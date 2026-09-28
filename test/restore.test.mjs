import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir, stat, symlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';
import { restoreArchive } from '../scripts/restore.mjs';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'fuori-restore-')), source = join(root, 'original');
  const archive = createArchive({ directory: source, mode: 'local', masterKey: undefined });
  await archive.write('workspace', { memory: 'restore-me' });
  await archive.batch([
    { key: 'identity', value: { version: 1, generation: 4, sessions: [{ tokenHash: 'old-session' }], flows: [{ token: 'old-flow' }] } },
    { key: 'devices', value: { version: 1, devices: [{ tokenHash: 'old-device' }], jobs: [{}], pairings: [{}], target: 'old-device' } },
    { key: 'repository-devices', value: { version: 1, inventories: [{}], jobs: [{}] } },
    { key: 'repository-worker', value: { version: 1, policies: [{}], journal: [{}] } },
    { key: 'connection', value: { token: 'old-connection' } },
    { key: 'sync', value: { link: { token: 'old-sync' } } },
    { key: 'maintenance', value: { backups: [{}] } },
    { key: 'portability/pending', value: [{ id: 'preview-id', expiresAt: Date.now() + 86400000 }] },
    { key: 'portability/import/preview-id', value: { status: 'pending', records: [] } },
    { key: 'governance', value: { version: 1, settings: { version: 2, autonomousRoutines: true, autonomousEnabledAt: new Date().toISOString() }, usages: [{ status: 'succeeded' }] } },
    { key: 'operations', value: { tasks: [{ status: 'running', executionId: 'recover-on-start' }], routines: [{ version: 3, enabled: true }] } },
  ]);
  const backup = join(root, 'backup.sqlite'); await archive.backup(backup);
  t.after(async () => { await archive.close(); await rm(root, { recursive: true, force: true }); });
  return { root, archive, source, backup, keyFile: join(source, 'archive.key') };
}
test('restore preserves work but invalidates old sessions, leases, synchronization and autonomy', async t => {
  const { root, archive, backup, keyFile } = await fixture(t), into = join(root, 'restored');
  const originalBackup = await readFile(backup);
  const result = await restoreArchive({ backup, into, keyFile, env: {} });
  assert.equal(result.ok, true); assert.equal(result.accessReset, true);
  const restored = createArchive({ directory: into, mode: 'local', masterKey: undefined });
  t.after(() => restored.close());
  assert.deepEqual(await restored.read('workspace'), { memory: 'restore-me' });
  assert.deepEqual(await restored.read('identity'), { version: 1, generation: 5, sessions: [], flows: [] });
  assert.deepEqual((await restored.read('devices')).devices, []);
  assert.deepEqual((await restored.read('repository-devices')).jobs, []);
  assert.deepEqual((await restored.read('repository-worker')).policies, []);
  assert.equal(await restored.read('connection'), null);
  assert.equal((await restored.read('sync')).link, null);
  assert.deepEqual((await restored.read('maintenance')).backups, []);
  assert.equal((await restored.read('portability/import/preview-id')).status, 'expired');
  assert.equal((await restored.read('governance')).settings.autonomousRoutines, false);
  assert.equal((await restored.read('operations')).routines[0].enabled, false);
  assert.equal((await restored.read('operations')).tasks[0].status, 'running');
  assert.equal((await archive.read('identity')).sessions[0].tokenHash, 'old-session');
  assert.deepEqual(await readFile(backup), originalBackup);
  assert.deepEqual(await readFile(join(into, 'archive.key')), await readFile(keyFile));
  assert.equal((await stat(into)).mode & 0o777, 0o700);
  assert.equal((await stat(join(into, 'studio.sqlite'))).mode & 0o777, 0o600);
});
test('wrong keys, corrupt backups, symlinks and existing destinations are refused without overwrite', async t => {
  const { root, source, backup, keyFile } = await fixture(t);
  const into = join(root, 'bad-key');
  await assert.rejects(restoreArchive({ backup, into, env: { FUORI_STUDIO_MASTER_KEY: randomBytes(32).toString('base64') } }), { code: 'ARCHIVE_VERIFY_FAILED' });
  await assert.rejects(stat(into), { code: 'ENOENT' });
  const damaged = join(root, 'bad.sqlite'); await writeFile(damaged, randomBytes(1024));
  await assert.rejects(restoreArchive({ backup: damaged, into, keyFile, env: {} }), { code: 'ARCHIVE_VERIFY_FAILED' });
  const empty = join(root, 'existing-empty'); await mkdir(empty);
  await assert.rejects(restoreArchive({ backup, into: empty, keyFile, env: {} }), /esiste già/);
  const release = await acquireInstanceLock(source);
  try { await assert.rejects(restoreArchive({ backup, into: source, keyFile, env: {} }), /esiste già/); } finally { await release(); }
  const linked = join(root, 'linked.sqlite'); await symlink(backup, linked);
  await assert.rejects(restoreArchive({ backup: linked, into, keyFile, env: {} }), { code: 'ARCHIVE_VERIFY_FAILED' });
  await assert.rejects(restoreArchive({ backup, into, keyFile, env: { FUORI_STUDIO_MASTER_KEY: randomBytes(32).toString('base64') } }), /non entrambi/);
});
test('external secret file restores without writing a local key and rejects ambiguous secret configuration', async t => {
  const { root, backup, keyFile } = await fixture(t), into = join(root, 'external'), secret = join(root, 'master-key');
  await writeFile(secret, (await readFile(keyFile)).toString('base64') + '\n');
  const env = { FUORI_STUDIO_MASTER_KEY_FILE: secret };
  await restoreArchive({ backup, into, env });
  await assert.rejects(stat(join(into, 'archive.key')), { code: 'ENOENT' });
  const restored = createArchive({ directory: into, mode: 'online', masterKey: env.FUORI_STUDIO_MASTER_KEY });
  t.after(() => restored.close());
  assert.equal((await restored.read('workspace')).memory, 'restore-me');
  await assert.rejects(restoreArchive({ backup, into: join(root, 'ambiguous'), env: { FUORI_STUDIO_MASTER_KEY_FILE: secret, FUORI_STUDIO_MASTER_KEY: env.FUORI_STUDIO_MASTER_KEY } }), /Configura solo/);
});

test('a failure during access reset leaves the destination locked and the source intact', async t => {
  const { root, archive, keyFile } = await fixture(t), backup = join(root, 'invalid-settings.sqlite'), into = join(root, 'incomplete');
  await archive.write('governance', { settings: null });
  await archive.backup(backup);
  await assert.rejects(restoreArchive({ backup, into, keyFile, env: {} }), /Configurazione autonomia non valida/);
  await assert.rejects(acquireInstanceLock(into), /Un altro server/);
  assert.equal((await stat(join(into, 'server.lock'))).isFile(), true);
  assert.equal((await archive.read('identity')).sessions[0].tokenHash, 'old-session');
});
