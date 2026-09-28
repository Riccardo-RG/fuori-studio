import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeviceHub } from '../lib/devices.mjs';
import { createArchive } from '../lib/archive.mjs';
import { createRepositoryDeviceHub, repositoryPolicyHash } from '../lib/repository-devices.ts';

const hash = value => createHash('sha256').update(value).digest('hex');
const base = 'a'.repeat(40), checks = [{ label: 'Unit tests', program: 'node', args: ['--test', 'test/example.test.mjs'] }];
const patch = 'diff --git a/app.js b/app.js\nindex 1111111..2222222 100644\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old\n+new\n';
const KEY = 'repository-devices';
function memoryStorage() {
  const records = new Map(); let queue = Promise.resolve();
  const serial = operation => { const promise = queue.then(operation); queue = promise.catch(() => {}); return promise; };
  return { records, failBatch: false,
    read: (key, fallback) => serial(() => structuredClone(records.has(key) ? records.get(key) : fallback)),
    write: (key, value) => serial(() => records.set(key, structuredClone(value))),
    batch(entries) { return serial(() => { if (this.failBatch) throw Error('Atomic write rejected'); const copies = structuredClone(entries); for (const { key, value } of copies) records.set(key, value); }); },
    update: (key, fn, fallback) => serial(() => { const next = fn(structuredClone(records.has(key) ? records.get(key) : fallback)); records.set(key, structuredClone(next)); return structuredClone(next); }),
  };
}
async function fixture(t, customStorage) {
  let clock = Date.parse('2026-09-28T12:00:00.000Z'); const storage = customStorage || memoryStorage();
  const devices = createDeviceHub({ storage, now: () => clock, publicUrl: 'https://studio.example', allowLocalExecution: false });
  const hub = createRepositoryDeviceHub({ storage, devices, now: () => clock, pollMs: 1 });
  const requests = [], controllers = [];
  t.after(async () => { controllers.forEach(item => item.abort()); await Promise.allSettled(requests); });
  async function pair(extra = {}) { const invite = await devices.mutate('pair', { name: 'Linux coding worker', scopeIds: ['development'], capabilities: ['repository'], ...extra }); return devices.pair({ code: invite.code }); }
  function repository(extra = {}) { const value = { alias: 'product', name: 'Product', head: base, branch: 'main', dirty: false, remote: 'https://github.com/owner/product', checks: structuredClone(checks), scopeIds: ['development'], ...extra }; return { ...value, policyHash: repositoryPolicyHash(value) }; }
  const worker = await pair(), repo = repository(); await hub.announce(worker.token, { repositories: [repo] });
  async function start(extra = {}) {
    const controller = new AbortController(); controllers.push(controller);
    const runId = `run-${controllers.length}`, progress = [];
    const result = hub.run({ deviceId: worker.deviceId, alias: repo.alias, scopeId: 'development', runId, baseCommit: base, policyHash: repo.policyHash, prompt: 'Implement the approved product requirement.', checks: structuredClone(checks), signal: controller.signal, onProgress: value => progress.push(value), ...extra }).then(value => ({ value }), error => ({ error }));
    requests.push(result);
    await until(async () => (await storage.read(KEY))?.jobs.some(job => job.runId === (extra.runId || runId)), 'queued job');
    return { result, controller, runId: extra.runId || runId, progress };
  }
  return { storage, devices, hub, worker, repo, pair, repository, start, advance: ms => { clock += ms; }, now: () => clock };
}
async function until(check, description) { for (let index = 0; index < 300; index++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 2)); } throw Error(`Timed out: ${description}`); }
function receipt(job, extra = {}) { return { version: 1, runId: job.runId, baseCommit: job.baseCommit, alias: job.alias, policyHash: job.policyHash, edited: { text: 'REPOSITORY_RESULT_MARKER', usage: { inputTokens: 12, outputTokens: 4 }, durationMs: 50 }, beforeHash: hash(patch), diff: { patch, hash: hash(patch), files: [{ path: 'app.js', status: 'M', additions: 1, deletions: 1 }], stats: { files: 1, additions: 1, deletions: 1 }, truncated: false }, checks: job.checks.map(command => ({ ...structuredClone(command), status: 'passed', exitCode: 0, output: 'All configured checks passed.', durationMs: 10, truncated: false })), dependencies: { status: 'not-needed', reason: 'No dependencies declared.' }, ...extra }; }

test('repository capability is independent of text execution; catalog only exposes scoped metadata and canonical policy', async t => {
  const f = await fixture(t), textWorker = await f.pair({ capabilities: ['execute'] });
  await assert.rejects(f.hub.announce(textWorker.token, { repositories: [f.repo] }), { code: 'DEVICE_UNAUTHORIZED' });
  await assert.rejects(f.devices.mutate('target', { id: f.worker.deviceId }), /non disponibile/);
  assert.equal((await f.devices.authenticate(f.worker.token, 'repository')).id, f.worker.deviceId);
  await assert.rejects(f.devices.authenticate(f.worker.token, 'execute'), { code: 'DEVICE_UNAUTHORIZED' });
  const catalog = await f.hub.catalog(); assert.equal(catalog.workers.length, 1); assert.equal(catalog.workers[0].online, true);
  assert.doesNotMatch(JSON.stringify(catalog), /token|lease|cwd|\/Users|\/home/);
  assert.deepEqual(await f.hub.inspect({ deviceId: f.worker.deviceId, alias: 'product', scopeId: 'development' }), f.repo);
  await assert.rejects(f.hub.inspect({ deviceId: f.worker.deviceId, alias: 'product', scopeId: 'personal' }), { code: 'REPOSITORY_DEVICE_SCOPE' });
  assert.equal(repositoryPolicyHash({ alias: 'product', checks, scopeIds: ['personal', 'development'] }), repositoryPolicyHash({ scopeIds: ['development', 'personal'], checks: [{ program: 'node', args: ['--test', 'test/example.test.mjs'], label: ' Unit tests ' }], alias: 'product' }));
});

test('inventory rejects paths, credentials, forged policy, unauthorized scopes and duplicate aliases; stale catalog fails closed', async t => {
  const f = await fixture(t);
  for (const value of [{ ...f.repo, path: '/home/worker/product' }, { ...f.repo, policyHash: 'b'.repeat(64) }, f.repository({ scopeIds: ['personal'] }), { ...f.repo, remote: 'https://token@github.com/owner/product' }, { ...f.repo, name: f.worker.token }]) await assert.rejects(f.hub.announce(f.worker.token, { repositories: [value] }));
  await assert.rejects(f.hub.announce(f.worker.token, { repositories: [f.repo, f.repo] }));
  f.advance(46000); await assert.rejects(f.hub.inspect({ deviceId: f.worker.deviceId, alias: 'product', scopeId: 'development' }), { code: 'REPOSITORY_DEVICE_OFFLINE' });
  await f.devices.touch(f.worker.token, 'repository'); f.advance(15000); await f.devices.touch(f.worker.token, 'repository');
  await assert.rejects(f.hub.inspect({ deviceId: f.worker.deviceId, alias: 'product', scopeId: 'development' }), { code: 'REPOSITORY_CATALOG_STALE' });
  assert.equal((await f.hub.catalog()).workers[0].online, false);
});

test('only the addressed worker can lease work, complete checks and durably return an immutable separate receipt', async t => {
  const f = await fixture(t), other = await f.pair(), request = await f.start();
  assert.deepEqual(await f.hub.claim(other.token), { job: null });
  const { job } = await f.hub.claim(f.worker.token); assert.ok(job); assert.equal(job.runId, request.runId); assert.equal(job.lease.length, 43);
  assert.deepEqual(await f.hub.claim(f.worker.token), { job: null });
  await assert.rejects(f.hub.heartbeat(other.token, { id: job.id, lease: job.lease }), { code: 'REPOSITORY_STALE_LEASE' });
  await f.hub.heartbeat(f.worker.token, { id: job.id, lease: job.lease, stage: 'editing' });
  await until(() => request.progress.some(item => item.stage === 'editing'), 'editing progress');
  await f.hub.heartbeat(f.worker.token, { id: job.id, lease: job.lease, stage: 'checking' });
  const result = receipt(job); await f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result });
  assert.deepEqual((await request.result).value, result);
  const ledger = await f.storage.read(KEY); assert.equal(ledger.jobs[0].status, 'completed'); assert.equal(ledger.jobs[0].prompt, null);
  assert.doesNotMatch(JSON.stringify(ledger), /REPOSITORY_RESULT_MARKER|diff --git|All configured checks passed/);
  assert.equal(JSON.stringify(ledger).includes(job.lease), false); assert.equal(JSON.stringify(ledger).includes(f.worker.token), false);
  assert.deepEqual(await f.storage.read(`${KEY}/result/${job.id}`), result);
});

test('completed receipt acknowledgements are idempotent across hub restart but changed output is rejected', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token), result = receipt(job);
  await f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result }); await request.result;
  const restored = createRepositoryDeviceHub({ storage: f.storage, devices: f.devices, now: f.now, pollMs: 1 }); await restored.recover();
  assert.deepEqual(await restored.finish(f.worker.token, { id: job.id, lease: job.lease, result: { ...result, edited: { usage: result.edited.usage, durationMs: 50, text: result.edited.text } } }), { ok: true });
  await assert.rejects(restored.finish(f.worker.token, { id: job.id, lease: job.lease, result: { ...result, edited: { ...result.edited, text: 'Different output' } } }), { code: 'REPOSITORY_RECEIPT_CONFLICT' });
  f.advance(24 * 60 * 60 * 1000 + 1);
  await assert.rejects(restored.finish(f.worker.token, { id: job.id, lease: job.lease, result }), { code: 'REPOSITORY_RECEIPT_CONFLICT' });
  assert.equal(await f.storage.read(`${KEY}/result/${job.id}`), null);
});

test('missing checks, mismatched commands, impossible statuses, hashes and protected patch paths cannot become receipts', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token), good = receipt(job);
  const cases = [
    { ...good, runId: 'other-run' }, { ...good, baseCommit: 'b'.repeat(40) }, { ...good, checks: [] },
    { ...good, checks: [{ ...good.checks[0], args: ['--test', 'other.test.mjs'] }] },
    { ...good, checks: [{ ...good.checks[0], exitCode: 1 }] }, { ...good, checks: [{ ...good.checks[0], truncated: true }] },
    { ...good, diff: { ...good.diff, hash: 'f'.repeat(64) } }, { ...good, diff: { ...good.diff, truncated: true } },
    { ...good, diff: { ...good.diff, files: [{ ...good.diff.files[0], path: '../../.env' }] } },
    { ...good, diff: { ...good.diff, stats: { ...good.diff.stats, additions: 42 } } },
    { ...good, diff: { ...good.diff, patch: patch.replaceAll('app.js', 'other.js'), hash: hash(patch.replaceAll('app.js', 'other.js')) } },
    { ...good, diff: { ...good.diff, patch: patch.replace('+++ b/app.js', '+++ b/../../outside.js'), hash: hash(patch.replace('+++ b/app.js', '+++ b/../../outside.js')) } },
    { ...good, diff: { ...good.diff, files: [{ ...good.diff.files[0], additions: 42 }], stats: { ...good.diff.stats, additions: 42 } } },
    { ...good, cwd: '/home/worker/checkout' }, { ...good, edited: { ...good.edited, text: `Bearer ${f.worker.token}` } },
    { ...good, edited: { ...good.edited, text: `PRIVATE sk-proj-${'a'.repeat(40)}` } },
  ];
  for (const result of cases) await assert.rejects(f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result }));
  assert.equal((await f.storage.read(KEY)).jobs[0].status, 'leased'); assert.equal(await f.storage.read(`${KEY}/result/${job.id}`), undefined);
  await f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result: good }); assert.deepEqual((await request.result).value, good);
});

test('pause aborts delivery and blocks late results without requeueing; expired leases never transfer to another worker', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token);
  request.controller.abort(); assert.equal((await request.result).error.code, 'REPOSITORY_DEVICE_ABORTED');
  await assert.rejects(f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result: receipt(job) }), { code: 'REPOSITORY_STALE_LEASE' });
  assert.deepEqual(await f.hub.claim(f.worker.token), { job: null });
  const next = await f.start(), claimed = (await f.hub.claim(f.worker.token)).job; f.advance(30001);
  await assert.rejects(f.hub.heartbeat(f.worker.token, { id: claimed.id, lease: claimed.lease }), { code: 'REPOSITORY_STALE_LEASE' });
  assert.equal((await next.result).error.code, 'REPOSITORY_DEVICE_EXPIRED');
  assert.deepEqual(await f.hub.claim(f.worker.token), { job: null });
});

test('valid heartbeats keep a long job alive without requiring its original inventory to be refreshed', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token);
  for (let i = 0; i < 8; i++) { f.advance(20000); await f.hub.heartbeat(f.worker.token, { id: job.id, lease: job.lease, stage: 'editing' }); }
  await assert.rejects(f.hub.inspect({ deviceId: f.worker.deviceId, alias: 'product', scopeId: 'development' }), { code: 'REPOSITORY_CATALOG_STALE' });
  await f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result: receipt(job) }); assert.ok((await request.result).value);
});

test('revocation, removed scope and changed policy each reject active results and never expose raw worker diagnostics', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token);
  await f.devices.mutate('revoke', { id: f.worker.deviceId }); await f.hub.cancelDevice(f.worker.deviceId);
  await assert.rejects(f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result: receipt(job) }), { code: 'DEVICE_UNAUTHORIZED' }); assert.ok((await request.result).error);
  const g = await fixture(t), next = await g.start(), leased = (await g.hub.claim(g.worker.token)).job;
  await g.storage.update('devices', state => { state.devices[0].scopeIds = ['personal']; return state; });
  await assert.rejects(g.hub.finish(g.worker.token, { id: leased.id, lease: leased.lease, result: receipt(leased) }), { code: 'REPOSITORY_DEVICE_SCOPE' }); assert.ok((await next.result).error);
  const h = await fixture(t), changed = await h.start(), active = (await h.hub.claim(h.worker.token)).job;
  await h.hub.announce(h.worker.token, { repositories: [h.repository({ checks: [{ label: 'Changed check', program: 'node', args: ['--test'] }] })] });
  assert.equal((await changed.result).error.code, 'REPOSITORY_POLICY_CHANGED');
  await assert.rejects(h.hub.finish(h.worker.token, { id: active.id, lease: active.lease, result: receipt(active) }));
  const last = await h.start({ policyHash: h.repository({ checks: [{ label: 'Changed check', program: 'node', args: ['--test'] }] }).policyHash, checks: [{ label: 'Changed check', program: 'node', args: ['--test'] }] });
  const final = (await h.hub.claim(h.worker.token)).job;
  await h.hub.finish(h.worker.token, { id: final.id, lease: final.lease, error: { code: 'SANDBOX_UNAVAILABLE', message: '/home/private/path RAW_DIAGNOSTICS' } });
  const error = (await last.result).error; assert.equal(error.code, 'SANDBOX_UNAVAILABLE'); assert.doesNotMatch(error.message, /RAW_DIAGNOSTICS|private/); assert.doesNotMatch(JSON.stringify(await h.storage.read(KEY)), /RAW_DIAGNOSTICS/);
});

test('recovery fails queued/leased jobs, requires fresh inventory, and does not rerun an existing attempt', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token); await f.hub.recover();
  assert.equal((await request.result).error.code, 'WORKER_INTERRUPTED'); assert.deepEqual(await f.hub.claim(f.worker.token), { job: null });
  await assert.rejects(f.hub.inspect({ deviceId: f.worker.deviceId, alias: 'product', scopeId: 'development' }), { code: 'REPOSITORY_CATALOG_STALE' });
  await f.hub.announce(f.worker.token, { repositories: [f.repo] });
  await assert.rejects(f.hub.run({ deviceId: f.worker.deviceId, alias: 'product', scopeId: 'development', runId: job.runId, baseCommit: base, policyHash: f.repo.policyHash, checks, prompt: 'Do not rerun old work.' }), { code: 'REPOSITORY_RUN_USED' });
});

test('atomic receipt write failures leave the lease retryable and corrupt archives are preserved', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token), result = receipt(job);
  f.storage.failBatch = true; await assert.rejects(f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result }), /Atomic write rejected/);
  assert.equal((await f.storage.read(KEY)).jobs[0].status, 'leased'); assert.equal(await f.storage.read(`${KEY}/result/${job.id}`), undefined);
  f.storage.failBatch = false; await f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result }); assert.ok((await request.result).value);
  const corrupted = { ...(await f.storage.read(KEY)), jobs: [{ ...((await f.storage.read(KEY)).jobs[0]), checks: [] }] }; await f.storage.write(KEY, corrupted);
  await assert.rejects(f.hub.catalog(), { code: 'REPOSITORY_DEVICE_CORRUPT' }); assert.deepEqual(await f.storage.read(KEY), corrupted);
});

test('concurrent duplicate starts reserve once, pre-abort reserves nothing, and deadline stops a queued job', async t => {
  const f = await fixture(t);
  const input = { deviceId: f.worker.deviceId, alias: 'product', scopeId: 'development', runId: 'once', baseCommit: base, policyHash: f.repo.policyHash, checks, prompt: 'Bounded change.' };
  await assert.rejects(f.hub.run({ ...input, signal: AbortSignal.abort() }), { code: 'REPOSITORY_DEVICE_ABORTED' }); assert.equal((await f.storage.read(KEY)).jobs.length, 0);
  const request = await f.start({ runId: 'once' }); await assert.rejects(f.hub.run(input), { code: 'REPOSITORY_RUN_USED' });
  f.advance(30 * 60 * 1000 + 1); assert.equal((await request.result).error.code, 'REPOSITORY_DEVICE_EXPIRED'); assert.deepEqual(await f.hub.claim(f.worker.token), { job: null });
});

test('real archive keeps prompts and patch receipts encrypted across restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-repository-hub-')), storage = createArchive({ directory, mode: 'local' });
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const f = await fixture(t, storage), request = await f.start(), { job } = await f.hub.claim(f.worker.token);
  await f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result: receipt(job) }); await request.result;
  const bytes = await readFile(join(directory, 'studio.sqlite')); assert.equal(bytes.includes(Buffer.from('REPOSITORY_RESULT_MARKER')), false); assert.equal(bytes.includes(Buffer.from(patch)), false);
  const restored = createRepositoryDeviceHub({ storage, devices: f.devices, now: f.now }); assert.equal((await restored.catalog()).workers[0].repositories[0].head, base);
  assert.deepEqual(await restored.finish(f.worker.token, { id: job.id, lease: job.lease, result: receipt(job) }), { ok: true });
});

test('patch metadata validation accepts added, deleted and Git-quoted UTF-8 filenames without hiding file counts', async t => {
  const f = await fixture(t), request = await f.start(), { job } = await f.hub.claim(f.worker.token);
  const detailedPatch = [
    'diff --git a/new.txt b/new.txt', 'new file mode 100644', 'index 0000000..1111111', '--- /dev/null', '+++ b/new.txt', '@@ -0,0 +1 @@', '+new',
    'diff --git a/old.txt b/old.txt', 'deleted file mode 100644', 'index 2222222..0000000', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-old',
    String.raw`diff --git "a/caff\303\250.txt" "b/caff\303\250.txt"`, 'index 1111111..2222222 100644', String.raw`--- "a/caff\303\250.txt"`, String.raw`+++ "b/caff\303\250.txt"`, '@@ -1 +1 @@', '-old', '+new', '',
  ].join('\n');
  const result = receipt(job, { diff: { patch: detailedPatch, hash: hash(detailedPatch), files: [{ path: 'new.txt', status: 'A', additions: 1, deletions: 0 }, { path: 'old.txt', status: 'D', additions: 0, deletions: 1 }, { path: 'caffè.txt', status: 'M', additions: 1, deletions: 1 }], stats: { files: 3, additions: 2, deletions: 2 }, truncated: false } });
  await f.hub.finish(f.worker.token, { id: job.id, lease: job.lease, result }); assert.deepEqual((await request.result).value.diff.stats, { files: 3, additions: 2, deletions: 2 });
});
