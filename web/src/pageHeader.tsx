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
 * 页头之后的区块标题由 `Panel` 的标题栏承担（2.2.1 起不再有独立的 SectionTitle）：
 * 一个页面里出现「页头 + 区块 + 区块内小标题」三层标题，层级反而读不清。
 */
