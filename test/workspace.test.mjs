import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore } from '../lib/workspace.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-studio-workspace-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'workspace.json'), store: createWorkspaceStore({ directory }) };
}
const memory = (scopeId, title, extra = {}) => ({ scopeId, title, content: `Contenuto di ${title}`, type: 'fact', status: 'confirmed', source: 'Test utente', sharedWith: [], agentIds: [], ...extra });
const hasTitle = (context, title) => context.memories.some(record => record.title === title);
async function addClient(store, name = 'Cliente A') {
  const snapshot = await store.mutate('createScope', { name, kind: 'client', parentId: 'consulting' });
  return snapshot.scopes.find(scope => scope.name === name).id;
}

test('initialization persists editable draft templates without personal assumptions, with private permissions', async t => {
  const { store, directory, file } = await fixture(t);
  const first = await store.getSnapshot();
  assert.equal(first.version, 1);
  assert.deepEqual(first.scopes.map(scope => scope.id), ['shared', 'personal', 'business', 'development', 'consulting', 'legacy']);
  assert.deepEqual(first.memories, []);
  assert.equal(first.workflows.length, 3);
  assert.ok(first.workflows.every(record => record.status === 'draft'));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  await store.mutate('saveMemory', memory('business', 'Una decisione esplicita'));
  const restored = createWorkspaceStore({ directory });
  assert.equal((await restored.getSnapshot()).memories[0].title, 'Una decisione esplicita');
  first.scopes[0].name = 'Alterato esternamente';
  assert.equal((await store.getSnapshot()).scopes[0].name, 'Profilo condiviso');
});

test('scopes do not inherit context; bridges and global profile are explicit', async t => {
  const { store } = await fixture(t);
  const clientA = await addClient(store);
  const clientB = await addClient(store, 'Cliente B');
  const projectSnapshot = await store.mutate('createScope', { name: 'Progetto A', kind: 'project', parentId: clientA });
  const project = projectSnapshot.scopes.find(scope => scope.name === 'Progetto A').id;
  await store.mutate('saveMemory', memory('personal', 'Personale riservato'));
  await store.mutate('saveMemory', memory('consulting', 'Area consulenza'));
  await store.mutate('saveMemory', memory(clientA, 'Cliente riservato'));
  await store.mutate('saveMemory', memory('personal', 'Ponte autorizzato', { sharedWith: [clientA] }));
  await store.mutate('saveMemory', memory('shared', 'Preferenza globale'));
  const context = await store.getContext({ scopeId: clientA });
  assert.equal(hasTitle(context, 'Personale riservato'), false);
  assert.equal(hasTitle(context, 'Area consulenza'), false);
  assert.equal(hasTitle(context, 'Cliente riservato'), true);
  assert.equal(hasTitle(context, 'Ponte autorizzato'), true);
  assert.equal(hasTitle(context, 'Preferenza globale'), true);
  for (const scopeId of [clientB, project]) {
    const isolated = await store.getContext({ scopeId });
    assert.equal(hasTitle(isolated, 'Cliente riservato'), false);
    assert.equal(hasTitle(isolated, 'Ponte autorizzato'), false);
    assert.equal(hasTitle(isolated, 'Preferenza globale'), true);
  }
  await assert.rejects(store.mutate('saveMemory', memory('personal', 'Global alias', { sharedWith: ['shared'] })), { code: 'VALIDATION_ERROR' });
});

test('proposals and unauthorized agents are excluded, also for the coordinator', async t => {
  const { store } = await fixture(t);
  await store.mutate('saveMemory', memory('development', 'Confermato'));
  await store.mutate('saveMemory', memory('development', 'Proposta', { status: 'proposed' }));
  await store.mutate('saveMemory', memory('shared', 'Solo sviluppatore', { agentIds: ['forge'] }));
  const leader = await store.getContext({ scopeId: 'development' });
  assert.equal(hasTitle(leader, 'Confermato'), true);
  assert.equal(hasTitle(leader, 'Proposta'), false);
  assert.equal(hasTitle(leader, 'Solo sviluppatore'), false);
  assert.equal(hasTitle(await store.getContext({ scopeId: 'development', agentId: 'forge' }), 'Solo sviluppatore'), true);
  await assert.rejects(store.getContext({ scopeId: 'development', agentId: 'unknown' }), { code: 'VALIDATION_ERROR' });
});

test('updates preserve revision history and enforce optimistic versions without poisoning the queue', async t => {
  const { store } = await fixture(t);
  const first = (await store.mutate('saveMemory', memory('business', 'Titolo originale'))).memories[0];
  const second = (await store.mutate('saveMemory', { id: first.id, title: 'Titolo aggiornato', expectedVersion: 1 })).memories[0];
  assert.equal(second.version, 2);
  assert.equal(second.revisions.length, 1);
  assert.equal(second.revisions[0].title, 'Titolo originale');
  assert.equal(second.content, first.content);
  assert.equal(second.revisions[0].revisions, undefined);
  await assert.rejects(store.mutate('saveMemory', { id: first.id, title: 'Update obsoleto', expectedVersion: 1 }), { code: 'VERSION_CONFLICT', status: 409 });
  assert.equal((await store.getSnapshot()).memories[0].version, 2);
  await store.mutate('saveMemory', { id: first.id, status: 'proposed', expectedVersion: 2 });
  assert.equal((await store.getContext({ scopeId: 'business' })).memories.length, 0);
  await store.mutate('deleteMemory', { id: first.id });
  assert.equal((await store.getSnapshot()).memories.length, 0);
});

test('only explicitly selected ready workflows enter context and scope checks apply', async t => {
  const { store } = await fixture(t);
  const seeded = (await store.getSnapshot()).workflows.find(record => record.scopeId === 'business');
  assert.equal((await store.getContext({ scopeId: 'business' })).workflow, null);
  await assert.rejects(store.getContext({ scopeId: 'business', workflowId: seeded.id }), { code: 'NOT_FOUND' });
  await store.mutate('saveWorkflow', { id: seeded.id, status: 'ready', expectedVersion: 1 });
  assert.equal((await store.getContext({ scopeId: 'business', workflowId: seeded.id })).workflow.id, seeded.id);
  await assert.rejects(store.getContext({ scopeId: 'personal', workflowId: seeded.id }), { code: 'NOT_FOUND' });
  await store.mutate('saveWorkflow', { id: seeded.id, sharedWith: ['personal'], expectedVersion: 2 });
  assert.equal((await store.getContext({ scopeId: 'personal', workflowId: seeded.id })).workflow.version, 3);
  assert.equal((await store.getSnapshot()).workflows.find(record => record.id === seeded.id).revisions.length, 2);
  await assert.rejects(store.mutate('saveWorkflow', { id: seeded.id, status: 'draft', expectedVersion: 1 }), { code: 'VERSION_CONFLICT' });
  await store.mutate('deleteWorkflow', { id: seeded.id });
  await assert.rejects(store.getContext({ scopeId: 'business', workflowId: seeded.id }), { code: 'NOT_FOUND' });
});

test('retrieval is deterministic, relevant and bounded, with room for constraints', async t => {
  const { store } = await fixture(t);
  for (let index = 0; index < 12; index++) await store.mutate('saveMemory', memory('development', `React progetto ${index}`, { content: 'React '.repeat(1000) }));
  await store.mutate('saveMemory', memory('development', 'Vincolo di tempo', { type: 'preference', content: 'Disponibile solo al mattino.' }));
  await store.mutate('saveMemory', memory('development', 'Ricetta', { content: 'Ingredienti per la cena.' }));
  const options = { scopeId: 'development', query: 'Come usare React?' };
  const context = await store.getContext(options);
  assert.equal(context.memories.length, 8);
  assert.equal(hasTitle(context, 'Vincolo di tempo'), true);
  assert.equal(hasTitle(context, 'Ricetta'), false);
  assert.ok(context.memories.every(record => record.content.length <= 1500 && record.revisions === undefined));
  assert.ok(context.memories.some(record => record.truncated));
  assert.deepEqual(context, await store.getContext(options));
  await assert.rejects(store.getContext({ ...options, query: 'a'.repeat(12001) }), { code: 'VALIDATION_ERROR' });
});

test('concurrent changes are serialized without lost writes and invalid operations recover', async t => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([
    ...Array.from({ length: 20 }, (_, index) => store.mutate('saveMemory', memory('business', `Memoria ${index}`))),
    store.mutate('saveMemory', memory('missing', 'Non valida')),
    store.mutate('saveMemory', memory('personal', 'Valida dopo errore')),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 21);
  assert.equal((await store.getSnapshot()).memories.length, 21);
  const record = (await store.getSnapshot()).memories[0];
  const concurrent = await Promise.allSettled([
    store.mutate('saveMemory', { id: record.id, title: 'Primo', expectedVersion: 1 }),
    store.mutate('saveMemory', { id: record.id, title: 'Secondo', expectedVersion: 1 }),
  ]);
  assert.equal(concurrent.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(concurrent.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
});

test('malformed or incompatible archives fail closed and recover only after an external repair', async t => {
  const { store, file } = await fixture(t);
  await store.mutate('saveMemory', memory('personal', 'Conservare'));
  const backup = await readFile(file, 'utf8');
  for (const broken of ['{truncated json', JSON.stringify({ ...JSON.parse(backup), version: 999 }), JSON.stringify({ ...JSON.parse(backup), memories: [{ bad: true }] })]) {
    await writeFile(file, broken);
    await assert.rejects(store.getSnapshot(), { code: 'WORKSPACE_CORRUPT' });
    await assert.rejects(store.mutate('saveMemory', memory('business', 'Non sovrascrivere')), { code: 'WORKSPACE_CORRUPT' });
    assert.equal(await readFile(file, 'utf8'), broken);
  }
  await writeFile(file, backup);
  await store.mutate('saveMemory', memory('business', 'Dopo ripristino'));
  assert.equal((await store.getSnapshot()).memories.length, 2);
});

test('invalid shapes and prototype keys cannot affect the archive', async t => {
  const { store } = await fixture(t);
  await assert.rejects(store.mutate('saveMemory', JSON.parse('{"__proto__":{"polluted":true}}')), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.mutate('saveMemory', memory('business', 'Agente duplicato', { agentIds: ['nova', 'nova'] })), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.mutate('createScope', { name: 'Bad', kind: 'client', parentId: 'shared' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.mutate('saveMemory', memory('business', 'Troppo lungo', { content: 'a'.repeat(8001) })), { code: 'VALIDATION_ERROR' });
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal((await store.getSnapshot()).memories.length, 0);
});

test('revoking a bridge takes effect immediately and historical private content never enters context', async t => {
  const { store } = await fixture(t);
  const first = (await store.mutate('saveMemory', memory('personal', 'Regola', { content: 'Dettaglio privato precedente.' }))).memories[0];
  await store.mutate('saveMemory', { id: first.id, content: 'Preferenza autorizzata per il lavoro.', sharedWith: ['business'], expectedVersion: 1 });
  const context = await store.getContext({ scopeId: 'business' });
  assert.equal(hasTitle(context, 'Regola'), true);
  assert.equal(JSON.stringify(context).includes('Dettaglio privato precedente'), false);
  await store.mutate('saveMemory', { id: first.id, sharedWith: [], expectedVersion: 2 });
  assert.equal(hasTitle(await store.getContext({ scopeId: 'business' }), 'Regola'), false);
  assert.equal((await store.getSnapshot()).memories[0].revisions[0].content, 'Dettaglio privato precedente.');
});
