import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { createPortability } from '../lib/portability.mjs';

const password = 'A long private test passphrase';
const note = extra => ({ scopeId: 'business', title: 'Documentation language', content: 'Preferisco documentazione tecnica in inglese.', type: 'preference', status: 'confirmed', source: 'User message original-source-id', sharedWith: ['development'], agentIds: ['nova'], ...extra });
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-portability-'));
  const storage = createArchive({ directory, mode: 'local' });
  const workspace = createWorkspaceStore({ directory, storage });
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, storage, workspace, service: createPortability({ workspace, storage, ...options }) };
}
async function seeded(t) {
  const f = await fixture(t);
  const original = (await f.workspace.mutate('saveMemory', note())).memories[0];
  await f.workspace.mutate('saveMemory', { id: original.id, expectedVersion: 1, content: 'PORTABLE_KNOWLEDGE_MARKER Preferisco documentazione tecnica in inglese.' });
  await f.workspace.mutate('saveMemory', note({ scopeId: 'personal', title: 'Private', content: 'PERSONAL_EXCLUDED_MARKER' }));
  await f.workspace.mutate('saveMemory', note({ title: 'Pending', status: 'proposed', content: 'PROPOSED_EXCLUDED_MARKER' }));
  const workflow = (await f.workspace.getSnapshot()).workflows.find(item => item.scopeId === 'business');
  await f.workspace.mutate('saveWorkflow', { id: workflow.id, expectedVersion: 1, status: 'ready' });
  return { ...f, original, workflow };
}

test('portable JSON and Markdown contain selected confirmed knowledge, source references and no grants, history or credentials', async t => {
  const f = await seeded(t);
  const exported = await f.service.export({ scopeIds: ['business'], format: 'json' });
  const manifest = JSON.parse(exported.content);
  assert.deepEqual(exported.counts, { memories: 1, workflows: 1 });
  assert.deepEqual(manifest.scopes.map(item => item.id), ['business']);
  assert.deepEqual(manifest.memories[0].sharedWith, []);
  assert.deepEqual(manifest.memories[0].agentIds, ['nova']);
  assert.equal(manifest.memories[0].version, undefined);
  assert.equal(manifest.memories[0].revisions, undefined);
  assert.match(manifest.memories[0].source, /original-source-id/);
  assert.doesNotMatch(exported.content, /PERSONAL_EXCLUDED_MARKER|PROPOSED_EXCLUDED_MARKER|revisions|apiKey|conversations/);
  assert.match(exported.warnings[0], /chiaro/);
  const readable = await f.service.export({ scopeIds: ['business'], format: 'markdown' });
  assert.match(readable.filename, /\.md$/);
  assert.match(readable.content, /PORTABLE_KNOWLEDGE_MARKER/);
  await assert.rejects(f.service.preview({ content: readable.content, targetScopeId: 'development' }), { code: 'INVALID_IMPORT' });
});

test('encrypted export has fixed authenticated encryption, random salts and no plaintext; wrong passphrases or tampering never import', async t => {
  const f = await seeded(t);
  const first = await f.service.export({ scopeIds: ['business'], passphrase: password });
  const second = await f.service.export({ scopeIds: ['business'], passphrase: password });
  assert.match(first.filename, /\.fs-memory$/);
  assert.doesNotMatch(first.content, /PORTABLE_KNOWLEDGE_MARKER|original-source-id|Documentation language/);
  assert.notEqual(first.content, second.content);
  const envelope = JSON.parse(first.content);
  assert.equal(envelope.kdf.N, 32768); assert.equal(envelope.cipher.name, 'aes-256-gcm');
  await assert.rejects(f.service.preview({ content: first.content, passphrase: 'Wrong but long password', targetScopeId: 'development' }), { code: 'IMPORT_DECRYPTION_FAILED' });
  const changed = { ...envelope, ciphertext: (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1) };
  await assert.rejects(f.service.preview({ content: JSON.stringify(changed), passphrase: password, targetScopeId: 'development' }), { code: 'IMPORT_DECRYPTION_FAILED' });
  await assert.rejects(f.service.preview({ content: JSON.stringify({ ...envelope, kdf: { ...envelope.kdf, N: 1048576 } }), passphrase: password, targetScopeId: 'development' }), { code: 'INVALID_IMPORT' });
  await assert.rejects(f.service.export({ scopeIds: ['business'], passphrase: 'short' }), { code: 'INVALID_PASSPHRASE' });
  assert.equal((await f.workspace.getSnapshot()).memories.filter(item => item.scopeId === 'development').length, 0);
});

test('preview creates no notes, commit creates proposed/draft records with new IDs and restricted agents, retry is idempotent', async t => {
  const source = await seeded(t), target = await fixture(t);
  const exported = await source.service.export({ scopeIds: ['business'], passphrase: password });
  const preview = await target.service.preview({ content: exported.content, passphrase: password, targetScopeId: 'development' });
  assert.deepEqual(preview.counts, { memories: 1, workflows: 1, duplicates: 0, conflicts: 0 });
  assert.deepEqual(preview.items.map(item => item.status), ['proposed', 'draft']);
  assert.equal((await target.workspace.getSnapshot()).memories.length, 0);
  const pending = await target.storage.read(`portability/import/${preview.importId}`);
  assert.equal(JSON.stringify(pending).includes(password), false);
  const result = await target.service.commit({ importId: preview.importId });
  assert.deepEqual(result.imported, { memories: 1, workflows: 1 });
  const note = result.snapshot.memories[0];
  assert.notEqual(note.id, source.original.id); assert.equal(note.scopeId, 'development'); assert.equal(note.status, 'proposed');
  assert.deepEqual(note.sharedWith, []); assert.deepEqual(note.agentIds, ['nova']);
  assert.match(note.source, /business\//);
  assert.equal((await target.workspace.getContext({ scopeId: 'development' })).memories.length, 0);
  const repeated = await target.service.commit({ importId: preview.importId });
  assert.deepEqual(repeated.imported, result.imported);
  assert.equal(repeated.snapshot.memories.length, 1);
  const completed = await target.storage.read(`portability/import/${preview.importId}`);
  assert.equal(completed.records, undefined);
  const database = await readFile(join(target.directory, 'studio.sqlite'));
  assert.equal(database.includes(Buffer.from('PORTABLE_KNOWLEDGE_MARKER')), false);
});

test('duplicate and same-title conflicts are previewed and skipped; changes after preview never overwrite local work', async t => {
  const f = await seeded(t);
  const exported = await f.service.export({ scopeIds: ['business'], format: 'json' });
  const same = await f.service.preview({ content: exported.content, targetScopeId: 'business' });
  assert.equal(same.counts.duplicates, 2);
  assert.deepEqual((await f.service.commit({ importId: same.importId })).imported, { memories: 0, workflows: 0 });
  const other = await f.service.preview({ content: exported.content, targetScopeId: 'development' });
  await f.workspace.mutate('saveMemory', note({ scopeId: 'development', content: 'Local change after preview.' }));
  const committed = await f.service.commit({ importId: other.importId });
  assert.equal(committed.skipped.conflicts, 1);
  assert.equal(committed.snapshot.memories.find(item => item.scopeId === 'development').content, 'Local change after preview.');
});

test('expired previews are wiped and rejected; restart and a post-commit write failure do not duplicate imports', async t => {
  let clock = Date.now();
  const source = await seeded(t), target = await fixture(t, { now: () => clock });
  const exported = await source.service.export({ scopeIds: ['business'], format: 'json' });
  const expired = await target.service.preview({ content: exported.content, targetScopeId: 'development' });
  clock += 16 * 60 * 1000;
  await assert.rejects(target.service.commit({ importId: expired.importId }), { code: 'IMPORT_EXPIRED' });
  assert.equal((await target.storage.read(`portability/import/${expired.importId}`)).records, undefined);
  const preview = await target.service.preview({ content: exported.content, targetScopeId: 'development' });
  const flaky = { read: (...args) => target.storage.read(...args), write: (...args) => target.storage.write(...args), batch: entries => entries.some(entry => entry.value?.status === 'committed') ? Promise.reject(Error('Simulated crash after durable workspace commit')) : target.storage.batch(entries) };
  await assert.rejects(createPortability({ workspace: target.workspace, storage: flaky, now: () => clock }).commit({ importId: preview.importId }), /Simulated crash/);
  assert.equal((await target.workspace.getSnapshot()).memories.length, 1);
  const restarted = createPortability({ workspace: createWorkspaceStore({ directory: target.directory, storage: target.storage }), storage: target.storage, now: () => clock });
  assert.equal((await restarted.commit({ importId: preview.importId })).snapshot.memories.length, 1);
});

test('imports reject unknown fields, credentials, executable structures, grants, oversized content and global targets', async t => {
  const f = await seeded(t);
  const exported = JSON.parse((await f.service.export({ scopeIds: ['business'], format: 'json' })).content);
  for (const mutate of [
    value => { value.memories[0].sharedWith = ['personal']; },
    value => { value.memories[0].content = 'password = DontStoreThis123'; },
    value => { value.memories[0].agentIds = ['nova', 'nova']; },
    value => { value.memories[0].content = 'x'.repeat(8001); },
    value => { value.workflows[0].steps[0].command = 'rm -rf'; },
    value => { value.credentials = { accessToken: 'hidden' }; },
  ]) {
    const changed = structuredClone(exported); mutate(changed);
    await assert.rejects(f.service.preview({ content: JSON.stringify(changed), targetScopeId: 'development' }));
  }
  await assert.rejects(f.service.preview({ content: JSON.stringify(exported), targetScopeId: 'shared' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(f.service.preview({ content: 'x'.repeat(12 * 1024 * 1024 + 1), targetScopeId: 'development' }), { code: 'IMPORT_TOO_LARGE' });
  assert.equal((await f.workspace.getSnapshot()).memories.filter(item => item.scopeId === 'development').length, 0);
});
