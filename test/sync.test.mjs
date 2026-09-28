import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';
import { createWorkspaceStore } from '../lib/workspace.mjs';
import { createDeviceHub } from '../lib/devices.mjs';
import { createSyncService, deviceRequest, mergeRecords, trustedOrigin } from '../lib/sync.mjs';
import { recordHash, recordKey, syncRecord } from '../lib/sync-records.mjs';

const remoteOrigin = 'https://studio.example.com';
const note = (title, extra = {}) => ({ scopeId: 'business', title, content: `${title}: specific project knowledge.`, type: 'fact', status: 'confirmed', source: 'User statement', sharedWith: [], agentIds: [], ...extra });
const field = (value, extra = {}) => ({ id: 'note-one', ...note(value), ...extra });
const key = 'memories/business/note-one';
const deletion = { collection: 'memories', scopeId: 'business', id: 'note-one', deletedAt: '2026-01-01T00:00:00.000Z' };

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-sync-'));
  const archives = [];
  t.after(async () => { for (const archive of archives) await archive.close(); await rm(directory, { recursive: true, force: true }); });
  async function studio(name, fetchImpl) {
    const path = join(directory, name), archive = createArchive({ directory: path, mode: 'local', masterKey: undefined });
    archives.push(archive);
    const workspace = createWorkspaceStore({ directory: path, storage: archive });
    const devices = createDeviceHub({ storage: archive, publicUrl: remoteOrigin });
    const service = createSyncService({ storage: archive, workspace, devices, fetchImpl });
    return { workspace, devices, service, archive };
  }
  const remote = await studio('remote');
  let afterExchange;
  const requests = [];
  const transport = async (url, options) => {
    const parsed = new URL(url), payload = JSON.parse(options.body);
    requests.push({ path: parsed.pathname, payload, headers: options.headers });
    assert.equal(parsed.origin, remoteOrigin);
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'POST');
    try {
      let result;
      if (parsed.pathname === '/api/device/pair') result = await remote.devices.pair(payload);
      else {
        assert.equal(parsed.pathname, '/api/device/sync');
        result = await remote.service.exchange(options.headers.Authorization?.slice(7), payload);
        if (afterExchange) { const callback = afterExchange; afterExchange = null; await callback(); }
      }
      return new Response(JSON.stringify(result), { status: 200, headers: { 'content-type': 'application/json' } });
    } catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: error.statusCode || error.status || 500, headers: { 'content-type': 'application/json' } }); }
  };
  const local = await studio('local', transport);
  async function connect(target = local, scopeIds = ['business']) {
    const pair = await remote.devices.mutate('pair', { name: 'Local studio', scopeIds, capabilities: ['sync'] });
    await target.service.mutate('connect', { url: remoteOrigin, code: pair.code });
    await target.service.mutate('configure', { scopeIds });
  }
  const add = async (side, title, extra) => (await side.workspace.mutate('saveMemory', note(title, extra))).memories.find(item => item.title === title);
  const edit = async (side, id, content) => {
    const existing = (await side.workspace.getSnapshot()).memories.find(item => item.id === id);
    return side.workspace.mutate('saveMemory', { id, expectedVersion: existing.version, content });
  };
  return { local, remote, requests, connect, add, edit, studio: name => studio(name, transport), onResponse(callback) { afterExchange = callback; } };
}

test('three-way merge distinguishes independent edits, matching edits, conflicting edits and deletion', () => {
  const base = field('base'), ours = field('ours'), theirs = field('theirs'), bases = { [key]: recordHash(base) };
  assert.deepEqual(mergeRecords({ [key]: base }, { [key]: base }, bases, ['business']), { changes: [], conflicts: [] });
  const pushed = mergeRecords({ [key]: ours }, { [key]: base }, bases, ['business']);
  assert.equal(pushed.changes[0].record.title, 'ours');
  assert.equal(pushed.changes[0].expectedHash, recordHash(base));
  assert.deepEqual(mergeRecords({ [key]: base }, { [key]: theirs }, bases, ['business']), { changes: [], conflicts: [] });
  assert.equal(mergeRecords({ [key]: ours }, { [key]: theirs }, bases, ['business']).conflicts.length, 1);
  assert.equal(mergeRecords({ [key]: ours }, { [key]: ours }, bases, ['business']).conflicts.length, 0);
  const removed = mergeRecords({}, { [key]: base }, bases, ['business'], { local: [deletion] });
  assert.equal(removed.changes[0].record, null);
  const conflict = mergeRecords({}, { [key]: theirs }, bases, ['business'], { local: [deletion] }).conflicts[0];
  assert.equal(conflict.localDeleted, true);
  assert.equal(conflict.remote.title, 'theirs');
  const oldPeer = mergeRecords({ [key]: base }, {}, {}, ['business'], { remote: [deletion] });
  assert.equal(oldPeer.changes.length, 0);
  assert.equal(oldPeer.conflicts[0].remoteDeleted, true);
  assert.equal(mergeRecords({}, {}, {}, ['business'], { local: [deletion] }).changes[0].record, null);
});

test('sync hashes ignore local grants and revision metadata while input identity and scope remain strict', () => {
  const original = field('same', { sharedWith: ['personal'], version: 22, createdAt: 'one', revisions: [{ sensitive: true }] });
  assert.equal(recordHash(original), recordHash(field('same', { sharedWith: [], version: 1, createdAt: 'two' })));
  assert.deepEqual(syncRecord(original).sharedWith, []);
  assert.equal(syncRecord(original).revisions, undefined);
  assert.throws(() => mergeRecords({ [key]: field('mismatch', { id: 'different' }) }, {}, {}, ['business']));
  assert.throws(() => mergeRecords({ [key]: field('private') }, {}, {}, ['personal']), { statusCode: 403 });
  assert.throws(() => mergeRecords({}, {}, { [key]: 'untrusted base' }, ['business']));
  assert.throws(() => mergeRecords({}, {}, {}, ['business'], { remote: [{ ...deletion, scopeId: 'personal' }] }), { statusCode: 403 });
  assert.throws(() => mergeRecords({ [key]: field('inconsistent') }, {}, {}, ['business'], { local: [deletion] }), { statusCode: 409 });
});

test('transport rejects insecure origins and oversized or malformed responses without exposing remote error details', async () => {
  for (const bad of ['http://studio.example.com', `${remoteOrigin}/subpath`, `${remoteOrigin}?token=secret`, 'https://user:pass@studio.example.com', `${remoteOrigin}#fragment`]) assert.throws(() => trustedOrigin(bad));
  assert.equal(trustedOrigin(`${remoteOrigin}/`), remoteOrigin);
  const request = fetchImpl => deviceRequest(remoteOrigin, '/api/device/sync', {}, 'private-token', fetchImpl);
  await assert.rejects(request(async (_url, init) => { assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, 'Bearer private-token'); return new Response('invalid json'); }), /non valida/);
  await assert.rejects(request(async () => new Response('x', { headers: { 'content-length': String(9 * 1024 * 1024) } })), { statusCode: 502 });
  await assert.rejects(request(async () => new Response('x'.repeat(8 * 1024 * 1024 + 1))), { statusCode: 502 });
  await assert.rejects(request(async () => new Response(JSON.stringify({ error: 'PRIVATE ACCESS TOKEN' }), { status: 401 })), error => error.statusCode === 401 && !error.message.includes('PRIVATE'));
});

test('two encrypted studio archives merge only selected scopes and propagate edits and deletions', async t => {
  const f = await fixture(t);
  const ours = await f.add(f.local, 'Local note', { sharedWith: ['personal'] });
  const theirs = await f.add(f.remote, 'Remote note');
  await f.add(f.local, 'Private personal data', { scopeId: 'personal' });
  await f.connect();
  const initial = await f.local.service.run();
  assert.equal(initial.running, false);
  assert.equal(initial.conflicts.length, 0);
  assert.equal(initial.link.error, null);
  assert.doesNotMatch(JSON.stringify(initial), /"token"/);
  const local = await f.local.workspace.getSnapshot(), remote = await f.remote.workspace.getSnapshot();
  assert.deepEqual(local.memories.find(item => item.id === ours.id).sharedWith, ['personal']);
  assert.deepEqual(remote.memories.find(item => item.id === ours.id).sharedWith, []);
  assert.ok(local.memories.some(item => item.id === theirs.id));
  assert.equal(remote.memories.some(item => item.scopeId === 'personal'), false);
  assert.equal(JSON.stringify(f.requests).includes('Private personal data'), false);
  await f.edit(f.local, ours.id, 'New local decision.');
  await f.local.service.run();
  assert.equal((await f.remote.workspace.getSnapshot()).memories.find(item => item.id === ours.id).content, 'New local decision.');
  await f.remote.workspace.mutate('deleteMemory', { id: theirs.id });
  await f.local.service.run();
  assert.equal((await f.local.workspace.getSnapshot()).memories.some(item => item.id === theirs.id), false);
  assert.ok((await f.local.workspace.exportSync(['business'])).tombstones.some(item => item.id === theirs.id));
  await f.local.service.run();
  assert.equal((await f.remote.workspace.getSnapshot()).memories.some(item => item.id === theirs.id), false);
});

test('concurrent edits produce stable versioned conflicts and stale conflict decisions are refused', async t => {
  const f = await fixture(t), memory = await f.add(f.local, 'Shared note');
  await f.connect(); await f.local.service.run();
  await f.edit(f.local, memory.id, 'Local changed statement.');
  await f.edit(f.remote, memory.id, 'Remote changed statement.');
  const conflict = (await f.local.service.run()).conflicts[0];
  assert.equal(conflict.local.content, 'Local changed statement.');
  assert.equal(conflict.remote.content, 'Remote changed statement.');
  assert.equal((await f.local.service.run()).conflicts[0].version, conflict.version);
  await f.edit(f.local, memory.id, 'Local changed a second time.');
  await assert.rejects(f.local.service.mutate('resolve', { id: conflict.id, expectedVersion: conflict.version, choice: 'remote' }), { statusCode: 409 });
  const newer = (await f.local.service.run()).conflicts[0];
  assert.equal(newer.version, conflict.version + 1);
  await assert.rejects(f.local.service.mutate('resolve', { id: newer.id, expectedVersion: conflict.version, choice: 'remote' }), { statusCode: 409 });
  await f.local.service.mutate('resolve', { id: newer.id, expectedVersion: newer.version, choice: 'local' });
  await f.local.service.run();
  assert.equal((await f.remote.workspace.getSnapshot()).memories.find(item => item.id === memory.id).content, 'Local changed a second time.');
  assert.equal((await f.local.service.snapshot()).conflicts.length, 0);
});

test('local edits made during a network round trip become conflicts instead of being overwritten', async t => {
  const f = await fixture(t), memory = await f.add(f.local, 'During network');
  await f.connect(); await f.local.service.run();
  await f.edit(f.remote, memory.id, 'Remote edit before request.');
  f.onResponse(() => f.edit(f.local, memory.id, 'Local edit during the request.'));
  const result = await f.local.service.run();
  assert.equal(result.conflicts.length, 1);
  assert.equal((await f.local.workspace.getSnapshot()).memories.find(item => item.id === memory.id).content, 'Local edit during the request.');
  assert.equal(result.conflicts[0].remote.content, 'Remote edit before request.');
});

test('a deletion during the network round trip is reflected in the conflict and cannot be restored in place', async t => {
  const f = await fixture(t), memory = await f.add(f.local, 'Deleted during network');
  await f.connect(); await f.local.service.run();
  await f.edit(f.remote, memory.id, 'Concurrent remote edit.');
  f.onResponse(() => f.local.workspace.mutate('deleteMemory', { id: memory.id }));
  const conflict = (await f.local.service.run()).conflicts[0];
  assert.equal(conflict.localDeleted, true);
  assert.equal(conflict.remote.content, 'Concurrent remote edit.');
  await assert.rejects(f.local.service.mutate('resolve', { id: conflict.id, expectedVersion: conflict.version, choice: 'remote' }), { statusCode: 409 });
  assert.equal((await f.local.workspace.getSnapshot()).memories.some(item => item.id === memory.id), false);
});

test('delete-versus-edit conflicts preserve the surviving text and cannot resurrect the deleted identity', async t => {
  for (const deletingSide of ['local', 'remote']) {
    const f = await fixture(t), memory = await f.add(f.local, `Delete conflict ${deletingSide}`);
    await f.connect(); await f.local.service.run();
    const editingSide = deletingSide === 'local' ? 'remote' : 'local';
    await f[deletingSide].workspace.mutate('deleteMemory', { id: memory.id });
    await f.edit(f[editingSide], memory.id, 'Concurrent surviving edit.');
    const conflict = (await f.local.service.run()).conflicts[0];
    assert.equal(conflict[`${deletingSide}Deleted`], true);
    assert.equal(conflict[editingSide].content, 'Concurrent surviving edit.');
    await assert.rejects(f.local.service.mutate('resolve', { id: conflict.id, expectedVersion: conflict.version, choice: editingSide }), { statusCode: 409 });
    await f.local.service.mutate('resolve', { id: conflict.id, expectedVersion: conflict.version, choice: deletingSide });
    await f.local.service.run();
    for (const side of [f.local, f.remote]) assert.equal((await side.workspace.getSnapshot()).memories.some(item => item.id === memory.id), false);
  }
});

test('a new peer receives deletion tombstones and an old copy cannot silently restore forgotten records', async t => {
  const f = await fixture(t), memory = await f.add(f.local, 'Forgotten record');
  await f.connect(); await f.local.service.run();
  await f.remote.workspace.mutate('deleteMemory', { id: memory.id });
  const stale = await f.studio('stale-copy');
  await stale.workspace.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: memory.id, record: syncRecord(memory), expectedHash: null }] });
  await f.connect(stale);
  const conflict = (await stale.service.run()).conflicts[0];
  assert.equal(conflict.remoteDeleted, true);
  assert.equal((await f.remote.workspace.getSnapshot()).memories.some(item => item.id === memory.id), false);
  await assert.rejects(stale.service.mutate('resolve', { id: conflict.id, expectedVersion: conflict.version, choice: 'local' }), { statusCode: 409 });
  await stale.service.mutate('resolve', { id: conflict.id, expectedVersion: conflict.version, choice: 'remote' });
  const fresh = await f.studio('fresh-copy'); await f.connect(fresh); await fresh.service.run();
  assert.ok((await fresh.workspace.exportSync(['business'])).tombstones.some(item => item.id === memory.id));
  await assert.rejects(fresh.workspace.applySync({ scopeIds: ['business'], changes: [{ collection: 'memories', scopeId: 'business', id: memory.id, record: syncRecord(memory), expectedHash: null }] }), { code: 'SYNC_DELETED' });
});

test('sync imports an authorized new project scope and rejects wrong-scope data or revoked devices', async t => {
  const f = await fixture(t);
  const created = await f.remote.workspace.mutate('createScope', { name: 'Remote-owned product', kind: 'project', parentId: 'business' });
  const project = created.scopes.find(item => item.name === 'Remote-owned product');
  const memory = await f.add(f.remote, 'Project decision', { scopeId: project.id });
  await f.connect(f.local, [project.id]); await f.local.service.run();
  assert.ok((await f.local.workspace.getSnapshot()).scopes.some(item => item.id === project.id));
  assert.ok((await f.local.workspace.getSnapshot()).memories.some(item => item.id === memory.id));
  const state = await f.local.archive.read('sync');
  await assert.rejects(f.remote.service.exchange(state.link.token, { scopeIds: ['personal'], records: {}, bases: {}, scopes: [], tombstones: [] }), { statusCode: 403 });
  await assert.rejects(f.remote.service.exchange(state.link.token, { scopeIds: [project.id], records: { [key]: field('private') }, bases: {}, scopes: [], tombstones: [] }), { statusCode: 403 });
  await f.remote.devices.mutate('revoke', { id: state.link.deviceId });
  await assert.rejects(f.local.service.run(), { statusCode: 401 });
  assert.match((await f.local.service.snapshot()).link.error, /non completata/);
  assert.equal((await f.local.workspace.getSnapshot()).memories.find(item => item.id === memory.id).content, memory.content);
});

test('manual sync is opt-in and rejects overlapping runs and changes to the connection', async t => {
  const f = await fixture(t);
  await assert.rejects(f.local.service.run(), /Collega/);
  const pair = await f.remote.devices.mutate('pair', { name: 'Manual only', scopeIds: ['business'], capabilities: ['sync'] });
  const linked = await f.local.service.mutate('connect', { url: remoteOrigin, code: pair.code });
  assert.deepEqual(linked.enabledScopeIds, []);
  const requestCount = f.requests.length;
  await f.local.service.run();
  assert.equal(f.requests.length, requestCount);
  await assert.rejects(f.local.service.mutate('configure', { scopeIds: ['personal'] }));
  await f.local.service.mutate('configure', { scopeIds: ['business'] });
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.onResponse(async () => { entered(); await new Promise(resolve => { release = resolve; }); });
  const pending = f.local.service.run(); await started;
  await assert.rejects(f.local.service.run(), { statusCode: 409 });
  await assert.rejects(f.local.service.mutate('disconnect'), { statusCode: 409 });
  release(); await pending;
  const disconnected = await f.local.service.mutate('disconnect');
  assert.equal(disconnected.link, null);
  assert.deepEqual(disconnected.enabledScopeIds, []);
});
