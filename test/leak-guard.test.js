// The whole repository is public (code, tests, CI, docs, vendored copies), so none of it may
// name a private deployment, its hosts or nodes, its tracker, or its team's process. Every
// tracked file is scanned; the only file left out is this one, which has to spell the patterns.
// Its samples are assembled from fragments or synthetic, so it carries no private string either.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SELF = 'test/leak-guard.test.js';
const j = (...parts) => parts.join('');

// [what it catches, pattern, a sample it must match]
const DENY = [
  ['the private forge and its domain', /tam[t]am/i, j('git.tam', 'tam.co')],
  ['a private registry', /verdacci[o]/i, j('verd', 'accio')],
  ['a host or node name', /\bapps-0\d+\b|\bai-tool[s]\b|\bpv[e]\d*\b|\bherme[s]-?\d{2}\b/i, j('apps', '-001')],
  ['a tracker reference by repo shorthand', /\b(?:DEV|DAP|FP|CP|CSD|CW|CDB|vbcdx)#\d+/, j('vbcdx', '#', '1')],
  ['an infrastructure repository', /\binfrastructur[e]\/[a-z][a-z-]+/, j('infrastructure', '/example')],
  ['a Coolify resource id', /\b(?=[a-z0-9]{24}\b)(?=[a-z0-9]*\d)(?=[a-z0-9]*[a-z])[a-z0-9]{24}\b/, 'a1b2c3d4e5f6g7h8i9j0k1l2'],
  ['a private address', /\b10\.\d{1,3}\.\d{1,3}\.\d{1,3}\b|\b192\.168\.\d{1,3}\.\d{1,3}\b|\b172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}\b/, j('10.', '0.0.1')],
  ['an agent credential key', /\bCODER_AGEN[T]\b|FORGEJO_(?:USE[R]|PAS[S])_[A-Z]/, j('CODER', '_AGENT')],
  ['an operator, fork or personal account', /pv[e]-agent|\bfor[k] [A-D]\b|circl[e]-q|tyaboni[l]/i, j('pv', 'e-agent')],
  ['a private tracker repository', /herme[s]-cluster/i, j('hermes', '-cluster')],
  ['a team process term', /\bRule #\d+|\bholacrac[y]\b|\bcrazy-iva[n]\b|\breward-hac[k]\b|\[agent-updat[e]\]|\bpm-agen[t]\b/i, j('Rule', ' #1')],
  ['a bare issue number', /(?<![\w/&])#\d{1,4}\b/, 'see #40'],
  ['a cross-repository tracker reference', /\b[A-Za-z][\w.-]*\/[\w.-]+#\d+/, 'acme/widget-plugin#26'],
  ['a section mark outside the contract wording', /(?<!contract )§\s?\d/, 'spec §3'],
];

// Every file that ships to the public repository: what git tracks. Outside a git checkout,
// fall back to walking the tree.
function tracked() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean).sort();
  } catch {
    const out = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir).sort()) {
        if (['node_modules', '.git', 'coverage'].includes(name)) continue;
        const abs = join(dir, name);
        if (statSync(abs).isDirectory()) walk(abs);
        else out.push(relative(root, abs));
      }
    };
    walk(root);
    return out;
  }
}

const scanned = () => tracked().filter((f) => f !== SELF);

describe('leak guard', () => {
  it('every pattern matches its sample, so none can be weakened silently', () => {
    for (const [what, re, sample] of DENY) expect(re.test(sample), what).toBe(true);
  });

  it('scans every tracked file except this one: no other blind spot', () => {
    const all = tracked();
    expect(all).toContain(SELF);
    expect(all.filter((f) => !scanned().includes(f))).toEqual([SELF]);
    for (const f of ['README.md', 'docs/contract.md', '.forgejo/workflows/ci.yml', 'test/vendor/vbcdx/SOURCE']) expect(all, f).toContain(f);
  });

  it('no file names a private deployment, its tracker or its process', () => {
    const hits = [];
    for (const f of scanned()) {
      let text;
      try {
        text = readFileSync(join(root, f), 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // binary
      text.split('\n').forEach((line, i) => {
        // A destructive tool's confirmation string names its target as owner/repo#id
        // (contract section 6); in test data that is not a tracker reference.
        const scrubbed = line.replace(/\b(?:comment|request|run) [\w.-]+\/[\w.-]+#\d+\b/g, '');
        for (const [what, re] of DENY) if (re.test(scrubbed)) hits.push(`${f}:${i + 1}: ${what}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
