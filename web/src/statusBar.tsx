import {
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
import { Button, Dropdown, Select, Space, Tooltip, Typography, theme } from 'antd';
import { useState } from 'react';

import { useGateways } from './api/hooks.ts';
import type { GatewayView } from './api/types.ts';
import type { HostControl } from './hostBridge.ts';
import { type Lang, type MsgKey, useI18n } from './i18n/index.tsx';
import { type ChipTone, StatusChip } from './statusChip.tsx';

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

const GATEWAY_TONE: Record<GatewayView['status']['state'], ChipTone> = {
  running: 'ok',
  error: 'danger',
  stopped: 'neutral',
  disabled: 'neutral',
};

const GATEWAY_KEY: Record<GatewayView['status']['state'], MsgKey> = {
  running: 'statusbar.gateway.running',
  error: 'statusbar.gateway.error',
  stopped: 'statusbar.gateway.stopped',
  disabled: 'statusbar.gateway.disabled',
};

const SERVICE_TONE: Record<string, ChipTone> = {
  running: 'ok',
  starting: 'warn',
  stopping: 'warn',
  stopped: 'neutral',
  error: 'danger',
};

const SERVICE_KEY: Record<string, MsgKey> = {
  running: 'service.state.running',
  starting: 'service.state.starting',
  stopping: 'service.state.stopping',
  stopped: 'service.state.stopped',
  error: 'service.state.error',
};

/** 状态栏里的一格：小号标签 + 值。标签是「这是什么」，不该靠猜。 */
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
        gap: 8,
        /* 地址可以省略，但不能缩到看不见——再窄就让整条状态栏横向滚动 */
        minWidth: flexible ? 150 : 0,
        flex: flexible ? '1 1 auto' : '0 0 auto',
        whiteSpace: 'nowrap',
      }}
    >
      <span className="cps-label" style={{ flex: '0 0 auto' }}>
        {label}
      </span>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: flexible ? '1 1 auto' : undefined }}
      >
        {children}
      </div>
    </div>
  );
}

function GatewayCluster({ gateway, onOpenGateways }: { gateway: GatewayView | undefined; onOpenGateways: () => void }) {
  const { t } = useI18n();
  if (!gateway) {
    return <span className="cps-meta">{t('statusbar.notReady')}</span>;
  }
  const account = gateway.accountState;
  return (
    <>
      <Tooltip title={gateway.status.error ?? undefined}>
        <StatusChip tone={GATEWAY_TONE[gateway.status.state]} small>
          {t(GATEWAY_KEY[gateway.status.state])}
        </StatusChip>
      </Tooltip>
      {account.code === 'no_accounts' && (
        <Tooltip title={t('statusbar.accountState.no_accounts.tip')}>
          <StatusChip tone="warn" small>
            {t('statusbar.accountState.no_accounts')}
          </StatusChip>
        </Tooltip>
      )}
      {account.code === 'empty_scope' && gateway.status.state !== 'disabled' && (
        <Tooltip
          title={t('statusbar.accountState.empty_scope.tip', {
            inScope: account.inScope,
            total: account.usableTotal,
          })}
        >
          <StatusChip tone="warn" small>
            {t('statusbar.accountState.empty_scope')}
          </StatusChip>
        </Tooltip>
      )}
      <Tooltip title={gateway.hasProxyKey ? t('statusbar.key.tip.set') : t('statusbar.key.tip.unset')}>
        <Button
          size="small"
          type="text"
          icon={gateway.hasProxyKey ? <LockOutlined /> : <KeyOutlined />}
          aria-label={gateway.hasProxyKey ? t('statusbar.key.set') : t('statusbar.key.unset')}
          style={{
            paddingInline: 4,
            color: gateway.hasProxyKey ? 'var(--cps-text-tertiary)' : 'var(--cps-warn-fg)',
          }}
          onClick={onOpenGateways}
        />
      </Tooltip>
    </>
  );
}

function ServiceCluster({ control }: { control: HostControl }) {
  const { t } = useI18n();
  const { status, busy } = control;
  if (!control.host) return null;

  const tone = SERVICE_TONE[status.state] ?? 'neutral';
  const label = t(SERVICE_KEY[status.state] ?? 'service.state.stopped');

  return (
    <Space size={8} align="center" style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>
      <span className="cps-label">{t('statusbar.service')}</span>
      <Tooltip
        title={
          status.port ? t('service.channel.title', { addr: `127.0.0.1:${status.port}` }) : t('service.channel.missing')
        }
      >
        <span>
          <StatusChip tone={tone} small dot={!busy}>
            {busy && <LoadingOutlined style={{ fontSize: 11 }} />}
            {label}
          </StatusChip>
        </span>
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
            style={{ color: 'var(--cps-text-secondary)', paddingInline: 6 }}
          >
            {t('service.action.stopShort')}
          </Button>
          <Button
            size="small"
            type="text"
            icon={<SyncOutlined />}
            loading={busy}
            onClick={() => void control.restart()}
            style={{ color: 'var(--cps-text-secondary)', paddingInline: 6 }}
          >
            {t('service.action.restartShort')}
          </Button>
        </Space>
      )}
      <Tooltip title={t('service.action.logs')}>
        <Button
          size="small"
          type="text"
          icon={<FileTextOutlined />}
          aria-label={t('service.action.logs')}
          onClick={control.openLogs}
          style={{ color: 'var(--cps-text-tertiary)' }}
        />
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
        height: 50,
        flex: '0 0 auto',
        display: 'flex',
        flexWrap: 'nowrap',
        alignItems: 'center',
        gap: 8,
        padding: '0 14px',
        background: 'var(--cps-rail)',
        borderTop: '1px solid var(--cps-border)',
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
          <Typography.Text ellipsis={{ tooltip: picked?.name }} style={{ fontSize: 12.5, maxWidth: 180 }}>
            {picked?.name ?? t('statusbar.notReady')}
          </Typography.Text>
        )}
      </Field>

      <Field label={t('statusbar.address')} flexible>
        {picked?.proxyBase ? (
          <Typography.Text
            ellipsis={{ tooltip: picked.proxyBase }}
            copyable={{ text: picked.proxyBase, tooltips: [t('statusbar.address.copy'), t('common.copied')] }}
            className="cps-data"
            /* 必须 minWidth:0：flex 子项的默认 min-width 是内容宽度，地址不会缩，
               会直接压到右边的状态芯片上（英文界面实测重叠）。 */
            style={{ maxWidth: 320, minWidth: 0, flex: '1 1 auto' }}
          >
            {picked.proxyBase}
          </Typography.Text>
        ) : (
          <span className="cps-meta">{t('statusbar.notReady')}</span>
        )}
      </Field>

      {/* ② 同一个网关的状态 / 账号 / 密钥，紧挨着左侧选择 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: '0 0 auto', whiteSpace: 'nowrap' }}>
        <GatewayCluster gateway={picked} onOpenGateways={onOpenGateways} />
      </div>

      <div style={{ width: 1, height: 18, background: token.colorBorderSecondary, flex: '0 0 auto' }} />

      {/* ③ 服务是进程级动作，明确标注，避免与上面的网关状态混淆 */}
      <div style={{ flex: '0 0 auto', whiteSpace: 'nowrap' }}>
        <ServiceCluster control={control} />
      </div>

      <Space size={2} style={{ marginLeft: 'auto', flex: '0 0 auto' }}>
        <span className="cps-data" style={{ fontSize: 11.5, color: 'var(--cps-text-tertiary)' }}>
          v{version ?? '…'}
        </span>
        {/*
          语言切换：即时生效，不刷新页面。
          **不要用 Tooltip、也不要加原生 title**：状态栏贴着窗口底部，菜单和提示都会被
          自动翻到上方并重叠；WebView2 的原生 title 是独立窗口，会直接压在菜单上，
          antd Tooltip 则会截走菜单项的点击。这个按钮只靠图标与 aria-label。
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
            style={{ color: 'var(--cps-text-tertiary)' }}
          />
        </Dropdown>
        <Tooltip title={mode === 'dark' ? t('statusbar.theme.dark') : t('statusbar.theme.light')}>
          <Button
            size="small"
            type="text"
            icon={mode === 'dark' ? <SunOutlined /> : <MoonOutlined />}
            aria-label={t('statusbar.theme.switch')}
            onClick={onToggleTheme}
            style={{ color: 'var(--cps-text-tertiary)' }}
          />
        </Tooltip>
        <Tooltip title={t('statusbar.refresh')}>
          <Button
            size="small"
            type="text"
            icon={<ReloadOutlined />}
            aria-label={t('statusbar.refresh')}
            onClick={onRefresh}
            style={{ color: 'var(--cps-text-tertiary)' }}
          />
        </Tooltip>
      </Space>
    </div>
  );
}
