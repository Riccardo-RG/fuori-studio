import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { createOperationsStore } from '../lib/operations.mjs';
import { createTaskExecutor } from '../lib/executor.mjs';
import { createPlanService } from '../lib/plans.ts';
import { configureSourceContext } from '../lib/context.mjs';

const nodes = [{ key: 'prepare', title: 'Prepare milestone', brief: 'Prepare a measurable milestone.', agentId: 'forge', dependsOn: [] }, { key: 'review', title: 'Review milestone', brief: 'Review the measurable milestone.', agentId: 'forge', dependsOn: ['prepare'] }];
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-plan-executor-'));
  const workspace = createWorkspaceStore({ directory }), operations = createOperationsStore({ directory });
  const calls = [], policy = { allowed: true };
  const providers = {
    async assertAllowed() { if (!policy.allowed) throw Error('Provider policy revoked'); return { id: 'fixture', type: 'fixture' }; },
    async execute(input) { calls.push(input); return { text: input.prompt.includes("Scomponi l'obiettivo") ? JSON.stringify({ title: 'Reviewed plan', nodes }) : 'SUPPORTED_ARTIFACT', provider: { id: 'fixture', type: 'fixture' }, usage: null, durationMs: 1 }; },
  };
  const executor = createTaskExecutor({ operations, workspace, providers });
  t.after(async () => { configureSourceContext(null); await executor.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const project = (await operations.mutate('createProject', { title: 'Product', scopeId: 'business' })).projects[0];
  const plans = createPlanService({ operations, workspace, providers });
  const draft = () => plans.draft({ projectId: project.id, brief: 'Prepare a measurable milestone.' });
  const note = async extra => (await workspace.mutate('saveMemory', { scopeId: 'business', title: 'Milestone invariant', content: 'Use a measurable milestone backed by evidence.', status: 'confirmed', type: 'preference', ...extra })).memories.at(-1);
  const current = async id => (await operations.getSnapshot()).tasks.find(item => item.id === id);
  async function settle(id) { for (let attempt = 0; attempt < 300; attempt++) { if (!executor.busy) return current(id); await new Promise(resolve => setTimeout(resolve, 5)); } throw Error('Executor did not settle'); }
  async function parentGraph() {
    const graph = await operations.mutate('createTaskGraph', { projectId: project.id, title: 'Dependency review', nodes, context: { memories: [], workflows: [], sources: [] } });
    const [parent, child] = graph.tasks; await executor.start(parent.id, parent.version);
    const reviewed = await settle(parent.id); assert.equal(reviewed.status, 'review', JSON.stringify(reviewed.events));
    await operations.mutate('approveTask', { id: parent.id, expectedVersion: reviewed.version });
    return { parent, child };
  }
  return { workspace, operations, providers, executor, plans, project, calls, policy, draft, note, current, parentGraph };
}

test('a plan cannot launder leader-only memories into another agent generated brief', async t => {
  const f = await fixture(t); await f.note({ agentIds: ['nova'] });
  const draft = await f.draft(); const graph = await f.plans.commit({ id: draft.id });
  assert.equal(f.calls.length, 1); assert.equal(graph.tasks[0].inputContext.memories.length, 1);
  await assert.rejects(f.executor.start(graph.tasks[0].id), /non è accessibile/);
  assert.equal(f.calls.length, 1); assert.equal((await f.current(graph.tasks[0].id)).status, 'queued');
});

test('dependency evidence keeps its original version even when retrieval selects the revised same memory', async t => {
  const f = await fixture(t), memory = await f.note(); const { child } = await f.parentGraph();
  await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'Use a measurable milestone with the revised invariant.' });
  assert.equal((await f.workspace.getContext({ scopeId: 'business', agentId: 'forge', query: child.brief })).memories[0].version, memory.version + 1);
  await assert.rejects(f.executor.start(child.id), /contesto.*cambiato/);
  assert.equal(f.calls.length, 1); assert.equal((await f.current(child.id)).status, 'queued');
});

test('plan input evidence cannot be overwritten by fresh retrieval of the same memory', async t => {
  const f = await fixture(t), memory = await f.note(), draft = await f.draft();
  const graph = await f.plans.commit({ id: draft.id });
  await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'Use a measurable milestone with new acceptance evidence.' });
  await assert.rejects(f.executor.start(graph.tasks[0].id), /contesto.*cambiato/);
  assert.equal(f.calls.length, 1);
});

test('an approved restricted dependency remains private when assigned to another recipient', async t => {
  const f = await fixture(t); await f.note({ agentIds: ['forge'] });
  const customNodes = [nodes[0], { ...nodes[1], agentId: 'nova' }];
  const graph = await f.operations.mutate('createTaskGraph', { projectId: f.project.id, title: 'Recipient audit', nodes: customNodes, context: { memories: [], workflows: [] } });
  const [parent, child] = graph.tasks;
  await f.executor.start(parent.id); while (f.executor.busy) await new Promise(resolve => setTimeout(resolve, 5));
  const delivery = await f.current(parent.id); await f.operations.mutate('approveTask', { id: parent.id, expectedVersion: delivery.version });
  await assert.rejects(f.executor.start(child.id), /non è accessibile/); assert.equal(f.calls.length, 1);
});

test('updated and expired document sources cannot return through approved dependency output', async t => {
  const f = await fixture(t);
  const source = { id: 'source-one', scopeId: 'business', title: 'Milestone requirements', version: 1, digest: 'a'.repeat(64), url: null, status: 'current' };
  configureSourceContext({ allMetadata: async () => [structuredClone(source)], retrieve: async () => ({ sources: source.status === 'current' ? [structuredClone(source)] : [], passages: [], truncated: false }) });
  const { child } = await f.parentGraph(); source.version = 2; source.digest = 'b'.repeat(64);
  await assert.rejects(f.executor.start(child.id), /fonte.*cambiata/); assert.equal(f.calls.length, 1);
  source.version = 1; source.digest = 'a'.repeat(64); source.status = 'expired';
  await assert.rejects(f.executor.start(child.id), /fonte.*cambiata/); assert.equal(f.calls.length, 1);
});

test('draft capacity is checked before a paid call and concurrent commits create a single graph', async t => {
  const f = await fixture(t), drafts = [];
  for (let index = 0; index < 20; index++) drafts.push(await f.draft());
  await assert.rejects(f.draft(), /Troppi piani/); assert.equal(f.calls.length, 20);
  const commits = await Promise.allSettled([f.plans.commit({ id: drafts[0].id }), f.plans.commit({ id: drafts[0].id })]);
  assert.equal(commits.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal((await f.operations.getSnapshot()).tasks.length, 2); assert.equal(f.calls.length, 20);
  await f.draft(); assert.equal(f.calls.length, 21, 'a consumed proposal frees exactly one slot');
});

test('failed plan preflight restores the same reviewable draft without duplicate tasks or extra calls', async t => {
  const f = await fixture(t), draft = await f.draft(); f.policy.allowed = false;
  await assert.rejects(f.plans.commit({ id: draft.id }), /Provider policy revoked/);
  assert.equal((await f.operations.getSnapshot()).tasks.length, 0);
  f.policy.allowed = true; const graph = await f.plans.commit({ id: draft.id });
  assert.deepEqual(graph.tasks.map(task => task.title), nodes.map(node => node.title));
  await assert.rejects(f.plans.commit({ id: draft.id }), /scaduta o già utilizzata/);
  assert.equal((await f.operations.getSnapshot()).tasks.length, 2); assert.equal(f.calls.length, 1);
});
