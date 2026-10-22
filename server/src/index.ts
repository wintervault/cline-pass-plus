import fs from 'node:fs/promises';
import type http from 'node:http';

import { ClassifyService } from './accounts/classify.ts';
import { AccountPool } from './accounts/pool.ts';
import type { AppContext } from './appContext.ts';
import {
  type AccountClassLookup,
  gatewayAccountState,
  gatewayAccounts,
  gatewayById,
  gatewayProxyBase,
  primaryGateway,
  usableAccounts,
} from './config/derive.ts';
import { applyEnvOverrides } from './config/env.ts';
import { loadConfig, persistConfigMigration, writeConfig } from './config/load.ts';
import { type Config, FailoverSchema } from './config/schema.ts';
import { ConsoleManager } from './console/manager.ts';
import { GatewayManager, type GatewayRuntime } from './gateways/manager.ts';
import { sendError, sendJSON } from './http/respond.ts';
import { type Handler, Router } from './http/router.ts';
import { registerApiRoutes } from './http/routes/api.ts';
import { chatHandler, isChatPath, isModelsPath, modelsHandler } from './http/routes/chat.ts';
import { staticHandler } from './http/routes/static.ts';
import { createHttpServer } from './http/server.ts';
import { logger } from './log/logger.ts';
import { CONFIG_PATH, DATA_DIR, META_PATH, PACKAGE_VERSION } from './paths.ts';
import { ChatChain } from './proxy/chain.ts';
import { ChannelHealth } from './proxy/health.ts';
import { assertBindSafe, InsecureBindError } from './security/bind.ts';
import { gatewayAliveGuard } from './security/gatewayGuard.ts';
import { authMiddleware, corsResponseHeaders, originCheckMiddleware } from './security/middleware.ts';
import { JsonStore } from './store/jsonStore.ts';
import { loadMetaStore } from './store/metaStore.ts';
import { CatalogService } from './upstream/catalog.ts';
import { classifyChannelStatus } from './upstream/errors.ts';
import { mergeLearnedProviders, ProbeService } from './upstream/probe.ts';
import {
  accountModels,
  blankModelMeta,
  ensureAccountModels,
  ensureGatewayModels,
  gatewayModels,
  type MetaFile,
} from './upstream/types.ts';

const VERSION = PACKAGE_VERSION;
const startedAt = Date.now();

/** 网关暂时从配置里消失时使用的兜底失败参数（正常情况不会用到）。 */
const FALLBACK_FAILOVER = FailoverSchema.parse({});

/**
 * 渠道失败自动学习（按网关）：
 * - 钉住失败 → 记录该渠道在该网关下的状态（仅确定性失败；瞬时限流标 limited 不拉黑）
 * - 自动+排除模式 → 网关报错附带的最新渠道清单合并进该网关的已知列表
 *   （触发场景：本地清单过期，网关侧新增了渠道——白名单漏掉新渠道）
 *
 * 必须按网关隔离：同一个渠道在两个网关里可能一个可用一个不可用（账号不同）。
 */
function learnFromFailure(configStore: JsonStore<Config>, metaStore: JsonStore<MetaFile>, gatewayId: string) {
  return (modelId: string, upstream: string | null, message: string, accountName: string): void => {
    if (upstream) {
      const status = classifyChannelStatus(message);
      if (status === 'unknown') return; // 无把握的不记录，避免误标
      const entry = { status, note: message.slice(0, 160), checkedAt: Date.now() };
      metaStore.update((meta) => {
        // 网关聚合（实际流量）与该账号的检测记录同时更新：前者供路由兜底，
        // 后者是检测页看到的「这个号在该渠道上的真实状态」。
        const models = ensureGatewayModels(meta, gatewayId);
        const model = models[modelId] ?? blankModelMeta();
        model.upstreamStatus = { ...model.upstreamStatus, [upstream]: entry };
        models[modelId] = model;
        if (accountName) {
          const byAccount = ensureAccountModels(meta, accountName);
          const accountModel = byAccount[modelId] ?? blankModelMeta();
          accountModel.upstreamStatus = { ...accountModel.upstreamStatus, [upstream]: entry };
          byAccount[modelId] = accountModel;
        }
      });
      return;
    }

    // 自动模式：把网关报错里附带的最新渠道清单并进已知列表
    const model = gatewayModels(metaStore.value, gatewayId)[modelId] ?? blankModelMeta();
    const merged = mergeLearnedProviders(model, message);
    if (!merged.length) return;
    logger.info({ gateway: gatewayId, modelId, learned: merged.length }, '从网关报错学习到新的渠道清单');
    metaStore.update((meta) => {
      ensureGatewayModels(meta, gatewayId)[modelId] = model;
    });
    void configStore; // 保持依赖形状一致（后续可能基于配置决定是否学习）
  };
}

async function main(): Promise<void> {
  // 数据目录可能还不存在（Docker 挂载卷 / systemd 的 StateDirectory）。
  // 新建目录在 POSIX 下就是 0700；已存在的目录不改权限（开发时 DATA_DIR 可能是仓库根）。
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  const loaded = await loadConfig(CONFIG_PATH);
  for (const note of loaded.notes) logger.warn({ note }, '配置迁移/修正');

  if (loaded.fresh) {
    await writeConfig(CONFIG_PATH, loaded.config);
    logger.info({ file: CONFIG_PATH }, '已生成默认配置文件');
  }

  // 版本迁移写回的是「用户文件」（不含环境变量覆盖）：先留一份快照，等启动闸门
  // 通过后再落盘——启动被拒绝时不动用户的配置文件。
  const migratedSnapshot = loaded.migrationFrom !== null ? structuredClone(loaded.config) : null;

  for (const note of applyEnvOverrides(loaded.config)) logger.info({ note }, '环境变量覆盖');

  assertBindSafe(loaded.config);

  // 迁移立刻写回：否则每次启动都要重放迁移，用户看到的 config.json 也会一直停在旧格式。
  // 原文件先备份。
  if (migratedSnapshot && loaded.migrationFrom !== null) {
    const backupPath = await persistConfigMigration(CONFIG_PATH, migratedSnapshot, loaded.migrationFrom);
    logger.info({ file: CONFIG_PATH, from: loaded.migrationFrom, backupPath }, '配置已按新格式写回');
  }

  const configStore = new JsonStore<Config>(CONFIG_PATH, loaded.config, {
    onError: (err) => logger.error({ err }, '配置写盘失败'),
  });
  const metaLoaded = await loadMetaStore(META_PATH);
  for (const note of metaLoaded.notes) logger.warn({ note }, '观测数据');
  const metaStore = metaLoaded.store;
  /** 风控结论查询：账号范围 normal/private 在每次取账号时按最新结论计算。 */
  const classOf: AccountClassLookup = (name) => metaStore.value.accountClass[name]?.class ?? 'unknown';

  // ---- 全局服务（不随网关变化） ----
  // 目录拉取只需要「随便一个可用账号」：用一个覆盖全局账号的池，与网关的粘性状态无关。
  const catalogPool = new AccountPool(() => ({
    accounts: configStore.value.accounts,
    accountMode: 'sticky',
    activeAccount: '',
  }));
  const catalog = new CatalogService({
    get upstreamBase() {
      return configStore.value.upstreamBase;
    },
    pool: catalogPool,
    meta: metaStore.value,
    markDirty: () => metaStore.markDirty(),
  });
  // 依赖用函数注入：配置与 metadata 都是就地更新的，每次体检都读最新值
  const classify = new ClassifyService(() => ({
    upstreamBase: configStore.value.upstreamBase,
    classifyModel: configStore.value.classifyModel,
    get: (name) => metaStore.value.accountClass[name],
    set: (name, record) =>
      metaStore.update((meta) => {
        meta.accountClass[name] = record;
      }),
  }));

  /**
   * 渠道检测（探测 / 校验）是**账号级**的：结论按账号名存进 `accountModels`，
   * 与网关无关。同一个模型在正常号与风控号上的可钉性和渠道清单可能完全不同。
   */
  const probe = new ProbeService({
    get upstreamBase() {
      return configStore.value.upstreamBase;
    },
    getMeta: (account, modelId) => accountModels(metaStore.value, account)[modelId],
    setMeta: (account, modelId, model) =>
      metaStore.update((meta) => {
        ensureAccountModels(meta, account)[modelId] = model;
      }),
    orEndpoints: (slug) => catalog.orEndpoints(slug),
  });

  // ---- 网关运行时 ----
  // ctx 在 makeServer 里按需取（listener 要等 reconcile 时才创建，那时 ctx 已就绪）
  let ctx: AppContext | null = null;
  const requireCtx = (): AppContext => {
    if (!ctx) throw new Error('服务尚未初始化完成');
    return ctx;
  };

  const makeRuntime = (id: string): GatewayRuntime => {
    const pool = new AccountPool(() => {
      const cfg = configStore.value;
      const gateway = gatewayById(cfg, id);
      return {
        accounts: gateway ? gatewayAccounts(cfg, gateway, classOf) : [],
        accountMode: gateway?.accountMode ?? 'sticky',
        activeAccount: gateway?.activeAccount ?? '',
      };
    });
    const health = new ChannelHealth();
    const chain = new ChatChain({
      get upstreamBase() {
        return configStore.value.upstreamBase;
      },
      get failover() {
        return gatewayById(configStore.value, id)?.failover ?? FALLBACK_FAILOVER;
      },
      pool,
      health,
    });
    chain.onChannelFailure(learnFromFailure(configStore, metaStore, id));
    return {
      id,
      pool,
      health,
      chain,
      server: null,
      bound: null,
      status: { id, state: 'stopped', boundPort: null, boundHost: null },
    };
  };

  const router = new Router();

  /**
   * 网关 listener：只有接入面（`/healthz` + OpenAI 兼容端点）。
   * 控制台 API 与静态页在独立的控制台 listener 上，网关绑不上不会连带控制台。
   */
  const makeServer = (gatewayId: string): http.Server => {
    const handler: Handler = (c) => {
      const cfg = configStore.value;
      if (c.path === '/healthz' && c.method === 'GET') {
        const gateway = gatewayById(cfg, gatewayId);
        const state = gateway ? gatewayAccountState(cfg, gateway, classOf) : null;
        sendJSON(c.res, 200, {
          ok: true,
          gateway: gatewayId,
          version: VERSION,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          configured: state?.code === 'ok',
          accountState: state?.code ?? 'no_accounts',
        });
        return;
      }
      if (isModelsPath(c.path) && c.method === 'GET') return modelsHandler(requireCtx(), gatewayId)(c);
      if (isChatPath(c.path) && c.method === 'POST') return chatHandler(requireCtx(), gatewayId)(c);
      return sendError(c.res, 404, 'not found', 'not_found');
    };

    return createHttpServer({
      gatewayId,
      handler,
      middleware: [
        gatewayAliveGuard(() => configStore.value),
        corsResponseHeaders((c) => gatewayById(configStore.value, c.gatewayId)?.corsOrigins ?? []),
        originCheckMiddleware((c) => gatewayById(configStore.value, c.gatewayId)?.corsOrigins ?? []),
        authMiddleware((c) => gatewayById(configStore.value, c.gatewayId)?.proxyKey ?? '', {
          // 网关只保护接入面；`/v1/*` 的密钥是下发给客户端的凭据，本机也不例外
          needsAuth: (path) => isChatPath(path) || isModelsPath(path),
          consolePath: () => false,
        }),
      ],
    });
  };

  const manager = new GatewayManager({
    config: () => configStore.value,
    createRuntime: makeRuntime,
    createServer: makeServer,
  });

  /**
   * 控制台 listener：API + 静态页，监听目标独立于任何网关。
   * `/api/shutdown` 不走密钥（壳不应依赖控制台密钥配置），由「回环来源 +
   * 无 Origin/Referer」三重放行保护（见 routes/api.ts 的注释）。
   */
  const consoleHandler: Handler = (c) => {
    if (c.path === '/healthz' && c.method === 'GET') {
      sendJSON(c.res, 200, {
        ok: true,
        console: true,
        version: VERSION,
        uptime: Math.round((Date.now() - startedAt) / 1000),
        accounts: usableAccounts(configStore.value).length,
      });
      return;
    }
    const route = router.resolve(c.method, c.path);
    if (route) return route(c);
    return staticHandler()(c);
  };

  const consoleManager = new ConsoleManager({
    target: () => configStore.value.console,
    handler: consoleHandler,
    middleware: [
      originCheckMiddleware(() => []),
      authMiddleware(() => configStore.value.console.proxyKey, {
        needsAuth: (path) => path !== '/api/shutdown' && path.startsWith('/api/'),
        consolePath: (path) => path.startsWith('/api/'),
      }),
    ],
  });

  ctx = {
    version: VERSION,
    startedAt,
    configStore,
    metaStore,
    gateways: manager,
    console: consoleManager,
    catalog,
    probe,
    classify,
  };
  registerApiRoutes(ctx, router);

  // ---- 启动监听（逐网关 + 控制台；任一失败不影响其它） ----
  await manager.reconcile();
  await consoleManager.reconcile();

  logger.info(
    {
      version: VERSION,
      dataDir: DATA_DIR,
      configFile: CONFIG_PATH,
      accounts: configStore.value.accounts.length,
      gateways: configStore.value.gateways.length,
      console: `${configStore.value.console.bindHost}:${configStore.value.console.port}`,
    },
    '服务已启动',
  );
  const consoleStatus = consoleManager.status();
  if (consoleStatus.state === 'running') {
    logger.info(
      { port: consoleStatus.boundPort, host: consoleStatus.boundHost },
      `控制台: http://${consoleStatus.boundHost ?? '127.0.0.1'}:${consoleStatus.boundPort}/`,
    );
  } else if (consoleStatus.state === 'error') {
    logger.error({ error: consoleStatus.error }, '控制台未能监听（网关不受影响；可修复后重启）');
  }
  for (const status of manager.statuses()) {
    const gateway = gatewayById(configStore.value, status.id);
    if (!gateway) continue;
    if (status.state === 'running') {
      logger.info(
        { gateway: gateway.id, name: gateway.name, proxyBase: gatewayProxyBase(gateway) },
        `网关「${gateway.name}」: ${gatewayProxyBase(gateway)}`,
      );
    } else if (status.state === 'error') {
      logger.error(
        { gateway: gateway.id, name: gateway.name, error: status.error },
        `网关「${gateway.name}」未能监听（其它网关照常运行）`,
      );
    }
  }
  if (usableAccounts(configStore.value).length === 0) {
    logger.warn('尚未配置上游 API Key：在控制台「账号池」添加账号，或设置 CLINE_PASS_KEY 环境变量');
  }

  // ---- 生命周期 ----
  // 优雅退出：信号与 /api/shutdown（桌面壳）共用同一条路径
  let shuttingDown = false;
  const shutdownOnce = (reason: string): void => {
    if (shuttingDown) {
      logger.warn({ reason }, '关停已在进行，忽略重复请求');
      return;
    }
    shuttingDown = true;
    logger.info({ reason }, '开始优雅退出');
    void (async () => {
      await Promise.all([manager.closeAll(30_000), consoleManager.close(30_000)]);
      configStore.close();
      metaStore.close();
      await Promise.all([configStore.flush(), metaStore.flush()]);
    })()
      .then(() => {
        logger.info('已关闭全部网关，数据已落盘');
        process.exit(0);
      })
      .catch((err: unknown) => {
        logger.error({ err }, '优雅退出过程中出错');
        process.exit(1);
      });
  };
  const onSignal = (signal: string): void => {
    if (shuttingDown) {
      logger.warn({ signal }, '再次收到退出信号，立即退出');
      process.exit(1);
    }
    shutdownOnce(signal);
  };
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGTERM', () => onSignal('SIGTERM'));

  ctx.onShutdown = shutdownOnce;

  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '未捕获异常');
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, '未处理的 Promise 拒绝');
  });
}

main().catch((err: unknown) => {
  if (err instanceof InsecureBindError) {
    // 安全配置错误是用户可修的，打成人话而不是堆栈
    console.error(`\n[拒绝启动] ${err.message}\n`);
    process.exit(1);
  }
  logger.fatal({ err }, '启动失败');
  process.exit(1);
});
