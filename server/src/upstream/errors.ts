import type { UpstreamErrorKind, UpstreamStatusKind } from './types.ts';

export interface UpstreamErrorInfo {
  /** HTTP 状态码；网络失败 / 超时 / 中止时为 null。 */
  status: number | null;
  /** 归一化后的错误文本。 */
  message: string;
}

// ---------- 渠道状态五分类（探测/校验用，驱动 UI 徽章） ----------

/**
 * 渠道被单独钉住时的真实状态。
 *
 * 注意 `empty response content` 归为 ok：请求已到达模型，只是推理模型把 max_tokens
 * 全花在思考上、还没输出正文。这是探测用小请求的正常现象，不是渠道故障。
 * `quota` 与 `limited` 分开：额度用尽换渠道也没用，限流等一会儿会恢复。
 */
export function classifyChannelStatus(message: string): UpstreamStatusKind {
  const m = String(message || '');
  if (/empty response content/i.test(m)) return 'ok';
  if (CAP_MSG.test(m)) return 'quota';
  if (/429|rate[\s_-]?limit(ed)?|temporarily rate/i.test(m)) return 'limited';
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(m))
    return 'bad';
  if (/unauthorized|re-authenticate|401/i.test(m)) return 'auth';
  return 'unknown';
}

// ---------- 故障转移三分类（决定重试还是切换） ----------

/** 限流语言的辨识度最高（避免 "rate limit ... quota" 被误判成账号级）。 */
const RATE_LIMIT_MSG = /429|rate[\s_-]?limit|too many requests|temporarily rate|overloaded/i;
/** 账号/额度问题：换渠道毫无意义，必须换账号。 */
const ACCOUNT_MSG =
  /unauthorized|re-?authenticate|invalid\s*api[_\s-]?key|api\s*key|insufficient|billing|payment|quota/i;
/**
 * 额度已经耗尽（不是瞬时限流）：必须换账号，重试与换渠道都不会有不同结果。
 *
 * 为什么它要**先于**限流判定：Cline Pass 的月度额度用尽时，网关回的是
 * `Error 429: You have reached your monthly Clinepass limit. The limit resets in 10d 14h`——
 * 文本里既有 429 又有 limit。按「限流先于配额」会判成渠道级，于是请求一次次落在同一个
 * 已耗尽的账号上、永远不轮转（2.1.5 修的实测问题：额度用完后粘住不切）。
 *
 * 区分依据是「额度本身已经用完」与「以天/小时计的恢复时间」；秒级的 retry-after
 * 仍然是瞬时限流，走渠道级重试。
 */
const CAP_MSG = new RegExp(
  [
    'INFERENCE_CAP_ERROR',
    // monthly Clinepass limit / daily usage quota / weekly quota
    '(?:monthly|daily|weekly)\\s+(?:\\w+\\s+){0,2}(?:limit|quota|cap)',
    // reached your monthly / exceeded the current quota / hit your usage cap
    '(?:reached|exceeded|hit)\\s+(?:your|the|its)\\s+(?:\\w+\\s+){0,2}(?:quota|credit|balance|spend(?:ing)?|usage)',
    // quota exhausted / credit balance depleted / usage limit exceeded
    '(?:usage|quota|credit|balance|spend(?:ing)?)\\s+(?:has\\s+been\\s+|was\\s+|is\\s+)?(?:exhausted|exceeded|used\\s+up|depleted|insufficient)',
    'insufficient[_ ](?:quota|credit|balance)',
    // "limit resets in 10d 14h"：以天/小时计的恢复时间不是瞬时限流
    '(?:limit|quota|cap)\\s+resets?\\s+in\\s+\\d+\\s*[dh]\\b',
    '额度(?:已)?(?:用完|耗尽|用尽|不足)',
    '配额(?:已)?(?:用完|耗尽|用尽|不足)',
  ].join('|'),
  'i',
);

/**
 * 是否「额度已经用完」（账号级，不是瞬时限流）。
 *
 * 探测、校验、账号体检、连通性测试与故障转移共用这一个判定——它们面对的是同一条
 * 上游错误，不能各自解释成「限流」「未判定」「连通但网关提示 429」。
 */
export function isQuotaExhausted(message: string): boolean {
  return CAP_MSG.test(String(message || ''));
}

/** 钉住相关的路由失败：换渠道有意义。 */
const PROVIDER_MSG = /no allowed providers|no available providers|available providers are:|modelid/i;
const TIMEOUT_MSG = /\btimeout\b|timed?\s*out/i;

export const KIND_LABEL: Record<UpstreamErrorKind, string> = {
  account: '账号级',
  channel: '渠道级',
  request: '请求级',
};

/**
 * 把上游错误分成三类，各自的处理策略不同（用户确认的设计）：
 *
 * - `account`：**立即换账号**，不重试。key 失效、额度用完时换渠道毫无意义。
 * - `channel`：**同渠道先退避重试，仍失败才切换**。429 / 5xx / 网络失败 / 超时。
 * - `request`：同渠道重试一次，仍失败则切换。
 *
 * 难点：`invalid_request_error` 在本项目有两种相反含义——钉住某渠道时该渠道映射不了
 * 模型 ID 会报它（渠道级），客户端参数错误也报它（请求级）。从错误文本无法可靠区分，
 * 所以不猜：两者都归入「先重试再切」，用「重试是否复现」这个行为来区分，
 * 代价只是多一次请求，换来 agent 永远不会被卡死（用户明确的优先级）。
 *
 * 判定顺序有讲究：网关可能把账号错误包在 200/502 响应体里，所以**文本检测先于状态码**；
 * 而「额度已耗尽」要先于限流——它的文本里通常就带着 429，但换渠道与重试都救不回来；
 * 普通的「rate limit ... quota」仍是渠道级，由限流判定先命中。
 */
export function classifyErrorKind(err: UpstreamErrorInfo): UpstreamErrorKind {
  // ① 无响应：网络失败 / 超时 / 中止。此时没有上游消息可分类。
  if (err.status === null) return 'channel';

  const m = String(err.message || '');

  // ② 文本检测（先于状态码，理由见函数注释）。额度耗尽是账号级，必须先于限流判定。
  if (CAP_MSG.test(m)) return 'account';
  if (RATE_LIMIT_MSG.test(m)) return 'channel';
  if (ACCOUNT_MSG.test(m)) return 'account';
  if (PROVIDER_MSG.test(m)) return 'channel';
  if (TIMEOUT_MSG.test(m)) return 'channel';

  // ③ 状态码检测
  if (err.status === 401 || err.status === 402 || err.status === 403) return 'account';
  if (err.status === 429 || err.status >= 500) return 'channel';

  // ④ 其余 4xx：参数错误 / 模型不存在等，重试与换渠道都不会有不同结果
  if (err.status >= 400 && err.status < 500) return 'request';

  // ⑤ 200 却带未知错误体等意外情况：按渠道级处理（宁切换勿卡死）
  return 'channel';
}
