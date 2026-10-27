import { parseRouting, type RoutingInfo } from './routing.ts';

/** 把任意形态的上游错误归一成短字符串（用于分类、学习与尝试日志）。 */
export function errText(e: unknown): string {
  if (e == null) return '';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

export interface Unwrapped {
  status: number;
  body: Record<string, unknown>;
  routing: RoutingInfo;
  /** 归一化后的错误文本；成功时为 null。 */
  error: string | null;
}

/**
 * 解包上游响应：
 * - 剥掉 Cline 的 `{"data": {...}}` 包装，得到标准 OpenAI 形状；
 * - 错误统一成 `{"error":{"message":...}}`——「model not found」映射 404，其余映射 502；
 * - 同时解析路由元数据（实际上游、背后模型），供响应头与历史记录使用。
 *
 * 纯函数，不改入参。
 */
export function unwrap(json: unknown): Unwrapped {
  const top =
    json !== null && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {};
  const innerData = top['data'];
  // data 包装的两种形态都取内层：{"data":{choices:[...]}} 成功体、{"data":{error:...}} 错误体
  const d =
    innerData !== null &&
    typeof innerData === 'object' &&
    !Array.isArray(innerData) &&
    (Array.isArray((innerData as Record<string, unknown>)['choices']) ||
      'error' in (innerData as Record<string, unknown>))
      ? (innerData as Record<string, unknown>)
      : top;

  const hasChoices = Array.isArray(d['choices']);
  const err = d['error'];

  if (err && !hasChoices) {
    const msg = errText(err);
    const status = /model not found/i.test(msg) ? 404 : 502;
    return {
      status,
      body: { error: { message: msg, type: 'upstream_error' } },
      routing: parseRouting(d),
      error: msg,
    };
  }

  // Cline 网关的额度/上游错误是顶层 `{"code":"INFERENCE_CAP_ERROR","message":"..."}`：
  // 既没有 error 包装，也没有 choices。不识别就会被当成成功体交给客户端，而且
  // 链上的分类看不到错误文本——额度耗尽的账号因此一直粘着不切（2.1.5 修）。
  const code = d['code'];
  if (!hasChoices && typeof code === 'string' && code !== '' && typeof d['message'] === 'string') {
    const msg = errText(d);
    // 额度/付费类 code 用 402（Payment Required）：即便文本以后变了，
    // 「状态码 → 账号级」这条兜底仍然成立。
    const status = /cap|quota|credit|limit|billing|payment/i.test(code) ? 402 : 502;
    return {
      status,
      body: { error: { message: msg, type: 'upstream_error' } },
      routing: parseRouting(d),
      error: msg,
    };
  }

  return { status: 200, body: d, routing: parseRouting(d), error: null };
}
