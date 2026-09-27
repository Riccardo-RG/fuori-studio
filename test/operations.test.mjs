import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOperationsStore } from '../lib/operations.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-studio-operations-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'operations.json'), store: createOperationsStore({ directory }) };
}
async function setup(store, steps = undefined) {
  const project = (await store.mutate('createProject', { title: 'Owned product', scopeId: 'business' })).projects[0];
  const task = (await store.mutate('createTask', { projectId: project.id, title: 'Deliver a proposal', brief: 'Use supplied evidence to propose the next milestone.', agentId: 'forge', steps })).tasks[0];
  return { project, task };
}
const byId = (snapshot, task) => snapshot.tasks.find(item => item.id === task.id);
async function finishSteps(store, task) {
  let current = task;
  for (const step of current.steps) {
    if (step.status === 'completed') continue;
    current = byId(await store.mutate('startStep', { id: current.id, stepId: step.id, executionId: current.executionId }), current);
    current = byId(await store.mutate('completeStep', { id: current.id, stepId: step.id, executionId: current.executionId, output: `Result for ${step.title}`, context: { memories: [{ id: 'memory-1', version: 2 }] }, execution: { provider: 'mock', elapsedMs: 5 } }), current);
  }
  return current;
}

test('owned projects and tasks persist privately, with validated references and detached snapshots', async t => {
  const { store, directory, file } = await fixture(t);
  assert.deepEqual(await store.getSnapshot(), { version: 1, projects: [], tasks: [], routines: [] });
  const { project, task } = await setup(store);
  assert.equal(project.kind, 'owned'); assert.equal(task.status, 'queued'); assert.equal(task.scopeId, 'business');
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await createOperationsStore({ directory }).getSnapshot(), await store.getSnapshot());
  task.steps[0].title = 'External mutation';
  assert.notEqual((await store.getSnapshot()).tasks[0].steps[0].title, 'External mutation');
  await assert.rejects(store.mutate('createTask', { projectId: project.id, scopeId: 'personal', title: 'Wrong scope' }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.mutate('createTask', { projectId: 'missing', title: 'Missing project' }), { code: 'NOT_FOUND' });
  await assert.rejects(store.mutate('saveProject', { id: project.id, expectedVersion: 1, scopeId: 'personal' }), { code: 'INVALID_STATE' });
});

test('task execution requires sequential steps, explicit review and current execution tokens', async t => {
  const { store } = await fixture(t);
  const { task: initial } = await setup(store, [{ title: 'Research', agentId: 'radar', instruction: 'Read the supplied evidence.' }, { title: 'Draft', agentId: 'forge', instruction: 'Prepare a draft.' }]);
  let task = byId(await store.mutate('startTask', { id: initial.id, expectedVersion: initial.version }), initial);
  const token = task.executionId;
  await assert.rejects(store.mutate('startTask', { id: task.id }), { code: 'INVALID_STATE' });
  await assert.rejects(store.mutate('startStep', { id: task.id, stepId: task.steps[1].id, executionId: token }), { code: 'INVALID_STATE' });
  await assert.rejects(store.mutate('submitArtifact', { id: task.id, executionId: token, content: 'Too early' }), { code: 'INVALID_STATE' });
  await assert.rejects(store.mutate('startStep', { id: task.id, stepId: task.steps[0].id, executionId: 'old' }), { code: 'STALE_EXECUTION' });
  task = await finishSteps(store, task);
  task = byId(await store.mutate('submitArtifact', { id: task.id, executionId: token, content: 'Review this deliverable.' }), task);
  assert.equal(task.status, 'review'); assert.equal(task.executionId, null); assert.equal(task.artifacts[0].decision, 'pending');
  assert.equal(task.artifacts[0].context.steps.length, 2);
  task = byId(await store.mutate('approveTask', { id: task.id, expectedVersion: task.version }), task);
  assert.equal(task.status, 'completed'); assert.equal(task.artifacts[0].decision, 'approved');
  await assert.rejects(store.mutate('startTask', { id: task.id }), { code: 'INVALID_STATE' });
});

test('requested changes preserve versioned artifacts and require feedback and a current version', async t => {
  const { store } = await fixture(t);
  let { task } = await setup(store);
  task = byId(await store.mutate('startTask', { id: task.id }), task);
  task = await finishSteps(store, task);
  task = byId(await store.mutate('submitArtifact', { id: task.id, executionId: task.executionId, content: 'Version one' }), task);
  await assert.rejects(store.mutate('approveTask', { id: task.id }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(store.mutate('requestChanges', { id: task.id, expectedVersion: task.version, feedback: ' ' }), { code: 'VALIDATION_ERROR' });
  task = byId(await store.mutate('requestChanges', { id: task.id, expectedVersion: task.version, feedback: 'Add measurable acceptance criteria.' }), task);
  assert.equal(task.status, 'queued'); assert.equal(task.steps[0].status, 'pending'); assert.equal(task.steps[0].output, undefined);
  assert.equal(task.artifacts[0].decision, 'changes_requested'); assert.equal(task.artifacts[0].content, 'Version one');
  task = byId(await store.mutate('startTask', { id: task.id }), task); task = await finishSteps(store, task);
  task = byId(await store.mutate('submitArtifact', { id: task.id, executionId: task.executionId, content: 'Version two', context: { memories: [] } }), task);
  assert.equal(task.artifacts.length, 2); assert.equal(task.artifacts[1].version, 2);
  assert.equal(task.artifacts[0].feedback, 'Add measurable acceptance criteria.');
  await assert.rejects(store.mutate('approveTask', { id: task.id, expectedVersion: 1 }), { code: 'VERSION_CONFLICT' });
});

test('restart recovery preserves finished steps and stale completions cannot change a resumed task', async t => {
  const { store, directory } = await fixture(t);
  let { task } = await setup(store, [{ title: 'First', instruction: 'First result' }, { title: 'Second', instruction: 'Second result' }]);
  task = byId(await store.mutate('startTask', { id: task.id }), task);
  const oldToken = task.executionId;
  task = byId(await store.mutate('startStep', { id: task.id, stepId: task.steps[0].id, executionId: oldToken }), task);
  task = byId(await store.mutate('completeStep', { id: task.id, stepId: task.steps[0].id, executionId: oldToken, output: 'Keep this completed work.' }), task);
  task = byId(await store.mutate('startStep', { id: task.id, stepId: task.steps[1].id, executionId: oldToken }), task);
  const restarted = createOperationsStore({ directory });
  task = byId(await restarted.recoverInterrupted(), task);
  assert.equal(task.status, 'paused'); assert.equal(task.steps[0].output, 'Keep this completed work.'); assert.equal(task.steps[1].status, 'pending');
  const recoveredVersion = task.version;
  assert.equal(byId(await restarted.recoverInterrupted(), task).version, recoveredVersion);
  task = byId(await restarted.mutate('startTask', { id: task.id }), task);
  assert.notEqual(task.executionId, oldToken);
  task = byId(await restarted.mutate('startStep', { id: task.id, stepId: task.steps[1].id, executionId: task.executionId }), task);
  await assert.rejects(restarted.mutate('completeStep', { id: task.id, stepId: task.steps[1].id, executionId: oldToken, output: 'Late stale output' }), { code: 'STALE_EXECUTION' });
  task = byId(await restarted.mutate('pauseTask', { id: task.id, expectedVersion: task.version }), task);
  task = byId(await restarted.mutate('restartTask', { id: task.id, expectedVersion: task.version }), task);
  assert.equal(task.status, 'queued'); assert.ok(task.steps.every(step => step.status === 'pending' && step.output === undefined && step.context === undefined));
});

test('failed tasks resume completed work and user mutation conflicts leave the queue usable', async t => {
  const { store } = await fixture(t);
  let { project, task } = await setup(store);
  task = byId(await store.mutate('startTask', { id: task.id }), task);
  task = byId(await store.mutate('startStep', { id: task.id, stepId: task.steps[0].id, executionId: task.executionId }), task);
  task = byId(await store.mutate('failTask', { id: task.id, executionId: task.executionId, error: 'Provider unavailable.' }), task);
  assert.equal(task.status, 'failed'); assert.equal(task.steps[0].status, 'failed');
  task = byId(await store.mutate('startTask', { id: task.id }), task);
  assert.equal(task.steps[0].status, 'pending'); assert.equal(task.steps[0].error, undefined);
  const competing = await Promise.allSettled([
    store.mutate('saveProject', { id: project.id, expectedVersion: 1, title: 'First edit' }),
    store.mutate('saveProject', { id: project.id, expectedVersion: 1, title: 'Stale edit' }),
  ]);
  assert.equal(competing.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(competing.find(result => result.status === 'rejected').reason.code, 'VERSION_CONFLICT');
  assert.equal((await store.getSnapshot()).projects[0].title, 'First edit');
});

test('routines require explicit enablement and atomic claims coalesce missed intervals without duplicate tasks', async t => {
  const { store } = await fixture(t);
  const { project } = await setup(store);
  const due = '2026-01-01T10:00:00.000Z';
  let routine = (await store.mutate('createRoutine', { projectId: project.id, title: 'Weekly review', brief: 'Prepare a review.', intervalHours: 0, nextRunAt: due })).routines[0];
  assert.equal(routine.enabled, false); assert.equal(routine.intervalHours, 1);
  let snapshot = await store.mutate('claimDueRoutine', { id: routine.id, now: due });
  assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.routines[0].version, 1);
  routine = (await store.mutate('updateRoutine', { id: routine.id, expectedVersion: 1, enabled: true })).routines[0];
  const now = '2026-01-01T15:30:00.000Z';
  await Promise.all(Array.from({ length: 8 }, () => store.mutate('claimDueRoutine', { id: routine.id, now, steps: [{ title: 'Current workflow step', agentId: 'radar', instruction: 'Resolve current evidence.' }] })));
  snapshot = await store.getSnapshot();
  assert.equal(snapshot.tasks.length, 2);
  assert.equal(snapshot.tasks[1].routineId, routine.id); assert.equal(snapshot.tasks[1].status, 'queued');
  assert.equal(snapshot.tasks[1].steps[0].title, 'Current workflow step');
  assert.equal(snapshot.tasks[1].steps[0].agentId, 'radar');
  assert.equal(snapshot.routines[0].nextRunAt, '2026-01-01T16:00:00.000Z');
  await store.mutate('claimDueRoutine', { id: routine.id, now: '2026-01-01T16:00:00.000Z' });
  assert.equal((await store.getSnapshot()).tasks.length, 3);
  await assert.rejects(store.mutate('updateRoutine', { id: routine.id, expectedVersion: routine.version, enabled: false }), { code: 'VERSION_CONFLICT' });
});

test('malformed archives fail closed and recover after repair, including falsy JSON values', async t => {
  const { store, file } = await fixture(t);
  await setup(store);
  const original = await readFile(file, 'utf8');
  for (const malformed of ['{broken', 'null', 'false', JSON.stringify({ ...JSON.parse(original), version: 999 })]) {
    await writeFile(file, malformed);
    await assert.rejects(store.getSnapshot(), { code: 'OPERATIONS_CORRUPT' });
    await assert.rejects(store.mutate('createProject', { title: 'Do not overwrite', scopeId: 'business' }), { code: 'OPERATIONS_CORRUPT' });
    assert.equal(await readFile(file, 'utf8'), malformed);
  }
  await writeFile(file, original);
  assert.equal((await store.getSnapshot()).tasks.length, 1);
  await store.mutate('createProject', { title: 'Recovered', scopeId: 'personal' });
  assert.equal((await store.getSnapshot()).projects.length, 2);
});

test('a changed routine cannot claim a task with workflow steps resolved from an obsolete version', async t => {
  const { store } = await fixture(t);
  const { project } = await setup(store);
  const now = '2026-01-01T10:00:00.000Z';
  const routine = (await store.mutate('createRoutine', { projectId: project.id, title: 'Scheduled workflow', workflowId: 'old-workflow', nextRunAt: now, enabled: true })).routines[0];
  await store.mutate('updateRoutine', { id: routine.id, expectedVersion: routine.version, workflowId: 'new-workflow' });
  await assert.rejects(store.mutate('claimDueRoutine', { id: routine.id, expectedVersion: routine.version, now, steps: [{ title: 'Obsolete step', instruction: 'Old workflow output' }] }), { code: 'VERSION_CONFLICT' });
  let snapshot = await store.getSnapshot();
  assert.equal(snapshot.tasks.length, 1); assert.equal(snapshot.routines[0].nextRunAt, now);
  snapshot = await store.mutate('claimDueRoutine', { id: routine.id, expectedVersion: snapshot.routines[0].version, now, steps: [{ title: 'Current step', instruction: 'Current workflow output' }] });
  assert.equal(snapshot.tasks.length, 2); assert.equal(snapshot.tasks[1].workflowId, 'new-workflow'); assert.equal(snapshot.tasks[1].steps[0].title, 'Current step');
});

test('invalid and oversized execution metadata cannot poison the archive', async t => {
  const { store } = await fixture(t);
  let { task } = await setup(store);
  task = byId(await store.mutate('startTask', { id: task.id }), task);
  task = byId(await store.mutate('startStep', { id: task.id, stepId: task.steps[0].id, executionId: task.executionId }), task);
  for (const context of [JSON.parse('{"__proto__":{"polluted":true}}'), { text: 'x'.repeat(96001) }]) {
    await assert.rejects(store.mutate('completeStep', { id: task.id, stepId: task.steps[0].id, executionId: task.executionId, output: 'Result', context }), { code: 'VALIDATION_ERROR' });
  }
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal((await store.getSnapshot()).tasks[0].steps[0].status, 'running');
});
