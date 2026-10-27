import type { ReactNode } from 'react';

/**
 * 状态 —— 全站唯一的状态表达（2.2.1 起是**内联状态**，不是彩色药丸）。
 *
 * 2.2.0 用带底色的圆角胶囊承载所有状态，结果一屏出现五六个药丸，像组件样例；
 * 真正需要被看见的异常反而被平均掉了。现在：
 * - 状态点负责「有没有异常」（颜色只出现在 6px 的点上）；
 * - 文字负责说清「是什么」（正常状态用次级文字色，警告/失败才用状态色）；
 * - 没有底色、没有描边，状态只是行内的一段文字。
 *
 * 五种语气不变：ok / warn / danger / info / neutral。
 */
export type ChipTone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral';

export function StatusChip({
  tone = 'neutral',
  children,
  /** 左侧状态点；纯计数、纯说明时关掉 */
  dot = true,
  small = false,
}: {
  tone?: ChipTone;
  children: ReactNode;
  dot?: boolean;
  small?: boolean;
}) {
  const cls = ['cps-status', `cps-status-${tone}`, small ? 'cps-status-sm' : '', dot ? '' : 'cps-status-plain']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls}>
      {dot && <span className="cps-status-dot" aria-hidden />}
      <span className="cps-status-text">{children}</span>
    </span>
  );
}
