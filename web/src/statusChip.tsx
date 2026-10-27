import type { ReactNode } from 'react';

/**
 * 状态芯片 —— 全站唯一的状态表达。
 *
 * 为什么不用 antd 的 `Tag color="green|red|orange"`：预设色是四套互不相干的
 * 高饱和色板（#52c41a / #ff4d4f / #faad14），同一屏里两三个一起出现就像
 * 告警灯；而且同一语义在不同页面会挑不同预设（绿 / geekblue / cyan），
 * 「同一件事只有一种表现」立刻失效。
 *
 * 这里只有五种语气，色值来自 `theme.ts`（随亮暗主题切换）：
 * `ok` 正常 / `warn` 需要留意 / `danger` 失败或不可用 / `info` 中性信息 /
 * `neutral` 未判定、未启用。**颜色永远不是唯一信息**：文字必须自己说得清。
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
  const cls = ['cps-chip', `cps-chip-${tone}`, small ? 'cps-chip-sm' : '', dot ? '' : 'cps-chip-plain']
    .filter(Boolean)
    .join(' ');
  return (
    <span className={cls}>
      {dot && <span className="cps-chip-dot" aria-hidden />}
      {children}
    </span>
  );
}
