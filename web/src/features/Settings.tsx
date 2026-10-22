import { InfoCircleOutlined, SaveOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Descriptions,
  Input,
  InputNumber,
  Popconfirm,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';

import { setAuthKey } from '../api/client.ts';
import { useConsole, useMeta, useSaveConsole } from '../api/hooks.ts';
import type { ConsoleStatus } from '../api/types.ts';
import { useFeedback } from '../feedback.ts';
import { getHostBridge, type HostInfo } from '../hostBridge.ts';
import { type MsgKey, useI18n } from '../i18n/index.tsx';
import { PageHeader } from '../pageHeader.tsx';
import { Panel } from '../panel.tsx';

/**
 * 设置页：只放「不属于账号、也不属于某个网关」的东西。
 *
 * - 启动：桌面壳的开机自启（操作系统级）
 * - 控制台访问：独立监听的端口/绑定/远端密钥（2.1 起与网关解耦）
 * - 数据：数据目录、日志、本机保存的访问密钥
 * - 关于：版本、仓库与许可证
 */

const STATE_TAG: Record<ConsoleStatus['state'], { color: string; key: MsgKey }> = {
  running: { color: 'green', key: 'settings.console.state.running' },
  error: { color: 'red', key: 'settings.console.state.error' },
  stopped: { color: 'default', key: 'settings.console.state.stopped' },
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '120px 1fr', gap: 12, alignItems: 'center' }}>
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  );
}

function AutostartPanel() {
  const { t } = useI18n();
  const host = getHostBridge();
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host?.autostart) return;
    let alive = true;
    void host
      .autostart()
      .then((r) => {
        if (alive) setEnabled(r.enabled);
      })
      .catch((err: unknown) => {
        if (alive) setError((err as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [host]);

  const toggle = async (next: boolean): Promise<void> => {
    if (!host?.setAutostart) return;
    setBusy(true);
    setError(null);
    try {
      const r = await host.setAutostart(next);
      setEnabled(r.enabled);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel title={t('settings.start.title')}>
      <div style={{ display: 'grid', gap: 12 }}>
        <Space size={12} align="center">
          <Switch checked={enabled === true} loading={busy || enabled === null} onChange={(v) => void toggle(v)} />
          <Typography.Text>{t('settings.start.autostart')}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('settings.start.autostartHint')}
          </Typography.Text>
        </Space>
        {error && <Alert type="error" showIcon message={t('settings.start.failed')} description={error} />}
      </div>
    </Panel>
  );
}

function ConsolePanel() {
  const { t } = useI18n();
  const { token } = theme.useToken();
  const consoleQuery = useConsole();
  const save = useSaveConsole();
  const host = getHostBridge();
  const data = consoleQuery.data;
  const [port, setPort] = useState<number | null>(null);
  const [bindHost, setBindHost] = useState('');
  const [key, setKey] = useState('');

  useEffect(() => {
    if (!data) return;
    setPort(data.port);
    setBindHost(data.bindHost);
  }, [data]);

  const status = data?.status ?? { state: 'stopped' as const, boundPort: null, boundHost: null };
  const tag = STATE_TAG[status.state] ?? STATE_TAG.stopped;
  /**
   * 非回环绑定必须保留访问密钥（服务端会拒绝清除）。
   * 这里提前禁用并说明原因，避免用户点完确认才收到一个失败回执。
   */
  const savedBindHost = (data?.bindHost ?? bindHost)
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  const loopbackBind = savedBindHost === 'localhost' || savedBindHost === '::1' || /^127\./.test(savedBindHost);
  const canClearKey = !!data?.hasProxyKey && loopbackBind;

  return (
    <Panel title={t('settings.console.title')}>
      <div style={{ display: 'grid', gap: 14 }}>
        <Descriptions
          size="small"
          column={1}
          items={[
            {
              key: 'url',
              label: t('settings.console.url'),
              children: data ? (
                <Typography.Text
                  copyable={{ text: data.url, tooltips: [t('common.copy'), t('common.copied')] }}
                  className="cps-mono"
                >
                  {data.url}
                </Typography.Text>
              ) : (
                '—'
              ),
            },
            {
              key: 'state',
              label: t('settings.console.state'),
              children: (
                <Space size={8} wrap>
                  <Tag color={tag.color} style={{ margin: 0 }}>
                    {t(tag.key)}
                  </Tag>
                  {status.state === 'running' && status.boundPort ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {`${status.boundHost ?? '127.0.0.1'}:${status.boundPort}`}
                    </Typography.Text>
                  ) : null}
                  {status.error ? (
                    <Tooltip title={status.error}>
                      <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis>
                        {status.error}
                      </Typography.Text>
                    </Tooltip>
                  ) : null}
                </Space>
              ),
            },
            {
              key: 'key',
              label: t('settings.console.key'),
              children: (
                <Tag color={data?.hasProxyKey ? 'green' : 'default'} style={{ margin: 0 }}>
                  {data?.hasProxyKey ? t('settings.console.keySet') : t('settings.console.keyUnset')}
                </Tag>
              ),
            },
          ]}
        />

        <div style={{ display: 'grid', gap: 12 }}>
          <Field label={t('settings.console.port')}>
            <Space size={8} align="center">
              <InputNumber
                min={1}
                max={65535}
                value={port}
                disabled={!!host}
                onChange={(v) => setPort(v)}
                style={{ width: 140 }}
              />
              {host && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('settings.console.portDesktopFixed')}
                </Typography.Text>
              )}
            </Space>
          </Field>
          <Field label={t('settings.console.bindHost')}>
            <Space size={8} align="center">
              <Input
                value={bindHost}
                disabled={!!host}
                onChange={(e) => setBindHost(e.target.value)}
                style={{ maxWidth: 240 }}
                placeholder="127.0.0.1"
              />
              {host && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('settings.console.bindDesktopFixed')}
                </Typography.Text>
              )}
            </Space>
          </Field>
          <Field label={t('settings.console.newKey')}>
            <Input.Password
              value={key}
              onChange={(e) => setKey(e.target.value)}
              style={{ maxWidth: 320 }}
              placeholder={t('settings.console.newKey.placeholder')}
            />
          </Field>
          <div style={{ display: 'flex', gap: 8, paddingLeft: 132 }}>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              loading={save.isPending}
              onClick={() =>
                save.mutate(
                  {
                    port: port ?? data?.port,
                    bindHost,
                    ...(key.trim() ? { proxyKey: key.trim() } : {}),
                    note: t('settings.console.saved'),
                  },
                  { onSuccess: () => setKey('') },
                )
              }
            >
              {t('settings.console.save')}
            </Button>
            <Tooltip title={data?.hasProxyKey && !canClearKey ? t('settings.console.clearKey.nonLoopback') : undefined}>
              <span>
                <Popconfirm
                  title={t('settings.console.clearKey.confirmTitle')}
                  description={t('settings.console.clearKey.confirmDesc')}
                  okText={t('common.confirmClear')}
                  okButtonProps={{ danger: true }}
                  cancelText={t('common.cancel')}
                  onConfirm={() =>
                    save.mutate(
                      { proxyKey: null, note: t('settings.console.cleared') },
                      { onSuccess: () => setKey('') },
                    )
                  }
                >
                  <Button danger disabled={!canClearKey}>
                    {t('settings.console.clearKey')}
                  </Button>
                </Popconfirm>
              </span>
            </Tooltip>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-start',
            fontSize: 12,
            color: token.colorTextTertiary,
          }}
        >
          <InfoCircleOutlined style={{ marginTop: 3 }} />
          <span>{t('settings.console.note')}</span>
        </div>
      </div>
    </Panel>
  );
}

function DataPanel() {
  const { t } = useI18n();
  const fb = useFeedback();
  const host = getHostBridge();
  const [info, setInfo] = useState<HostInfo | null>(null);

  useEffect(() => {
    if (!host?.info) return;
    let alive = true;
    void host
      .info()
      .then((r) => {
        if (alive) setInfo(r);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [host]);

  return (
    <Panel title={t('settings.data.title')}>
      <div style={{ display: 'grid', gap: 14 }}>
        {info ? (
          <Descriptions
            size="small"
            column={1}
            items={[
              {
                key: 'data',
                label: t('settings.data.dir'),
                children: (
                  <Typography.Text copyable={{ tooltips: [t('common.copy'), t('common.copied')] }} className="cps-mono">
                    {info.dataDir}
                  </Typography.Text>
                ),
              },
              {
                key: 'logs',
                label: t('settings.data.logs'),
                children: <Typography.Text className="cps-mono">{info.logDir}</Typography.Text>,
              },
            ]}
          />
        ) : (
          <Typography.Text type="secondary">{t('settings.data.desktopOnly')}</Typography.Text>
        )}
        <Space size={8} wrap>
          <Button disabled={!host?.openLogs} onClick={() => host?.openLogs().catch(() => {})}>
            {t('service.action.logs')}
          </Button>
          <Popconfirm
            title={t('settings.data.clearKey.confirmTitle')}
            description={t('settings.data.clearKey.confirmDesc')}
            okText={t('common.confirmClear')}
            okButtonProps={{ danger: true }}
            cancelText={t('common.cancel')}
            onConfirm={() => {
              setAuthKey('');
              fb.ok(t('settings.data.keyCleared'));
            }}
          >
            <Button danger>{t('settings.data.clearKey')}</Button>
          </Popconfirm>
        </Space>
      </div>
    </Panel>
  );
}

function AboutPanel() {
  const { t } = useI18n();
  const meta = useMeta();
  return (
    <Panel title={t('settings.about.title')}>
      <Descriptions
        size="small"
        column={1}
        items={[
          {
            key: 'version',
            label: t('settings.about.version'),
            children: <span className="cps-mono">v{meta.data?.version ?? '…'}</span>,
          },
          {
            key: 'repo',
            label: t('settings.about.repo'),
            children: (
              <Typography.Link href="https://github.com/wintervault/cline-pass-plus" target="_blank" rel="noreferrer">
                wintervault/cline-pass-plus
              </Typography.Link>
            ),
          },
          {
            key: 'license',
            label: t('settings.about.license'),
            children: 'MIT',
          },
        ]}
      />
    </Panel>
  );
}

export default function Settings() {
  const { t } = useI18n();
  const host = getHostBridge();
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader title={t('settings.title')} desc={t('settings.desc')} />
      {/* 开机自启只在桌面版有意义：浏览器/服务器部署不显示这一块 */}
      {host?.autostart ? <AutostartPanel /> : null}
      <ConsolePanel />
      <DataPanel />
      <AboutPanel />
    </div>
  );
}
