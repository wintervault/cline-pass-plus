import { DeleteOutlined, EditOutlined, PlusOutlined, TeamOutlined } from '@ant-design/icons';
import { useQueryClient } from '@tanstack/react-query';
import {
  Alert,
  App,
  Button,
  DatePicker,
  Input,
  Modal,
  Popconfirm,
  Select,
  Skeleton,
  Space,
  Tooltip,
  Typography,
} from 'antd';
import dayjs from 'dayjs';
import { useState } from 'react';

import { qk, useAccounts, useSaveAccounts, useTestAccount } from '../api/hooks.ts';
import type { AccountsResponse, AccountView, ExpiryState } from '../api/types.ts';
import { EmptyLine, EmptyState } from '../emptyState.tsx';
import { type Lang, useI18n } from '../i18n/index.tsx';
import { useFlipList } from '../motion.ts';
import { PageHeader } from '../pageHeader.tsx';
import { Panel, PanelHint } from '../panel.tsx';
import { StatusChip } from '../statusChip.tsx';

/**
 * 账号池是**全局**的：名称/密钥/分组/到期只在这里定义一次。
 * 账号策略（粘性/单账号/轮转）与「哪些账号参与」是**网关级**的，在「网关」页编辑——
 * 同一个账号可以带多个分组，同时服务多个网关，但密钥只有一份。
 */

/** 提交给服务端的账号行；key 空串 = 保持原 key（服务端拿不到明文）。 */
interface DraftAccount {
  name: string;
  key: string;
  /** `YYYY-MM-DD`；null = 没有到期时间。 */
  expiresAt: string | null;
  /** 用户自定义标签；网关的「按分组」范围按它选账号。 */
  groups: string[];
  /**
   * 该行在已存列表里的下标；新增行为 null。
   * key 的归属由它指定——**不能按当前行号对位**：删除一行会让后面的行
   * 错位继承别人的密钥（服务端按 existingIndex 取旧 key）。
   */
  existingIndex: number | null;
}

/** 编辑弹窗的状态。 */
interface EditModal {
  /** null = 新增；数字 = 编辑已存账号的下标 */
  index: number | null;
  name: string;
  key: string;
  expiresAt: string | null;
  groups: string[];
}

/** 最近使用时间：当天只显示时刻，跨天带日期（跟随界面语言）。 */
function fmtUsed(ts: number, lang: Lang): string {
  const d = new Date(ts);
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(lang)
    : d.toLocaleString(lang, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

/**
 * 分组标签。
 *
 * 用文本而不是彩色药丸：分组是用户起的名字，不是状态。给它配颜色等于暗示
 * 「这组比那组更对」，而分组之间没有优劣；一屏五六个彩色药丸也会把真正的
 * 异常（额度用尽、密钥失效）平均掉。
 */
function GroupTags({ groups }: { groups: string[] }) {
  const { t } = useI18n();
  if (groups.length === 0) {
    return (
      <span className="cps-meta" style={{ color: 'var(--cps-text-tertiary)' }}>
        {t('accounts.groups.none')}
      </span>
    );
  }
  return (
    <span
      className="cps-meta"
      style={{
        display: 'block',
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--cps-text-secondary)',
      }}
    >
      {groups.join(' · ')}
    </span>
  );
}

/**
 * 到期徽标。三种形态之外还有一条常被误解的规则：**到期不会自动停用账号**。
 * 日期可能只是没续上，停用是破坏性动作——所以这里只标记，不改变行为。
 */
function ExpiryTag({ expiry, expiresAt }: { expiry: ExpiryState; expiresAt: string | null }) {
  const { t } = useI18n();
  if (expiry.kind === 'none' || !expiresAt) {
    return (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {t('accounts.expiry.none')}
      </Typography.Text>
    );
  }
  if (expiry.kind === 'expired') {
    return (
      <Tooltip title={t('accounts.expiry.expiredTip', { date: expiresAt })}>
        <span>
          <StatusChip tone="danger" small>
            {expiry.days !== null
              ? t('accounts.expiry.expired', { days: Math.abs(expiry.days) })
              : t('accounts.expiry.expiredOnly')}
          </StatusChip>
        </span>
      </Tooltip>
    );
  }
  if (expiry.kind === 'soon' && expiry.days !== null) {
    return (
      <Tooltip title={t('accounts.expiry.soonTip', { date: expiresAt })}>
        <span>
          <StatusChip tone="warn" small>
            {expiry.days === 0 ? t('accounts.expiry.today') : t('accounts.expiry.inDays', { days: expiry.days })}
          </StatusChip>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={t('accounts.expiry.on', { date: expiresAt })}>
      <span className="cps-body" style={{ color: 'var(--cps-text-secondary)' }}>
        {expiresAt}
      </span>
    </Tooltip>
  );
}

export default function Accounts() {
  const { message } = App.useApp();
  const { t, lang } = useI18n();
  const qc = useQueryClient();
  const accounts = useAccounts();
  const save = useSaveAccounts();
  const testKey = useTestAccount();
  const [modal, setModal] = useState<EditModal | null>(null);
  const [groupFilter, setGroupFilter] = useState<string | null>(null);

  const data = accounts.data;
  const rows = data?.accounts ?? [];

  const noExpiry = rows.filter((a) => !a.expiresAt).length;
  /** 分组清单 = 所有账号用过的标签；同时作为筛选器与编辑弹窗的候选项。 */
  const allGroups = [...new Set(rows.flatMap((a) => a.groups))].sort((a, b) => a.localeCompare(b));
  /** 选过的分组可能刚被改名/删除：失效时按「全部分组」显示，而不是给出空名单。 */
  const activeGroup = groupFilter && allGroups.includes(groupFilter) ? groupFilter : null;
  const shown = rows.map((a, i) => ({ a, i })).filter(({ a }) => !activeGroup || a.groups.includes(activeGroup));
  /** 增删账号时，其余行滑到新位置，而不是瞬移（只响应用户操作后的数据变化）。 */
  const listRef = useFlipList<HTMLDivElement>(rows.map((a) => a.name).join('|'));

  /** 把服务端当前状态组装成提交数组（key 留空 = 保持不变）。 */
  const draftFromServer = (): DraftAccount[] =>
    rows.map((a, i) => ({ name: a.name, key: '', expiresAt: a.expiresAt, groups: a.groups, existingIndex: i }));

  /** 就地保存：只改传入的字段，其余保持服务端当前值。note 是给用户的回执文案。 */
  const commit = (next: { accounts: DraftAccount[] }, note: string): void => {
    const nextAccounts = next.accounts;
    // 乐观更新缓存：连续操作（连点开关）时，下一次 draftFromServer()
    // 读到的必须包含上一次改动——否则后一次提交会用旧缓存覆盖前一次（丢改动）
    qc.setQueryData<AccountsResponse>(qk.accounts, (old) =>
      old
        ? {
            ...old,
            accounts: nextAccounts.map((a) => {
              const prev = a.existingIndex !== null ? old.accounts[a.existingIndex] : undefined;
              const key = a.key.trim();
              const expiresAt = a.expiresAt;
              const unchanged = (prev?.expiresAt ?? null) === expiresAt;
              return {
                name: a.name,
                keyMasked: key
                  ? `${'•'.repeat(Math.max(8, key.length - 4))}${key.slice(-4)}`
                  : (prev?.keyMasked ?? '—'),
                keyTail: key ? key.slice(-4) : (prev?.keyTail ?? ''),
                hasKey: !!key || !!prev?.hasKey,
                expiresAt,
                // 日期变了就先按「到期 <日期>」展示，服务端刷新后换成准确的天数
                expiry: unchanged
                  ? (prev?.expiry ?? { kind: 'none', days: null })
                  : { kind: expiresAt ? 'active' : 'none', days: null },
                groups: a.groups,
              } satisfies AccountView;
            }),
          }
        : old,
    );
    save.mutate(
      { payload: { accounts: nextAccounts }, note },
      { onSuccess: () => qc.invalidateQueries({ queryKey: qk.accounts }) },
    );
  };

  const testAccount = (name: string): void => {
    testKey.mutate({ payload: { name }, label: name });
  };

  /** 分组只有数量和长度上限（8 个 / 各 24 字），与服务端 schema 一致。 */
  const cleanGroups = (groups: string[]): string[] =>
    [...new Set(groups.map((g) => g.trim().slice(0, 24)).filter(Boolean))].slice(0, 8);

  const submitModal = (): void => {
    if (!modal) return;
    const name = modal.name.trim() || t('accounts.defaultName', { n: rows.length + 1 });
    const key = modal.key.trim();
    if (modal.index === null && !key) {
      message.warning(t('accounts.validate.keyRequired'));
      return;
    }
    const draft = draftFromServer();
    const editing = modal.index !== null;
    const groups = cleanGroups(modal.groups);
    if (modal.index === null) {
      draft.push({ name, key, expiresAt: modal.expiresAt, groups, existingIndex: null });
    } else {
      draft[modal.index] = { ...(draft[modal.index] as DraftAccount), name, key, expiresAt: modal.expiresAt, groups };
    }
    commit({ accounts: draft }, editing ? t('accounts.note.updated', { name }) : t('accounts.note.added', { name }));
    setModal(null);
  };

  const removeAccount = (i: number): void => {
    const name = rows[i]?.name ?? t('common.none');
    const draft = draftFromServer().filter((_, j) => j !== i);
    commit({ accounts: draft }, t('accounts.note.deleted', { name }));
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <PageHeader
        title={t('accounts.title')}
        desc={t('accounts.desc')}
        actions={
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setModal({ index: null, name: '', key: '', expiresAt: null, groups: [] })}
          >
            {t('accounts.add')}
          </Button>
        }
      />

      {/* 账号名单 */}
      <Panel
        title={t('accounts.panel.title')}
        extra={
          rows.length > 0 ? (
            <Space size={12} align="center">
              <PanelHint>{t('common.count', { count: rows.length })}</PanelHint>
              {noExpiry > 0 && <PanelHint>{t('accounts.panel.noExpiry', { count: noExpiry })}</PanelHint>}
              {allGroups.length > 0 && (
                <Select
                  size="small"
                  allowClear
                  style={{ width: 132 }}
                  placeholder={t('accounts.groups.filter')}
                  value={activeGroup ?? undefined}
                  onChange={(v?: string) => setGroupFilter(v ?? null)}
                  options={allGroups.map((g) => ({ value: g, label: g }))}
                />
              )}
            </Space>
          ) : undefined
        }
        flush
      >
        {accounts.isError ? (
          <Alert
            type="error"
            showIcon
            style={{ margin: 16 }}
            message={t('accounts.loadFailed')}
            description={t('accounts.loadFailed.desc')}
            action={
              <Button size="small" onClick={() => void accounts.refetch()}>
                {t('common.retry')}
              </Button>
            }
          />
        ) : accounts.isLoading && !data ? (
          <div style={{ padding: 16 }}>
            <Skeleton active paragraph={{ rows: 4 }} />
          </div>
        ) : rows.length === 0 ? (
          <EmptyState
            minHeight={240}
            icon={<TeamOutlined />}
            desc={t('accounts.empty')}
            action={
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setModal({ index: null, name: '', key: '', expiresAt: null, groups: [] })}
              >
                {t('accounts.add')}
              </Button>
            }
          />
        ) : (
          <div ref={listRef} className="cps-fade-in">
            <div className="cps-list-head cps-account-grid">
              <span className="cps-label">{t('accounts.col.account')}</span>
              <span className="cps-label">{t('accounts.col.groups')}</span>
              <span className="cps-label">{t('accounts.col.expiry')}</span>
              <span className="cps-label" style={{ textAlign: 'right' }}>
                {t('accounts.col.usage')}
              </span>
              <span className="cps-label" style={{ textAlign: 'right' }}>
                {t('accounts.col.actions')}
              </span>
            </div>
            {shown.length === 0 ? (
              <EmptyLine>{t('accounts.groups.empty', { group: activeGroup ?? '' })}</EmptyLine>
            ) : null}
            {shown.map(({ a, i }) => {
              const st = data?.stats[a.name];
              return (
                <div key={`${a.name}-${a.keyMasked}`} className="cps-list-row cps-account-row" data-flip-key={a.name}>
                  <div className="cps-account-grid" style={{ width: '100%' }}>
                    <div style={{ minWidth: 0, display: 'grid', gap: 3 }}>
                      <span
                        className="cps-title"
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: 'var(--cps-text)',
                        }}
                      >
                        {a.name || t('accounts.unnamed')}
                      </span>
                      <span className="cps-data" style={{ fontSize: 11.5, color: 'var(--cps-text-tertiary)' }}>
                        {a.keyMasked}
                      </span>
                    </div>

                    <GroupTags groups={a.groups} />

                    <ExpiryTag expiry={a.expiry} expiresAt={a.expiresAt} />

                    <div style={{ display: 'grid', gap: 2, justifyItems: 'end' }}>
                      <span className="cps-num" style={{ color: 'var(--cps-text)' }}>
                        {t('common.requests', { count: st?.requests ?? 0 })}
                      </span>
                      <span className="cps-meta">
                        {st?.lastUsed ? fmtUsed(st.lastUsed, lang) : t('accounts.usage.neverUsed')}
                      </span>
                      {st?.lastError && (
                        <Tooltip title={st.lastError}>
                          <span className="cps-status cps-status-danger" style={{ gap: 0, fontSize: 11.5 }}>
                            {t('accounts.usage.error')}
                          </span>
                        </Tooltip>
                      )}
                    </div>

                    <Space size={2} style={{ justifySelf: 'end' }}>
                      <Tooltip title={t('accounts.action.test.tip')}>
                        <Button
                          size="small"
                          loading={
                            testKey.isPending &&
                            testKey.variables !== undefined &&
                            'name' in testKey.variables.payload &&
                            testKey.variables.payload.name === a.name
                          }
                          onClick={() => testAccount(a.name)}
                        >
                          {t('accounts.action.test')}
                        </Button>
                      </Tooltip>
                      <Tooltip title={t('accounts.action.edit.tip')}>
                        <Button
                          size="small"
                          type="text"
                          icon={<EditOutlined />}
                          aria-label={t('common.edit')}
                          onClick={() =>
                            setModal({
                              index: i,
                              name: a.name,
                              key: '',
                              expiresAt: a.expiresAt,
                              groups: a.groups,
                            })
                          }
                        />
                      </Tooltip>
                      <Popconfirm
                        title={t('accounts.delete.title', { name: a.name })}
                        description={t('accounts.delete.desc')}
                        okText={t('common.delete')}
                        okButtonProps={{ danger: true }}
                        cancelText={t('common.cancel')}
                        onConfirm={() => removeAccount(i)}
                      >
                        <Button
                          size="small"
                          type="text"
                          danger
                          icon={<DeleteOutlined />}
                          aria-label={t('accounts.action.delete.tip')}
                        />
                      </Popconfirm>
                    </Space>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Panel>

      <Modal
        open={modal !== null}
        title={modal?.index === null ? t('accounts.modal.add') : t('accounts.modal.edit')}
        okText={t('common.save')}
        cancelText={t('common.cancel')}
        onOk={submitModal}
        onCancel={() => setModal(null)}
        /* 填 key 时经常要切到浏览器/编辑器复制再切回来；点一下遮罩就丢掉已输入的内容太伤 */
        maskClosable={false}
        destroyOnHidden
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accounts.field.name')}
            </Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              placeholder={t('accounts.field.name.placeholder')}
              value={modal?.name ?? ''}
              onChange={(e) => setModal((m) => (m ? { ...m, name: e.target.value } : m))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accounts.field.key')}
            </Typography.Text>
            <Input.Password
              style={{ marginTop: 4 }}
              placeholder={
                modal?.index === null
                  ? t('accounts.field.key.placeholderNew')
                  : t('accounts.field.key.placeholderKeep', { tail: rows[modal?.index ?? 0]?.keyTail ?? '' })
              }
              value={modal?.key ?? ''}
              onChange={(e) => setModal((m) => (m ? { ...m, key: e.target.value } : m))}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accounts.field.groups')}
            </Typography.Text>
            <Select
              mode="tags"
              style={{ marginTop: 4, width: '100%' }}
              maxCount={8}
              tokenSeparators={[',', '，']}
              placeholder={t('accounts.field.groups.placeholder')}
              value={modal?.groups ?? []}
              onChange={(v: string[]) => setModal((m) => (m ? { ...m, groups: v } : m))}
              options={allGroups.map((g) => ({ value: g, label: g }))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              {t('accounts.field.groups.hint')}
            </Typography.Text>
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {t('accounts.field.expiry')}
            </Typography.Text>
            <DatePicker
              style={{ marginTop: 4, width: '100%' }}
              /* 日历挂到 body：留在 Modal 内会被弹窗边界裁掉，底部日期点不到 */
              getPopupContainer={() => document.body}
              placement="bottomLeft"
              allowClear
              placeholder={t('accounts.field.expiry.placeholder')}
              value={modal?.expiresAt ? dayjs(modal.expiresAt) : null}
              onChange={(d) => setModal((m) => (m ? { ...m, expiresAt: d ? d.format('YYYY-MM-DD') : null } : m))}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 6 }}>
              {t('accounts.field.expiry.hint')}
            </Typography.Text>
          </div>
        </Space>
      </Modal>
    </div>
  );
}
