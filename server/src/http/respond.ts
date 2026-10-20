import type http from 'node:http';

/**
 * 所有响应统一带上的安全头。
 * 前端是 React 构建产物、没有内联脚本，所以 CSP 可以直接收紧到只允许同源资源。
 */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  /**
   * 前端是 React 构建产物、没有内联脚本，所以脚本只放行同源；
   * 样式必须允许内联（antd 以 <style> 注入）。
   * connect-src 额外放行回环任意端口——桌面壳的控制通道（默认 3122，
   * 被占用时退回系统分配）是跨端口同机来源。
   */
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' data:; font-src 'self' data:; connect-src 'self' http://127.0.0.1:*; " +
    "frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

/** 客户端已断开 / 响应已结束时的写保护：对这些 res 写入会抛未捕获异常，可能拖垮进程。 */
export function canRespond(res: http.ServerResponse): boolean {
  return !res.writableEnded && !res.destroyed && !res.headersSent;
}

export function applySecurityHeaders(res: http.ServerResponse): void {
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!res.hasHeader(k)) res.setHeader(k, v);
  }
}

export function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  if (!canRespond(res)) return;
  applySecurityHeaders(res);
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

/**
 * 统一的错误响应形状，与 OpenAI 兼容客户端期望的 `{error:{message}}` 一致。
 *
 * 控制台能看到的错误额外带稳定 `code + params`：前端按语言映射文案，
 * `message` 只作为日志与老客户端的兜底（见 i18n 决定 #13）。
 */
export function sendError(
  res: http.ServerResponse,
  status: number,
  message: string,
  type = 'invalid_request_error',
  code?: string,
  params?: Record<string, string | number>,
): void {
  sendJSON(res, status, { error: { message, type, ...(code ? { code, params } : {}) } });
}

export function sendText(
  res: http.ServerResponse,
  status: number,
  body: string,
  contentType = 'text/plain; charset=utf-8',
): void {
  if (!canRespond(res)) return;
  applySecurityHeaders(res);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
