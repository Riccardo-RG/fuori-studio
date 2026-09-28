import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';
import { createGovernance } from '../lib/governance.ts';
import { createProviderStore } from '../lib/providers.mjs';

const target = { scopeId: 'business', projectId: 'project-a', taskId: 'task-a' };
const meta = { ...target, agentId: 'forge', kind: 'inference', connectionId: 'codex' };
function storage() {
  const records = new Map(); let queue = Promise.resolve();
  return { records, read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), update: (key, fn, fallback) => { const pending = queue.then(() => { const next = fn(structuredClone(records.get(key) ?? fallback)); records.set(key, structuredClone(next)); return structuredClone(next); }); queue = pending.catch(() => {}); return pending; } };
}
const invoke = async () => ({ usage: { inputTokens: 5, outputTokens: 1 } });

test('default lifetime budgets apply without a saved setting and preview is read-only', async () => {
  const store = storage(), governance = createGovernance({ storage: store });
  const result = await governance.preflight({ ...target, requiredCalls: 3 });
  assert.equal(result.project.callLimit, 200); assert.equal(result.assignment.callLimit, 12);
  assert.equal(result.allowed, true); assert.equal(result.assignment.period, 'lifetime');
  assert.equal(store.records.get('governance').usages.length, 0);
  for (let i = 0; i < 12; i++) await governance.execute(meta, invoke);
  await assert.rejects(governance.execute(meta, () => assert.fail('Cannot overspend default')), { code: 'ASSIGNMENT_CALL_LIMIT' });
  assert.equal((await governance.preflight({ ...target, requiredCalls: 1 })).allowed, false);
});

test('atomic reservations share the project ceiling across assignments and never overspend it', async () => {
  const governance = createGovernance({ storage: storage() });
  await governance.configureBudget({ scopeId: target.scopeId, projectId: target.projectId, callLimit: 2, expectedVersion: 0 });
  let dispatched = 0;
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => governance.execute({ ...meta, taskId: `task-${i}` }, async () => { dispatched++; return invoke(); })));
  assert.equal(dispatched, 2); assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
  assert.ok(results.filter(item => item.status === 'rejected').every(item => item.reason.code === 'PROJECT_CALL_LIMIT'));
  const report = await governance.preflight({ ...target, requiredCalls: 1 });
  assert.equal(report.project.used, 2); assert.equal(report.project.remaining, 0);
  await governance.execute({ ...meta, projectId: 'project-b' }, invoke);
});

test('assignment failures remain charged, raising limits preserves counts and stale writes conflict', async () => {
  const governance = createGovernance({ storage: storage() });
  await governance.configureBudget({ ...target, callLimit: 1, expectedVersion: 0 });
  await assert.rejects(governance.execute(meta, async () => { throw Error('remote error'); }), /remote error/);
  let report = await governance.preflight({ ...target, requiredCalls: 1 });
  assert.equal(report.assignment.used, 1); assert.equal(report.assignment.usage.unknownInputCount, 1); assert.equal(report.assignment.usage.inputTokens, null);
  await assert.rejects(governance.configureBudget({ ...target, callLimit: 3, expectedVersion: 0 }), { code: 'VERSION_CONFLICT' });
  await governance.configureBudget({ ...target, callLimit: 3, expectedVersion: 1 });
  report = await governance.preflight({ ...target, requiredCalls: 2 });
  assert.equal(report.assignment.used, 1); assert.equal(report.assignment.remaining, 2); assert.equal(report.allowed, true);
  await governance.configureBudget({ ...target, callLimit: 0, expectedVersion: 2 });
  await assert.rejects(governance.execute(meta, () => assert.fail('Zero must block')), { code: 'ASSIGNMENT_CALL_LIMIT' });
});

test('repository revisions share original assignment while logs retain actual attempt IDs', async () => {
  const governance = createGovernance({ storage: storage() });
  const root = { scopeId: 'business', projectId: 'project-a', runId: 'original' };
  await governance.configureBudget({ ...root, callLimit: 2, expectedVersion: 0 });
  for (const runId of ['original', 'revision-1']) await governance.execute({ ...meta, taskId: undefined, ...root, runId, budgetRunId: 'original' }, invoke);
  await assert.rejects(governance.execute({ ...meta, taskId: undefined, ...root, runId: 'revision-2', budgetRunId: 'original' }, invoke), { code: 'ASSIGNMENT_CALL_LIMIT' });
  const records = (await governance.snapshot()).usages;
  assert.deepEqual(records.map(item => item.runId).sort(), ['original', 'revision-1']);
  const report = await governance.preflight({ ...root, runId: 'revision-2', budgetRunId: 'original', requiredCalls: 1 });
  assert.equal(report.assignment.runId, 'original'); assert.equal(report.assignment.used, 2);
});

test('UTC rollover and process restart never reset lifetime counters; legacy global records remain honest', async () => {
  const store = storage(); let now = Date.parse('2026-09-28T23:59:00Z');
  let governance = createGovernance({ storage: store, clock: () => now });
  await governance.configureBudget({ ...target, callLimit: 1, expectedVersion: 0 });
  await governance.execute(meta, invoke);
  await governance.execute({ scopeId: 'business', agentId: 'nova', kind: 'chat', connectionId: 'codex' }, invoke);
  now += 86400000;
  governance = createGovernance({ storage: store, clock: () => now });
  assert.equal((await governance.snapshot()).daily.calls, 0);
  await assert.rejects(governance.execute(meta, invoke), { code: 'ASSIGNMENT_CALL_LIMIT' });
  const report = await governance.budgets(); assert.equal(report.unattributedCalls, 1); assert.equal(report.entries.find(item => item.taskId === target.taskId).used, 1);
});

test('encrypted SQLite reservation and settings survive reopening the durable archive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-budget-durable-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let archive = createArchive({ directory }); let governance = createGovernance({ storage: archive });
  await governance.configureBudget({ ...target, callLimit: 1, expectedVersion: 0 }); await governance.execute(meta, invoke); await archive.close();
  archive = createArchive({ directory }); t.after(() => archive.close()); governance = createGovernance({ storage: archive });
  await assert.rejects(governance.execute(meta, invoke), { code: 'ASSIGNMENT_CALL_LIMIT' });
  const report = await governance.preflight({ ...target, requiredCalls: 1 }); assert.equal(report.assignment.used, 1); assert.equal(report.assignment.version, 1);
});

test('provider policy receives project, task and repository attribution before fake dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-budget-provider-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const seen = [], providers = createProviderStore({ directory, codexRunner: async () => 'fake response', executionPolicy: async (metadata, call, signal) => { seen.push(metadata); return call(signal); } });
  await providers.execute({ scopeId: 'business', projectId: 'project-a', taskId: 'task-a', agentId: 'forge', prompt: 'Fake inference only' });
  await providers.execute({ scopeId: 'business', projectId: 'project-a', runId: 'revision-1', budgetRunId: 'original', agentId: 'nova', prompt: 'Fake review only' });
  assert.equal(seen[0].taskId, 'task-a'); assert.equal(seen[0].projectId, 'project-a'); assert.equal(seen[1].budgetRunId, 'original'); assert.equal(seen[1].runId, 'revision-1');
});

test('malformed attribution and unbounded limits fail closed', async () => {
  const governance = createGovernance({ storage: storage() });
  for (const value of [{ ...meta, projectId: undefined }, { ...meta, runId: 'also-a-run' }, { ...meta, budgetRunId: 'without-run' }]) await assert.rejects(governance.execute(value, () => assert.fail('Invalid attribution must not dispatch')), { code: 'GOVERNANCE_INVALID' });
  for (const callLimit of [-1, Infinity, null, 50001]) await assert.rejects(governance.configureBudget({ ...target, callLimit, expectedVersion: 0 }), { code: 'GOVERNANCE_INVALID' });
});

test('an unconfigured provider governor blocks even a local fake runner before dispatch', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-budget-fail-closed-')); t.after(() => rm(directory, { recursive: true, force: true }));
  let dispatched = false;
  const providers = createProviderStore({ directory, codexRunner: async () => { dispatched = true; return 'never'; } });
  await assert.rejects(providers.execute({ scopeId: 'business', agentId: 'nova', prompt: 'Never send' }), { code: 'GOVERNANCE_UNAVAILABLE' });
  assert.equal(dispatched, false);
});

test('moving a stable project to another scope retains its lifetime ceiling and assignment counters', async () => {
  const governance = createGovernance({ storage: storage() });
  await governance.configureBudget({ scopeId: 'business', projectId: 'project-a', callLimit: 1, expectedVersion: 0 });
  await governance.configureBudget({ ...target, callLimit: 1, expectedVersion: 0 });
  await governance.execute(meta, invoke);
  const moved = { ...target, scopeId: 'personal' }, report = await governance.preflight({ ...moved, requiredCalls: 1 });
  assert.equal(report.project.scopeId, 'personal'); assert.equal(report.project.used, 1); assert.equal(report.project.remaining, 0); assert.equal(report.assignment.used, 1);
  await assert.rejects(governance.execute({ ...meta, scopeId: 'personal' }, invoke), { code: 'PROJECT_CALL_LIMIT' });
  await governance.configureBudget({ scopeId: 'personal', projectId: 'project-a', callLimit: 2, expectedVersion: 1 });
  await assert.rejects(governance.execute({ ...meta, scopeId: 'personal' }, invoke), { code: 'ASSIGNMENT_CALL_LIMIT' });
  assert.equal((await governance.budgets({ scopeId: 'personal', projectId: 'project-a' })).entries.find(item => !item.taskId).used, 1);
});

test('zero-call artifact finalization may preflight exhausted budgets without reserving or bypassing execution', async () => {
  const governance = createGovernance({ storage: storage() });
  const { settings } = await governance.snapshot();
  await governance.configure({ expectedVersion: settings.version, dailyCallLimit: 0, maxCallSeconds: settings.maxCallSeconds, autonomousRoutines: false, maxAutonomousRunsPerDay: settings.maxAutonomousRunsPerDay });
  await governance.configureBudget({ scopeId: target.scopeId, projectId: target.projectId, callLimit: 0, expectedVersion: 0 });
  await governance.configureBudget({ ...target, callLimit: 0, expectedVersion: 0 });
  const report = await governance.preflight({ ...target, requiredCalls: 0 });
  assert.equal(report.allowed, true); assert.equal(report.requiredCalls, 0); assert.deepEqual(report.blocking, []); assert.equal(report.remaining, 0);
  await assert.rejects(governance.execute(meta, () => assert.fail('An actual call still requires capacity')), { code: 'DAILY_CALL_LIMIT' });
  assert.equal((await governance.snapshot()).daily.calls, 0);
});
