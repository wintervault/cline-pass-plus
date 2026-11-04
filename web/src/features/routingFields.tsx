import { Select, Space, Switch, Tooltip, Typography } from 'antd';

import type { PerModelConfig, SortKey } from '../api/types.ts';
import { useT } from '../i18n/index.tsx';

/**
 * 路由策略的三个控件（钉住模式 / 排除私有渠道 / 渠道排序）。
 *
 * 「订阅模型」和「测试台」编辑的是**同一份配置**，两边各写一遍必然漂移
 * （之前一处带标签、一处是光头下拉，同一个设置两种样子）。抽成一处，
 * 只保留调用点决定的「改动后回执文案」。
 *
 * 「排除私有渠道」跟在钉住模式同一格里，而不是另起一行：测试台在默认窗口下
 * 不允许出现纵向滚动条，多一整行 48px 正好会把它顶出去。
 */
export function RoutingFields({
  cfg,
  onChange,
}: {
  cfg: PerModelConfig;
  onChange: (patch: Partial<PerModelConfig>, note: string) => void;
}) {
  const t = useT();
  const selectWidth = 180;
  const guard = cfg.regionGuard ?? true;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: '16px 40px' }}>
      <div>
        <Space size={12} align="center" wrap>
          <Tooltip title={t('routing.pinMode.hint')}>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 13, borderBottom: '1px dashed var(--ant-color-border)' }}
            >
              {t('routing.pinMode')}
            </Typography.Text>
          </Tooltip>
          <Select
            style={{ width: selectWidth }}
            value={cfg.pinMode}
            onChange={(v) =>
              onChange(
                { pinMode: v },
                t('routing.note.pinMode', {
                  name: v === 'strict' ? t('routing.pinMode.strict') : t('routing.pinMode.preferred'),
                }),
              )
            }
            options={[
              { value: 'strict', label: t('routing.pinMode.strict') },
              { value: 'preferred', label: t('routing.pinMode.preferred') },
            ]}
          />
          <Tooltip title={t('routing.regionGuard.hint')}>
            <Space size={8} align="center" style={{ whiteSpace: 'nowrap' }}>
              <Switch
                size="small"
                checked={guard}
                aria-label={t('routing.regionGuard')}
                onChange={(v) =>
                  onChange({ regionGuard: v }, v ? t('routing.note.regionGuardOn') : t('routing.note.regionGuardOff'))
                }
              />
              <span className="cps-meta">{t('routing.regionGuard')}</span>
            </Space>
          </Tooltip>
        </Space>
      </div>
      <div>
        <Space size={12} align="center">
          <Tooltip title={t('routing.sort.hint')}>
            <Typography.Text
              type="secondary"
              style={{ fontSize: 13, borderBottom: '1px dashed var(--ant-color-border)' }}
            >
              {t('routing.sort')}
            </Typography.Text>
          </Tooltip>
          <Select
            style={{ width: selectWidth }}
            value={cfg.sort ?? ''}
            onChange={(v: string) => {
              const label: Record<string, string> = {
                '': t('routing.sort.auto'),
                cost: t('routing.sort.cost'),
                ttft: t('routing.sort.ttft'),
                tps: t('routing.sort.tps'),
              };
              onChange({ sort: (v || null) as SortKey | null }, t('routing.note.sort', { name: label[v] ?? v }));
            }}
            options={[
              { value: '', label: t('routing.sort.auto') },
              { value: 'cost', label: t('routing.sort.cost') },
              { value: 'ttft', label: t('routing.sort.ttft') },
              { value: 'tps', label: t('routing.sort.tps') },
            ]}
          />
        </Space>
      </div>
    </div>
  );
}
