import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildManifest, serializeManifest } from '../src/manifest.js';
import { envelopeSchema } from '../src/schemas.js';

describe('manifest', () => {
  const m = buildManifest();

  it('README states the catalogue size the manifest has (the counts once drifted)', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    const counts = [...readme.matchAll(/\b(\d+)[- ]tools?\b/g)].map((x) => Number(x[1]));
    expect(counts.length).toBeGreaterThan(0);
    expect(counts).toEqual(counts.map(() => m.tools.length));
  });

  it('has the fixed identity fields', () => {
    expect(m.schema_version).toBe(1);
    expect(m.service).toBe('forgejo');
    expect(m.contract).toBe('vbcdx.forgejo/1');
    expect(typeof m.package_version).toBe('string');
  });

  it('lists all 35 tools, sorted by name', () => {
    expect(m.tools).toHaveLength(35);
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

  it('pins create_repository to effect write, write:organization for the create and read:repository for its read-back (token issuance relies on it)', () => {
    const t = m.tools.find((x) => x.name === 'create_repository');
    expect(t).toBeTruthy();
    expect(t.effect).toBe('write');
    // The verify read is GET /repos/{org}/{name}, a repository-scope route
    // that write:organization alone cannot reach.
    expect(t.required_permissions).toEqual(['write:organization', 'read:repository']);
    expect(t.inputSchema.required).toEqual(expect.arrayContaining(['org', 'name', 'private']));
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
    expect(by.read).toBe(21);
    expect(by.read + by.write + by.destructive).toBe(35);
  });

  // The tool manifest is generated from the registry (no hand edit), so the
  // new review tool and the new list_reviews parameters must show up here.
  it('publishes get_review and the list_reviews filters/cap in the manifest', () => {
    const list = m.tools.find((t) => t.name === 'list_reviews');
    expect(list).toBeTruthy();
    expect(Object.keys(list.inputSchema.properties)).toEqual(
      expect.arrayContaining(['commit_id', 'state', 'body_max_chars']),
    );
    // A prefix shorter than 7 hex characters cannot be accepted.
    expect(list.inputSchema.properties.commit_id.pattern).toBe('^[0-9a-f]{7,64}$');
    expect(list.inputSchema.properties.body_max_chars.minimum).toBe(1);
    expect(list.inputSchema.properties.body_max_chars.maximum).toBe(100000);
    const itemProps = list.outputSchema.properties.data.properties.items.items.properties;
    expect(Object.keys(itemProps)).toEqual(expect.arrayContaining(['body', 'body_truncated', 'body_length']));

    const get = m.tools.find((t) => t.name === 'get_review');
    expect(get).toBeTruthy();
    expect(get.effect).toBe('read');
    expect(get.required_permissions).toEqual(['read:repository']);
    expect(get.inputSchema.required).toEqual(expect.arrayContaining(['owner', 'repo', 'index', 'id']));
    // get_review returns S.review: the full body, no truncation fields.
    expect(get.outputSchema.properties.data.properties.body_truncated).toBeUndefined();
  });

  it('envelopeSchema requires the four core envelope fields', () => {
    const s = envelopeSchema({ type: 'object' });
    expect(s.required).toEqual(['outcome', 'effect', 'request', 'verification']);
  });
});
