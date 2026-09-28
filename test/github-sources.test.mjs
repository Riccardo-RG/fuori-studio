import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createSourceStore } from '../lib/sources.ts';
const blob = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');

test('authenticated GitHub imports preserve immutable provenance, scope, refresh versions and revocation behavior', async () => {
  let time = Date.now(), content = 'The product uses a dedicated review flow.\n', revoked = false, calls = 0;
  const records = new Map(), storage = { read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), write: async (key, value) => records.set(key, structuredClone(value)) };
  const github = async input => {
    calls++; if (revoked || input.scopeId !== 'owned') throw Error('Scope or connection denied');
    return { text: content, commit: (content.includes('updated') ? 'b' : 'a').repeat(40), blobSha: blob(content), repository: input.repository, path: input.path, url: 'ignored-untrusted-url' };
  };
  const store = createSourceStore({ storage, workspace: { getSnapshot: async () => ({ scopes: [{ id: 'owned' }, { id: 'personal' }] }) }, github, now: () => time });
  const input = { scopeId: 'owned', connectionId: 'connection', repository: 'owner/private', ref: 'main', path: 'docs/spec.md' };
  const result = await store.importGitHub(input);
  assert.equal(result.source.kind, 'github'); assert.equal(result.source.refreshable, true);
  assert.equal(result.source.github.blobSha, blob(content)); assert.equal(result.source.github.commit, 'a'.repeat(40));
  assert.equal(result.source.url, `https://github.com/owner/private/blob/${'a'.repeat(40)}/docs/spec.md`);
  assert.equal(result.source.connectionId, undefined);
  assert.equal((await store.retrieve({ scopeId: 'personal', query: 'review' })).passages.length, 0);
  content = 'The product uses an updated review flow.\n';
  const refreshed = await store.refresh({ id: result.source.id, scopeId: 'owned', version: 1 });
  assert.equal(refreshed.source.version, 2); assert.equal(refreshed.source.github.commit, 'b'.repeat(40));
  revoked = true;
  await assert.rejects(store.refresh({ id: result.source.id, scopeId: 'owned', version: 2 }), /denied/);
  assert.equal((await store.detail({ scopeId: 'owned', id: result.source.id })).source.version, 2);
  // Import is a deliberate retained snapshot; revoking access prevents reads, not removal of the user's copy.
  assert.equal((await store.retrieve({ scopeId: 'owned', query: 'review' })).sources.length, 1);
  time += 8 * 86400000;
  assert.equal((await store.retrieve({ scopeId: 'owned', query: 'review' })).sources.length, 0);
  const before = calls;
  for (const path of ['../secret.md', '.env', '.git/config', '/etc/passwd', 'folder//file.md']) await assert.rejects(store.importGitHub({ ...input, path }));
  assert.equal(calls, before);
});

test('GitHub source adapter mismatched content is rejected before storing anything', async () => {
  let saved = false;
  const store = createSourceStore({ storage: { read: async (_key, value) => value, write: async () => { saved = true; } }, workspace: { getSnapshot: async () => ({ scopes: [{ id: 'owned' }] }) }, github: async input => ({ ...input, text: 'wrong content', commit: 'a'.repeat(40), blobSha: 'b'.repeat(40), url: '' }) });
  await assert.rejects(store.importGitHub({ scopeId: 'owned', connectionId: 'connection', repository: 'owner/repo', ref: 'main', path: 'README.md' }), { code: 'SOURCE_GITHUB_INVALID' });
  assert.equal(saved, false);
});
