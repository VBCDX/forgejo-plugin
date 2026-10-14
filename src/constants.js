// Section references (`contract §N`) point at docs/contract.md.
// Contract identity, size limits and the closed enumerations the envelope uses.
// Every reason / outcome / verification string the server can emit is declared
// here so the registry, the tools and the tests share one vocabulary.

export const SERVICE = 'forgejo';
export const CONTRACT = 'vbcdx.forgejo/1';
export const SERVER_NAME = 'forgejo';

// Transport safeguards (contract §3).
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MiB read cap before parsing
export const MAX_STRUCTURED_BYTES = 256 * 1024; // 256 KiB rendered structured cap
export const MAX_TEXT_BYTES = 64 * 1024; // 64 KiB human text cap
export const MAX_INPUT_BODY_BYTES = 128 * 1024; // 128 KiB max input body / message
export const DEFAULT_TIMEOUT_MS = 30000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 120000;
export const DEFAULT_LIMIT = 25;
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 50;

// Pull-request review reads. A review body is 5–15k characters, so
// listing every round of a multi-round PR floods the caller's result budget;
// `list_reviews` caps each body by default and `get_review` reads one in full.
export const DEFAULT_REVIEW_BODY_CHARS = 2000; // default per-review body cap
export const MAX_REVIEW_BODY_CHARS = 100000; // largest cap a caller may ask for
// The reviews route has no server-side commit/state filter, so a filtered list
// reads pages until this bound and then reports truncation honestly. It meets
// fetchArrayBounded's own HARD_CAP (1000), which clamps a larger value here.
export const MAX_REVIEW_SCAN = 1000;
// A commit prefix shorter than this would match unrelated reviews.
export const MIN_COMMIT_PREFIX = 7;

export const WRITE_MODES = Object.freeze(['off', 'write', 'full']);

export const EFFECTS = Object.freeze(['read', 'write', 'destructive']);

// The Forgejo review state vocabulary `list_reviews`' `state` filter accepts.
export const REVIEW_STATES = Object.freeze([
  'APPROVED',
  'PENDING',
  'COMMENT',
  'REQUEST_CHANGES',
  'REQUEST_REVIEW',
]);

export const OUTCOMES = Object.freeze([
  'ok',
  'accepted',
  'refused',
  'failed',
  'unverified',
  'indeterminate',
]);

export const VERIFICATIONS = Object.freeze([
  'not_applicable',
  'confirmed',
  'pending',
  'unavailable',
  'mismatch',
]);

// Fixed failure reasons (contract §4 and contract §5). Nothing outside this set is emitted.
export const REASONS = Object.freeze([
  // credential / local reasons
  'credential_missing',
  'credential_not_absolute',
  'credential_unreadable',
  'credential_unsafe',
  'credential_malformed',
  'credential_key_missing',
  'credential_rejected',
  'permission_denied',
  // request / gate / upstream reasons
  'validation_failed',
  'server_not_configured',
  'write_gate_disabled',
  'confirmation_required',
  'confirmation_mismatch',
  'not_found',
  'conflict',
  'rate_limited',
  'upstream_error',
  'network_error',
  'timeout',
  'response_too_large',
  'unexpected_response',
  'verification_failed',
  'indeterminate_write',
  'unsupported_operation',
]);
