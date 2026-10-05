import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { RpcConnection, RpcError } from '../../src/adapters/codex/rpc.ts';

function connect(onRequest: (method: string, params: unknown) => Promise<unknown> = async () => ({})) {
  const fromServer = new PassThrough();
  const toServer = new PassThrough();
  const notifications: [string, unknown][] = [];
  const rpc = new RpcConnection(fromServer, toServer, {
    onNotification: (method, params) => notifications.push([method, params]),
    onRequest,
  });
  const sent: unknown[] = [];
  toServer.setEncoding('utf8').on('data', (chunk: string) => {
    for (const line of chunk.split('\n').filter(Boolean)) sent.push(JSON.parse(line));
  });
  const serverSays = (message: unknown) => fromServer.write(JSON.stringify(message) + '\n');
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { rpc, sent, notifications, serverSays, flush };
}

describe('RpcConnection', () => {
  it('matches responses to requests', async () => {
    const { rpc, sent, serverSays, flush } = connect();
    const first = rpc.request('a', { x: 1 });
    const second = rpc.request('b');
    await flush();
    expect(sent).toEqual([{ id: 1, method: 'a', params: { x: 1 } }, { id: 2, method: 'b' }]);
    serverSays({ id: 2, result: 'two' });
    serverSays({ id: 1, result: 'one' });
    expect(await first).toBe('one');
    expect(await second).toBe('two');
  });

  it('rejects with RpcError on an error response', async () => {
    const { rpc, serverSays } = connect();
    const pending = rpc.request('a');
    serverSays({ id: 1, error: { code: -32600, message: 'bad' } });
    await expect(pending).rejects.toEqual(new RpcError(-32600, 'bad'));
  });

  it('delivers notifications and skips lines that are not JSON', async () => {
    const { notifications, serverSays, flush } = connect();
    serverSays({ method: 'n', params: { y: 2 } });
    await flush();
    expect(notifications).toEqual([['n', { y: 2 }]]);
  });

  it('answers server requests with the handler result or error', async () => {
    const { sent, serverSays, flush } = connect(async (method) => {
      if (method === 'ok') return { fine: true };
      throw new RpcError(-32601, 'nope');
    });
    serverSays({ id: 'x', method: 'ok', params: {} });
    serverSays({ id: 'y', method: 'other', params: {} });
    await flush();
    await flush();
    expect(sent).toEqual([
      { id: 'x', result: { fine: true } },
      { id: 'y', error: { code: -32601, message: 'nope' } },
    ]);
  });

  it('rejects pending and later requests after close', async () => {
    const { rpc } = connect();
    const pending = rpc.request('a');
    rpc.close(new Error('gone'));
    await expect(pending).rejects.toThrow('gone');
    await expect(rpc.request('b')).rejects.toThrow('gone');
  });
});
