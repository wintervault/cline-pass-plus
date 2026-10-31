import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AppContext } from '../src/appContext.ts';
import { defaultConfig } from '../src/config/schema.ts';
import { sendError } from '../src/http/respond.ts';
import type { Ctx } from '../src/http/router.ts';
import { chatHandler, isChatPath } from '../src/http/routes/chat.ts';
import { createHttpServer } from '../src/http/server.ts';
import { JsonStore } from '../src/store/jsonStore.ts';
import { blankModelMeta, defaultMeta, type MetaFile } from '../src/upstream/types.ts';
import { delay, listen } from './helpers/http.ts';
import { chainStream } from './helpers/stream.ts';

/**
 * 上游在 SSE 中途断开时，服务必须活下来。
 *
 * 线上实测（2.2.1，两次）：网关超时 / TLS 被重置 → undici 让响应体 stream 报
 * `TypeError: terminated` → `Readable.fromWeb(...).pipe(...)` 把错误抛成未捕获异常
 * → 进程退出，桌面壳还开着窗口，于是「程序没闪退，服务却没了，得手动重启」。
 *
 * 这里用真实 HTTP 栈复现：假上游写出两块 SSE 后销毁 socket，断言
 *   1) 没有任何未捕获异常；
 *   2) 客户端收到的是断流（不是假装正常结束的 200）；
 *   3) 请求历史记下一条失败记录（不再把中断的流转成「成功」）。
 */

let dir: string;
const closers: Array<() => Promise<void>> = [];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cps-chat-stream-'));
});

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  await fs.promises.rm(dir, { recursive: true, force: true });
});

/** 走真实 HTTP 的流式请求：连上就收数据，连接被掐断时以 aborted 结束，不抛给测试。 */
function streamRequest(port: number, body: unknown): Promise<{ status: number; text: string; aborted: boolean }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      },
      (res) => {
        let text = '';
        let aborted = false;
        res.setEncoding('utf8');
        res.on('data', (c: string) => {
          text += c;
        });
        res.on('aborted', () => {
          aborted = true;
        });
        res.on('error', () => {
          aborted = true;
        });
        res.on('close', () => resolve({ status: res.statusCode ?? 0, text, aborted: aborted || !res.complete }));
      },
    );
    req.on('error', reject);
    req.setTimeout(5_000, () => req.destroy(new Error('请求超时')));
    req.write(payload);
    req.end();
  });
}

async function harness() {
  const fx = await chainStream();
  closers.push(fx.close);

  const config = defaultConfig();
  config.accounts = [
    { name: 'A', key: 'sk_a' },
    { name: 'B', key: 'sk_b' },
  ];
  const gateway = config.gateways[0];
  if (!gateway) throw new Error('defaultConfig 没有网关');
  gateway.perModel['cline-pass/x'] = { upstreams: ['ch1'], exclude: [], pinMode: 'strict', sort: null };

  const meta = defaultMeta();
  meta.models['main'] = {
    'cline-pass/x': { ...blankModelMeta(), pipeline: 'planner', pinState: 'enforced', upstreams: ['ch1'] },
  };

  const configStore = new JsonStore(path.join(dir, 'config.json'), config, { debounceMs: 1 });
  const metaStore = new JsonStore<MetaFile>(path.join(dir, 'metadata.json'), meta, { debounceMs: 1 });
  closers.push(async () => {
    configStore.close();
    metaStore.close();
    await Promise.all([configStore.flush(), metaStore.flush()]);
  });

  const ctx: AppContext = {
    version: 'test',
    startedAt: Date.now(),
    configStore,
    metaStore,
    gateways: {
      get: (id: string) => (id === 'main' ? { chain: fx.chain } : null),
    } as unknown as AppContext['gateways'],
    console: {} as AppContext['console'],
    catalog: {} as AppContext['catalog'],
    probe: {} as AppContext['probe'],
    classify: {} as AppContext['classify'],
  };

  const server = createHttpServer({
    gatewayId: 'main',
    handler: (c: Ctx) => {
      if (isChatPath(c.path) && c.method === 'POST') return chatHandler(ctx, 'main')(c);
      sendError(c.res, 404, 'no route', 'not_found');
      return undefined;
    },
  });
  const { port, close } = await listen(server);
  closers.push(close);
  return { port, metaStore, upstream: fx.upstream };
}

describe('流式透传：上游中途断开', () => {
  it('不抛未捕获异常，客户端收到断流，历史记为失败', async () => {
    const { port, metaStore, upstream } = await harness();
    upstream.script([
      {
        status: 200,
        // 第一块被链路读作首块探测，第二块之后 socket 被销毁
        sse: [
          'data: {"choices":[{"delta":{"content":"he"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"llo"}}]}\n\n',
        ],
        abortAfter: 2,
      },
    ]);

    const escaped: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      escaped.push(err);
    };
    process.on('uncaughtException', onUncaught);

    try {
      const res = await streamRequest(port, {
        model: 'cline-pass/x',
        stream: true,
        messages: [{ role: 'user', content: 'hi' }],
      });

      expect(res.status).toBe(200);
      expect(res.aborted).toBe(true); // 断流，而不是「正常结束」
      expect(res.text).toContain('he');
      expect(escaped).toEqual([]); // 服务没被上游断开拖垮
    } finally {
      process.off('uncaughtException', onUncaught);
    }

    // 历史：一条失败记录，原因是中断（不能伪装成成功）
    await delay(50);
    await metaStore.flush();
    const entries = metaStore.value.history;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.stream).toBe(true);
    expect(entries[0]?.error).toMatch(/stream interrupted/);
  });

  it('客户端自己断开不算失败：不记历史', async () => {
    const { port, metaStore, upstream } = await harness();
    upstream.script([
      {
        status: 200,
        sse: [
          'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
          'data: [DONE]\n\n',
        ],
      },
    ]);

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    req.on('error', () => {});
    req.write(JSON.stringify({ model: 'cline-pass/x', stream: true, messages: [{ role: 'user', content: 'hi' }] }));
    req.end();
    // 收到首个数据块后客户端主动断开
    await new Promise<void>((resolve) =>
      req.on('response', (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
        res.resume();
      }),
    );

    await delay(600);
    await metaStore.flush();
    expect(metaStore.value.history).toHaveLength(0);
  });
});
