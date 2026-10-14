// docs/contract.md publishes the contract this package implements. Its tool catalog must
// name exactly the tools the manifest has, with the same effect and token scopes, and state
// the same count, so the published contract cannot drift from the code.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../src/manifest.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const contract = readFileSync(join(root, 'docs', 'contract.md'), 'utf8');
const manifest = buildManifest();

describe('docs/contract.md', () => {
  it('names the contract the manifest reports', () => {
    expect(contract.split('\n')[0]).toContain(`\`${manifest.contract}\``);
  });

  it('lists every tool, with its effect and token scopes, exactly as the manifest does', () => {
    const rows = new Map();
    for (const line of contract.split('\n')) {
      const m = /^\| `([a-z_]+)` \|.*\| (read|write|destructive); ([^|]+) \|$/.exec(line);
      if (m) rows.set(m[1], { effect: m[2], scopes: m[3].split(',').map((s) => s.trim()) });
    }
    expect([...rows.keys()].sort()).toEqual(manifest.tools.map((t) => t.name).sort());
    for (const t of manifest.tools) {
      expect(rows.get(t.name), t.name).toEqual({ effect: t.effect, scopes: t.required_permissions });
    }
    expect(contract).toContain(`There are ${manifest.tools.length} tools.`);
  });

  it('every section a source comment cites exists', () => {
    // Every file under src/, so a citation in a file added later is checked too.
    const cited = new Map();
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) {
          for (const m of readFileSync(p, 'utf8').matchAll(/contract §(\d+)/g)) cited.set(Number(m[1]), p);
        }
      }
    };
    walk(join(root, 'src'));
    expect(cited.size).toBeGreaterThan(0);
    for (const [n, file] of cited) expect(contract, `section ${n} (cited in ${file})`).toMatch(new RegExp(`^## ${n}\\. `, 'm'));
  });
});
