// Launch configuration (spec §3).
//
// Only three service settings affect the server, and they are read exactly once
// per process. Nothing else — no CODE_HOST_*, no FORGEJO_AGENT, no ambient
// token/password, no VBCDX_AGENTS_* launch secret — is consulted. A missing or
// invalid setting never blocks MCP initialization or tools/list; it surfaces as
// a configuration tool error the first time a call needs the network.

import {
  DEFAULT_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  WRITE_MODES,
} from './constants.js';

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{
 *   apiBase: string|null, origin: string|null, insecure: boolean,
 *   writes: string, writesInvalid: string|null,
 *   timeoutMs: number,
 *   urlError: string|null, timeoutError: string|null
 * }}
 */
export function loadConfig(env = process.env) {
  const rawUrl = env.VBCDX_FORGEJO_URL;
  const rawWrites = env.VBCDX_FORGEJO_WRITES;
  const rawTimeout = env.VBCDX_FORGEJO_TIMEOUT_MS;

  let apiBase = null;
  let origin = null;
  let insecure = false;
  let urlError = null;
  if (rawUrl !== undefined && String(rawUrl).trim() !== '') {
    try {
      const parsed = normalizeUrl(String(rawUrl));
      apiBase = parsed.apiBase;
      origin = parsed.origin;
      insecure = parsed.insecure;
    } catch (e) {
      // The message intentionally does not echo the raw value: a misconfigured
      // URL setting could contain a pasted secret.
      urlError = `VBCDX_FORGEJO_URL is not a valid Forgejo instance URL: ${e.message}`;
    }
  } else {
    urlError = 'VBCDX_FORGEJO_URL is not set. Set it to the Forgejo instance origin (optionally ending in /api/v1).';
  }

  // Write mode: an unrecognised value behaves as off and is reported on a write
  // call. The mode is a fixed enum, safe to name back.
  let writes = 'off';
  let writesInvalid = null;
  if (rawWrites !== undefined && String(rawWrites).trim() !== '') {
    const v = String(rawWrites).trim();
    if (WRITE_MODES.includes(v)) {
      writes = v;
    } else {
      writesInvalid = v.slice(0, 32);
    }
  }

  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let timeoutError = null;
  if (rawTimeout !== undefined && String(rawTimeout).trim() !== '') {
    const v = String(rawTimeout).trim();
    if (!/^\d+$/.test(v)) {
      timeoutError = 'VBCDX_FORGEJO_TIMEOUT_MS must be an integer number of milliseconds.';
    } else {
      const n = Number(v);
      if (n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
        timeoutError = `VBCDX_FORGEJO_TIMEOUT_MS must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}.`;
      } else {
        timeoutMs = n;
      }
    }
  }

  return { apiBase, origin, insecure, writes, writesInvalid, timeoutMs, urlError, timeoutError };
}

/**
 * Normalize and validate a Forgejo instance URL into an API base.
 * Accepts an origin with an optional deployment subpath, optionally already
 * ending in /api/v1; appends the suffix exactly once. Rejects userinfo, query,
 * fragment, control characters, non-HTTP(S) schemes and path traversal.
 */
export function normalizeUrl(raw) {
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error('contains control characters');
  }
  // Reject traversal in the raw input: the WHATWG parser would silently
  // collapse `/../` before we could see it, so inspect the string first.
  if (/\/\.\.(?:\/|$)/.test(raw) || /%2e/i.test(raw)) {
    throw new Error('must not include path traversal segments');
  }
  let u;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a parseable absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('only http and https are supported');
  }
  if (u.username || u.password) {
    throw new Error('must not embed userinfo (username/password)');
  }
  if (u.search) {
    throw new Error('must not include a query string');
  }
  if (u.hash) {
    throw new Error('must not include a fragment');
  }

  let path = u.pathname;
  const decoded = safeDecode(path);
  const segments = decoded.split('/');
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error('must not include path traversal segments');
  }
  path = path.replace(/\/+$/, '');
  if (!/\/api\/v1$/.test(path)) {
    path = `${path}/api/v1`;
  }

  return {
    origin: u.origin,
    apiBase: `${u.origin}${path}`,
    insecure: u.protocol === 'http:',
  };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
