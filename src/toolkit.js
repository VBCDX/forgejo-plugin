// Shared helpers for tool definitions: input-schema fragments, identifier
// validation, request dispatch with phase-aware failure classification,
// pagination assembly, confirmation checks and body hashing.
//
// "Phase" matters because the same failure means different things at different
// points of a write: a 5xx or reset on a preflight GET means the mutation was
// never attempted (failed), but on the mutation itself it means the write may
// have applied (indeterminate). request.attempted therefore tracks the primary
// operation, not a preceding preflight.

import { createHash } from 'node:crypto';
import { request } from './http.js';
import { ToolError, TransportError, failed, indeterminate } from './errors.js';
import { DEFAULT_LIMIT, MIN_LIMIT, MAX_LIMIT, MAX_INPUT_BODY_BYTES } from './constants.js';

// ---------- input schema fragments ----------

export const ownerRepo = {
  owner: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\s/\\\\.][^\\s/\\\\]*$' },
  repo: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[^\\s/\\\\.][^\\s/\\\\]*$' },
};

export const pageLimit = {
  page: { type: 'integer', minimum: 1 },
  limit: { type: 'integer', minimum: MIN_LIMIT, maximum: MAX_LIMIT },
};

export const offsetLimit = {
  offset: { type: 'integer', minimum: 0 },
  limit: { type: 'integer', minimum: MIN_LIMIT, maximum: MAX_LIMIT },
};

export const shaSchema = { type: 'string', pattern: '^([0-9a-f]{40}|[0-9a-f]{64})$' };
export const bodySha256Schema = { type: 'string', pattern: '^[0-9a-f]{64}$' };
export const positiveInt = { type: 'integer', minimum: 1 };
export const bodyText = { type: 'string', maxLength: MAX_INPUT_BODY_BYTES };

/** Build an input object schema with owner/repo baked in and credential_file required. */
export function inputSchema({ properties = {}, required = [] }) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['credential_file', ...required],
    properties: {
      credential_file: { type: 'string', minLength: 1 },
      ...properties,
    },
  };
}

// ---------- resolved paging / normalization ----------

export function resolveLimit(v) {
  if (v === undefined) return DEFAULT_LIMIT;
  return v;
}

export function resolvePage(v) {
  return v === undefined ? 1 : v;
}

// ---------- request helpers ----------

/** Attach a redacted {method, path, attempted} request descriptor to an error. */
function setReq(err, opts) {
  err.request = { method: opts.method, path: opts.path, attempted: err.attempted ?? false };
  return err;
}

/**
 * Issue a request and return the raw result. Throws a phase-classified
 * ToolError (with a request descriptor attached) on transport failure. The
 * caller inspects result.ok / result.status for HTTP-level handling; use this
 * when a non-2xx is expected and handled specially (e.g. a delete read-back
 * that expects 404).
 */
export async function send(call, phase, opts) {
  try {
    return await request(call, opts);
  } catch (e) {
    if (e instanceof TransportError) throw setReq(classifyTransport(phase, e, opts.method), opts);
    throw e;
  }
}

/**
 * Issue a request that must return parseable 2xx JSON. Throws a
 * phase-classified ToolError otherwise. Returns the request result.
 */
export async function getJson(call, phase, opts) {
  const result = await send(call, phase, opts);
  if (!result.ok) throw setReq(httpFailure(phase, opts.method, result), opts);
  const wantsJson = opts.accept === undefined || opts.accept.includes('json');
  if (wantsJson && result.json === undefined && result.text.length > 0) {
    throw setReq(unparsable(phase, opts.method, result), opts);
  }
  return result;
}

/** Convert a non-2xx HTTP result to a phase-classified ToolError. */
export function httpFailure(phase, method, result) {
  const attempted = phase !== 'preflight';
  const s = result.status;
  const base = { httpStatus: s, attempted };

  if (s === 401) {
    return failed('credential_rejected', 'The Forgejo credentials were rejected (401).', base);
  }
  if (s === 403) {
    return failed(
      'permission_denied',
      'The credential lacks the token scope or repository permission this endpoint requires (403).',
      base,
    );
  }
  if (s === 404) {
    return failed('not_found', 'The requested resource was not found (404).', base);
  }
  if (s === 409) {
    return failed('conflict', 'The request conflicts with the current state of the resource (409).', base);
  }
  if (s === 429) {
    return failed('rate_limited', 'The request was rate limited (429).', {
      ...base,
      evidence: result.retryAfter ? { retry_after: result.retryAfter } : undefined,
    });
  }
  if (s >= 500) {
    if (phase === 'mutation') {
      return indeterminate('indeterminate_write', `The server returned ${s}; the write may or may not have applied.`, base);
    }
    return failed('upstream_error', `The server returned an error (${s}).`, base);
  }
  // Other 4xx (422 validation, etc.). A mutation rejected with 4xx did not apply.
  return failed('upstream_error', `The request was rejected (${s}).`, base);
}

/** A successful (2xx) response whose JSON could not be parsed within bounds. */
export function unparsable(phase, method, result) {
  if (phase === 'mutation') {
    return indeterminate('indeterminate_write', 'The server returned an unparsable success body; the write is unconfirmed.', {
      httpStatus: result.status,
      attempted: true,
    });
  }
  return failed('unexpected_response', 'The server returned an unparsable response body.', {
    httpStatus: result.status,
    attempted: phase !== 'preflight',
  });
}

function classifyTransport(phase, err, method) {
  const mutation = phase === 'mutation';
  const attempted = phase !== 'preflight';
  switch (err.kind) {
    case 'timeout':
      return mutation
        ? indeterminate('timeout', 'The write timed out; it may or may not have applied.', { attempted: true })
        : failed('timeout', 'The request exceeded the call deadline.', { attempted });
    case 'size':
      return mutation
        ? indeterminate('response_too_large', 'The write response exceeded the size limit; it is unconfirmed.', { attempted: true })
        : failed('response_too_large', 'The response exceeded the size limit before it could be parsed.', { attempted });
    case 'redirect':
      return mutation
        ? indeterminate('indeterminate_write', 'The server redirected the write; credentials were not forwarded and the result is unconfirmed.', { attempted: true })
        : failed('unexpected_response', 'The server responded with a redirect; credentials were not forwarded.', { attempted });
    case 'network':
    default:
      return mutation
        ? indeterminate('network_error', 'The connection failed during the write; it may or may not have applied.', { attempted: true })
        : failed('network_error', 'The network request failed.', { attempted });
  }
}

/**
 * A read-back used for verification. It never throws: a transport failure, a
 * non-2xx status or an unparsable body all resolve to { ok:false } so the
 * caller can report `unverified` (the mutation may already have happened)
 * rather than pretending nothing changed.
 */
export async function verifyGet(call, opts) {
  try {
    const r = await request(call, opts);
    if (!r.ok || r.json === undefined) return { ok: false, status: r.status };
    return { ok: true, status: r.status, json: r.json };
  } catch {
    return { ok: false };
  }
}

// ---------- pagination ----------

/**
 * Assemble an upstream-paged envelope. Never infers completion from a short
 * page alone (the host may clamp limits); an empty page establishes completion.
 * When authoritative total metadata is present it is used; otherwise the next
 * page is offered as a probe with unknown has_more.
 */
export function pagedEnvelope({ items, page, limit, total }) {
  const count = items.length;
  const out = { items, count, page, limit };

  if (typeof total === 'number') {
    const seen = (page - 1) * limit + count;
    const hasMore = seen < total;
    out.next_page = hasMore ? page + 1 : null;
    out.has_more = hasMore;
    out.truncated = false;
    out.total = total;
    return out;
  }

  if (count === 0) {
    out.next_page = null;
    out.has_more = false;
  } else {
    // A non-empty page never proves completion here; offer the next as a probe.
    out.next_page = page + 1;
    out.has_more = null;
  }
  out.truncated = false;
  return out;
}

/**
 * Assemble a local-window envelope over an already-retrieved bounded array.
 * @param {object} a
 * @param {*[]} a.array   projected items (the retrieved slice source)
 * @param {number} a.offset
 * @param {number} a.limit
 * @param {boolean} a.terminal  whether array retrieval reached the true end
 */
export function windowEnvelope({ array, offset, limit, terminal }) {
  const window = array.slice(offset, offset + limit);
  const count = window.length;
  const out = {
    items: window,
    count,
    offset,
    limit,
  };
  const consumed = offset + count;
  if (terminal) {
    out.total = array.length;
    out.next_offset = consumed < array.length ? consumed : null;
  } else {
    out.next_offset = consumed;
  }
  out.truncated = !terminal;
  return out;
}

/**
 * Retrieve enough of an upstream array to serve a local window, honestly.
 * Only an empty page establishes the end (a short page may be a host limit
 * clamp, not completion). Stops once it holds `need`+1 items, hits an empty
 * page (terminal) or reaches a hard cap (not terminal).
 *
 * @returns {Promise<{array:object[], terminal:boolean}>}
 */
export async function fetchArrayBounded(call, phase, { path, query = {}, auth, need, wrapperKeys = [] }) {
  const perPage = MAX_LIMIT;
  const HARD_CAP = 1000;
  const array = [];
  let page = 1;
  let terminal = false;
  for (;;) {
    if (array.length >= need + 1 || array.length >= HARD_CAP) break;
    const r = await getJson(call, phase, { method: 'GET', path, query: { ...query, page, limit: perPage }, auth });
    const batch = Array.isArray(r.json) ? r.json : unwrapArray(r.json, wrapperKeys);
    if (batch.length === 0) {
      terminal = true;
      break;
    }
    array.push(...batch);
    page += 1;
  }
  return { array, terminal };
}

// ---------- confirmation ----------

/**
 * Enforce an exact confirmation string (spec §6). Confirmations are an accident
 * control and are never sent to the upstream API.
 * @throws {ToolError} refused/confirmation_required | confirmation_mismatch
 */
export function assertConfirm(provided, expected) {
  if (provided === undefined || provided === null || String(provided).trim() === '') {
    throw new ToolError({
      outcome: 'refused',
      reason: 'confirmation_required',
      message: `This destructive operation requires confirm to be exactly: "${expected}".`,
      attempted: false,
    });
  }
  if (String(provided).trim() !== expected) {
    throw new ToolError({
      outcome: 'refused',
      reason: 'confirmation_mismatch',
      message: `The confirm string did not match. It must be exactly: "${expected}".`,
      attempted: false,
    });
  }
}

// ---------- success spec ----------

/**
 * Build the success/observed-outcome spec a tool.run returns.
 * @param {object} a
 * @param {string} [a.outcome] default 'ok'
 * @param {string} a.method
 * @param {string} a.path
 * @param {number} [a.status] observed HTTP status
 * @param {string} [a.verification] default 'not_applicable'
 * @param {*} [a.data]
 */
export function success({ outcome = 'ok', method, path, status, verification = 'not_applicable', data }) {
  const spec = {
    outcome,
    request: { method, path, attempted: true },
    verification,
  };
  if (status !== undefined) spec.httpStatus = status;
  if (data !== undefined) spec.data = data;
  return spec;
}

/** A mutation that succeeded upstream but whose observable state could not be confirmed. */
export function unverifiedSpec({ method, path, status, message, evidence, verification = 'unavailable' }) {
  return {
    outcome: 'unverified',
    request: { method, path, attempted: true },
    verification,
    httpStatus: status,
    reason: 'verification_failed',
    message,
    evidence,
  };
}

// ---------- hashing ----------

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- misc ----------

/** Unwrap a jobs/runs list body that may be a bare array or a wrapper object. */
export function unwrapArray(json, wrapperKeys) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object') {
    for (const k of wrapperKeys) {
      if (Array.isArray(json[k])) return json[k];
    }
  }
  return [];
}
