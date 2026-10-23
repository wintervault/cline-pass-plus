import { ArrowDownOutlined, ArrowUpOutlined, DeleteOutlined, EditOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Drawer,
  Input,
  InputNumber,
  Popconfirm,
  Segmented,
  Select,
  Skeleton,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';

import { useAccounts, useDeleteGateway, useGateways, useMeta, useSaveGateway } from '../api/hooks.ts';
import type { AccountMode, AccountScope, FailoverConfig, GatewayView } from '../api/types.ts';
import { useFeedback } from '../feedback.ts';
import { type MsgKey, useI18n } from '../i18n/index.tsx';
import { useFlipList } from '../motion.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';

/**
 * 网关 = 一个独立的接入面（端口 + 密钥 + 账号子集 + 账号策略 + 模型清单与路由配置）。
 *
 * 这一页承担了 3.0 之前「访问与安全」的全部内容：接入地址、API Key、CORS、目录暴露
 * 本来就是接入面的属性，多网关后只能按网关编辑——单独一页会立刻变成「编辑的是哪一个」。
 */

const STATE_TAG: Record<GatewayView['status']['state'], { color: string; labelKey: MsgKey }> = {
  running: { color: 'green', labelKey: 'gateways.state.running' },
  error: { color: 'red', labelKey: 'gateways.state.error' },
  stopped: { color: 'default', labelKey: 'gateways.state.stopped' },
  disabled: { color: 'default', labelKey: 'gateways.state.disabled' },
};

const ACCOUNT_MODE_OPTIONS: Array<{ value: AccountMode; labelKey: MsgKey }> = [
  { value: 'sticky', labelKey: 'gateways.mode.sticky' },
  { value: 'single', labelKey: 'gateways.mode.single' },
  { value: 'roundrobin', labelKey: 'gateways.mode.roundrobin' },
];

const MODE_HINT: Record<AccountMode, MsgKey> = {
  sticky: 'gateways.mode.hint.sticky',
  single: 'gateways.mode.hint.single',
  roundrobin: 'gateways.mode.hint.roundrobin',
};

const ADVANCED_KEY = 'cps_gateway_advanced';

/** 账号范围四选一（顺序按用户习惯：正常 / 风控 / 全部 / 自选）。 */
const SCOPE_OPTIONS: Array<{ value: AccountScope; labelKey: MsgKey }> = [
  { value: 'normal', labelKey: 'gateways.scope.normal' },
  { value: 'private', labelKey: 'gateways.scope.private' },
  { value: 'all', labelKey: 'gateways.scope.all' },
  { value: 'custom', labelKey: 'gateways.scope.custom' },
];

const CLASS_TAG: Record<'normal' | 'private' | 'unknown', { color: string; labelKey: MsgKey }> = {
  normal: { color: 'green', labelKey: 'labels.class.normal' },
  private: { color: 'orange', labelKey: 'labels.class.private' },
  unknown: { color: 'default', labelKey: 'labels.class.unknown' },
};

/** 新网关的标识：默认模式下用户不用填，自动生成合法 slug。 */
const makeGatewayId = (): string => `gw-${Math.random().toString(36).slice(2, 8)}`;

/** 按 accountOrder 排序；不在 order 里的保持源顺序。 */
const sortNames = (names: string[], order: string[]): string[] => {
  const rank = new Map(order.map((name, i) => [name, i]));
  return [...names].sort((a, b) => (rank.get(a) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b) ?? Number.MAX_SAFE_INTEGER));
};

/**
 * unit: 'seconds' = 存储毫秒、界面按秒显示；'count' = 次数。
 * min/max 是**显示单位**下的边界，必须与 `server/src/config/schema.ts` 的
 * FailoverSchema 一致——否则界面允许输入、保存时才被服务端拒绝。
 */
const FAILOVER_FIELDS: Array<{
  key: keyof FailoverConfig;
  labelKey: MsgKey;
  hintKey: MsgKey;
  unit: 'seconds' | 'count';
  min: number;
  max: number;
}> = [
  {
    key: 'attemptTimeoutMs',
    labelKey: 'gateways.failover.attemptTimeoutMs',
    hintKey: 'gateways.failover.attemptTimeoutMs.hint',
    unit: 'seconds',
    min: 1,
    max: 600,
  },
  {
    key: 'idleTimeoutMs',
    labelKey: 'gateways.failover.idleTimeoutMs',
    hintKey: 'gateways.failover.idleTimeoutMs.hint',
    unit: 'seconds',
    min: 1,
    max: 600,
  },
  {
    key: 'budgetMs',
    labelKey: 'gateways.failover.budgetMs',
    hintKey: 'gateways.failover.budgetMs.hint',
    unit: 'seconds',
    min: 1,
    max: 600,
  },
  {
    key: 'retriesPerChannel',
    labelKey: 'gateways.failover.retriesPerChannel',
    hintKey: 'gateways.failover.retriesPerChannel.hint',
    unit: 'count',
    min: 0,
    max: 5,
  },
  {
    key: 'cooldownMs',
    labelKey: 'gateways.failover.cooldownMs',
    hintKey: 'gateways.failover.cooldownMs.hint',
    unit: 'seconds',
    min: 0,
    max: 3600,
  },
  {
    key: 'retryBackoffMs',
    labelKey: 'gateways.failover.retryBackoffMs',
    hintKey: 'gateways.failover.retryBackoffMs.hint',
    unit: 'seconds',
    min: 0,
    max: 10,
  },
];

/** 编辑抽屉的表单状态。 */
interface Draft {
  /** true = 新建；false = 编辑已有网关 */
  created: boolean;
  id: string;
  name: string;
  port: number;
  bindHost: string;
  /** 留空 = 保持原密钥（控制台拿不到明文） */
  proxyKey: string;
  clearKey: boolean;
  publicBaseUrl: string;
  corsOrigins: string;
  exposeCatalog: boolean;
  accountScope: AccountScope;
  /** 自选范围勾选的账号 */
  accounts: string[];
  /** 顺序 = 粘性优先级 */
  accountOrder: string[];
  accountMode: AccountMode;
  activeAccount: string;
  failover: FailoverConfig;
}

function draftOf(gateway: GatewayView): Draft {
  return {
    created: false,
    id: gateway.id,
    name: gateway.name,
    port: gateway.port,
    bindHost: gateway.bindHost,
    proxyKey: '',
    clearKey: false,
    publicBaseUrl: gateway.publicBaseUrl,
    corsOrigins: gateway.corsOrigins.join('\n'),
    exposeCatalog: gateway.exposeCatalog,
    accountScope: gateway.accountScope,
    accounts: gateway.accounts,
    accountOrder: gateway.accountOrder,
    accountMode: gateway.accountMode,
    activeAccount: gateway.activeAccount,
    failover: gateway.failover,
  };
}

/**
 * 从 3126 起找一个没有被现有网关占用的端口（保存时服务端还会再校验一次）。
 * 3122 = 桌面壳控制通道，3125 = 控制台（独立监听），都要跳过。
 */
function nextFreePort(used: number[], consolePort: number): number {
  const taken = new Set([3122, consolePort, ...used]);
  let port = 3126;
  while (taken.has(port) && port < 65535) port += 1;
  return port;
}

function emptyDraft(usedPorts: number[], consolePort: number): Draft {
  return {
    created: true,
    id: makeGatewayId(),
    name: '',
    port: nextFreePort(usedPorts, consolePort),
    bindHost: '127.0.0.1',
    proxyKey: '',
    clearKey: false,
    publicBaseUrl: '',
    corsOrigins: '',
    exposeCatalog: false,
    accountScope: 'all',
    accounts: [],
    accountOrder: [],
    accountMode: 'sticky',
    activeAccount: '',
    failover: {
      attemptTimeoutMs: 60000,
      idleTimeoutMs: 60000,
      budgetMs: 90000,
      retriesPerChannel: 1,
      cooldownMs: 300000,
      retryBackoffMs: 500,
    },
  };
}

/** 一个网关的列表行。 */
function GatewayRow({
  gateway,
  busy,
  onEdit,
  onToggle,
  onDelete,
}: {
  gateway: GatewayView;
  busy: boolean;
  onEdit: () => void;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const state = STATE_TAG[gateway.status.state];
  return (
    <div className="cps-list-row" data-flip-key={gateway.id}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, width: '100%' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <Typography.Text strong>{gateway.name}</Typography.Text>
            <Tooltip title={gateway.status.error ?? undefined}>
              <Tag color={state.color} style={{ margin: 0 }}>
                {t(state.labelKey)}
                {gateway.status.state === 'running' && gateway.status.boundPort ? ` :${gateway.status.boundPort}` : ''}
              </Tag>
            </Tooltip>
            {gateway.accountState.code === 'empty_scope' && gateway.status.state !== 'disabled' && (
              <Tooltip
                title={t('gateways.accountState.empty_scope.tip', {
                  inScope: gateway.accountState.inScope,
                  total: gateway.accountState.usableTotal,
                })}
              >
                <Tag color="warning" style={{ margin: 0 }}>
                  {t('gateways.accountState.empty_scope')}
                </Tag>
              </Tooltip>
            )}
            {gateway.accountState.code === 'no_accounts' && gateway.status.state !== 'disabled' && (
              <Tooltip title={t('gateways.accountState.no_accounts.tip')}>
                <Tag color="warning" style={{ margin: 0 }}>
                  {t('gateways.accountState.no_accounts')}
                </Tag>
              </Tooltip>
            )}
            {gateway.status.state === 'error' && (
              <Typography.Text type="danger" style={{ fontSize: 12 }} ellipsis={{ tooltip: gateway.status.error }}>
                {gateway.status.error}
              </Typography.Text>
            )}
          </div>
          <Space size={16} wrap>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {gateway.id}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('gateways.accountCount', { count: gateway.accountCount })}
            </Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('gateways.modelCount', { count: gateway.modelCount })}
            </Typography.Text>
            <Typography.Text
              copyable={{ text: gateway.proxyBase, tooltips: [t('gateways.copy.address'), t('common.copied')] }}
            >
              <span className="cps-mono" style={{ fontSize: 12 }}>
                {gateway.proxyBase}
              </span>
            </Typography.Text>
          </Space>
        </div>

        <Space size={6}>
          <Tooltip title={gateway.enabled === false ? t('gateways.action.enable') : t('gateways.action.disable')}>
            <Switch
              size="small"
              checked={gateway.enabled !== false}
              loading={busy}
              aria-label={t('gateways.action.toggle')}
              onChange={(v) => onToggle(v)}
            />
          </Tooltip>
          <Tooltip title={t('gateways.action.edit')}>
            <Button size="small" type="text" icon={<EditOutlined />} aria-label={t('common.edit')} onClick={onEdit} />
          </Tooltip>
          <Popconfirm
            title={t('gateways.delete.title', { name: gateway.name })}
            description={t('gateways.delete.desc')}
            okText={t('common.delete')}
            okButtonProps={{ danger: true }}
            cancelText={t('common.cancel')}
            onConfirm={onDelete}
          >
            <Button
              size="small"
              type="text"
              danger
              icon={<DeleteOutlined />}
              aria-label={t('gateways.action.delete')}
            />
          </Popconfirm>
        </Space>
      </div>
    </div>
  );
}

export default function Gateways() {
  const { t } = useI18n();
  const gateways = useGateways();
  const accounts = useAccounts();
  const meta = useMeta();
  const save = useSaveGateway();
  const remove = useDeleteGateway();
  const fb = useFeedback();
  const [draft, setDraft] = useState<Draft | null>(null);
  /** 默认 / 高级：偏好存本地，切换即时生效。 */
  const [advanced, setAdvanced] = useState(() => localStorage.getItem(ADVANCED_KEY) === '1');

  const list = gateways.data?.gateways ?? [];
  /** 新增/删除网关时，其余行滑到新位置，而不是瞬移。 */
  const listRef = useFlipList<HTMLDivElement>(list.map((g) => g.id).join('|'));
  const consolePort = meta.data?.console.port ?? 3125;
  const maxGateways = gateways.data?.maxGateways ?? 8;
  const hasMain = list.some((g) => g.id === 'main');
  const accountNames = (accounts.data?.accounts ?? []).map((a) => a.name);
  const accountClasses = new Map(
    (accounts.data?.accounts ?? []).map((a) => [a.name, a.classify?.class ?? ('unknown' as const)]),
  );
  const candidatesOf = (scope: AccountScope): string[] =>
    scope === 'normal' || scope === 'private'
      ? accountNames.filter((n) => accountClasses.get(n) === scope)
      : accountNames;
  const orderedCandidates = draft ? sortNames(candidatesOf(draft.accountScope), draft.accountOrder) : [];
  const orderedCustom = draft ? sortNames(draft.accounts, draft.accountOrder) : [];
  const scopeNames = draft?.accountScope === 'custom' ? orderedCustom : orderedCandidates;

  const changeScope = (scope: AccountScope): void => {
    if (!draft) return;
    // 第一次切到「自选」时，把当前范围内的账号作为初始勾选
    const accounts =
      scope === 'custom' && draft.accounts.length === 0 ? candidatesOf(draft.accountScope) : draft.accounts;
    setDraft({ ...draft, accountScope: scope, accounts });
  };

  const moveDraftAccount = (name: string, dir: -1 | 1): void => {
    if (!draft) return;
    const listNames = draft.accountScope === 'custom' ? orderedCustom : orderedCandidates;
    const i = listNames.indexOf(name);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= listNames.length) return;
    const swapped = [...listNames];
    [swapped[i], swapped[j]] = [swapped[j] as string, swapped[i] as string];
    setDraft({ ...draft, accountOrder: swapped });
  };

  const toggleDraftAccount = (name: string, checked: boolean): void => {
    if (!draft) return;
    const next = checked ? [...draft.accounts, name] : draft.accounts.filter((n) => n !== name);
    setDraft({
      ...draft,
      accounts: next,
      accountOrder: checked ? sortNames(next, draft.accountOrder) : draft.accountOrder,
    });
  };

  const submit = (): void => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      fb.fail(t('gateways.validate.name'));
      return;
    }
    const id = draft.id.trim();
    if (draft.created && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(id)) {
      fb.fail(t('gateways.validate.id'), t('gateways.validate.id.current', { id: id || '—' }));
      return;
    }
    if (draft.created && list.some((x) => x.id === id)) {
      fb.fail(t('gateways.validate.id.exists', { id }));
      return;
    }
    if (draft.accountScope === 'custom' && draft.accounts.length === 0) {
      fb.fail(t('gateways.validate.accounts'));
      return;
    }
    const gateway: Record<string, unknown> = {
      id,
      name,
      port: draft.port,
      bindHost: draft.bindHost.trim(),
      publicBaseUrl: draft.publicBaseUrl.trim(),
      corsOrigins: draft.corsOrigins
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
      exposeCatalog: draft.exposeCatalog,
      accountScope: draft.accountScope,
      accounts: draft.accounts,
      accountOrder: scopeNames,
      accountMode: draft.accountMode,
      activeAccount: draft.accountMode === 'single' ? draft.activeAccount : '',
      failover: draft.failover,
    };
    // proxyKey 三态：只有用户真的输入/清除时才带上这个字段
    if (draft.clearKey) gateway['proxyKey'] = null;
    else if (draft.proxyKey.trim()) gateway['proxyKey'] = draft.proxyKey.trim();

    save.mutate(
      {
        gateway,
        created: draft.created,
        note: draft.created ? t('gateways.note.created', { name }) : t('gateways.note.saved', { name }),
      },
      { onSuccess: () => setDraft(null) },
    );
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title={t('gateways.title')}
        desc={t('gateways.desc')}
        actions={
          <Tooltip
            title={list.length >= maxGateways ? t('gateways.create.limit', { max: maxGateways }) : t('gateways.create')}
          >
            <Button
              type="primary"
              icon={<PlusOutlined />}
              disabled={list.length >= maxGateways}
              onClick={() =>
                setDraft(
                  emptyDraft(
                    list.map((g) => g.port),
                    consolePort,
                  ),
                )
              }
            >
              {t('gateways.create')}
            </Button>
          </Tooltip>
        }
      />

      <Panel
        title={t('gateways.list.title')}
        extra={<PanelHint>{t('gateways.list.hint', { count: list.length })}</PanelHint>}
        flush
      >
        {gateways.isError ? (
          <Alert
            type="error"
            showIcon
            style={{ margin: 16 }}
            message={t('gateways.loadFailed')}
            description={t('gateways.loadFailed.desc')}
            action={
              <Button size="small" onClick={() => void gateways.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : gateways.isLoading && !gateways.data ? (
          <div style={{ padding: 16 }}>
            <Skeleton active paragraph={{ rows: 3 }} />
          </div>
        ) : (
          <div ref={listRef} className="cps-fade-in">
            {list.map((gateway) => (
              <GatewayRow
                key={gateway.id}
                gateway={gateway}
                busy={save.isPending || remove.isPending}
                onEdit={() => setDraft(draftOf(gateway))}
                onToggle={(enabled) =>
                  save.mutate({
                    gateway: { id: gateway.id, enabled },
                    note: enabled
                      ? t('gateways.note.enabled', { name: gateway.name })
                      : t('gateways.note.disabled', { name: gateway.name }),
                  })
                }
                onDelete={() => remove.mutate({ id: gateway.id, name: gateway.name })}
              />
            ))}
          </div>
        )}
      </Panel>

      <Drawer
        open={draft !== null}
        width={560}
        title={draft?.created ? t('gateways.drawer.create') : t('gateways.drawer.edit', { name: draft?.name ?? '' })}
        onClose={() => setDraft(null)}
        /* 表单里可能已经填了密钥/端口；点遮罩误关会全部丢失 */
        maskClosable={false}
        destroyOnHidden
        extra={
          <Space>
            <Button onClick={() => setDraft(null)}>{t('common.cancel')}</Button>
            <Button type="primary" loading={save.isPending} onClick={submit}>
              {t('common.save')}
            </Button>
          </Space>
        }
      >
        {draft && (
          <div style={{ display: 'grid', gap: 18 }}>
            <Segmented
              block
              value={advanced ? 'advanced' : 'default'}
              onChange={(v) => {
                const next = v === 'advanced';
                setAdvanced(next);
                localStorage.setItem(ADVANCED_KEY, next ? '1' : '0');
              }}
              options={[
                { value: 'default', label: t('gateways.form.default') },
                { value: 'advanced', label: t('gateways.form.advanced') },
              ]}
            />
            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.name')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input
                  placeholder={t('gateways.field.name.placeholder')}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
            </div>

            {advanced && (
              <div className="cps-field">
                <div className="cps-field-label">
                  <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.id')}</Typography.Text>
                </div>
                <div className="cps-field-body">
                  <Input
                    className="cps-mono"
                    placeholder={t('gateways.field.id.placeholder')}
                    disabled={!draft.created}
                    value={draft.id}
                    onChange={(e) => setDraft({ ...draft, id: e.target.value.toLowerCase() })}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                    {t('gateways.field.id.hint')}
                  </Typography.Text>
                </div>
              </div>
            )}

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.port')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Space size={10} align="center">
                  <InputNumber
                    min={1}
                    max={65535}
                    value={draft.port}
                    onChange={(v) => setDraft({ ...draft, port: Number(v ?? 3124) })}
                    style={{ width: 120 }}
                  />
                  {advanced && (
                    <>
                      <Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>
                        {t('gateways.field.bindHost')}
                      </Typography.Text>
                      <Input
                        value={draft.bindHost}
                        onChange={(e) => setDraft({ ...draft, bindHost: e.target.value })}
                        style={{ width: 150 }}
                      />
                    </>
                  )}
                </Space>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {advanced ? t('gateways.field.port.hint') : t('gateways.field.port.hint.default')}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.key')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Input.Password
                  placeholder={
                    draft.created
                      ? hasMain
                        ? t('gateways.field.key.placeholderInherit')
                        : t('gateways.field.key.placeholderNew')
                      : t('gateways.field.key.placeholderKeep')
                  }
                  value={draft.proxyKey}
                  disabled={draft.clearKey}
                  onChange={(e) => setDraft({ ...draft, proxyKey: e.target.value })}
                />
                <Checkbox
                  style={{ marginTop: 8 }}
                  checked={draft.clearKey}
                  onChange={(e) => setDraft({ ...draft, clearKey: e.target.checked, proxyKey: '' })}
                >
                  {draft.created ? t('gateways.field.key.none') : t('gateways.field.key.clear')}
                </Checkbox>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {advanced ? t('gateways.field.key.hint') : t('gateways.field.key.hint.default')}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.accounts')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Segmented
                  block
                  size="small"
                  value={draft.accountScope}
                  onChange={(v) => changeScope(v as AccountScope)}
                  options={SCOPE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                />
                <div style={{ display: 'grid', gap: 2, marginTop: 10, maxHeight: 230, overflow: 'auto' }}>
                  {(draft.accountScope === 'custom'
                    ? sortNames(accountNames, draft.accountOrder)
                    : orderedCandidates
                  ).map((name, idx) => {
                    const cls = accountClasses.get(name) ?? 'unknown';
                    const tag = CLASS_TAG[cls];
                    const checked = draft.accountScope !== 'custom' || draft.accounts.includes(name);
                    const position = draft.accountScope === 'custom' ? orderedCustom.indexOf(name) : idx;
                    const max = (draft.accountScope === 'custom' ? orderedCustom : orderedCandidates).length - 1;
                    return (
                      <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '3px 0' }}>
                        {draft.accountScope === 'custom' ? (
                          <Checkbox checked={checked} onChange={(e) => toggleDraftAccount(name, e.target.checked)} />
                        ) : (
                          <Typography.Text type="secondary" style={{ fontSize: 12, width: 18, textAlign: 'right' }}>
                            {idx + 1}
                          </Typography.Text>
                        )}
                        <Typography.Text style={{ flex: 1, minWidth: 0 }} ellipsis>
                          {name}
                        </Typography.Text>
                        <Tag color={tag.color} style={{ margin: 0 }}>
                          {t(tag.labelKey)}
                        </Tag>
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowUpOutlined />}
                          disabled={!checked || position <= 0}
                          onClick={() => moveDraftAccount(name, -1)}
                        />
                        <Button
                          size="small"
                          type="text"
                          icon={<ArrowDownOutlined />}
                          disabled={!checked || position < 0 || position >= max}
                          onClick={() => moveDraftAccount(name, 1)}
                        />
                      </div>
                    );
                  })}
                  {(draft.accountScope === 'normal' || draft.accountScope === 'private') &&
                    orderedCandidates.length === 0 && (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {t('gateways.field.accounts.emptyScope')}
                      </Typography.Text>
                    )}
                </div>
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {t('gateways.field.accounts.orderHint')}
                </Typography.Text>
              </div>
            </div>

            <div className="cps-field">
              <div className="cps-field-label">
                <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.mode')}</Typography.Text>
              </div>
              <div className="cps-field-body">
                <Select
                  style={{ width: 280 }}
                  value={draft.accountMode}
                  onChange={(v: AccountMode) => setDraft({ ...draft, accountMode: v })}
                  options={ACCOUNT_MODE_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
                />
                {draft.accountMode === 'single' && (
                  <Select
                    style={{ width: 280, marginTop: 10 }}
                    placeholder={t('gateways.field.mode.placeholder')}
                    value={draft.activeAccount || undefined}
                    onChange={(v: string) => setDraft({ ...draft, activeAccount: v })}
                    options={scopeNames.map((n) => ({ value: n, label: n }))}
                  />
                )}
                <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
                  {t(MODE_HINT[draft.accountMode])}
                </Typography.Text>
              </div>
            </div>

            {advanced && (
              <>
                <div className="cps-field">
                  <div className="cps-field-label">
                    <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.access')}</Typography.Text>
                  </div>
                  <div className="cps-field-body">
                    <Input
                      placeholder={t('gateways.field.publicBase.placeholder')}
                      value={draft.publicBaseUrl}
                      onChange={(e) => setDraft({ ...draft, publicBaseUrl: e.target.value })}
                    />
                    <Input.TextArea
                      rows={2}
                      style={{ marginTop: 8 }}
                      placeholder={t('gateways.field.cors.placeholder')}
                      value={draft.corsOrigins}
                      onChange={(e) => setDraft({ ...draft, corsOrigins: e.target.value })}
                    />
                    <Space size={10} style={{ marginTop: 10 }}>
                      <Switch
                        checked={draft.exposeCatalog}
                        onChange={(v) => setDraft({ ...draft, exposeCatalog: v })}
                      />
                      <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.exposeCatalog')}</Typography.Text>
                    </Space>
                  </div>
                </div>

                <div className="cps-field">
                  <div className="cps-field-label">
                    <Typography.Text style={{ fontSize: 13 }}>{t('gateways.field.failover')}</Typography.Text>
                  </div>
                  <div className="cps-field-body">
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px 18px' }}>
                      {FAILOVER_FIELDS.map((field) => {
                        const seconds = field.unit === 'seconds';
                        const value = seconds ? draft.failover[field.key] / 1000 : draft.failover[field.key];
                        return (
                          <div key={field.key} style={{ display: 'grid', gap: 5, alignContent: 'start' }}>
                            <Typography.Text style={{ fontSize: 13 }}>{t(field.labelKey)}</Typography.Text>
                            <InputNumber
                              min={field.min}
                              max={field.max}
                              step={1}
                              addonAfter={seconds ? t('gateways.unit.seconds') : t('gateways.unit.times')}
                              value={value}
                              onChange={(v) =>
                                setDraft({
                                  ...draft,
                                  failover: {
                                    ...draft.failover,
                                    [field.key]: seconds
                                      ? Math.round(Number(v ?? 0) * 1000)
                                      : Math.round(Number(v ?? 0)),
                                  },
                                })
                              }
                              style={{ width: '100%' }}
                            />
                            <Typography.Text type="secondary" style={{ fontSize: 12, lineHeight: '18px' }}>
                              {t(field.hintKey)}
                            </Typography.Text>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </Drawer>
    </div>
  );
}
