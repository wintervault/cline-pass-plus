import { ApiError } from '../api/client.ts';
import type { Notice } from '../api/types.ts';
import type { Lang, MsgKey } from './index.tsx';

/**
 * 后端返回的用户可见文案：**稳定 code + params**，这里映射成词条。
 *
 * 不在前端猜后端字符串（中英文混排、原文变化都会立刻破功）；未知 code 返回空串，
 * 宁可少显示一句，也不把中文原文泄漏到英文界面里。原始信息仍在服务端日志里。
 */
const CODE_KEYS: Record<string, MsgKey> = {
  'account.keyOkGatewayNotice': 'toast.account.notice',
  'account.keyInvalid': 'api.account.keyInvalid',
  'account.quotaExhausted': 'api.account.quotaExhausted',
  'account.rateLimited': 'api.account.rateLimited',
  'account.upstreamError': 'api.account.upstreamError',
  'upstream.quotaExhausted': 'api.upstream.quotaExhausted',
  'accounts.classify.noTargets': 'api.accounts.noTargets',
  'accounts.classify.noEnabled': 'api.accounts.noEnabled',
  'accounts.classify.busy': 'api.accounts.busy',
  'accounts.required': 'api.accounts.required',
  'accounts.notFound': 'api.accounts.notFound',
  'console.portInvalid': 'api.console.portInvalid',
  'console.bindHostRequired': 'api.console.bindHostRequired',
  'console.insecureBind': 'api.console.insecureBind',
  'console.portConflict': 'api.console.portConflict',
  'console.bindFailed': 'api.console.bindFailed',
  'console.invalid': 'api.console.invalid',
  'gateway.idInvalid': 'api.gateway.idInvalid',
  'gateway.limit': 'api.gateway.limit',
  'gateway.nameInvalid': 'api.gateway.nameInvalid',
  'gateway.portInvalid': 'api.gateway.portInvalid',
  'gateway.bindHostRequired': 'api.gateway.bindHostRequired',
  'gateway.failoverInvalid': 'api.gateway.failoverInvalid',
  'gateway.insecureBind': 'api.gateway.insecureBind',
  'gateway.portConflict': 'api.gateway.portConflict',
  'gateway.portConflictConsole': 'api.gateway.portConflictConsole',
  'gateway.notFound': 'api.gateway.notFound',
  'gateway.lastOne': 'api.gateway.lastOne',
  'gateway.consoleProtected': 'api.gateway.consoleProtected',
  'gateway.consoleDisabled': 'api.gateway.consoleDisabled',
  'validate.pinIgnored': 'api.validate.pinIgnored',
  'validate.pinUnverified': 'api.validate.pinUnverified',
  'validate.noAccount': 'api.validate.noAccount',
  'gateway.notRunning': 'api.gateway.notRunning',
};

export function noticeText(
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
  notice: Notice | undefined,
): string {
  if (!notice) return '';
  return codeText(t, notice.code, notice.params);
}

/** 稳定 code → 当前语言文案（没有映射返回空串）。接口返回 code、而不是拼好的文案。 */
export function codeText(
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
  code: string | null | undefined,
  params?: Record<string, string | number>,
): string {
  if (!code) return '';
  const key = CODE_KEYS[code];
  return key ? t(key, params) : '';
}

/** 接口错误里已知的 code → 当前语言文案；未知 code 返回 null（调用方用原 message 兜底）。 */
export function errorText(
  t: (key: MsgKey, params?: Record<string, string | number>) => string,
  err: unknown,
): string | null {
  if (!(err instanceof ApiError) || !err.code) return null;
  const key = CODE_KEYS[err.code];
  if (!key) return null;
  return t(key, err.params);
}

/** 任意汉字（按 Unicode Script 判定，不依赖具体码点区间）。 */
const CJK = /\p{Script=Han}/u;

/**
 * 诊断原文的显示规则：中文界面原样显示；英文界面丢弃含中文的字符串。
 * 服务端的诊断（钉住理由、尝试备注、体检失败原因）是观测数据，不是 UI 文案，
 * 没有 code 可翻译——按项目约定「未知 code 宁可不显示，也不漏中文」。
 */
export function diagnosticText(lang: Lang, text: string | null | undefined): string {
  if (!text) return '';
  if (lang === 'zh-CN') return text;
  return CJK.test(text) ? '' : text;
}
