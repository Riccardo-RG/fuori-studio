import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';
import { createRepositoryWorker } from '../lib/repository-worker.ts';
import { repositoryPolicyHash } from '../lib/repository-devices.ts';
import { createRepositoryDeviceHub } from '../lib/repository-devices.ts';
import { createDeviceHub } from '../lib/devices.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const baseCommit = 'a'.repeat(40);
const checks = [{ label: 'Unit tests', program: 'node', args: ['--test', 'value.test.mjs'] }];
const patch = 'diff --git a/value.mjs b/value.mjs\nindex 1111111..2222222 100644\n--- a/value.mjs\n+++ b/value.mjs\n@@ -1 +1 @@\n-export const value = 1;\n+export const value = 2;\n';
const diff = () => ({ patch, hash: sha(patch), files: [{ path: 'value.mjs', status: 'M', additions: 1, deletions: 1 }], stats: { files: 1, additions: 1, deletions: 1 }, truncated: false });
function fixture(options = {}) {
  let clock = Date.parse('2026-09-28T00:00:00Z');
  const records = new Map(), writes = [], calls = [], runtimeCalls = [], jobs = [];
  const connection = { url: 'https://studio.example.org', deviceId: 'device-one', token: 'T'.repeat(43), capabilities: ['repository'], scopeIds: ['development', 'personal'], expiresAt: clock + 30 * 86400000 };
  const storage = options.storage || { read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), write: async (key, value) => { writes.push(structuredClone(value)); records.set(key, structuredClone(value)); } };
  const runtime = {
    inspect: async path => { runtimeCalls.push('inspect'); return { path, name: 'Fixture project', head: baseCommit, branch: 'main', dirty: true, remote: 'https://github.com/owner/project' }; },
    prepare: async input => { runtimeCalls.push('prepare'); return { cwd: '/isolated/checkout', baseCommit: input.baseCommit, dependencies: { status: 'not-needed', reason: 'No Node dependencies.' } }; },
    edit: async () => { runtimeCalls.push('edit'); return { text: 'Updated the candidate patch.', usage: { inputTokens: 15, outputTokens: 10 }, durationMs: 10 }; },
    check: async ({ command }) => { runtimeCalls.push('check'); return { ...command, status: 'passed', exitCode: 0, output: 'Tests passed', durationMs: 5 }; },
    diff: async () => { runtimeCalls.push('diff'); return diff(); },
    ...options.runtime,
  };
  const request = async (path, payload, signal) => {
    calls.push({ path, payload: structuredClone(payload) });
    if (options.request) { const result = await options.request(path, payload, signal); if (result !== undefined) return result; }
    if (path.endsWith('/claim')) return { job: jobs.shift() || null };
    return { ok: true };
  };
  const workerOptions = { storage, runtime, connection, request, now: () => clock, heartbeatMs: 20, requestTimeoutMs: 100, ...options.worker };
  const worker = createRepositoryWorker(workerOptions);
  const add = async () => { const result = await worker.add({ alias: 'product', path: '/allowed/repository', scopeIds: ['development'], checks }); runtimeCalls.length = 0; return result; };
  const job = (override = {}) => ({ id: 'job-one', lease: 'L'.repeat(43), runId: 'run-one', scopeId: 'development', alias: 'product', baseCommit, policyHash: repositoryPolicyHash({ alias: 'product', checks, scopeIds: ['development'] }), prompt: 'Change value to 2 in the isolated checkout.', checks, expiresAt: clock + 30 * 60000, ...override });
  return { worker, workerOptions, storage, records, writes, runtime, calls, runtimeCalls, jobs, job, add, connection, advance: ms => { clock += ms; } };
}

test('local policy is exact, scope-limited, connection-bound and path-free in the announced catalog', async () => {
  const f = fixture(); const policy = await f.add();
  assert.equal(policy.policyHash, sha(JSON.stringify({ alias: 'product', checks, scopeIds: ['development'] })));
  await f.worker.announce(); const announced = f.calls.find(item => item.path.endsWith('/announce')).payload;
  assert.equal(announced.repositories[0].dirty, true); assert.doesNotMatch(JSON.stringify(announced), /allowed\/repository|"path"|"token"/);
  await assert.rejects(f.worker.add({ alias: 'wrong', path: '/other/repository', scopeIds: ['unpaired'], checks }), { code: 'WORKER_SCOPE_DENIED' });
  await assert.rejects(f.worker.add({ alias: 'wrong', path: '/other/repository', scopeIds: ['development'], checks: [{ label: 'Shell', program: 'sh', args: ['-c', 'anything'] }] }));
  const other = createRepositoryWorker({ ...f.workerOptions, connection: { ...f.connection, deviceId: 'device-two', url: 'https://another.example.org' } });
  assert.deepEqual(await other.list(), []); assert.deepEqual((await other.catalog()).repositories, []);
  assert.throws(() => createRepositoryWorker({ ...f.workerOptions, connection: { ...f.connection, capabilities: ['execute'] } }), { code: 'WORKER_CAPABILITY_DENIED' });
});

test('job uses committed snapshot, exact checks and a durable receipt before its result POST', async () => {
  let f; let persistedBeforePost = false;
  f = fixture({ request: async (path, payload) => { if (path.endsWith('/result')) { const journal = (await f.storage.read('repository-worker')).journal[0]; assert.equal(journal.status, 'pending'); assert.deepEqual(journal.delivery, payload); persistedBeforePost = true; } } });
  await f.add(); f.jobs.push(f.job()); await f.worker.announce();
  assert.equal((await f.worker.pollOnce()).status, 'processed'); assert.equal(persistedBeforePost, true);
  assert.deepEqual(f.runtimeCalls, ['inspect', 'inspect', 'prepare', 'edit', 'diff', 'check', 'diff']);
  const result = f.calls.find(item => item.path.endsWith('/result')).payload.result;
  assert.equal(result.version, 1); assert.equal(result.baseCommit, baseCommit); assert.equal(result.beforeHash, result.diff.hash); assert.equal(result.checks[0].exitCode, 0); assert.equal(result.edited.usage.inputTokens, 15);
  assert.equal((await f.worker.status()).journal[0].status, 'delivered');
  assert.doesNotMatch(JSON.stringify(await f.worker.status()), /"lease"|"token"|allowed\/repository|Change value to/);
});

test('mismatched policies, scopes and commands cannot invoke any repository runtime method', async () => {
  for (const override of [{ policyHash: 'b'.repeat(64) }, { scopeId: 'personal' }, { checks: [{ label: 'Other check', program: 'node', args: ['--test', 'other.mjs'] }] }, { alias: 'unregistered' }]) {
    const f = fixture(); await f.add(); f.jobs.push(f.job(override));
    assert.equal((await f.worker.pollOnce()).status, 'policy-denied'); assert.deepEqual(f.runtimeCalls, []);
    assert.equal(f.calls.find(item => item.path.endsWith('/result')).payload.error.code, 'WORKER_POLICY_DENIED');
  }
  const malformed = fixture(); await malformed.add(); malformed.jobs.push(malformed.job({ checks: [{ label: 'Escape', program: 'sh', args: ['-c', 'id'] }] }));
  await assert.rejects(malformed.worker.pollOnce()); assert.deepEqual(malformed.runtimeCalls, []);
});

test('a source commit changed since announcement fails before preparation or paid editing', async () => {
  const f = fixture(); await f.add(); f.runtime.inspect = async path => { f.runtimeCalls.push('inspect'); return { path, name: 'Changed', head: 'b'.repeat(40), branch: 'main', dirty: false, remote: null }; };
  f.jobs.push(f.job()); await f.worker.pollOnce();
  assert.deepEqual(f.runtimeCalls, ['inspect']); assert.equal(f.calls.find(item => item.path.endsWith('/result')).payload.error.code, 'REPOSITORY_STALE_BASE');
});

test('a lost result acknowledgement retries the exact durable receipt without repeating editing or checks', async () => {
  let attempts = 0;
  const f = fixture({ request: async path => { if (path.endsWith('/result') && ++attempts === 1) throw Error('Network disconnected after server commit'); } });
  await f.add(); f.jobs.push(f.job()); await f.worker.pollOnce();
  assert.equal((await f.worker.status()).pending, 1); f.advance(10001); await f.worker.pollOnce();
  const deliveries = f.calls.filter(item => item.path.endsWith('/result')); assert.equal(deliveries.length, 2); assert.deepEqual(deliveries[0].payload, deliveries[1].payload);
  assert.equal(f.runtimeCalls.filter(item => item === 'edit').length, 1); assert.equal(f.runtimeCalls.filter(item => item === 'check').length, 1); assert.equal((await f.worker.status()).pending, 0);
});

test('existing job and logical run identifiers never trigger another paid execution', async () => {
  const f = fixture(); await f.add(); const job = f.job(); f.jobs.push(job, job, f.job({ id: 'job-two', lease: 'M'.repeat(43) }));
  await f.worker.pollOnce(); assert.equal((await f.worker.pollOnce()).status, 'duplicate'); assert.equal((await f.worker.pollOnce()).status, 'duplicate');
  assert.equal(f.runtimeCalls.filter(item => item === 'edit').length, 1);
});

test('restart converts an in-progress journal to explicit interruption and never resumes editing', async () => {
  let atCrash, f;
  f = fixture({ runtime: { edit: async () => { f.runtimeCalls.push('edit'); atCrash = await f.storage.read('repository-worker'); throw Error('Simulated process stop'); } } });
  await f.add(); f.jobs.push(f.job()); await f.worker.pollOnce();
  await f.storage.write('repository-worker', atCrash); f.calls.length = 0; f.runtimeCalls.length = 0;
  const restarted = createRepositoryWorker(f.workerOptions); await restarted.recover(); await restarted.pollOnce();
  assert.deepEqual(f.runtimeCalls, []); assert.equal(f.calls.find(item => item.path.endsWith('/result')).payload.error.code, 'WORKER_INTERRUPTED');
});

test('heartbeat rejection aborts an active editor and reports lease loss without executing checks', async () => {
  let editingHeartbeats = 0, observedAbort = false;
  const f = fixture({
    request: async (path, payload) => { if (path.endsWith('/heartbeat') && payload.stage === 'editing' && ++editingHeartbeats > 1) throw Object.assign(Error('Revoked'), { statusCode: 401 }); },
    runtime: { edit: async ({ signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => { observedAbort = true; reject(signal.reason); }, { once: true })) },
  });
  await f.add(); f.jobs.push(f.job()); await f.worker.pollOnce();
  assert.equal(observedAbort, true); assert.equal(f.calls.find(item => item.path.endsWith('/result')).payload.error.code, 'LEASE_LOST'); assert.equal(f.runtimeCalls.includes('check'), false);
});

test('shutdown persists a failure for later delivery while cancellation stops active editing', async () => {
  const controller = new AbortController();
  const f = fixture({ runtime: { edit: async ({ signal }) => new Promise((_, reject) => { signal.addEventListener('abort', () => reject(signal.reason), { once: true }); setTimeout(() => controller.abort(), 10); }) } });
  await f.add(); f.jobs.push(f.job()); await f.worker.pollOnce(controller.signal);
  assert.equal(f.calls.some(item => item.path.endsWith('/result')), false);
  const state = await f.worker.status(); assert.equal(state.pending, 1); assert.equal(state.journal[0].errorCode, 'WORKER_INTERRUPTED');
});

test('truncated check evidence is an explicit error, and sandbox errors are reported without leaking paths', async () => {
  const f = fixture({ runtime: { check: async ({ command }) => ({ ...command, status: 'passed', exitCode: 0, output: 'x'.repeat(13000), durationMs: 1 }) } });
  await f.add(); f.jobs.push(f.job()); await f.worker.pollOnce();
  const result = f.calls.find(item => item.path.endsWith('/result')).payload.result;
  assert.equal(result.checks[0].status, 'error'); assert.equal(result.checks[0].exitCode, null); assert.equal(result.checks[0].truncated, true); assert.ok(result.checks[0].output.length <= 12000);
  const blocked = fixture({ runtime: { edit: async () => { throw Object.assign(Error('/private/owner/secret/token'), { code: 'SANDBOX_UNAVAILABLE' }); } } });
  await blocked.add(); blocked.jobs.push(blocked.job()); await blocked.worker.pollOnce();
  const error = blocked.calls.find(item => item.path.endsWith('/result')).payload.error; assert.equal(error.code, 'SANDBOX_UNAVAILABLE'); assert.doesNotMatch(JSON.stringify(error), /owner|secret|token/);
});

test('stale result rejection is retained and not retried; concurrent polls cannot execute twice', async () => {
  const f = fixture({ request: async path => { if (path.endsWith('/result')) throw Object.assign(Error('Stale'), { statusCode: 409 }); } });
  await f.add(); f.jobs.push(f.job()); const pending = f.worker.pollOnce(); await assert.rejects(f.worker.pollOnce(), { code: 'WORKER_BUSY' }); await pending;
  f.advance(15000); await f.worker.pollOnce();
  assert.equal(f.calls.filter(item => item.path.endsWith('/result')).length, 1); assert.equal((await f.worker.status()).journal[0].status, 'rejected');
});

test('worker local paths, policies and receipts are persisted only through the encrypted archive', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-repository-worker-')), storage = createArchive({ directory, mode: 'local', masterKey: undefined });
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const f = fixture({ storage }); await f.add(); f.jobs.push(f.job()); await f.worker.pollOnce();
  for (const file of ['studio.sqlite', 'studio.sqlite-wal']) { const bytes = await readFile(join(directory, file)); assert.equal(bytes.includes(Buffer.from('/allowed/repository')), false); assert.equal(bytes.includes(Buffer.from('Updated the candidate patch.')), false); }
  const restored = createRepositoryWorker(f.workerOptions); assert.equal((await restored.status()).journal[0].status, 'delivered');
});

test('worker receipt completes a real paired repository hub job through the agreed API contract', async t => {
  const records = new Map();
  const storage = {
    read: async (key, fallback) => structuredClone(records.get(key) ?? fallback),
    write: async (key, value) => { records.set(key, structuredClone(value)); },
    update: async (key, fn, fallback) => { const value = fn(structuredClone(records.get(key) ?? fallback)); records.set(key, structuredClone(value)); return structuredClone(value); },
    batch: async entries => { for (const { key, value } of structuredClone(entries)) records.set(key, value); },
  };
  const now = () => Date.parse('2026-09-28T00:00:00Z');
  const devices = createDeviceHub({ storage, now, publicUrl: 'https://studio.example.org', allowLocalExecution: false });
  const pairing = await devices.mutate('pair', { name: 'Repository worker', scopeIds: ['development'], capabilities: ['repository'] });
  const connection = { ...await devices.pair({ code: pairing.code }), url: 'https://studio.example.org' };
  const hub = createRepositoryDeviceHub({ storage, devices, now, pollMs: 1 });
  const f = fixture({ worker: { connection }, request: (path, payload) => {
    const method = path.split('/').at(-1); return method === 'announce' ? hub.announce(connection.token, payload) : method === 'claim' ? hub.claim(connection.token) : method === 'heartbeat' ? hub.heartbeat(connection.token, payload) : hub.finish(connection.token, payload);
  } });
  await f.add(); await f.worker.announce();
  const controller = new AbortController(); t.after(() => controller.abort());
  const pending = hub.run({ deviceId: connection.deviceId, alias: 'product', scopeId: 'development', runId: 'integrated-run', baseCommit, policyHash: repositoryPolicyHash({ alias: 'product', checks, scopeIds: ['development'] }), prompt: 'Change the value to two.', checks, signal: controller.signal });
  for (let attempt = 0; attempt < 100 && !(await storage.read('repository-devices'))?.jobs.length; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  await f.worker.pollOnce(); const receipt = await pending;
  assert.equal(receipt.runId, 'integrated-run'); assert.equal(receipt.checks[0].status, 'passed'); assert.equal(receipt.diff.hash, sha(patch));
  assert.equal((await f.worker.status()).journal[0].status, 'delivered'); assert.equal(f.runtimeCalls.filter(item => item === 'edit').length, 1);
});
