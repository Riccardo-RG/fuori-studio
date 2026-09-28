import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, rm, unlink, symlink, mkdir, copyFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-archive-'));
  const archive = createArchive({ directory, mode: 'local', masterKey: undefined, ...options });
  t.after(async () => { await archive.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, archive, database: join(directory, 'studio.sqlite') };
}

test('archive encrypts record values and creates private files', async t => {
  const { directory, archive, database } = await fixture(t);
  const payload = { secret: 'private-memory-never-in-sqlite-plaintext' };
  await archive.write('test/secrets', payload);
  assert.deepEqual(await archive.read('test/secrets'), payload);
  assert.deepEqual(await archive.read('unknown', { empty: true }), { empty: true });
  for (const file of [database, `${database}-wal`]) assert.equal((await readFile(file)).includes(Buffer.from(payload.secret)), false);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  assert.equal((await stat(database)).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, 'archive.key'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(directory, 'archive.key'))).length, 32);
  const copy = await archive.read('test/secrets'); copy.secret = 'modified';
  assert.equal((await archive.read('test/secrets')).secret, payload.secret);
});

test('revision conflicts and failed batches roll back without poisoning later work', async t => {
  const { archive } = await fixture(t);
  assert.equal(await archive.write('a', { n: 1 }, 0), 1);
  await assert.rejects(archive.batch([{ key: 'a', value: { n: 2 }, expectedRevision: 1 }, { key: 'b', value: { n: 2 }, expectedRevision: 4 }]), { code: 'VERSION_CONFLICT', statusCode: 409 });
  assert.deepEqual(await archive.read('a'), { n: 1 });
  assert.equal(await archive.read('b'), undefined);
  await assert.rejects(archive.update('a', async value => value), /sincrone/);
  const updates = await Promise.all(Array.from({ length: 12 }, () => archive.update('a', value => ({ n: value.n + 1 }))));
  assert.equal(updates.at(-1).n, 13);
  assert.deepEqual(await archive.read('a'), { n: 13 });
});

test('legacy migration commits encrypted backup before removing the original file', async t => {
  const { archive, directory } = await fixture(t);
  const file = join(directory, 'workspace.json'), raw = JSON.stringify({ version: 1, secret: 'original-value' });
  await writeFile(file, raw);
  const value = await archive.load('workspace', file, {}, candidate => { assert.equal(candidate.version, 1); return candidate; });
  assert.deepEqual(value, JSON.parse(raw));
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  const migration = await archive.read(`migration/${createHash('sha256').update(file).digest('hex')}`);
  assert.equal(migration.original, raw);
  assert.equal(migration.digest, createHash('sha256').update(raw).digest('hex'));
  await writeFile(file, raw);
  assert.deepEqual(await archive.load('workspace', file, {}), JSON.parse(raw));
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await writeFile(file, JSON.stringify({ changed: true }));
  await assert.rejects(archive.load('workspace', file, {}), /divergenti/);
  assert.deepEqual(JSON.parse(await readFile(file)), { changed: true });
});

test('invalid or concurrently changed legacy files remain recoverable', async t => {
  const { archive, directory } = await fixture(t);
  const invalid = join(directory, 'invalid.json');
  await writeFile(invalid, '{broken');
  await assert.rejects(archive.load('invalid', invalid, {}), /precedente non valido/);
  assert.equal(await readFile(invalid, 'utf8'), '{broken');
  assert.equal(await archive.read('invalid'), undefined);
  const changed = join(directory, 'changed.json');
  await writeFile(changed, '{"value":1}');
  await assert.rejects(archive.load('changed', changed, {}, value => { writeFileSync(changed, '{"value":2}'); return value; }), /cambiato durante/);
  assert.equal(await readFile(changed, 'utf8'), '{"value":2}');
  assert.deepEqual(await archive.read('changed'), { value: 1 });
  let validated = false;
  assert.equal(await archive.load('optional-missing', join(directory, 'missing.json'), undefined, () => { validated = true; throw Error('must not validate a missing optional record'); }), undefined);
  assert.equal(validated, false);
  assert.equal(await archive.read('optional-missing'), undefined);
});

test('ciphertext and authenticated record metadata tampering fail closed, including writes', async t => {
  const { archive, database } = await fixture(t);
  await archive.write('a', { private: 'alpha' });
  await archive.write('b', { private: 'beta' });
  const connection = new DatabaseSync(database);
  t.after(() => connection.close());
  const row = connection.prepare('SELECT value FROM records WHERE key=?').get('a');
  connection.prepare('UPDATE records SET value=? WHERE key=?').run(row.value, 'b');
  await assert.rejects(archive.read('b'), { code: 'ARCHIVE_CORRUPT' });
  await assert.rejects(archive.write('b', { replacement: 'must-not-write' }), { code: 'ARCHIVE_CORRUPT' });
  assert.deepEqual(await archive.read('a'), { private: 'alpha' });
  connection.prepare('UPDATE records SET revision=revision+1 WHERE key=?').run('a');
  await assert.rejects(archive.read('a'), { code: 'ARCHIVE_CORRUPT' });
});

test('missing keys, wrong keys, newer schemas and symlinks are refused', async t => {
  const { archive, directory, database } = await fixture(t);
  await archive.write('private', { value: 42 });
  await archive.close();
  const key = await readFile(join(directory, 'archive.key'));
  await unlink(join(directory, 'archive.key'));
  await assert.rejects(createArchive({ directory, mode: 'local', masterKey: undefined }).init(), /aprire l’archivio cifrato/);
  await writeFile(join(directory, 'archive.key'), key, { mode: 0o600 });
  await assert.rejects(createArchive({ directory, mode: 'online', masterKey: randomBytes(32).toString('base64') }).init(), /aprire l’archivio cifrato/);
  const connection = new DatabaseSync(database); connection.exec('PRAGMA user_version=2'); connection.close();
  await assert.rejects(createArchive({ directory, mode: 'local', masterKey: undefined }).init(), /aprire l’archivio cifrato/);
  const linked = join(directory, 'linked'); await symlink(database, linked);
  await assert.rejects(createArchive({ directory: linked, mode: 'local' }).init());
  const secondary = join(directory, 'secondary'); await mkdir(secondary); await symlink(join(directory, 'archive.key'), join(secondary, 'archive.key'));
  await assert.rejects(createArchive({ directory: secondary, mode: 'local' }).init(), /aprire l’archivio cifrato/);
});

test('remote archives require a deployment key and encrypted backups restore with that key', async t => {
  const masterKey = randomBytes(32).toString('base64');
  const { archive, directory } = await fixture(t, { mode: 'online', masterKey });
  await assert.rejects(createArchive({ directory: join(directory, 'missing'), mode: 'hybrid', masterKey: undefined }).init(), /aprire l’archivio cifrato/);
  await archive.write('workspace', { content: 'recoverable-secret' });
  const destination = join(directory, 'backup.sqlite');
  await archive.backup(destination);
  assert.equal((await stat(destination)).mode & 0o777, 0o600);
  assert.equal((await readFile(destination)).includes(Buffer.from('recoverable-secret')), false);
  await assert.rejects(archive.backup(destination), { code: 'EEXIST' });
  const restoredDirectory = join(directory, 'restored'); await mkdir(restoredDirectory);
  await copyFile(destination, join(restoredDirectory, 'studio.sqlite'));
  const restored = createArchive({ directory: restoredDirectory, mode: 'online', masterKey });
  t.after(() => restored.close());
  assert.deepEqual(await restored.read('workspace'), { content: 'recoverable-secret' });
});

test('verification authenticates every encrypted record and does not disclose plaintext', async t => {
  const { archive, database, directory } = await fixture(t);
  await archive.write('verified', { secret: 'never-return-this' });
  const live = await archive.verify();
  assert.deepEqual(Object.keys(live).sort(), ['ok', 'records', 'verifiedAt']);
  assert.equal(live.ok, true); assert.equal(live.records, 2);
  const backup = join(directory, 'verified.sqlite'); await archive.backup(backup);
  assert.equal((await archive.verifyBackup(backup)).records, 2);
  await writeFile(backup + '-wal', 'unexpected');
  await assert.rejects(archive.verifyBackup(backup), { code: 'ARCHIVE_VERIFY_FAILED' });
  await unlink(backup + '-wal');
  const damaged = new DatabaseSync(backup);
  damaged.prepare('UPDATE records SET revision=revision+1 WHERE key=?').run('verified'); damaged.close();
  await assert.rejects(archive.verifyBackup(backup), { code: 'ARCHIVE_VERIFY_FAILED' });
  assert.equal((await archive.verify()).ok, true);
  const connection = new DatabaseSync(database);
  connection.prepare('UPDATE records SET value=? WHERE key=?').run(Buffer.alloc(30), 'verified'); connection.close();
  await assert.rejects(archive.verify(), { code: 'ARCHIVE_VERIFY_FAILED' });
});
