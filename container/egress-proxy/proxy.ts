// Roster's egress proxy (ADR 0023, plan 002 section 9.6). A zero-dependency HTTP CONNECT proxy:
// it tunnels only CONNECT requests to the `host:443` pairs given as arguments, answers 403 to
// everything else, never forwards plain HTTP, and writes one JSON line per decision to stdout.
//
//   node proxy.ts api.anthropic.com            listens on port 3128
//
// Log lines (stdout, one JSON object each, `time` in ISO 8601 UTC):
//   {"time":…,"event":"listening","port":3128,"allow":["api.anthropic.com:443"]}
//   {"time":…,"event":"decision","decision":"allow","method":"CONNECT","target":"api.anthropic.com:443"}
//   {"time":…,"event":"decision","decision":"deny","reason":"host-not-allowed","method":"CONNECT","target":"example.com:443"}
//   {"time":…,"event":"upstream-error","target":"api.anthropic.com:443","error":"…"}
// Deny reasons: plain-http, malformed-request, malformed-target, port-not-allowed, host-not-allowed.
// Plain HTTP requests log only their host, never the path or query.
//
// Parsing and the allow/deny decision are pure functions in decision.ts.

import http from 'node:http';
import net from 'node:net';
import type { Duplex } from 'node:stream';
import {
  ALLOWED_PORT,
  decide,
  formatLogLine,
  LISTEN_PORT,
  loggedTarget,
  parseAllowlist,
  plainRequestTarget,
  rawResponse,
} from './decision.ts';
import type { LogEntry } from './decision.ts';

/** Opens the upstream TCP connection; replaced in tests. */
export type Connector = (host: string, port: number) => net.Socket;

export interface ProxyOptions {
  readonly allowlist: ReadonlySet<string>;
  readonly log: (line: string) => void;
  readonly connect?: Connector;
  readonly now?: () => Date;
  /** Upstream connect timeout in milliseconds. */
  readonly connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

function refuse(socket: Duplex, status: 403 | 502): void {
  if (socket.writable) socket.end(rawResponse(status));
  else socket.destroy();
  setTimeout(() => socket.destroy(), 1_000).unref();
}

export function createProxyServer(options: ProxyOptions): http.Server {
  const connect: Connector = options.connect ?? ((host, port) => net.connect({ host, port }));
  const now = options.now ?? (() => new Date());
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const log = (entry: LogEntry): void => options.log(formatLogLine(entry, now()));

  const server = http.createServer((req, res) => {
    log({
      event: 'decision',
      decision: 'deny',
      reason: 'plain-http',
      method: loggedTarget(req.method),
      target: loggedTarget(plainRequestTarget(req.url, req.headers.host)),
    });
    res.writeHead(403, { 'content-length': '0', connection: 'close' }).end();
  });

  // Requests with an `Upgrade` header are plain HTTP too.
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex) => {
    socket.on('error', () => socket.destroy());
    log({
      event: 'decision',
      decision: 'deny',
      reason: 'plain-http',
      method: loggedTarget(req.method),
      target: loggedTarget(plainRequestTarget(req.url, req.headers.host)),
    });
    refuse(socket, 403);
  });

  server.on('connect', (req: http.IncomingMessage, client: Duplex, head: Buffer) => {
    client.on('error', () => client.destroy());
    const target = loggedTarget(req.url);
    const decision = decide(req.method, req.url, options.allowlist);
    if (decision.decision === 'deny') {
      log({ event: 'decision', decision: 'deny', reason: decision.reason, method: 'CONNECT', target });
      refuse(client, 403);
      return;
    }

    const authority = `${decision.host}:${decision.port}`;
    log({ event: 'decision', decision: 'allow', method: 'CONNECT', target: authority });
    const upstream = connect(decision.host, decision.port);
    let established = false;
    upstream.setTimeout(timeoutMs, () => upstream.destroy(new Error(`connect timeout after ${timeoutMs} ms`)));
    upstream.once('connect', () => {
      established = true;
      upstream.setTimeout(0);
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', (error: Error) => {
      log({ event: 'upstream-error', target: authority, error: error.message });
      if (established) client.destroy();
      else refuse(client, 502);
    });
    upstream.on('close', () => {
      if (established) client.destroy();
    });
    client.on('close', () => upstream.destroy());
  });

  server.on('clientError', (error: NodeJS.ErrnoException, socket: Duplex) => {
    if (error.code === 'ECONNRESET' || !socket.writable) {
      socket.destroy();
      return;
    }
    log({ event: 'decision', decision: 'deny', reason: 'malformed-request' });
    refuse(socket, 403);
  });

  return server;
}

function main(argv: readonly string[]): void {
  const parsed = parseAllowlist(argv);
  if (!parsed.ok) {
    process.stderr.write(`egress-proxy: ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const write = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const server = createProxyServer({ allowlist: parsed.hosts, log: write });
  server.listen(LISTEN_PORT, () => {
    const allow = [...parsed.hosts].map((host) => `${host}:${ALLOWED_PORT}`);
    write(formatLogLine({ event: 'listening', port: LISTEN_PORT, allow }, new Date()));
  });
  // PID 1 in a container ignores signals without a handler; `docker stop` must still stop the proxy.
  const stop = (): void => {
    server.close();
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (import.meta.main) main(process.argv.slice(2));
