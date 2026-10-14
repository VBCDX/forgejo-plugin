// vbcdx.json is how `vbcdx install tool` registers this package. It is
// checked with the installer's own validator (vendored under test/vendor/vbcdx until
// @vbcdx/vbcdx is published), and kept true to this package: the same service and
// contract as the manifest, a bin package.json ships, and exactly the settings the source
// reads.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildManifest } from '../src/manifest.js';
import { validateToolDeclaration } from './vendor/vbcdx/src/install/tool-declaration.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const decl = JSON.parse(readFileSync(join(root, 'vbcdx.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const manifest = buildManifest();

function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.js') ? [join(dir, e.name)] : []);
}

describe('vbcdx.json', () => {
  it("passes the vbcdx installer's own validator", () => {
    expect(validateToolDeclaration(decl, { pkg })).toEqual({ ok: true, errors: [] });
  });

  it('is checked by an unmodified copy of that validator', () => {
    const vendor = join(root, 'test', 'vendor', 'vbcdx');
    const listed = readFileSync(join(vendor, 'SOURCE'), 'utf8').split('\n').filter((l) => /^[0-9a-f]{64}  /.test(l));
    expect(listed.length).toBe(4);
    for (const line of listed) {
      const [hash, file] = line.split('  ');
      expect(createHash('sha256').update(readFileSync(join(vendor, file))).digest('hex'), file).toBe(hash);
    }
  });

  it('names the service and contract the manifest reports', () => {
    expect(decl.server_name).toBe(manifest.service);
    expect(decl.contract).toBe(manifest.contract);
  });

  it('starts a bin this package ships, and the package ships the declaration', () => {
    expect(Object.keys(pkg.bin)).toContain(decl.stdio.bin);
    expect(decl.stdio.args).toEqual(['mcp']);
    expect(decl.http.args).toEqual(['serve']);
    expect(decl.manifest.args).toEqual(['manifest']);
    expect(pkg.files).toContain('vbcdx.json');
  });

  it('lists exactly the VBCDX_FORGEJO_* settings the source reads', () => {
    const read = new Set();
    for (const f of [...sourceFiles(join(root, 'src')), ...sourceFiles(join(root, 'bin'))]) {
      for (const m of readFileSync(f, 'utf8').matchAll(/\bVBCDX_FORGEJO_[A-Z_]+[A-Z]\b/g)) read.add(m[0]);
    }
    expect(decl.env.map((e) => e.name).sort()).toEqual([...read].sort());
    expect(decl.env.map((e) => e.name)).toContain(decl.http.port_env);
    expect(decl.env.filter((e) => e.required).map((e) => e.name)).toEqual(['VBCDX_FORGEJO_URL']);
    expect(decl.env.every((e) => e.kind === 'config')).toBe(true); // credentials never come from the environment
  });

  it('marks exactly the network-mode settings as read in http mode only, so no stdio entry carries them', () => {
    // vbcdx writes only stdio-mode settings into a harness entry; an unset
    // network setting there would reach the stdio server as a literal ${VAR} under Hermes.
    const httpOnly = decl.env.filter((e) => e.modes !== undefined);
    for (const e of httpOnly) expect(e.modes, e.name).toEqual(['http']);
    expect(httpOnly.map((e) => e.name).sort()).toEqual([
      'VBCDX_FORGEJO_HTTP_ALLOWED_ORIGINS', 'VBCDX_FORGEJO_HTTP_HOST', 'VBCDX_FORGEJO_HTTP_PORT',
      'VBCDX_FORGEJO_TLS_CERT', 'VBCDX_FORGEJO_TLS_KEY',
    ]);
    for (const e of decl.env) expect(e.description.startsWith('Network mode only'), e.name).toBe(e.modes !== undefined);
  });

  it('declares the per-call credential argument every tool takes', () => {
    expect(decl.credential_file).toEqual({ argument: 'credential_file' });
    for (const t of manifest.tools) expect(Object.keys(t.inputSchema.properties), t.name).toContain('credential_file');
  });
});
