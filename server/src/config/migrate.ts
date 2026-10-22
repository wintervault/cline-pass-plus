import { uniqueAccountNames } from '../accounts/naming.ts';
import { CONFIG_VERSION, DEFAULT_CONSOLE_PORT } from './schema.ts';

/** 配置文件版本高于本程序支持的版本——拒绝启动，否则会把新版配置改坏。 */
export class ConfigTooNewError extends Error {
  readonly version: number;
  constructor(version: number) {
    super(
      `配置版本为 ${version}，高于本程序支持的 ${CONFIG_VERSION}。请升级程序，或手动把 config.json 的 version 改回 ${CONFIG_VERSION}。`,
    );
    this.name = 'ConfigTooNewError';
    this.version = version;
  }
}

export interface MigrationResult {
  raw: Record<string, unknown>;
  /** 人类可读的迁移记录，用于启动日志。 */
  applied: string[];
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 把任意版本的配置文件就地升级到当前版本。
 * 只做「搬运」，不做校验——校验交给 schema，这样迁移逻辑可以独立测试。
 */
export function migrateConfig(input: Record<string, unknown>): MigrationResult {
  const raw: Record<string, unknown> = { ...input };
  const applied: string[] = [];
  const from = typeof raw.version === 'number' && Number.isInteger(raw.version) ? raw.version : 1;

  if (from > CONFIG_VERSION) throw new ConfigTooNewError(from);

  if (from < 2) {
    // ① 旧版单 key 字段迁入账号池
    const legacyKey = typeof raw.apiKey === 'string' ? raw.apiKey.trim() : '';
    const accounts = Array.isArray(raw.accounts) ? [...raw.accounts] : [];
    if (legacyKey && !accounts.some((a) => isPlainObject(a) && a.key === legacyKey)) {
      accounts.unshift({ name: '默认账号', key: legacyKey });
      applied.push('旧版 apiKey 已迁入账号池');
    }
    if ('apiKey' in raw) delete raw.apiKey;
    raw.accounts = accounts;

    // ② perModel：单 upstream 转优先级列表；丢弃退役的 maxRetries 与 upstream 镜像
    if (isPlainObject(raw.perModel)) {
      let converted = 0;
      for (const cfg of Object.values(raw.perModel)) {
        if (!isPlainObject(cfg)) continue;
        let upstreams: string[];
        if (Array.isArray(cfg.upstreams)) {
          upstreams = cfg.upstreams.filter((u): u is string => typeof u === 'string');
        } else {
          upstreams = typeof cfg.upstream === 'string' && cfg.upstream ? [cfg.upstream] : [];
          if (upstreams.length) converted += 1;
        }
        cfg.upstreams = upstreams;
        delete cfg.upstream;
        delete cfg.maxRetries;
      }
      if (converted) applied.push(`${converted} 个模型的单上游配置已转为优先级列表`);
    }

    // ③ 每请求轮转 → 粘性：轮询式切换会让上游 prompt cache 全失效
    if (raw.accountMode === 'roundrobin') {
      raw.accountMode = 'sticky';
      applied.push('账号模式 roundrobin → sticky（避免轮询式切换浪费 prompt cache）');
    }

    raw.version = 2;
    applied.push(`配置格式 v${from} → v2`);
  }

  if (from < 3) {
    // ---- v2 → v3：单端口 → 网关列表 ----
    // v2 的接入设置（端口/密钥/CORS/账号策略/模型清单/路由配置）全是顶层字段，
    // 现在它们属于「网关」。整体搬进第一个网关（id=main），账号池保持全局。
    const rawAccounts = Array.isArray(raw.accounts) ? raw.accounts.filter(isPlainObject) : [];
    // 名称归一化与 AccountSchema 的规则保持一致（缺失/超长 → '账号'），
    // 因为下面要把旧的 activeAccount 下标翻译成账号名。
    const names = uniqueAccountNames(
      rawAccounts.map((a) => {
        const name = typeof a.name === 'string' ? a.name : '';
        return name.length >= 1 && name.length <= 50 ? name : '账号';
      }),
    );
    const oldActive = typeof raw.activeAccount === 'number' ? raw.activeAccount : 0;
    const activeName = names[oldActive] ?? '';

    const legacyKeys = [
      'port',
      'bindHost',
      'proxyKey',
      'publicBaseUrl',
      'corsOrigins',
      'exposeCatalog',
      'accountMode',
      'activeAccount',
      'knownModels',
      'perModel',
      'failover',
    ] as const;
    const gateway: Record<string, unknown> = { id: 'main', name: '主网关' };
    for (const key of legacyKeys) {
      if (raw[key] !== undefined) gateway[key] = raw[key];
    }
    // v2 的账号池本来就是全量的
    gateway.allAccounts = true;
    gateway.accounts = [];
    gateway.activeAccount = activeName;

    raw.gateways = [gateway];
    raw.console = { gatewayId: 'main' };
    for (const key of legacyKeys) delete raw[key];
    raw.version = 3;
    applied.push('配置格式 v2 → v3：原有接入设置迁入「主网关」，账号池保持全局');
  }

  if (from < 4) {
    // ---- v3 → v4：账号范围四选一 + 移除账号启用开关 ----
    // 「启用开关」在多网关后语义重叠：参与哪个网关由网关的账号范围决定。
    // 旧开关为 false 的账号按启用处理（不静默丢账号），迁移记录里点名。
    const gateways = Array.isArray(raw.gateways) ? raw.gateways.filter(isPlainObject) : [];
    for (const gateway of gateways) {
      if (gateway['accountScope'] === undefined) {
        gateway['accountScope'] = gateway['allAccounts'] === false ? 'custom' : 'all';
      }
      delete gateway['allAccounts'];
      if (!Array.isArray(gateway['accountOrder'])) gateway['accountOrder'] = [];
    }
    const accounts = Array.isArray(raw.accounts) ? raw.accounts.filter(isPlainObject) : [];
    const disabled = accounts
      .filter((a) => a['enabled'] === false)
      .map((a) => (typeof a['name'] === 'string' && a['name'] ? a['name'] : '账号'));
    for (const account of accounts) delete account['enabled'];
    raw.version = 4;
    applied.push('配置格式 v3 → v4：网关账号范围改为「全部 / 全部正常 / 全部风控 / 自选」');
    if (disabled.length) {
      applied.push(`账号启用开关已移除，以下账号改为启用：${disabled.join('、')}（如需排除请在网关里设置账号范围）`);
    }
  }

  if (from < 5) {
    // ---- v4 → v5：控制台从网关里独立出来 ----
    // 旧版控制台挂在 console.gatewayId 指向的网关上，该网关因此不能被停用/删除，
    // 而且它绑不上时控制台一起不可达。现在控制台有自己的监听目标。
    //
    // 网关端口**保持原值**：用户可能已经把 3123 填进了 Cline，不能为了改布局而
    // 悄悄改掉接入地址。新网关的默认端口从 3126 起（见 DEFAULT_GATEWAY_PORT）。
    const oldConsole = isPlainObject(raw.console) ? raw.console : {};
    const oldConsoleId = typeof oldConsole['gatewayId'] === 'string' ? oldConsole['gatewayId'] : '';
    const gateways = Array.isArray(raw.gateways) ? raw.gateways.filter(isPlainObject) : [];
    const donor = gateways.find((g) => g['id'] === oldConsoleId) ?? gateways[0];
    // 复制旧控制台网关的密钥：远端用户升级后不会因为「换了一把钥匙」而进不去控制台。
    const proxyKey = donor && typeof donor['proxyKey'] === 'string' ? donor['proxyKey'] : '';
    raw.console = { port: DEFAULT_CONSOLE_PORT, bindHost: '127.0.0.1', proxyKey };
    raw.version = 5;
    applied.push(
      `配置格式 v4 → v5：控制台改为独立监听 ${DEFAULT_CONSOLE_PORT}（仍可本机免密钥访问；远端访问密钥沿用原控制台网关）`,
    );
  }

  return { raw, applied };
}
