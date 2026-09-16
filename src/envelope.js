// The result envelope (spec §5).
//
// Every call returns exactly one complete human-readable text plus the same
// JSON object in structuredContent. Required fields are outcome, effect,
// request and verification. http_status appears only when a status was
// received; data only for ok/accepted. A failure adds reason and message and
// may add redacted evidence. Only ok/accepted carry isError:false.

import { MAX_TEXT_BYTES } from './constants.js';

/**
 * @param {object} spec
 * @param {string} spec.outcome
 * @param {string} spec.effect
 * @param {{method:string,path:string,attempted:boolean}} spec.request
 * @param {string} spec.verification
 * @param {number} [spec.httpStatus]
 * @param {*} [spec.data]
 * @param {string} [spec.reason]
 * @param {string} [spec.message]
 * @param {object} [spec.evidence]
 * @returns {{content:{type:string,text:string}[], structuredContent:object, isError:boolean}}
 */
export function buildResult(spec) {
  const {
    outcome,
    effect,
    request,
    verification,
    httpStatus,
    data,
    reason,
    message,
    evidence,
  } = spec;

  const envelope = { outcome, effect, request, verification };
  if (typeof httpStatus === 'number') envelope.http_status = httpStatus;

  const success = outcome === 'ok' || outcome === 'accepted';
  if (success) {
    if (data !== undefined) envelope.data = data;
  } else {
    // Never place resource-shaped success data on a failure.
    envelope.reason = reason;
    envelope.message = message;
    if (evidence !== undefined) envelope.evidence = evidence;
  }

  return {
    content: [{ type: 'text', text: renderText(envelope) }],
    structuredContent: envelope,
    isError: !success,
  };
}

function renderText(envelope) {
  const { outcome, effect, request, verification, http_status, data, reason, message, evidence } = envelope;
  const lines = [];
  const statusPart = typeof http_status === 'number' ? ` http ${http_status}` : '';
  lines.push(`${outcome} · ${effect} · ${request.method} ${request.path}${statusPart} · verification=${verification}`);
  if (reason) lines.push(`reason: ${reason}`);
  if (message) lines.push(message);
  if (evidence !== undefined) lines.push(`evidence: ${stableStringify(evidence)}`);
  if (data !== undefined) lines.push(stableStringify(data));

  let text = lines.join('\n');
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > MAX_TEXT_BYTES) {
    text = truncateUtf8(text, MAX_TEXT_BYTES - 32) + '\n… [text truncated]';
  }
  return text;
}

function truncateUtf8(s, maxBytes) {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  // Avoid splitting a multi-byte character.
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.slice(0, end).toString('utf8');
}

// Deterministic JSON (sorted keys) so text and manifest output are stable.
export function stableStringify(value) {
  return JSON.stringify(sortKeys(value), null, 2);
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = sortKeys(value[k]);
    return out;
  }
  return value;
}
