import type { ReactNode } from 'react';

/**
 * 空状态只有一种拼法（2.2.1）：**线性图标 + 一句说明 + 一个明确的下一步**。
 *
 * 为什么不用 antd 的 `Empty`：它默认带一张插画，而我们全站的图标都是线性图标。
 * 同一屏里混用两套图形语言，看起来像两个产品拼起来的（这正是 2.2.0 被指出的
 * 「细节差了很多」的来源之一）。也不会再让每个页面各写一份居中的 div——
 * 三处空状态的内边距、字号、间距因此会各不相同。
 *
 * 语义放在面板标题里（「还没有可检测的账号」），这里只负责说明与行动。
 */
export function EmptyState({
  icon,
  desc,
  action,
  fill = false,
  minHeight,
}: {
  icon: ReactNode;
  desc: ReactNode;
  action?: ReactNode;
  /** 撑满父级剩余高度（整页只有这一块时用），内容仍然居中 */
  fill?: boolean;
  minHeight?: number;
}) {
  return (
    <div
      className="cps-empty"
      style={fill ? { flex: '1 1 auto', justifyContent: 'center' } : minHeight ? { minHeight } : undefined}
    >
      <span className="cps-empty-icon" aria-hidden>
        {icon}
      </span>
      <span className="cps-empty-desc">{desc}</span>
      {action ? <div className="cps-empty-action">{action}</div> : null}
    </div>
  );
}
