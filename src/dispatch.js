// The single call path shared by the MCP server and the tests.
//
// Ordering is deliberate and matches the spec: input validation, then the
// write gate (before any credential read or network), then configuration, then
// the destructive confirmation, then the credential read, then the tool's
// networked run. Each stage that fails short-circuits into a redacted failure
// envelope; nothing throws past this function for an expected failure.

import { validate } from './validate.js';
import { assertGate } from './gate.js';
import { loadCredential, authAttempts } from './credential.js';
import { createCall } from './http.js';
import { buildResult } from './envelope.js';
import { assertConfirm } from './toolkit.js';
import { ToolError, refused } from './errors.js';

/**
 * @param {object} tool
 * @param {object} rawArgs
 * @param {object} [ctx]
 * @param {object} [ctx.config]
 * @param {AbortSignal} [ctx.signal]
 * @param {(msg:string)=>void} [ctx.log]
 * @param {() => ({attempts:object[],state:object})} [ctx.resolveAuth] alternative
 *   credential source (network header mode). When absent, the per-call
 *   credential_file is read (stdio mode) — unchanged.
 * @param {object} [ctx.inputSchema] validation schema override (network mode
 *   drops the credential_file requirement, since credentials arrive by header).
 */
export async function executeTool(tool, rawArgs, { config, signal, log, resolveAuth, inputSchema } = {}) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs : {};
  const req0 = { method: tool.method, path: tool.route, attempted: false };

  // 1. Input validation.
  const v = validate(inputSchema || tool.input, args);
  if (!v.valid) {
    const first = v.errors[0];
    return finish(
      tool,
      refused('validation_failed', `Invalid input: ${first.path || '(root)'} ${first.message}.`),
      req0,
      log,
    );
  }

  // 2. Write gate — before credential reads / network.
  try {
    assertGate(tool.effect, config);
  } catch (e) {
    return finish(tool, e, req0, log);
  }

  // 3. Configuration must be usable for a call.
  if (config.urlError) return finish(tool, refused('server_not_configured', config.urlError), req0, log);
  if (config.timeoutError) return finish(tool, refused('server_not_configured', config.timeoutError), req0, log);

  // 4. Destructive confirmation (local, before credentials/network).
  if (tool.confirm) {
    try {
      assertConfirm(args.confirm, tool.confirm(args));
    } catch (e) {
      return finish(tool, e, req0, log);
    }
  }

  // 5. Credentials. Stdio reads the per-call file; the network transport injects
  // a resolver that reads the request's Authorization header. Either way, only
  // an ordered `auth` object reaches the network layer — tools never see a raw
  // credential.
  let auth;
  try {
    auth = resolveAuth ? await resolveAuth() : { attempts: authAttempts(await loadCredential(args.credential_file)), state: {} };
  } catch (e) {
    return finish(tool, e, req0, log);
  }

  // 6. Networked run under the call deadline.
  const call = createCall({ config, signal });
  try {
    const spec = await tool.run({ args, config, call, auth });
    return validated(tool, buildResult({ effect: tool.effect, ...spec }), log);
  } catch (e) {
    if (e instanceof ToolError) return finish(tool, e, req0, log);
    // Unexpected internal fault: never leak a stack or a value.
    if (log) log(`internal error in ${tool.name}: ${redact(e)}`);
    return validated(
      tool,
      buildResult({
        outcome: 'failed',
        effect: tool.effect,
        request: req0,
        verification: 'not_applicable',
        reason: 'unexpected_response',
        message: 'The server hit an unexpected internal error handling this call.',
      }),
      log,
    );
  } finally {
    call.dispose();
  }
}

function finish(tool, err, req0, log) {
  const result = buildResult({
    outcome: err.outcome,
    effect: tool.effect,
    request: err.request || { ...req0, attempted: err.attempted ?? false },
    verification: err.verification || 'not_applicable',
    httpStatus: err.httpStatus,
    reason: err.reason,
    message: err.message,
    evidence: err.evidence,
  });
  return validated(tool, result, log);
}

// Defensive self-check: the structuredContent we return must match the tool's
// published outputSchema. A mismatch is our bug, not the caller's; surface a
// generic failure rather than an envelope that violates its own contract.
function validated(tool, result, log) {
  const v = validate(tool.output, result.structuredContent);
  if (!v.valid) {
    if (log) log(`output schema violation in ${tool.name}: ${v.errors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
    const fallback = buildResult({
      outcome: 'failed',
      effect: tool.effect,
      request: result.structuredContent.request || { method: tool.method, path: tool.route, attempted: false },
      verification: 'not_applicable',
      reason: 'unexpected_response',
      message: 'The server produced a result that failed its own output contract.',
    });
    return fallback;
  }
  return result;
}

function redact(e) {
  const msg = e && e.message ? String(e.message) : String(e);
  return msg.slice(0, 200);
}
