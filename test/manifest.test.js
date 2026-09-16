import { describe, it, expect } from 'vitest';
import { buildManifest, serializeManifest } from '../src/manifest.js';
import { envelopeSchema } from '../src/schemas.js';

describe('manifest', () => {
  const m = buildManifest();

  it('has the fixed identity fields', () => {
    expect(m.schema_version).toBe(1);
    expect(m.service).toBe('forgejo');
    expect(m.contract).toBe('vbcdx.forgejo/1');
    expect(typeof m.package_version).toBe('string');
  });

  it('lists all 33 tools, sorted by name', () => {
    expect(m.tools).toHaveLength(33);
    const names = m.tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
  });

  it('gives each tool the required fields with a valid effect and permission list', () => {
    for (const t of m.tools) {
      expect(typeof t.name).toBe('string');
      expect(typeof t.description).toBe('string');
      expect(t.inputSchema).toBeTruthy();
      expect(t.outputSchema).toBeTruthy();
      expect(['read', 'write', 'destructive']).toContain(t.effect);
      expect(Array.isArray(t.required_permissions)).toBe(true);
      expect(t.required_permissions.length).toBeGreaterThan(0);
      // every tool requires credential_file
      expect(t.inputSchema.required).toContain('credential_file');
    }
  });

  it('serializes deterministically', () => {
    expect(serializeManifest()).toBe(serializeManifest());
  });

  it('contains no secrets, credential paths, install paths or harness prefixes', () => {
    const text = serializeManifest();
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('VBCDX_FORGEJO_URL');
    expect(text).not.toContain('mcp__');
    expect(text).not.toMatch(/token\s+[A-Za-z0-9]{8,}/);
  });

  it('has exactly the counts of read/write/destructive effects the catalog defines', () => {
    const by = { read: 0, write: 0, destructive: 0 };
    for (const t of m.tools) by[t.effect] += 1;
    expect(by.destructive).toBe(3); // delete_comment, merge_pull_request, cancel_workflow_run
    expect(by.read + by.write + by.destructive).toBe(33);
  });

  it('envelopeSchema requires the four core envelope fields', () => {
    const s = envelopeSchema({ type: 'object' });
    expect(s.required).toEqual(['outcome', 'effect', 'request', 'verification']);
  });
});
