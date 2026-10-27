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
 * 字体栈——**唯一来源**（`main.tsx` 写成 CSS 变量，组件里不许再写内联字体栈）。
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
 * 表面与状态色的**唯一来源**（2.2）。
 *
 * 四层表面语义固定：`canvas`（布局底）/ `rail`（侧栏与状态栏）/ `surface`（面板）/
 * `raised`（输入框、悬浮控件）/ `overlay`（弹层）。层次靠亮度差 + 1px 描边，
 * 暗色不靠投影——投影一多就像贴纸，不像一块被同一盏灯照着的金属。
 *
 * 状态色刻意比 antd 预设更沉：预设的 #52c41a / #ff4d4f 在暗底上像告警灯，
 * 数据类界面需要「能读懂」而不是「被吓到」。色值都量过对比度（暗色正文 ≥ 7:1，
 * 次要文字 ≥ 4.5:1），亮色同理。
 */
export const PALETTE = {
  dark: {
    canvas: '#0b0d11',
    rail: '#0f1217',
    surface: '#161a21',
    raised: '#1c212a',
    overlay: '#222833',
    /* 输入框是「凹槽」：比面板与弹层都暗，边界靠描边而不是靠更亮 */
    well: '#101419',
    border: '#252b36',
    borderStrong: '#343c4a',
    text: '#eef1f7',
    textSecondary: '#aab4c4',
    textTertiary: '#7d8798',
    textQuaternary: '#5d6778',
    primary: '#3b6fdf',
    accent: '#7aa9ff',
    success: '#4cc38a',
    warning: '#e3a95c',
    error: '#f0756c',
    info: '#5b93ff',
    mask: 'rgba(0, 0, 0, 0.6)',
    /** 面板顶部那道 1px 内高光 */
    highlight: 'rgba(255, 255, 255, 0.05)',
    /** 画布上的一层极淡冷光，只落在留白处 */
    glow: 'rgba(91, 147, 255, 0.065)',
    /** 选中用的薄晕染 */
    wash: 'rgba(91, 147, 255, 0.085)',
    washStrong: 'rgba(91, 147, 255, 0.13)',
    washBorder: 'rgba(91, 147, 255, 0.28)',
    rowHover: 'rgba(255, 255, 255, 0.035)',
    headTint: 'rgba(255, 255, 255, 0.022)',
    shadow: 'none',
  },
  light: {
    canvas: '#eceef2',
    rail: '#f7f8fa',
    surface: '#ffffff',
    raised: '#ffffff',
    overlay: '#ffffff',
    /* 亮色下「凹槽」是一层极淡的灰，白面板上的输入框才读得出可编辑 */
    well: '#f4f6f9',
    border: '#e3e7ee',
    borderStrong: '#cfd6e0',
    text: '#161b24',
    textSecondary: '#59616f',
    textTertiary: '#6b7483',
    textQuaternary: '#99a2b0',
    primary: '#2f6fe0',
    accent: '#2f6fe0',
    success: '#0f7a50',
    warning: '#96610f',
    error: '#c1362f',
    info: '#2f6fe0',
    mask: 'rgba(15, 23, 42, 0.34)',
    highlight: 'rgba(255, 255, 255, 0.9)',
    glow: 'rgba(59, 120, 246, 0.045)',
    wash: 'rgba(59, 120, 246, 0.065)',
    washStrong: 'rgba(59, 120, 246, 0.11)',
    washBorder: 'rgba(59, 120, 246, 0.24)',
    rowHover: 'rgba(15, 23, 42, 0.03)',
    headTint: 'rgba(15, 23, 42, 0.018)',
    shadow: '0 1px 2px rgba(16, 24, 40, 0.05), 0 1px 3px rgba(16, 24, 40, 0.03)',
  },
} as const;

/**
 * 状态色的三种用途（2.2.1）：
 * - `fg`：状态文字（只在需要强调时用；日常状态文字仍是次级色）
 * - `dot`：状态点
 * - `bg` / `bd`：只给提示条（`.cps-notice`）用，不再做「彩色药丸」
 *
 * 为什么去掉彩色底盘：满屏小药丸会让界面像组件样例，而不是一台仪器。
 * 状态的第一层信息是「有没有异常」，一个点就够了；文字负责说清是什么。
 */
export const STATUS_TONE_CSS = {
  dark: {
    ok: { fg: '#7fd6a8', dot: '#4cc38a', bg: 'rgba(76, 195, 138, 0.10)', bd: 'rgba(76, 195, 138, 0.24)' },
    warn: { fg: '#f0c07a', dot: '#e3a95c', bg: 'rgba(227, 169, 92, 0.11)', bd: 'rgba(227, 169, 92, 0.26)' },
    danger: { fg: '#ff938b', dot: '#f0756c', bg: 'rgba(240, 117, 108, 0.11)', bd: 'rgba(240, 117, 108, 0.28)' },
    info: { fg: '#9dbcff', dot: '#5b93ff', bg: 'rgba(91, 147, 255, 0.10)', bd: 'rgba(91, 147, 255, 0.26)' },
    neutral: { fg: '#aab4c4', dot: '#7d8798', bg: 'rgba(255, 255, 255, 0.05)', bd: 'rgba(255, 255, 255, 0.10)' },
  },
  light: {
    ok: { fg: '#0b6b45', dot: '#0f7a50', bg: 'rgba(15, 122, 80, 0.06)', bd: 'rgba(15, 122, 80, 0.20)' },
    warn: { fg: '#7d500a', dot: '#96610f', bg: 'rgba(150, 97, 15, 0.06)', bd: 'rgba(150, 97, 15, 0.22)' },
    danger: { fg: '#a52a24', dot: '#c1362f', bg: 'rgba(193, 54, 47, 0.05)', bd: 'rgba(193, 54, 47, 0.22)' },
    info: { fg: '#2158c9', dot: '#3b78f6', bg: 'rgba(59, 120, 246, 0.06)', bd: 'rgba(59, 120, 246, 0.22)' },
    neutral: { fg: '#59616f', dot: '#8f98a6', bg: 'rgba(15, 23, 42, 0.04)', bd: 'rgba(15, 23, 42, 0.10)' },
  },
} as const;

/**
 * 把主题色写成 CSS 变量（并在 `<html data-theme>` 上落位）。
 *
 * 首帧之前调用一次，切换主题时再调用一次——两处共用这一个入口，
 * 避免「CSS 变量只在启动时写」导致切主题后面板/芯片不跟着变。
 *
 * **命名只有一种**：驼峰键转 kebab（`textSecondary` → `--cps-text-secondary`）。
 * 之前直接 `toLowerCase()`，写出的是 `--cps-textsecondary`，而 CSS 里写的是
 * `--cps-text-secondary`——变量没定义时浏览器**不报错**，只是静默退回继承色，
 * 于是「第四级文字」全站都没生效过（2.2.1 发现）。名字在两端必须逐字一致。
 */
export function cssVarName(key: string): string {
  return key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

export function applyThemeVars(mode: ThemeMode): void {
  const root = document.documentElement;
  root.dataset.theme = mode;
  for (const [name, value] of Object.entries(PALETTE[mode])) {
    root.style.setProperty(`--cps-${cssVarName(name)}`, value);
  }
  for (const [tone, colors] of Object.entries(STATUS_TONE_CSS[mode])) {
    root.style.setProperty(`--cps-${tone}-fg`, colors.fg);
    root.style.setProperty(`--cps-${tone}-dot`, colors.dot);
    root.style.setProperty(`--cps-${tone}-bg`, colors.bg);
    root.style.setProperty(`--cps-${tone}-bd`, colors.bd);
  }
}

const sharedToken = {
  colorPrimary: PALETTE.dark.primary,
  colorInfo: PALETTE.dark.accent,
  borderRadius: 6,
  borderRadiusLG: 8,
  fontSizeHeading3: 22,
  fontFamily: FONT_SANS,
  fontFamilyCode: FONT_MONO,
  wireframe: false,
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
 * 暗色：antd 默认纯黑布局底（#000）在桌面应用里过于生硬。
 * 抬升为五层体系——画布 / 侧栏 / 面板 / 抬升面 / 弹层，层次靠亮度差与极淡描边。
 */
const darkToken = {
  ...sharedToken,
  colorPrimary: PALETTE.dark.primary,
  colorInfo: PALETTE.dark.accent,
  colorSuccess: PALETTE.dark.success,
  colorWarning: PALETTE.dark.warning,
  colorError: PALETTE.dark.error,
  colorLink: PALETTE.dark.accent,
  colorBgLayout: PALETTE.dark.canvas,
  colorBgContainer: PALETTE.dark.surface,
  colorBgElevated: PALETTE.dark.overlay,
  colorBgSpotlight: PALETTE.dark.overlay,
  colorBorder: PALETTE.dark.borderStrong,
  colorBorderSecondary: PALETTE.dark.border,
  colorText: PALETTE.dark.text,
  colorTextSecondary: PALETTE.dark.textSecondary,
  colorTextTertiary: PALETTE.dark.textTertiary,
  colorTextQuaternary: PALETTE.dark.textQuaternary,
  colorBgMask: PALETTE.dark.mask,
  colorFillSecondary: 'rgba(255, 255, 255, 0.07)',
  colorFillTertiary: 'rgba(255, 255, 255, 0.05)',
  colorFillQuaternary: 'rgba(255, 255, 255, 0.035)',
};

const lightToken = {
  ...sharedToken,
  colorPrimary: PALETTE.light.primary,
  colorInfo: PALETTE.light.accent,
  colorSuccess: PALETTE.light.success,
  colorWarning: PALETTE.light.warning,
  colorError: PALETTE.light.error,
  colorLink: PALETTE.light.accent,
  colorBgLayout: PALETTE.light.canvas,
  colorBgContainer: PALETTE.light.surface,
  colorBgElevated: PALETTE.light.overlay,
  colorBgSpotlight: '#1b2029',
  colorBorder: PALETTE.light.borderStrong,
  colorBorderSecondary: PALETTE.light.border,
  colorText: PALETTE.light.text,
  colorTextSecondary: PALETTE.light.textSecondary,
  colorTextTertiary: PALETTE.light.textTertiary,
  colorTextQuaternary: PALETTE.light.textQuaternary,
  colorBgMask: PALETTE.light.mask,
  colorFillSecondary: 'rgba(15, 23, 42, 0.06)',
  colorFillTertiary: 'rgba(15, 23, 42, 0.045)',
  colorFillQuaternary: 'rgba(15, 23, 42, 0.03)',
};

/**
 * 部件级微调：让 antd 的控件与我们的表面语言一致。
 * - 输入类落在 `raised` 面上，读起来是「凹槽」而不是又一块面板；
 * - 表头用极淡的底色分层，去掉列分隔灰线；
 * - 弹层圆角比面板大一号（面板 8，弹层 12）。
 */
function components(palette: (typeof PALETTE)['dark' | 'light']) {
  return {
    Button: { defaultShadow: 'none', primaryShadow: 'none', dangerShadow: 'none', fontWeight: 500 },
    Input: { colorBgContainer: palette.well, activeShadow: '0 0 0 3px rgba(91, 147, 255, 0.14)' },
    InputNumber: { colorBgContainer: palette.well, activeShadow: '0 0 0 3px rgba(91, 147, 255, 0.14)' },
    Select: { colorBgContainer: palette.well, optionSelectedBg: palette.washStrong, optionActiveBg: palette.rowHover },
    DatePicker: { colorBgContainer: palette.well, activeShadow: '0 0 0 3px rgba(91, 147, 255, 0.14)' },
    Table: {
      headerSplitColor: 'transparent',
      headerBg: 'transparent',
      headerColor: palette.textTertiary,
      borderColor: palette.border,
      rowHoverBg: palette.rowHover,
      cellPaddingBlockSM: 10,
    },
    Tag: { defaultBg: palette.headTint, defaultColor: palette.textSecondary },
    Segmented: { trackBg: palette.headTint, itemSelectedBg: palette.raised, itemColor: palette.textSecondary },
    Message: { contentBg: palette.overlay, contentPadding: '10px 16px' },
    Modal: { borderRadiusLG: 12, contentBg: palette.overlay, headerBg: palette.overlay },
    Drawer: { colorBgElevated: palette.overlay },
    Tooltip: {
      colorBgSpotlight: palette === PALETTE.dark ? '#2a3140' : '#1b2029',
      colorTextLightSolid: '#eef1f7',
    },
    Card: { colorBgContainer: palette.surface },
  };
}

export const darkTheme = {
  algorithm: theme.darkAlgorithm,
  token: darkToken,
  components: components(PALETTE.dark),
};

export const lightTheme = {
  algorithm: theme.defaultAlgorithm,
  token: lightToken,
  components: components(PALETTE.light),
};
