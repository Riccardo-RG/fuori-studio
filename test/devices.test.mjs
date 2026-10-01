import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceHub } from '../lib/devices.mjs';

function fixture(options = {}) {
  let value, queue = Promise.resolve(), time = Date.now();
  const storage = {
    async read(_key, fallback) { await queue; return structuredClone(value || fallback); },
    update(_key, fn, fallback) {
      const operation = queue.then(() => { const updated = fn(structuredClone(value || fallback)); value = structuredClone(updated); return structuredClone(updated); });
      queue = operation.catch(() => {}); return operation;
    },
  };
  const hub = createDeviceHub({ storage, now: () => time, publicUrl: 'https://studio.example', ...options });
  async function pair(extra = {}) {
    const invite = await hub.mutate('pair', { name: 'Mac personale', scopeIds: ['development'], capabilities: ['execute', 'sync'], ...extra });
    return { invite, ...(await hub.pair({ code: invite.code })) };
  }
  async function start(scopeId = 'development', options = {}) {
    const controller = new AbortController();
    const result = hub.run('Private task prompt', { ...options, scopeId, signal: controller.signal }).then(result => typeof result === 'string' ? { text: result } : result, error => ({ error }));
    for (let i = 0; i < 100; i += 1) {
      if (value?.jobs?.some(job => job.status === 'queued')) return { result, controller };
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail('Expected an enqueued job');
  }
  return { hub, pair, start, advance(ms) { time += ms; }, get state() { return structuredClone(value); } };
}

test('pairing codes are short-lived and single-use, tokens are hashed, snapshots are redacted', async () => {
  const f = fixture(), paired = await f.pair();
  assert.equal(paired.invite.serverUrl, 'https://studio.example');
  assert.equal(paired.token.length, 43);
  assert.equal(JSON.stringify(f.state).includes(paired.token), false);
  assert.equal(JSON.stringify(f.state).includes(paired.invite.code), false);
  const snapshot = await f.hub.snapshot();
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.devices[0].online, true);
  assert.doesNotMatch(JSON.stringify(snapshot), /tokenHash|codeHash|Private task/);
  await assert.rejects(f.hub.pair({ code: paired.invite.code }), { statusCode: 401 });
  await assert.rejects(f.hub.authenticate('invalid', 'execute'), { statusCode: 401 });
  const expired = await f.hub.mutate('pair', { name: 'Expiring', scopeIds: ['development'], capabilities: ['execute'] });
  f.advance(300000);
  await assert.rejects(f.hub.pair({ code: expired.code }), { statusCode: 401 });
  assert.equal((await f.hub.snapshot()).devices[0].online, false);
});

test('device capabilities, authorized scopes and explicit execution target are mandatory', async () => {
  const f = fixture({ allowLocalExecution: false });
  await assert.rejects(f.hub.authorize('development'), { code: 'DEVICE_NOT_CONFIGURED' });
  const syncOnly = await f.pair({ capabilities: ['sync'] });
  await assert.rejects(f.hub.mutate('target', { id: syncOnly.deviceId }));
  await assert.rejects(f.hub.claim(syncOnly.token), { statusCode: 401 });
  const worker = await f.pair({ capabilities: ['execute'] });
  await f.hub.mutate('target', { id: worker.deviceId });
  await f.hub.authorize('development');
  await assert.rejects(f.hub.authorize('personal'), { statusCode: 403 });
  await assert.rejects(f.hub.run('private', { scopeId: 'personal' }), { statusCode: 403 });
  await assert.rejects(f.hub.authenticate(worker.token, 'sync'), { statusCode: 401 });
  await assert.rejects(f.hub.mutate('target', { id: 'local' }));
  f.advance(30 * 86400000);
  await assert.rejects(f.hub.authenticate(worker.token, 'execute'), { statusCode: 401 });
});

test('a job is addressed to one device and accepts exactly one matching lease result', async () => {
  const f = fixture(), worker = await f.pair(), other = await f.pair({ name: 'Altro Mac' });
  await f.hub.mutate('target', { id: worker.deviceId });
  const task = await f.start();
  assert.deepEqual(await f.hub.claim(other.token), { job: null });
  const { job } = await f.hub.claim(worker.token);
  assert.equal(job.prompt, 'Private task prompt');
  assert.equal(job.scopeId, 'development');
  assert.deepEqual(await f.hub.claim(worker.token), { job: null });
  await assert.rejects(f.hub.finish(other.token, { id: job.id, lease: job.lease, text: 'wrong worker' }), { code: 'DEVICE_STALE_RESULT' });
  await assert.rejects(f.hub.finish(worker.token, { id: job.id, lease: 'wrong lease', text: 'wrong lease' }), { code: 'DEVICE_STALE_RESULT' });
  await f.hub.finish(worker.token, { id: job.id, lease: job.lease, text: 'Completed result' });
  await assert.rejects(f.hub.finish(worker.token, { id: job.id, lease: job.lease, text: 'duplicate' }), { code: 'DEVICE_STALE_RESULT' });
  assert.deepEqual(await task.result, { text: 'Completed result' });
  assert.equal(f.state.jobs[0].prompt, undefined);
  assert.equal(f.state.jobs[0].text, undefined);
  assert.equal(f.state.jobs[0].leaseHash, undefined);
});

test('remote usage survives the lease boundary with only validated counts and supports older workers', async () => {
  const f = fixture(), worker = await f.pair();
  await f.hub.mutate('target', { id: worker.deviceId });
  for (const [usage, expected] of [
    [{ inputTokens: 45, outputTokens: 0, privateMetadata: 'PRIVATE_USAGE_SECRET' }, { inputTokens: 45, outputTokens: 0 }],
    [undefined, { inputTokens: null, outputTokens: null }],
    [{ inputTokens: '45', outputTokens: -1 }, { inputTokens: null, outputTokens: null }],
    [{ inputTokens: 0.5, outputTokens: Number.MAX_SAFE_INTEGER + 1 }, { inputTokens: null, outputTokens: null }],
    [{ inputTokens: 5 }, { inputTokens: 5, outputTokens: null }],
  ]) {
    const task = await f.start('development', { returnUsage: true });
    const { job } = await f.hub.claim(worker.token);
    await f.hub.finish(worker.token, { id: job.id, lease: job.lease, text: 'Completed result', usage });
    assert.doesNotMatch(JSON.stringify(f.state), /PRIVATE_USAGE_SECRET/);
    assert.deepEqual(await task.result, { text: 'Completed result', usage: expected });
    assert.ok(f.state.jobs.every(item => item.usage === undefined));
  }
  assert.equal(await fixture().hub.run('local prompt', { scopeId: 'development', returnUsage: true }), null);
});

test('heartbeats renew only an active lease; expired work is not reclaimed or retried', async () => {
  const f = fixture(), worker = await f.pair();
  await f.hub.mutate('target', { id: worker.deviceId });
  const task = await f.start(), { job } = await f.hub.claim(worker.token);
  f.advance(20000);
  await f.hub.finish(worker.token, { id: job.id, lease: job.lease }, true);
  f.advance(20000);
  await f.hub.finish(worker.token, { id: job.id, lease: job.lease }, true);
  f.advance(30000);
  await assert.rejects(f.hub.finish(worker.token, { id: job.id, lease: job.lease, text: 'late' }), { code: 'DEVICE_STALE_RESULT' });
  assert.deepEqual(await f.hub.claim(worker.token), { job: null });
  const result = await task.result;
  assert.equal(result.error.code, 'DEVICE_FAILED');
  assert.equal(f.state.jobs[0].status, 'failed');
});

test('offline jobs wait for the selected device and cancellation removes prompts and rejects late output', async () => {
  const f = fixture(), worker = await f.pair();
  await f.hub.mutate('target', { id: worker.deviceId });
  f.advance(60000);
  const task = await f.start();
  assert.equal((await f.hub.snapshot()).devices[0].online, false);
  assert.equal(f.state.jobs[0].status, 'queued');
  task.controller.abort();
  const result = await task.result;
  assert.equal(result.error.code, 'DEVICE_ABORTED');
  assert.equal(f.state.jobs[0].status, 'cancelled');
  assert.equal(f.state.jobs[0].prompt, undefined);
  assert.deepEqual(await f.hub.claim(worker.token), { job: null });
});

test('revocation and server recovery cancel work without accepting stale device replies', async () => {
  const f = fixture(), worker = await f.pair();
  await f.hub.mutate('target', { id: worker.deviceId });
  const task = await f.start(), { job } = await f.hub.claim(worker.token);
  await f.hub.mutate('revoke', { id: worker.deviceId });
  await assert.rejects(f.hub.finish(worker.token, { id: job.id, lease: job.lease, text: 'late' }), { statusCode: 401 });
  await assert.rejects(f.hub.authorize('development'), { code: 'DEVICE_NOT_CONFIGURED' });
  assert.equal((await task.result).error.code, 'DEVICE_FAILED');
  assert.equal(f.state.devices[0].tokenHash, null);
  const next = await f.pair(); await f.hub.mutate('target', { id: next.deviceId });
  const interrupted = await f.start();
  await f.hub.recover();
  assert.equal((await interrupted.result).error.code, 'DEVICE_FAILED');
  assert.deepEqual(await f.hub.claim(next.token), { job: null });
});

test('local execution is an explicit target and already-aborted runs enqueue nothing', async () => {
  const f = fixture();
  assert.equal(await f.hub.run('local prompt', { scopeId: 'development' }), null);
  const signal = AbortSignal.abort();
  await assert.rejects(f.hub.run('cancelled', { signal, scopeId: 'development' }), { code: 'DEVICE_ABORTED' });
  assert.equal(f.state.jobs.length, 0);
});

test('outstanding pairing codes cannot bypass the maximum active device count', async () => {
  const f = fixture();
  for (let i = 0; i < 19; i += 1) await f.pair({ name: `Computer ${i}` });
  const one = await f.hub.mutate('pair', { name: 'Computer 20', scopeIds: ['development'], capabilities: ['execute'] });
  const two = await f.hub.mutate('pair', { name: 'Computer 21', scopeIds: ['development'], capabilities: ['execute'] });
  await f.hub.pair({ code: one.code });
  await assert.rejects(f.hub.pair({ code: two.code }));
  assert.equal((await f.hub.snapshot()).devices.length, 20);
});
