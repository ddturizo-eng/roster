// Socket-level tests of the egress proxy on 127.0.0.1. The upstream connector is replaced, so no test
// reaches the internet: allowed tunnels go to a local echo server.

import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createProxyServer } from '../../../container/egress-proxy/proxy.ts';
import type { Connector } from '../../../container/egress-proxy/proxy.ts';

const FIXED_NOW = new Date('2026-10-31T00:00:00.000Z');
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

function listen(server: net.Server | http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    closers.push(
      () =>
        new Promise<void>((done) => {
          (server as http.Server).closeAllConnections?.();
          server.close(() => done());
        }),
    );
  });
}

async function echoServer(): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => sockets.delete(socket));
    socket.pipe(socket);
  });
  const port = await listen(server);
  closers.push(async () => {
    for (const socket of sockets) socket.destroy();
  });
  return port;
}

interface Harness {
  port: number;
  lines: string[];
  connects: Array<{ host: string; port: number }>;
}

async function startProxy(connectTo: (host: string, port: number) => net.Socket): Promise<Harness> {
  const lines: string[] = [];
  const connects: Array<{ host: string; port: number }> = [];
  const connect: Connector = (host, port) => {
    connects.push({ host, port });
    return connectTo(host, port);
  };
  const server = createProxyServer({
    allowlist: new Set(['api.anthropic.com']),
    log: (line) => lines.push(line),
    connect,
    now: () => FIXED_NOW,
    connectTimeoutMs: 2_000,
  });
  const port = await listen(server);
  return { port, lines, connects };
}

/** Sends raw bytes and collects everything the proxy answers until it closes or `until` matches. */
function exchange(port: number, request: string, until?: RegExp): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1');
    let received = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`no complete answer; got ${JSON.stringify(received)}`));
    }, 3_000);
    const finish = (): void => {
      clearTimeout(timer);
      socket.destroy();
      resolve(received);
    };
    socket.on('data', (chunk) => {
      received += chunk.toString('latin1');
      if (until?.test(received)) finish();
    });
    socket.on('close', finish);
    socket.on('error', () => undefined);
    socket.write(request, 'latin1');
  });
}

const parsed = (lines: string[]): unknown[] => lines.map((line) => JSON.parse(line) as unknown);

describe('egress proxy server', () => {
  it('tunnels CONNECT to an allowlisted host on 443, including bytes sent with the request', async () => {
    const echoPort = await echoServer();
    const proxy = await startProxy(() => net.connect(echoPort, '127.0.0.1'));
    const answer = await exchange(
      proxy.port,
      'CONNECT API.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\nhello-through-tunnel',
      /hello-through-tunnel$/,
    );
    expect(answer).toBe('HTTP/1.1 200 Connection Established\r\n\r\nhello-through-tunnel');
    expect(proxy.connects).toEqual([{ host: 'api.anthropic.com', port: 443 }]);
    expect(parsed(proxy.lines)).toEqual([
      {
        time: FIXED_NOW.toISOString(),
        event: 'decision',
        decision: 'allow',
        method: 'CONNECT',
        target: 'api.anthropic.com:443',
      },
    ]);
  });

  it.each([
    ['another host', 'example.com:443', 'host-not-allowed'],
    ['another port', 'api.anthropic.com:80', 'port-not-allowed'],
    ['a malformed target', 'api.anthropic.com', 'malformed-target'],
  ])('answers 403 to CONNECT with %s and never connects', async (_name, target, reason) => {
    const proxy = await startProxy(() => {
      throw new Error('must not connect');
    });
    const answer = await exchange(proxy.port, `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(proxy.connects).toEqual([]);
    expect(parsed(proxy.lines)).toEqual([
      { time: FIXED_NOW.toISOString(), event: 'decision', decision: 'deny', reason, method: 'CONNECT', target },
    ]);
  });

  it('answers 403 to plain HTTP, never forwards it, and logs only the host', async () => {
    const proxy = await startProxy(() => {
      throw new Error('must not connect');
    });
    const answer = await exchange(
      proxy.port,
      'GET http://api.anthropic.com/v1/messages?key=secret HTTP/1.1\r\nHost: api.anthropic.com\r\n\r\n',
    );
    expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(proxy.connects).toEqual([]);
    expect(proxy.lines.join('\n')).not.toContain('secret');
    expect(parsed(proxy.lines)).toEqual([
      {
        time: FIXED_NOW.toISOString(),
        event: 'decision',
        decision: 'deny',
        reason: 'plain-http',
        method: 'GET',
        target: 'api.anthropic.com',
      },
    ]);
  });

  it('answers 403 to a plain HTTP upgrade request', async () => {
    const proxy = await startProxy(() => {
      throw new Error('must not connect');
    });
    const answer = await exchange(
      proxy.port,
      'GET /socket HTTP/1.1\r\nHost: api.anthropic.com\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n',
    );
    expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(proxy.connects).toEqual([]);
    expect(parsed(proxy.lines)).toMatchObject([{ event: 'decision', decision: 'deny', reason: 'plain-http', method: 'GET' }]);
  });

  it('answers 403 to a malformed request', async () => {
    const proxy = await startProxy(() => {
      throw new Error('must not connect');
    });
    const answer = await exchange(proxy.port, 'NOT A VALID REQUEST\r\n\r\n');
    expect(answer).toMatch(/^HTTP\/1\.1 403 Forbidden\r\n/);
    expect(proxy.connects).toEqual([]);
    expect(parsed(proxy.lines)).toEqual([
      { time: FIXED_NOW.toISOString(), event: 'decision', decision: 'deny', reason: 'malformed-request' },
    ]);
  });

  it('answers 502 and logs the error when the upstream connection fails', async () => {
    const closed = net.createServer();
    const deadPort = await listen(closed);
    await new Promise<void>((done) => closed.close(() => done()));
    const proxy = await startProxy(() => net.connect(deadPort, '127.0.0.1'));
    const answer = await exchange(proxy.port, 'CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n');
    expect(answer).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
    expect(parsed(proxy.lines)).toMatchObject([
      { event: 'decision', decision: 'allow', target: 'api.anthropic.com:443' },
      { event: 'upstream-error', target: 'api.anthropic.com:443' },
    ]);
  });
});
