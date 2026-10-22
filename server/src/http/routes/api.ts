import type { IncomingMessage } from 'node:http';

import { expiryState } from '../../accounts/expiry.ts';
import { ensureUniqueAccountNames } from '../../accounts/naming.ts';
import { type AppContext, updateConfig } from '../../appContext.ts';
import { isIsoDate } from '../../config/date.ts';
import {
  type AccountClassLookup,
  gatewayAccountState,
  gatewayById,
  gatewayProxyBase,
  gatewayUsableAccounts,
  primaryGateway,
  usableAccounts,
} from '../../config/derive.ts';
import {
  type Account,
  type Config,
  ConsoleSchema,
  defaultGateway,
  type Gateway,
  GatewaySchema,
  MAX_GATEWAYS,
  type PerModelConfig,
} from '../../config/schema.ts';
import { probeBind } from '../../console/manager.ts';
import { moduleLogger } from '../../log/logger.ts';
import type { ChainResult } from '../../proxy/chain.ts';
import { bindingsConflict } from '../../security/bind.ts';
import { isLoopbackHost, maskSecret } from '../../security/compare.ts';
import { fetchJSON } from '../../upstream/client.ts';
import type { RoutingInfo } from '../../upstream/routing.ts';
import { accountModels, gatewayModels } from '../../upstream/types.ts';
import { sendError, sendJSON } from '../respond.ts';
import type { Ctx, Handler } from '../router.ts';

const MAX_BODY = 50 * 1024 * 1024;
const log = moduleLogger('api');

/** 读请求体并解析 JSON；超大或畸形返回 null（调用方回 400/413）。 */
export function readJsonBody(
  req: IncomingMessage,
  limit = MAX_BODY,
): Promise<{ ok: true; value: unknown } | { ok: false; reason: 'too-large' | 'bad-json' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        req.destroy();
        resolve({ ok: false, reason: 'too-large' });
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        resolve({ ok: false, reason: 'bad-json' });
      }
    });
    req.on('error', () => resolve({ ok: false, reason: 'bad-json' }));
  });
}

/** perModel 归一化：去重、限长、exclude 优先于 upstreams。 */
export function normalizePerModel(raw: unknown): PerModelConfig {
  const source = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const toList = (v: unknown): string[] =>
    [...new Set((Array.isArray(v) ? v : []).map((s) => String(s ?? '').trim()).filter(Boolean))].slice(0, 10);

  let upstreams = toList(source['upstreams']);
  const exclude = toList(source['exclude']);
  const excl = new Set(exclude);
  upstreams = upstreams.filter((u) => !excl.has(u));

  return {
    upstreams,
    exclude,
    pinMode: source['pinMode'] === 'preferred' ? 'preferred' : 'strict',
    sort: source['sort'] === 'cost' || source['sort'] === 'ttft' || source['sort'] === 'tps' ? source['sort'] : null,
  };
}

/** perModel 映射归一化（每个模型的配置逐个收敛）。 */
function normalizePerModelMap(raw: unknown): Record<string, PerModelConfig> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, PerModelConfig> = {};
  for (const [id, cfg] of Object.entries(raw as Record<string, unknown>)) {
    if (!id.trim()) continue;
    out[id] = normalizePerModel(cfg);
  }
  return out;
}

/**
 * 账号列表合并（前端编辑结果 → 服务端账号池）。
 *
 * key 的归属由每行的 `existingIndex`（编辑开始时在旧列表里的下标）显式指定，
 * **绝不能按当前行号对位**：删除一行会让后面的行错位继承别人的密钥（数据破坏）。
 * 前端拿不到明文，留空 = 用 existingIndex 指向的旧 key；掩码串原样传回也当作「未修改」。
 *
 * `expiresAt` 是三态语义：缺省 = 保持不变（老客户端/局部提交），`null`/空串 = 清空，
 * 合法日期 = 设置。非法日期同样按「保持」处理——手抖打错不该把已有日期清掉。
 */
export function mergeAccounts(existing: Account[], incoming: unknown): Account[] {
  return mergeAccountsDetailed(existing, incoming).accounts;
}

export interface AccountMergeResult {
  accounts: Account[];
  /** 名字变了的账号（旧名 → 新名），调用方据此迁移按名字索引的观测数据。 */
  renames: Array<{ from: string; to: string }>;
}

export function mergeAccountsDetailed(existing: Account[], incoming: unknown): AccountMergeResult {
  const rows = Array.isArray(incoming) ? incoming : [];
  const picked: Array<{ account: Account; priorName: string | null }> = [];

  rows.forEach((raw, i) => {
    const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const name = String(a['name'] ?? `账号${i + 1}`).slice(0, 50);
    const key = String(a['key'] ?? '').trim();
    const safeKey = /^[•*]+$/.test(key.slice(0, -4)) || key.includes('•') ? '' : key;
    const keepIdx = a['existingIndex'];
    const prior =
      typeof keepIdx === 'number' && Number.isInteger(keepIdx) && keepIdx >= 0 ? existing[keepIdx] : undefined;
    const finalKey = safeKey || prior?.key || '';
    if (!finalKey) return; // 新行没填 key 就丢弃（空账号没有意义）

    let expiresAt = prior?.expiresAt;
    const rawExpires = a['expiresAt'];
    if (rawExpires === null || rawExpires === '') expiresAt = undefined;
    else if (typeof rawExpires === 'string' && isIsoDate(rawExpires)) expiresAt = rawExpires;

    picked.push({
      account: {
        name,
        key: finalKey,
        ...(expiresAt ? { expiresAt } : {}),
      },
      priorName: prior?.name ?? null,
    });
  });

  const unified = ensureUniqueAccountNames(picked.map((p) => p.account));
  const renames: Array<{ from: string; to: string }> = [];
  unified.accounts.forEach((account, i) => {
    const priorName = picked[i]?.priorName ?? null;
    if (priorName && priorName !== account.name) renames.push({ from: priorName, to: account.name });
  });
  return { accounts: unified.accounts, renames };
}

/**
 * 账号改名 / 删除后整理按账号名索引的观测数据（检测记录、用量统计、风控结论）。
 *
 * 两段式（先全部取出并删除，再写入新名）是必须的：改名可以成环
 * （A→B、B→A），逐条搬会把目标位置的旧数据覆盖掉。
 * 历史记录不动——那是行为日志，账号名在里面是历史事实。
 */
function migrateAccountMeta(ctx: AppContext, renames: Array<{ from: string; to: string }>, names: string[]): void {
  const alive = new Set(names);
  const current = ctx.metaStore.value;
  const hasStale = [
    ...Object.keys(current.stats),
    ...Object.keys(current.accountClass),
    ...Object.keys(current.accountModels),
  ].some((n) => !alive.has(n));
  if (!renames.length && !hasStale) return;

  ctx.metaStore.update((meta) => {
    const moves = renames.map((r) => ({
      ...r,
      stats: meta.stats[r.from],
      cls: meta.accountClass[r.from],
      models: meta.accountModels[r.from],
    }));
    for (const r of renames) {
      delete meta.stats[r.from];
      delete meta.accountClass[r.from];
      delete meta.accountModels[r.from];
    }
    for (const m of moves) {
      if (!alive.has(m.to)) continue;
      if (m.stats) meta.stats[m.to] = m.stats;
      if (m.cls) meta.accountClass[m.to] = m.cls;
      if (m.models) meta.accountModels[m.to] = m.models;
    }
    for (const name of Object.keys(meta.stats)) if (!alive.has(name)) delete meta.stats[name];
    for (const name of Object.keys(meta.accountClass)) if (!alive.has(name)) delete meta.accountClass[name];
    // 删除账号后，检测记录不能留着：同名账号以后再加回来时不该继承别人的探测结论
    for (const name of Object.keys(meta.accountModels)) if (!alive.has(name)) delete meta.accountModels[name];
  });
}

/** 所有网关已知模型的并集（去重、保持配置顺序）。检测页不再依赖单个网关。 */
function allKnownModels(config: Config): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const gateway of config.gateways) {
    for (const id of gateway.knownModels) {
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * 订阅模型 + 网关路由配置 + **所选账号**的检测记录。
 * `config` 来自 `?gateway=`（路由属于网关），`meta` 来自 `?account=`（检测属于账号）。
 */
function subscriptionView(ctx: AppContext, gateway: Gateway, account: Account | null) {
  const observed = account ? accountModels(ctx.metaStore.value, account.name) : {};
  return allKnownModels(ctx.configStore.value).map((id) => ({
    id,
    config: gateway.perModel[id] ?? null,
    meta: observed[id] ?? null,
  }));
}

/**
 * 请求指向哪个网关：`?gateway=<id>`，缺省 = 配置里的第一个网关。
 * 返回 null 表示 id 不存在（调用方回 404，不要静默回退到别的网关——那会把请求发到错误的地方）。
 */
function requestGateway(ctx: AppContext, c: Ctx): Gateway | null {
  const config = ctx.configStore.value;
  const id = c.url.searchParams.get('gateway');
  if (!id) return primaryGateway(config);
  return gatewayById(config, id);
}

/** 网关视图：配置 + 运行状态 + 统计。**不回传明文密钥**。 */
function gatewayViews(ctx: AppContext) {
  const config = ctx.configStore.value;
  const statuses = new Map(ctx.gateways.statuses().map((s) => [s.id, s]));
  const classOf: AccountClassLookup = (name) => ctx.metaStore.value.accountClass[name]?.class ?? 'unknown';
  return config.gateways.map((gateway) => {
    const { proxyKey, ...rest } = gateway;
    const status = statuses.get(gateway.id) ?? {
      id: gateway.id,
      state: 'stopped' as const,
      boundPort: null,
      boundHost: null,
    };
    return {
      ...rest,
      hasProxyKey: !!proxyKey,
      accountCount: gatewayUsableAccounts(config, gateway, classOf).length,
      accountState: gatewayAccountState(config, gateway, classOf),
      modelCount: gateway.knownModels.length,
      proxyBase: gatewayProxyBase(gateway),
      status,
    };
  });
}

/**
 * 网关配置写回后应用监听变更。
 *
 * 控制台是独立 listener（2.1 起），保存网关设置永远不会关闭当前请求所在的
 * listener，所以可以安全地等 reconcile 完成再回响应。
 */
async function applyGatewayChange(ctx: AppContext, _c: Ctx, _changedIds: string[]): Promise<boolean> {
  await ctx.gateways.reconcile();
  return false;
}

/**
 * 网关保存请求的字段白名单与归一化（防止前端顺手改掉 id 之类的东西）。
 * proxyKey 三态：缺省/空串 = 保持，null = 清除，非空 = 设置——前端拿不到明文，「留空」是常态。
 */
export type GatewayMergeResult =
  | { ok: true; gateway: Gateway }
  | { ok: false; code: string; message: string; params?: Record<string, string | number> };

/**
 * 网关保存请求的字段白名单与归一化。
 *
 * 失败时同时给 `code`（前端按语言映射）与中文 `message`（日志/老客户端兜底）——
 * 控制台文案不靠服务端拼中文。
 */
export function mergeGatewayPayload(raw: Record<string, unknown>, existing: Gateway | null): GatewayMergeResult {
  const fallback = existing ?? defaultGateway({ id: String(raw['id'] ?? '') });
  const name = typeof raw['name'] === 'string' ? raw['name'].trim() : fallback.name;
  if (!name || name.length > 50) return { ok: false, code: 'gateway.nameInvalid', message: '网关名称需要 1-50 个字符' };

  const port = raw['port'] === undefined ? fallback.port : Number(raw['port']);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    return { ok: false, code: 'gateway.portInvalid', message: '端口必须是 1-65535 的整数' };

  const bindHost = typeof raw['bindHost'] === 'string' ? raw['bindHost'].trim() : fallback.bindHost;
  if (!bindHost) return { ok: false, code: 'gateway.bindHostRequired', message: '绑定地址不能为空' };

  const enabled = typeof raw['enabled'] === 'boolean' ? raw['enabled'] : fallback.enabled;

  const accountMode =
    raw['accountMode'] === 'single' || raw['accountMode'] === 'roundrobin' || raw['accountMode'] === 'sticky'
      ? raw['accountMode']
      : fallback.accountMode;

  const scopeValue = raw['accountScope'];
  const accountScope =
    scopeValue === 'all' || scopeValue === 'normal' || scopeValue === 'private' || scopeValue === 'custom'
      ? scopeValue
      : fallback.accountScope;
  const accounts = Array.isArray(raw['accounts'])
    ? [...new Set(raw['accounts'].map((n) => String(n ?? '').trim()).filter(Boolean))]
    : fallback.accounts;
  const accountOrder = Array.isArray(raw['accountOrder'])
    ? [...new Set(raw['accountOrder'].map((n) => String(n ?? '').trim()).filter(Boolean))]
    : fallback.accountOrder;

  const activeAccount = typeof raw['activeAccount'] === 'string' ? raw['activeAccount'].trim() : fallback.activeAccount;

  const corsOrigins = Array.isArray(raw['corsOrigins'])
    ? raw['corsOrigins'].map((o) => String(o ?? '').trim()).filter(Boolean)
    : fallback.corsOrigins;

  const knownModels = Array.isArray(raw['knownModels'])
    ? [...new Set(raw['knownModels'].map((m) => String(m ?? '').trim()).filter(Boolean))]
    : fallback.knownModels;

  // proxyKey 三态：缺省或空串 = 保持；null = 清除；非空 = 设置
  let proxyKey = fallback.proxyKey;
  if (raw['proxyKey'] === null) proxyKey = '';
  else if (typeof raw['proxyKey'] === 'string' && raw['proxyKey'].trim()) proxyKey = raw['proxyKey'].trim();

  const failover =
    raw['failover'] === undefined
      ? fallback.failover
      : (() => {
          const parsed = GatewaySchema.shape.failover.safeParse(raw['failover']);
          return parsed.success ? parsed.data : null;
        })();
  if (!failover) return { ok: false, code: 'gateway.failoverInvalid', message: '失败转移参数不合法' };

  return {
    ok: true,
    gateway: {
      ...fallback,
      name,
      enabled,
      port,
      bindHost,
      proxyKey,
      publicBaseUrl:
        typeof raw['publicBaseUrl'] === 'string'
          ? raw['publicBaseUrl'].trim().replace(/\/+$/, '')
          : fallback.publicBaseUrl,
      corsOrigins,
      exposeCatalog: typeof raw['exposeCatalog'] === 'boolean' ? raw['exposeCatalog'] : fallback.exposeCatalog,
      accountScope,
      accounts,
      accountOrder,
      accountMode,
      activeAccount,
      knownModels,
      perModel: raw['perModel'] === undefined ? fallback.perModel : normalizePerModelMap(raw['perModel']),
      failover,
    },
  };
}

export function registerApiRoutes(
  ctx: AppContext,
  router: { get(path: string, handler: Handler): void; post(path: string, handler: Handler): void },
): void {
  const config = () => ctx.configStore.value;
  const meta = () => ctx.metaStore.value;
  /** 账号范围 normal/private 依赖当前体检结论（与 gatewayViews 同一口径）。 */
  const classOf: AccountClassLookup = (name) => ctx.metaStore.value.accountClass[name]?.class ?? 'unknown';

  /** 控制台监听的公开视图（不回传密钥）。 */
  const consoleView = (reqHost?: string) => {
    const cfg = config();
    const status = ctx.console.status();
    const wildcard = cfg.console.bindHost === '0.0.0.0' || cfg.console.bindHost === '::';
    // 0.0.0.0 不是可访问的地址：展示时换成当前请求的 Host（远端访问）或 localhost
    const host = isLoopbackHost(cfg.console.bindHost)
      ? '127.0.0.1'
      : wildcard
        ? (reqHost?.replace(/:\d+$/, '') ?? 'localhost')
        : cfg.console.bindHost;
    return {
      port: cfg.console.port,
      bindHost: cfg.console.bindHost,
      hasProxyKey: !!cfg.console.proxyKey,
      /** 控制台页面地址（远端访问时以实际请求的主机为准）。 */
      url: `http://${host}:${cfg.console.port}/`,
      status,
    };
  };

  router.get('/api/meta', (c: Ctx) => {
    const cfg = config();
    const primary = primaryGateway(cfg);
    sendJSON(c.res, 200, {
      version: ctx.version,
      /** 远端访问控制台是否需要密钥（本机永远免密钥）。 */
      authRequired: !!cfg.console.proxyKey,
      accounts: {
        total: cfg.accounts.length,
        usable: usableAccounts(cfg).length,
      },
      defaultGatewayId: primary.id,
      console: consoleView(c.req.headers.host),
      /** 只给选择器需要的字段；完整信息在 /api/gateways。 */
      gateways: cfg.gateways.map((g) => {
        const state = gatewayAccountState(cfg, g, classOf);
        return { id: g.id, name: g.name, enabled: g.enabled, accountState: state.code };
      }),
    });
  });

  router.get('/api/console', (c: Ctx) => {
    sendJSON(c.res, 200, { ok: true, ...consoleView(c.req.headers.host) });
  });

  /**
   * 保存控制台监听设置。
   *
   * 绑定目标变化时不能在这里等 reconcile：那会关闭正在回这个响应的 listener
   * （请求等 reconcile、reconcile 等请求结束）。先回响应，`finish` 之后再重建。
   */
  router.post('/api/console/save', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const raw = (body.value ?? {}) as { port?: unknown; bindHost?: unknown; proxyKey?: unknown };
    const cfg = config();
    const before = cfg.console;

    const port = raw.port === undefined ? before.port : Number(raw.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return sendError(c.res, 400, '端口必须是 1-65535 的整数', 'invalid_request_error', 'console.portInvalid');
    }
    const bindHost = typeof raw.bindHost === 'string' ? raw.bindHost.trim() : before.bindHost;
    if (!bindHost) {
      return sendError(c.res, 400, '绑定地址不能为空', 'invalid_request_error', 'console.bindHostRequired');
    }

    // proxyKey 三态：缺省/空串 = 保持，null = 清除，非空 = 设置
    let proxyKey = before.proxyKey;
    if (raw.proxyKey === null) proxyKey = '';
    else if (typeof raw.proxyKey === 'string' && raw.proxyKey.trim()) proxyKey = raw.proxyKey.trim();

    const parsed = ConsoleSchema.safeParse({ port, bindHost, proxyKey });
    if (!parsed.success) {
      return sendError(c.res, 400, '控制台设置不合法', 'invalid_request_error', 'console.invalid');
    }
    const next = parsed.data;

    // 与启动闸门同一条规则：非回环 + 空密钥 = 任何人可读控制台
    if (!isLoopbackHost(next.bindHost) && !next.proxyKey && process.env['ALLOW_INSECURE_BIND'] !== '1') {
      return sendError(
        c.res,
        400,
        '绑定非回环地址时必须设置控制台访问密钥（或把绑定地址改成 127.0.0.1）',
        'invalid_request_error',
        'console.insecureBind',
      );
    }
    const clash = cfg.gateways.find((g) => bindingsConflict(g, next));
    if (clash) {
      return sendError(
        c.res,
        409,
        `端口 ${next.port} 已被网关「${clash.name}」占用`,
        'invalid_request_error',
        'console.portConflict',
        { port: next.port, name: clash.name },
      );
    }

    // 先预检新目标再写配置：端口被别的程序占用时，直接拒绝，
    // 而不是先关掉当前控制台、再发现新端口绑不上（等于把自己锁在门外）。
    const targetChanged = before.port !== next.port || before.bindHost !== next.bindHost;
    if (targetChanged) {
      // 同端口只改绑定地址时，旧 listener 还占着端口：用 0 号端口验证地址本身可用
      const probePort = before.port === next.port ? 0 : next.port;
      const bindError = await probeBind(probePort, next.bindHost);
      if (bindError) {
        return sendError(
          c.res,
          409,
          `控制台无法监听 ${next.bindHost}:${next.port}：${bindError}`,
          'invalid_request_error',
          'console.bindFailed',
          { addr: `${next.bindHost}:${next.port}`, error: bindError },
        );
      }
    }

    updateConfig(ctx, (draft) => {
      draft.console = next;
    });
    const apply = () => {
      setTimeout(() => {
        ctx.console.reconcile().catch((err: unknown) => log.error({ err }, '延迟应用控制台监听变更失败'));
      }, 50);
    };
    if (targetChanged) c.res.once('finish', apply);
    else apply();

    sendJSON(c.res, 200, { ok: true, deferred: targetChanged, ...consoleView(c.req.headers.host) });
  });

  /** 按名字取账号（检测接口的必填目标）。 */
  const accountByName = (name: unknown): Account | null => {
    if (typeof name !== 'string' || !name.trim()) return null;
    return config().accounts.find((a) => a.name === name.trim()) ?? null;
  };

  router.get('/api/models', (c: Ctx) => {
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    const account = accountByName(c.url.searchParams.get('account'));
    void ctx.catalog
      .catalog()
      .catch(() => [] as string[])
      .then((catalogIds) => {
        sendJSON(c.res, 200, {
          gateway: { id: gateway.id, name: gateway.name },
          account: account ? { name: account.name } : null,
          subscription: subscriptionView(ctx, gateway, account),
          catalogCount: catalogIds.length,
          catalog: catalogIds,
          proxyBase: gatewayProxyBase(gateway),
          officialFetch: meta().officialModelsFetch,
        });
      });
  });

  router.post('/api/probe', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = body.value as { model?: unknown; account?: unknown };
    const model = payload.model;
    if (typeof model !== 'string' || !model) return sendError(c.res, 400, 'model required');
    if (payload.account === undefined)
      return sendError(c.res, 400, 'account required', 'invalid_request_error', 'accounts.required');
    const account = accountByName(payload.account);
    if (!account) return sendError(c.res, 404, 'account not found', 'not_found', 'accounts.notFound');
    try {
      const result = await ctx.probe.probeModel(model, account, c.abortSignal);
      sendJSON(c.res, result.ok ? 200 : 502, result);
    } catch (err) {
      sendJSON(c.res, 502, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/api/validate-upstreams', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = body.value as { model?: unknown; account?: unknown };
    const model = payload.model;
    if (typeof model !== 'string' || !model) return sendError(c.res, 400, 'model required');
    if (payload.account === undefined)
      return sendError(c.res, 400, 'account required', 'invalid_request_error', 'accounts.required');
    const account = accountByName(payload.account);
    if (!account) return sendError(c.res, 404, 'account not found', 'not_found', 'accounts.notFound');
    const outcome = await ctx.probe.validateUpstreams(model, account, c.abortSignal);
    if (!outcome.ok) {
      // 钉住参数被网关丢弃 / 尚未确认生效：校验结果是假绿，明确拒绝而不是输出全绿误导
      // code 给前端按语言取词；reason 只作原文兜底（英文界面不会显示中文）。
      sendError(c.res, 409, outcome.reason, 'invalid_request_error', outcome.code);
      return;
    }
    const summary: Record<string, number> = { ok: 0, limited: 0, bad: 0, auth: 0, unknown: 0 };
    for (const r of Object.values(outcome.results)) summary[r.status] = (summary[r.status] ?? 0) + 1;
    sendJSON(c.res, 200, {
      ok: true,
      summary,
      results: outcome.results,
      upstreams: outcome.upstreams,
      pinState: outcome.pinState,
    });
  });

  router.post('/api/fetch-official-models', async (c: Ctx) => {
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    const result = await ctx.catalog.fetchOfficialModels(c.abortSignal, {
      knownModels: gateway.knownModels,
      addKnownModels: (ids) =>
        updateConfig(ctx, (cfg) => {
          const target = cfg.gateways.find((g) => g.id === gateway.id);
          if (!target) return;
          for (const id of ids) if (!target.knownModels.includes(id)) target.knownModels.push(id);
        }),
    });
    sendJSON(c.res, 200, { ok: true, ...result });
  });

  router.post('/api/test', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as {
      model?: unknown;
      account?: unknown;
      upstream?: unknown;
      upstreams?: unknown;
      exclude?: unknown;
    };
    const model = typeof payload.model === 'string' ? payload.model : '';
    if (!model) return sendError(c.res, 400, 'model required');
    if (payload.account === undefined)
      return sendError(c.res, 400, 'account required', 'invalid_request_error', 'accounts.required');
    const account = accountByName(payload.account);
    if (!account) return sendError(c.res, 404, 'account not found', 'not_found', 'accounts.notFound');

    const gateway = requestGateway(ctx, c);
    const runtime = gateway ? ctx.gateways.get(gateway.id) : null;
    if (!gateway || !runtime) return sendError(c.res, 404, 'unknown gateway', 'not_found');

    // 临时配置覆盖：不落盘，仅本次请求生效（与保存的配置叠加）
    const base = gateway.perModel[model];
    const cfg: PerModelConfig = base ? { ...base } : { upstreams: [], exclude: [], pinMode: 'strict', sort: null };
    if (payload.upstreams !== undefined) cfg.upstreams = normalizePerModel({ upstreams: payload.upstreams }).upstreams;
    else if (payload.upstream !== undefined)
      cfg.upstreams = typeof payload.upstream === 'string' && payload.upstream ? [payload.upstream] : [];
    if (payload.exclude !== undefined) cfg.exclude = normalizePerModel({ exclude: payload.exclude }).exclude;

    const result = await runtime.chain.run({
      modelId: model,
      body: { model, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      cfg,
      meta: gatewayModels(meta(), gateway.id)[model],
      /** 测试台锁定在用户选中的账号上，不换号。 */
      forcedAccount: account.name,
      forcedAccountInfo: account,
      accountMeta: (name) => accountModels(meta(), name)[model],
      stream: false,
      clientSignal: c.abortSignal,
    });

    const targets = cfg.upstreams.filter(Boolean);
    const trace = result.trace;
    if (result.outcome === 'stream') {
      // stream:false 的请求不会返回流式结果；防御性兜底
      sendJSON(c.res, 502, { ok: false, error: 'unexpected stream outcome', targets, trace });
      return;
    }
    // 客户端在请求结束前断开（取消）：不是上游失败，不记历史、不写响应
    if (result.outcome === 'cancelled') return;
    recordHistory(ctx, gateway.id, model, result, { stream: false });

    if (result.outcome !== 'success') {
      const message = result.outcome === 'failure' ? result.message : 'unexpected stream outcome';
      sendJSON(c.res, 200, {
        ok: false,
        error: message.slice(0, 400),
        targets,
        exclude: cfg.exclude,
        trace,
        degraded: result.degraded,
      });
      return;
    }

    sendJSON(c.res, 200, {
      ok: true,
      ms: result.totalMs,
      targets,
      exclude: cfg.exclude,
      actual: result.routing.finalProvider,
      actualName: result.routing.finalProviderName,
      pipeline: result.routing.pipeline,
      pinnable: result.routing.pipeline !== null,
      canonicalSlug: result.routing.canonicalSlug,
      fallbacks: result.routing.fallbacks,
      content: typeof result.routing.content === 'string' ? result.routing.content.slice(0, 120) : '',
      account: result.account?.name ?? null,
      trace,
      degraded: result.degraded,
    });
  });

  router.get('/api/accounts', (c: Ctx) => {
    const cfg = config();
    const stats = meta().stats;
    const accountClass = meta().accountClass;
    // 不回传明文 key：只给掩码与指纹（末 4 位），编辑时留空 = 保持不变
    sendJSON(c.res, 200, {
      accounts: cfg.accounts.map((a) => ({
        name: a.name,
        keyMasked: maskSecret(a.key),
        keyTail: a.key.slice(-4),
        hasKey: !!a.key,
        expiresAt: a.expiresAt ?? null,
        /** 到期状态由**服务端**算（时钟以服务端为准；i18n 时前端按 kind 取词）。 */
        expiry: expiryState(a.expiresAt),
        /** 风控体检结论（观测值，可能为空 = 从未体检过）。 */
        classify: accountClass[a.name] ?? null,
      })),
      /** 体检判定模型（全局；账号策略与账号范围是网关级的，在「网关」页编辑）。 */
      classifyModel: cfg.classifyModel,
      stats,
    });
  });

  router.post('/api/accounts', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as { accounts?: unknown; classifyModel?: unknown };
    /**
     * accounts 三态：
     * - 缺省 → 保持现有账号（只改判定模型的请求不该清空账号池）；
     * - 空数组 → 明确删除全部账号（首次启动本来就是 0 个，必须允许回到该状态）；
     * - 非数组 → 拒绝，避免坏请求把账号池清空。
     */
    if (payload.accounts !== undefined && !Array.isArray(payload.accounts)) {
      return sendError(c.res, 400, 'accounts must be an array', 'invalid_request_error');
    }
    const { accounts, renames } =
      payload.accounts === undefined
        ? { accounts: config().accounts, renames: [] as Array<{ from: string; to: string }> }
        : mergeAccountsDetailed(config().accounts, payload.accounts);
    const names = new Set(accounts.map((a) => a.name));
    const classifyModel = typeof payload.classifyModel === 'string' ? payload.classifyModel.trim().slice(0, 120) : '';

    updateConfig(ctx, (cfg) => {
      cfg.accounts = accounts;
      if (classifyModel) cfg.classifyModel = classifyModel;
      const renameMap = new Map(renames.map((r) => [r.from, r.to]));
      for (const gw of cfg.gateways) {
        // 改名：账号范围与 single 模式的选择跟着改
        if (renameMap.size) {
          gw.accounts = gw.accounts.map((n) => renameMap.get(n) ?? n);
          gw.accountOrder = gw.accountOrder.map((n) => renameMap.get(n) ?? n);
          gw.activeAccount = renameMap.get(gw.activeAccount) ?? gw.activeAccount;
        }
        // 删除：把已不存在的名字从范围与顺序里摘掉（自选范围下空 = 不参与任何账号）
        gw.accounts = [...new Set(gw.accounts.filter((n) => names.has(n)))];
        gw.accountOrder = [...new Set(gw.accountOrder.filter((n) => names.has(n)))];
        if (gw.activeAccount && !names.has(gw.activeAccount)) gw.activeAccount = '';
      }
    });
    // 账号名是观测数据的键：改名要迁走、删除要清掉（历史记录是日志，保留历史账号名）
    migrateAccountMeta(ctx, renames, [...names]);

    sendJSON(c.res, 200, {
      ok: true,
      accounts: accounts.length,
      classifyModel: config().classifyModel,
      renamed: renames,
    });
  });

  /**
   * 风控体检：每个账号发**一次**最小请求，看网关默认路由到哪个渠道。
   * 显式传 `names` 时只体检这些（允许体检没参与任何网关的账号）；不传则体检全部账号。
   * 串行执行——串行不会打满上游速率限制，也让「1 发/账号」的额度消耗可解释。
   */
  router.post('/api/accounts/classify', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as { names?: unknown };
    const wanted = Array.isArray(payload.names)
      ? new Set(payload.names.filter((n): n is string => typeof n === 'string' && n.length > 0))
      : null;
    const targets = config().accounts.filter((a) => !!a.key && (wanted ? wanted.has(a.name) : true));
    if (!targets.length) {
      return sendError(
        c.res,
        400,
        wanted ? '没有匹配的账号' : '没有可体检的账号',
        'invalid_request_error',
        wanted ? 'accounts.classify.noTargets' : 'accounts.classify.noEnabled',
      );
    }
    if (ctx.classify.isRunning())
      return sendError(c.res, 409, '体检正在进行中，请稍候', 'invalid_request_error', 'accounts.classify.busy');
    const batch = await ctx.classify.classifyMany(targets, c.abortSignal);
    // 客户端中途离开：不再写响应（socket 已断）
    if (batch.cancelled) return;
    sendJSON(c.res, 200, { ok: true, ...batch });
  });

  router.post('/api/accounts/test', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const payload = (body.value ?? {}) as { key?: unknown; name?: unknown };
    // 两种用法：传 key（新增账号保存前测试）或传 name（测试已存账号——服务端取，前端拿不到明文）
    let key = String(payload.key ?? '').trim();
    if (!key && typeof payload.name === 'string') {
      key = config().accounts.find((a) => a.name === payload.name)?.key ?? '';
    }
    if (!key) return sendError(c.res, 400, 'key required');

    const started = Date.now();
    const gateway = primaryGateway(config());
    const model = gateway.knownModels[0] ?? 'cline-pass/glm-5.3-flash';
    const { json } = await fetchJSON(
      `${config().upstreamBase}/chat/completions`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 }),
        signal: c.abortSignal,
      },
      120_000,
    );
    const shaped = json as { error?: unknown } | null;
    if (shaped && typeof shaped === 'object' && shaped.error) {
      const message = typeof shaped.error === 'string' ? shaped.error : JSON.stringify(shaped.error);
      const authFail = /unauthorized|re-authenticate|invalid\s*api|401/i.test(message);
      // 密钥无效直接 Unauthorized；其他错误（如推理模型耗尽 max_tokens 的 empty response）
      // 说明鉴权已通过，不应误报为密钥问题
      return sendJSON(
        c.res,
        200,
        authFail
          ? {
              ok: false,
              ms: Date.now() - started,
              error: `密钥无效或未授权：${message.slice(0, 160)}`,
              notice: { code: 'account.keyInvalid', params: { message: message.slice(0, 160) } },
            }
          : {
              ok: true,
              ms: Date.now() - started,
              model,
              // 用户可见文案不在服务端拼：给稳定的 code + params，前端按语言映射
              notice: { code: 'account.keyOkGatewayNotice', params: { message: message.slice(0, 120) } },
            },
      );
    }
    sendJSON(c.res, 200, { ok: true, ms: Date.now() - started, model });
  });

  // ---- 网关管理（3.0 起「访问与安全」并入网关） ----

  router.get('/api/gateways', (c: Ctx) => {
    sendJSON(c.res, 200, {
      gateways: gatewayViews(ctx),
      maxGateways: MAX_GATEWAYS,
    });
  });

  router.post('/api/gateways/save', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const raw = ((body.value ?? {}) as { gateway?: unknown }).gateway;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return sendError(c.res, 400, 'gateway required');
    const payload = raw as Record<string, unknown>;

    const cfg = config();
    const id = typeof payload['id'] === 'string' ? payload['id'].trim() : '';
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(id))
      return sendError(
        c.res,
        400,
        '网关 id 需为 1-32 位的字母数字与连字符',
        'invalid_request_error',
        'gateway.idInvalid',
      );
    const existing = gatewayById(cfg, id);
    if (!existing && cfg.gateways.length >= MAX_GATEWAYS) {
      return sendError(c.res, 400, `最多只能有 ${MAX_GATEWAYS} 个网关`, 'invalid_request_error', 'gateway.limit', {
        max: MAX_GATEWAYS,
      });
    }

    const merged = mergeGatewayPayload({ ...payload, id }, existing);
    if (!merged.ok) {
      return sendError(c.res, 400, merged.message, 'invalid_request_error', merged.code, merged.params);
    }
    const gateway = merged.gateway;
    if (!existing) gateway.id = id;

    // 与启动闸门同一条规则：非回环地址 + 空密钥 = 任何人可白嫖，运行期保存也不许绕过
    if (!isLoopbackHost(gateway.bindHost) && !gateway.proxyKey && process.env['ALLOW_INSECURE_BIND'] !== '1') {
      return sendError(
        c.res,
        400,
        '绑定非回环地址时必须设置 API Key（或把绑定地址改成 127.0.0.1）',
        'invalid_request_error',
        'gateway.insecureBind',
      );
    }

    // 端口冲突在保存时就拦住：同地址同端口一定绑不上，没必要等到运行时报错
    const clash = cfg.gateways.find((g) => g.id !== id && bindingsConflict(g, gateway));
    if (clash)
      return sendError(
        c.res,
        409,
        `端口 ${gateway.port} 已被网关「${clash.name}」占用`,
        'invalid_request_error',
        'gateway.portConflict',
        { port: gateway.port, name: clash.name },
      );
    // 控制台是独立监听：网关也不能占用它的端口（反之亦然）
    if (bindingsConflict(cfg.console, gateway))
      return sendError(
        c.res,
        409,
        `端口 ${gateway.port} 已被控制台占用`,
        'invalid_request_error',
        'gateway.portConflictConsole',
        { port: gateway.port },
      );

    // 账号范围只保留存在的账号；自选范围下，single 指定的账号必须仍在范围里
    const alive = new Set(cfg.accounts.map((a) => a.name));
    gateway.accounts = [...new Set(gateway.accounts.filter((n) => alive.has(n)))];
    gateway.accountOrder = [...new Set(gateway.accountOrder.filter((n) => alive.has(n)))];
    if (gateway.activeAccount && !alive.has(gateway.activeAccount)) gateway.activeAccount = '';
    if (
      gateway.accountScope === 'custom' &&
      gateway.activeAccount &&
      !gateway.accounts.includes(gateway.activeAccount)
    ) {
      gateway.activeAccount = '';
    }

    // 新网关默认沿用「主网关」的下游密钥（桌面场景通常只需要一把）；
    // 想留空就显式传 proxyKey: null。
    if (!existing && !('proxyKey' in payload)) {
      const donor = gatewayById(cfg, 'main') ?? primaryGateway(cfg);
      if (donor && donor.id !== id) gateway.proxyKey = donor.proxyKey;
    }

    updateConfig(ctx, (draft) => {
      const index = draft.gateways.findIndex((g) => g.id === id);
      if (index >= 0) draft.gateways[index] = gateway;
      else draft.gateways.push(gateway);
    });

    const deferred = await applyGatewayChange(ctx, c, [id]);
    sendJSON(c.res, 200, { ok: true, deferred, gateways: gatewayViews(ctx) });
  });

  router.post('/api/gateways/delete', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const id = String(((body.value ?? {}) as { id?: unknown }).id ?? '').trim();
    const cfg = config();
    const target = gatewayById(cfg, id);
    if (!target) return sendError(c.res, 404, '网关不存在', 'not_found', 'gateway.notFound');
    if (cfg.gateways.length <= 1)
      return sendError(c.res, 400, '至少保留一个网关', 'invalid_request_error', 'gateway.lastOne');

    updateConfig(ctx, (draft) => {
      draft.gateways = draft.gateways.filter((g) => g.id !== id);
    });
    // 网关级观测随网关一起删除：以后新建同 id 的网关时不该继承旧的探测/渠道状态
    ctx.metaStore.update((m) => {
      delete m.models[id];
    });
    const deferred = await applyGatewayChange(ctx, c, [id]);
    sendJSON(c.res, 200, { ok: true, deferred, gateways: gatewayViews(ctx) });
  });

  router.get('/api/history', (c: Ctx) => {
    sendJSON(c.res, 200, { history: meta().history });
  });

  // 桌面壳/UI 的启停通道。放行条件（三重，全部满足）：
  // ① 来自回环地址——Docker/反代部署的远程请求来源不是 127.0.0.1，直接拒绝；
  // ② 无 Origin 且无 Referer——浏览器的跨源 fetch 必带 Origin（被拦），本机恶意网页
  //    打不到这里；非浏览器客户端（壳、curl）天然不带。本机恶意进程本来就能 taskkill，
  //    这不引入新的攻击面。
  // 鉴权不走 proxyKey：壳不应依赖用户的下游密钥配置。
  router.post('/api/shutdown', async (c: Ctx) => {
    const remote = c.req.socket.remoteAddress ?? '';
    const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
    const browserLike = c.req.headers['origin'] !== undefined || c.req.headers['referer'] !== undefined;
    if (!loopback || browserLike || !ctx.onShutdown) {
      sendError(c.res, 404, 'not found', 'not_found');
      return;
    }
    sendJSON(c.res, 200, { ok: true, message: '服务正在优雅关停' });
    // 让响应先落到线上再关停
    setTimeout(() => ctx.onShutdown?.('control-api'), 50);
  });

  router.get('/api/config', (c: Ctx) => {
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    sendJSON(c.res, 200, {
      gateway: { id: gateway.id, name: gateway.name },
      perModel: gateway.perModel,
      knownModels: gateway.knownModels,
    });
  });

  router.post('/api/config', async (c: Ctx) => {
    const body = await readJsonBody(c.req);
    if (!body.ok) return sendError(c.res, 400, body.reason === 'bad-json' ? 'invalid JSON body' : 'body too large');
    const gateway = requestGateway(ctx, c);
    if (!gateway) return sendError(c.res, 404, 'unknown gateway', 'not_found');
    const perModel = (body.value as { perModel?: unknown })?.perModel;
    if (perModel && typeof perModel === 'object' && !Array.isArray(perModel)) {
      updateConfig(ctx, (cfg) => {
        const target = cfg.gateways.find((g) => g.id === gateway.id);
        if (!target) return;
        for (const [model, raw] of Object.entries(perModel as Record<string, unknown>)) {
          target.perModel[model] = normalizePerModel(raw);
        }
      });
    }
    sendJSON(c.res, 200, { ok: true });
  });
}

/** 记录请求历史与账号统计（历史条数受 historyLimit 约束）。 */
export function recordHistory(
  ctx: AppContext,
  gatewayId: string,
  modelId: string,
  result: {
    account: { name: string } | null;
    trace: ChainResult['trace'];
    totalMs: number;
    outcome: string;
    routing: RoutingInfo;
    message?: string;
    degraded?: boolean;
  },
  options: { stream: boolean; pinMismatch?: boolean },
): void {
  ctx.metaStore.update((meta) => {
    const entry = {
      ts: Date.now(),
      gateway: gatewayId,
      model: modelId,
      provider: result.routing.finalProvider,
      canonical: result.routing.canonicalSlug,
      ms: result.totalMs,
      stream: options.stream,
      error: result.outcome === 'failure' ? (result.message ?? null) : null,
      account: result.account?.name ?? null,
      attempts: result.trace.map((t) => t.upstream ?? 'auto'),
      trace: result.trace,
      pinMismatch: options.pinMismatch ?? false,
    };
    meta.history.unshift(entry);
    if (meta.history.length > ctx.configStore.value.historyLimit)
      meta.history.length = ctx.configStore.value.historyLimit;

    if (result.account) {
      const name = result.account.name;
      const existing = meta.stats[name];
      const st = existing ?? { requests: 0, lastUsed: null, lastError: null };
      meta.stats[name] = st;
      st.requests += 1;
      st.lastUsed = Date.now();
      st.lastError = result.outcome === 'failure' ? (result.message ?? null) : null;
    }
  });
}
