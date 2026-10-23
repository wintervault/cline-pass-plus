import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';

/**
 * 动效 token 与工具。**唯一来源**：CSS 变量由 `main.tsx` 写进 `:root`，
 * antd 的 motion seed 在 `theme.ts` 映射到同一套值——三处同源，才不会出现
 * 「弹层是 200ms、列表是 150ms」的两种节奏。
 *
 * 判定标准见 `docs/ROADMAP-2.2.md` 的五问：解释因果、可中断、只动
 * transform/opacity、不造成布局位移、reduced-motion 下仍可理解。
 */
export const DURATION = {
  /** 即时反馈：按下、勾选 */
  instant: 60,
  /** 微动效：颜色、图标、悬停 */
  fast: 120,
  /** 标准过渡：页面、行、位置 */
  base: 180,
  /** 浮层与大面积变化 */
  slow: 280,
  /** 签名时刻上限 */
  signature: 360,
} as const;

export const EASE = {
  /** 标准曲线：进入减速，退出也用它（退出靠时长更短来表达） */
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  /** 退出可以更直接一点 */
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 同一元素上正在播放的入场动画（切换页面时先取消，避免叠在一起）。 */
const running = new WeakMap<Element, Animation>();

/**
 * 入场：淡入 + 轻微上移。页面切换、区块出现用。
 * reduced-motion 下退化为纯淡入，时长压到 fast。
 */
export function animateEnter(
  el: Element | null | undefined,
  opts: { y?: number; duration?: number; delay?: number } = {},
): Animation | null {
  if (!el) return null;
  const reduce = prefersReducedMotion();
  const y = reduce ? 0 : (opts.y ?? 6);
  const duration = reduce ? DURATION.fast : (opts.duration ?? DURATION.base);
  running.get(el)?.cancel();
  const anim = el.animate(
    [
      { opacity: 0, transform: y ? `translateY(${y}px)` : 'none' },
      { opacity: 1, transform: 'none' },
    ],
    { duration, delay: opts.delay ?? 0, easing: EASE.standard, fill: 'both' },
  );
  running.set(el, anim);
  /*
   * 兜底：动画时间线被浏览器挂起时（窗口最小化、渲染被节流），
   * 元素可能停在 opacity:0。超时后取消动画，让它回到 CSS 的最终状态。
   */
  const guard = window.setTimeout(
    () => {
      if (running.get(el) === anim) {
        running.delete(el);
        anim.cancel();
      }
    },
    duration + (opts.delay ?? 0) + 400,
  );
  anim.onfinish = () => {
    window.clearTimeout(guard);
    if (running.get(el) === anim) running.delete(el);
    anim.cancel();
  };
  return anim;
}

/**
 * 列表连续感（FLIP）：DOM 重排后，让元素从「上一帧的位置」滑到新位置，
 * 新增项淡入上浮。
 *
 * 只用于**用户刚做过操作**的列表（账号增删、渠道排序）。轮询与后台刷新
 * 不要用——那会把「数据更新」演成「有人在搬东西」。
 *
 * 用法：
 *   const ref = useFlipList(rows.map(r => r.id).join('|'));
 *   <div ref={ref}>{rows.map(r => <Row key={r.id} data-flip-key={r.id} />)}</div>
 *
 * `signature` 是「这一帧的顺序与成员」的字符串指纹（调用方用 join('|') 生成）：
 * 只有它变化时才重新测量，避免每次渲染都做一次布局读取。
 *
 * 位置按容器内坐标计算（含 scrollTop），滚动不会误触发动画；容器不可见
 * （切到别的页面）时清空基准，回来时不播过期的位移。
 */
export function useFlipList<T extends HTMLElement = HTMLDivElement>(signature: string) {
  const ref = useRef<T>(null);
  const previous = useRef<Map<string, { x: number; y: number }>>(new Map());
  const first = useRef(true);

  const measure = useCallback((animate: boolean) => {
    const container = ref.current;
    if (!container) return;
    // display:none 时量不到有意义的位置：清空基准，等可见后重建
    if (container.getClientRects().length === 0) {
      if (animate) {
        previous.current = new Map();
        first.current = true;
      }
      return;
    }
    const box = container.getBoundingClientRect();
    const scrollTop = container.scrollTop;
    const next = new Map<string, { x: number; y: number }>();
    const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-flip-key]'));
    for (const node of nodes) {
      const key = node.dataset.flipKey;
      if (!key) continue;
      const rect = node.getBoundingClientRect();
      const pos = { x: rect.left - box.left, y: rect.top - box.top + scrollTop };
      next.set(key, pos);
      if (!animate || first.current) continue;
      const before = previous.current.get(key);
      if (!before) {
        if (!prefersReducedMotion()) {
          node.animate(
            [
              { opacity: 0, transform: 'translateY(4px)' },
              { opacity: 1, transform: 'none' },
            ],
            { duration: DURATION.base, easing: EASE.standard },
          );
        }
        continue;
      }
      const dx = before.x - pos.x;
      const dy = before.y - pos.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) continue;
      if (prefersReducedMotion()) continue;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], {
        duration: DURATION.base,
        easing: EASE.standard,
      });
    }
    previous.current = next;
    first.current = false;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: signature 是调用方给的顺序指纹，只用来决定「何时重新测量」
  useLayoutEffect(() => {
    measure(true);
  }, [signature, measure]);

  /*
   * 列表装载时往往在别的页面里（display:none）：那时量不到位置。
   * 用 ResizeObserver 在它**第一次可见**时建立基准（不播动画），
   * 之后的第一次增删/排序才有上一帧可比。
   */
  useEffect(() => {
    const container = ref.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (container.getClientRects().length === 0) {
        previous.current = new Map();
        first.current = true;
        return;
      }
      if (first.current) measure(false);
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [measure]);

  return ref;
}
