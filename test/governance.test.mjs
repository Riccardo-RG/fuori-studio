import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { createGovernance, aggregateOperations } from '../lib/governance.ts';

const meta = { scopeId: 'business', agentId: 'forge', kind: 'repository_edit', connectionId: 'codex' };
function memoryStorage() {
  const records = new Map(); let queue = Promise.resolve();
  return { records, read: async (key, fallback) => structuredClone(records.has(key) ? records.get(key) : fallback), update: (key, fn, fallback) => {
    const result = queue.then(() => { const previous = structuredClone(records.has(key) ? records.get(key) : fallback); const next = fn(previous); records.set(key, structuredClone(next)); return structuredClone(next); });
    queue = result.catch(() => {}); return result;
  } };
}
async function fixture() {
  let clock = Date.parse('2026-09-28T12:00:00.000Z');
  const storage = memoryStorage(), governance = createGovernance({ storage, clock: () => clock });
  // Only the documented configure fields are transmitted.
  const configure = async extra => { const current = (await governance.snapshot()).settings; return governance.configure({ expectedVersion: current.version, dailyCallLimit: current.dailyCallLimit, maxCallSeconds: current.maxCallSeconds, autonomousRoutines: current.autonomousRoutines, maxAutonomousRunsPerDay: current.maxAutonomousRunsPerDay, ...extra }); };
  return { storage, governance, configure, advance: ms => { clock += ms; }, clock: () => clock };
}

test('safe defaults, strict settings versions and UTC daily boundaries', async () => {
  const f = await fixture(), initial = await f.governance.snapshot();
  assert.deepEqual(initial.settings, { version: 1, dailyCallLimit: 50, maxCallSeconds: 180, autonomousRoutines: false, maxAutonomousRunsPerDay: 3, autonomousEnabledAt: null });
  assert.equal(initial.period.resetAt, '2026-09-29T00:00:00.000Z');
  assert.equal(initial.usageTotals.inputTokens, null); assert.equal(initial.feedback.minutesSaved, null);
  await assert.rejects(f.configure({ dailyCallLimit: 1001 }), { code: 'GOVERNANCE_INVALID' });
  await assert.rejects(f.configure({ maxCallSeconds: 1801 }), { code: 'GOVERNANCE_INVALID' });
  const changed = await f.configure({ dailyCallLimit: 0 });
  assert.equal(changed.settings.version, 2);
  await assert.rejects(f.configure({ expectedVersion: 1 }), { code: 'VERSION_CONFLICT' });
  let executed = false;
  await assert.rejects(f.governance.execute(meta, async () => { executed = true; }), { code: 'DAILY_CALL_LIMIT' });
  assert.equal(executed, false); assert.equal((await f.governance.snapshot()).daily.calls, 0);
});

test('reservations commit before an AI call, failures count, tokens remain unknown when unreported and logs contain no prompts/errors', async () => {
  const f = await fixture();
  const result = await f.governance.execute(meta, async signal => {
    assert.equal(signal.aborted, false);
    const stored = f.storage.records.get('governance');
    assert.equal(stored.usages[0].status, 'running');
    f.advance(150);
    return { text: 'PRIVATE_RESULT_BODY', usage: { inputTokens: 120, outputTokens: 20 } };
  });
  assert.equal(result.text, 'PRIVATE_RESULT_BODY');
  await assert.rejects(f.governance.execute({ ...meta, agentId: 'nova', kind: 'chat' }, async () => { throw Object.assign(Error('PRIVATE_ERROR_API_KEY'), { code: 'PRIVATE_ERROR_API_KEY' }); }), /PRIVATE_ERROR_API_KEY/);
  const snapshot = await f.governance.snapshot();
  assert.equal(snapshot.daily.calls, 2); assert.equal(snapshot.daily.remaining, 48);
  assert.equal(snapshot.usageTotals.succeeded, 1); assert.equal(snapshot.usageTotals.failed, 1);
  assert.equal(snapshot.usageTotals.inputTokens, 120); assert.equal(snapshot.usageTotals.outputTokens, 20); assert.equal(snapshot.usageTotals.unknownInputCount, 1); assert.equal(snapshot.usageTotals.complete, false);
  assert.equal(snapshot.usages.find(item => item.status === 'succeeded').durationMs, 150);
  assert.equal(snapshot.usages[0].errorCode, 'CALL_FAILED');
  assert.doesNotMatch(JSON.stringify(f.storage.records.get('governance')), /PRIVATE_RESULT_BODY|PRIVATE_ERROR_API_KEY/);
});

test('transactional daily reservations resist concurrent overspend and reset only on the next UTC day', async () => {
  const f = await fixture(); await f.configure({ dailyCallLimit: 2 });
  let calls = 0;
  const results = await Promise.allSettled(Array.from({ length: 8 }, () => f.governance.execute(meta, async () => { calls++; return { usage: { inputTokens: 1, outputTokens: 0 } }; })));
  assert.equal(calls, 2); assert.equal(results.filter(item => item.status === 'fulfilled').length, 2);
  assert.equal((await f.governance.snapshot()).daily.remaining, 0);
  f.advance(24 * 60 * 60 * 1000);
  await f.governance.execute(meta, async () => ({ usage: { inputTokens: 2, outputTokens: 1 } }));
  assert.equal((await f.governance.snapshot()).daily.calls, 1);
  assert.equal((await f.governance.snapshot()).usageTotals.calls, 3);
});

test('only three live inference calls can run and unstarted calls do not consume the daily allowance', async () => {
  const f = await fixture(), releases = [];
  const started = Array.from({ length: 3 }, () => f.governance.execute(meta, async () => new Promise(resolve => releases.push(resolve))));
  while (releases.length < 3) await setImmediate();
  let fourth = false;
  await assert.rejects(f.governance.execute(meta, async () => { fourth = true; }), { code: 'CALL_CONCURRENCY_LIMIT' });
  assert.equal(fourth, false); assert.equal((await f.governance.snapshot()).daily.calls, 3);
  releases.forEach(release => release({ usage: { inputTokens: 3, outputTokens: 1 } }));
  await Promise.all(started);
  assert.equal((await f.governance.snapshot()).usageTotals.running, 0);
});

test('parent cancellation propagates, stays charged and a pre-aborted call never reserves', async () => {
  const f = await fixture(), parent = new AbortController();
  let entered;
  const began = new Promise(resolve => { entered = resolve; });
  const request = f.governance.execute(meta, signal => new Promise((_, reject) => { entered(signal); signal.addEventListener('abort', () => reject(Error('Underlying cancellation')), { once: true }); }), parent.signal);
  const signal = await began; parent.abort();
  await assert.rejects(request, { code: 'CALL_CANCELLED' }); assert.equal(signal.aborted, true);
  assert.equal((await f.governance.snapshot()).usageTotals.cancelled, 1);
  await assert.rejects(f.governance.execute(meta, async () => assert.fail('Must not execute'), parent.signal), { code: 'CALL_CANCELLED' });
  assert.equal((await f.governance.snapshot()).daily.calls, 1);
});

test('deadline aborts the underlying call, returns a stable timeout, and does not refund its reservation', async () => {
  const f = await fixture(); await f.configure({ maxCallSeconds: 1 });
  let aborted = false;
  await assert.rejects(f.governance.execute(meta, signal => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('Timed out downstream')); }, { once: true }))), { code: 'CALL_TIMEOUT' });
  assert.equal(aborted, true);
  const snapshot = await f.governance.snapshot();
  assert.equal(snapshot.usageTotals.timedOut, 1); assert.equal(snapshot.daily.calls, 1);
});

test('restart recovers running reservations as interrupted without refunding or inventing tokens', async () => {
  const f = await fixture(); await f.governance.snapshot();
  const state = f.storage.records.get('governance');
  state.usages.push({ ...meta, id: 'interrupted-call', day: '2026-09-28', status: 'running', startedAt: '2026-09-28T11:59:00.000Z', finishedAt: null, durationMs: null, inputTokens: null, outputTokens: null, errorCode: null });
  const restarted = createGovernance({ storage: f.storage, clock: f.clock });
  const snapshot = await restarted.recoverInterrupted();
  assert.equal(snapshot.daily.calls, 1); assert.equal(snapshot.usageTotals.interrupted, 1); assert.equal(snapshot.usageTotals.inputTokens, null);
  assert.equal(snapshot.usages[0].durationMs, 60000);
});

test('autonomous routines need explicit opt-in, deduplicate occurrences and obey an atomic daily cap', async () => {
  const f = await fixture(), request = { routineId: 'weekly-review', scopeId: 'business', occurrenceId: 'task-occurrence-1' };
  await assert.rejects(f.governance.claimRoutine(request), { code: 'AUTONOMY_DISABLED' });
  await f.configure({ autonomousRoutines: true, maxAutonomousRunsPerDay: 1 });
  const claims = await Promise.all(Array.from({ length: 4 }, () => f.governance.claimRoutine(request)));
  assert.equal(claims.filter(item => item.claimed).length, 1);
  assert.equal(new Set(claims.map(item => item.id)).size, 1);
  await assert.rejects(f.governance.claimRoutine({ ...request, occurrenceId: 'task-occurrence-2' }), { code: 'AUTONOMOUS_RUN_LIMIT' });
  assert.equal((await f.governance.snapshot()).daily.autonomousRuns, 1);
  assert.equal((await f.governance.snapshot()).daily.calls, 0, 'routine reservation is separate from inference calls');
  const enabledAt = (await f.governance.snapshot()).settings.autonomousEnabledAt;
  f.advance(86400000);
  assert.equal((await f.configure({ maxAutonomousRunsPerDay: 2 })).settings.autonomousEnabledAt, enabledAt);
  assert.equal((await f.governance.claimRoutine(request)).claimed, false, 'a claimed occurrence stays claimed across UTC days');
  await f.configure({ autonomousRoutines: false });
  assert.equal((await f.governance.snapshot()).settings.autonomousEnabledAt, null);
  assert.notEqual((await f.configure({ autonomousRoutines: true })).settings.autonomousEnabledAt, enabledAt);
});

test('user outcomes update by entity and time savings are explicitly self-reported, never invented from calls', async () => {
  const f = await fixture();
  let snapshot = await f.governance.saveOutcome({ taskId: 'task-1', helpful: true });
  assert.equal(snapshot.feedback.minutesSaved, null); assert.equal(snapshot.feedback.selfReported, true);
  snapshot = await f.governance.saveOutcome({ taskId: 'task-1', expectedVersion: 1, helpful: false, minutesSaved: 0, note: 'Needed substantial revision.' });
  assert.equal(snapshot.outcomes.length, 1); assert.equal(snapshot.outcomes[0].version, 2); assert.equal(snapshot.feedback.minutesSaved, 0);
  await f.governance.saveOutcome({ runId: 'run-1', helpful: true, minutesSaved: 35.5 });
  snapshot = await f.governance.snapshot(); assert.equal(snapshot.feedback.minutesSaved, 35.5); assert.equal(snapshot.feedback.minutesSavedEntries, 2);
  await assert.rejects(f.governance.saveOutcome({ taskId: 'task-1', expectedVersion: 1, helpful: true }), { code: 'VERSION_CONFLICT' });
  await assert.rejects(f.governance.saveOutcome({ taskId: 'task-1', runId: 'run-1', helpful: true }), { code: 'GOVERNANCE_INVALID' });
});

test('metrics count human-reviewed deliveries only, derive cycles from real events and preserve unknown usage', () => {
  const operations = { tasks: [
    { id: 'task-1', workflowId: 'procedure-a', status: 'completed', artifacts: [{ decision: 'changes_requested' }, { decision: 'approved' }], events: [{ type: 'started', createdAt: '2026-09-28T12:00:00Z' }, { type: 'submitted', createdAt: '2026-09-28T12:02:00Z' }], steps: [{ execution: { usage: { inputTokens: 100, outputTokens: 40 } } }] },
    { id: 'task-2', workflowId: 'procedure-a', status: 'review', artifacts: [{ decision: 'pending' }], events: [], steps: [{ execution: { usage: null } }] },
    { id: 'task-3', status: 'failed', artifacts: [], events: [{ type: 'failed', createdAt: '2026-09-28T13:00:00Z' }] },
  ] };
  const repositories = { runs: [{ id: 'run-1', status: 'completed', patchHash: 'hash', decision: { status: 'approved' }, events: [{ type: 'started', at: '2026-09-28T14:00:00Z' }, { type: 'review', at: '2026-09-28T14:03:00Z' }], editor: { usage: { inputTokens: 200, outputTokens: null } }, review: { status: 'unavailable' } }] };
  const metrics = aggregateOperations(operations, repositories);
  assert.deepEqual(metrics.deliveries, { total: 4, accepted: 2, revised: 1, pending: 1, reviewed: 3, acceptanceRatio: 2 / 3 });
  assert.equal(metrics.cycles.count, 2); assert.equal(metrics.cycles.averageMs, 150000);
  assert.equal(metrics.procedures[0].acceptanceRatio, 0.5); assert.deepEqual(metrics.failures, { current: 1, events: 1 });
  assert.equal(metrics.tokens.inputTokens, 300); assert.equal(metrics.tokens.outputTokens, 40); assert.equal(metrics.tokens.unknownInputCount, 1); assert.equal(metrics.tokens.unknownOutputCount, 2); assert.equal(metrics.tokens.complete, false);
  assert.equal(aggregateOperations().deliveries.acceptanceRatio, null); assert.equal(aggregateOperations().cycles.averageMs, null);
});
