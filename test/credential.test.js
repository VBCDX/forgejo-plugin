import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, symlinkSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCredential, authAttempts } from '../src/credential.js';
import { makeCredFile } from './helpers.js';

function reasonOf(promise) {
  return promise.then(
    () => {
      throw new Error('expected a rejection');
    },
    (e) => e,
  );
}

describe('loadCredential safety', () => {
  it('loads a valid 0600 file in a 0700 directory', async () => {
    const path = makeCredFile();
    const creds = await loadCredential(path);
    expect(creds.role).toBe('code-agent');
    expect(creds.user).toBe('bot');
    expect(creds.token).toBe('secret-token-value');
  });

  it('rejects a relative path with credential_not_absolute', async () => {
    const e = await reasonOf(loadCredential('relative/path.env'));
    expect(e.reason).toBe('credential_not_absolute');
  });

  it('reports credential_missing for an absent file, naming the path', async () => {
    const e = await reasonOf(loadCredential('/nonexistent/vbcdx/x.env'));
    expect(e.reason).toBe('credential_missing');
    expect(e.message).toContain('/nonexistent/vbcdx/x.env');
  });

  it('rejects a world-readable file (wrong mode)', async () => {
    const path = makeCredFile();
    chmodSync(path, 0o644);
    const e = await reasonOf(loadCredential(path));
    expect(e.reason).toBe('credential_unsafe');
  });

  it('rejects a symlinked credential file', async () => {
    const path = makeCredFile();
    const link = `${path}.link`;
    symlinkSync(path, link);
    const e = await reasonOf(loadCredential(link));
    expect(e.reason).toBe('credential_unsafe');
  });

  it('rejects a loose 0755 parent directory', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'vbcdx-loose-'));
    chmodSync(dir, 0o755);
    const path = join(dir, 'c.env');
    writeFileSync(path, 'VBCDX_AGENTS_ROLE=r\nVBCDX_AGENTS_USER=u\nVBCDX_AGENTS_TOKEN=t\n', { mode: 0o600 });
    chmodSync(path, 0o600);
    const e = await reasonOf(loadCredential(path));
    expect(e.reason).toBe('credential_unsafe');
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires USER', async () => {
    const path = makeCredFile({ VBCDX_AGENTS_USER: '' });
    const e = await reasonOf(loadCredential(path));
    expect(e.reason).toBe('credential_key_missing');
  });

  it('requires at least one of token/password', async () => {
    const path = makeCredFile({ VBCDX_AGENTS_TOKEN: null });
    const e = await reasonOf(loadCredential(path));
    expect(e.reason).toBe('credential_key_missing');
  });

  it('rejects an unsupported VBCDX_AGENTS_* field', async () => {
    const path = makeCredFile({ VBCDX_AGENTS_EXTRA: 'x' });
    const e = await reasonOf(loadCredential(path));
    expect(e.reason).toBe('credential_malformed');
  });

  it('never leaks the token value in an error message', async () => {
    const path = makeCredFile({ VBCDX_AGENTS_USER: '', VBCDX_AGENTS_TOKEN: 'TOKEN-LEAK-CANARY' });
    const e = await reasonOf(loadCredential(path));
    expect(e.message).not.toContain('TOKEN-LEAK-CANARY');
  });
});

describe('authAttempts', () => {
  it('prefers token, with a Basic fallback when a password is also present', () => {
    const a = authAttempts({ user: 'u', token: 't', password: 'p' });
    expect(a.map((x) => x.kind)).toEqual(['token', 'basic']);
    expect(a[0].header).toBe('token t');
  });

  it('uses Basic alone when there is no token', () => {
    const a = authAttempts({ user: 'u', password: 'p' });
    expect(a.map((x) => x.kind)).toEqual(['basic']);
  });

  it('offers no fallback for a token-only file', () => {
    const a = authAttempts({ user: 'u', token: 't' });
    expect(a.map((x) => x.kind)).toEqual(['token']);
  });
});
