import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';

export interface ArchiveVerification { ok: boolean; records: number; verifiedAt: string; }
export interface MaintenanceArchive {
  read(key: string, fallback?: unknown): Promise<unknown>;
  write(key: string, value: unknown): Promise<unknown>;
  backup(path: string): Promise<string>;
  verify(): Promise<ArchiveVerification>;
  verifyBackup(path: string): Promise<ArchiveVerification>;
}
export interface BackupMetadata { id: string; filename: string; createdAt: string; bytes: number; sha256: string; verifiedAt: string; records: number; }
export interface MaintenanceSnapshot { backups: BackupMetadata[]; lastVerification: ArchiveVerification | null; }
interface MaintenanceState extends MaintenanceSnapshot { version: 1; }
export interface MaintenanceOptions { archive: MaintenanceArchive; directory: string; now?: () => number; }
const KEY = 'maintenance', LIMIT = 30, UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const fail = (message: string, code = 'MAINTENANCE_INVALID', statusCode = 400) => Object.assign(Error(message), { code, statusCode });
const seed = (): MaintenanceState => ({ version: 1, backups: [], lastVerification: null });
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
function verification(value: unknown): value is ArchiveVerification { return record(value) && value.ok === true && Number.isSafeInteger(value.records) && Number(value.records) > 0 && date(value.verifiedAt); }
function validate(value: unknown): MaintenanceState {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.backups) || value.backups.length > LIMIT || value.lastVerification !== null && !verification(value.lastVerification)) throw fail('Registro backup non valido.', 'MAINTENANCE_CORRUPT', 503);
  const ids = new Set<string>();
  for (const item of value.backups) {
    if (!record(item) || typeof item.id !== 'string' || !UUID.test(item.id) || ids.has(item.id) || item.filename !== `studio-${item.id}.sqlite` || !date(item.createdAt) || !date(item.verifiedAt) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 512 || !Number.isSafeInteger(item.records) || Number(item.records) < 1 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw fail('Registro backup non valido.', 'MAINTENANCE_CORRUPT', 503);
    ids.add(item.id);
  }
  return structuredClone(value) as unknown as MaintenanceState;
}

/** Managed backups are encrypted SQLite snapshots. Their trusted digest is kept
 * in the encrypted live archive, never alongside the decryption key. */
export function createMaintenance({ archive, directory, now = Date.now }: MaintenanceOptions) {
  const root = resolve(directory), folder = resolve(root, 'backups');
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const load = async () => validate(await archive.read(KEY, seed()));
  const publicState = (state: MaintenanceState): MaintenanceSnapshot => structuredClone({ backups: state.backups, lastVerification: state.lastVerification });
  async function privateFolder() {
    const rootInfo = await lstat(root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw fail('Directory archivio non valida.', 'MAINTENANCE_PATH_DENIED', 503);
    await mkdir(folder, { mode: 0o700 });
  }
  async function ensureFolder() {
    await privateFolder().catch((error: unknown) => { if (!record(error) || error.code !== 'EEXIST') throw error; });
    const info = await lstat(folder);
    if (!info.isDirectory() || info.isSymbolicLink()) throw fail('Directory backup non valida.', 'MAINTENANCE_PATH_DENIED', 503);
    await chmod(folder, 0o700);
  }
  async function fingerprint(path: string) {
    const before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw fail('Backup non regolare.', 'MAINTENANCE_PATH_DENIED', 409);
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (info.dev !== before.dev || info.ino !== before.ino) throw fail('Backup cambiato durante la lettura.', 'MAINTENANCE_CHANGED', 409);
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
      const after = await handle.stat(), current = await lstat(path);
      if (['size', 'mtimeMs', 'ctimeMs'].some(field => after[field as 'size' | 'mtimeMs' | 'ctimeMs'] !== info[field as 'size' | 'mtimeMs' | 'ctimeMs']) || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) throw fail('Backup cambiato durante la lettura.', 'MAINTENANCE_CHANGED', 409);
      return { bytes: info.size, sha256: hash.digest('hex') };
    } finally { await handle.close(); }
  }
  return {
    snapshot: () => serial(async () => publicState(await load())),
    createBackup: () => serial(async () => {
      const state = await load();
      if (state.backups.length >= LIMIT) throw fail('Limite di 30 backup raggiunto. Esporta e rimuovi una copia tramite manutenzione locale prima di crearne altre.', 'BACKUP_CAPACITY', 409);
      await ensureFolder();
      const id = randomUUID(), filename = `studio-${id}.sqlite`, path = resolve(folder, filename);
      let owned = false;
      try {
        // archive.backup exclusively creates the destination, refusing overwrite.
        await archive.backup(path); owned = true;
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { await handle.sync(); } finally { await handle.close(); }
        const checked = await archive.verifyBackup(path), hash = await fingerprint(path);
        if (!verification(checked)) throw fail('Verifica backup non valida.', 'BACKUP_VERIFY_FAILED', 503);
        state.backups.unshift({ id, filename, createdAt: new Date(now()).toISOString(), ...hash, verifiedAt: checked.verifiedAt, records: checked.records });
        await archive.write(KEY, state);
        return publicState(state);
      } catch (error) { if (owned) await unlink(path).catch(() => {}); throw error; }
    }),
    verify: () => serial(async () => {
      const state = await load(), checked = await archive.verify();
      if (!verification(checked)) throw fail('Verifica archivio non valida.', 'ARCHIVE_VERIFY_FAILED', 503);
      state.lastVerification = checked;
      await archive.write(KEY, state);
      return { verification: structuredClone(checked), snapshot: publicState(state) };
    }),
    backupFile: ({ id }: { id: string }) => serial(async () => {
      if (typeof id !== 'string' || !UUID.test(id)) throw fail('Backup non valido.');
      const state = await load(), item = state.backups.find(backup => backup.id === id);
      if (!item) throw fail('Backup non trovato.', 'BACKUP_NOT_FOUND', 404);
      await ensureFolder();
      const path = resolve(folder, item.filename), actual = await fingerprint(path);
      if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) throw fail('Il backup è cambiato: download rifiutato.', 'BACKUP_DIGEST_MISMATCH', 409);
      return { path, filename: item.filename, bytes: item.bytes, sha256: item.sha256 };
    }),
    // Deliberately CLI-only: deleting the last recovery copy is never a browser action.
    removeBackup: ({ id }: { id: string }) => serial(async () => {
      if (typeof id !== 'string' || !UUID.test(id)) throw fail('Backup non valido.');
      const state = await load(), item = state.backups.find(backup => backup.id === id);
      if (!item) throw fail('Backup non trovato.', 'BACKUP_NOT_FOUND', 404);
      await ensureFolder();
      const path = resolve(folder, item.filename);
      const info = await lstat(path).catch((error: unknown) => { if (record(error) && error.code === 'ENOENT') return null; throw error; });
      if (info && (!info.isFile() || info.isSymbolicLink())) throw fail('Backup non regolare.', 'MAINTENANCE_PATH_DENIED', 409);
      // A missing file can be pruned from the index, including after a crash
      // between unlink and the durable archive update. No glob/path input exists.
      if (info) await unlink(path);
      state.backups = state.backups.filter(backup => backup.id !== id);
      await archive.write(KEY, state);
      return publicState(state);
    }),
  };
}
