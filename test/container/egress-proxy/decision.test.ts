import { describe, expect, it } from 'vitest';
import {
  decide,
  formatLogLine,
  isHostname,
  loggedTarget,
  MAX_LOGGED_TARGET,
  parseAllowlist,
  parseConnectTarget,
  plainRequestTarget,
  rawResponse,
} from '../../../container/egress-proxy/decision.ts';

const ALLOW = new Set(['api.anthropic.com']);

describe('parseAllowlist', () => {
  it('accepts bare hosts and host:443, lowercased and deduplicated', () => {
    const result = parseAllowlist(['api.anthropic.com', 'API.Anthropic.com:443', 'registry.npmjs.org']);
    expect(result).toEqual({ ok: true, hosts: new Set(['api.anthropic.com', 'registry.npmjs.org']) });
  });

  it('rejects an empty list', () => {
    expect(parseAllowlist([]).ok).toBe(false);
  });

  it.each(['api.anthropic.com:80', 'api.anthropic.com:8443', 'api.anthropic.com:0'])('rejects a port other than 443: %s', (arg) => {
    const result = parseAllowlist([arg]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('only port 443');
  });

  it.each(['*.anthropic.com', '', 'api.anthropic.com.', 'http://api.anthropic.com', 'a b', '[::1]:443', 'host:443:443', '-bad.com'])(
    'rejects an invalid host: %j',
    (arg) => {
      const result = parseAllowlist([arg]);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('not a valid host name');
    },
  );
});

describe('isHostname', () => {
  it.each(['api.anthropic.com', 'localhost', 'a-b.c0', '10.0.0.1'])('accepts %s', (host) => {
    expect(isHostname(host)).toBe(true);
  });

  it.each(['', 'API.anthropic.com', 'a..b', 'a.-b', 'a_b.com', `${'a'.repeat(64)}.com`, `${'a.'.repeat(127)}aa`])('rejects %j', (host) => {
    expect(isHostname(host)).toBe(false);
  });
});

describe('parseConnectTarget', () => {
  it('parses host:port and lowercases the host', () => {
    expect(parseConnectTarget('API.Anthropic.COM:443')).toEqual({ host: 'api.anthropic.com', port: 443 });
    expect(parseConnectTarget('example.com:8080')).toEqual({ host: 'example.com', port: 8080 });
  });

  it.each([
    undefined,
    '',
    'api.anthropic.com',
    ':443',
    'api.anthropic.com:',
    'api.anthropic.com:0',
    'api.anthropic.com:65536',
    'api.anthropic.com:123456',
    'api.anthropic.com:44a',
    'api.anthropic.com :443',
    'user@api.anthropic.com:443',
    'https://api.anthropic.com:443',
    '[::1]:443',
    '/path',
    'api.anthropic.com:443/x',
  ])('returns null for a malformed target: %j', (raw) => {
    expect(parseConnectTarget(raw)).toBeNull();
  });
});

describe('decide', () => {
  it('allows CONNECT to an allowlisted host on port 443', () => {
    expect(decide('CONNECT', 'api.anthropic.com:443', ALLOW)).toEqual({ decision: 'allow', host: 'api.anthropic.com', port: 443 });
  });

  it('compares hosts exactly after lowercasing', () => {
    expect(decide('CONNECT', 'Api.Anthropic.Com:443', ALLOW).decision).toBe('allow');
    for (const target of [
      'anthropic.com:443',
      'evil.api.anthropic.com:443',
      'api.anthropic.com.evil.com:443',
      'api.anthropic.co:443',
      'xapi.anthropic.com:443',
    ]) {
      expect(decide('CONNECT', target, ALLOW)).toEqual({ decision: 'deny', reason: 'host-not-allowed' });
    }
  });

  it('denies another host', () => {
    expect(decide('CONNECT', 'example.com:443', ALLOW)).toEqual({ decision: 'deny', reason: 'host-not-allowed' });
  });

  it('denies another port, even for an allowlisted host', () => {
    expect(decide('CONNECT', 'api.anthropic.com:80', ALLOW)).toEqual({ decision: 'deny', reason: 'port-not-allowed' });
    expect(decide('CONNECT', 'api.anthropic.com:22', ALLOW)).toEqual({ decision: 'deny', reason: 'port-not-allowed' });
  });

  it.each(['GET', 'POST', 'PUT', 'HEAD', 'connect', undefined])('denies plain HTTP (%s) even to an allowlisted host', (method) => {
    expect(decide(method, 'http://api.anthropic.com/v1/messages', ALLOW)).toEqual({ decision: 'deny', reason: 'plain-http' });
    expect(decide(method, 'api.anthropic.com:443', ALLOW)).toEqual({ decision: 'deny', reason: 'plain-http' });
  });

  it('denies a malformed CONNECT target', () => {
    expect(decide('CONNECT', 'api.anthropic.com', ALLOW)).toEqual({ decision: 'deny', reason: 'malformed-target' });
    expect(decide('CONNECT', undefined, ALLOW)).toEqual({ decision: 'deny', reason: 'malformed-target' });
  });

  it('denies everything with an empty allowlist', () => {
    expect(decide('CONNECT', 'api.anthropic.com:443', new Set()).decision).toBe('deny');
  });
});

describe('plainRequestTarget', () => {
  it('keeps only the authority of an absolute-form URL', () => {
    expect(plainRequestTarget('http://example.com:8080/path?token=secret', undefined)).toBe('example.com:8080');
    expect(plainRequestTarget('http://user:pass@example.com/x', 'other')).toBe('example.com');
  });

  it('falls back to the Host header for origin-form requests', () => {
    expect(plainRequestTarget('/path?token=secret', 'example.com')).toBe('example.com');
    expect(plainRequestTarget('/path', undefined)).toBeUndefined();
  });

  it('returns undefined for an unparsable absolute URL', () => {
    expect(plainRequestTarget('http://[bad/', 'example.com')).toBeUndefined();
  });
});

describe('log formatting', () => {
  it('cuts long client values', () => {
    expect(loggedTarget('a'.repeat(1000))).toHaveLength(MAX_LOGGED_TARGET);
    expect(loggedTarget('short')).toBe('short');
    expect(loggedTarget(undefined)).toBeUndefined();
  });

  it('writes one JSON object per line with the time first', () => {
    const line = formatLogLine(
      { event: 'decision', decision: 'deny', reason: 'host-not-allowed', method: 'CONNECT', target: 'x.com:443\n{"forged":1}' },
      new Date('2026-10-31T01:02:03.000Z'),
    );
    expect(line).not.toContain('\n');
    expect(JSON.parse(line)).toEqual({
      time: '2026-10-31T01:02:03.000Z',
      event: 'decision',
      decision: 'deny',
      reason: 'host-not-allowed',
      method: 'CONNECT',
      target: 'x.com:443\n{"forged":1}',
    });
    expect(Object.keys(JSON.parse(line))[0]).toBe('time');
  });

  it('builds raw 403 and 502 responses', () => {
    expect(rawResponse(403)).toBe('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    expect(rawResponse(502)).toMatch(/^HTTP\/1\.1 502 Bad Gateway\r\n/);
  });
});
