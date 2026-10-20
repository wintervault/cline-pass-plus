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

/** 该网关是否至少有一个可用账号。 */
export function gatewayConfigured(config: Config, gateway: Gateway, classOf?: AccountClassLookup): boolean {
  return gatewayUsableAccounts(config, gateway, classOf).length > 0;
}

/** 按 id 找网关；不存在返回 null。 */
export function gatewayById(config: Config, id: string): Gateway | null {
  return config.gateways.find((g) => g.id === id) ?? null;
}

/**
 * 控制台网关。加载时已保证 `console.gatewayId` 指向存在的网关；
 * 这里的兜底只为「保存过程中瞬态不一致」不崩。
 */
export function consoleGateway(config: Config): Gateway {
  return gatewayById(config, config.console.gatewayId) ?? config.gateways[0] ?? defaultGateway();
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
