import type http from 'node:http';
import net from 'node:net';
import type { Handler, Middleware } from '../http/router.ts';
import { createHttpServer, shutdownServer } from '../http/server.ts';
import { logger } from '../log/logger.ts';

/**
 * 预检监听目标：先在一个临时 socket 上试绑，失败就返回原因。
 *
 * 用途：保存控制台设置前先确认新端口/地址可用。否则「先写配置、再关旧
 * listener、最后绑新端口」一旦失败，用户会失去正在访问的控制台——
 * 明明只是改端口，却把自己锁在门外。
 */
export function probeBind(port: number, bindHost: string): Promise<string | null> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    let settled = false;
    const done = (err: string | null): void => {
      if (settled) return;
      settled = true;
      probe.removeAllListeners();
      // 绑定失败时没有监听句柄需要关；成功时先关掉临时 socket 再返回
      if (err) {
        resolve(err);
        return;
      }
      probe.close(() => resolve(null));
    };
    probe.once('error', (err: Error) => done(err.message));
    probe.once('listening', () => done(null));
    try {
      probe.listen(port, bindHost);
    } catch (err) {
      done(err instanceof Error ? err.message : String(err));
    }
  });
}

export type ConsoleState = 'running' | 'error' | 'stopped';

export interface ConsoleStatus {
  state: ConsoleState;
  /** 实际监听端口（配置值）；未运行时为 null。 */
  boundPort: number | null;
  boundHost: string | null;
  /** state=error 时的原因（端口占用、地址不可用等）。 */
  error?: string;
}

export interface ConsoleManagerDeps {
  /** 控制台当前的监听目标（来自配置；环境变量覆盖已生效）。 */
  target: () => { port: number; bindHost: string };
  handler: Handler;
  middleware: readonly Middleware[];
  onStateChange?: (status: ConsoleStatus) => void;
}

/**
 * 控制台监听管理器（2.1 起与网关解耦）。
 *
 * 只做一件事：把「配置里的控制台监听目标」变成真实的 listener。与网关管理器
 * 同样的三条约束：
 * 1. reconcile 是唯一入口（启动、保存设置都走它）；
 * 2. 串行执行——连点保存时两个 reconcile 交错会重复绑定或关掉刚起来的 listener；
 * 3. 绑不上只标 error 并写原因，不抛出（控制台本来就是唯一能看到这个原因的地方）。
 */
export class ConsoleManager {
  readonly #deps: ConsoleManagerDeps;
  #server: http.Server | null = null;
  #bound: { port: number; bindHost: string } | null = null;
  #status: ConsoleStatus = { state: 'stopped', boundPort: null, boundHost: null };
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: ConsoleManagerDeps) {
    this.#deps = deps;
  }

  status(): ConsoleStatus {
    return this.#status;
  }

  reconcile(): Promise<void> {
    const run = this.#queue.then(
      () => this.#reconcile(),
      () => this.#reconcile(),
    );
    this.#queue = run.catch(() => {});
    return run;
  }

  async #reconcile(): Promise<void> {
    const want = this.#deps.target();
    if (this.#server && this.#bound && this.#bound.port === want.port && this.#bound.bindHost === want.bindHost) {
      return;
    }
    if (this.#server) await this.#close(3_000);
    await this.#bind(want);
  }

  async close(graceMs = 30_000): Promise<void> {
    await this.#close(graceMs);
  }

  async #bind(want: { port: number; bindHost: string }): Promise<void> {
    let server: http.Server | null = null;
    try {
      server = createHttpServer({
        gatewayId: 'console',
        handler: this.#deps.handler,
        middleware: this.#deps.middleware,
      });
      const created = server;
      this.#server = created;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error): void => {
          created.off('listening', onListening);
          reject(err);
        };
        const onListening = (): void => {
          created.off('error', onError);
          resolve();
        };
        created.once('error', onError);
        created.once('listening', onListening);
        created.listen(want.port, want.bindHost);
      });
      this.#bound = want;
      this.#status = { state: 'running', boundPort: want.port, boundHost: want.bindHost };
      logger.info({ port: want.port, host: want.bindHost }, '控制台已启动');
    } catch (err) {
      server?.close(() => {});
      this.#server = null;
      this.#bound = null;
      const message = err instanceof Error ? err.message : String(err);
      this.#status = { state: 'error', error: message, boundPort: null, boundHost: null };
      logger.error({ port: want.port, host: want.bindHost, err }, '控制台绑定失败');
    }
    this.#deps.onStateChange?.(this.#status);
  }

  async #close(graceMs: number): Promise<void> {
    const server = this.#server;
    this.#server = null;
    this.#bound = null;
    if (server) await shutdownServer(server, { graceMs });
    this.#status = { state: 'stopped', boundPort: null, boundHost: null };
    this.#deps.onStateChange?.(this.#status);
  }
}
