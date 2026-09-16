// The single tool registry.
//
// Every tool group is imported and concatenated here, and this array is the one
// source the MCP server, the manifest and the effect gate all read from. There
// is no hand-maintained second list anywhere: adding a group means importing it
// here, and both tools/list and the manifest pick it up automatically (the
// prior implementation shipped a copy of this list inside its output-contract
// suite, so a whole group could go untested — that cannot recur here).

import { userTools } from './tools/user.js';
import { repoTools } from './tools/repos.js';
import { issueTools } from './tools/issues.js';
import { commentTools } from './tools/comments.js';
import { labelTools } from './tools/labels.js';
import { pullTools } from './tools/pulls.js';
import { reviewTools } from './tools/reviews.js';
import { statusTools } from './tools/statuses.js';
import { actionTools } from './tools/actions.js';

export const TOOLS = [
  ...userTools,
  ...repoTools,
  ...issueTools,
  ...commentTools,
  ...labelTools,
  ...pullTools,
  ...reviewTools,
  ...statusTools,
  ...actionTools,
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

export function getTool(name) {
  return byName.get(name);
}

// Over the network transport credentials arrive in the Authorization header, so
// the per-tool `credential_file` argument is neither required nor accepted. This
// derives that variant once per tool; the stdio catalogue is untouched.
const httpInputByName = new Map(
  TOOLS.map((t) => {
    const props = { ...t.input.properties };
    delete props.credential_file;
    return [
      t.name,
      {
        ...t.input,
        properties: props,
        required: (t.input.required || []).filter((r) => r !== 'credential_file'),
      },
    ];
  }),
);

/** The tool's input schema with `credential_file` removed (network header mode). */
export function httpInputSchema(name) {
  return httpInputByName.get(name);
}

export function toolNames() {
  return TOOLS.map((t) => t.name);
}

// MCP tool annotations derived from the declared effect (spec §5). read =>
// readOnly; write => not read-only, not destructive; destructive => destructive.
export function annotationsFor(effect) {
  return {
    readOnlyHint: effect === 'read',
    destructiveHint: effect === 'destructive',
    idempotentHint: effect === 'read',
    openWorldHint: true,
  };
}
