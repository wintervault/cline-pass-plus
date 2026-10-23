import { theme } from 'antd';

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE = 'cps_theme';

/** 初始主题：localStorage 优先，否则跟随系统。 */
export function initialTheme(): ThemeMode {
  const saved = localStorage.getItem(THEME_STORAGE);
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function persistTheme(mode: ThemeMode): void {
  localStorage.setItem(THEME_STORAGE, mode);
}

/**
 * 字体栈——**唯一来源**（`app.css` 通过 antd 注入的 `--ant-font-family` /
 * `--ant-font-family-code` 引用，不再各写一份）。
 *
 * - sans 用系统 UI 优先，并显式列出 CJK 字体；
 * - mono 只用于标识符，**必须带 CJK 回退**——Windows 上 `monospace` 的中文回退是宋体，
 *   这是「界面里出现宋体」的唯一来源（2026-10-17 实测）。
 */
export const FONT_SANS =
  '-apple-system, "Segoe UI", "Microsoft YaHei UI", "PingFang SC", "Noto Sans CJK SC", "Source Han Sans SC", sans-serif';
export const FONT_MONO =
  'ui-monospace, SFMono-Regular, Menlo, Consolas, "Microsoft YaHei UI", "Noto Sans Mono CJK SC", monospace';

/**
 * 品牌与体系 token（亮暗共用语义）。排版角色固定四层：
 * 22 页标题 / 14 正文与控件 / 13 说明文字 / 12 小注与数据。
 * 主色只用于主操作、选中与状态，其余交给 antd 算法。
 */
const sharedToken = {
  colorPrimary: '#4f8cff',
  colorInfo: '#4f8cff',
  borderRadius: 6,
  borderRadiusLG: 10,
  fontSizeHeading3: 22,
  fontFamily: FONT_SANS,
  fontFamilyCode: FONT_MONO,
  /*
   * 动效节奏与 `motion.ts` 同源（60 / 120 / 280ms）。
   * antd 的弹层、下拉、消息都用这三档；不映射的话，antd 组件会和
   * 我们自己的过渡呈现两种速度感——同屏两种节奏是最容易露怯的细节。
   */
  motionDurationFast: '0.06s',
  motionDurationMid: '0.12s',
  motionDurationSlow: '0.28s',
  motionEaseOut: 'cubic-bezier(0.2, 0, 0, 1)',
  motionEaseInOut: 'cubic-bezier(0.2, 0, 0, 1)',
};

/**
 * 暗色专用：antd 默认纯黑布局底（#000）在桌面应用里过于生硬。
 * 抬升为三层体系——布局底 / 容器面 / 弹层，层次靠亮度差与极淡描边，
 * 而不是靠高对比边框。
 */
const darkToken = {
  ...sharedToken,
  colorBgLayout: '#0e0f12',
  colorBgContainer: '#16181d',
  colorBgElevated: '#1e2026',
  colorBorderSecondary: '#25272e',
  /* 遮罩比 antd 默认略深一点：暗色界面下 45% 仍能看清底下的结构，会显得吵 */
  colorBgMask: 'rgba(0, 0, 0, 0.52)',
};

/**
 * 部件级微调：
 * - 表头去掉列分隔灰线（按行分隔足够，视觉更干净）。
 * - 气泡提醒（消息）用弹层底色而不是容器底色：它浮在所有内容之上，
 *   用「更高一层」的表面色，层次才对；内边距也放宽一点，短文案不显得局促。
 */
const sharedComponents = {
  Table: { headerSplitColor: 'transparent' },
  Message: { contentPadding: '10px 16px' },
};

export const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: darkToken,
  components: {
    ...sharedComponents,
    // 暗色下默认的消息底色偏黑，与侧栏/内容面糊在一起；抬到弹层色才看得出是浮层
    Message: { ...sharedComponents.Message, contentBg: darkToken.colorBgElevated },
    Modal: { borderRadiusLG: 12 },
  },
};

export const lightTheme = {
  algorithm: theme.defaultAlgorithm,
  token: { ...sharedToken, colorBgMask: 'rgba(0, 0, 0, 0.32)' },
  components: {
    ...sharedComponents,
    /* 弹层圆角比面板再大一号（面板 10，弹层 12） */
    Modal: { borderRadiusLG: 12 },
  },
};
