import {
  AppstoreOutlined,
  ExperimentOutlined,
  GatewayOutlined,
  HistoryOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  NodeIndexOutlined,
  PushpinFilled,
  PushpinOutlined,
  SettingOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, ConfigProvider, Layout, Tooltip, theme } from 'antd';
import enUS from 'antd/es/locale/en_US';
import zhCN from 'antd/es/locale/zh_CN';
import { type ComponentType, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AccessGate } from './accessGate.tsx';
import { getAuthKey, setAuthKey } from './api/client.ts';
import { useMeta, useRefresh } from './api/hooks.ts';
import './app.css';
import { DetectionAccountProvider } from './detectionScope.tsx';
import Accounts from './features/Accounts.tsx';
import Catalog from './features/Catalog.tsx';
import Gateways from './features/Gateways.tsx';
import History from './features/History.tsx';
import Models from './features/Models.tsx';
import Playground from './features/Playground.tsx';
import Settings from './features/Settings.tsx';
import { useFeedback } from './feedback.ts';
import { useHostControl } from './hostBridge.ts';
import { I18nProvider, type MsgKey, useI18n, useT } from './i18n/index.tsx';
import { PAGE_GUTTER, PAGE_WIDTH } from './layout.ts';
import { animateEnter } from './motion.ts';
import { RoutingGatewayProvider } from './routingGateway.tsx';
import { ServiceBanner } from './serviceBanner.tsx';
import { StatusBar } from './statusBar.tsx';
import { applyThemeVars, darkTheme, initialTheme, lightTheme, persistTheme, type ThemeMode } from './theme.ts';
import { TITLEBAR_HEIGHT, TitleBar } from './titleBar.tsx';

/** 钉住页面的持久化键：打开控制台时默认落到被钉住的页面。 */
const PIN_KEY = 'cps_pinned_page';
const SIDEBAR_KEY = 'cps_sidebar';

/**
 * 导航注册表：壳层只认这张表；页面增减只改这里。
 *
 * 顺序即使用频率：先网关与账号（配置），再订阅模型与测试台（日常），
 * 然后请求历史与设置。完整目录是彩蛋页，永远排在最后且默认不出现。
 */
const PAGES: { key: string; labelKey: MsgKey; icon: ComponentType; element: ComponentType }[] = [
  { key: 'gateways', labelKey: 'nav.gateways', icon: GatewayOutlined, element: Gateways },
  { key: 'accounts', labelKey: 'nav.accounts', icon: TeamOutlined, element: Accounts },
  { key: 'models', labelKey: 'nav.models', icon: NodeIndexOutlined, element: Models },
  { key: 'playground', labelKey: 'nav.playground', icon: ExperimentOutlined, element: Playground },
  { key: 'history', labelKey: 'nav.history', icon: HistoryOutlined, element: History },
  { key: 'settings', labelKey: 'nav.settings', icon: SettingOutlined, element: Settings },
  { key: 'catalog', labelKey: 'nav.catalog', icon: AppstoreOutlined, element: Catalog },
];

/** 左侧导航：可折叠（64px 图标 ⇄ 200px 图标+文字）；悬停可钉住页面（打开时默认落到此页）。 */
function SideNav({
  nav,
  pages,
  onNav,
  onDoubleNav,
  collapsed,
  onToggle,
  pinned,
  onTogglePin,
}: {
  nav: string;
  pages: typeof PAGES;
  onNav: (key: string) => void;
  /** 双击某个导航项（完整目录彩蛋：双击「订阅模型」）。 */
  onDoubleNav: (key: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  pinned: string | null;
  onTogglePin: (key: string) => void;
}) {
  const { token } = theme.useToken();
  const t = useT();
  const btnBase = { height: 40, width: '100%', gap: 10, paddingInline: collapsed ? 0 : 10 } as const;
  const gutter = collapsed ? '0 10px' : '0 12px';
  /**
   * 选中标记：一根 2px 的主色竖条在导航项之间**滑过去**（180ms），
   * 选中项本身只有一层极淡的表面。2.2.0 的整块圆角 pill 太像「组件样例」，
   * 而且和内容区的选中浓度互相打架；一根竖条足够说明位置，也不需要底色。
   */
  const listRef = useRef<HTMLDivElement>(null);
  const [marker, setMarker] = useState<{ top: number; height: number } | null>(null);
  const [indicatorReady, setIndicatorReady] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: collapsed 与 pages.length 改变导航几何，必须重新测量
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.querySelector<HTMLElement>(`[data-nav-key="${nav}"]`);
    if (!item) {
      setMarker(null);
      return;
    }
    const listBox = list.getBoundingClientRect();
    const box = item.getBoundingClientRect();
    const barHeight = 18;
    setMarker({ top: box.top - listBox.top + (box.height - barHeight) / 2, height: barHeight });
  }, [nav, collapsed, pages.length]);
  // 首帧直接落位，不做一次「从顶部滑下来」的假动画
  useEffect(() => {
    const id = requestAnimationFrame(() => setIndicatorReady(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return (
    /*
      侧栏顶部这一段（20 + 28 + 8 = 56px）原本是「logo + Cline Pass」品牌块，
      与自绘标题栏的标识完全重复——按反馈删掉。删除后这段空间不能就这么空着，
      也不能让下面的导航往上提（会与标题栏贴在一起），所以交给侧栏**自己的**折叠
      开关占据：它是侧栏这一列唯一的自有控件，放在列的顶端正好是它的位置。
      20px 这个上边距不是随手值：它让开关的顶边与页面标题的顶边同在一条直线上
      （标题栏 36 + 内容区上内边距 20）。
    */
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: '20px 0 12px' }}>
      <div style={{ display: 'flex', justifyContent: collapsed ? 'center' : 'flex-end', padding: gutter }}>
        <Tooltip
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          placement={collapsed ? 'right' : 'bottomRight'}
        >
          <Button
            type="text"
            aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
            onClick={onToggle}
            style={{
              width: 28,
              minWidth: 28,
              height: 28,
              padding: 0,
              fontSize: 14,
              color: token.colorTextTertiary,
            }}
            icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
          />
        </Tooltip>
      </div>
      <div ref={listRef} style={{ position: 'relative', display: 'grid', gap: 4, padding: gutter, marginTop: 8 }}>
        {marker && (
          <span
            aria-hidden
            className="cps-nav-marker"
            style={{
              left: collapsed ? 11 : 13,
              height: marker.height,
              transform: `translateY(${marker.top}px)`,
              transition: indicatorReady ? undefined : 'none',
            }}
          />
        )}
        {pages.map((p) => {
          const active = nav === p.key;
          const isPinned = pinned === p.key;
          const Comp = p.icon;
          return (
            <div key={p.key} className="cps-nav-item" data-nav-key={p.key}>
              <Tooltip title={collapsed ? t(p.labelKey) : undefined} placement="right">
                <Button
                  type="text"
                  aria-label={t(p.labelKey)}
                  aria-current={active ? 'page' : undefined}
                  className={[
                    'cps-nav',
                    active ? 'cps-nav-active' : '',
                    collapsed && isPinned ? 'cps-nav-pinned-dot' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={() => onNav(p.key)}
                  onDoubleClick={() => onDoubleNav(p.key)}
                  style={{
                    ...btnBase,
                    justifyContent: collapsed ? 'center' : 'flex-start',
                    fontSize: 17,
                    color: active ? token.colorText : token.colorTextSecondary,
                    /* 选中项只有一层薄表面；位置由滑动的竖条承担 */
                    background: active ? 'var(--cps-wash)' : undefined,
                  }}
                  icon={<Comp />}
                >
                  {!collapsed && (
                    <span
                      className="cps-nav-label"
                      style={{
                        fontSize: 13.5,
                        fontWeight: active ? 600 : 400,
                        paddingRight: 18,
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {t(p.labelKey)}
                    </span>
                  )}
                </Button>
              </Tooltip>
              {!collapsed && (
                <Tooltip title={isPinned ? t('pin.unpin') : t('pin.hint')}>
                  <button
                    type="button"
                    aria-label={`${isPinned ? t('pin.unpin') : t('pin.pin')} ${t(p.labelKey)}`}
                    className={isPinned ? 'cps-pin cps-pinned' : 'cps-pin'}
                    onClick={() => onTogglePin(p.key)}
                  >
                    {isPinned ? <PushpinFilled /> : <PushpinOutlined />}
                  </button>
                </Tooltip>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Console({ mode, onToggleTheme }: { mode: ThemeMode; onToggleTheme: () => void }) {
  const { token } = theme.useToken();
  const { t, lang, setLang } = useI18n();
  const meta = useMeta();
  const refresh = useRefresh();
  const qc = useQueryClient();
  const fb = useFeedback();
  /**
   * 服务由壳托管：状态、启停动作、失败原因都在这里（状态栏与提示条共用同一份）。
   * 启停/重启都有回执——按下时说「正在…」，状态真的变过去后说「已完成」。
   */
  const host = useHostControl({
    onChanged: useCallback(() => void qc.invalidateQueries(), [qc]),
    onNotice: useCallback(
      (text: string, kind: 'ok' | 'fail' | 'info') => {
        if (kind === 'ok') fb.ok(text);
        else if (kind === 'fail') fb.fail(text);
        else fb.info(text);
      },
      [fb],
    ),
  });
  /** 钉住的页面：打开控制台时默认落在这里（用户可把高频页钉住，省一次点击）。 */
  const [pinned, setPinned] = useState<string | null>(() => localStorage.getItem(PIN_KEY));
  const [nav, setNav] = useState(() => localStorage.getItem(PIN_KEY) ?? 'gateways');
  /**
   * 完整目录是彩蛋页：**只在本次运行内可见**，不写 localStorage。
   * 上次打开过就永久留在导航里，会让「隐藏功能」变成「移除不掉的入口」。
   */
  const [catalogVisible, setCatalogVisible] = useState(false);
  const pages = PAGES.filter((p) => p.key !== 'catalog' || catalogVisible);
  /** 彩蛋页被隐藏时，别停留在不可达的页面上。 */
  const activeNav = nav === 'catalog' && !catalogVisible ? 'gateways' : nav;
  /**
   * 页面切换：新页面淡入并上移 6px（180ms），而不是硬切。
   * 页面仍然全部挂载（保留表单/滚动/查询状态），只对**当前**容器播一次动画；
   * 快速连续切页时 animateEnter 会取消上一段，不排队。
   */
  const pageRefs = useRef(new Map<string, HTMLDivElement>());
  const contentRef = useRef<HTMLElement>(null);
  const previousNav = useRef(activeNav);
  useLayoutEffect(() => {
    if (previousNav.current === activeNav) return;
    previousNav.current = activeNav;
    // 切页从顶部开始：页面容器共享同一个滚动区，不重置的话会落在上一页的滚动位置
    contentRef.current?.scrollTo({ top: 0 });
    animateEnter(pageRefs.current.get(activeNav), { y: 6 });
  }, [activeNav]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(SIDEBAR_KEY) === 'collapsed');

  const toggleSidebar = (): void => {
    setCollapsed((c) => {
      localStorage.setItem(SIDEBAR_KEY, c ? 'expanded' : 'collapsed');
      return !c;
    });
  };

  /** 双击「订阅模型」：显示/隐藏完整目录（彩蛋，不跨会话保留）。 */
  const toggleCatalog = (key: string): void => {
    if (key !== 'models') return;
    const next = !catalogVisible;
    setCatalogVisible(next);
    if (next) setNav('catalog');
    else if (nav === 'catalog') setNav('models');
  };

  const togglePin = (key: string): void => {
    const page = PAGES.find((p) => p.key === key);
    const name = page ? t(page.labelKey) : key;
    setPinned((p) => {
      const next = p === key ? null : key;
      if (next) localStorage.setItem(PIN_KEY, next);
      else localStorage.removeItem(PIN_KEY);
      fb.ok(next ? t('pin.done', { name }) : t('pin.undone', { name }));
      return next;
    });
  };

  /** 存一份状态只为在密钥变化时触发重渲染（值本身不再显示）。 */
  const [, setKey] = useState(getAuthKey());
  /**
   * 需要密钥才能读控制台 API（只可能出现在**远端访问**的部署上）。
   *
   * 这里是 v2.9.2 真实反馈的修复点：以前一设密钥就弹一个关不掉的模态框，
   * 密钥忘了/输了错的就永远进不去——用下发给客户端的密钥把机器主人锁在门外。
   * 现在两件事都改了：
   * 1. 服务端把「本机访问控制台」判定为最高权限，本机永远不发 401（见 security/local.ts）；
   * 2. 页面侧不再用模态框硬拦，改成一块**常驻、可重试、给出恢复路径**的面板——
   *    不可能出现「关不掉的弹窗」这种死循环。
   */
  const [needKey, setNeedKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyChecking, setKeyChecking] = useState(false);
  const [keyError, setKeyError] = useState<string | null>(null);

  // 页面底色跟随主题（Layout 之外的区域由 body 承担）；
  // data-theme 与表面色变量由 applyThemeVars 一次写完（切主题时重跑）
  useEffect(() => {
    applyThemeVars(mode);
    document.body.style.background = token.colorBgLayout;
    document.body.style.colorScheme = mode;
  }, [token.colorBgLayout, mode]);

  /*
   * WebView2 的原生 title 提示是独立窗口，会压在同一个触发器的弹出层上。
   * antd Select 会给选中值自动加 title，悬停 Select 再打开下拉时，黑色提示框
   * 会盖住选项（尤其靠近窗口底部时）。这里只摘掉 Select 的 title；完整值本来
   * 在下拉里就能看到，不损失信息。
   */
  useEffect(() => {
    const strip = (): void => {
      for (const el of document.querySelectorAll('.ant-select-content[title], .ant-select-selection-item[title]')) {
        el.removeAttribute('title');
      }
    };
    strip();
    const observer = new MutationObserver(strip);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
    return () => observer.disconnect();
  }, []);

  // 遇到 401（远端部署且密钥缺失/失效）→ 记下状态，由面板承担输入
  useEffect(() => {
    const handler = (): void => {
      setAuthKey('');
      setKey('');
      setNeedKey(true);
    };
    window.addEventListener('cps:unauthorized', handler);
    return () => window.removeEventListener('cps:unauthorized', handler);
  }, []);

  // 页面内的引导按钮通过自定义事件请求切页（避免给每个 feature 传导航 prop）
  useEffect(() => {
    const handler = (e: Event): void => {
      const key = (e as CustomEvent<string>).detail;
      if (typeof key === 'string') setNav(key);
    };
    window.addEventListener('cps:navigate', handler);
    return () => window.removeEventListener('cps:navigate', handler);
  }, []);

  const tryKey = async (): Promise<void> => {
    const candidate = keyDraft.trim();
    if (!candidate) {
      setKeyError(t('key.required'));
      return;
    }
    setKeyChecking(true);
    setKeyError(null);
    try {
      const res = await fetch('/api/models', { headers: { 'X-Admin-Key': candidate } });
      if (!res.ok)
        throw new Error(res.status === 401 ? t('key.invalid') : t('key.serverStatus', { status: res.status }));
      setAuthKey(candidate);
      setKey(candidate);
      setNeedKey(false);
      setKeyDraft('');
      void qc.invalidateQueries();
      fb.ok(t('key.ok'));
    } catch (err) {
      setKeyError((err as Error).message);
    } finally {
      setKeyChecking(false);
    }
  };

  return (
    // 检测账号与路由网关是跨页共享状态（页面同时挂载，各自持有会不同步）
    <>
      {/* 桌面应用形态：自绘标题栏 + 固定侧栏 + 内容区内滚 + 常驻状态栏（窗口高度恒定，不整页滚） */}
      <TitleBar />
      <Layout style={{ height: '100vh', paddingTop: TITLEBAR_HEIGHT, background: 'transparent' }}>
        <Layout.Sider
          width={collapsed ? 64 : 200}
          style={{
            background: 'var(--cps-rail)',
            borderRight: '1px solid var(--cps-border)',
          }}
        >
          <SideNav
            nav={activeNav}
            pages={pages}
            onDoubleNav={toggleCatalog}
            onNav={setNav}
            collapsed={collapsed}
            onToggle={toggleSidebar}
            pinned={pinned}
            onTogglePin={togglePin}
          />
        </Layout.Sider>

        <DetectionAccountProvider>
          <RoutingGatewayProvider>
            <Layout style={{ background: 'transparent', minWidth: 0 }}>
              {/*
            内容列由外壳统一给定（唯一来源）：所有页面共用同一个宽度与左边距。
            两处关键：
            1. `scrollbarGutter: 'stable'` —— 常驻预留滚动条槽位。不预留的话，
               页面有滚动条时内容宽 1044、没有时 1054，切页时整块内容横移 5px
               （「切页感觉布局偏移、不像一个 app」的真正来源）。
            2. 页面**不许**再自己写 maxWidth —— 一写就与别的页面对不齐，
               标题的横坐标会在切页时跳。
          */}
              <Layout.Content
                ref={contentRef}
                style={{
                  overflow: 'auto',
                  scrollbarGutter: 'stable',
                  padding: `20px ${PAGE_GUTTER}px 24px`,
                }}
              >
                <div
                  style={{
                    width: '100%',
                    maxWidth: PAGE_WIDTH,
                    margin: '0 auto',
                    /* 必须给**确定**高度（不是 minHeight）：需要填满内容列的页面
                   （订阅模型）以它为高度来源；内容更高的页面照常溢出、由内容区滚动。 */
                    height: '100%',
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  {needKey ? (
                    <AccessGate
                      value={keyDraft}
                      onChange={setKeyDraft}
                      onSubmit={() => void tryKey()}
                      checking={keyChecking}
                      error={keyError}
                    />
                  ) : (
                    <>
                      <ServiceBanner control={host} />
                      {pages.map((p) => (
                        /* 页面包装层可拉伸、不可压缩：需要「填满内容列」的页面（订阅模型）
                       把这一层当高度来源；内容更高的页面保持自然高度、由内容区滚动。
                       shrink 必须是 0——缩了会把高页面的内容压进视口。 */
                        <div
                          key={p.key}
                          ref={(node) => {
                            if (node) pageRefs.current.set(p.key, node);
                            else pageRefs.current.delete(p.key);
                          }}
                          style={{ display: activeNav === p.key ? 'block' : 'none', flex: '1 0 auto', minHeight: 0 }}
                        >
                          <p.element />
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </Layout.Content>

              <StatusBar
                control={host}
                version={meta.data?.version}
                onOpenGateways={() => setNav('gateways')}
                mode={mode}
                lang={lang}
                onToggleLang={setLang}
                onToggleTheme={onToggleTheme}
                onRefresh={() => {
                  refresh();
                  fb.ok(t('app.refreshed'));
                }}
              />
            </Layout>
          </RoutingGatewayProvider>
        </DetectionAccountProvider>
      </Layout>
    </>
  );
}

/** 语言与主题都在最外层：Console 在 ConfigProvider 内部才能拿到主题 token 与 locale。 */
export default function App() {
  return (
    <I18nProvider>
      <AppShell />
    </I18nProvider>
  );
}

function AppShell() {
  const { lang } = useI18n();
  const [mode, setMode] = useState<ThemeMode>(initialTheme);

  const toggleTheme = (): void => {
    const next: ThemeMode = mode === 'dark' ? 'light' : 'dark';
    setMode(next);
    persistTheme(next);
  };

  return (
    // antd 的组件内建文案（分页、空态、日期选择等）跟随语言即时切换
    <ConfigProvider theme={mode === 'dark' ? darkTheme : lightTheme} locale={lang === 'zh-CN' ? zhCN : enUS}>
      <AntdApp>
        <Console mode={mode} onToggleTheme={toggleTheme} />
      </AntdApp>
    </ConfigProvider>
  );
}
