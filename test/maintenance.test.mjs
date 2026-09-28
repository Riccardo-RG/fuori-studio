import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, symlink, unlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';
import { createMaintenance } from '../lib/maintenance.ts';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-maintenance-'));
  const archive = createArchive({ directory, mode: 'local', masterKey: undefined });
  await archive.write('workspace', { private: 'maintenance-secret' });
  t.after(async () => { await archive.close(); await rm(directory, { recursive: true, force: true }); });
  return { archive, directory, maintenance: createMaintenance({ archive, directory }) };
}
test('managed backup is verified, encrypted, privately stored and digest checked', async t => {
  const { archive, directory, maintenance } = await fixture(t);
  assert.deepEqual(await maintenance.snapshot(), { backups: [], lastVerification: null });
  const created = await maintenance.createBackup(), item = created.backups[0];
  assert.equal(item.records, 2); assert.match(item.sha256, /^[a-f0-9]{64}$/);
  const file = await maintenance.backupFile({ id: item.id });
  assert.equal(file.sha256, item.sha256); assert.equal(file.bytes, item.bytes);
  assert.equal((await readFile(file.path)).includes(Buffer.from('maintenance-secret')), false);
  assert.equal((await stat(join(directory, 'backups'))).mode & 0o777, 0o700);
  assert.equal((await stat(file.path)).mode & 0o777, 0o600);
  const verified = await maintenance.verify();
  assert.equal(verified.verification.ok, true);
  assert.deepEqual(verified.snapshot.lastVerification, verified.verification);
  await archive.close();
  assert.deepEqual((await maintenance.snapshot()).backups[0], item);
  await writeFile(file.path, Buffer.alloc(item.bytes));
  await assert.rejects(maintenance.backupFile({ id: item.id }), { code: 'BACKUP_DIGEST_MISMATCH' });
  assert.equal((await maintenance.removeBackup({ id: item.id })).backups.length, 0);
  await assert.rejects(stat(file.path), { code: 'ENOENT' });
});
test('download and removal refuse unregistered paths, symlinks and replaced backup folders', async t => {
  const { directory, maintenance } = await fixture(t);
  const item = (await maintenance.createBackup()).backups[0], path = join(directory, 'backups', item.filename);
  await assert.rejects(maintenance.backupFile({ id: '../archive.key' }));
  await assert.rejects(maintenance.removeBackup({ id: 'b6b6b6b6-0000-4000-8000-111111111111' }), { code: 'BACKUP_NOT_FOUND' });
  await unlink(path); await symlink(join(directory, 'archive.key'), path);
  await assert.rejects(maintenance.backupFile({ id: item.id }), { code: 'MAINTENANCE_PATH_DENIED' });
  await assert.rejects(maintenance.removeBackup({ id: item.id }), { code: 'MAINTENANCE_PATH_DENIED' });
  await unlink(path);
  assert.equal((await maintenance.removeBackup({ id: item.id })).backups.length, 0);
  await rm(join(directory, 'backups'), { recursive: true });
  await symlink(directory, join(directory, 'backups'));
  await assert.rejects(maintenance.createBackup(), { code: 'MAINTENANCE_PATH_DENIED' });
});
test('failed verification never registers a backup; concurrent requests serialize and capacity does not delete', async t => {
  const { archive, directory, maintenance } = await fixture(t);
  const bad = createMaintenance({ archive: { ...archive, verifyBackup: async () => { throw Error('verification failed'); } }, directory });
  await assert.rejects(bad.createBackup(), /verification failed/);
  assert.equal((await maintenance.snapshot()).backups.length, 0);
  await Promise.all([maintenance.createBackup(), maintenance.createBackup()]);
  const state = await archive.read('maintenance');
  assert.equal(state.backups.length, 2);
  for (let i = 2; i < 30; i++) { const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`; state.backups.push({ ...state.backups[0], id, filename: `studio-${id}.sqlite` }); }
  await archive.write('maintenance', state);
  await assert.rejects(maintenance.createBackup(), { code: 'BACKUP_CAPACITY' });
  assert.equal((await maintenance.snapshot()).backups.length, 30);
  const file = await maintenance.backupFile({ id: state.backups[0].id });
  assert.equal((await stat(file.path)).size, file.bytes);
});
