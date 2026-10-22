/** 与 server/src/http/routes 的响应形状一一对应。 */

export type Pipeline = 'planner' | 'direct';
/** 钉住参数是否被网关读取（探针判定，见 docs/pinning.md D1）。 */
export type PinState = 'enforced' | 'ignored' | 'unknown';
export type UpstreamStatusKind = 'ok' | 'limited' | 'bad' | 'auth' | 'unknown';
export type PinMode = 'strict' | 'preferred';
export type SortKey = 'cost' | 'ttft' | 'tps';
export type AccountMode = 'sticky' | 'single' | 'roundrobin';
/** 网关的账号范围：全部 / 全部正常号 / 全部风控号 / 自选。 */
export type AccountScope = 'all' | 'normal' | 'private' | 'custom';

export interface UpstreamStatus {
  status: UpstreamStatusKind;
  note?: string;
  /** 最近一次校验该渠道的往返耗时（毫秒）；未校验过则缺省。 */
  ms?: number;
  checkedAt?: number;
}

export interface UpstreamDetail {
  name?: string;
  endpoints?: number;
  context?: number;
  uptime?: number;
}

export interface TraceEntry {
  upstream: string | null;
  status: number;
  ms: number;
  note: string;
}

export interface ModelMeta {
  pipeline: Pipeline | null;
  pinnable: boolean;
  pinState: PinState;
  pinProbeAt: number | null;
  pinDisabledReason: string | null;
  availableProviders: string[];
  upstreams: string[];
  upstreamDetail: Record<string, UpstreamDetail>;
  upstreamStatus: Record<string, UpstreamStatus>;
  tier0: string[];
  canonicalSlug: string | null;
  openrouterSlug: string | null;
  lastProvider: string | null;
  lastMs: number | null;
  probedAt: number | null;
  validatedAt: number | null;
}

export interface PerModelConfig {
  upstreams: string[];
  exclude: string[];
  pinMode: PinMode;
  sort: SortKey | null;
}

/**
 * 模型尚未保存过配置时的界面默认值。
 *
 * 必须与 `server/src/config/schema.ts` 的 `PerModelSchema` 默认值一致（strict）：
 * 订阅模型页与测试台编辑的是同一份配置，两处默认值不同会让「没保存过」的模型
 * 在两页显示不同的钉住模式，并且从哪页保存就固化成哪页的值。
 */
export const EMPTY_PER_MODEL: PerModelConfig = {
  upstreams: [],
  exclude: [],
  pinMode: 'strict',
  sort: null,
};

export interface SubscriptionRow {
  id: string;
  config: PerModelConfig | null;
  meta: ModelMeta | null;
}

export interface OfficialFetch {
  ts: number;
  sources: string[];
  found: number;
  added: string[];
  total: number;
}

export interface ModelsResponse {
  gateway: { id: string; name: string };
  /** 检测所针对的账号（缺省 null = 只看模型清单）。 */
  account: { name: string } | null;
  subscription: SubscriptionRow[];
  catalogCount: number;
  catalog: string[];
  proxyBase: string;
  officialFetch: OfficialFetch | null;
}

export interface AccountView {
  name: string;
  keyMasked: string;
  keyTail: string;
  hasKey: boolean;
  /** 用户声明的到期日期（YYYY-MM-DD）；未设置为 null。 */
  expiresAt: string | null;
  /** 到期状态由服务端计算（时钟与 i18n 都以服务端为准）。 */
  expiry: ExpiryState;
  /** 风控体检结论；从未体检过为 null。 */
  classify: AccountClassRecord | null;
}

/** 风控分类：观测值，会随时间翻转（见 server/src/accounts/types.ts）。 */
export type AccountClassKind = 'normal' | 'private' | 'unknown';

export interface AccountClassRecord {
  class: AccountClassKind;
  checkedAt: number | null;
  note?: string;
}

export type ExpiryKind = 'none' | 'active' | 'soon' | 'expired';

export interface ExpiryState {
  kind: ExpiryKind;
  /** 距到期还有几天（今天 = 0，已过期为负）；未设置时为 null。 */
  days: number | null;
}

export interface AccountStats {
  requests: number;
  lastUsed: number | null;
  lastError: string | null;
}

export interface AccountsResponse {
  accounts: AccountView[];
  /** 风控体检的判定模型（全局；账号策略与范围是网关级的，在「网关」页编辑）。 */
  classifyModel: string;
  stats: Record<string, AccountStats>;
}

/** 网关配置 + 运行状态（/api/gateways）。 */
export interface GatewayView {
  id: string;
  name: string;
  enabled: boolean;
  port: number;
  bindHost: string;
  hasProxyKey: boolean;
  publicBaseUrl: string;
  corsOrigins: string[];
  exposeCatalog: boolean;
  accountScope: AccountScope;
  /** 自选范围使用的账号名（accountScope=custom 时生效）。 */
  accounts: string[];
  /** 账号顺序 = sticky 优先级。 */
  accountOrder: string[];
  accountMode: AccountMode;
  activeAccount: string;
  knownModels: string[];
  perModel: Record<string, PerModelConfig>;
  failover: FailoverConfig;
  accountCount: number;
  /** 账号可用状态：区分「没有账号」与「范围内没有账号」。 */
  accountState: GatewayAccountStateInfo;
  modelCount: number;
  proxyBase: string;
  status: {
    id: string;
    state: 'running' | 'error' | 'stopped' | 'disabled';
    error?: string;
    boundPort: number | null;
    boundHost: string | null;
  };
}

export interface GatewaysResponse {
  gateways: GatewayView[];
  maxGateways: number;
}

export type GatewayAccountStateCode = 'ok' | 'no_accounts' | 'empty_scope' | 'disabled';

export interface GatewayAccountStateInfo {
  code: GatewayAccountStateCode;
  /** 该网关范围内、key 非空的账号数。 */
  inScope: number;
  /** 全局 key 非空的账号数。 */
  usableTotal: number;
  scope: AccountScope;
}

export interface ConsoleStatus {
  state: 'running' | 'error' | 'stopped';
  boundPort: number | null;
  boundHost: string | null;
  error?: string;
}

/** 控制台独立监听的公开视图（/api/console）。 */
export interface ConsoleInfo {
  port: number;
  bindHost: string;
  hasProxyKey: boolean;
  url: string;
  status: ConsoleStatus;
}

export interface FailoverConfig {
  attemptTimeoutMs: number;
  idleTimeoutMs: number;
  budgetMs: number;
  retriesPerChannel: number;
  cooldownMs: number;
  retryBackoffMs: number;
}

export interface ClassifyResult extends AccountClassRecord {
  name: string;
  /** 本次是否新得出结论（false = 沿用旧结论，note 是失败原因）。 */
  fresh: boolean;
}

/** 后端用户可见文案一律是稳定 code + params（前端按语言映射，未知 code 不显示原文）。 */
export interface Notice {
  code: string;
  params?: Record<string, string>;
}

export interface AccountTestResult {
  ok: boolean;
  ms: number;
  model?: string;
  error?: string;
  notice?: Notice;
}

export interface ClassifyResponse {
  ok: boolean;
  results: ClassifyResult[];
  summary: { normal: number; private: number; unknown: number; failed: number };
  cancelled: boolean;
}

export interface HistoryEntry {
  ts: number;
  /** 处理这条请求的网关 id。 */
  gateway: string;
  model: string;
  provider: string | null;
  canonical: string | null;
  ms: number | null;
  stream: boolean;
  error: string | null;
  account: string | null;
  attempts: string[];
  trace: TraceEntry[];
  /** strict 钉住但网关实际由别的渠道提供服务（流式只能标记，不能撤回）。 */
  pinMismatch: boolean;
}

export interface TestResult {
  ok: boolean;
  ms?: number;
  targets: string[];
  exclude: string[];
  actual?: string | null;
  actualName?: string | null;
  pipeline?: Pipeline | null;
  pinnable?: boolean;
  canonicalSlug?: string | null;
  content?: string;
  account?: string | null;
  trace?: TraceEntry[];
  error?: string;
  degraded?: boolean;
}

export interface ProbeResult extends ModelMeta {
  ok: boolean;
  ms: number;
  error?: string;
}

export interface ValidationResult {
  ok: boolean;
  summary: Record<string, number>;
  results: Record<string, { status: UpstreamStatusKind; ms: number; note: string }>;
  upstreams: string[];
}

export interface MetaInfo {
  version: string;
  /** 远端访问控制台是否需要密钥（本机永远免密钥）。 */
  authRequired: boolean;
  accounts: { total: number; usable: number };
  defaultGatewayId: string;
  console: ConsoleInfo;
  /** 网关清单（只给选择器用的最小信息）。 */
  gateways: Array<{ id: string; name: string; enabled: boolean; accountState: GatewayAccountStateCode }>;
}

/** 校验状态排序权重：可用优先、不可钉最后。 */
export const STATUS_RANK: Record<UpstreamStatusKind, number> = { ok: 0, limited: 1, unknown: 2, auth: 3, bad: 4 };
