// Pure parsing and allow/deny logic of Roster's egress proxy (ADR 0023, plan 002 section 9.6).
// No I/O here: proxy.ts owns the sockets and calls these functions. Zero dependencies, so the file
// runs unchanged inside the proxy image through Node's type stripping.

/** Port the proxy listens on inside its container (`http://<proxy-name>:3128`, spike finding 8). */
export const LISTEN_PORT = 3128;

/** The only destination port the proxy ever forwards to. */
export const ALLOWED_PORT = 443;

/** Longest target text written to the log; longer values are cut to keep log lines bounded. */
export const MAX_LOGGED_TARGET = 255;

const LABEL = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})*$`);
const AUTHORITY = /^([^:]+):([0-9]{1,5})$/;

export type DenyReason =
  | 'plain-http'
  | 'malformed-request'
  | 'malformed-target'
  | 'port-not-allowed'
  | 'host-not-allowed';

export type Decision =
  | { readonly decision: 'allow'; readonly host: string; readonly port: number }
  | { readonly decision: 'deny'; readonly reason: DenyReason };

export type AllowlistResult =
  | { readonly ok: true; readonly hosts: ReadonlySet<string> }
  | { readonly ok: false; readonly error: string };

export interface ConnectTarget {
  readonly host: string;
  readonly port: number;
}

/** True for a lowercase DNS name or dotted IPv4 literal; no wildcards, no trailing dot, no IPv6. */
export function isHostname(value: string): boolean {
  return HOSTNAME.test(value);
}

/**
 * Parses the proxy's command-line arguments. Each argument is `host` or `host:443`; hosts are
 * lowercased. Any other port, an invalid host or an empty list is a configuration error.
 */
export function parseAllowlist(args: readonly string[]): AllowlistResult {
  if (args.length === 0) {
    return { ok: false, error: 'no allowed host given; usage: proxy.ts <host>[:443] ...' };
  }
  const hosts = new Set<string>();
  for (const arg of args) {
    const lowered = arg.toLowerCase();
    const match = AUTHORITY.exec(lowered);
    const host = match ? (match[1] ?? '') : lowered;
    if (match && Number(match[2]) !== ALLOWED_PORT) {
      return { ok: false, error: `only port ${ALLOWED_PORT} may be allowed: ${JSON.stringify(arg)}` };
    }
    if (!isHostname(host)) {
      return { ok: false, error: `not a valid host name: ${JSON.stringify(arg)}` };
    }
    hosts.add(host);
  }
  return { ok: true, hosts };
}

/**
 * Parses the authority-form target of a CONNECT request (`host:port`). Returns null when the target
 * is not a valid host name followed by a port in 1-65535.
 */
export function parseConnectTarget(raw: string | undefined): ConnectTarget | null {
  if (raw === undefined) return null;
  const match = AUTHORITY.exec(raw.toLowerCase());
  if (!match) return null;
  const host = match[1] ?? '';
  const port = Number(match[2]);
  if (!isHostname(host) || port < 1 || port > 65535) return null;
  return { host, port };
}

/**
 * Decides one request. Only `CONNECT` to an allowlisted host on port 443 is allowed; hosts are
 * compared exactly after lowercasing. Every other method is plain HTTP and is never forwarded.
 */
export function decide(method: string | undefined, target: string | undefined, allowlist: ReadonlySet<string>): Decision {
  if (method !== 'CONNECT') return { decision: 'deny', reason: 'plain-http' };
  const parsed = parseConnectTarget(target);
  if (parsed === null) return { decision: 'deny', reason: 'malformed-target' };
  if (parsed.port !== ALLOWED_PORT) return { decision: 'deny', reason: 'port-not-allowed' };
  if (!allowlist.has(parsed.host)) return { decision: 'deny', reason: 'host-not-allowed' };
  return { decision: 'allow', host: parsed.host, port: parsed.port };
}

/**
 * The part of a plain HTTP request worth logging: the authority of an absolute-form URL, else the
 * Host header. Paths and query strings are never logged, so nothing they carry reaches the log.
 */
export function plainRequestTarget(url: string | undefined, hostHeader: string | undefined): string | undefined {
  if (url !== undefined && /^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      return new URL(url).host;
    } catch {
      return undefined;
    }
  }
  return hostHeader;
}

/** Cuts a client-supplied value to a bounded length for the log. */
export function loggedTarget(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_LOGGED_TARGET ? value.slice(0, MAX_LOGGED_TARGET) : value;
}

export type LogEntry =
  | {
      readonly event: 'decision';
      readonly decision: 'allow' | 'deny';
      readonly reason?: DenyReason;
      readonly method?: string;
      readonly target?: string;
    }
  | { readonly event: 'upstream-error'; readonly target: string; readonly error: string }
  | { readonly event: 'listening'; readonly port: number; readonly allow: readonly string[] };

/** One JSON log line (without the newline): `time` in ISO 8601 UTC first, then the entry. */
export function formatLogLine(entry: LogEntry, now: Date): string {
  return JSON.stringify({ time: now.toISOString(), ...entry });
}

/** The raw HTTP/1.1 response written to a socket that is refused or failed. */
export function rawResponse(status: 403 | 502): string {
  const text = status === 403 ? 'Forbidden' : 'Bad Gateway';
  return `HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`;
}
