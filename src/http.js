// The HTTP layer and per-call context (spec §3).
//
// One deadline covers credential loading, an optional preflight, the primary
// request, pagination and verification — so the deadline lives on a call
// object created once per tool invocation, and every request shares its signal.
// Requests are same-origin only, never follow a redirect (which would forward
// credentials), cap the response body at 2 MiB before parsing, and perform the
// one and only permitted retry: a single re-send with USER/PASSWORD after an
// explicit 401 on a token request. TLS verification is never disabled.

import { TransportError } from './errors.js';
import { MAX_RESPONSE_BYTES } from './constants.js';

/**
 * Create a call context carrying the total-call deadline.
 * @param {object} opts
 * @param {object} opts.config
 * @param {AbortSignal} [opts.signal] external cancellation (MCP request / SIGTERM)
 */
export function createCall({ config, signal: external }) {
  const ac = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    ac.abort();
  }, config.timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const signals = [ac.signal];
  if (external) signals.push(external);
  const signal = AbortSignal.any(signals);

  return {
    config,
    signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
    },
  };
}

/**
 * Issue one API request under a call's deadline.
 *
 * @param {object} call  from createCall
 * @param {object} opts
 * @param {string} opts.method
 * @param {string} opts.path      absolute API path with pre-encoded segments
 * @param {object} [opts.query]   key -> string | string[]
 * @param {*} [opts.body]         JSON body (object) for POST/PATCH/PUT
 * @param {string} [opts.accept]  Accept header, default application/json
 * @param {{attempts:{header:string,kind:string}[], state:{idx?:number}}} opts.auth
 * @returns {Promise<{status:number, ok:boolean, text:string, json:*, retryAfter:string|null}>}
 * @throws {TransportError}
 */
export async function request(call, { method, path, query, body, accept = 'application/json', auth }) {
  const url = buildUrl(call.config, path, query);
  const bodyText = body !== undefined ? JSON.stringify(body) : undefined;

  const headers = { Accept: accept };
  if (bodyText !== undefined) headers['Content-Type'] = 'application/json';

  const attempts = auth.attempts;
  const startIdx = auth.state.idx ?? 0;
  let resp = await sendOne(call, url, method, headers, bodyText, attempts[startIdx]);

  // The sole permitted retry: token attempt returned an explicit 401 and a
  // Basic fallback exists on the same file. Never on 403/redirect/429/5xx/reset.
  if (resp.status === 401 && startIdx === 0 && attempts[0]?.kind === 'token' && attempts[1]) {
    resp = await sendOne(call, url, method, headers, bodyText, attempts[1]);
    if (resp.status !== 401) auth.state.idx = 1;
  }

  const text = await readCappedText(resp, MAX_RESPONSE_BYTES);
  let json;
  if (accept.includes('json')) {
    if (text.length === 0) {
      json = null; // 204 / empty body
    } else {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined; // caller decides: unexpected_response vs indeterminate
      }
    }
  }

  return {
    status: resp.status,
    ok: resp.status >= 200 && resp.status < 300,
    text,
    json,
    retryAfter: resp.headers.get('retry-after'),
    headers: {
      totalCount: numeric(resp.headers.get('x-total-count')),
      link: resp.headers.get('link'),
    },
  };
}

function numeric(v) {
  if (v == null || !/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

async function sendOne(call, url, method, baseHeaders, bodyText, attempt) {
  const headers = { ...baseHeaders };
  if (attempt) headers.Authorization = attempt.header;

  let resp;
  try {
    resp = await fetch(url, {
      method,
      headers,
      body: bodyText,
      redirect: 'manual',
      signal: call.signal,
    });
  } catch (e) {
    if (call.timedOut()) {
      throw new TransportError('timeout', 'the request exceeded the call deadline');
    }
    if (call.signal.aborted || e?.name === 'AbortError') {
      throw new TransportError('network', 'the request was cancelled');
    }
    throw new TransportError('network', 'the network request failed');
  }

  // Refuse redirects rather than forwarding credentials to a new location.
  if (resp.type === 'opaqueredirect' || (resp.status >= 300 && resp.status < 400)) {
    throw new TransportError('redirect', 'the server responded with a redirect; credentials were not forwarded');
  }
  return resp;
}

function buildUrl(config, path, query) {
  const parts = [];
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      const key = encodeURIComponent(k);
      if (Array.isArray(v)) {
        for (const item of v) parts.push(`${key}=${encodeURIComponent(item)}`);
      } else {
        parts.push(`${key}=${encodeURIComponent(v)}`);
      }
    }
  }
  const qs = parts.length ? `?${parts.join('&')}` : '';
  const url = `${config.apiBase}${path}${qs}`;
  const parsed = new URL(url);
  if (parsed.origin !== config.origin) {
    throw new TransportError('network', 'refusing an off-origin request');
  }
  return url;
}

async function readCappedText(resp, maxBytes) {
  const body = resp.body;
  if (!body || typeof body.getReader !== 'function') {
    const t = await resp.text();
    if (Buffer.byteLength(t, 'utf8') > maxBytes) {
      throw new TransportError('size', 'the response exceeded the size limit');
    }
    return t;
  }
  const reader = body.getReader();
  let received = 0;
  const chunks = [];
  for (;;) {
    let r;
    try {
      r = await reader.read();
    } catch {
      throw new TransportError('network', 'the response body could not be read');
    }
    if (r.done) break;
    received += r.value.byteLength;
    if (received > maxBytes) {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      throw new TransportError('size', 'the response exceeded the size limit');
    }
    chunks.push(Buffer.from(r.value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
