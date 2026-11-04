/**
 * 自由标签（账号分组）的归一化。
 *
 * 三条写入路径——配置文件加载、环境变量注入、API 保存——必须用同一套规则，
 * 否则「界面上存进去的」和「手改文件的」会得到不同结果，而分组直接决定
 * 账号属于哪个网关。
 *
 * 规则刻意**只删不改**：去首尾空白、丢空串、丢超长标签、去重、按上限截断数量。
 * **绝不截断标签内容**：把「主力-华东」截成「主力-华」会与另一个分组重名，
 * 静默把账号挪进别的网关范围——这类错误不会报错，只会在路由上表现出来。
 * 超长的标签宁可整条丢掉：它本来也不可能匹配到任何账号分组。
 */

/** 单个账号可以带的分组数上限（界面的标签输入与 schema 共用）。 */
export const MAX_GROUPS_PER_ACCOUNT = 8;

/** 单个分组的最大长度。 */
export const MAX_GROUP_LENGTH = 24;

/**
 * 归一化标签列表。`max` 用 `Number.POSITIVE_INFINITY` 表示不限制数量
 * （网关的 `scopeGroups` 不设上限：截断会让某些账号静默掉出范围）。
 */
export function normalizeTags(raw: unknown, max: number): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const tag = item.trim();
    if (!tag || tag.length > MAX_GROUP_LENGTH || out.includes(tag)) continue;
    out.push(tag);
    if (out.length >= max) break;
  }
  return out;
}
