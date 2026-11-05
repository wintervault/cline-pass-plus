import { z } from 'zod';

import { isIsoDate } from './date.ts';
import { MAX_GROUPS_PER_ACCOUNT, normalizeTags } from './tags.ts';

/** 当前配置格式版本。加载到更低版本会触发迁移，更高版本拒绝启动（避免新版写的配置被旧版改坏）。 */
export const CONFIG_VERSION = 7;

/**
 * 控制台监听默认端口（2.1 起独立于网关）。
 *
 * 为什么不再跟网关共用：控制台是「本机管理界面」，网关是「给客户端用的接入面」。
 * 绑在一起时，网关绑不上就等于控制台也进不去，而且控制台所在网关永远不能停用/删除。
 * 拆开后两边各自监听、各自失败，互不连带。
 *
 * 端口布局：3122 = 桌面壳控制通道，3125 = 控制台，3126 起 = 网关。
 */
export const DEFAULT_CONSOLE_PORT = 3125;

/** 网关默认端口的起点（新建网关从这里往后找空位）。 */
export const DEFAULT_GATEWAY_PORT = 3126;

/** 上游网关默认地址（Cline 官方）。 */
export const DEFAULT_UPSTREAM_BASE = 'https://api.cline.bot/api/v1';

/**
 * 订阅模型默认清单。这是「初始值」而非「权威清单」——启动后可点「拉取官方最新模型」合并，
 * 以及任何经代理成功调用的 `cline-pass/*` 模型会自动收录。
 */
export const DEFAULT_KNOWN_MODELS = [
  'cline-pass/deepseek-v4.1-flash-1017',
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.3-flash',
  'cline-pass/glm-5.2',
  'cline-pass/kimi-k3.1-pro',
  'cline-pass/kimi-k3',
  'cline-pass/kimi-k2.7-code',
  'cline-pass/kimi-k2.6',
  'cline-pass/qwen3.8-max',
  'cline-pass/qwen3.7-max',
  'cline-pass/qwen3.7-plus',
  'cline-pass/minimax-m3.1-flash',
  'cline-pass/minimax-m3',
  'cline-pass/mimo-v2.6-pro',
  'cline-pass/mimo-v2.6-flash',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/mimo-v2.5',
  'cline-pass/muse-spark-1.3-contributor',
];

export const AccountSchema = z.object({
  name: z.string().min(1).max(50).catch('账号'),
  key: z.string().min(1),
  /**
   * 用户声明的到期日期（本地日期 `YYYY-MM-DD`，可缺省）。
   * 非法日期按「未设置」处理而不是丢弃整个账号——手改配置写错一个数字，
   * 不该把密钥一起丢掉。**到期只提醒**：它不改变账号参与哪个网关。
   */
  expiresAt: z.string().refine(isIsoDate, '日期格式应为 YYYY-MM-DD').optional().catch(undefined),
  /**
   * 用户自定义分组（2.3.0 起）。自由标签，最多 8 个、每个不超过 24 字，用于网关的
   * 「按分组」账号范围与列表筛选。**分组是用户的事实，不是观测**——网关不参与决定。
   *
   * 归一化走 `config/tags.ts`（与 API 保存、环境变量注入共用），规则是只删不改：
   * 空格与重复被清掉，超长或超量的标签整条丢弃，绝不截断标签内容。
   */
  groups: z.preprocess((v) => normalizeTags(v, MAX_GROUPS_PER_ACCOUNT), z.array(z.string())).default([]),
});
export type Account = z.infer<typeof AccountSchema>;

export const PinModeSchema = z.enum(['strict', 'preferred']);
export type PinMode = z.infer<typeof PinModeSchema>;

export const SortSchema = z.enum(['cost', 'ttft', 'tps']);
export type Sort = z.infer<typeof SortSchema>;

export const AccountModeSchema = z.enum(['sticky', 'single', 'roundrobin']);
export type AccountMode = z.infer<typeof AccountModeSchema>;

/**
 * 网关的账号范围（v6 起按**用户分组**，不再是体检结论）：
 * - `all`    全部账号
 * - `groups` 指定分组（`scopeGroups`，账号带任一标签即命中）
 * - `custom` 自选（`accounts` 列表）
 *
 * 为什么去掉「正常号 / 风控号」：账号级的分类结论并不预测什么——同一个号在
 * 不同模型上可能一个能钉、一个被 VMC 接管；而能钉的模型靠区域约束就能回到官方
 * 渠道。「这个号能不能用」是**账号 × 模型**的观测（`accountModels`），不是账号属性。
 */
export const AccountScopeSchema = z.enum(['all', 'groups', 'custom']);
export type AccountScope = z.infer<typeof AccountScopeSchema>;

export const PerModelSchema = z.object({
  /** 有序优先列表：按顺序逐个尝试。空 = 自动（交给网关）。 */
  upstreams: z.array(z.string().min(1)).max(10).catch([]).default([]),
  /** 排除列表，优先级高于 upstreams。 */
  exclude: z.array(z.string().min(1)).max(10).catch([]).default([]),
  pinMode: PinModeSchema.catch('strict').default('strict'),
  sort: SortSchema.nullable().catch(null).default(null),
});
export type PerModelConfig = z.infer<typeof PerModelSchema>;

/**
 * 故障转移参数。默认值取向是「agent 场景不超时」：
 * 单次尝试 60s、整条链 90s 封顶——多数 OpenAI 客户端 60~120s 就断了，再长只是白烧额度。
 */
export const FailoverSchema = z.object({
  /** 单次尝试上限（毫秒）。语义是「多久内要开始有响应」——拿到首块数据后交给下面的空闲超时。 */
  attemptTimeoutMs: z.number().int().min(1000).max(600000).catch(60000).default(60000),
  /** 流式/内部流式尝试的**空闲**超时（毫秒）：连续这么久没有新数据才判定卡死。
   *  长回答不再被「总时长」切断（详见 docs/timeouts.md）。 */
  idleTimeoutMs: z.number().int().min(1000).max(600000).catch(60000).default(60000),
  /** 整条故障转移链的总预算（毫秒）。预算耗尽立即返回最后错误，不再切换。 */
  budgetMs: z.number().int().min(1000).max(600000).catch(90000).default(90000),
  /** 渠道级错误时同渠道重试次数（不含首次）。 */
  retriesPerChannel: z.number().int().min(0).max(5).catch(1).default(1),
  /** 渠道进入冷却的时长（毫秒）。冷却期内排到候选末尾，不是剔除。 */
  cooldownMs: z.number().int().min(0).max(3600000).catch(300000).default(300000),
  /** 同渠道重试之间的退避基数（毫秒）。 */
  retryBackoffMs: z.number().int().min(0).max(10000).catch(500).default(500),
});
export type FailoverConfig = z.infer<typeof FailoverSchema>;

/**
 * 网关标识：用短 slug 而不是自增数字——它出现在查询参数（`?gateway=`）与日志里，
 * 可读、可手写、可推断。改名会丢配置关联，所以 id 创建后不可改（UI 只让改显示名）。
 */
export const GatewayIdSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9-]*$/)
  .catch('main');

/** 网关数量上限：每个网关一个端口 + 一套运行时，数量失控只会让配置面变复杂。 */
export const MAX_GATEWAYS = 8;

/**
 * 网关 = 一个独立接入面。
 *
 * 设计要点（docs/ROADMAP-3.0.md §2、§9 第 1/8 条）：
 * - **账号池是全局的**，网关只引用账号名（子集），不复制密钥；
 * - 账号策略、失败转移、模型清单与路由配置都是**网关级**——不同网关可以走完全不同的策略；
 * - `upstreamBase` 保持全局（所有网关连同一个 Cline 网关）；
 * - 控制台是**独立监听**（见 `ConsoleSchema`），网关只管 `/v1`。
 */
export const GatewaySchema = z.object({
  id: GatewayIdSchema,
  /** 显示名（可改）。 */
  name: z.string().min(1).max(50).catch('网关'),
  /** 启用开关：停用的网关不监听端口、不服务 /v1（配置保留）。 */
  enabled: z.boolean().catch(true).default(true),
  port: z.number().int().min(1).max(65535).catch(DEFAULT_GATEWAY_PORT),
  bindHost: z.string().min(1).catch('127.0.0.1'),
  /** 下游代理密钥。为空 = 不鉴权；绑定非回环地址时为空会拒绝启动（启动闸门按网关判定）。 */
  proxyKey: z.string().catch('').default(''),
  /** 公网代理地址，仅用于展示。 */
  publicBaseUrl: z.string().catch('').default(''),
  /** CORS 白名单。默认空 = 不发 Access-Control-Allow-Origin（同源访问足够）。 */
  corsOrigins: z.array(z.string()).catch([]).default([]),
  /** true 时 /v1/models 合并完整目录模型。 */
  exposeCatalog: z.boolean().catch(false).default(false),

  /**
   * 账号范围。解析失败时回退到 `custom`（= 不参与任何账号）而不是 `all`：
   * 手改配置写错一个字母不该把「只用一个号」悄悄放大成「用全部号」。
   * 加载时会为无法识别的值写一条 note。
   */
  accountScope: AccountScopeSchema.catch('custom').default('all'),
  /** 指定分组（账号的 `groups` 里带任一标签即命中），仅在 accountScope=groups 时生效。 */
  scopeGroups: z.preprocess((v) => normalizeTags(v, Number.POSITIVE_INFINITY), z.array(z.string())).default([]),
  /** 自选账号（全局账号池里的名字），仅在 accountScope=custom 时生效。 */
  accounts: z.array(z.string().min(1)).catch([]).default([]),
  /** 账号顺序 = 粘性优先级（不在列表里的按全局顺序排在后面）。 */
  accountOrder: z.array(z.string().min(1)).catch([]).default([]),
  accountMode: AccountModeSchema.catch('sticky').default('sticky'),
  /** single 模式使用的账号名（账号标识是 name，不再是下标）。 */
  activeAccount: z.string().catch('').default(''),

  // 键缺失或值损坏 → 恢复默认清单；显式写 [] → 尊重用户清空，不复活
  knownModels: z
    .array(z.string())
    .catch(() => [...DEFAULT_KNOWN_MODELS])
    .default(() => [...DEFAULT_KNOWN_MODELS]),
  perModel: z.record(z.string(), z.unknown()).catch({}).default({}),

  // 注意：zod 4 的 .default({}) 不会 parse 默认值（会原样返回裸 {}，缺字段）；
  // .prefault({}) 会 parse，但遇到「存在且非法」的输入直接抛。两者组合才既能补全又能兜底。
  failover: FailoverSchema.catch(() => FailoverSchema.parse({})).prefault({}),
});

/** 解析后的网关类型（perModel 收敛为强类型）。 */
export type Gateway = Omit<z.infer<typeof GatewaySchema>, 'perModel'> & {
  perModel: Record<string, PerModelConfig>;
};

/** 只过了 schema、尚未做 perModel 收敛的网关。 */
export type GatewayInput = z.infer<typeof GatewaySchema>;

/**
 * 控制台监听（2.1 起独立于网关）。
 *
 * - `port` / `bindHost`：控制台自己的监听目标；桌面壳用 `PORT` 环境变量固定为 3125。
 * - `proxyKey`：远端访问控制台时的密钥。**本机访问永远免密钥**（见 security/local.ts），
 *   与网关的 `proxyKey` 是两把独立的钥匙：下发给客户端的那把不该顺带管住控制台。
 */
export const ConsoleSchema = z.object({
  port: z.number().int().min(1).max(65535).catch(DEFAULT_CONSOLE_PORT).default(DEFAULT_CONSOLE_PORT),
  bindHost: z.string().min(1).catch('127.0.0.1').default('127.0.0.1'),
  /** 为空 = 不鉴权；绑定非回环地址时为空会拒绝启动（启动闸门按监听目标判定）。 */
  proxyKey: z.string().catch('').default(''),
});
export type ConsoleConfig = z.infer<typeof ConsoleSchema>;

export const ConfigSchema = z.object({
  version: z.number().int().catch(CONFIG_VERSION).default(CONFIG_VERSION),

  /** 上游网关地址（所有网关共用同一个 Cline 网关）。 */
  upstreamBase: z.string().url().catch(DEFAULT_UPSTREAM_BASE).default(DEFAULT_UPSTREAM_BASE),

  /**
   * 强行绑定渠道：钉住非私有渠道时，用区域约束把 `openai-compatible-private` 排出去。
   *
   * 只写 `gateway.only` 挡不住它——网关会先走「私有 contributor」再回退官方
   * （linux.do 3119385，2026-11-04 实测）。给私有渠道加一个它没有节点的区域，它就不成立，
   * 请求才会真正落到清单内的渠道。**默认开启**；关掉等于放弃钉住的强制力
   * （请求可能仍被网关送到私有渠道），只留给「某模型只有私有渠道能服务」这类特殊情况。
   *
   * 2.3.1 起是**全局设置**（界面上在「设置」页）：按模型分别开关时，用户既看不出
   * 默认值、也不知道它为什么在直连模型上没反应。
   */
  forceChannelBinding: z.boolean().catch(true).default(true),

  // ---- 账号池（全局） ----
  accounts: z.array(z.unknown()).catch([]).default([]),

  // ---- 网关（接入面） ----
  gateways: z.array(z.unknown()).catch([]).default([]),
  /** 控制台自己的监听目标（与网关解耦）。 */
  console: ConsoleSchema.catch(() => ConsoleSchema.parse({})).prefault({}),

  // ---- 观测 ----
  historyLimit: z.number().int().min(1).max(10000).catch(500).default(500),
});

/** 校验并归一化后的配置类型。accounts / gateways 在加载时已收敛为强类型。 */
export type Config = Omit<z.infer<typeof ConfigSchema>, 'accounts' | 'gateways'> & {
  accounts: Account[];
  gateways: Gateway[];
};

/** 默认网关（新安装 / 迁移目标）。 */
export function defaultGateway(overrides: Partial<Gateway> = {}): Gateway {
  return {
    id: 'main',
    name: '主网关',
    enabled: true,
    port: DEFAULT_GATEWAY_PORT,
    bindHost: '127.0.0.1',
    proxyKey: '',
    publicBaseUrl: '',
    corsOrigins: [],
    exposeCatalog: false,
    accountScope: 'all',
    scopeGroups: [],
    accounts: [],
    accountOrder: [],
    accountMode: 'sticky',
    activeAccount: '',
    knownModels: [...DEFAULT_KNOWN_MODELS],
    perModel: {},
    failover: FailoverSchema.parse({}),
    ...overrides,
  };
}

/** 全新安装时的默认配置。 */
export function defaultConfig(): Config {
  return {
    version: CONFIG_VERSION,
    upstreamBase: DEFAULT_UPSTREAM_BASE,
    forceChannelBinding: true,
    accounts: [],
    gateways: [defaultGateway()],
    console: ConsoleSchema.parse({}),
    historyLimit: 500,
  };
}
