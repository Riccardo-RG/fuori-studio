import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArchive } from '../lib/archive.mjs';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';
import { deviceRequest, trustedOrigin } from '../lib/sync.mjs';
import { codexStatus, runCodex, shutdownCodex } from '../lib/codex.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.FUORI_STUDIO_DEVICE_DIR || resolve(root, '.local', 'device'));
const storage = createArchive({ directory, mode: 'local' });
const release = await acquireInstanceLock(directory);
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutdown.abort(); shutdownCodex(); });
const delay = ms => new Promise(done => { const timer = setTimeout(finish, ms); function finish() { clearTimeout(timer); shutdown.signal.removeEventListener('abort', finish); done(); } shutdown.signal.addEventListener('abort', finish, { once: true }); });

try {
  const command = process.argv[2] || 'status';
  if (command === 'pair') {
    const url = trustedOrigin(process.argv[3]);
    const existing = await storage.read('connection');
    if (existing) throw Error('Scollega prima il dispositivo con npm run device -- disconnect.');
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    let code; try { code = (await reader.question('Codice monouso mostrato dal tuo studio online: ')).trim(); } finally { reader.close(); }
    const connection = await deviceRequest(url, '/api/device/pair', { code });
    if (!connection.capabilities?.includes('execute') || typeof connection.token !== 'string') throw Error('Questo codice non abilita l’esecuzione. Generane uno con la capacità Codex.');
    await storage.write('connection', { ...connection, url });
    console.log('Computer collegato. Il login Codex rimane su questo computer. Avvia npm run device -- run.');
  } else if (command === 'status') {
    const connection = await storage.read('connection');
    console.log(connection ? `${connection.name} · ${connection.url}\nScadenza: ${new Date(connection.expiresAt).toISOString()}\nAmbiti: ${connection.scopeIds.join(', ')}` : 'Nessuno studio collegato.');
    const status = await codexStatus(); console.log(status.ready ? 'Codex: accesso disponibile.' : 'Codex: esegui codex login su questo computer.');
  } else if (command === 'disconnect') {
    const connection = await storage.read('connection');
    if (connection) {
      try { await deviceRequest(connection.url, '/api/device/disconnect', {}, connection.token); }
      catch { console.log('Studio non raggiungibile: revoca anche il dispositivo dal pannello online.'); }
    }
    await storage.write('connection', null); console.log('Credenziale locale rimossa.');
  } else if (command === 'run') {
    const connection = await storage.read('connection');
    if (!connection) throw Error('Collega prima questo computer: npm run device -- pair https://studio.example.com');
    if (!(await codexStatus()).ready) throw Error('Esegui codex login su questo computer prima di avviare il dispositivo.');
    console.log(`In attesa di incarichi autorizzati da ${connection.url}. Ctrl+C per fermare.`);
    while (!shutdown.signal.aborted) {
      let job;
      try { ({ job } = await deviceRequest(connection.url, '/api/device/claim', {}, connection.token)); }
      catch { console.error('Collegamento non disponibile o revocato. Nessun lavoro avviato.'); await delay(10000); continue; }
      if (!job) { await delay(2500); continue; }
      if (typeof job.id !== 'string' || typeof job.lease !== 'string' || typeof job.prompt !== 'string' || job.prompt.length > 120000 || typeof job.schema !== 'boolean' || !connection.scopeIds.includes(job.scopeId)) throw Error('Lo studio ha inviato un incarico incompatibile. Dispositivo fermato.');
      const controller = new AbortController();
      const stop = () => controller.abort(); shutdown.signal.addEventListener('abort', stop, { once: true });
      let renewing = false;
      const heartbeat = setInterval(async () => {
        if (renewing) return; renewing = true;
        try { await deviceRequest(connection.url, '/api/device/heartbeat', { id: job.id, lease: job.lease }, connection.token); }
        catch { controller.abort(); }
        finally { renewing = false; }
      }, 8000);
      let result;
      try { result = { text: await runCodex(job.prompt, { schema: job.schema, signal: controller.signal }) }; }
      catch { result = { error: true }; }
      finally { clearInterval(heartbeat); shutdown.signal.removeEventListener('abort', stop); }
      try { await deviceRequest(connection.url, '/api/device/result', { id: job.id, lease: job.lease, ...result }, connection.token); console.log(result.error ? 'Incarico interrotto.' : 'Risposta consegnata.'); }
      catch { console.error('Risultato non accettato o connessione persa. Nessuna riesecuzione automatica.'); }
    }
  } else throw Error('Comandi: status | pair <https://studio.example.com> | run | disconnect');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { shutdownCodex(); await storage.close(); await release(); }
