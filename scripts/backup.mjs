import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecretEnvironment } from '../lib/deployment.ts';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';

await loadSecretEnvironment();
const { createArchive } = await import('../lib/archive.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local'));
let release, archive;
try {
  const destination = process.argv[2];
  if (!destination || process.argv.length !== 3) throw Error('Uso: npm run backup -- /percorso/sicuro/studio-backup.sqlite');
  // Stop the server first so this CLI covers a coherent idle application state.
  release = await acquireInstanceLock(directory);
  archive = createArchive({ directory });
  await archive.backup(destination);
  const result = await archive.verifyBackup(destination);
  console.log(`Backup cifrato creato e verificato: ${result.records} record. Conserva separatamente archive.key o FUORI_STUDIO_MASTER_KEY.`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await archive?.close(); await release?.(); }
