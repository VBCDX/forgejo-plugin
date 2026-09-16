// Per-request credential resolution for the network transport (issue #8).
//
// The stdio server reads a credential *file*; the network server instead takes
// a credential from the request's `Authorization` header — one header, one
// scheme, one credential, resolved fresh for every request and never cached.
//
// This module is the header analogue of credential.js#authAttempts: it produces
// the same ordered `auth` object the HTTP layer consumes (tools only ever see
// `auth`, never a raw credential), so nothing downstream changes. Because a
// single header carries exactly one scheme there is at most one attempt and no
// token->Basic-after-401 retry — that retry stays a credential-file feature,
// where one file can hold both a token and a password.
//
// No part of the header value is ever echoed in an error: a malformed header
// could place a secret where a scheme name is expected.

import { ToolError } from './errors.js';

const GUIDANCE =
  '\nSupply credentials per request via the Authorization header:\n' +
  '  Authorization: Bearer <personal access token>   (or: token <PAT>)\n' +
  '  Authorization: Basic <base64(user:password)>\n' +
  'No Forgejo request was attempted.';

function headerError(reason, message) {
  return new ToolError({
    outcome: 'refused',
    reason,
    message: `${message}${GUIDANCE}`,
    attempted: false,
  });
}

/**
 * Resolve an `Authorization` header value into the ordered auth attempts the
 * HTTP layer consumes.
 *
 * @param {string|undefined} headerValue raw Authorization header value
 * @returns {{attempts:{header:string,kind:string}[], state:object}}
 * @throws {ToolError} refused/credential_missing | credential_malformed
 */
export function authFromHeader(headerValue) {
  if (typeof headerValue !== 'string' || headerValue.trim() === '') {
    throw headerError('credential_missing', 'No Authorization header was provided.');
  }
  const trimmed = headerValue.trim();
  const sp = trimmed.indexOf(' ');
  const scheme = (sp === -1 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const rest = sp === -1 ? '' : trimmed.slice(sp + 1).trim();

  // Bearer and token both carry a PAT; forward upstream as Forgejo's `token`
  // scheme regardless of which the client sent, matching the file path exactly.
  if (scheme === 'bearer' || scheme === 'token') {
    if (rest === '') {
      throw headerError('credential_malformed', 'The Authorization header carried no token value.');
    }
    return { attempts: [{ header: `token ${rest}`, kind: 'token' }], state: {} };
  }

  if (scheme === 'basic') {
    if (rest === '') {
      throw headerError('credential_malformed', 'The Authorization header carried no Basic value.');
    }
    // Decode only to sanity-check the RFC 7617 user:password shape; the header
    // is forwarded verbatim. Buffer.from never throws on bad base64.
    const decoded = Buffer.from(rest, 'base64').toString('utf8');
    if (!decoded.includes(':')) {
      throw headerError('credential_malformed', 'The Basic Authorization value must decode to user:password.');
    }
    return { attempts: [{ header: `Basic ${rest}`, kind: 'basic' }], state: {} };
  }

  throw headerError('credential_malformed', 'Unsupported Authorization scheme; use Bearer, token, or Basic.');
}
