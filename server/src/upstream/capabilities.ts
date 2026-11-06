import type { Pipeline } from './types.ts';

/**
 * 上游能力开关 —— **2026-11-06 起，规划器管线的钉住被 Cline 关掉了**。
 *
 * 实测（同一账号、同一天，见 `docs/pinning.md` 第七节）：
 * - 现在对**任何**客户端 `providerOptions` 返回 403：
 *   `client-supplied "providerOptions" model routing is not supported`。
 *   连 `providerOptions: {}`、连直连（OpenRouter）模型也一样——所以这不是「某个字段不支持」，
 *   而是整块拒绝。能力关闭期间 `injectPrefs` 会把它统一剥掉。
 * - 直连管线**仍然有效**：顶层 `provider.only` 写一个不存在的渠道，
 *   OpenRouter 仍回 `No allowed providers are available`；正常请求 200。
 *
 * 因此这里只关规划器，直连保持开启。**注入、探测、审计的实现一行都没有删**：
 * 它们全部经由本文件的开关判断，上游哪天恢复（或我们找到新写法），把 `planner`
 * 改回 `true` 即可，UI 与链路都会自动解锁——不要再在别处硬编码第二个开关。
 *
 * 两个必须保持的语义：
 * 1. **旧配置不改、不迁移**：用户的 `perModel.upstreams/pinMode/exclude` 原样保留，
 *    运行时按「自动路由」对待（不注入、不审计、不做候选循环）。这也是防呆：
 *    升级后即使用户什么都不改，也绝不会再发出 `providerOptions` 而把请求打成 403。
 * 2. **直连与未知管线走顶层 `provider`**：顶层字段对规划器是惰性无害的（网关会忽略），
 *    所以在管线还没探测出来时仍可安全地尝试直连钉住。
 */
export interface PinningCapability {
  planner: boolean;
  direct: boolean;
}

/**
 * 唯一的开关表。**生产代码只读**；测试需要覆盖「上游恢复」的分支时会临时改写，
 * 并在 `afterEach` 里还原（`routing.test.ts` / `chain.test.ts` / `probe.test.ts`）。
 * 之所以不做成 `as const`：那样恢复时得改类型，测试也无法验证保留的旧路径。
 */
export const PINNING: PinningCapability = {
  planner: false,
  direct: true,
};

/**
 * 这条管线现在能不能注入钉住参数。
 *
 * - `planner`：看 `PINNING.planner`（当前 false）
 * - `direct`：看 `PINNING.direct`（当前 true）
 * - `null`（尚未探测出管线）：按直连处理——只写顶层 `provider`，规划器会忽略它，
 *   不会触发 403；探测出 planner 之后自然走上面的 false 分支。
 */
export function pinningEnabled(pipeline: Pipeline | null): boolean {
  return pipeline === 'planner' ? PINNING.planner : PINNING.direct;
}

/**
 * `injectPrefs` 用：这条管线要不要写 `providerOptions` 那一半。
 *
 * 管线未知时跟随 `PINNING.planner`：默认关闭（避免 403）；上游恢复后恢复双写
 * （旧行为——未知管线时两种写法各写一份，互不干扰）。
 */
export function vercelPinningEnabled(pipeline: Pipeline | null): boolean {
  return (pipeline === 'planner' || pipeline === null) && PINNING.planner;
}

/** `injectPrefs` 用：这条管线要不要写顶层 `provider` 那一半。 */
export function openRouterPinningEnabled(pipeline: Pipeline | null): boolean {
  return pipeline === 'direct' || pipeline === null ? PINNING.direct : false;
}
