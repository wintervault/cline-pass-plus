import {
  ArrowDownOutlined,
  ArrowUpOutlined,
  DownloadOutlined,
  ExclamationCircleFilled,
  HolderOutlined,
  InfoCircleOutlined,
  SearchOutlined,
  StopOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Card, Checkbox, Input, Skeleton, Space, Tooltip, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { qk, useFetchOfficial, useModels, useProbe, useSaveModelConfig, useTest, useValidate } from '../api/hooks.ts';
import {
  EMPTY_PER_MODEL,
  type ModelMeta,
  type ModelsResponse,
  type PerModelConfig,
  STATUS_RANK,
  type SubscriptionRow,
  type UpstreamStatusKind,
} from '../api/types.ts';
import { DetectionAccountPicker, useDetectionAccount } from '../detectionScope.tsx';
import { EmptyState } from '../emptyState.tsx';
import { diagnosticText } from '../i18n/codes.ts';
import { type Lang, useI18n, useT } from '../i18n/index.tsx';
import { STATUS_TAG } from '../labels.ts';
import { useFlipList } from '../motion.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';
import { RoutingGatewayPicker, useRoutingGateway } from '../routingGateway.tsx';
import { StatusChip } from '../statusChip.tsx';
import { RoutingFields } from './routingFields.tsx';

/** 按校验状态排序的渠道列表（可用优先），供详情面板与测试台共用。 */
export function sortedUpstreams(meta: ModelMeta | null): string[] {
  const statusOf = (u: string): UpstreamStatusKind => meta?.upstreamStatus[u]?.status ?? 'unknown';
  return [...(meta?.upstreams ?? [])].sort((a, b) => (STATUS_RANK[statusOf(a)] ?? 2) - (STATUS_RANK[statusOf(b)] ?? 2));
}

const fmtTime = (ts: number | null | undefined, lang: Lang): string =>
  ts
    ? new Date(ts).toLocaleString(lang, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    : '—';

/**
 * 左侧模型列表项。
 *
 * 版式压到最少行数：**第一行 = 模型 ID + 状态**，第二行只在真有信息时才出现
 * （使用数 / 最近路由）。原来状态永远独占一行，18 个模型里一屏只看得到 4 个。
 */
function ModelItem({
  row,
  prefix,
  active,
  onClick,
}: {
  row: SubscriptionRow;
  /** 列表里所有模型共有的前缀（如 `cline-pass/`）——显示时去掉，完整 ID 进悬停 */
  prefix: string;
  active: boolean;
  onClick: () => void;
}) {
  const { t } = useI18n();
  const meta = row.meta;
  const cfg = row.config ?? EMPTY_PER_MODEL;
  const probed = (meta?.upstreams?.length ?? 0) > 0;
  const ignored = meta?.pinState === 'ignored';
  const hasSecondLine = cfg.upstreams.length > 0 || cfg.exclude.length > 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="cps-ghost"
      style={{
        textAlign: 'left',
        cursor: 'pointer',
        background: active ? 'var(--cps-wash)' : undefined,
        border: 'none',
        borderLeft: active ? '2px solid var(--cps-accent)' : '2px solid transparent',
        borderRadius: 6,
        padding: '9px 10px 9px 8px',
        display: 'grid',
        gap: 5,
        font: 'inherit',
        width: '100%',
        transition: 'background-color var(--cps-duration-fast) var(--cps-ease-standard)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
        <Tooltip title={row.id}>
          <span className="cps-mono cps-cell-ellipsis" style={{ flex: 1, minWidth: 0, color: 'var(--cps-text)' }}>
            {row.id.slice(prefix.length)}
          </span>
        </Tooltip>
        {/* 状态跟着 ID 同行：它是扫读这一列时最需要看到的东西 */}
        {ignored ? (
          <StatusChip tone="danger" small>
            {t('models.tag.ignored')}
          </StatusChip>
        ) : probed ? (
          <span className="cps-meta" style={{ flex: '0 0 auto' }}>
            {t('models.tag.channels', { count: meta?.upstreams?.length ?? 0 })}
          </span>
        ) : (
          <span className="cps-meta" style={{ flex: '0 0 auto' }}>
            {t('models.tag.untested')}
          </span>
        )}
      </div>
      {hasSecondLine && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
          {cfg.upstreams.length > 0 && (
            <StatusChip tone="info" small dot={false}>
              {t('models.tag.using', { count: cfg.upstreams.length })}
            </StatusChip>
          )}
          {cfg.exclude.length > 0 && (
            <StatusChip tone="warn" small dot={false}>
              {t('models.tag.excluded', { count: cfg.exclude.length })}
            </StatusChip>
          )}
        </div>
      )}
    </button>
  );
}

/** 行内拖拽排序的回调集合（状态在父级，跨行共享）。 */
interface RowDragProps {
  isDragging: boolean;
  isDropTarget: boolean;
  onDragStartRow: (order: number) => void;
  onDragOverRow: (order: number) => void;
  onDropRow: (order: number) => void;
  onDragEndRow: () => void;
}

/** 渠道清单的一行：序号 / 渠道 / 状态 / 优先·排除 / 排序。 */
function UpstreamRow({
  upstream,
  cfg,
  meta,
  onSave,
  drag,
}: {
  upstream: string;
  cfg: PerModelConfig;
  meta: ModelMeta | null;
  /** note 是给用户看的回执文案（每类改动说清做了什么） */
  onSave: (patch: Partial<PerModelConfig>, note: string) => void;
  drag: RowDragProps;
}) {
  const { token } = theme.useToken();
  const t = useT();
  const selected = cfg.upstreams.includes(upstream);
  const excluded = cfg.exclude.includes(upstream);
  const order = cfg.upstreams.indexOf(upstream);
  const detail = meta?.upstreamDetail[upstream];
  const status = meta?.upstreamStatus[upstream]?.status;

  const toggleSelect = () => {
    if (selected) {
      onSave(
        { upstreams: cfg.upstreams.filter((x) => x !== upstream) },
        t('models.note.unselected', { name: upstream }),
      );
    } else {
      onSave(
        {
          upstreams: [...cfg.upstreams.filter((x) => !cfg.exclude.includes(x)), upstream],
          exclude: cfg.exclude.filter((x) => x !== upstream),
        },
        t('models.note.selected', {
          index: cfg.upstreams.filter((x) => !cfg.exclude.includes(x)).length + 1,
          name: upstream,
        }),
      );
    }
  };
  const toggleExclude = () => {
    if (excluded) {
      onSave({ exclude: cfg.exclude.filter((x) => x !== upstream) }, t('models.note.unexcluded', { name: upstream }));
    } else {
      onSave(
        { upstreams: cfg.upstreams.filter((x) => x !== upstream), exclude: [...cfg.exclude, upstream] },
        t('models.note.excluded', { name: upstream }),
      );
    }
  };
  const move = (dir: -1 | 1) => {
    const list = [...cfg.upstreams];
    const i = list.indexOf(upstream);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    const a = list[i];
    const b = list[j];
    if (a === undefined || b === undefined) return;
    list[i] = b;
    list[j] = a;
    onSave({ upstreams: list }, t('models.note.moved', { name: upstream, index: j + 1 }));
  };

  return (
    <li
      className={`cps-route-row cps-route-grid${drag.isDragging ? ' cps-dragging' : ''}${drag.isDropTarget ? ' cps-drop-target' : ''}`}
      data-flip-key={upstream}
      data-state={excluded ? 'excluded' : selected ? 'on' : 'off'}
      onDragOver={
        selected
          ? (e) => {
              e.preventDefault();
              drag.onDragOverRow(order);
            }
          : undefined
      }
      onDrop={
        selected
          ? (e) => {
              e.preventDefault();
              drag.onDropRow(order);
            }
          : undefined
      }
    >
      <span
        className="cps-num"
        style={{
          textAlign: 'center',
          color: selected ? 'var(--cps-text)' : 'var(--cps-text-quaternary)',
          fontWeight: selected ? 600 : 400,
        }}
      >
        {selected ? order + 1 : '—'}
      </span>
      {selected ? (
        <button
          type="button"
          className="cps-grip"
          draggable
          aria-label={t('models.upstream.drag.aria')}
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            drag.onDragStartRow(order);
          }}
          onDragEnd={() => drag.onDragEndRow()}
        >
          <HolderOutlined />
        </button>
      ) : (
        <span />
      )}
      <div style={{ minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span
          className="cps-mono"
          style={{ whiteSpace: 'nowrap', color: selected ? 'var(--cps-text)' : 'var(--cps-text-secondary)' }}
        >
          {upstream}
        </span>
        {detail?.name && detail.name.toLowerCase() !== upstream.toLowerCase() && (
          <span className="cps-meta cps-cell-ellipsis">
            {detail.name}
            {detail.endpoints !== undefined && detail.endpoints > 1 ? ` ×${detail.endpoints}` : ''}
          </span>
        )}
      </div>
      <span style={{ justifySelf: 'start' }}>
        {status ? (
          <StatusChip tone={STATUS_TAG[status].tone} small>
            {t(STATUS_TAG[status].labelKey)}
          </StatusChip>
        ) : (
          <span className="cps-meta">{t('labels.upstream.unknown')}</span>
        )}
      </span>
      <Tooltip title={t('models.upstream.use.tip')}>
        <Checkbox
          checked={selected}
          disabled={excluded}
          aria-label={t('models.upstream.use')}
          onChange={toggleSelect}
        />
      </Tooltip>
      {selected ? (
        <Space size={0}>
          <Button
            size="small"
            type="text"
            icon={<ArrowUpOutlined />}
            aria-label={t('models.upstream.moveUp')}
            disabled={order <= 0}
            onClick={() => move(-1)}
          />
          <Button
            size="small"
            type="text"
            icon={<ArrowDownOutlined />}
            aria-label={t('models.upstream.moveDown')}
            disabled={order < 0 || order >= cfg.upstreams.length - 1}
            onClick={() => move(1)}
          />
        </Space>
      ) : (
        <span />
      )}
      <Tooltip title={excluded ? t('models.upstream.unexclude.tip') : t('models.upstream.exclude.tip')}>
        <Button
          size="small"
          type="text"
          icon={<StopOutlined />}
          aria-label={excluded ? t('models.upstream.unexclude.tip') : t('models.upstream.exclude.tip')}
          style={{ color: excluded ? token.colorError : undefined }}
          onClick={toggleExclude}
        />
      </Tooltip>
    </li>
  );
}

export default function Models() {
  /** 检测属于账号；路由配置属于网关（底部「路由策略」区块里的选择器）。 */
  const { gatewayId } = useRoutingGateway();
  const { t, lang } = useI18n();
  const { account: activeAccount, accounts } = useDetectionAccount();

  const models = useModels({ gatewayId, account: activeAccount });
  const qc = useQueryClient();
  const save = useSaveModelConfig(gatewayId);
  const probe = useProbe(activeAccount);
  const validate = useValidate(activeAccount);
  const test = useTest(gatewayId, activeAccount);
  const fetchOfficial = useFetchOfficial(gatewayId);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modelFilter, setModelFilter] = useState('');
  /** 管线拖拽排序：源行/落点行的 upstreams 索引（null = 未拖拽）。 */
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragTo, setDragTo] = useState<number | null>(null);

  // 切换检测账号时把模型选择收回到第一项，避免停留在上一个账号的选择上
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖的用途是「变化时重置」，effect 内不读取它
  useEffect(() => {
    setSelectedId(null);
  }, [activeAccount]);

  const rows = models.data?.subscription ?? [];
  const official = models.data?.officialFetch ?? null;
  const current = rows.find((r) => r.id === selectedId) ?? rows[0] ?? null;
  const filteredRows = rows.filter((r) => !modelFilter || r.id.toLowerCase().includes(modelFilter.toLowerCase()));

  /**
   * 列表里所有模型共有的 `xxx/` 前缀。订阅模型的 ID 全都是同一个前缀
   * （如 `cline-pass/`），列在每一行里纯属噪音、还挤掉了真正的区分部分
   * （「模型显示不全」）。去掉它，完整 ID 仍在悬停与右侧面板标题里。
   */
  const sharedPrefix = (() => {
    if (rows.length === 0) return '';
    const first = rows[0]?.id ?? '';
    const slash = first.indexOf('/');
    if (slash <= 0) return '';
    const candidate = first.slice(0, slash + 1);
    return rows.every((r) => r.id.startsWith(candidate)) ? candidate : '';
  })();

  const saveConfig = (modelId: string, patch: Partial<PerModelConfig>, note: string) => {
    const currentCfg = rows.find((r) => r.id === modelId)?.config ?? EMPTY_PER_MODEL;
    const merged: PerModelConfig = { ...currentCfg, ...patch };
    // 乐观更新：面板立刻反映，onSuccess 的失效会拉回服务端真实状态
    qc.setQueryData<ModelsResponse>(qk.models(gatewayId, activeAccount), (old) =>
      old
        ? { ...old, subscription: old.subscription.map((s) => (s.id === modelId ? { ...s, config: merged } : s)) }
        : old,
    );
    save.mutate({ modelId, config: merged, note });
  };

  // 校验进行中时轮询：服务端每批校验会渐进写入**该账号**的检测记录，2 秒一拉让进度可见
  useEffect(() => {
    if (!validate.isPending) return;
    const timer = setInterval(() => void qc.invalidateQueries({ queryKey: qk.models(gatewayId, activeAccount) }), 2000);
    return () => clearInterval(timer);
  }, [validate.isPending, qc, gatewayId, activeAccount]);

  const cfg = current?.config ?? EMPTY_PER_MODEL;
  const meta = current?.meta ?? null;
  const ups = sortedUpstreams(meta);
  /** 管线渲染顺序：链上（按优先级序号）在前，离线（按状态排序）在后。 */
  const chainRows = [...cfg.upstreams.filter((u) => ups.includes(u)), ...ups.filter((u) => !cfg.upstreams.includes(u))];
  /** 渠道顺序变化（上下移、勾选、拖拽落点）时，让行滑到新位置。 */
  const chainRef = useFlipList<HTMLUListElement>(chainRows.join('|'));
  /** 探测/校验会按健康状态重排观测列表：让行滑过去，而不是瞬移。 */
  const observeRef = useFlipList<HTMLUListElement>(ups.join('|'));
  const pinIgnored = meta?.pinState === 'ignored';
  /** 只有明确确认钉住生效才允许校验——ignored 与 unknown 都会产出不可信的结果。 */
  const pinUnverified = meta?.pinState !== 'enforced';
  const canAct = !!activeAccount;

  const runProbe = (): void => {
    if (!current || !activeAccount) return;
    probe.mutate(current.id);
  };
  const runTest = (): void => {
    if (!current || !activeAccount) return;
    test.mutate({ model: current.id, upstreams: cfg.upstreams, exclude: cfg.exclude });
  };
  const runValidate = (): void => {
    if (!current || !activeAccount) return;
    validate.mutate(current.id);
  };

  /** 拉取官方模型清单（页头按钮与首屏引导共用）。结果回执由 mutation 统一给气泡。 */
  const runFetchOfficial = (): void => {
    fetchOfficial.mutate(undefined);
  };

  /** 账号体检结论标签：检测结果要跟着账号走，页头必须能看见「现在用的是哪个号」。 */
  return (
    /* 填满内容列：两栏吃满剩余高度，路由策略贴底，底部只留内容区内边距。 */
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <PageHeader
        title={t('models.title')}
        desc={t('models.desc')}
        actions={
          <Space size={8}>
            <DetectionAccountPicker label={t('models.account.label')} showClass />
            <Tooltip
              title={
                official
                  ? t('models.official.last', {
                      time: new Date(official.ts).toLocaleString(lang),
                      sources: official.sources.join(' + '),
                      added: official.added.length,
                    })
                  : t('models.official.none')
              }
            >
              <Button icon={<DownloadOutlined />} loading={fetchOfficial.isPending} onClick={runFetchOfficial}>
                {t('models.pull')}
              </Button>
            </Tooltip>
          </Space>
        }
      />

      {accounts.length === 0 ? (
        <Panel title={t('models.noAccount.title')}>
          <EmptyState
            minHeight={220}
            icon={<TeamOutlined />}
            desc={t('models.noAccount.desc')}
            action={
              <Button
                type="primary"
                onClick={() => window.dispatchEvent(new CustomEvent('cps:navigate', { detail: 'accounts' }))}
              >
                {t('models.noAccount.action')}
              </Button>
            }
          />
        </Panel>
      ) : models.isError ? (
        <Alert
          type="error"
          showIcon
          message={t('models.loadFailed')}
          description={t('models.loadFailed.desc')}
          action={
            <Button size="small" onClick={() => void models.refetch()}>
              {t('common.retry')}
            </Button>
          }
        />
      ) : models.isLoading && !models.data ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : rows.length === 0 ? (
        <Card style={{ maxWidth: 560, margin: '48px auto 0' }}>
          <Typography.Title level={5} style={{ marginTop: 0 }}>
            {t('models.onboarding.title')}
          </Typography.Title>
          <div style={{ display: 'grid', gap: 14 }}>
            <Space size={10}>
              <StatusChip tone="neutral" small dot={false}>
                {t('models.onboarding.step', { index: 1 })}
              </StatusChip>
              <Typography.Text>{t('models.onboarding.step1')}</Typography.Text>
              <Button
                size="small"
                onClick={() => window.dispatchEvent(new CustomEvent('cps:navigate', { detail: 'accounts' }))}
              >
                {t('models.onboarding.step1.action')}
              </Button>
            </Space>
            <Space size={10}>
              <StatusChip tone="neutral" small dot={false}>
                {t('models.onboarding.step', { index: 2 })}
              </StatusChip>
              <Typography.Text>{t('models.onboarding.step2')}</Typography.Text>
              <Button size="small" loading={fetchOfficial.isPending} onClick={runFetchOfficial}>
                {t('models.onboarding.step2.action')}
              </Button>
            </Space>
            <Space size={10}>
              <StatusChip tone="neutral" small dot={false}>
                {t('models.onboarding.step', { index: 3 })}
              </StatusChip>
              <Typography.Text type="secondary">{t('models.onboarding.step3')}</Typography.Text>
            </Space>
          </div>
        </Card>
      ) : (
        <>
          {/* 两列主体：吃满剩余高度、各自内部滚动（页面本身不滚） */}
          <div style={{ display: 'flex', gap: 16, flex: '1 1 0', minHeight: 300 }}>
            {/* 左：模型列表 */}
            <Panel
              title={t('models.list.title')}
              extra={<PanelHint>{t('common.count', { count: filteredRows.length })}</PanelHint>}
              style={{ width: 312, flex: '0 0 312px' }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 8 }}>
                <Input
                  prefix={<SearchOutlined />}
                  allowClear
                  placeholder={t('models.list.filter')}
                  value={modelFilter}
                  onChange={(e) => setModelFilter(e.target.value)}
                />
                <div
                  className="cps-model-list-scroll"
                  style={{ flex: 1, minHeight: 0, display: 'grid', gap: 6, alignContent: 'start' }}
                >
                  {filteredRows.map((r) => (
                    <ModelItem
                      key={r.id}
                      row={r}
                      prefix={sharedPrefix}
                      active={current?.id === r.id}
                      onClick={() => setSelectedId(r.id)}
                    />
                  ))}
                  {filteredRows.length === 0 && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('models.list.noMatch')}
                    </Typography.Text>
                  )}
                </div>
              </div>
            </Panel>

            {/* 右：所选账号在该模型上的真实渠道观测（只读；路由在下方区块编辑） */}
            {current && (
              <Panel
                /* 只有当前模型的探测才显示扫描线：切到别的模型时不该继续「假装在探测」 */
                className={probe.isPending && probe.variables === current.id ? 'cps-scanning' : undefined}
                style={{ flex: 1, minWidth: 0 }}
                title={
                  <Typography.Text
                    code
                    style={{
                      fontSize: 13,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                    copyable={{ text: current.id, tooltips: [t('models.detail.copyId'), t('common.copied')] }}
                  >
                    {current.id}
                  </Typography.Text>
                }
                extra={
                  <Space size={8}>
                    <Tooltip title={t('models.action.probe.tip')}>
                      <Button
                        size="small"
                        type="primary"
                        disabled={!canAct}
                        loading={probe.isPending}
                        onClick={runProbe}
                      >
                        {t('models.action.probe')}
                      </Button>
                    </Tooltip>
                    <Tooltip title={t('models.action.test.tip')}>
                      <Button size="small" disabled={!canAct} loading={test.isPending} onClick={runTest}>
                        {t('models.action.test')}
                      </Button>
                    </Tooltip>
                    <Tooltip
                      title={
                        pinUnverified
                          ? t(
                              pinIgnored
                                ? 'models.action.validate.tip.ignored'
                                : 'models.action.validate.tip.unverified',
                            )
                          : t('models.action.validate.tip', { count: ups.length })
                      }
                    >
                      <Button
                        size="small"
                        disabled={!canAct || pinUnverified || ups.length === 0}
                        loading={validate.isPending}
                        onClick={runValidate}
                      >
                        {validate.isPending ? t('models.action.validating') : t('models.action.validate')}
                      </Button>
                    </Tooltip>
                  </Space>
                }
              >
                <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, gap: 10 }}>
                  {pinIgnored && (
                    <Tooltip
                      title={
                        meta?.lastProvider
                          ? `${t('models.pin.ignored.tip')} ${t('models.pin.ignored.routed', { provider: meta.lastProvider })}`
                          : t('models.pin.ignored.tip')
                      }
                    >
                      <div className="cps-notice cps-notice-warn cps-notice-center">
                        <ExclamationCircleFilled />
                        <span>{t('models.pin.ignored.notice')}</span>
                      </div>
                    </Tooltip>
                  )}

                  {/* 元信息行：自由折行，窄窗口下自动换行而不互相挤压 */}
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 28px', fontSize: 12 }}>
                    {meta?.pipeline && (
                      <span>
                        <Typography.Text type="secondary">{t('models.meta.pipeline')} </Typography.Text>
                        {meta.pipeline === 'planner' ? t('models.pipeline.planner') : t('models.pipeline.direct')}
                      </span>
                    )}
                    {meta?.canonicalSlug && (
                      <span>
                        <Typography.Text type="secondary">{t('models.meta.canonical')} </Typography.Text>
                        <Typography.Text code style={{ fontSize: 12 }}>
                          {meta.canonicalSlug}
                        </Typography.Text>
                      </span>
                    )}
                    {meta?.lastProvider && (
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Typography.Text type="secondary">{t('models.meta.lastHit')} </Typography.Text>
                        <span className="cps-mono">{meta.lastProvider}</span>
                        {meta.lastMs ? (
                          <Typography.Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
                            {meta.lastMs}ms
                          </Typography.Text>
                        ) : null}
                      </span>
                    )}
                    {meta?.tier0?.length ? (
                      <span>
                        <Typography.Text type="secondary">{t('models.meta.tier0')} </Typography.Text>
                        {meta.tier0.join(t('models.meta.listSeparator'))}
                      </span>
                    ) : null}
                    <span>
                      <Typography.Text type="secondary">{t('models.meta.probed')} </Typography.Text>
                      {fmtTime(meta?.probedAt, lang)}
                      {meta?.validatedAt ? (
                        <>
                          <Typography.Text type="secondary">{t('models.meta.validated')} </Typography.Text>
                          {fmtTime(meta.validatedAt, lang)}
                        </>
                      ) : null}
                    </span>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
                    <Typography.Text strong style={{ fontSize: 13 }}>
                      {t('models.observe.title')}
                    </Typography.Text>
                    <PanelHint>{t('models.chain.count', { count: ups.length })}</PanelHint>
                    {activeAccount && <PanelHint>{t('models.observe.forAccount', { name: activeAccount })}</PanelHint>}
                    <Tooltip title={t('models.observe.footer')}>
                      <InfoCircleOutlined style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 13 }} />
                    </Tooltip>
                  </div>

                  <div style={{ flex: 1, minHeight: 0, overflow: 'auto', overscrollBehavior: 'contain' }}>
                    {ups.length ? (
                      <>
                        <div className="cps-observe-head cps-observe-grid">
                          <span className="cps-label">{t('models.col.channel')}</span>
                          <span className="cps-label">{t('models.col.state')}</span>
                          <span className="cps-label" style={{ textAlign: 'right' }}>
                            {t('models.col.latency')}
                          </span>
                          <span className="cps-label" style={{ textAlign: 'right' }}>
                            {t('models.col.route')}
                          </span>
                        </div>
                        <ul className="cps-observe" ref={observeRef}>
                          {ups.map((u) => {
                            const s = meta?.upstreamStatus[u];
                            const detail = meta?.upstreamDetail[u];
                            const order = cfg.upstreams.indexOf(u);
                            const excluded = cfg.exclude.includes(u);
                            const state = excluded ? 'excluded' : order >= 0 ? 'on' : 'off';
                            const tone = s ? STATUS_TAG[s.status].tone : 'neutral';
                            return (
                              <li
                                key={u}
                                className="cps-observe-row cps-observe-grid"
                                data-flip-key={u}
                                data-state={state}
                              >
                                <Tooltip
                                  title={[
                                    u,
                                    detail?.name,
                                    detail?.context
                                      ? t('playground.channel.context', { k: Math.round(detail.context / 1000) })
                                      : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                >
                                  <div className="cps-observe-channel">
                                    <span className={`cps-dot cps-dot-${tone}`} aria-hidden />
                                    <span className="cps-mono cps-cell-ellipsis" style={{ minWidth: 0 }}>
                                      {u}
                                    </span>
                                    {detail?.name && detail.name.toLowerCase() !== u.toLowerCase() && (
                                      <span className="cps-meta cps-cell-ellipsis" style={{ flex: '0 1 auto' }}>
                                        {detail.name}
                                        {detail.endpoints !== undefined && detail.endpoints > 1
                                          ? ` ×${detail.endpoints}`
                                          : ''}
                                      </span>
                                    )}
                                  </div>
                                </Tooltip>
                                <span>
                                  {s ? (
                                    <Tooltip title={diagnosticText(lang, s.note) || undefined}>
                                      <span>
                                        <StatusChip tone={tone} small dot={false}>
                                          {t(STATUS_TAG[s.status].labelKey)}
                                        </StatusChip>
                                      </span>
                                    </Tooltip>
                                  ) : (
                                    <span className="cps-meta">{t('labels.upstream.unknown')}</span>
                                  )}
                                </span>
                                <span
                                  className="cps-num"
                                  style={{ textAlign: 'right', color: 'var(--cps-text-tertiary)' }}
                                >
                                  {s?.ms != null ? `${s.ms} ms` : '—'}
                                </span>
                                <span className="cps-meta" style={{ textAlign: 'right' }}>
                                  {state === 'on'
                                    ? t('models.observe.inRoute')
                                    : state === 'excluded'
                                      ? t('models.observe.excluded')
                                      : t('models.observe.notUsed')}
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    ) : (
                      /* 面板内的空：一句说明就够，不再放插画式 Empty——
                         它在这个高度里比正片还重，而且和全站的空状态是两套语言 */
                      <div style={{ display: 'grid', placeItems: 'center', padding: '28px 16px' }}>
                        <span className="cps-meta" style={{ maxWidth: 380, textAlign: 'center', textWrap: 'pretty' }}>
                          {!activeAccount
                            ? t('models.observe.noAccount')
                            : pinIgnored
                              ? t('models.chain.emptyIgnored')
                              : t('models.observe.empty')}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </Panel>
            )}
          </div>

          {/*
            路由策略：属于网关，不属于账号。通道编辑器与「所属网关」选择器放在同一块，
            避免用户在账号视图里误以为钉住是账号级配置。
          */}
          {current && (
            <Panel
              title={t('models.routing.title')}
              extra={
                <Space size={8} align="center">
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {t('models.routing.gateway')}
                  </Typography.Text>
                  <RoutingGatewayPicker />
                  <PanelHint>{t('models.routing.hint')}</PanelHint>
                </Space>
              }
            >
              <div style={{ display: 'grid', gap: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    {t('models.chain.title')}
                  </Typography.Text>
                  <PanelHint>{t('models.chain.count', { count: ups.length })}</PanelHint>
                  <Tooltip title={t('models.chain.footer')}>
                    <InfoCircleOutlined style={{ color: 'var(--ant-color-text-tertiary)', fontSize: 13 }} />
                  </Tooltip>
                  <Space size={8} style={{ marginLeft: 'auto' }}>
                    <Button
                      size="small"
                      onClick={() => {
                        const list = ups.filter((u) => !cfg.exclude.includes(u));
                        saveConfig(
                          current.id,
                          { upstreams: list, exclude: cfg.exclude },
                          t('models.note.allAdded', { count: list.length }),
                        );
                      }}
                    >
                      {t('models.chain.all')}
                    </Button>
                    <Button
                      size="small"
                      onClick={() => saveConfig(current.id, { upstreams: [], exclude: [] }, t('models.note.cleared'))}
                    >
                      {t('models.chain.clear')}
                    </Button>
                  </Space>
                </div>

                <div style={{ maxHeight: 170, overflow: 'auto', overscrollBehavior: 'contain' }}>
                  {chainRows.length ? (
                    <>
                      <div className="cps-route-head cps-route-grid">
                        <span className="cps-label" style={{ textAlign: 'center' }}>
                          #
                        </span>
                        <span />
                        <span className="cps-label">{t('models.col.channel')}</span>
                        <span className="cps-label">{t('models.col.state')}</span>
                        <span className="cps-label" style={{ textAlign: 'center' }}>
                          {t('models.col.use')}
                        </span>
                        <span className="cps-label" style={{ textAlign: 'center' }}>
                          {t('models.col.move')}
                        </span>
                        <span />
                      </div>
                      <ul className="cps-route" ref={chainRef}>
                        {chainRows.map((u) => {
                          const rowOrder = cfg.upstreams.indexOf(u);
                          return (
                            <UpstreamRow
                              key={u}
                              upstream={u}
                              cfg={cfg}
                              meta={meta}
                              onSave={(patch, note) => saveConfig(current.id, patch, note)}
                              drag={{
                                isDragging: dragFrom !== null && dragFrom === rowOrder,
                                isDropTarget: dragTo !== null && dragTo === rowOrder && dragFrom !== rowOrder,
                                onDragStartRow: (o) => setDragFrom(o),
                                onDragOverRow: (o) => setDragTo((cur) => (cur === o ? cur : o)),
                                onDropRow: (o) => {
                                  if (dragFrom !== null && dragFrom !== o) {
                                    const list = [...cfg.upstreams];
                                    const [item] = list.splice(dragFrom, 1);
                                    if (item) {
                                      list.splice(o, 0, item);
                                      saveConfig(
                                        current.id,
                                        { upstreams: list },
                                        t('models.note.dragged', { name: item, index: o + 1 }),
                                      );
                                    }
                                  }
                                  setDragFrom(null);
                                  setDragTo(null);
                                },
                                onDragEndRow: () => {
                                  setDragFrom(null);
                                  setDragTo(null);
                                },
                              }}
                            />
                          );
                        })}
                      </ul>
                    </>
                  ) : (
                    <div className="cps-notice">
                      <span>{pinIgnored ? t('models.chain.emptyIgnored') : t('models.chain.empty')}</span>
                    </div>
                  )}
                </div>
                <RoutingFields cfg={cfg} onChange={(patch, note) => saveConfig(current.id, patch, note)} />
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}
