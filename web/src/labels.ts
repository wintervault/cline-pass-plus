import type { AccountClassKind, UpstreamStatusKind } from './api/types.ts';
import type { MsgKey } from './i18n/index.tsx';
import type { ChipTone } from './statusChip.tsx';

/**
 * 状态 → 芯片（文案 key + 语气）。
 *
 * 放在 UI 层而不是 `api/types.ts`：那里只镜像服务端的数据形状，
 * 而「可用 / 限流 / 风控」是界面语言，要跟着语言切换。
 *
 * 语气只有五种（见 statusChip.tsx），不按页面各挑一个 antd 预设色。
 */
export const STATUS_TAG: Record<UpstreamStatusKind, { labelKey: MsgKey; tone: ChipTone }> = {
  ok: { labelKey: 'labels.upstream.ok', tone: 'ok' },
  limited: { labelKey: 'labels.upstream.limited', tone: 'warn' },
  quota: { labelKey: 'labels.upstream.quota', tone: 'danger' },
  bad: { labelKey: 'labels.upstream.bad', tone: 'danger' },
  auth: { labelKey: 'labels.upstream.auth', tone: 'danger' },
  unknown: { labelKey: 'labels.upstream.unknown', tone: 'neutral' },
};

export const ACCOUNT_CLASS_TAG: Record<AccountClassKind, { labelKey: MsgKey; tone: ChipTone }> = {
  normal: { labelKey: 'labels.class.normal', tone: 'ok' },
  private: { labelKey: 'labels.class.private', tone: 'warn' },
  unknown: { labelKey: 'labels.class.unknown', tone: 'neutral' },
};
