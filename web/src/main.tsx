import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import App from './App.tsx';
import { UnauthorizedError } from './api/client.ts';
import { DURATION, EASE } from './motion.ts';
import { applyThemeVars, FONT_MONO, FONT_SANS, initialTheme } from './theme.ts';

// 字体栈的唯一来源是 theme.ts；CSS 侧通过自定义变量引用（antd 6 **不会**把
// fontFamily / fontFamilyCode 注入成 --ant-* 变量，实测为空——别再依赖它）。
document.documentElement.style.setProperty('--cps-font-sans', FONT_SANS);
document.documentElement.style.setProperty('--cps-font-mono', FONT_MONO);

// 主题在首帧之前落位：CSS 的暗/亮表面 token 依赖它，晚一帧会闪一下。
// 表面与状态色同样只有一个来源（theme.ts），CSS 里不重复写色值。
applyThemeVars(initialTheme());

// 动效 token 的唯一来源是 motion.ts（antd 在 theme.ts 映射到同一套值）。
for (const [name, ms] of Object.entries(DURATION)) {
  document.documentElement.style.setProperty(`--cps-duration-${name}`, `${ms}ms`);
}
document.documentElement.style.setProperty('--cps-ease-standard', EASE.standard);
document.documentElement.style.setProperty('--cps-ease-exit', EASE.exit);

const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error) => {
      if (error instanceof UnauthorizedError) window.dispatchEvent(new Event('cps:unauthorized'));
    },
  }),
  mutationCache: new MutationCache({
    onError: (error) => {
      if (error instanceof UnauthorizedError) window.dispatchEvent(new Event('cps:unauthorized'));
    },
  }),
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('缺少 #root 挂载点');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
