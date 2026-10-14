// Packaging metadata for the public npm package: links to the public
// repository (npm provenance needs it), a supported Node floor, one author, and the files
// a user needs shipped with the code.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('package.json', () => {
  it('points at the public repository, its home page and its issues', () => {
    expect(pkg.repository).toEqual({ type: 'git', url: 'git+https://github.com/VBCDX/forgejo-plugin.git' });
    expect(pkg.homepage).toBe('https://github.com/VBCDX/forgejo-plugin#readme');
    expect(pkg.bugs).toEqual({ url: 'https://github.com/VBCDX/forgejo-plugin/issues' });
  });

  it('needs a supported Node, names one author, and ships the licence, config example and declaration', () => {
    expect(pkg.engines).toEqual({ node: '>=22' });
    expect(pkg.author).toBe('VBCDX');
    for (const f of ['LICENSE', '.env.example', 'vbcdx.json', 'README.md', 'docs/']) expect(pkg.files).toContain(f);
    expect(pkg.exports['./package.json']).toBe('./package.json');
    expect(pkg.scripts.lint).toBe('node scripts/lint.mjs');
  });
});
