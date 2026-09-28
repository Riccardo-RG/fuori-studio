import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { createRepositoryWork } from '../lib/repository-work.mjs';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const configured = [{ label: 'Unit tests', program: 'node', args: ['--test', 'test/example.test.mjs'] }];
const patchText = 'diff --git a/app.js b/app.js\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-old\n+new\n';
const diff = (patch = patchText) => ({ patch, hash: createHash('sha256').update(patch).digest('hex'), files: [{ path: 'app.js', status: 'M', additions: 1, deletions: 1 }], stats: { files: 1, additions: 1, deletions: 1 }, truncated: false });
function memoryStorage() {
  const values = new Map();
  return { values, read: async (key, fallback) => structuredClone(values.has(key) ? values.get(key) : fallback), write: async (key, value) => values.set(key, structuredClone(value)), batch: async entries => { const cloned = entries.map(entry => ({ ...entry, value: structuredClone(entry.value) })); cloned.forEach(entry => values.set(entry.key, entry.value)); } };
}
async function fixture(t, overrides = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-repository-work-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const storage = memoryStorage(), workspace = createWorkspaceStore({ directory }), calls = { inspect: [], prepare: [], edit: [], check: [], review: [], authorization: [] };
  const operations = { getSnapshot: async () => ({ projects: [{ id: 'owned-project', title: 'Owned product', scopeId: 'business' }] }) };
  const providers = {
    assertAllowed: async options => ({ id: 'codex', type: 'codex', model: 'local-default', name: 'Codex locale', configured: true }),
    execute: async options => { calls.review.push(options); return { text: 'Revisione testuale della patch, con limiti espliciti.', provider: { id: 'codex', type: 'codex', model: 'local-default' }, usage: null, durationMs: 2 }; },
    ...overrides.providers,
  };
  const runtime = {
    inspect: async path => { calls.inspect.push(path); return { path: '/trusted/repository', name: 'repository', head: base, branch: 'main', dirty: true, remote: null }; },
    prepare: async input => { calls.prepare.push(input); return { cwd: `/isolated/${input.runId}`, baseCommit: input.baseCommit, dependencies: { status: 'available' } }; },
    edit: async input => { calls.edit.push(input); return { text: 'Updated app.js.', usage: { inputTokens: 100, outputTokens: 10 }, durationMs: 3 }; },
    check: async input => { calls.check.push(input); return { ...input.command, status: 'passed', exitCode: 0, output: '1 test passed', durationMs: 1 }; },
    diff: async () => diff(),
    ...overrides.runtime,
  };
  const authorizeExecution = async () => { calls.authorization.push(true); if (overrides.authorizeExecution) return overrides.authorizeExecution(); };
  const service = createRepositoryWork({ storage, workspace, operations, providers, runtime, remote: overrides.remote, mode: overrides.mode || 'local', authorizeExecution });
  const register = (extra = {}) => service.register({ projectId: 'owned-project', scopeId: 'business', path: '/trusted/repository', checks: configured, ...extra });
  async function create() { const state = await register(); return (await service.create({ repositoryId: state.repositories[0].id, title: 'Improve feature', brief: 'Implement the requested behavior and verify it.' })).runs.at(-1); }
  return { storage, workspace, operations, providers, runtime, service, calls, register, create };
}
async function settled(service) {
  for (let attempt = 0; attempt < 1000; attempt++) { const state = await service.snapshot(); if (!service.busy) return state; await setImmediate(); }
  throw Error('Repository fake runtime did not settle');
}

test('registration is local-only, project-scoped and requires explicitly allowed checks', async t => {
  const f = await fixture(t);
  await assert.rejects(f.register({ projectId: 'missing' }), { code: 'REPOSITORY_SCOPE_DENIED' });
  await assert.rejects(f.register({ scopeId: 'personal' }), { code: 'REPOSITORY_SCOPE_DENIED' });
  await assert.rejects(f.register({ checks: [] }));
  await assert.rejects(f.register({ checks: [{ label: 'Install', program: 'npm', args: ['install'] }] }));
  await assert.rejects(f.register({ checks: [{ label: 'Shell', program: 'sh', args: ['-c', 'anything'] }] }));
  for (const program of ['npm', 'pnpm', 'yarn']) await assert.rejects(f.register({ checks: [{ label: 'Invalid script option', program, args: ['run', '--prefix'] }] }));
  const result = await f.register();
  assert.equal(result.available, true); assert.equal(result.localOnly, true); assert.equal(result.repositories[0].dirty, true);
  await assert.rejects(f.register(), { code: 'REPOSITORY_EXISTS' });
  const scripts = await fixture(t);
  const scriptChecks = ['npm', 'pnpm', 'yarn'].map(program => ({ label: `${program} offline tests`, program, args: ['run', 'test:offline'] }));
  assert.deepEqual((await scripts.register({ checks: scriptChecks })).repositories[0].checks, scriptChecks);
  const remote = await fixture(t, { mode: 'hybrid' });
  assert.equal((await remote.service.snapshot()).available, false);
  await assert.rejects(remote.register(), { code: 'REPOSITORY_LOCAL_ONLY' });
});

test('a run snapshots its committed base and commands, records actual checks, stores immutable patch separately, and needs human approval', async t => {
  const f = await fixture(t), queued = await f.create();
  assert.equal(queued.baseCommit, base); assert.equal(queued.sourceDirty, true); assert.equal(queued.status, 'queued');
  const started = await f.service.start({ id: queued.id, expectedVersion: queued.version });
  assert.equal(started.runs[0].status, 'running'); assert.equal(f.service.busy, true);
  await assert.rejects(f.service.start({ id: queued.id, expectedVersion: queued.version }), { code: 'REPOSITORY_BUSY' });
  const result = await settled(f.service), run = result.runs[0];
  assert.equal(run.status, 'review'); assert.equal(run.stage, 'review'); assert.equal(run.checksValid, true);
  assert.equal(run.checks[0].status, 'passed'); assert.equal(run.checks[0].exitCode, 0); assert.equal(run.review.status, 'completed');
  assert.equal(f.calls.prepare[0].baseCommit, base); assert.deepEqual(f.calls.check[0].command, configured[0]);
  assert.equal(f.calls.edit.length, 1); assert.equal(f.calls.review.length, 1);
  assert.match(f.calls.review[0].prompt, /CONTROLLI REALI REGISTRATI/);
  assert.equal(run.cwd, undefined); assert.equal(JSON.stringify(result).includes(patchText), false);
  assert.equal((await f.service.patch({ id: run.id })).patch, patchText);
  await assert.rejects(f.service.approve({ id: run.id, expectedVersion: 1 }), { code: 'VERSION_CONFLICT' });
  const approved = (await f.service.approve({ id: run.id, expectedVersion: run.version })).runs[0];
  assert.equal(approved.status, 'completed'); assert.equal(approved.decision.status, 'approved');
  assert.equal(f.calls.edit.length, 1, 'approval cannot execute or modify the checkout');
  const memory = await f.service.proposeMemory({ id: run.id, title: 'Reusable pattern', content: 'Keep this reviewed implementation pattern.', type: 'pattern' });
  assert.equal(memory.memories[0].status, 'proposed'); assert.deepEqual(memory.memories[0].sharedWith, []);
  assert.match(memory.memories[0].source, new RegExp(run.patchHash));
});

test('API editors, authorization failures, unknown project transitions and denied source scopes stop before repository editing', async t => {
  const api = await fixture(t, { providers: { assertAllowed: async () => ({ id: 'external-api', type: 'openai' }) } });
  const apiRun = await api.create();
  await assert.rejects(api.service.start({ id: apiRun.id, expectedVersion: apiRun.version }), { code: 'REPOSITORY_CODEX_REQUIRED' });
  assert.equal(api.calls.prepare.length, 0);
  const denied = await fixture(t, { authorizeExecution: async () => { throw Error('Remote target forbidden'); } });
  const deniedRun = await denied.create();
  await assert.rejects(denied.service.start({ id: deniedRun.id, expectedVersion: deniedRun.version }), /Remote target forbidden/);
  assert.equal(denied.calls.edit.length, 0);
  const source = await fixture(t, { providers: { assertAllowed: async options => { if (options.scopeId === 'personal') throw Error('Source provider forbidden'); return { id: 'codex', type: 'codex' }; } } });
  await source.workspace.mutate('saveMemory', { scopeId: 'personal', title: 'Shared constraint', content: 'Use this implementation constraint.', type: 'preference', status: 'confirmed', sharedWith: ['business'], agentIds: ['forge'] });
  const sourceRun = await source.create();
  await assert.rejects(source.service.start({ id: sourceRun.id, expectedVersion: sourceRun.version }), /Source provider forbidden/);
  assert.equal(source.calls.edit.length, 0);
});

test('a restricted editor source cannot leak through the optional independent reviewer or derived memory', async t => {
  const f = await fixture(t);
  await f.workspace.mutate('saveMemory', { scopeId: 'business', title: 'Forge private constraint', content: 'PRIVATE_FORGE_CONTEXT', type: 'preference', status: 'confirmed', agentIds: ['forge'] });
  const queued = await f.create();
  await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0];
  assert.equal(run.status, 'review'); assert.equal(run.review.status, 'unavailable');
  assert.match(f.calls.edit[0].prompt, /PRIVATE_FORGE_CONTEXT/); assert.equal(f.calls.review.length, 0);
  await f.service.approve({ id: run.id, expectedVersion: run.version });
  const snapshot = await f.service.proposeMemory({ id: run.id, title: 'Restricted pattern', content: 'A pattern derived from the authorized implementation.' });
  assert.deepEqual(snapshot.memories.at(-1).agentIds, ['forge']);
});

test('failed checks remain failed even when the AI reviewer claims success; no premature memory or approval', async t => {
  const f = await fixture(t, { runtime: { check: async input => ({ ...input.command, status: 'failed', exitCode: 1, output: 'Assertion failed', durationMs: 1 }) }, providers: { execute: async () => ({ text: 'Everything passed, approve now!' }) } });
  const queued = await f.create();
  await assert.rejects(f.service.proposeMemory({ id: queued.id, title: 'Premature', content: 'Not approved' }), { code: 'REPOSITORY_INVALID_STATE' });
  await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0];
  assert.equal(run.checks[0].status, 'failed'); assert.equal(run.checks[0].exitCode, 1); assert.equal(run.status, 'review');
  await assert.rejects(f.service.approve({ id: run.id, expectedVersion: run.version }), { code: 'REPOSITORY_APPROVAL_BLOCKED' });
});

test('checks modifying the patch invalidate evidence; a new revision retains the previous artifact and uses a fresh checkout', async t => {
  let diffCalls = 0;
  const f = await fixture(t, { runtime: { diff: async () => diff(++diffCalls === 1 ? patchText : patchText.replace('+new', '+changed-by-check')) } });
  const queued = await f.create();
  await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0];
  assert.equal(run.status, 'failed'); assert.equal(run.checksValid, false); assert.equal(f.calls.review.length, 0);
  const previousPatch = await f.service.patch({ id: run.id });
  const changed = await f.service.requestChanges({ id: run.id, expectedVersion: run.version, feedback: 'Keep test outputs outside tracked source files.' });
  const next = changed.runs.at(-1);
  assert.notEqual(next.id, run.id); assert.equal(next.baseCommit, run.baseCommit); assert.equal(next.parentRunId, run.id); assert.equal(next.status, 'queued');
  assert.deepEqual(await f.service.patch({ id: run.id }), previousPatch);
  await f.service.start({ id: next.id, expectedVersion: next.version });
  await settled(f.service);
  assert.notEqual(f.calls.prepare[0].runId, f.calls.prepare[1].runId);
});

test('pause cancels the active attempt and late runtime output cannot overwrite paused state', async t => {
  let release, began;
  const entered = new Promise(resolve => { began = resolve; });
  const f = await fixture(t, { runtime: { edit: async input => { began(input); await new Promise(resolve => { release = resolve; }); return { text: 'Late reply' }; } } });
  const queued = await f.create(); await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const input = await entered;
  const current = (await f.service.snapshot()).runs[0];
  const paused = await f.service.pause({ id: current.id, expectedVersion: current.version });
  assert.equal(input.signal.aborted, true); assert.equal(paused.runs[0].status, 'paused');
  release(); const result = await settled(f.service);
  assert.equal(result.runs[0].status, 'paused'); assert.equal(result.runs[0].summary, ''); assert.equal(result.runs[0].patchHash, null); assert.equal(f.calls.check.length, 0);
  await assert.rejects(f.service.start({ id: current.id, expectedVersion: result.runs[0].version }), { code: 'REPOSITORY_INVALID_STATE' });
});

test('sandbox or base mismatch failures are surfaced without unsafe fallback or reviewer calls', async t => {
  const sandbox = await fixture(t, { runtime: { edit: async () => { throw Object.assign(Error('Sandbox unavailable'), { code: 'SANDBOX_UNAVAILABLE' }); } } });
  const queued = await sandbox.create(); await sandbox.service.start({ id: queued.id, expectedVersion: queued.version });
  const failed = (await settled(sandbox.service)).runs[0];
  assert.equal(failed.status, 'failed'); assert.match(failed.error, /Sandbox unavailable/); assert.equal(sandbox.calls.review.length, 0);
  const wrongBase = await fixture(t, { runtime: { prepare: async () => ({ cwd: '/wrong', baseCommit: head }) } });
  const wrong = await wrongBase.create(); await wrongBase.service.start({ id: wrong.id, expectedVersion: wrong.version });
  assert.equal((await settled(wrongBase.service)).runs[0].status, 'failed'); assert.equal(wrongBase.calls.edit.length, 0);
});

test('stored patch tampering blocks download and approval; interrupted records recover to paused', async t => {
  const f = await fixture(t), queued = await f.create(); await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0];
  const key = `repository-work/patch/${run.id}`, artifact = await f.storage.read(key);
  await f.storage.write(key, { ...artifact, patch: artifact.patch + 'unreviewed' });
  await assert.rejects(f.service.patch({ id: run.id }), { code: 'REPOSITORY_PATCH_INVALID' });
  await assert.rejects(f.service.approve({ id: run.id, expectedVersion: run.version }), { code: 'REPOSITORY_PATCH_INVALID' });
  const state = await f.storage.read('repository-work'); state.runs[0].status = 'running'; state.runs[0].stage = 'editing'; await f.storage.write('repository-work', state);
  assert.equal((await f.service.recoverInterrupted()).runs[0].status, 'paused');
});

test('withdrawn source versions cannot be converted into new memory after approval', async t => {
  const f = await fixture(t);
  const memory = (await f.workspace.mutate('saveMemory', { scopeId: 'business', title: 'Constraint', content: 'Use reviewed evidence.', type: 'preference', status: 'confirmed' })).memories[0];
  const queued = await f.create(); await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0]; await f.service.approve({ id: run.id, expectedVersion: run.version });
  await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'The constraint was withdrawn.' });
  await assert.rejects(f.service.proposeMemory({ id: run.id, title: 'Pattern', content: 'Derived from stale context.' }), { code: 'REPOSITORY_CONTEXT_CHANGED' });
});

test('fresh reviewer retrieval cannot hide the editor original memory version', async t => {
  const f = await fixture(t);
  const memory = (await f.workspace.mutate('saveMemory', { scopeId: 'business', title: 'Implementation requirement', content: 'Implement the requested behavior with the original invariant.', type: 'preference', status: 'confirmed' })).memories.at(-1);
  f.runtime.check = async ({ command }) => {
    await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'Implement the requested behavior with a revised invariant.' });
    return { ...command, status: 'passed', exitCode: 0, output: '1 test passed', durationMs: 1 };
  };
  const queued = await f.create(); await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0];
  assert.equal(run.status, 'review'); assert.equal(run.review.status, 'unavailable');
  assert.match(run.review.error, /contesto.*cambiato/); assert.equal(f.calls.review.length, 0);
  assert.equal(run.editorContext.memories[0].version, memory.version);
});

test('derived memory validates every persisted editor and reviewer reference before merging versions', async t => {
  const f = await fixture(t);
  const memory = (await f.workspace.mutate('saveMemory', { scopeId: 'business', title: 'Implementation requirement', content: 'Implement the requested behavior with the original invariant.', type: 'preference', status: 'confirmed' })).memories.at(-1);
  const queued = await f.create(); await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0]; await f.service.approve({ id: run.id, expectedVersion: run.version });
  await f.workspace.mutate('saveMemory', { id: memory.id, expectedVersion: memory.version, content: 'Implement the requested behavior with a revised invariant.' });
  // Simulate an earlier persisted result with v1 editor and v2 reviewer evidence.
  const state = await f.storage.read('repository-work'); state.runs[0].reviewerContext.memories[0].version++;
  await f.storage.write('repository-work', state);
  await assert.rejects(f.service.proposeMemory({ id: run.id, title: 'Stale implementation', content: 'Do not restore an obsolete editor decision.' }), { code: 'REPOSITORY_CONTEXT_CHANGED' });
  assert.equal((await f.workspace.getSnapshot()).memories.length, 1);
});

function remoteFixture(overrides = {}) {
  const requests = [], policyHash = 'c'.repeat(64);
  const repository = { alias: 'product', name: 'Product', head: base, branch: 'main', dirty: true, remote: null, checks: configured, scopeIds: ['business'], policyHash, workerName: 'Linux worker' };
  const remote = {
    catalog: async () => ({ workers: [{ id: 'worker', name: 'Linux worker', online: true, scopeIds: ['business'], repositories: [repository] }] }),
    inspect: async input => { requests.push(input); if (input.scopeId !== 'business') throw Error('Remote source scope denied'); return repository; },
    run: async input => { requests.push(input); await input.onProgress({ stage: 'checking' }); return { version: 1, runId: input.runId, baseCommit: base, alias: 'product', policyHash, edited: { text: 'Remote edit', usage: null, durationMs: 10 }, beforeHash: diff().hash, diff: diff(), checks: configured.map(check => ({ ...check, status: 'passed', exitCode: 0, output: 'Passed', durationMs: 2 })) }; },
    ...overrides,
  };
  return { remote, requests, policyHash };
}

test('hosted repository work uses an explicitly authorized worker and never the host filesystem or text execution target', async t => {
  const { remote, requests } = remoteFixture();
  const f = await fixture(t, { mode: 'hybrid', remote, providers: {
    assertPolicyAllowed: async () => ({ id: 'codex', type: 'codex' }),
    assertAllowed: async () => { throw Error('No text target configured'); },
  } });
  const state = await f.service.register({ projectId: 'owned-project', scopeId: 'business', executionTarget: 'worker', repositoryAlias: 'product' });
  assert.equal(state.available, true); assert.equal(state.localAvailable, false); assert.equal(state.localOnly, false);
  const repository = state.repositories[0]; assert.equal(repository.path, 'device:worker/product'); assert.deepEqual(repository.checks, configured);
  let run = (await f.service.create({ repositoryId: repository.id, title: 'Remote change', brief: 'Improve the owned product.' })).runs[0];
  await f.service.start({ id: run.id, expectedVersion: run.version });
  run = (await settled(f.service)).runs[0];
  assert.equal(run.status, 'review'); assert.equal(run.checks[0].status, 'passed'); assert.equal(run.review.status, 'unavailable');
  assert.equal(run.editor.deviceId, 'worker'); assert.equal(f.calls.prepare.length, 0); assert.equal(f.calls.edit.length, 0); assert.equal(f.calls.authorization.length, 0);
  assert.equal(requests.filter(input => input.prompt).length, 1);
  const approved = (await f.service.approve({ id: run.id, expectedVersion: run.version })).runs[0]; assert.equal(approved.status, 'completed');
  assert.match((await f.service.patch({ id: run.id })).patch, /\+new/);
});

test('remote registration cannot grant browser-selected paths or commands and source-scope grants are checked before dispatch', async t => {
  const { remote, requests } = remoteFixture(); const f = await fixture(t, { mode: 'online', remote });
  const registration = { projectId: 'owned-project', scopeId: 'business', executionTarget: 'worker', repositoryAlias: 'product' };
  await assert.rejects(f.service.register({ ...registration, path: '/etc' }));
  await assert.rejects(f.service.register({ ...registration, checks: configured }));
  const repository = (await f.service.register(registration)).repositories[0];
  await f.workspace.mutate('saveMemory', { scopeId: 'personal', title: 'Private decision', content: 'A personal constraint.', type: 'decision', status: 'confirmed', sharedWith: ['business'], agentIds: ['forge'] });
  const run = (await f.service.create({ repositoryId: repository.id, title: 'Scoped change', brief: 'Use the personal constraint.' })).runs[0];
  await assert.rejects(f.service.start({ id: run.id, expectedVersion: run.version }), /Remote source scope denied/);
  assert.equal(requests.filter(input => input.prompt).length, 0);
});

test('remote receipts require exact run, commit, policy and check evidence before human approval', async t => {
  for (const change of [receipt => { receipt.baseCommit = head; }, receipt => { receipt.policyHash = 'd'.repeat(64); }, receipt => { receipt.checks = []; }, receipt => { receipt.diff.patch += 'changed'; }]) {
    const { remote } = remoteFixture(), original = remote.run;
    remote.run = async input => { const receipt = await original(input); change(receipt); return receipt; };
    const f = await fixture(t, { mode: 'hybrid', remote });
    const repository = (await f.service.register({ projectId: 'owned-project', scopeId: 'business', executionTarget: 'worker', repositoryAlias: 'product' })).repositories[0];
    const run = (await f.service.create({ repositoryId: repository.id, title: 'Remote change', brief: 'Make a change.' })).runs[0];
    await f.service.start({ id: run.id, expectedVersion: run.version });
    const result = (await settled(f.service)).runs[0]; assert.equal(result.status, 'failed'); assert.equal(f.calls.review.length, 0);
    await assert.rejects(f.service.approve({ id: result.id, expectedVersion: result.version }), { code: 'REPOSITORY_APPROVAL_BLOCKED' });
  }
});

test('remote policy changes require explicit repository refresh and paused runs reject a late receipt', async t => {
  const setup = remoteFixture(); const f = await fixture(t, { mode: 'hybrid', remote: setup.remote });
  let repository = (await f.service.register({ projectId: 'owned-project', scopeId: 'business', executionTarget: 'worker', repositoryAlias: 'product' })).repositories[0];
  const changed = { ...await setup.remote.inspect({ scopeId: 'business' }), policyHash: 'd'.repeat(64), checks: [{ label: 'New test', program: 'npm', args: ['run', 'test:offline'] }] };
  setup.remote.inspect = async () => changed;
  await assert.rejects(f.service.create({ repositoryId: repository.id, title: 'Change', brief: 'Change it.' }), { code: 'REPOSITORY_POLICY_CHANGED' });
  repository = (await f.service.refresh({ id: repository.id, expectedVersion: repository.version })).repositories[0]; assert.deepEqual(repository.checks, changed.checks);
  let resolveReceipt, signal;
  setup.remote.run = async input => { signal = input.signal; return new Promise(resolve => { resolveReceipt = resolve; }); };
  let run = (await f.service.create({ repositoryId: repository.id, title: 'Change', brief: 'Change it.' })).runs[0];
  await f.service.start({ id: run.id, expectedVersion: run.version });
  for (let i = 0; i < 1000 && !resolveReceipt; i++) await setImmediate();
  assert.ok(resolveReceipt);
  run = (await f.service.snapshot()).runs[0];
  await f.service.pause({ id: run.id, expectedVersion: run.version }); assert.equal(signal.aborted, true);
  resolveReceipt({});
  assert.equal((await settled(f.service)).runs[0].status, 'paused');
});


test('publication candidates require current human approval, valid checks and the exact persisted patch', async t => {
  const f = await fixture(t), queued = await f.create();
  await assert.rejects(f.service.approvedPublication({ id: queued.id }), { code: 'REPOSITORY_APPROVAL_BLOCKED' });
  await f.service.start({ id: queued.id, expectedVersion: queued.version });
  const run = (await settled(f.service)).runs[0];
  await assert.rejects(f.service.approvedPublication({ id: run.id }), { code: 'REPOSITORY_APPROVAL_BLOCKED' });
  const approved = (await f.service.approve({ id: run.id, expectedVersion: run.version })).runs[0];
  const candidate = await f.service.approvedPublication({ id: run.id });
  assert.equal(candidate.patch, patchText); assert.equal(candidate.patchHash, run.patchHash); assert.equal(candidate.version, approved.version);
  assert.equal(candidate.path, undefined); assert.equal(candidate.configuration, undefined);
  const artifact = await f.storage.read(`repository-work/patch/${run.id}`);
  await f.storage.write(`repository-work/patch/${run.id}`, { ...artifact, patch: artifact.patch + 'changed' });
  await assert.rejects(f.service.approvedPublication({ id: run.id }), { code: 'REPOSITORY_PATCH_INVALID' });
  await f.storage.write(`repository-work/patch/${run.id}`, artifact);
  await f.service.requestChanges({ id: run.id, expectedVersion: approved.version, feedback: 'Revise before publishing.' });
  await assert.rejects(f.service.approvedPublication({ id: run.id }), { code: 'REPOSITORY_APPROVAL_BLOCKED' });
});
