import { Typography } from 'antd';
import type { ReactNode } from 'react';

/**
 * 每页统一的页头：标题 + 一句话说明 + 右侧主操作。
 *
 * **页头自己不设外边距** —— 页头与首个区块之间、以及区块彼此之间的间距，
 * 全部由页面根容器的 `gap` 决定（六页一律 `flex column + gap 16`）。
 * 如果这里再写 marginBottom，就会与父级的 gap 叠加，页头到内容的距离
 * 变成 40 而区块之间是 16，同一个页面里出现两套节奏。
 */
export function PageHeader({ title, desc, actions }: { title: ReactNode; desc?: ReactNode; actions?: ReactNode }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 16,
        flexWrap: 'wrap',
        /* 一条页头分隔线：标题区与工具区之间的「面」从这里开始。
           只加在页头内部，不引入 margin，页面间距仍由父级 gap 统一。 */
        paddingBottom: 14,
        borderBottom: '1px solid var(--cps-border)',
      }}
    >
      {/* flex-basis 必须是 0：用 auto 时标题块的基准宽度是「文案的 max-content」，
          在 flex-wrap 下先换行、再收缩，右侧操作会被挤到第二行（英文长文案尤甚）。
          basis 0 让操作先占位，标题块拿剩余宽度。 */}
      <div style={{ minWidth: 0, flex: '1 1 0' }}>
        <h1 className="cps-display" style={{ margin: 0 }}>
          {title}
        </h1>
        {desc && (
          <p
            className="cps-body"
            style={{ margin: '5px 0 0', maxWidth: 720, color: 'var(--cps-text-secondary)', textWrap: 'pretty' }}
          >
            {desc}
          </p>
        )}
      </div>
      {actions && (
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            justifyContent: 'flex-end',
            paddingTop: 2,
          }}
        >
          {actions}
        </div>
      )}
    </header>
  );
}

/**
 * 区块标题。之前每个页面用不同的字号/间距/分隔线做「小节」，
 * 现在统一成：小标题 + 可选右侧操作，上方留白由调用方用 GAP_SECTION 控制。
 */
export function SectionTitle({ title, extra }: { title: ReactNode; extra?: ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 12,
        minHeight: 28,
      }}
    >
      <Typography.Text strong style={{ fontSize: 14 }}>
        {title}
      </Typography.Text>
      {extra && <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>{extra}</div>}
    </div>
  );
}
