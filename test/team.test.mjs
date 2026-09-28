import test from 'node:test';
import assert from 'node:assert/strict';
import { createTeamStore } from '../lib/team.ts';
import { agents } from '../dist/data.js';

const defaults = { nova: 'Riccardo', radar: 'Raffaele', forge: 'Big Fonz', muse: "D'albenzio", growth: 'Cicciolina' };
function storageFixture() {
  const records = new Map(); let failNext = false;
  const storage = {
    read: async (key, fallback) => structuredClone(records.has(key) ? records.get(key) : fallback),
    write: async (key, value) => {
      if (failNext) { failNext = false; throw Error('Fixture disk write failure'); }
      records.set(key, structuredClone(value)); return structuredClone(value);
    },
  };
  return { storage, records, failWrite() { failNext = true; } };
}

test('team defaults and renamed profiles persist across store recreation without changing stable IDs or global agents', async () => {
  const f = storageFixture(), team = createTeamStore({ storage: f.storage });
  const globalBefore = agents.map(({ id, name }) => ({ id, name }));
  const initial = await team.snapshot(); assert.deepEqual(initial, { version: 1, names: defaults });
  const next = await team.rename({ id: 'radar', name: '  Andre\u0301  ', expectedVersion: 1 });
  assert.deepEqual(next, { version: 2, names: { ...defaults, radar: 'André' } });
  assert.deepEqual(f.records.get('team-profiles'), { schemaVersion: 1, version: 2, names: next.names });
  assert.deepEqual(await createTeamStore({ storage: f.storage }).snapshot(), next);
  assert.deepEqual(await team.rename({ id: 'radar', name: 'André', expectedVersion: next.version }), next);
  assert.deepEqual(agents.map(({ id, name }) => ({ id, name })), globalBefore);
  next.names.nova = 'Caller mutation'; initial.names.forge = 'Caller mutation';
  assert.equal((await team.snapshot()).names.nova, defaults.nova);
  assert.equal((await team.snapshot()).names.forge, defaults.forge);
});

test('team names validate length, normalized duplicates, control characters, IDs and strict payloads', async () => {
  const f = storageFixture(), team = createTeamStore({ storage: f.storage });
  await team.snapshot();
  const invalid = [
    { name: '' }, { name: '   ' }, { name: 'x'.repeat(61) }, { name: 123 }, { name: null },
    { name: ' RICCARDO ' }, { name: 'One\nTwo' }, { name: 'One\tTwo' }, { name: 'One\u0000Two' },
    { name: 'One\u007fTwo' }, { name: 'One\u202eTwo' }, { name: 'One\u2066Two' },
    { id: 'missing' }, { id: '__proto__' }, { id: 'constructor' }, { id: '' },
    { expectedVersion: 0 }, { expectedVersion: '1' }, { expectedVersion: 1.5 },
    { extra: true }, { names: { forge: 'Unexpected mass update' } },
  ];
  for (const fields of invalid) {
    await assert.rejects(() => team.rename({ id: 'radar', name: 'Valid name', expectedVersion: 1, ...fields }), error => error.statusCode === 400 || error.status === 400, JSON.stringify(fields));
    assert.deepEqual(await team.snapshot(), { version: 1, names: defaults });
  }
  for (const payload of [null, [], 'radar']) await assert.rejects(() => team.rename(payload));
  const long = await team.rename({ id: 'forge', name: 'x'.repeat(60), expectedVersion: 1 });
  assert.equal(long.names.forge.length, 60);
  const accented = await team.rename({ id: 'radar', name: 'André', expectedVersion: long.version });
  await assert.rejects(() => team.rename({ id: 'muse', name: 'ANDRE\u0301', expectedVersion: accented.version }), error => error.statusCode === 400 || error.status === 400);
  assert.equal((await team.snapshot()).names.muse, defaults.muse);
});

test('concurrent renames from one version produce one durable winner and one conflict', async () => {
  const f = storageFixture(), team = createTeamStore({ storage: f.storage });
  const initial = await team.snapshot();
  const results = await Promise.allSettled([
    team.rename({ id: 'radar', name: 'Researcher', expectedVersion: initial.version }),
    team.rename({ id: 'forge', name: 'Developer', expectedVersion: initial.version }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected');
  assert.equal(rejected.reason.code, 'TEAM_CONFLICT'); assert.equal(rejected.reason.statusCode ?? rejected.reason.status, 409);
  const winner = results.find(result => result.status === 'fulfilled').value;
  assert.deepEqual(await team.snapshot(), winner); assert.equal(winner.version, 2);
  assert.deepEqual(await createTeamStore({ storage: f.storage }).snapshot(), winner);
});

test('failed team persistence leaves both memory and archive unchanged and the queue can recover', async () => {
  const f = storageFixture(), team = createTeamStore({ storage: f.storage });
  const before = await team.rename({ id: 'nova', name: 'Leader', expectedVersion: 1 });
  const stored = structuredClone(f.records.get('team-profiles'));
  f.failWrite();
  await assert.rejects(() => team.rename({ id: 'forge', name: 'Developer', expectedVersion: before.version }), /Fixture disk write failure/);
  assert.deepEqual(await team.snapshot(), before); assert.deepEqual(f.records.get('team-profiles'), stored);
  const recovered = await team.rename({ id: 'forge', name: 'Developer', expectedVersion: before.version });
  assert.equal(recovered.version, before.version + 1); assert.equal(recovered.names.forge, 'Developer');
});

test('corrupt team profiles fail closed instead of silently overwriting saved names', async () => {
  for (const record of [
    { schemaVersion: 2, version: 1, names: defaults },
    { schemaVersion: 1, version: 0, names: defaults },
    { schemaVersion: 1, version: 1, names: { nova: 'Only one profile' } },
    { schemaVersion: 1, version: 1, names: { ...defaults, radar: defaults.nova } },
    { schemaVersion: 1, version: 1, names: { ...defaults, unknown: 'Unknown' } },
  ]) {
    const f = storageFixture(); f.records.set('team-profiles', structuredClone(record));
    const team = createTeamStore({ storage: f.storage });
    await assert.rejects(() => team.snapshot(), error => (error.statusCode ?? error.status) === 503);
    assert.deepEqual(f.records.get('team-profiles'), record);
  }
});
