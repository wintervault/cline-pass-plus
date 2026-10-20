import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../src/appContext.ts';
import { gatewayUsableAccounts } from '../src/config/derive.ts';
import { defaultConfig, defaultGateway, type Gateway } from '../src/config/schema.ts';
import { GatewayManager, type GatewayRuntime } from '../src/gateways/manager.ts';
import { sendError, sendJSON } from '../src/http/respond.ts';
import { type Ctx, Router } from '../src/http/router.ts';
import { recordHistory, registerApiRoutes } from '../src/http/routes/api.ts';
import { createHttpServer } from '../src/http/server.ts';
import { JsonStore } from '../src/store/jsonStore.ts';
import { defaultMeta, type MetaFile } from '../src/upstream/types.ts';
import { listen, request } from './helpers/http.ts';

let dir: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-gateway-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

/** 运行时桩：网关管理测试只关心 listener，不跑请求链。 */
const stubRuntime = (id: string): GatewayRuntime =>
  ({
    id,
    pool: {},
    health: {},
    chain: {},
    probe: {},
    server: null,
    bound: null,
    status: { id, state: 'stopped', boundPort: null, boundHost: null },
  }) as unknown as GatewayRuntime;

const pingServer = (gatewayId: string): http.Server =>
  createHttpServer({
    gatewayId,
    handler: (c: Ctx) => sendJSON(c.res, 200, { gateway: c.gatewayId }),
  });

/** 拿一个当前空闲的端口（先绑 0 再关掉）。 */
async function freePort(): Promise<number> {
  const probe = http.createServer();
  const { port, close } = await listen(probe);
  await close();
  return port;
}

describe('GatewayManager', () => {
  it('绑定失败局部化：一个端口被占用，另一个照常运行并可访问', async () => {
    const blocker = http.createServer((_req, res) => res.end('busy'));
    const taken = await listen(blocker);
    closers.push(taken.close);

    const config = defaultConfig();
    config.gateways = [defaultGateway({ id: 'a', port: 0 }), defaultGateway({ id: 'b', port: taken.port })];
    const manager = new GatewayManager({ config: () => config, createRuntime: stubRuntime, createServer: pingServer });
    closers.push(() => manager.closeAll(200));

    await manager.reconcile();
    const byId = new Map(manager.statuses().map((s) => [s.id, s]));
    expect(byId.get('a')?.state).toBe('running');
    expect(byId.get('a')?.boundPort).toBeGreaterThan(0);
    expect(byId.get('b')?.state).toBe('error');
    expect(byId.get('b')?.error).toBeTruthy();

    // 运行中的那个网关照常服务
    const port = byId.get('a')?.boundPort ?? 0;
    const res = await request(port, '/');
    expect(res.json<{ gateway: string }>().gateway).toBe('a');
  });

  it('新增网关自动监听、删除网关自动关闭', async () => {
    const config = defaultConfig();
    config.gateways = [defaultGateway({ id: 'a', port: 0 })];
    const manager = new GatewayManager({ config: () => config, createRuntime: stubRuntime, createServer: pingServer });
    closers.push(() => manager.closeAll(200));
    await manager.reconcile();
    expect(manager.list()).toHaveLength(1);

    config.gateways.push(defaultGateway({ id: 'b', port: 0 }));
    await manager.reconcile();
    expect(manager.list()).toHaveLength(2);
    expect(manager.statuses().every((s) => s.state === 'running')).toBe(true);

    config.gateways = config.gateways.filter((g) => g.id !== 'a');
    await manager.reconcile();
    expect(manager.get('a')).toBeNull();
    expect(manager.get('b')?.status.state).toBe('running');
  });

  it('端口变化触发重绑', async () => {
    const config = defaultConfig();
    const first = await freePort();
    config.gateways = [defaultGateway({ id: 'a', port: first })];
    const manager = new GatewayManager({ config: () => config, createRuntime: stubRuntime, createServer: pingServer });
    closers.push(() => manager.closeAll(200));
    await manager.reconcile();
    expect(manager.get('a')?.status.boundPort).toBe(first);

    const next = await freePort();
    const gateway = config.gateways[0];
    if (!gateway) throw new Error('缺少网关');
    gateway.port = next;
    await manager.reconcile();
    expect(manager.get('a')?.status.boundPort).toBe(next);
    expect((await request(next, '/')).status).toBe(200);
  });
});

describe('网关 API', () => {
  interface Harness {
    port: number;
    ctx: AppContext;
    configStore: JsonStore<ReturnType<typeof defaultConfig>>;
    metaStore: JsonStore<MetaFile>;
  }

  async function harness(gateways: Gateway[]): Promise<Harness> {
    const config = defaultConfig();
    config.accounts = [{ name: 'A', key: 'sk_a' }];
    config.gateways = gateways;
    const configStore = new JsonStore(path.join(dir, 'config.json'), config, { debounceMs: 1 });
    const meta = defaultMeta();
    const metaStore = new JsonStore<MetaFile>(path.join(dir, 'metadata.json'), meta, { debounceMs: 1 });
    closers.push(async () => {
      configStore.close();
      metaStore.close();
      await Promise.all([configStore.flush(), metaStore.flush()]);
    });

    const manager = new GatewayManager({
      config: () => configStore.value,
      createRuntime: stubRuntime,
      createServer: (id) => pingServer(id),
    });
    closers.push(() => manager.closeAll(200));

    const ctx: AppContext = {
      version: 'test',
      startedAt: Date.now(),
      configStore,
      metaStore,
      gateways: manager,
      classify: {} as AppContext['classify'],
      catalog: {} as AppContext['catalog'],
    };
    const router = new Router();
    registerApiRoutes(ctx, router);
    // 先让网关真正监听：status 才是 running（保存/删除会再次 reconcile）
    await manager.reconcile();
    const server = createHttpServer({
      gatewayId: configStore.value.console.gatewayId,
      handler: (c: Ctx) => {
        const route = router.resolve(c.method, c.path);
        if (!route) {
          sendError(c.res, 404, 'no route', 'not_found');
          return;
        }
        return route(c);
      },
    });
    const { port, close } = await listen(server);
    closers.push(close);
    return { port, ctx, configStore, metaStore };
  }

  it('GET /api/gateways：给出运行状态与统计，不回传明文密钥', async () => {
    const port = await freePort();
    const { port: apiPort } = await harness([
      defaultGateway({ id: 'main', port, proxyKey: 'sk_secret', knownModels: ['cline-pass/x'] }),
    ]);
    const res = await request(apiPort, '/api/gateways');
    const body = res.json<{ gateways: Array<Record<string, unknown>>; consoleGatewayId: string }>();
    expect(body.consoleGatewayId).toBe('main');
    const main = body.gateways[0];
    if (!main) throw new Error('缺少网关卡');
    expect(main?.['proxyKey']).toBeUndefined();
    expect(main?.['hasProxyKey']).toBe(true);
    expect(main?.['modelCount']).toBe(1);
    expect(main?.['accountCount']).toBe(1);
    expect((main['status'] as { state: string }).state).toBe('running');
  });

  it('保存新网关：创建、绑定、出现在列表里', async () => {
    const mainPort = await freePort();
    const secondPort = await freePort();
    const { port: apiPort, configStore } = await harness([defaultGateway({ id: 'main', port: mainPort })]);

    const res = await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: {
        gateway: {
          id: 'risk',
          name: '风控号专用',
          port: secondPort,
          bindHost: '127.0.0.1',
          accountScope: 'custom',
          accounts: ['A'],
          accountMode: 'single',
          activeAccount: 'A',
          knownModels: ['cline-pass/mimo-v2.5-pro'],
        },
      },
    });
    expect(res.status).toBe(200);
    expect(configStore.value.gateways.map((g) => g.id)).toEqual(['main', 'risk']);
    const saved = configStore.value.gateways[1];
    expect(saved?.name).toBe('风控号专用');
    expect(saved?.activeAccount).toBe('A');
    expect(saved?.perModel).toEqual({});

    const list = await request(apiPort, '/api/gateways');
    const gateways = list.json<{ gateways: Array<{ id: string; status: { state: string } }> }>().gateways;
    expect(gateways.find((g) => g.id === 'risk')?.status.state).toBe('running');
  });

  it('端口冲突在保存时就拦住（409），不等到运行时', async () => {
    const mainPort = await freePort();
    const { port: apiPort, configStore } = await harness([defaultGateway({ id: 'main', port: mainPort })]);
    const res = await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'dup', name: '撞端口', port: mainPort } },
    });
    expect(res.status).toBe(409);
    expect(configStore.value.gateways).toHaveLength(1);
  });

  it('新网关默认沿用主网关的下游密钥；显式 null 才留空', async () => {
    const p1 = await freePort();
    const p2 = await freePort();
    const p3 = await freePort();
    const { port: apiPort, configStore } = await harness([
      defaultGateway({ id: 'main', port: p1, proxyKey: 'sk_main_key' }),
    ]);
    await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'risk', name: '风控号', port: p2 } },
    });
    expect(configStore.value.gateways.find((g) => g.id === 'risk')?.proxyKey).toBe('sk_main_key');

    await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'open', name: '公开', port: p3, proxyKey: null } },
    });
    expect(configStore.value.gateways.find((g) => g.id === 'open')?.proxyKey).toBe('');
  });

  it('proxyKey 三态：留空保持、null 清除、非空设置', async () => {
    const mainPort = await freePort();
    const { port: apiPort, configStore } = await harness([
      defaultGateway({ id: 'main', port: mainPort, proxyKey: 'sk_secret' }),
    ]);
    const save = (gateway: Record<string, unknown>) =>
      request(apiPort, '/api/gateways/save', { method: 'POST', body: { gateway: { id: 'main', ...gateway } } });

    await save({ name: '主网关' });
    expect(configStore.value.gateways[0]?.proxyKey).toBe('sk_secret');

    await save({ proxyKey: null });
    expect(configStore.value.gateways[0]?.proxyKey).toBe('');

    await save({ proxyKey: '  sk_new  ' });
    expect(configStore.value.gateways[0]?.proxyKey).toBe('sk_new');
  });

  it('删除：最后一个与控制台网关不可删，其它可删', async () => {
    const p1 = await freePort();
    const p2 = await freePort();
    const { port: apiPort, configStore } = await harness([
      defaultGateway({ id: 'main', port: p1 }),
      defaultGateway({ id: 'other', port: p2 }),
    ]);

    expect((await request(apiPort, '/api/gateways/delete', { method: 'POST', body: { id: 'main' } })).status).toBe(400);

    const del = await request(apiPort, '/api/gateways/delete', { method: 'POST', body: { id: 'other' } });
    expect(del.status).toBe(200);
    expect(configStore.value.gateways.map((g) => g.id)).toEqual(['main']);

    expect((await request(apiPort, '/api/gateways/delete', { method: 'POST', body: { id: 'main' } })).status).toBe(400);
  });

  it('切换控制台网关', async () => {
    const p1 = await freePort();
    const p2 = await freePort();
    const { port: apiPort, configStore } = await harness([
      defaultGateway({ id: 'main', port: p1 }),
      defaultGateway({ id: 'other', port: p2 }),
    ]);
    const res = await request(apiPort, '/api/gateways/console', { method: 'POST', body: { id: 'other' } });
    expect(res.status).toBe(200);
    expect(configStore.value.console.gatewayId).toBe('other');
    // 旧控制台网关现在可以删了
    expect((await request(apiPort, '/api/gateways/delete', { method: 'POST', body: { id: 'main' } })).status).toBe(200);
  });

  it('不能把控制台切到没起来的网关（否则旧控制台一停就再也进不来）', async () => {
    const p1 = await freePort();
    const blocker = http.createServer((_req, res) => res.end('busy'));
    const taken = await listen(blocker);
    closers.push(taken.close);
    const { port: apiPort, configStore } = await harness([
      defaultGateway({ id: 'main', port: p1 }),
      defaultGateway({ id: 'dead', port: taken.port }),
    ]);
    expect(configStore.value.console.gatewayId).toBe('main');

    const res = await request(apiPort, '/api/gateways/console', { method: 'POST', body: { id: 'dead' } });
    expect(res.status).toBe(409);
    expect(res.json<{ error: { code?: string } }>().error.code).toBe('gateway.notRunning');
    expect(configStore.value.console.gatewayId).toBe('main');
  });

  it('桌面壳固定 PORT 时，切控制台会交换端口并返回真实的新地址', async () => {
    const p1 = await freePort();
    const p2 = await freePort();
    const { port: apiPort, configStore } = await harness([
      defaultGateway({ id: 'main', port: p1 }),
      defaultGateway({ id: 'other', port: p2 }),
    ]);
    const previous = process.env['PORT'];
    process.env['PORT'] = String(p1);
    try {
      const res = await request(apiPort, '/api/gateways/console', { method: 'POST', body: { id: 'other' } });
      expect(res.status).toBe(200);
      expect(configStore.value.console.gatewayId).toBe('other');
      // 新控制台接管壳固定的端口，原控制台网关接管它的旧端口
      expect(configStore.value.gateways.find((g) => g.id === 'other')?.port).toBe(p1);
      expect(configStore.value.gateways.find((g) => g.id === 'main')?.port).toBe(p2);
      expect(res.json<{ consoleUrl: string }>().consoleUrl).toBe(`http://127.0.0.1:${p1}`);
    } finally {
      if (previous === undefined) delete process.env['PORT'];
      else process.env['PORT'] = previous;
    }
  });

  it('网关启用开关：停用后 listener 关闭、状态变为 disabled，可再启用', async () => {
    const p1 = await freePort();
    const p2 = await freePort();
    const { port: apiPort, configStore } = await harness([
      defaultGateway({ id: 'main', port: p1 }),
      defaultGateway({ id: 'other', port: p2 }),
    ]);
    const save = (gateway: Record<string, unknown>) =>
      request(apiPort, '/api/gateways/save', { method: 'POST', body: { gateway: { id: 'other', ...gateway } } });

    expect((await save({ enabled: false })).status).toBe(200);
    expect(configStore.value.gateways.find((g) => g.id === 'other')?.enabled).toBe(false);
    const list = await request(apiPort, '/api/gateways');
    expect(
      list.json<{ gateways: Array<{ id: string; status: { state: string } }> }>().gateways.find((g) => g.id === 'other')
        ?.status.state,
    ).toBe('disabled');
    let listening = true;
    try {
      await request(p2, '/healthz');
    } catch {
      listening = false;
    }
    expect(listening).toBe(false);

    expect((await save({ enabled: true })).status).toBe(200);
    expect(
      (await request(apiPort, '/api/gateways'))
        .json<{
          gateways: Array<{ id: string; status: { state: string } }>;
        }>()
        .gateways.find((g) => g.id === 'other')?.status.state,
    ).toBe('running');
  });

  it('控制台网关不能被停用（否则控制台再也进不去）', async () => {
    const p1 = await freePort();
    const p2 = await freePort();
    const { port: apiPort } = await harness([
      defaultGateway({ id: 'main', port: p1 }),
      defaultGateway({ id: 'other', port: p2 }),
    ]);
    const res = await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'main', enabled: false } },
    });
    expect(res.status).toBe(409);
    expect(res.json<{ error: { code?: string } }>().error.code).toBe('gateway.consoleDisabled');
  });

  it('账号改名 / 删除会同步迁移 gateway.accountOrder（粘性优先级不丢）', async () => {
    const p1 = await freePort();
    const { port: apiPort, configStore } = await harness([defaultGateway({ id: 'main', port: p1 })]);
    await request(apiPort, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [
          { name: 'A', key: 'sk_a', existingIndex: 0 },
          { name: 'B', key: 'sk_b', existingIndex: null },
        ],
      },
    });
    await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'main', accountScope: 'all', accountOrder: ['B', 'A'] } },
    });
    // B → C（改名）
    await request(apiPort, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [
          { name: 'A', key: '', existingIndex: 0 },
          { name: 'C', key: '', existingIndex: 1 },
        ],
      },
    });
    expect(configStore.value.gateways[0]?.accountOrder).toEqual(['C', 'A']);
    // 删除 A
    await request(apiPort, '/api/accounts', {
      method: 'POST',
      body: { accounts: [{ name: 'C', key: '', existingIndex: 1 }] },
    });
    expect(configStore.value.gateways[0]?.accountOrder).toEqual(['C']);
  });

  it('/api/meta 的 configured 按账号范围与体检结论计算（回归：切到「全部正常」后误报未配置）', async () => {
    const p1 = await freePort();
    const { port: apiPort, configStore, metaStore } = await harness([defaultGateway({ id: 'main', port: p1 })]);
    await request(apiPort, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [
          { name: 'A', key: 'sk_a', existingIndex: 0 },
          { name: 'B', key: 'sk_b', existingIndex: null },
        ],
      },
    });
    metaStore.update((m) => {
      m.accountClass['A'] = { class: 'normal', checkedAt: 1 };
      m.accountClass['B'] = { class: 'private', checkedAt: 1 };
    });
    await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'main', accountScope: 'normal' } },
    });
    expect(configStore.value.gateways[0]?.accountScope).toBe('normal');
    const meta = await request(apiPort, '/api/meta');
    expect(meta.json<{ configured: boolean }>().configured).toBe(true);
  });

  it('模型清单按网关隔离（/api/models?gateway=）', async () => {
    const p1 = await freePort();
    const p2 = await freePort();
    const { port: apiPort, ctx } = await harness([
      defaultGateway({ id: 'main', port: p1, knownModels: ['cline-pass/a'] }),
      defaultGateway({ id: 'risk', port: p2, knownModels: ['cline-pass/b'] }),
    ]);
    // catalog() 会尝试访问上游：这里给一个固定实现，避免触网
    ctx.catalog = { catalog: async () => [] } as unknown as AppContext['catalog'];

    const a = await request(apiPort, '/api/models?gateway=main');
    const b = await request(apiPort, '/api/models?gateway=risk');
    expect(a.json<{ subscription: Array<{ id: string }> }>().subscription.map((r) => r.id)).toEqual(['cline-pass/a']);
    expect(b.json<{ subscription: Array<{ id: string }> }>().subscription.map((r) => r.id)).toEqual(['cline-pass/b']);

    const unknown = await request(apiPort, '/api/models?gateway=nope');
    expect(unknown.status).toBe(404);
  });

  it('自选范围：只用列出的账号，删除账号后不会悄悄放大成全部', async () => {
    const mainPort = await freePort();
    const { port: apiPort, configStore } = await harness([defaultGateway({ id: 'main', port: mainPort })]);
    // 再加一个账号，并把网关限制到 A
    await request(apiPort, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [
          { name: 'A', key: 'sk_a', existingIndex: 0 },
          { name: 'B', key: 'sk_b', existingIndex: null },
        ],
      },
    });
    await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'main', name: '主网关', accountScope: 'custom', accounts: ['A'] } },
    });
    const gateway = configStore.value.gateways[0];
    if (!gateway) throw new Error('缺少网关');
    expect(gateway.accountScope).toBe('custom');
    expect(gateway.accounts).toEqual(['A']);
    expect(gatewayUsableAccounts(configStore.value, gateway)).toHaveLength(1);

    // 删掉 A：范围变空，但仍是自选 → 0 个账号（而不是全部）
    await request(apiPort, '/api/accounts', {
      method: 'POST',
      body: { accounts: [{ name: 'B', key: 'sk_b', existingIndex: 1 }] },
    });
    const after = configStore.value.gateways[0];
    if (!after) throw new Error('缺少网关');
    expect(after.accountScope).toBe('custom');
    expect(after.accounts).toEqual([]);
    expect(gatewayUsableAccounts(configStore.value, after)).toHaveLength(0);
  });

  it('正常/风控范围按体检结论动态计算，账号顺序按 accountOrder 保存', async () => {
    const mainPort = await freePort();
    const { port: apiPort, configStore, metaStore } = await harness([defaultGateway({ id: 'main', port: mainPort })]);
    await request(apiPort, '/api/accounts', {
      method: 'POST',
      body: {
        accounts: [
          { name: 'A', key: 'sk_a', existingIndex: 0 },
          { name: 'B', key: 'sk_b', existingIndex: null },
        ],
      },
    });
    metaStore.update((m) => {
      m.accountClass['A'] = { class: 'normal', checkedAt: 1 };
      m.accountClass['B'] = { class: 'private', checkedAt: 1 };
    });

    const save = (gateway: Record<string, unknown>) =>
      request(apiPort, '/api/gateways/save', {
        method: 'POST',
        body: { gateway: { id: 'main', name: '主网关', ...gateway } },
      });
    const count = async (): Promise<number> => {
      const list = await request(apiPort, '/api/gateways');
      return list.json<{ gateways: Array<{ id: string; accountCount: number }> }>().gateways[0]?.accountCount ?? -1;
    };

    expect((await save({ accountScope: 'private', accountOrder: ['B', 'A'] })).status).toBe(200);
    expect(configStore.value.gateways[0]?.accountOrder).toEqual(['B', 'A']);
    expect(await count()).toBe(1); // 只有 B 是风控号

    expect((await save({ accountScope: 'normal' })).status).toBe(200);
    expect(await count()).toBe(1); // A

    // 结论翻转（体检是观测值）：范围跟着变，不需要重新保存网关
    metaStore.update((m) => {
      m.accountClass['B'] = { class: 'normal', checkedAt: 2 };
    });
    expect(await count()).toBe(2);

    expect((await save({ accountScope: 'all' })).status).toBe(200);
    expect(await count()).toBe(2);
  });

  it('保存网关时也执行「非回环 + 空密钥」闸门', async () => {
    const mainPort = await freePort();
    const { port: apiPort } = await harness([defaultGateway({ id: 'main', port: mainPort })]);
    const res = await request(apiPort, '/api/gateways/save', {
      method: 'POST',
      body: { gateway: { id: 'main', name: '主网关', bindHost: '0.0.0.0', proxyKey: null } },
    });
    expect(res.status).toBe(400);
  });

  it('请求历史带 gateway 字段', async () => {
    const { ctx } = await harness([defaultGateway({ id: 'main', port: 0 })]);
    recordHistory(
      ctx,
      'risk',
      'cline-pass/x',
      {
        account: { name: 'A' },
        trace: [],
        totalMs: 12,
        outcome: 'success',
        routing: {
          content: null,
          usage: null,
          pipeline: 'planner',
          canonicalSlug: null,
          finalProvider: 'deepseek',
          finalProviderName: 'deepseek',
          fallbacks: [],
          plan: '',
        },
      },
      { stream: false },
    );
    expect(ctx.metaStore.value.history[0]?.gateway).toBe('risk');
  });
});
