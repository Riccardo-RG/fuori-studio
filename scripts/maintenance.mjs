import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSecretEnvironment } from '../lib/deployment.ts';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';
import { createMaintenance } from '../lib/maintenance.ts';

await loadSecretEnvironment();
const { createArchive } = await import('../lib/archive.mjs');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local'));
let archive, release;
try {
  const [command = 'list', id, ...extra] = process.argv.slice(2);
  if (!['list', 'remove'].includes(command) || extra.length || command === 'list' && id || command === 'remove' && !id) throw Error('Uso: npm run maintenance -- list | remove <backup-id>');
  release = await acquireInstanceLock(directory);
  archive = createArchive({ directory });
  const maintenance = createMaintenance({ archive, directory });
  const state = command === 'remove' ? await maintenance.removeBackup({ id }) : await maintenance.snapshot();
  if (command === 'remove') console.log('Copia locale rimossa. Le altre copie sono conservate.');
  if (!state.backups.length) console.log('Nessun backup gestito.');
  for (const item of state.backups) console.log(`${item.id}  ${item.createdAt}  ${item.bytes} byte  SHA-256 ${item.sha256}`);
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await archive?.close(); await release?.(); }
