import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchive } from '../lib/archive.mjs';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local'));
const destination = process.argv[2];
if (!destination) throw Error('Uso: npm run backup -- /percorso/sicuro/studio-backup.sqlite');
// Stop the server first so the backup covers a coherent idle application state.
const release = await acquireInstanceLock(directory);
const archive = createArchive({ directory });
try { await archive.backup(destination); console.log('Backup cifrato creato. Conserva separatamente archive.key o FUORI_STUDIO_MASTER_KEY.'); }
finally { await archive.close(); await release(); }
