// The shared credential-file grammar (owned by the dev-agents spec §4).
//
// A credential file is a literal configuration file, never shell code. This
// parser does not source, execute, interpolate, expand ~ or read ambient
// variables. It implements exactly one grammar so that the file the agents
// installer writes round-trips losslessly through the reader here:
//
//   * Blank lines, and lines whose first non-whitespace character is '#',
//     are ignored.
//   * An assignment is split at the first '='. Whitespace around the key and
//     the value is trimmed.
//   * An unquoted value is literal: interior spaces, '#', '=' and '$' stay
//     literal. There is no interpolation.
//   * A single-quoted value is literal with no escapes; it must close and have
//     no trailing data.
//   * A double-quoted value uses JSON string escaping; it must close and have
//     no trailing data. A decoded NUL or line break is rejected.
//   * Duplicate keys, compared case-insensitively, are rejected.
//   * A NUL anywhere, or a raw line break inside a value, is rejected.
//
// It throws GrammarError with a message that names the offending key/line and
// never contains a value.

export class GrammarError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GrammarError';
  }
}

const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

/**
 * @param {string} content raw file text
 * @returns {Map<string,string>} preserving first-seen order
 */
export function parseGrammar(content) {
  if (content.includes('\u0000')) {
    throw new GrammarError('File contains a NUL byte.');
  }
  const out = new Map();
  const seenLower = new Map(); // lowercased key -> original key
  const lines = content.split('\n');

  lines.forEach((rawLine, idx) => {
    const lineNo = idx + 1;
    // Strip a single trailing CR so CRLF files behave like LF files.
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

    const trimmedLeft = line.replace(/^\s+/, '');
    if (trimmedLeft === '' || trimmedLeft.startsWith('#')) return;

    const eq = line.indexOf('=');
    if (eq === -1) {
      throw new GrammarError(`Line ${lineNo}: not a KEY=VALUE assignment.`);
    }
    const key = line.slice(0, eq).trim();
    const rawValue = line.slice(eq + 1).trim();

    if (!KEY_RE.test(key)) {
      throw new GrammarError(`Line ${lineNo}: "${safeKey(key)}" is not a valid configuration key.`);
    }
    const lower = key.toLowerCase();
    if (seenLower.has(lower)) {
      throw new GrammarError(`Line ${lineNo}: duplicate key "${key}" (keys are case-insensitive).`);
    }

    const value = decodeValue(rawValue, key, lineNo);
    seenLower.set(lower, key);
    out.set(key, value);
  });

  return out;
}

function decodeValue(raw, key, lineNo) {
  if (raw === '') return '';
  const first = raw[0];

  if (first === "'") {
    const end = raw.indexOf("'", 1);
    if (end === -1) throw new GrammarError(`Line ${lineNo}: unterminated single-quoted value for "${key}".`);
    if (end !== raw.length - 1) {
      throw new GrammarError(`Line ${lineNo}: trailing data after quoted value for "${key}".`);
    }
    const v = raw.slice(1, end);
    if (CONTROL_RE.test(v)) throw new GrammarError(`Line ${lineNo}: control character in value for "${key}".`);
    return v;
  }

  if (first === '"') {
    // Find the closing unescaped quote.
    let i = 1;
    let closed = -1;
    while (i < raw.length) {
      if (raw[i] === '\\') {
        i += 2;
        continue;
      }
      if (raw[i] === '"') {
        closed = i;
        break;
      }
      i += 1;
    }
    if (closed === -1) throw new GrammarError(`Line ${lineNo}: unterminated double-quoted value for "${key}".`);
    if (closed !== raw.length - 1) {
      throw new GrammarError(`Line ${lineNo}: trailing data after quoted value for "${key}".`);
    }
    let decoded;
    try {
      decoded = JSON.parse(raw.slice(0, raw.length));
    } catch {
      throw new GrammarError(`Line ${lineNo}: invalid JSON string escaping in value for "${key}".`);
    }
    if (typeof decoded !== 'string') {
      throw new GrammarError(`Line ${lineNo}: invalid double-quoted value for "${key}".`);
    }
    if (/[\n\r]/.test(decoded) || decoded.includes('\u0000')) {
      throw new GrammarError(`Line ${lineNo}: decoded line break or NUL in value for "${key}".`);
    }
    return decoded;
  }

  // Unquoted: literal. Reject an accidental opening quote mid-value only if the
  // value both starts unquoted — here it does not — so nothing further to do
  // beyond a control-character guard.
  if (CONTROL_RE.test(raw)) {
    throw new GrammarError(`Line ${lineNo}: control character in value for "${key}".`);
  }
  return raw;
}

// Keys are echoed in errors; a malformed "key" might be junk, so keep it short
// and strip anything unusual to avoid leaking a mis-pasted secret.
function safeKey(k) {
  return k.replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 40);
}
