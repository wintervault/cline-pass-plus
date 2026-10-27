#!/usr/bin/env node
/**
 * 生成一份**演示数据**（config.json + metadata.json），用于界面评审、截图与 UI 验收。
 *
 * 为什么需要它：真实数据里有账号密钥与邮箱，不能进仓库、也不能出现在截图里
 * （CLAUDE.md 的硬性约定）。演示数据全部是虚构账号与假密钥，可以放心摆进文档。
 *
 * 用法：
 *   node scripts/demo-data.mjs --data %TEMP%/cps-demo
 *   node scripts/demo-data.mjs --data %TEMP%/cps-demo --force   # 覆盖已有文件
 *
 * 生成后按隔离实例启动（不要碰线上实例）：
 *   npm run dev:isolated -- --data <目录>
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const dir = resolve(flag('--data', 'cps-demo'));
const force = args.includes('--force');
const configPath = join(dir, 'config.json');
const metaPath = join(dir, 'metadata.json');
if (!force && (existsSync(configPath) || existsSync(metaPath))) {
  console.error(`[demo] ${dir} 已有配置或观测数据；要覆盖请加 --force`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true });

const now = Date.now();
const minutes = (n) => now - n * 60_000;
const hours = (n) => now - n * 3_600_000;
const days = (n) => now - n * 86_400_000;
const day = (ts) => new Date(ts).toISOString().slice(0, 10);

const ACCOUNTS = [
  { name: '演示账号 A', key: 'sk-demo-a-000000000001', expiresAt: day(days(-22)) },
  { name: '演示账号 B', key: 'sk-demo-b-000000000002', expiresAt: day(days(-3)) },
  { name: '演示账号 C', key: 'sk-demo-c-000000000003' },
];

const MODELS = [
  'cline-pass/glm-5.3-flash',
  'cline-pass/kimi-k3',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/qwen3.8-max',
  'cline-pass/minimax-m3',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.2',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/kimi-k2.7-code',
  'cline-pass/qwen3.7-max',
];

const PROVIDERS = [
  { slug: 'fireworks', name: 'Fireworks', context: 128000 },
  { slug: 'together', name: 'Together', context: 128000 },
  { slug: 'deepinfra', name: 'DeepInfra', context: 64000 },
  { slug: 'novita', name: 'Novita', context: 32768 },
  { slug: 'openrouter', name: 'OpenRouter', context: 200000 },
];

/** 一个模型的检测记录。账号 A 正常、账号 B 被风控（钉住参数被忽略）。 */
function modelMeta(index, { ignored = false } = {}) {
  const providers = PROVIDERS.slice(0, (index % 3) + 2).map((p) => p.slug);
  const detail = {};
  const status = {};
  for (const [i, p] of providers.entries()) {
    const info = PROVIDERS.find((x) => x.slug === p);
    detail[p] = { name: info.name, endpoints: (i % 3) + 1, context: info.context, uptime: 0.98 - i * 0.07 };
    status[p] =
      i === providers.length - 1 && index % 5 === 0
        ? { status: 'bad', note: 'HTTP 500：上游错误', ms: 820 + i * 120, checkedAt: minutes(40 + i) }
        : { status: 'ok', ms: 320 + i * 260, checkedAt: minutes(40 + i) };
  }
  return {
    pipeline: 'planner',
    pinnable: !ignored,
    pinState: ignored ? 'ignored' : 'enforced',
    pinProbeAt: hours(3),
    pinDisabledReason: ignored ? '探针请求返回 200，钉住参数被丢弃（实际路由：openai-compatible-private）' : null,
    availableProviders: providers,
    upstreams: [...providers, 'openai-compatible-private'],
    upstreamDetail: detail,
    upstreamStatus: status,
    tier0: providers.slice(0, 2),
    canonicalSlug: null,
    openrouterSlug: null,
    lastProvider: providers[0],
    lastMs: 640 + index * 90,
    probedAt: hours(3),
    validatedAt: minutes(40),
  };
}

const accountModels = {
  '演示账号 A': Object.fromEntries(MODELS.map((id, i) => [id, modelMeta(i)])),
  '演示账号 B': Object.fromEntries(MODELS.slice(0, 5).map((id, i) => [id, modelMeta(i, { ignored: true })])),
};

const history = [];
const seed = [
  ['cline-pass/glm-5.3', 'fireworks', '演示账号 A', 'main', true, 2140, null, [['fireworks', 200, 2140, '']]],
  ['cline-pass/kimi-k3', 'together', '演示账号 A', 'main', true, 3860, null, [['together', 200, 3860, '']]],
  [
    'cline-pass/deepseek-v4.1-flash',
    'deepinfra',
    '演示账号 A',
    'main',
    false,
    720,
    null,
    [['deepinfra', 200, 720, '']],
  ],
  ['cline-pass/qwen3.8-max', 'novita', '演示账号 A', 'edge', true, 5120, null, [['novita', 200, 5120, '']]],
  [
    'cline-pass/glm-5.3',
    'fireworks',
    '演示账号 B',
    'main',
    true,
    2680,
    'HTTP 429：rate limit exceeded',
    [
      ['fireworks', 429, 380, 'rate limit exceeded'],
      ['together', 200, 2680, ''],
    ],
  ],
  ['cline-pass/mimo-v2.5-pro', 'openrouter', '演示账号 A', 'edge', false, 1580, null, [['openrouter', 200, 1580, '']]],
  [
    'cline-pass/glm-5.2',
    null,
    '演示账号 C',
    'main',
    true,
    940,
    'INFERENCE_CAP_ERROR：账号额度已用尽',
    [['auto', 502, 940, 'Error 429: monthly limit reached，resets in 10d']],
  ],
  [
    'cline-pass/deepseek-v4-pro',
    'together',
    '演示账号 A',
    'main',
    false,
    6400,
    null,
    [
      ['deepinfra', 500, 1240, 'upstream error'],
      ['together', 200, 6400, ''],
    ],
  ],
  ['cline-pass/kimi-k2.7-code', 'fireworks', '演示账号 B', 'edge', true, 2950, null, [['fireworks', 200, 2950, '']]],
  ['cline-pass/qwen3.7-max', 'openrouter', '演示账号 A', 'main', true, 4380, null, [['openrouter', 200, 4380, '']]],
  ['cline-pass/minimax-m3', 'novita', '演示账号 A', 'main', false, 510, null, [['novita', 200, 510, '']]],
  ['cline-pass/glm-5.3-flash', 'together', '演示账号 B', 'main', true, 1120, null, [['together', 200, 1120, '']]],
];

seed.forEach(([model, provider, account, gateway, stream, ms, error, trace], i) => {
  history.push({
    ts: minutes(6 + i * 13),
    gateway,
    model,
    provider: error ? null : provider,
    canonical: provider === 'openrouter' ? model : null,
    ms,
    stream,
    error,
    account,
    attempts: [],
    trace: trace.map(([upstream, status, t, note]) => ({ upstream, status, ms: t, note })),
    pinMismatch: false,
  });
});

const metadata = {
  models: {
    main: Object.fromEntries(MODELS.slice(0, 8).map((id, i) => [id, modelMeta(i)])),
    edge: Object.fromEntries(MODELS.slice(0, 4).map((id, i) => [id, modelMeta(i)])),
  },
  accountModels,
  history,
  catalog: MODELS.concat(['cline-pass/sonnet-5', 'cline-pass/gpt-6.1', 'cline-pass/gemini-4-pro']),
  catalogFetchedAt: hours(6),
  orModelList: null,
  orModelsFetchedAt: 0,
  officialModelsFetch: {
    ts: hours(6),
    sources: ['api.cline.bot', 'openrouter.ai'],
    found: 15,
    added: ['cline-pass/sonnet-5', 'cline-pass/gpt-6.1', 'cline-pass/gemini-4-pro'],
    total: 15,
  },
  stats: {
    '演示账号 A': { requests: 1284, lastUsed: minutes(6), lastError: null },
    '演示账号 B': { requests: 402, lastUsed: minutes(19), lastError: 'HTTP 429：rate limit exceeded' },
    '演示账号 C': { requests: 37, lastUsed: hours(28), lastError: 'INFERENCE_CAP_ERROR：账号额度已用尽' },
  },
  accountClass: {
    '演示账号 A': { class: 'normal', checkedAt: hours(2) },
    '演示账号 B': { class: 'private', checkedAt: hours(2) },
    '演示账号 C': {
      class: 'unknown',
      checkedAt: minutes(12),
      reason: 'quota',
      note: '上游返回 HTTP 502：Error 429: monthly limit reached',
    },
  },
};

const config = {
  version: 5,
  upstreamBase: 'https://api.cline.bot/api/v1',
  accounts: ACCOUNTS,
  classifyModel: 'cline-pass/deepseek-v4.1-flash',
  gateways: [
    {
      id: 'main',
      name: '主网关',
      enabled: true,
      port: 3136,
      bindHost: '127.0.0.1',
      proxyKey: 'sk-demo-downstream',
      publicBaseUrl: '',
      corsOrigins: [],
      exposeCatalog: false,
      accountScope: 'all',
      accounts: [],
      accountOrder: ['演示账号 A', '演示账号 B', '演示账号 C'],
      accountMode: 'sticky',
      activeAccount: '',
      knownModels: MODELS,
      perModel: {
        'cline-pass/glm-5.3': {
          upstreams: ['fireworks', 'together'],
          exclude: ['novita'],
          pinMode: 'strict',
          sort: 'ttft',
        },
        'cline-pass/kimi-k3': { upstreams: ['together'], exclude: [], pinMode: 'preferred', sort: null },
      },
      failover: {
        attemptTimeoutMs: 60000,
        idleTimeoutMs: 60000,
        budgetMs: 90000,
        retriesPerChannel: 1,
        cooldownMs: 300000,
        retryBackoffMs: 500,
      },
    },
    {
      id: 'edge',
      name: '边缘网关',
      enabled: true,
      port: 3137,
      bindHost: '127.0.0.1',
      proxyKey: '',
      publicBaseUrl: '',
      corsOrigins: [],
      exposeCatalog: true,
      accountScope: 'normal',
      accounts: [],
      accountOrder: [],
      accountMode: 'roundrobin',
      activeAccount: '',
      knownModels: MODELS.slice(0, 6),
      perModel: {},
      failover: {
        attemptTimeoutMs: 60000,
        idleTimeoutMs: 60000,
        budgetMs: 90000,
        retriesPerChannel: 1,
        cooldownMs: 300000,
        retryBackoffMs: 500,
      },
    },
  ],
  console: { port: 3125, bindHost: '127.0.0.1', proxyKey: '' },
  historyLimit: 500,
};

writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
writeFileSync(metaPath, `${JSON.stringify(metadata, null, 2)}\n`);
console.log(`[demo] 已写入 ${configPath}`);
console.log(`[demo] 已写入 ${metaPath}（${history.length} 条历史，${ACCOUNTS.length} 个演示账号）`);
