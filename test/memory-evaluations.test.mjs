import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { createMemoryEvaluations } from '../lib/memory-evaluations.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-evaluation-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const records = new Map(), storage = { read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), write: async (key, value) => records.set(key, structuredClone(value)) };
  const workspace = createWorkspaceStore({ directory });
  const service = createMemoryEvaluations({ storage, workspace });
  const memory = async (title, content, fields = {}) => { const state = await workspace.mutate('saveMemory', { scopeId: 'business', title, content, type: 'fact', status: 'confirmed', source: 'Owner decision', sharedWith: [], agentIds: [], ...fields }); return state.memories.at(-1); };
  const save = async (expectedIds, forbiddenIds = [], fields = {}) => { const state = await service.saveCase({ scopeId: 'business', title: 'Deployment question', query: 'deployment runtime node', agentId: 'forge', expectedIds, forbiddenIds, ...fields }); return state.cases.at(-1); };
  return { records, storage, workspace, service, memory, save };
}

test('real retrieval evaluates owner labels and scope exclusion without copying memory text or invoking AI', async t => {
  const f = await fixture(t), expected = await f.memory('Deployment runtime', 'Use Node 24 for this studio.'), privateNote = await f.memory('Private deployment runtime', 'Personal confidential decision.', { scopeId: 'personal' });
  const item = await f.save([expected.id], [privateNote.id]);
  const result = await f.service.runCase({ id: item.id, expectedVersion: item.version }), run = result.runs[0];
  assert.equal(run.status, 'passed'); assert.equal(run.recall, 1); assert.equal(run.expectedShare, 1); assert.deepEqual(run.matched, [expected.id]);
  assert.equal(result.summary.measured, 1); assert.equal(result.noAiCalls, true);
  assert.doesNotMatch(JSON.stringify(f.records.get('memory-evaluations')), /Personal confidential|Use Node 24/);
  assert.equal((await f.service.snapshot({ scopeId: 'personal' })).runs.length, 0);
});

test('missing and forbidden selections fail honestly, and a new case has no invented quality score', async t => {
  const f = await fixture(t), absent = await f.memory('Travel', 'Ride a bicycle.'), constraint = await f.memory('Documentation policy', 'Write technical docs in English.', { type: 'decision' });
  const item = await f.save([absent.id], [constraint.id]);
  assert.equal((await f.service.snapshot({ scopeId: 'business' })).summary.measured, 0);
  const result = await f.service.runCase({ id: item.id, expectedVersion: item.version }), run = result.runs[0];
  assert.equal(run.status, 'failed'); assert.equal(run.recall, 0); assert.deepEqual(run.missing, [absent.id]); assert.deepEqual(run.forbidden, [constraint.id]);
  assert.equal(run.selected[0].rank, 1);
  const empty = await f.save([], [absent.id], { title: 'Only exclusion' });
  const only = (await f.service.runCase({ id: empty.id, expectedVersion: empty.version })).runs.at(-1);
  assert.equal(only.recall, null); assert.equal(only.status, 'passed');
});

test('version, deletion and grant changes require reviewed labels and invalidate current summaries', async t => {
  const f = await fixture(t), memory = await f.memory('Deployment runtime', 'Use Node 24.');
  let item = await f.save([memory.id]);
  await f.service.runCase({ id: item.id, expectedVersion: item.version });
  await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'Use updated deployment runtime.' });
  let snapshot = await f.service.snapshot({ scopeId: 'business' });
  assert.deepEqual(snapshot.cases[0].stale, [memory.id]); assert.equal(snapshot.summary.measured, 0); assert.equal(snapshot.runs[0].current, false);
  snapshot = await f.service.runCase({ id: item.id, expectedVersion: item.version });
  assert.equal(snapshot.runs.at(-1).status, 'needs-review'); assert.equal(snapshot.runs.at(-1).recall, null);
  item = await f.save([memory.id], [], { id: item.id, expectedVersion: item.version });
  assert.equal((await f.service.runCase({ id: item.id, expectedVersion: item.version })).runs.at(-1).status, 'passed');
  const current = (await f.workspace.getSnapshot()).memories[0];
  await f.workspace.mutate('saveMemory', { id: current.id, expectedVersion: current.version, agentIds: ['muse'] });
  await assert.rejects(f.save([memory.id], [], { id: item.id, expectedVersion: item.version }), { code: 'EVALUATION_MEMORY_DENIED' });
  const revised = (await f.workspace.getSnapshot()).memories[0]; await f.workspace.mutate('deleteMemory', { id: revised.id, expectedVersion: revised.version });
  assert.deepEqual((await f.service.snapshot({ scopeId: 'business' })).cases[0].stale, [memory.id]);
});

test('bounded retrieval exposes missing labels and truncation for real overfull contexts', async t => {
  const f = await fixture(t), ids = [];
  for (let i = 0; i < 10; i++) ids.push((await f.memory(`Deployment runtime ${i}`, 'deployment '.repeat(160))).id);
  const item = await f.save(ids);
  const run = (await f.service.runCase({ id: item.id, expectedVersion: item.version })).runs[0];
  assert.equal(run.selected.length, 8); assert.equal(run.missing.length, 2); assert.equal(run.recall, 0.8); assert.equal(run.status, 'failed'); assert.ok(run.selected.every(item => item.truncated));
});

test('stale saves, unauthorized positive labels, secrets, feedback drift and case removal are explicit', async t => {
  const f = await fixture(t), personal = await f.memory('Private', 'Deployment runtime.', { scopeId: 'personal' }), memory = await f.memory('Deployment', 'Deployment runtime.');
  await assert.rejects(f.save([personal.id]), { code: 'EVALUATION_MEMORY_DENIED' });
  await assert.rejects(f.save([memory.id], [memory.id]));
  await assert.rejects(f.save([memory.id], [], { query: 'api_key=privatecredential123' }));
  const item = await f.save([memory.id]);
  await assert.rejects(f.service.runCase({ id: item.id, expectedVersion: 90 }), { code: 'VERSION_CONFLICT' });
  await f.service.runCase({ id: item.id, expectedVersion: item.version });
  await f.service.feedback({ memoryId: memory.id, memoryVersion: memory.version, helpful: false, note: 'Needs a more precise constraint.' });
  await assert.rejects(f.service.feedback({ memoryId: memory.id, memoryVersion: memory.version, helpful: true }), { code: 'VERSION_CONFLICT' });
  await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'Deployment runtime Node 24.' });
  assert.equal((await f.service.snapshot({ scopeId: 'business' })).feedback[0].current, false);
  const result = await f.service.removeCase({ id: item.id, expectedVersion: item.version });
  assert.equal(result.cases.length, 0); assert.equal(result.runs.length, 0);
});

test('context changed during retrieval or unsafe selection cannot be recorded as a passing result', async () => {
  const memory = { id: 'memory', version: 1, scopeId: 'business', title: 'Deployment', status: 'confirmed', agentIds: [], sharedWith: [] };
  const state = { scopes: [{ id: 'business' }], memories: [memory] }, records = new Map();
  let mutate = true;
  const workspace = { getSnapshot: async () => structuredClone(state), getContext: async () => { if (mutate) memory.version++; return { memories: [{ ...memory, id: 'unauthorized' }] }; } };
  const service = createMemoryEvaluations({ workspace, storage: { read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), write: async (key, value) => records.set(key, structuredClone(value)) } });
  const fields = { scopeId: 'business', title: 'Deployment', query: 'deployment', agentId: 'forge', expectedIds: ['memory'], forbiddenIds: [] };
  let item = (await service.saveCase(fields)).cases[0];
  await assert.rejects(service.runCase({ id: item.id, expectedVersion: item.version }), { code: 'EVALUATION_CONTEXT_CHANGED' });
  assert.equal((await service.snapshot({ scopeId: 'business' })).runs.length, 0);
  mutate = false; item = (await service.saveCase({ ...fields, id: item.id, expectedVersion: item.version })).cases[0];
  const run = (await service.runCase({ id: item.id, expectedVersion: item.version })).runs[0]; assert.equal(run.status, 'failed'); assert.deepEqual(run.violations, ['unauthorized']);
});

test('unrelated private edits preserve a measurement; a newly eligible shared note requires another run', async t => {
  const f = await fixture(t), memory = await f.memory('Deployment runtime', 'Use Node 24.');
  const item = await f.save([memory.id]);
  await f.service.runCase({ id: item.id, expectedVersion: item.version });
  const privateNote = await f.memory('Deployment personal', 'Personal deployment plan.', { scopeId: 'personal' });
  assert.equal((await f.service.snapshot({ scopeId: 'business' })).summary.measured, 1);
  await f.workspace.mutate('saveMemory', { id: privateNote.id, expectedVersion: privateNote.version, sharedWith: ['business'] });
  const changed = await f.service.snapshot({ scopeId: 'business' });
  assert.equal(changed.summary.measured, 0); assert.deepEqual(changed.cases[0].stale, []);
  const measured = await f.service.runCase({ id: item.id, expectedVersion: item.version });
  assert.equal(measured.summary.measured, 1); assert.equal(measured.runs.at(-1).selected.length, 2);
});
