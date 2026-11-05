import type { ComponentProps, ReactNode } from 'react';

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

type StatusChipProps = Omit<ComponentProps<'span'>, 'children'> & {
  tone?: ChipTone;
  children: ReactNode;
  /** 左侧状态点；纯计数、纯说明时关掉 */
  dot?: boolean;
  small?: boolean;
};

/**
 * 透传 `ref` 与事件是**必须**的（2.3.1 修）：`<Tooltip><StatusChip/></Tooltip>` 是它的
 * 主要用法，而 Tooltip/Dropdown 靠子元素的 ref 计算弹层位置。不透传时 antd 拿不到
 * 触发元素，弹层会被停到 `-1000vw / -1000vh`——点了没反应，或者出现在屏幕外。
 * 包一层 `<span>` 也不可行：多出来的行盒会让状态点在弹性行里按基线对齐，
 * 与旁边的状态芯片差 2~3px（状态栏实测）。
 */
export function StatusChip({
  tone = 'neutral',
  children,
  dot = true,
  small = false,
  className,
  ...rest
}: StatusChipProps) {
  const cls = [
    'cps-status',
    `cps-status-${tone}`,
    small ? 'cps-status-sm' : '',
    dot ? '' : 'cps-status-plain',
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls} {...rest}>
      {dot && <span className="cps-status-dot" aria-hidden />}
      <span className="cps-status-text">{children}</span>
    </span>
  );
}
