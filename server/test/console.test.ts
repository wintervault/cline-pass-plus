import net from 'node:net';
import { describe, expect, it } from 'vitest';

import { probeBind } from '../src/console/manager.ts';

function listenNet(server: net.Server): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('无法取得监听端口');
      resolve({
        port: address.port,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

describe('probeBind（保存控制台设置前的预检）', () => {
  it('端口空闲 → 返回 null', async () => {
    const blocker = net.createServer();
    const { port, close } = await listenNet(blocker);
    await close();
    expect(await probeBind(port, '127.0.0.1')).toBeNull();
  });

  it('端口被占用 → 返回错误，而不是先关掉当前控制台', async () => {
    const blocker = net.createServer((socket) => socket.end());
    const { port, close } = await listenNet(blocker);
    const error = await probeBind(port, '127.0.0.1');
    expect(error).toBeTruthy();
    await close();
  });
});
