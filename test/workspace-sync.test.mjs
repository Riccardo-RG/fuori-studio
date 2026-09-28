import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { recordHash, syncRecord } from '../lib/sync-records.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-workspace-sync-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return createWorkspaceStore({ directory });
}
const note = extra => ({ scopeId: 'business', title: 'Lingua', content: 'Preferisco documentazione in inglese.', type: 'preference', status: 'confirmed', source: 'Test', sharedWith: [], agentIds: ['nova'], ...extra });

test('sync exports selected current records, preserves record identity and never exports local sharing or histories', async t => {
  const store = await fixture(t);
  const original = (await store.mutate('saveMemory', note({ sharedWith: ['personal'] }))).memories[0];
  await store.mutate('saveMemory', { id: original.id, expectedVersion: 1, content: 'Testo aggiornato.' });
  await store.mutate('saveMemory', note({ scopeId: 'personal', title: 'Privato' }));
  const exported = await store.exportSync(['business']);
  assert.deepEqual(exported.scopes.map(scope => scope.id), ['business']);
  assert.equal(exported.memories.length, 1);
  assert.equal(exported.memories[0].id, original.id);
  assert.deepEqual(exported.memories[0].sharedWith, []);
  assert.deepEqual(exported.memories[0].agentIds, ['nova']);
  assert.equal(exported.memories[0].revisions, undefined);
  assert.equal(exported.memories[0].version, undefined);
  assert.equal(JSON.stringify(exported).includes(original.content), false);
  assert.deepEqual(await store.exportSync(['new-remote-project']), { scopes: [], memories: [], workflows: [], tombstones: [] });
});

test('sync imports selected project scopes and records atomically without creating invisible parent scopes', async t => {
  const store = await fixture(t);
  const record = { id: 'remote-memory', ...note({ scopeId: 'remote-project' }) };
  const scope = { id: 'remote-project', name: 'Remote project', kind: 'project', parentId: 'business' };
  const input = { scopeIds: ['remote-project'], scopes: [scope], changes: [{ collection: 'memories', scopeId: scope.id, id: record.id, record, expectedHash: null }] };
  const result = await store.applySync(input);
  assert.equal(result.memories[0].id, record.id);
  assert.equal(result.memories[0].version, 1);
  assert.equal(result.scopes.at(-1).id, scope.id);
  await assert.rejects(store.applySync({ ...input, changes: [], scopes: [{ ...scope, id: 'hidden-parent' }] }), { code: 'SYNC_SCOPE_DENIED' });
  await assert.rejects(store.applySync({ scopeIds: ['orphan'], scopes: [{ ...scope, id: 'orphan', parentId: 'hidden-parent' }], changes: [] }), { code: 'NOT_FOUND' });
  assert.equal((await store.getSnapshot()).scopes.some(item => item.id === 'orphan'), false);
});

test('sync version conflicts roll back the entire batch and cannot erase later local edits', async t => {
  const store = await fixture(t);
  const original = (await store.mutate('saveMemory', note())).memories[0];
  const next = { ...syncRecord(original), content: 'New synchronized content.' };
  const extra = { ...next, id: 'remote-extra', title: 'Extra' };
  await assert.rejects(store.applySync({ scopeIds: ['business'], changes: [
    { collection: 'memories', scopeId: 'business', id: extra.id, record: extra, expectedHash: null },
    { collection: 'memories', scopeId: 'business', id: original.id, record: next, expectedHash: 'stale' },
  ] }), { code: 'VERSION_CONFLICT' });
  assert.equal((await store.getSnapshot()).memories.length, 1);
  const updated = await store.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: original.id, record: next, expectedHash: recordHash(original) }] });
  assert.equal(updated.memories[0].version, 2);
  assert.equal(updated.memories[0].revisions[0].content, original.content);
  await assert.rejects(store.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: original.id, record: null, expectedHash: recordHash(original) }] }), { code: 'VERSION_CONFLICT' });
});

test('sync never transfers scope grants, broadens agent access or moves/deletes a record outside selected scope', async t => {
  const store = await fixture(t);
  const original = (await store.mutate('saveMemory', note({ sharedWith: ['development'] }))).memories[0];
  const apply = (record, extra = {}) => store.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: original.id, record, expectedHash: recordHash(original), ...extra }] });
  await assert.rejects(apply({ ...syncRecord(original), agentIds: [] }), { code: 'SYNC_GRANT_DENIED' });
  await assert.rejects(apply({ ...syncRecord(original), sharedWith: ['personal'] }), { code: 'SYNC_GRANT_DENIED' });
  await assert.rejects(apply({ ...syncRecord(original), scopeId: 'personal' }), { code: 'SYNC_SCOPE_DENIED' });
  await assert.rejects(apply(null, { scopeId: 'personal' }), { code: 'SYNC_SCOPE_DENIED' });
  const updated = await apply({ ...syncRecord(original), title: 'Updated title' });
  assert.deepEqual(updated.memories[0].sharedWith, ['development']);
  assert.deepEqual(updated.memories[0].agentIds, ['nova']);
});

test('sync deletion creates anti-resurrection suppression and importing secrets is rejected atomically', async t => {
  const store = await fixture(t);
  const original = (await store.mutate('saveMemory', note())).memories[0];
  const deleted = await store.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: original.id, record: null, expectedHash: recordHash(original) }] });
  assert.equal(deleted.memories.length, 0);
  assert.equal(deleted.memoryAssistant.suppressions.length, 1);
  await assert.rejects(store.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: 'new-secret-note', record: { ...syncRecord(original), id: 'new-secret-note', content: 'password = NeverStoreThis123' }, expectedHash: null }] }), { code: 'MEMORY_SECRET' });
  assert.equal((await store.getSnapshot()).memories.length, 0);
  await assert.rejects(store.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: original.id, record: syncRecord(original), expectedHash: null }] }), { code: 'SYNC_DELETED' });
  assert.equal((await store.exportSync(['business'])).tombstones[0].id, original.id);
});

test('deletion tombstones survive absent records and workflow deletes and are scoped on export', async t => {
  const store = await fixture(t);
  const workflow = (await store.getSnapshot()).workflows.find(item => item.scopeId === 'business');
  await store.mutate('deleteWorkflow', { id: workflow.id, expectedVersion: workflow.version });
  await store.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: 'already-remote-deleted', record: null, expectedHash: null }] });
  const exported = await store.exportSync(['business']);
  assert.equal(exported.tombstones.length, 2);
  assert.deepEqual((await store.exportSync(['personal'])).tombstones, []);
  await assert.rejects(store.applySync({ scopeIds: ['business'], changes: [{ collection: 'workflows', scopeId: 'business', id: workflow.id, record: syncRecord(workflow), expectedHash: null }] }), { code: 'SYNC_DELETED' });
});
