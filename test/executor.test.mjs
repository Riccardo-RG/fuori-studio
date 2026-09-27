import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationsStore } from '../lib/operations.mjs';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { createTaskExecutor } from '../lib/executor.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 5000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(15); }
  throw Error(`Timed out waiting for ${label}.`);
}
async function fixture(t, implementation) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-executor-'));
  const workspace = createWorkspaceStore({ directory });
  const operations = createOperationsStore({ directory });
  const calls = [], checks = [], policies = new Map();
  const providers = {
    async assertAllowed(options) {
      checks.push(options);
      if (policies.has(options.scopeId) && !policies.get(options.scopeId).includes('mock')) throw Object.assign(Error('Source scope denies provider'), { code: 'PROVIDER_NOT_ALLOWED', statusCode: 403 });
      return { id: 'mock', type: 'mock', model: 'fixture' };
    },
    async execute(options) {
      calls.push(options);
      const text = implementation ? await implementation(options, calls.length) : `Result ${calls.length} from ${options.agentId}`;
      return { text, provider: { id: 'mock', type: 'mock', model: 'fixture' }, usage: { inputTokens: 10, outputTokens: 20 }, durationMs: 1 };
    },
  };
  const executor = createTaskExecutor({ operations, workspace, providers });
  t.after(async () => { await executor.shutdown(); await rm(directory, { recursive: true, force: true }); });
  const project = (await operations.mutate('createProject', { title: 'Owned product', scopeId: 'business' })).projects[0];
  const createTask = async extra => (await operations.mutate('createTask', { projectId: project.id, title: 'Milestone proposal', brief: 'Prepare a measurable milestone.', agentId: 'forge', ...extra })).tasks.at(-1);
  const currentTask = async id => (await operations.getSnapshot()).tasks.find(task => task.id === id);
  const settle = async id => { await until(() => !executor.busy, 'executor idle'); return currentTask(id); };
  return { directory, workspace, operations, executor, providers, calls, checks, policies, project, createTask, currentTask, settle };
}
async function note(workspace, extra = {}) {
  return (await workspace.mutate('saveMemory', { scopeId: 'business', title: 'Milestone constraint', content: 'Use evidence and measurable criteria.', type: 'preference', status: 'confirmed', source: 'Explicit fixture', agentIds: [], sharedWith: [], ...extra })).memories.at(-1);
}
async function workflow(workspace) {
  return (await workspace.mutate('saveWorkflow', { scopeId: 'business', title: 'Research and draft', description: 'Process fixture', input: 'Supplied evidence', output: 'Reviewed draft', status: 'ready', steps: [{ title: 'Research', agentId: 'radar', output: 'List supported findings.' }, { title: 'Draft', agentId: 'forge', output: 'Propose the next milestone.' }] })).workflows.at(-1);
}
const workflowSteps = record => record.steps.map(step => ({ title: step.title, agentId: step.agentId, instruction: step.output }));

test('executor produces reviewed versions and a proposed memory while preserving restricted-agent provenance', async t => {
  const f = await fixture(t);
  const memory = await note(f.workspace, { agentIds: ['forge'] });
  let task = await f.createTask();
  await f.executor.start(task.id, task.version);
  task = await f.settle(task.id);
  assert.equal(task.status, 'review'); assert.equal(task.artifacts[0].decision, 'pending');
  assert.equal(task.steps[0].execution.provider.id, 'mock');
  assert.deepEqual(task.artifacts[0].context.memories.map(ref => ref.id), [memory.id]);
  await assert.rejects(f.executor.proposeMemory({ id: task.id, title: 'Too early', content: 'Draft' }), /Approva/);
  task = (await f.operations.mutate('requestChanges', { id: task.id, expectedVersion: task.version, feedback: 'Include a measurable criterion.' })).tasks[0];
  await f.executor.start(task.id, task.version);
  task = await f.settle(task.id);
  assert.equal(task.artifacts.length, 2); assert.equal(task.artifacts[0].decision, 'changes_requested');
  assert.ok(f.calls[1].prompt.includes('Include a measurable criterion.'));
  task = (await f.operations.mutate('approveTask', { id: task.id, expectedVersion: task.version })).tasks[0];
  const snapshot = await f.executor.proposeMemory({ id: task.id, title: 'Reusable milestone review', content: 'Require measurable acceptance criteria.', type: 'pattern' });
  const proposal = snapshot.memories.at(-1);
  assert.equal(proposal.status, 'proposed'); assert.deepEqual(proposal.agentIds, ['forge']); assert.deepEqual(proposal.sharedWith, []);
  assert.equal((await f.workspace.getContext({ scopeId: 'business', agentId: 'forge' })).memories.some(item => item.id === proposal.id), false);
});

test('source-scope provider policy rejects a shared note before any model call', async t => {
  const f = await fixture(t);
  await note(f.workspace, { scopeId: 'personal', sharedWith: ['business'] });
  f.policies.set('business', ['mock']); f.policies.set('personal', []);
  const task = await f.createTask();
  await assert.rejects(f.executor.start(task.id), { code: 'PROVIDER_NOT_ALLOWED' });
  assert.equal(f.calls.length, 0); assert.equal((await f.currentTask(task.id)).status, 'queued');
  assert.ok(f.checks.some(check => check.scopeId === 'personal' && check.connectionId === 'mock'));
});

test('restricted notes cannot flow into a different agent through completed-step output', async t => {
  const f = await fixture(t);
  await note(f.workspace, { agentIds: ['forge'], content: 'RESTRICTED_MARKER' });
  const task = await f.createTask({ steps: [{ title: 'Private analysis', agentId: 'forge', instruction: 'Analyze the constraint.' }, { title: 'Public draft', agentId: 'muse', instruction: 'Draft from previous findings.' }] });
  await assert.rejects(f.executor.start(task.id), /non è accessibile/);
  assert.equal(f.calls.length, 0, 'Preflight rejects the whole chain before the first paid call');
  assert.equal((await f.currentTask(task.id)).status, 'queued');
});

test('ready workflow runs in order and the next step receives the previous output with provenance', async t => {
  const f = await fixture(t);
  const flow = await workflow(f.workspace);
  const task = await f.createTask({ workflowId: flow.id, steps: workflowSteps(flow) });
  await f.executor.start(task.id);
  const delivered = await f.settle(task.id);
  assert.equal(delivered.status, 'review'); assert.deepEqual(f.calls.map(call => call.agentId), ['radar', 'forge']);
  assert.ok(f.calls[1].prompt.includes('Result 1 from radar'));
  assert.ok(delivered.artifacts[0].context.workflows.some(ref => ref.id === flow.id && ref.version === flow.version));
});

test('persisted interrupted tasks retain completed steps, reject stale references, and restart cleanly', async t => {
  const f = await fixture(t);
  const memory = await note(f.workspace);
  let task = await f.createTask({ steps: [{ title: 'First', instruction: 'First' }, { title: 'Second', instruction: 'Second' }] });
  task = (await f.operations.mutate('startTask', { id: task.id })).tasks[0];
  await f.operations.mutate('startStep', { id: task.id, stepId: task.steps[0].id, executionId: task.executionId });
  await f.operations.mutate('completeStep', { id: task.id, stepId: task.steps[0].id, executionId: task.executionId, output: 'Persisted result', context: { scopeId: 'business', memories: [{ id: memory.id, version: memory.version }], workflows: [] } });
  const restored = createOperationsStore({ directory: f.directory });
  task = (await restored.recoverInterrupted()).tasks[0];
  assert.equal(task.status, 'paused'); assert.equal(task.steps[0].output, 'Persisted result');
  await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'The constraint changed.' });
  await assert.rejects(f.executor.start(task.id), /contesto.*cambiato/);
  assert.equal(f.calls.length, 0);
  task = (await f.operations.mutate('restartTask', { id: task.id, expectedVersion: task.version })).tasks[0];
  await f.executor.start(task.id);
  task = await f.settle(task.id);
  assert.equal(task.status, 'review'); assert.equal(f.calls.length, 2);
  assert.ok(!f.calls[0].prompt.includes('Persisted result'));
});

test('pause cancels an in-flight provider call and retains finished steps without accepting late output', async t => {
  const f = await fixture(t, async (options, number) => {
    if (number === 1) return 'Preserved first result';
    await new Promise((resolve, reject) => {
      if (options.signal.aborted) return reject(Error('Aborted'));
      options.signal.addEventListener('abort', () => reject(Error('Aborted')), { once: true });
    });
  });
  let task = await f.createTask({ steps: [{ title: 'First', instruction: 'First' }, { title: 'Second', instruction: 'Second' }] });
  await f.executor.start(task.id);
  task = await until(async () => { const value = await f.currentTask(task.id); return value.steps[1].status === 'running' && f.calls.length === 2 ? value : false; }, 'second running step');
  await f.executor.pause(task.id, task.version);
  task = await f.settle(task.id);
  assert.equal(task.status, 'paused'); assert.equal(task.steps[0].output, 'Preserved first result'); assert.equal(task.steps[1].output, undefined);
});

test('routine scheduling queues current workflow steps without provider calls and preserves due time on invalid workflow', async t => {
  const f = await fixture(t);
  const flow = await workflow(f.workspace);
  const due = '2026-01-01T00:00:00.000Z';
  const routine = (await f.operations.mutate('createRoutine', { projectId: f.project.id, title: 'Recurring review', workflowId: flow.id, enabled: true, intervalHours: 24, nextRunAt: due })).routines[0];
  await f.executor.tick(due);
  let snapshot = await f.operations.getSnapshot();
  assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.tasks[0].status, 'queued'); assert.equal(snapshot.tasks[0].steps.length, 2); assert.equal(f.calls.length, 0);
  const nextRunAt = snapshot.routines[0].nextRunAt;
  await f.workspace.mutate('saveWorkflow', { id: flow.id, expectedVersion: flow.version, status: 'draft' });
  await assert.rejects(f.executor.tick(nextRunAt));
  snapshot = await f.operations.getSnapshot();
  assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.routines[0].nextRunAt, nextRunAt); assert.equal(snapshot.routines[0].id, routine.id);
});

test('memory proposals reject revoked workflow provenance from an approved artifact', async t => {
  const f = await fixture(t);
  const flow = await workflow(f.workspace);
  let task = await f.createTask({ workflowId: flow.id, steps: workflowSteps(flow) });
  await f.executor.start(task.id); task = await f.settle(task.id);
  await f.operations.mutate('approveTask', { id: task.id, expectedVersion: task.version });
  await f.workspace.mutate('deleteWorkflow', { id: flow.id });
  await assert.rejects(f.executor.proposeMemory({ id: task.id, title: 'Withdrawn source', content: 'Do not recreate withdrawn content.' }));
});

test('scheduler rejects a definition changed while workflow steps were being resolved and retries the current definition', async t => {
  const f = await fixture(t);
  const oldFlow = await workflow(f.workspace);
  const newFlow = (await f.workspace.mutate('saveWorkflow', { scopeId: 'business', title: 'Replacement workflow', output: 'Current result', status: 'ready', steps: [{ title: 'Replacement step', agentId: 'forge', output: 'Use the current definition.' }] })).workflows.at(-1);
  const now = '2026-01-01T00:00:00.000Z';
  const routine = (await f.operations.mutate('createRoutine', { projectId: f.project.id, title: 'Concurrent definition', workflowId: oldFlow.id, enabled: true, nextRunAt: now })).routines[0];
  const originalGetContext = f.workspace.getContext;
  let release, entered;
  const gate = new Promise(resolve => release = resolve);
  const resolving = new Promise(resolve => entered = resolve);
  f.workspace.getContext = async options => { const context = await originalGetContext(options); entered(); await gate; return context; };
  const ticking = f.executor.tick(now);
  await resolving;
  await f.operations.mutate('updateRoutine', { id: routine.id, expectedVersion: routine.version, workflowId: newFlow.id });
  release();
  await assert.rejects(ticking);
  assert.equal((await f.operations.getSnapshot()).tasks.length, 0);
  f.workspace.getContext = originalGetContext;
  await f.executor.tick(now);
  const task = (await f.operations.getSnapshot()).tasks[0];
  assert.equal(task.workflowId, newFlow.id); assert.equal(task.steps.length, 1); assert.equal(task.steps[0].title, 'Replacement step');
});
