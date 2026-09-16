// The write-mode gate (spec §5).
//
// It is an accident control, not a human-approval or identity boundary. It runs
// before any credential read or network request and cannot be bypassed through
// aliases or helper calls. `off` refuses writes; `write` allows ordinary
// writes; `full` also allows destructive tools. All tools stay discoverable
// regardless of mode. The real controls are token scopes, repository
// permissions and branch protection — the server cannot guarantee independent
// reviewers or prevent self-approval.

import { refused } from './errors.js';

/**
 * @param {string} effect  'read' | 'write' | 'destructive'
 * @param {object} config  loaded configuration
 * @throws {ToolError} refused/write_gate_disabled when the mode forbids the effect
 */
export function assertGate(effect, config) {
  if (effect === 'read') return;

  const invalidNote =
    config.writesInvalid != null
      ? ` VBCDX_FORGEJO_WRITES is set to an unrecognised value ("${config.writesInvalid}") and is treated as off.`
      : '';

  if (effect === 'write') {
    if (config.writes === 'write' || config.writes === 'full') return;
    throw refused(
      'write_gate_disabled',
      `Write tools are disabled. Set VBCDX_FORGEJO_WRITES=write (or full) to allow this write.${invalidNote}`,
    );
  }

  if (effect === 'destructive') {
    if (config.writes === 'full') return;
    throw refused(
      'write_gate_disabled',
      `Destructive tools require VBCDX_FORGEJO_WRITES=full. The current mode does not permit this operation.${invalidNote}`,
    );
  }
}
