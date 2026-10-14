import { describe, it, expect } from 'vitest';
import { loadConfig, normalizeUrl, withoutUnexpanded } from '../src/config.js';

describe('normalizeUrl', () => {
  it('appends /api/v1 exactly once and normalizes trailing slashes', () => {
    expect(normalizeUrl('https://git.example.com/').apiBase).toBe('https://git.example.com/api/v1');
    expect(normalizeUrl('https://git.example.com/api/v1').apiBase).toBe('https://git.example.com/api/v1');
    expect(normalizeUrl('https://git.example.com/git/').apiBase).toBe('https://git.example.com/git/api/v1');
  });

  it('flags http as insecure but accepts it', () => {
    expect(normalizeUrl('http://127.0.0.1:3000').insecure).toBe(true);
  });

  it('rejects userinfo, query, fragment and non-http schemes', () => {
    expect(() => normalizeUrl('https://user:pass@git.example.com')).toThrow();
    expect(() => normalizeUrl('https://git.example.com?x=1')).toThrow();
    expect(() => normalizeUrl('https://git.example.com#f')).toThrow();
    expect(() => normalizeUrl('ftp://git.example.com')).toThrow();
  });

  it('rejects path traversal', () => {
    expect(() => normalizeUrl('https://git.example.com/../etc')).toThrow();
  });
});

describe('loadConfig', () => {
  it('defaults writes=off and timeout=30000, records a URL error when unset', () => {
    const c = loadConfig({});
    expect(c.writes).toBe('off');
    expect(c.timeoutMs).toBe(30000);
    expect(c.urlError).toBeTruthy();
  });

  it('treats an invalid write mode as off and records it', () => {
    const c = loadConfig({ VBCDX_FORGEJO_URL: 'https://git.example.com', VBCDX_FORGEJO_WRITES: 'yes' });
    expect(c.writes).toBe('off');
    expect(c.writesInvalid).toBe('yes');
  });

  it('rejects an out-of-range or non-integer timeout', () => {
    expect(loadConfig({ VBCDX_FORGEJO_URL: 'https://x.example', VBCDX_FORGEJO_TIMEOUT_MS: '10' }).timeoutError).toBeTruthy();
    expect(loadConfig({ VBCDX_FORGEJO_URL: 'https://x.example', VBCDX_FORGEJO_TIMEOUT_MS: 'abc' }).timeoutError).toBeTruthy();
    expect(loadConfig({ VBCDX_FORGEJO_URL: 'https://x.example', VBCDX_FORGEJO_TIMEOUT_MS: '5000' }).timeoutMs).toBe(5000);
  });

  it('does not echo the raw URL value in the error', () => {
    const c = loadConfig({ VBCDX_FORGEJO_URL: 'https://user:supersecret@git.example.com' });
    expect(c.urlError).toBeTruthy();
    expect(c.urlError).not.toContain('supersecret');
  });
});

// Hermes passes an unset `${VAR}` reference through as literal text.
describe('an unexpanded ${VAR} counts as unset', () => {
  const URL_OK = { VBCDX_FORGEJO_URL: 'https://git.example.com' };

  it('an optional timeout takes its default instead of failing every call', () => {
    const c = loadConfig({ ...URL_OK, VBCDX_FORGEJO_TIMEOUT_MS: '${VBCDX_FORGEJO_TIMEOUT_MS}' });
    expect(c.timeoutError).toBeNull();
    expect(c.timeoutMs).toBe(30000);
  });

  it('the write gate stays off without reporting an invalid mode', () => {
    const c = loadConfig({ ...URL_OK, VBCDX_FORGEJO_WRITES: '${VBCDX_FORGEJO_WRITES}' });
    expect(c.writes).toBe('off');
    expect(c.writesInvalid).toBeNull();
  });

  it('the URL reads as not set', () => {
    expect(loadConfig({ VBCDX_FORGEJO_URL: ' ${VBCDX_FORGEJO_URL} ' }).urlError).toMatch(/is not set/);
  });

  it('only a whole-value reference is dropped; anything else is still checked', () => {
    expect(loadConfig({ ...URL_OK, VBCDX_FORGEJO_TIMEOUT_MS: '${X}0' }).timeoutError).toBeTruthy();
    expect(loadConfig({ ...URL_OK, VBCDX_FORGEJO_TIMEOUT_MS: '$X' }).timeoutError).toBeTruthy();
    expect(loadConfig({ ...URL_OK, VBCDX_FORGEJO_WRITES: '${1X}' }).writesInvalid).toBe('${1X}');
  });

  it('withoutUnexpanded touches only VBCDX_FORGEJO_* references', () => {
    const env = { VBCDX_FORGEJO_WRITES: '${A}', VBCDX_FORGEJO_URL: 'https://x.example', OTHER: '${B}' };
    expect(withoutUnexpanded(env)).toEqual({ VBCDX_FORGEJO_URL: 'https://x.example', OTHER: '${B}' });
    expect(env.VBCDX_FORGEJO_WRITES).toBe('${A}'); // the caller's object is not changed
  });
});
