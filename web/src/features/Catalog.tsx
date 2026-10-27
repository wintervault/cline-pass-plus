import { SearchOutlined } from '@ant-design/icons';
import { Alert, App, Button, Empty, Input, Skeleton, Space, Table, Tooltip, Typography } from 'antd';
import { useState } from 'react';

import { useModels, useProbe } from '../api/hooks.ts';
import type { PinState, Pipeline } from '../api/types.ts';
import { DetectionAccountPicker, useDetectionAccount } from '../detectionScope.tsx';
import { useI18n } from '../i18n/index.tsx';
import { PageHeader } from '../pageHeader.tsx';
import { Panel } from '../panel.tsx';
import { StatusChip } from '../statusChip.tsx';

/** 本页探测的结果（失败也留痕）。目录模型多半不在订阅清单里，结果就地展示，不再「存了却无处可看」。 */
interface ProbeOutcome {
  ok: boolean;
  error?: string;
  pipeline?: Pipeline | null;
  upstreams?: string[];
  pinState?: PinState;
}

/** 探测结果标签：管线 + **探测到的渠道名**。
 *  只显示「2 渠道」等于没说——用户探测就是为了知道背后是哪几个渠道。 */
function ProbeTags({ p }: { p: ProbeOutcome }) {
  const { t } = useI18n();
  if (!p.ok) {
    return (
      <Tooltip title={p.error}>
        <span>
          <StatusChip tone="danger" small>
            {t('catalog.probe.failed')}
          </StatusChip>
        </span>
      </Tooltip>
    );
  }
  const ups = p.upstreams ?? [];
  const shown = ups.slice(0, 3);
  return (
    <Space size={4} wrap>
      <StatusChip tone="info" small dot={false}>
        {p.pipeline === 'planner' ? t('models.pipeline.planner') : t('models.pipeline.direct')}
      </StatusChip>
      {shown.map((u) => (
        <StatusChip key={u} tone="neutral" small dot={false}>
          <span className="cps-mono">{u}</span>
        </StatusChip>
      ))}
      {ups.length > shown.length && (
        <Tooltip title={ups.join(t('models.meta.listSeparator'))}>
          <span>
            <StatusChip tone="neutral" small dot={false}>
              +{ups.length - shown.length}
            </StatusChip>
          </span>
        </Tooltip>
      )}
      {ups.length === 0 && (
        <StatusChip tone="neutral" small dot={false}>
          {t('catalog.noChannel')}
        </StatusChip>
      )}
      {p.pinState === 'ignored' && (
        <Tooltip title={t('catalog.pinIgnored.tip')}>
          <span>
            <StatusChip tone="warn" small>
              {t('models.tag.ignored')}
            </StatusChip>
          </span>
        </Tooltip>
      )}
    </Space>
  );
}

export default function Catalog() {
  const { message } = App.useApp();
  const { t } = useI18n();
  // 目录是全局的；探测结论属于**账号**（按账号隔离，换号结果可能不同）
  const { account: activeAccount } = useDetectionAccount();
  const models = useModels({ account: activeAccount });
  const probe = useProbe(activeAccount);
  const [filter, setFilter] = useState('');
  const [probes, setProbes] = useState<Record<string, ProbeOutcome>>({});

  const catalog = models.data?.catalog ?? [];
  const matched = catalog.filter((id) => !filter || id.toLowerCase().includes(filter.toLowerCase()));
  const filtered = matched.slice(0, 400);

  const runProbe = (id: string): void => {
    probe.mutate(id, {
      onSuccess: (r) => {
        setProbes((prev) => ({
          ...prev,
          [`${activeAccount}|${id}`]: {
            ok: r.ok,
            error: r.error,
            pipeline: r.pipeline,
            upstreams: r.upstreams,
            pinState: r.pinState,
          },
        }));
        if (!r.ok) message.error(t('catalog.probe.error', { id, error: r.error ?? t('common.unknownError') }));
      },
      onError: (e) => {
        const err = String(e);
        setProbes((prev) => ({ ...prev, [`${activeAccount}|${id}`]: { ok: false, error: err } }));
        message.error(t('catalog.probe.error', { id, error: err }));
      },
    });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title={t('catalog.title')}
        desc={t('catalog.desc')}
        actions={<DetectionAccountPicker label={t('models.account.label')} />}
      />
      {/* 区域：目录（搜索与计数属于这块区域的头，表格是它的体） */}
      <Panel
        flush
        title={
          <Input
            style={{ width: 320 }}
            prefix={<SearchOutlined />}
            allowClear
            placeholder={t('catalog.filter.placeholder')}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        }
        extra={
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {filter
              ? t('catalog.count.matched', {
                  matched: matched.length,
                  total: models.data?.catalogCount ?? 0,
                  limit: 400,
                })
              : t('catalog.count.all', { total: models.data?.catalogCount ?? 0, limit: 400 })}
          </Typography.Text>
        }
      >
        {models.isError ? (
          <Alert
            type="error"
            showIcon
            message={t('catalog.loadFailed')}
            description={t('catalog.loadFailed.desc')}
            action={
              <Button size="small" onClick={() => void models.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : models.isLoading && !models.data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <Table
            className="cps-table-center"
            rowKey="id"
            size="small"
            sticky
            loading={models.isLoading}
            dataSource={filtered.map((id) => ({ id }))}
            locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('catalog.empty')} /> }}
            pagination={false}
            columns={[
              {
                title: t('catalog.col.model'),
                dataIndex: 'id',
                /* 纯等宽文字（不用 code 芯片）：这一列是 400 行同样的标识，
                   每行一个带内边距与描边的芯片会变成一片栅格噪点。 */
                render: (v: string) => (
                  <Tooltip title={v}>
                    <span className="cps-mono cps-cell-ellipsis">{v}</span>
                  </Tooltip>
                ),
              },
              {
                title: t('catalog.col.type'),
                width: 320,
                render: (_, r) => {
                  const id = String(r.id);
                  const p = probes[`${activeAccount}|${id}`];
                  if (!p) {
                    return id.includes(':free') ? (
                      <StatusChip tone="ok" small dot={false}>
                        {t('catalog.type.free')}
                      </StatusChip>
                    ) : (
                      <StatusChip tone="neutral" small dot={false}>
                        {t('catalog.type.planner')}
                      </StatusChip>
                    );
                  }
                  return <ProbeTags p={p} />;
                },
              },
              {
                title: t('catalog.col.actions'),
                width: 76,
                render: (_, r) => (
                  <Button
                    size="small"
                    disabled={!activeAccount}
                    loading={probe.isPending && probe.variables === r.id}
                    onClick={() => runProbe(String(r.id))}
                  >
                    {t('catalog.action.probe')}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </Panel>
    </div>
  );
}
