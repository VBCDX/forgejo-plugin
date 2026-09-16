// Typed errors used across the server.
//
// ToolError carries everything the envelope builder needs to render a failure
// result: the outcome bucket, the fixed reason, a redacted human message, an
// optional evidence object and the HTTP status when one was received. It never
// carries a credential value or a raw upstream body — callers must redact
// before constructing one.

export class ToolError extends Error {
  /**
   * @param {object} spec
   * @param {string} spec.outcome  one of OUTCOMES (refused|failed|unverified|indeterminate)
   * @param {string} spec.reason   one of REASONS
   * @param {string} spec.message  redacted, human-readable
   * @param {object} [spec.evidence]     optional redacted evidence
   * @param {number} [spec.httpStatus]   HTTP status if one was received
   * @param {object} [spec.retry]        {retry_after} preserved metadata
   * @param {boolean} [spec.attempted]   whether the primary request was dispatched
   * @param {string} [spec.verification] override verification state
   */
  constructor({ outcome, reason, message, evidence, httpStatus, retry, attempted, verification }) {
    super(message);
    this.name = 'ToolError';
    this.outcome = outcome;
    this.reason = reason;
    this.evidence = evidence;
    this.httpStatus = httpStatus;
    this.retry = retry;
    this.attempted = attempted;
    this.verification = verification;
  }
}

// Low-level transport failure raised by the HTTP layer. kind is one of
// 'timeout' | 'network' | 'size' | 'redirect'. The caller (a tool phase)
// converts it to a phase-appropriate ToolError, because the same reset means
// "failed" on a read but "indeterminate" on a mutation.
export class TransportError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'TransportError';
    this.kind = kind;
  }
}

export function refused(reason, message, extra = {}) {
  return new ToolError({ outcome: 'refused', reason, message, attempted: false, ...extra });
}

export function failed(reason, message, extra = {}) {
  return new ToolError({ outcome: 'failed', reason, message, ...extra });
}

export function indeterminate(reason, message, extra = {}) {
  return new ToolError({
    outcome: 'indeterminate',
    reason,
    message,
    verification: extra.verification ?? 'unavailable',
    ...extra,
  });
}
