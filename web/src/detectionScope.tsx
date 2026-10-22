import { Select, Space, Tag, Typography } from 'antd';
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';

import { useAccounts } from './api/hooks.ts';
import type { AccountView } from './api/types.ts';
import { useI18n } from './i18n/index.tsx';

/**
 * 检测账号（订阅模型 / 测试台 / 完整目录共用）。
 *
 * 2.1 起探测与校验的结论只对**执行它的账号**成立，所以这三个页面必须使用
 * 同一个「当前检测账号」。各自 useState 会在切页后保留旧选择：在订阅模型页
 * 换成账号 B，切到测试台仍是账号 A，结果看起来像「探测数据丢了」。
 * 选择存本地；账号被删除/改名时自动收敛到仍然存在的账号。
 */
const PICKED_KEY = 'cps_detect_account';

interface DetectionAccountValue {
  /** 当前检测账号名；账号池为空时为空串。 */
  account: string;
  /** 当前账号的完整视图（体检结论、到期状态等）；没有账号时为 null。 */
  current: AccountView | null;
  accounts: AccountView[];
  /** 账号列表还没加载完。 */
  loading: boolean;
  setAccount: (name: string) => void;
}

const DetectionAccountContext = createContext<DetectionAccountValue | null>(null);

export function DetectionAccountProvider({ children }: { children: ReactNode }) {
  const accountsQuery = useAccounts();
  const accounts = useMemo(() => accountsQuery.data?.accounts ?? [], [accountsQuery.data?.accounts]);
  const [picked, setPicked] = useState<string>(() => localStorage.getItem(PICKED_KEY) ?? '');
  /**
   * 刚改名的目标名。改名回执先到、账号列表刷新后到：这段时间不能因为
   * 「旧列表里没有新名字」就回退到第一个账号，否则改名后选择会丢。
   */
  const pendingRename = useRef<string | null>(null);

  const account = accounts.some((a) => a.name === picked)
    ? picked
    : pendingRename.current === picked
      ? picked
      : (accounts[0]?.name ?? '');

  // 账号被删除/改名后把选择收敛到仍然存在的账号（并写回本地）
  useEffect(() => {
    if (accounts.some((a) => a.name === picked)) {
      pendingRename.current = null;
      return;
    }
    if (pendingRename.current === picked) return;
    if (!account || account === picked) return;
    setPicked(account);
    localStorage.setItem(PICKED_KEY, account);
  }, [account, accounts, picked]);

  const setAccount = useCallback((name: string) => {
    setPicked(name);
    localStorage.setItem(PICKED_KEY, name);
  }, []);

  // 账号改名后跟着改名，避免检测页突然回退到另一个账号
  useEffect(() => {
    const handler = (e: Event): void => {
      const renamed = (e as CustomEvent<Array<{ from: string; to: string }>>).detail;
      if (!Array.isArray(renamed)) return;
      setPicked((current) => {
        const hit = renamed.find((r) => r.from === current);
        if (!hit) return current;
        pendingRename.current = hit.to;
        localStorage.setItem(PICKED_KEY, hit.to);
        return hit.to;
      });
    };
    window.addEventListener('cps:accounts-renamed', handler);
    return () => window.removeEventListener('cps:accounts-renamed', handler);
  }, []);

  const current = accounts.find((a) => a.name === account) ?? null;

  const value = useMemo<DetectionAccountValue>(
    () => ({ account, current, accounts, loading: accountsQuery.isLoading, setAccount }),
    [account, current, accounts, accountsQuery.isLoading, setAccount],
  );
  return <DetectionAccountContext.Provider value={value}>{children}</DetectionAccountContext.Provider>;
}

export function useDetectionAccount(): DetectionAccountValue {
  const value = useContext(DetectionAccountContext);
  if (!value) throw new Error('useDetectionAccount 必须在 DetectionAccountProvider 内使用');
  return value;
}

/**
 * 页头的账号选择器。所有检测页共用同一个控件，避免三个页面各写一套
 * 「选中值/回退/风险标签」。
 */
export function DetectionAccountPicker({ label, showClass = false }: { label: string; showClass?: boolean }) {
  const { t } = useI18n();
  const { account, current, accounts, setAccount } = useDetectionAccount();
  const kind = current?.classify?.class ?? 'unknown';
  return (
    <Space size={6} align="center">
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {label}
      </Typography.Text>
      <Select
        size="small"
        showSearch
        style={{ minWidth: 180, maxWidth: 240 }}
        value={account || undefined}
        placeholder={t('models.account.placeholder')}
        options={accounts.map((a) => ({ value: a.name, label: a.name }))}
        onChange={setAccount}
      />
      {showClass && account ? (
        kind === 'normal' ? (
          <Tag color="green">{t('models.account.normal')}</Tag>
        ) : kind === 'private' ? (
          <Tag color="orange">{t('models.account.private')}</Tag>
        ) : (
          <Tag>{t('models.account.unknown')}</Tag>
        )
      ) : null}
    </Space>
  );
}
