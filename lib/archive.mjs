import { DatabaseSync, backup } from 'node:sqlite';
import { randomBytes, createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fail = (message, code = 'ARCHIVE_ERROR', status = 503) => Object.assign(Error(message), { code, status, statusCode: status });
const clone = value => value === undefined ? undefined : structuredClone(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const validKey = key => { if (typeof key !== 'string' || !/^[a-zA-Z0-9_./:-]{1,200}$/.test(key)) throw fail('Chiave archivio non valida.'); return key; };

// The database contains authenticated ciphertext, including migration backups. The
// deployment key is intentionally not in SQLite and must be backed up separately.
export function createArchive({ directory, masterKey = process.env.FUORI_STUDIO_MASTER_KEY, mode = process.env.FUORI_STUDIO_MODE || 'local' } = {}) {
  const folder = resolve(directory), filename = resolve(folder, 'studio.sqlite');
  let db, encryptionKey, initializing, queue = Promise.resolve();
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function regular(path, missing = false) {
    try { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw fail('Archivio o chiave non sono file regolari.'); return info; }
    catch (error) { if (missing && error.code === 'ENOENT') return null; throw error; }
  }
  async function removeMigratedFile(path, originalInfo, originalBytes) {
    const currentInfo = await regular(path);
    if (['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(field => currentInfo[field] !== originalInfo[field]) || digest(await readFile(path)) !== digest(originalBytes)) throw fail('Il file precedente è cambiato durante la migrazione. Conserva entrambi gli archivi e verifica le modifiche.');
    await unlink(path);
  }
  async function init() {
    if (db) return;
    if (!initializing) initializing = (async () => {
      await mkdir(folder, { recursive: true, mode: 0o700 });
      const info = await lstat(folder);
      if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Directory archivio non valida.');
      await chmod(folder, 0o700);
      const exists = await regular(filename, true);
      if (masterKey) {
        if (!/^[A-Za-z0-9+/]{43}=$/.test(masterKey) || Buffer.from(masterKey, 'base64').length !== 32) throw fail('FUORI_STUDIO_MASTER_KEY deve contenere 32 byte in base64.');
        encryptionKey = Buffer.from(masterKey, 'base64');
      } else {
        if (mode !== 'local') throw fail('In modalità online/ibrida configura FUORI_STUDIO_MASTER_KEY attraverso il gestore dei segreti.');
        const path = resolve(folder, 'archive.key');
        let keyInfo = await regular(path, true);
        if (!keyInfo) {
          if (exists) throw fail('Chiave archivio mancante: ripristinala dal backup. Nessun dato è stato modificato.');
          const handle = await open(path, 'wx', 0o600);
          try { await handle.writeFile(randomBytes(32)); await handle.sync(); } finally { await handle.close(); }
          keyInfo = await regular(path);
        }
        if (keyInfo.size !== 32) throw fail('Chiave archivio non valida.');
        await chmod(path, 0o600); encryptionKey = await readFile(path);
      }
      for (const suffix of ['-wal', '-shm']) await regular(filename + suffix, true);
      // Precreate with restrictive permissions, including before SQLite opens it.
      if (!exists) { const handle = await open(filename, 'wx', 0o600); await handle.close(); }
      await chmod(filename, 0o600);
      const connection = new DatabaseSync(filename, { timeout: 5000, enableForeignKeyConstraints: true, allowExtension: false });
      try {
        connection.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
        const version = connection.prepare('PRAGMA user_version').get().user_version;
        if (version > 1) throw fail('Versione database più recente: aggiorna Fuori Studio.');
        if (!version) connection.exec('BEGIN IMMEDIATE; CREATE TABLE records (key TEXT PRIMARY KEY, revision INTEGER NOT NULL, value BLOB NOT NULL, updated_at TEXT NOT NULL) STRICT; PRAGMA user_version=1; COMMIT;');
        db = connection;
        const sentinel = readSync('system/key-check');
        if (sentinel && sentinel.marker !== 'fuori-studio-v1') throw fail('Chiave archivio errata.');
        if (!sentinel) writeSync('system/key-check', { marker: 'fuori-studio-v1' });
      } catch (error) { db = undefined; connection.close(); throw error; }
    })().catch(() => { throw fail('Impossibile aprire l’archivio cifrato. Verifica chiave, versione e integrità; i dati sono conservati.'); });
    await initializing;
  }
  function encode(key, revision, value) {
    const raw = JSON.stringify(value);
    if (raw === undefined || Buffer.byteLength(raw) > 32 * 1024 * 1024) throw fail('Record archivio troppo grande o non valido.');
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
    cipher.setAAD(Buffer.from(`${key}:${revision}`));
    const ciphertext = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
  }
  function readSync(key, fallback) {
    const row = db.prepare('SELECT revision,value FROM records WHERE key=?').get(validKey(key));
    if (!row) return clone(fallback);
    try {
      const data = Buffer.from(row.value), decipher = createDecipheriv('aes-256-gcm', encryptionKey, data.subarray(0, 12));
      decipher.setAAD(Buffer.from(`${key}:${row.revision}`)); decipher.setAuthTag(data.subarray(12, 28));
      return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8'));
    } catch { throw fail('Il record cifrato non è leggibile. Nessun dato è stato sostituito.', 'ARCHIVE_CORRUPT'); }
  }
  function writeSync(key, value, expectedRevision) {
    validKey(key);
    const revision = db.prepare('SELECT revision FROM records WHERE key=?').get(key)?.revision || 0;
    if (expectedRevision !== undefined && revision !== expectedRevision) throw fail('Archivio aggiornato da un’altra operazione. Ricarica.', 'VERSION_CONFLICT', 409);
    // Do not silently replace a damaged record, even when a caller has cached
    // an older in-memory snapshot of that record.
    if (revision) readSync(key);
    db.prepare('INSERT INTO records(key,revision,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET revision=excluded.revision,value=excluded.value,updated_at=excluded.updated_at').run(key, revision + 1, encode(key, revision + 1, value), new Date().toISOString());
    return revision + 1;
  }
  function transactionSync(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return {
    init,
    info: () => ({ type: 'sqlite', encrypted: true, keySource: masterKey ? 'environment' : 'local-file' }),
    read: (key, fallback) => serial(async () => { await init(); return readSync(key, fallback); }),
    write: (key, value, expectedRevision) => serial(async () => { await init(); return transactionSync(() => writeSync(key, value, expectedRevision)); }),
    batch: entries => serial(async () => { await init(); return transactionSync(() => entries.map(({ key, value, expectedRevision }) => writeSync(key, value, expectedRevision))); }),
    update: (key, fn, fallback) => serial(async () => {
      await init(); return transactionSync(() => {
        const previous = readSync(key, fallback), before = JSON.stringify(previous);
        const value = fn(previous);
        if (value?.then) throw fail('Le transazioni devono essere sincrone.');
        // Presence checks and waiting jobs must not rewrite encrypted prompts on
        // every poll. A changed value still commits within this transaction.
        if (JSON.stringify(value) !== before || !db.prepare('SELECT 1 FROM records WHERE key=?').get(validKey(key))) writeSync(key, value);
        return clone(value);
      });
    }),
    load: (key, legacyFile, seed, validate = value => value) => serial(async () => {
      await init();
      const existing = readSync(key);
      const migrationKey = `migration/${digest(legacyFile)}`;
      const info = await regular(legacyFile, true);
      if (existing !== undefined) {
        const validated = validate(existing);
        // Finish a migration interrupted after the durable commit, but never remove
        // a legacy file changed by another application in the meantime.
        if (info) {
          const migration = readSync(migrationKey);
          const raw = await readFile(legacyFile);
          if (!migration || digest(raw) !== migration.digest) throw fail('Archivio JSON e database divergenti: conserva entrambi e risolvi la migrazione.');
          await removeMigratedFile(legacyFile, info, raw);
        }
        return validated;
      }
      let value, raw;
      if (info) {
        if (info.size > 32 * 1024 * 1024) throw fail('Archivio precedente troppo grande.');
        raw = await readFile(legacyFile);
        try { value = validate(JSON.parse(raw.toString('utf8'))); } catch { throw fail('Archivio precedente non valido. Il file originale è conservato.'); }
      } else {
        const initial = typeof seed === 'function' ? await seed() : clone(seed);
        if (initial === undefined) return undefined;
        value = validate(initial);
      }
      if (value === undefined) return undefined;
      transactionSync(() => {
        writeSync(key, value);
        if (raw) writeSync(migrationKey, { digest: digest(raw), original: raw.toString('utf8'), migratedAt: new Date().toISOString() });
      });
      if (raw) await removeMigratedFile(legacyFile, info, raw);
      return clone(value);
    }),
    backup: destination => serial(async () => {
      await init(); const path = resolve(destination);
      const handle = await open(path, 'wx', 0o600); await handle.close();
      await backup(db, path); await chmod(path, 0o600); return path;
    }),
    close: () => serial(async () => { if (db) { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); db = undefined; initializing = undefined; encryptionKey?.fill(0); } }),
  };
}

export const defaultArchive = createArchive({ directory: process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local') });
