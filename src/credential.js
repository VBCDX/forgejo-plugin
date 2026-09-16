// Per-call credential loading (spec §4).
//
// Every catalog tool receives an absolute `credential_file`. We read exactly
// that file, for that one call, and never search, select a role, borrow another
// file, accept a token in tool arguments or cache a value between calls. The
// file must be a regular, non-symlink file owned by the effective user at mode
// 0600, inside a private 0700 parent, with no symlink anywhere in its path.
//
// v1 is POSIX. Errors name the attempted absolute path, the relevant key names
// and the required format/mode — never an actual value.

import { promises as fs } from 'node:fs';
import { isAbsolute } from 'node:path';
import { ToolError } from './errors.js';
import { parseGrammar, GrammarError } from './grammar.js';
import { MAX_INPUT_BODY_BYTES } from './constants.js';

const KNOWN_FIELDS = new Set([
  'VBCDX_AGENTS_ROLE',
  'VBCDX_AGENTS_USER',
  'VBCDX_AGENTS_TOKEN',
  'VBCDX_AGENTS_PASSWORD',
]);

const CRED_FILE_MAX_BYTES = 64 * 1024;

function credError(reason, message, path) {
  const expectation =
    `\nExpected a regular owned file, mode 0600, in a private 0700 directory:\n` +
    `VBCDX_AGENTS_ROLE=<role>\n` +
    `VBCDX_AGENTS_USER=<username>\n` +
    `VBCDX_AGENTS_TOKEN=<token>\n` +
    `VBCDX_AGENTS_PASSWORD=<optional password>\n` +
    `At least one token/password is required. No Forgejo request was attempted.`;
  return new ToolError({
    outcome: 'refused',
    reason,
    message: `${message}${path ? ` ${safePath(path)}.` : ''}${expectation}`,
    attempted: false,
  });
}

/**
 * Read and validate a credential file.
 *
 * @param {string} filePath absolute path
 * @param {object} [opts]
 * @param {number} [opts.uid] effective uid override (tests)
 * @returns {Promise<{role:string,user:string,token:string|undefined,password:string|undefined}>}
 */
export async function loadCredential(filePath, opts = {}) {
  if (typeof filePath !== 'string' || filePath === '') {
    throw credError('credential_missing', 'No credential_file was provided.', null);
  }
  if (!isAbsolute(filePath)) {
    throw credError('credential_not_absolute', 'Credential file path must be absolute:', filePath);
  }

  const euid = opts.uid ?? (typeof process.getuid === 'function' ? process.getuid() : null);

  // lstat the file itself: it must exist and be a regular, non-symlink file.
  let lst;
  try {
    lst = await fs.lstat(filePath);
  } catch (e) {
    if (e.code === 'ENOENT') {
      throw credError('credential_missing', 'Credential file not found:', filePath);
    }
    if (e.code === 'EACCES') {
      throw credError('credential_unreadable', 'Credential file is not readable:', filePath);
    }
    throw credError('credential_unreadable', 'Credential file could not be examined:', filePath);
  }
  if (lst.isSymbolicLink()) {
    throw credError('credential_unsafe', 'Credential file must not be a symbolic link:', filePath);
  }
  if (!lst.isFile()) {
    throw credError('credential_unsafe', 'Credential file must be a regular file:', filePath);
  }

  // No symlink anywhere in the path: realpath must equal the supplied path.
  try {
    const real = await fs.realpath(filePath);
    if (real !== filePath) {
      throw credError('credential_unsafe', 'Credential file path must not traverse a symbolic link:', filePath);
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw credError('credential_unsafe', 'Credential file path could not be resolved safely:', filePath);
  }

  // Ownership and mode of the file (0600, owned by the effective user).
  if (euid != null && lst.uid !== euid) {
    throw credError('credential_unsafe', 'Credential file must be owned by the running user:', filePath);
  }
  if ((lst.mode & 0o777) !== 0o600) {
    throw credError('credential_unsafe', 'Credential file must have mode 0600:', filePath);
  }

  // The immediate parent must be a private 0700 directory owned by the user.
  const parent = filePath.replace(/\/[^/]+$/, '') || '/';
  try {
    const pst = await fs.lstat(parent);
    if (pst.isSymbolicLink()) {
      throw credError('credential_unsafe', 'Credential directory must not be a symbolic link:', parent);
    }
    if (!pst.isDirectory()) {
      throw credError('credential_unsafe', 'Credential file parent must be a directory:', parent);
    }
    if (euid != null && pst.uid !== euid) {
      throw credError('credential_unsafe', 'Credential directory must be owned by the running user:', parent);
    }
    if ((pst.mode & 0o777) !== 0o700) {
      throw credError('credential_unsafe', 'Credential directory must have mode 0700:', parent);
    }
  } catch (e) {
    if (e instanceof ToolError) throw e;
    throw credError('credential_unsafe', 'Credential directory could not be examined:', parent);
  }

  if (lst.size > CRED_FILE_MAX_BYTES) {
    throw credError('credential_malformed', 'Credential file is too large to be a credential file:', filePath);
  }

  // Read the file, tolerating replacement between stat and read.
  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (e.code === 'EACCES') {
      throw credError('credential_unreadable', 'Credential file is not readable:', filePath);
    }
    throw credError('credential_unreadable', 'Credential file could not be read:', filePath);
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_INPUT_BODY_BYTES) {
    throw credError('credential_malformed', 'Credential file is too large:', filePath);
  }

  let fields;
  try {
    fields = parseGrammar(content);
  } catch (e) {
    if (e instanceof GrammarError) {
      throw credError('credential_malformed', `Credential file is malformed (${e.message})`, filePath);
    }
    throw credError('credential_malformed', 'Credential file is malformed:', filePath);
  }

  // Reject unsupported VBCDX_AGENTS_* keys (typo protection). Unrelated,
  // non-namespaced keys are ignored and never echoed.
  for (const key of fields.keys()) {
    if (key.startsWith('VBCDX_AGENTS_') && !KNOWN_FIELDS.has(key)) {
      throw credError('credential_malformed', `Credential file has an unsupported field "${key}":`, filePath);
    }
  }

  const role = (fields.get('VBCDX_AGENTS_ROLE') || '').trim();
  const user = (fields.get('VBCDX_AGENTS_USER') || '').trim();
  const token = nonBlank(fields.get('VBCDX_AGENTS_TOKEN'));
  const password = nonBlank(fields.get('VBCDX_AGENTS_PASSWORD'));

  if (role === '') {
    throw credError('credential_key_missing', 'Credential file is missing VBCDX_AGENTS_ROLE:', filePath);
  }
  if (user === '') {
    throw credError('credential_key_missing', 'Credential file is missing VBCDX_AGENTS_USER:', filePath);
  }
  if (token === undefined && password === undefined) {
    throw credError(
      'credential_key_missing',
      'Credential file needs at least one of VBCDX_AGENTS_TOKEN or VBCDX_AGENTS_PASSWORD:',
      filePath,
    );
  }

  return { role, user, token, password };
}

/**
 * Ordered authentication attempts for a credential (spec §4).
 * Token first (`Authorization: token <token>`); the Basic USER/PASSWORD attempt
 * is used only as the single retry after an explicit 401 on the token request.
 * With no token, Basic is the sole attempt and there is no fallback.
 *
 * @returns {{header:string, kind:string}[]}
 */
export function authAttempts(creds) {
  const attempts = [];
  if (creds.token !== undefined) {
    attempts.push({ header: `token ${creds.token}`, kind: 'token' });
    if (creds.password !== undefined) {
      attempts.push({ header: basic(creds.user, creds.password), kind: 'basic' });
    }
  } else if (creds.password !== undefined) {
    attempts.push({ header: basic(creds.user, creds.password), kind: 'basic' });
  }
  return attempts;
}

function basic(user, password) {
  return `Basic ${Buffer.from(`${user}:${password}`, 'utf8').toString('base64')}`;
}

function nonBlank(v) {
  if (v === undefined || v === null) return undefined;
  return v === '' ? undefined : v;
}

// Escape newlines/quotes so a path can appear safely in a one-line message.
function safePath(p) {
  return JSON.stringify(String(p));
}
