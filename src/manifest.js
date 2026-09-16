// The `manifest` command output (spec §7).
//
// A deterministic JSON object describing the offline tool interface for the
// agents installer. It performs no network or file-secret access and starts no
// server. The same registry that drives runtime schemas and the effect gate
// drives this, so the portable manifest cannot drift from the live tools. No
// secrets, credential paths, installation paths or native harness prefixes
// appear here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SERVICE, CONTRACT } from './constants.js';
import { TOOLS } from './registry.js';

function packageVersion() {
  const url = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'));
  return pkg.version;
}

export function buildManifest() {
  const tools = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input,
    outputSchema: t.output,
    effect: t.effect,
    required_permissions: [...t.permissions],
  })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  return {
    schema_version: 1,
    service: SERVICE,
    contract: CONTRACT,
    package_version: packageVersion(),
    tools,
  };
}

// Serialize with sorted keys so the output is byte-stable across runs.
export function serializeManifest(manifest = buildManifest()) {
  return JSON.stringify(sortKeys(manifest), null, 2);
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
