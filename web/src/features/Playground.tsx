import {
  CopyOutlined,
  ExclamationCircleFilled,
  InfoCircleOutlined,
  PlayCircleOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  InputNumber,
  Select,
  Space,
  Switch,
  Table,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';

import { useModels, useSaveModelConfig, useTest } from '../api/hooks.ts';
import {
  EMPTY_PER_MODEL,
  type ModelMeta,
  type PerModelConfig,
  type TestResult,
  type TraceEntry,
} from '../api/types.ts';
import { DetectionAccountPicker, useDetectionAccount } from '../detectionScope.tsx';
import { useFeedback } from '../feedback.ts';
import { codeText, diagnosticText } from '../i18n/codes.ts';
import { useI18n } from '../i18n/index.tsx';
import { STATUS_TAG } from '../labels.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';
import { RoutingGatewayPicker, useRoutingGateway } from '../routingGateway.tsx';
import { StatusChip } from '../statusChip.tsx';
import { RoutingFields } from './routingFields.tsx';

/**
 * 当前路由策略面板。
 *
 * 测试台要回答的问题是「这个模型现在会怎么走」——钉住模式、渠道顺序、每个
 * 候选的可用性必须和「发送测试」同屏可见，否则测完还得滚回去对答案。
 * 改动即时保存（与订阅模型页同一套配置，改哪边都生效）。
 */
function RoutingPanel({ model, cfg, meta }: { model: string; cfg: PerModelConfig; meta: ModelMeta | null }) {
  const { gatewayId } = useRoutingGateway();
  const { t, lang } = useI18n();
  const save = useSaveModelConfig(gatewayId);

  const patch = (next: Partial<PerModelConfig>, note: string): void => {
    save.mutate({ modelId: model, config: { ...cfg, ...next }, note });
  };

  /**
   * 参与路由的顺序在前；被排除的渠道排在后面（enabled=false）——否则在测试台
   * 关掉一个渠道后它就从表里消失，再也无法在这里重新启用。
   */
  const disabled = cfg.exclude.filter((n) => !cfg.upstreams.includes(n));
  const rows = [
    ...cfg.upstreams.map((name, i) => ({
      key: name,
      index: (i + 1) as number | null,
      name,
      status: meta?.upstreamStatus?.[name],
      detail: meta?.upstreamDetail?.[name],
      enabled: true,
    })),
    ...disabled.map((name) => ({
      key: name,
      index: null as number | null,
      name,
      status: meta?.upstreamStatus?.[name],
      detail: meta?.upstreamDetail?.[name],
      enabled: false,
    })),
  ];

  return (
    <Panel
      title={
        <Space size={8}>
          <SettingOutlined />
          <span>{t('playground.routing.title')}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            {cfg.pinMode === 'strict' ? t('playground.routing.strict') : t('playground.routing.preferred')}
          </Typography.Text>
        </Space>
      }
      extra={
        <Space size={8} align="center">
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {t('playground.routing.gateway')}
          </Typography.Text>
          <RoutingGatewayPicker />
        </Space>
      }
    >
      <RoutingFields cfg={cfg} onChange={patch} />
      {rows.length === 0 ? (
        <div className="cps-notice" style={{ marginTop: 12 }}>
          <ExclamationCircleFilled style={{ color: 'var(--cps-warn-fg)' }} />
          <span>
            {(meta?.upstreams?.length ?? 0) > 0 ? t('playground.routing.empty') : t('playground.routing.emptyNoProbe')}
          </span>
          {(meta?.upstreams?.length ?? 0) > 0 && (
            <Button
              size="small"
              type="link"
              style={{ paddingInline: 2, height: 'auto' }}
              onClick={() =>
                patch(
                  { upstreams: [...(meta?.upstreams ?? [])], exclude: [] },
                  t('playground.note.useProbed', { count: meta?.upstreams?.length ?? 0 }),
                )
              }
            >
              {t('playground.routing.useProbed')}
            </Button>
          )}
        </div>
      ) : (
        <Table
          size="small"
          rowKey="key"
          pagination={false}
          dataSource={rows}
          columns={[
            {
              title: t('playground.col.order'),
              width: 64,
              align: 'center',
              render: (_, r) => (
                <Typography.Text
                  type={r.enabled ? undefined : 'secondary'}
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {r.index ?? '—'}
                </Typography.Text>
              ),
            },
            {
              title: t('playground.col.channel'),
              dataIndex: 'name',
              align: 'center',
              render: (v: string, r) => (
                <Space size={6}>
                  <Typography.Text
                    code
                    copyable={{ text: v, tooltips: [t('playground.copyChannel'), t('common.copied')] }}
                    style={r.enabled ? undefined : { opacity: 0.5 }}
                  >
                    {v}
                  </Typography.Text>
                  {r.detail?.context ? (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {t('playground.channel.context', { k: Math.round(r.detail.context / 1000) })}
                    </Typography.Text>
                  ) : null}
                </Space>
              ),
            },
            {
              title: t('playground.col.health'),
              width: 130,
              align: 'center',
              render: (_, r) => {
                const s = r.status;
                if (!s) return <Typography.Text type="secondary">{t('labels.upstream.unknown')}</Typography.Text>;
                const tag = STATUS_TAG[s.status];
                return (
                  <Tooltip title={diagnosticText(lang, s.note) || undefined}>
                    <span>
                      <StatusChip tone={tag.tone} small>
                        {t(tag.labelKey)}
                      </StatusChip>
                    </span>
                  </Tooltip>
                );
              },
            },
            {
              title: t('playground.col.lastMs'),
              width: 104,
              align: 'center',
              /* 来自「校验渠道」的实测往返（那是小请求，只用于渠道之间的相对比较）。
                 以前这里恒为「—」——列头写着耗时却没有数据，等于没有这一列。 */
              render: (_, r) =>
                r.status?.ms != null ? (
                  <Typography.Text className="cps-num">{r.status.ms} ms</Typography.Text>
                ) : (
                  <Typography.Text type="secondary">—</Typography.Text>
                ),
            },
            {
              title: t('playground.col.enabled'),
              width: 88,
              align: 'center',
              render: (_, r) => (
                <Switch
                  size="small"
                  checked={r.enabled}
                  loading={save.isPending}
                  onChange={(v) =>
                    patch(
                      v
                        ? {
                            upstreams: [...cfg.upstreams.filter((x) => x !== r.name), r.name],
                            exclude: cfg.exclude.filter((x) => x !== r.name),
                          }
                        : {
                            upstreams: cfg.upstreams.filter((x) => x !== r.name),
                            exclude: [...cfg.exclude.filter((x) => x !== r.name), r.name],
                          },
                      v
                        ? t('playground.note.enabled', { name: r.name })
                        : t('playground.note.excluded', { name: r.name }),
                    )
                  }
                />
              ),
            },
          ]}
        />
      )}
    </Panel>
  );
}

function TraceTable({ trace, targets }: { trace?: TraceEntry[]; targets: string[] }) {
  const { t } = useI18n();
  const list = trace ?? [];
  if (!list.length) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {targets.length
          ? t('playground.trace.emptyTargets', { targets: targets.join(' → ') })
          : t('playground.trace.empty')}
      </Typography.Text>
    );
  }
  return (
    <Table<TraceEntry>
      className="cps-table-center cps-trace-in"
      size="small"
      rowKey={(r, i) => `${r.upstream ?? 'auto'}-${i}`}
      pagination={false}
      dataSource={list}
      columns={[
        {
          title: t('playground.col.order'),
          width: 64,
          render: (_, __, i) => (
            <Typography.Text type="secondary" className="cps-num">
              {i + 1}
            </Typography.Text>
          ),
        },
        {
          title: t('playground.col.channel'),
          dataIndex: 'upstream',
          render: (v: string | null) =>
            v ? (
              <span className="cps-mono">{v}</span>
            ) : (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('playground.trace.auto')}
              </Typography.Text>
            ),
        },
        {
          title: t('playground.col.result'),
          width: 120,
          render: (_, r) => (
            <Badge status={r.status === 200 ? 'success' : 'error'} text={t('playground.http', { status: r.status })} />
          ),
        },
        {
          title: t('playground.col.lastMs'),
          width: 100,
          render: (_, r) => <Typography.Text className="cps-num">{r.ms} ms</Typography.Text>,
        },
        {
          title: t('playground.col.note'),
          dataIndex: 'note',
          render: (v: string) =>
            v ? (
              <span className="cps-cell-ellipsis" style={{ fontSize: 12 }}>
                {v}
              </span>
            ) : (
              <Typography.Text type="secondary">—</Typography.Text>
            ),
        },
      ]}
    />
  );
}

export default function Playground() {
  const { gatewayId } = useRoutingGateway();
  const { t } = useI18n();
  const { account: activeAccount } = useDetectionAccount();
  const models = useModels({ gatewayId, account: activeAccount });
  const test = useTest(gatewayId, activeAccount);
  const fb = useFeedback();
  const [model, setModel] = useState('');
  const [upstream, setUpstream] = useState('');
  const [maxTokens, setMaxTokens] = useState(256);
  const [result, setResult] = useState<TestResult | null>(null);
  /** 每次测试递增：尝试链以新表挂载，才能按执行顺序重新逐行落定。 */
  const [runSeq, setRunSeq] = useState(0);

  const rows = models.data?.subscription ?? [];
  const active = rows.some((r) => r.id === model) ? model : (rows[0]?.id ?? '');
  const activeRow = rows.find((r) => r.id === active);
  const cfg: PerModelConfig = activeRow?.config ?? EMPTY_PER_MODEL;

  // 切换账号或路由网关时清掉上一组选择与结果：结果只对执行它的账号成立。
  // biome-ignore lint/correctness/useExhaustiveDependencies: 依赖的用途是「变化时重置」，effect 内不读取它们
  useEffect(() => {
    setModel('');
    setUpstream('');
    setResult(null);
  }, [activeAccount, gatewayId]);

  const upstreamOptions = [
    { value: '', label: t('playground.field.channel.auto') },
    // 先列路由清单，再补该账号探测到、但还没加入路由的渠道：
    // 用户可以先测试一个候选渠道，再决定要不要钉它。
    ...[...new Set([...cfg.upstreams, ...(activeRow?.meta?.upstreams ?? [])])].map((u) => ({ value: u, label: u })),
  ];

  const run = (): void => {
    if (!active) {
      fb.fail(t('playground.validate.key'));
      return;
    }
    if (!activeAccount) {
      fb.fail(t('playground.validate.account'));
      return;
    }
    // 成功/失败的回执由 useTest 统一给出，这里只负责把结果放进结果区
    test.mutate(
      { model: active, upstreams: upstream ? [upstream] : [], exclude: [] },
      {
        onSuccess: (r) => {
          setResult(r);
          setRunSeq((n) => n + 1);
        },
      },
    );
  };

  const hit =
    result?.ok &&
    (!result.targets.length || result.actual === result.targets[0] || result.actualName === result.targets[0]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, height: '100%' }}>
      <PageHeader
        title={t('playground.title')}
        desc={t('playground.desc')}
        actions={<DetectionAccountPicker label={t('playground.account.label')} />}
      />

      <Panel title={t('playground.params.title')} extra={<PanelHint>{t('playground.params.hint')}</PanelHint>}>
        <Space wrap size={16} align="center">
          <Space size={6} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('playground.field.model')}
            </Typography.Text>
            <Select
              showSearch
              /* 250 / 180 / 96 是按**英文界面**量的：这一行的控件在 890 宽的内容列里
                 必须排成一行（折行 = 凭空长高 48px）。英文标签比中文长，
                 改宽度或文案前先把窗口缩到 1170 复测。 */
              style={{ width: 250, fontFamily: 'var(--cps-font-mono)' }}
              placeholder={t('playground.field.model.placeholder')}
              value={active || undefined}
              onChange={(v) => {
                setModel(v);
                setUpstream('');
                setResult(null);
              }}
              options={rows.map((r) => ({ value: r.id, label: r.id }))}
            />
          </Space>
          <Space size={6} align="center">
            <Typography.Text type="secondary" style={{ fontSize: 13 }}>
              {t('playground.field.channel')}
            </Typography.Text>
            <Select style={{ width: 190 }} value={upstream} onChange={setUpstream} options={upstreamOptions} />
          </Space>
          <Space size={6} align="center">
            <Tooltip title={t('playground.field.maxTokens.tip')}>
              <Typography.Text type="secondary" style={{ fontSize: 13 }}>
                {t('playground.field.maxTokens')}
              </Typography.Text>
            </Tooltip>
            <InputNumber
              min={16}
              max={4096}
              step={64}
              value={maxTokens}
              onChange={(v) => setMaxTokens(v ?? 256)}
              style={{ width: 96 }}
            />
          </Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            loading={test.isPending}
            disabled={!activeAccount}
            onClick={run}
            style={{ marginLeft: 'auto' }}
          >
            {t('playground.send')}
          </Button>
        </Space>
      </Panel>

      {active && <RoutingPanel model={active} cfg={cfg} meta={activeRow?.meta ?? null} />}

      {/* 结果区：始终在位（空态也属于这块区域），避免「点完才长出一块」的跳动。
          它吃满剩余高度——结果区是这一页的终点，空着也应该是一块完整的区域。 */}
      <Panel
        style={{ flex: '1 1 auto', minHeight: 140 }}
        bodyStyle={!result ? { display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}
        title={
          result ? (
            <Space size={8}>
              {result.ok ? (
                <StatusChip tone="ok" small>
                  {t('playground.result.success')}
                </StatusChip>
              ) : (
                <StatusChip tone="danger" small>
                  {t('playground.result.failed')}
                </StatusChip>
              )}
              <Typography.Text code style={{ fontSize: 13 }}>
                {active}
              </Typography.Text>
              {result.ok && (
                <StatusChip tone={hit ? 'ok' : 'warn'} small dot={false}>
                  {hit ? t('playground.result.hit') : t('playground.result.miss')}
                </StatusChip>
              )}
              {result.degraded && (
                <Tooltip title={t('playground.result.degraded.tip')}>
                  <span>
                    <StatusChip tone="warn" small>
                      {t('playground.result.degraded')}
                    </StatusChip>
                  </span>
                </Tooltip>
              )}
            </Space>
          ) : (
            <span>{t('playground.result.title')}</span>
          )
        }
        extra={
          result ? (
            <Tooltip title={t('playground.result.copy.tip')}>
              <Button
                size="small"
                type="text"
                icon={<CopyOutlined />}
                aria-label={t('playground.result.copy')}
                onClick={() =>
                  void navigator.clipboard.writeText(JSON.stringify(result, null, 2)).then(
                    () => fb.copy(t('playground.result.title')),
                    () => fb.fail(t('common.copyFailed'), t('common.clipboardUnavailable')),
                  )
                }
              />
            </Tooltip>
          ) : undefined
        }
      >
        {!result ? (
          /* 空态是一块安静的「目的地」：一个图标、一句标题、一句怎么做。
             不占满、不插图，也不在点完之后才长出这一块。 */
          <div style={{ display: 'grid', justifyItems: 'center', gap: 6, textAlign: 'center', padding: '28px 0' }}>
            <InfoCircleOutlined style={{ fontSize: 20, color: 'var(--cps-text-quaternary)', marginBottom: 2 }} />
            <span className="cps-body" style={{ color: 'var(--cps-text-secondary)', fontWeight: 500 }}>
              {t('playground.result.emptyTitle')}
            </span>
            <span className="cps-meta" style={{ maxWidth: 460 }}>
              {t('playground.result.empty')}
            </span>
          </div>
        ) : !result.ok ? (
          <Alert
            type="error"
            showIcon
            message={t('playground.result.error', {
              error: codeText(t, result.code) || result.error || t('playground.result.unknownError'),
            })}
          />
        ) : (
          <div style={{ display: 'grid', gap: 16 }}>
            <Descriptions
              size="small"
              column={3}
              items={[
                {
                  key: 'actual',
                  label: t('playground.desc.actual'),
                  children: result.actual ?? result.actualName ?? '—',
                },
                {
                  key: 'ms',
                  label: t('playground.desc.ms'),
                  children: result.ms != null ? t('common.ms', { value: result.ms }) : '—',
                },
                { key: 'account', label: t('playground.desc.account'), children: result.account ?? '—' },
                {
                  key: 'targets',
                  label: t('playground.desc.targets'),
                  children: result.targets.length ? result.targets.join(' → ') : t('playground.desc.targets.auto'),
                },
                {
                  key: 'pipeline',
                  label: t('playground.desc.pipeline'),
                  children: result.pipeline ? `/${result.pipeline}` : t('playground.desc.pipeline.unknown'),
                },
                {
                  key: 'pin',
                  label: t('playground.desc.pinnable'),
                  children:
                    result.pinnable == null
                      ? t('playground.desc.unknown')
                      : result.pinnable
                        ? t('playground.desc.yes')
                        : t('playground.desc.no'),
                },
              ]}
            />
            {result.content && (
              <div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {t('playground.content')}
                </Typography.Text>
                <pre className="cps-pre">{result.content}</pre>
              </div>
            )}
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {t('playground.trace')}
              </Typography.Text>
              <div style={{ marginTop: 6 }}>
                <TraceTable key={runSeq} trace={result.trace} targets={result.targets} />
              </div>
            </div>
          </div>
        )}
      </Panel>
    </div>
  );
}
