import {
  CheckCircleFilled,
  CloseCircleFilled,
  ExclamationCircleFilled,
  FileTextOutlined,
  KeyOutlined,
  LoadingOutlined,
  LockOutlined,
  MoonOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  SunOutlined,
  SyncOutlined,
  TranslationOutlined,
} from '@ant-design/icons';
import { Button, Dropdown, Select, Space, Tag, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';

import { useGateways } from './api/hooks.ts';
import type { GatewayView } from './api/types.ts';
import type { HostControl } from './hostBridge.ts';
import { type Lang, type MsgKey, useI18n } from './i18n/index.tsx';

/**
 * 常驻状态栏。2.1 起以**左侧选中的网关**为主线（左→右 = 同一个网关的完整状态）：
 *
 * ① 接入：网关选择 + 该网关的 BASE URL（选中谁，这一行就是谁）。
 * ② 该网关的状态：监听状态、账号范围是否有可用账号、密钥是否已设置。
 * ③ 服务：Node 服务的启停（**明确标注「服务」**，不再与网关状态混在一起）。
 * ④ 应用：版本、语言、主题、刷新。
 *
 * 旧版把「服务运行中 + 停止/重启」放在最左，紧挨着网关选择器——用户会以为
 * 那是在说选中的网关；而它其实是整个进程。现在两者用分隔线明确分开。
 */

const STATE_COLOR: Record<string, string> = {
  running: '#52c41a',
  starting: '#faad14',
  stopping: '#faad14',
  stopped: 'var(--ant-color-text-quaternary)',
  error: '#ff4d4f',
};

const STATE_ICON: Record<string, typeof CheckCircleFilled> = {
  running: CheckCircleFilled,
  starting: ExclamationCircleFilled,
  stopping: ExclamationCircleFilled,
  stopped: CloseCircleFilled,
  error: CloseCircleFilled,
};

const STATE_KEY: Record<string, MsgKey> = {
  running: 'service.state.running',
  starting: 'service.state.starting',
  stopping: 'service.state.stopping',
  stopped: 'service.state.stopped',
  error: 'service.state.error',
};

/** 状态栏里的一格：小号灰色标签 + 值。标签是「这是什么」不该靠猜。 */
function Field({
  label,
  children,
  flexible,
}: {
  label: string;
  children: React.ReactNode;
  /**
   * 允许这一格在窄窗口下收缩（只有接入地址需要）。
   *
   * 其余各格必须 `flex: 0 0 auto` + `nowrap`：状态栏是固定高度的一行，
   * 一旦允许收缩，中文会被逐字挤成竖排（「网 / 关」），看起来像 UI 坏了。
   * 地址太长时由它自己省略，复制按钮仍在。
   */
  flexible?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        /* 地址可以省略，但不能缩到看不见——再窄就让整条状态栏横向滚动 */
        minWidth: flexible ? 150 : 0,
        flex: flexible ? '1 1 auto' : '0 0 auto',
        whiteSpace: 'nowrap',
      }}
    >
      <Typography.Text style={{ fontSize: 12, color: 'var(--ant-color-text-quaternary)', flex: '0 0 auto' }}>
        {label}
      </Typography.Text>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>{children}</div>
    </div>
  );
}

const GATEWAY_STATE_TAG: Record<GatewayView['status']['state'], { color: string; key: MsgKey }> = {
  running: { color: 'green', key: 'statusbar.gateway.running' },
  error: { color: 'red', key: 'statusbar.gateway.error' },
  stopped: { color: 'default', key: 'statusbar.gateway.stopped' },
  disabled: { color: 'default', key: 'statusbar.gateway.disabled' },
};

/** 状态标签的颜色过渡：状态翻转时是「变色」，不是「闪一下」。 */
const TAG_MOTION = {
  margin: 0,
  transition:
    'background-color var(--cps-duration-base) var(--cps-ease-standard), color var(--cps-duration-base) var(--cps-ease-standard), border-color var(--cps-duration-base) var(--cps-ease-standard)',
} as const;

function GatewayCluster({ gateway, onOpenGateways }: { gateway: GatewayView | undefined; onOpenGateways: () => void }) {
  const { t } = useI18n();
  if (!gateway) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {t('statusbar.notReady')}
      </Typography.Text>
    );
  }
  const state = GATEWAY_STATE_TAG[gateway.status.state];
  const account = gateway.accountState;
  return (
    <>
      <Tooltip title={gateway.status.error ?? undefined}>
        <Tag color={state.color} style={TAG_MOTION}>
          {t(state.key)}
        </Tag>
      </Tooltip>
      {account.code === 'no_accounts' && (
        <Tooltip title={t('statusbar.accountState.no_accounts.tip')}>
          <Tag color="warning" style={TAG_MOTION}>
            {t('statusbar.accountState.no_accounts')}
          </Tag>
        </Tooltip>
      )}
      {account.code === 'empty_scope' && gateway.status.state !== 'disabled' && (
        <Tooltip
          title={t('statusbar.accountState.empty_scope.tip', {
            inScope: account.inScope,
            total: account.usableTotal,
          })}
        >
          <Tag color="warning" style={TAG_MOTION}>
            {t('statusbar.accountState.empty_scope')}
          </Tag>
        </Tooltip>
      )}
      <Tooltip title={gateway.hasProxyKey ? t('statusbar.key.tip.set') : t('statusbar.key.tip.unset')}>
        <Button
          size="small"
          type="link"
          icon={gateway.hasProxyKey ? <LockOutlined /> : <KeyOutlined />}
          style={{ fontSize: 13, padding: 0, height: 'auto' }}
          onClick={onOpenGateways}
        >
          {gateway.hasProxyKey ? t('statusbar.key.set') : t('statusbar.key.unset')}
        </Button>
      </Tooltip>
    </>
  );
}

function ServiceCluster({ control }: { control: HostControl }) {
  const { token } = theme.useToken();
  const { t } = useI18n();
  const { status, busy } = control;
  if (!control.host) return null;

  const Icon = busy ? LoadingOutlined : (STATE_ICON[status.state] ?? CloseCircleFilled);
  const color = STATE_COLOR[status.state] ?? token.colorTextSecondary;
  const label = t(STATE_KEY[status.state] ?? 'service.state.stopped');

  return (
    <Space size={8} align="center" style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>
      <Typography.Text style={{ fontSize: 12, color: 'var(--ant-color-text-quaternary)' }}>
        {t('statusbar.service')}
      </Typography.Text>
      <Tooltip
        title={
          status.port ? t('service.channel.title', { addr: `127.0.0.1:${status.port}` }) : t('service.channel.missing')
        }
      >
        <Space size={6} align="center">
          <Icon style={{ color, fontSize: 12 }} />
          <Typography.Text style={{ fontSize: 13, color: token.colorText }}>{label}</Typography.Text>
        </Space>
      </Tooltip>
      {status.state === 'stopped' || status.state === 'error' ? (
        <Button
          size="small"
          type="primary"
          ghost
          icon={<PlayCircleOutlined />}
          loading={busy}
          onClick={() => void control.start()}
        >
          {t('service.action.startShort')}
        </Button>
      ) : (
        <Space size={2}>
          <Button
            size="small"
            type="text"
            icon={<PauseCircleOutlined />}
            loading={busy}
            onClick={() => void control.stop()}
          >
            {t('service.action.stopShort')}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<SyncOutlined />}
            loading={busy}
            onClick={() => void control.restart()}
          >
            {t('service.action.restartShort')}
          </Button>
        </Space>
      )}
      <Tooltip title={t('service.action.logs')}>
        <Button size="small" type="text" icon={<FileTextOutlined />} onClick={control.openLogs} />
      </Tooltip>
    </Space>
  );
}

export function StatusBar({
  control,
  version,
  onOpenGateways,
  mode,
  lang,
  onToggleLang,
  onToggleTheme,
  onRefresh,
}: {
  control: HostControl;
  version?: string;
  onOpenGateways: () => void;
  mode: 'light' | 'dark';
  lang: Lang;
  onToggleLang: (lang: Lang) => void;
  onToggleTheme: () => void;
  onRefresh: () => void;
}) {
  const { token } = theme.useToken();
  const { t } = useI18n();
  // 多网关：状态栏可以查看任意网关的接入地址、状态与密钥（与控制台监听无关）。
  const gatewaysQuery = useGateways({ poll: false });
  const gateways = gatewaysQuery.data?.gateways ?? [];
  const [pickedId, setPickedId] = useState(() => localStorage.getItem('cps_status_gateway') ?? '');
  const picked = gateways.find((g) => g.id === pickedId) ?? gateways[0];

  return (
    <div
      className="cps-statusbar"
      style={{
        height: 54,
        flex: '0 0 auto',
        display: 'flex',
        flexWrap: 'nowrap',
        alignItems: 'center',
        gap: 8,
        padding: '0 16px',
        background: token.colorBgContainer,
        borderTop: `1px solid ${token.colorBorderSecondary}`,
        overflowX: 'auto',
      }}
    >
      {/* ① 左侧选中的网关 = 这一行的主语 */}
      <Field label={t('statusbar.gateway')}>
        {gateways.length > 1 ? (
          <Select
            size="small"
            variant="borderless"
            style={{ minWidth: 88, maxWidth: 180 }}
            value={picked?.id}
            popupMatchSelectWidth={false}
            onChange={(id: string) => {
              setPickedId(id);
              localStorage.setItem('cps_status_gateway', id);
            }}
            options={gateways.map((g) => ({ value: g.id, label: g.name }))}
          />
        ) : (
          <Typography.Text ellipsis={{ tooltip: picked?.name }} style={{ fontSize: 13, maxWidth: 180 }}>
            {picked?.name ?? t('statusbar.notReady')}
          </Typography.Text>
        )}
      </Field>

      <Field label={t('statusbar.address')} flexible>
        {picked?.proxyBase ? (
          <Typography.Text
            ellipsis={{ tooltip: picked.proxyBase }}
            copyable={{ text: picked.proxyBase, tooltips: [t('statusbar.address.copy'), t('common.copied')] }}
            style={{ fontSize: 13, fontFamily: 'var(--cps-font-mono)', maxWidth: 320 }}
          >
            {picked.proxyBase}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 13 }}>
            {t('statusbar.notReady')}
          </Typography.Text>
        )}
      </Field>

      {/* ② 同一个网关的状态 / 账号 / 密钥，紧挨着左侧选择 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto', whiteSpace: 'nowrap' }}>
        <GatewayCluster gateway={picked} onOpenGateways={onOpenGateways} />
      </div>

      <div style={{ width: 1, height: 20, background: token.colorBorderSecondary, flex: '0 0 auto' }} />

      {/* ③ 服务是进程级动作，明确标注，避免与上面的网关状态混淆 */}
      <div style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>
        <ServiceCluster control={control} />
      </div>

      <Space size={2} style={{ marginLeft: 'auto', flex: '0 0 auto' }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          v{version ?? '…'}
        </Typography.Text>
        {/*
          语言切换：即时生效，不刷新页面。
          **不要用 Tooltip 包这个按钮**：状态栏贴着窗口底部，菜单和提示都会被自动
          翻到上方并重叠，提示层会截走菜单项的点击（实测：语言菜单点不动）。
          用原生 title 即可，它不参与命中测试。
        */}
        <Dropdown
          trigger={['click']}
          menu={{
            selectable: true,
            selectedKeys: [lang],
            items: [
              { key: 'zh-CN', label: '中文' },
              { key: 'en-US', label: 'English' },
            ],
            onClick: ({ key }) => onToggleLang(key as Lang),
          }}
        >
          <Button
            size="small"
            type="text"
            icon={<TranslationOutlined />}
            aria-label={t('app.lang.switch')}
            title={t('app.lang.switch')}
          />
        </Dropdown>
        <Tooltip title={mode === 'dark' ? t('statusbar.theme.dark') : t('statusbar.theme.light')}>
          <Button
            size="small"
            type="text"
            icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            onClick={onToggleTheme}
          />
        </Tooltip>
        <Tooltip title={t('statusbar.refresh')}>
          <Button size="small" type="text" icon={<ReloadOutlined />} onClick={onRefresh} />
        </Tooltip>
      </Space>
    </div>
  );
}
