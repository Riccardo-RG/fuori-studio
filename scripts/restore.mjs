import { constants } from 'node:fs';
import { chmod, copyFile, mkdir, open } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadSecretEnvironment } from '../lib/deployment.ts';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';

const failure = message => Object.assign(Error(message), { code: 'RESTORE_FAILED' });

/** Restore into an exclusively created directory. The original and backup are
 * never changed; a failed destination is retained for operator inspection. */
export async function restoreArchive({ backup, into, keyFile, env = process.env }) {
  await loadSecretEnvironment(env);
  const { createArchive, verifyEncryptedArchive } = await import('../lib/archive.mjs');
  const source = resolve(backup), destination = resolve(into);
  if (keyFile && env.FUORI_STUDIO_MASTER_KEY) throw failure('Scegli --key-file oppure FUORI_STUDIO_MASTER_KEY, non entrambi.');
  let key;
  if (keyFile) {
    const handle = await open(resolve(keyFile), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const info = await handle.stat(); if (!info.isFile() || info.size !== 32) throw failure('Il file chiave locale deve contenere esattamente 32 byte.'); key = await handle.readFile(); }
    finally { await handle.close(); }
  } else {
    const value = env.FUORI_STUDIO_MASTER_KEY;
    if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw failure('Fornisci --key-file con archive.key originale oppure la chiave esterna in base64.');
    key = Buffer.from(value, 'base64');
  }
  let archive, release, completed = false;
  try {
    // Authentication precedes creation, and is repeated on the exclusive copy.
    const verified = await verifyEncryptedArchive(source, key);
    try { await mkdir(destination, { mode: 0o700 }); }
    catch (error) { if (error.code === 'EEXIST') throw failure('La destinazione esiste già. Scegli una cartella nuova: nessun archivio è stato sovrascritto.'); throw error; }
    await chmod(destination, 0o700);
    release = await acquireInstanceLock(destination);
    const database = resolve(destination, 'studio.sqlite');
    await copyFile(source, database, constants.COPYFILE_EXCL);
    await chmod(database, 0o600);
    await verifyEncryptedArchive(database, key);
    if (keyFile) {
      const handle = await open(resolve(destination, 'archive.key'), 'wx', 0o600);
      try { await handle.writeFile(key); await handle.sync(); } finally { await handle.close(); }
    }
    archive = createArchive({ directory: destination, mode: keyFile ? 'local' : 'online', masterKey: keyFile ? null : key.toString('base64') });
    await archive.init();
    const entries = [], identity = await archive.read('identity');
    entries.push({ key: 'identity', value: { version: 1, generation: Number.isSafeInteger(identity?.generation) ? Math.min(identity.generation + 1, Number.MAX_SAFE_INTEGER) : 1, sessions: [], flows: [] } });
    entries.push({ key: 'devices', value: { version: 1, devices: [], pairings: [], jobs: [], target: 'local' } });
    entries.push({ key: 'repository-devices', value: { version: 1, inventories: [], jobs: [] } });
    entries.push({ key: 'repository-worker', value: { version: 1, policies: [], journal: [] } });
    entries.push({ key: 'connection', value: null });
    entries.push({ key: 'sync', value: { version: 1, link: null, enabledScopeIds: [], bases: {}, conflicts: [] } });
    entries.push({ key: 'maintenance', value: { version: 1, backups: [], lastVerification: null } });
    const pending = await archive.read('portability/pending', []);
    if (!Array.isArray(pending)) throw failure('Registro importazioni non valido. Conserva la copia e verifica il backup.');
    for (const item of pending) {
      if (typeof item?.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(item.id)) throw failure('Identificativo importazione non valido.');
      entries.push({ key: `portability/import/${item.id}`, value: { status: 'expired', expiresAt: 0 } });
    }
    entries.push({ key: 'portability/pending', value: [] });
    const governance = await archive.read('governance');
    if (governance) {
      if (!governance.settings || typeof governance.settings.version !== 'number') throw failure('Configurazione autonomia non valida.');
      governance.settings.autonomousRoutines = false; governance.settings.autonomousEnabledAt = null; governance.settings.version++;
      entries.push({ key: 'governance', value: governance });
    }
    const operations = await archive.read('operations');
    if (operations) {
      if (!Array.isArray(operations.routines)) throw failure('Registro routine non valido.');
      for (const routine of operations.routines) { if (routine.enabled) { routine.enabled = false; routine.version++; routine.updatedAt = new Date().toISOString(); } }
      entries.push({ key: 'operations', value: operations });
    }
    entries.push({ key: 'system/recovery', value: { restoredAt: new Date().toISOString(), sourceVerifiedAt: verified.verifiedAt, accessReset: true, autonomyDisabled: true } });
    await archive.batch(entries);
    const result = await archive.verify();
    await archive.close(); archive = undefined;
    const handle = await open(database, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
    completed = true;
    return { directory: destination, ...result, accessReset: true, autonomyDisabled: true };
  } finally {
    key?.fill(0); await archive?.close();
    // A partial restore retains its exclusive lock. Never let an incomplete
    // credential reset become a startable installation after an error/crash.
    if (completed) await release?.();
  }
}

async function main() {
  const args = process.argv.slice(2), backup = args.shift();
  if (!backup || args.length < 2 || args.length > 4 || args.length % 2) throw failure('Uso: npm run restore -- <backup.sqlite> --into <cartella-nuova> [--key-file <archive.key>]');
  const options = {};
  for (let index = 0; index < args.length; index += 2) { const flag = args[index]; if (!['--into', '--key-file'].includes(flag) || options[flag] || !args[index + 1]) throw failure('Opzioni ripristino non valide.'); options[flag] = args[index + 1]; }
  if (!options['--into']) throw failure('Specifica --into con una cartella nuova.');
  const result = await restoreArchive({ backup, into: options['--into'], keyFile: options['--key-file'] });
  console.log(`Ripristino verificato in ${result.directory}. Record: ${result.records}. Sessioni, dispositivi e sincronizzazione devono essere ricollegati; routine autonome disattivate. Avvia lo studio con FUORI_STUDIO_DATA_DIR impostato su questa cartella e ricontrolla i servizi collegati.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
