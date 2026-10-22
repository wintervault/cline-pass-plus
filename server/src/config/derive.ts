import { isLoopbackHost } from '../security/compare.ts';
import { type Account, type Config, defaultGateway, type Gateway } from './schema.ts';

/** 账号池里是否有可用账号（决定控制台是否提示去配置）。 */
export function isConfigured(config: Config): boolean {
  return config.accounts.some((a) => a.key);
}

/** 可用的账号（key 非空）。账号没有「启用开关」——参与哪个网关由网关的账号范围决定。 */
export function usableAccounts(config: Config) {
  return config.accounts.filter((a) => a.key);
}

/** 风控体检结论查询（按账号名）。 */
export type AccountClassLookup = (name: string) => 'normal' | 'private' | 'unknown';

/**
 * 该网关可见的账号。
 *
 * 账号本身是全局的，网关只声明**范围**：
 * - `all` 全部 / `normal` 全部正常号 / `private` 全部风控号 / `custom` 自选列表；
 * - 正常/风控按**当前体检结论**计算（观测值会翻转，所以不保存快照）；
 * - `accountOrder` 决定顺序 = sticky 模式的优先顺序；不在列表里的按全局顺序排后面。
 *
 * `classOf` 缺省时，分类范围返回空（绝不把「没给结论」当成正常号）。
 */
export function gatewayAccounts(config: Config, gateway: Gateway, classOf?: AccountClassLookup): Account[] {
  let list: Account[];
  switch (gateway.accountScope) {
    case 'custom': {
      const names = new Set(gateway.accounts);
      list = config.accounts.filter((a) => names.has(a.name));
      break;
    }
    case 'normal':
    case 'private': {
      if (!classOf) return [];
      const wanted = gateway.accountScope;
      list = config.accounts.filter((a) => classOf(a.name) === wanted);
      break;
    }
    default:
      list = config.accounts;
  }
  if (!gateway.accountOrder.length) return list;
  const rank = new Map(gateway.accountOrder.map((name, i) => [name, i]));
  return [...list].sort(
    (a, b) => (rank.get(a.name) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.name) ?? Number.MAX_SAFE_INTEGER),
  );
}

/** 该网关可用的账号（key 非空）。 */
export function gatewayUsableAccounts(config: Config, gateway: Gateway, classOf?: AccountClassLookup): Account[] {
  return gatewayAccounts(config, gateway, classOf).filter((a) => a.key);
}

/** 按 id 找网关；不存在返回 null。 */
export function gatewayById(config: Config, id: string): Gateway | null {
  return config.gateways.find((g) => g.id === id) ?? null;
}

/**
 * 第一个网关。控制台 API 在没带 `?gateway=` 时用它作为默认目标
 * （控制台本身已独立监听，不再有「控制台网关」这个概念）。
 */
export function primaryGateway(config: Config): Gateway {
  return config.gateways[0] ?? defaultGateway();
}

/**
 * 网关的账号可用状态。
 *
 * 必须把「一个账号都没有」和「有账号、但都不在该网关的范围内」分开：
 * 后者（例如两个号都被风控，而网关范围是「全部正常号」）以前会被误报成
 * 「尚未配置上游 API Key」，用户去账号池看却发现账号明明在。
 */
export type GatewayAccountStateCode = 'ok' | 'no_accounts' | 'empty_scope' | 'disabled';

export interface GatewayAccountState {
  code: GatewayAccountStateCode;
  /** 该网关范围内、key 非空的账号数。 */
  inScope: number;
  /** 全局 key 非空的账号数。 */
  usableTotal: number;
  scope: Gateway['accountScope'];
}

export function gatewayAccountState(
  config: Config,
  gateway: Gateway,
  classOf?: AccountClassLookup,
): GatewayAccountState {
  const usableTotal = usableAccounts(config).length;
  const inScope = gatewayUsableAccounts(config, gateway, classOf).length;
  const scope = gateway.accountScope;
  if (gateway.enabled === false) return { code: 'disabled', inScope, usableTotal, scope };
  if (usableTotal === 0) return { code: 'no_accounts', inScope, usableTotal, scope };
  if (inScope === 0) return { code: 'empty_scope', inScope, usableTotal, scope };
  return { code: 'ok', inScope, usableTotal, scope };
}

/**
 * 给下游客户端用的代理 Base URL（按网关）。
 * 设了 publicBaseUrl 就用它；否则按绑定地址推导（本地绑定展示 127.0.0.1 更实用）。
 */
export function gatewayProxyBase(gateway: Gateway): string {
  const base = gateway.publicBaseUrl.replace(/\/+$/, '');
  if (base) return `${base}/v1`;
  const host = isLoopbackHost(gateway.bindHost) ? '127.0.0.1' : gateway.bindHost;
  return `http://${host}:${gateway.port}/v1`;
}
