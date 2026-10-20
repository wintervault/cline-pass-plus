import { type Logger, pino } from 'pino';

/**
 * 所有可能承载密钥的字段名。pino 的 redact 路径用点号分隔，`*` 匹配一层。
 * 这里同时覆盖顶层与一层嵌套（config.accounts[].key 这类更深的结构由调用方负责不整包打日志）。
 */
const REDACT_PATHS = [
  'key',
  'apiKey',
  'proxyKey',
  'authorization',
  '*.key',
  '*.apiKey',
  '*.proxyKey',
  '*.authorization',
  // 数组形状（config.accounts / config.gateways）——防御性：目前没有代码整包打日志，
  // 但以后有人 `logger.info({ config })` 时不能让明文密钥落盘。
  'accounts[*].key',
  'gateways[*].proxyKey',
  'req.headers.authorization',
  'req.headers["x-admin-key"]',
  'headers.authorization',
  'headers["x-admin-key"]',
];

const level = process.env.LOG_LEVEL?.trim() || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

export const logger: Logger = pino({
  level,
  redact: { paths: REDACT_PATHS, censor: '[redacted]' },
  base: undefined, // 不打 pid/hostname，本地工具噪音大
  timestamp: pino.stdTimeFunctions.isoTime,
});

/** 给各模块用的子 logger，绑定 module 字段便于过滤。 */
export function moduleLogger(module: string): Logger {
  return logger.child({ module });
}
