import { createInterface } from 'node:readline/promises';
import { resolve } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lstat, readFile } from 'node:fs/promises';
import { createArchive } from '../lib/archive.mjs';
import { acquireInstanceLock } from '../lib/instance-lock.mjs';
import { deviceRequest, trustedOrigin } from '../lib/sync.mjs';
import { codexStatus, runCodex, shutdownCodex } from '../lib/codex.mjs';
import { createRepositoryRuntime } from '../lib/repository-runtime.mjs';
import { createRepositoryWorker } from '../lib/repository-worker.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.env.FUORI_STUDIO_DEVICE_DIR || resolve(root, '.local', 'device'));
const storage = createArchive({ directory, mode: 'local' });
const release = await acquireInstanceLock(directory);
const shutdown = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { shutdown.abort(); shutdownCodex(); });
const delay = ms => new Promise(done => { if (shutdown.signal.aborted) { done(); return; } const timer = setTimeout(finish, ms); function finish() { clearTimeout(timer); shutdown.signal.removeEventListener('abort', finish); done(); } shutdown.signal.addEventListener('abort', finish, { once: true }); });
const request = (connection, path, payload, signal = shutdown.signal) => deviceRequest(connection.url, path, payload, connection.token, (url, options) => fetch(url, { ...options, signal: signal ? AbortSignal.any([options.signal, signal]) : options.signal }));
const repositoryWorker = connection => createRepositoryWorker({ storage, connection, runtime: createRepositoryRuntime({ directory: resolve(directory, 'repository-runs') }), request: (path, payload, signal) => request(connection, path, payload, signal) });
const requireRepositoryConnection = async () => { const connection = await storage.read('connection'); if (!connection?.capabilities?.includes('repository')) throw Error('Associa questo computer con la capacità Repository prima di autorizzare percorsi locali.'); return connection; };

try {
  const command = process.argv[2] || 'status';
  if (command === 'pair') {
    const url = trustedOrigin(process.argv[3]);
    const existing = await storage.read('connection');
    if (existing) throw Error('Scollega prima il dispositivo con npm run device -- disconnect.');
    const reader = createInterface({ input: process.stdin, output: process.stdout });
    let code; try { code = (await reader.question('Codice monouso mostrato dal tuo studio online: ')).trim(); } finally { reader.close(); }
    const connection = await deviceRequest(url, '/api/device/pair', { code });
    if (!connection.capabilities?.some(capability => ['execute', 'repository'].includes(capability)) || typeof connection.token !== 'string') throw Error('Questo codice non abilita l’esecuzione. Generane uno con la capacità Codex o Repository.');
    await storage.write('connection', { ...connection, url });
    console.log('Computer collegato. Il login Codex rimane su questo computer. Avvia npm run device -- run.');
  } else if (command === 'status') {
    const connection = await storage.read('connection');
    console.log(connection ? `${connection.name} · ${connection.url}\nScadenza: ${new Date(connection.expiresAt).toISOString()}\nAmbiti: ${connection.scopeIds.join(', ')}` : 'Nessuno studio collegato.');
    if (connection) console.log(`Capacità: ${connection.capabilities.join(', ')}`);
    if (connection?.capabilities.includes('repository')) {
      const worker = repositoryWorker(connection), policies = await worker.list(), state = await worker.status();
      console.log(`Repository locali autorizzati per questo collegamento: ${policies.length}. Consegne in attesa: ${state.pending}.`);
      for (const policy of policies) console.log(`  ${policy.alias} · ambiti: ${policy.scopeIds.join(', ')} · controlli: ${policy.checks.map(check => check.label).join(', ')}`);
      for (const entry of state.journal.slice(0, 5)) console.log(`  Incarico ${entry.runId}: ${entry.status}${entry.errorCode ? ` (${entry.errorCode})` : ''}`);
    }
    const status = await codexStatus(); console.log(status.ready ? 'Codex: accesso disponibile.' : 'Codex: esegui codex login su questo computer.');
  } else if (command === 'repository:add') {
    const connection = await requireRepositoryConnection(), selectedAlias = process.argv[3], path = process.argv[4];
    const args = process.argv.slice(5);
    if (args.length !== 4 || !args.includes('--scopes') || !args.includes('--checks')) throw Error('Uso: repository:add <alias> <percorsoGitAssoluto> --scopes <ambiti,separati> --checks <fileJSON>');
    const scopeIndex = args.indexOf('--scopes'), checksIndex = args.indexOf('--checks');
    if (![0, 2].includes(scopeIndex) || ![0, 2].includes(checksIndex) || scopeIndex === checksIndex) throw Error('Opzioni repository non valide.');
    const filename = resolve(args[checksIndex + 1]), info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 64000) throw Error('Il file dei controlli deve essere un file JSON regolare entro 64 KB.');
    let checks; try { checks = JSON.parse(await readFile(filename, 'utf8')); } catch { throw Error('Il file dei controlli non contiene JSON valido.'); }
    const policy = await repositoryWorker(connection).add({ alias: selectedAlias, path, scopeIds: args[scopeIndex + 1].split(',').map(value => value.trim()).filter(Boolean), checks });
    console.log(`Repository ${policy.alias} autorizzato soltanto per ${connection.url}.\nPercorso locale: ${policy.path}\nAmbiti: ${policy.scopeIds.join(', ')}\nControlli: ${policy.checks.map(check => check.label).join(', ')}\nAvvia il worker per pubblicare il catalogo. Nessuna AI è stata avviata.`);
  } else if (command === 'repository:list') {
    const connection = await requireRepositoryConnection(), policies = await repositoryWorker(connection).list();
    if (!policies.length) console.log('Nessun repository autorizzato per questo collegamento.');
    for (const policy of policies) console.log(`${policy.alias}\n  ${policy.path}\n  Ambiti: ${policy.scopeIds.join(', ')}\n  Controlli: ${policy.checks.map(check => `${check.label}: ${JSON.stringify([check.program, ...check.args])}`).join('; ')}\n  Politica: ${policy.policyHash}`);
  } else if (command === 'repository:remove') {
    const connection = await requireRepositoryConnection(), result = await repositoryWorker(connection).remove(process.argv[3]);
    console.log(`Autorizzazione locale ${result.removed} rimossa. Avvia il worker per aggiornare il catalogo dello studio.`);
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
    const worker = connection.capabilities.includes('repository') ? repositoryWorker(connection) : null;
    if (worker) await worker.recover();
    let nextAnnouncement = 0;
    console.log(`In attesa di incarichi autorizzati da ${connection.url}. Ctrl+C per fermare.`);
    while (!shutdown.signal.aborted) {
      if (worker) {
        try {
          if (Date.now() >= nextAnnouncement) {
            const catalog = await worker.announce(shutdown.signal); nextAnnouncement = Date.now() + 20000;
            for (const item of catalog.blocked) console.error(`Repository ${item.alias} non disponibile (${item.code}).`);
          }
          const result = await worker.pollOnce(shutdown.signal);
          if (result.status === 'processed') { console.log(`Incarico repository ${result.jobId} terminato; stato consegna disponibile con device status.`); continue; }
          if (result.status === 'policy-denied') { console.error('Incarico repository rifiutato dalla politica locale. Nessun comando eseguito.'); continue; }
        } catch (error) { if (!shutdown.signal.aborted) console.error(`Worker repository: ${error.message}`); await delay(10000); continue; }
      }
      if (shutdown.signal.aborted) break;
      if (!connection.capabilities.includes('execute')) { await delay(2500); continue; }
      let job;
      try { ({ job } = await request(connection, '/api/device/claim', {})); }
      catch { console.error('Collegamento non disponibile o revocato. Nessun lavoro avviato.'); await delay(10000); continue; }
      if (!job) { await delay(2500); continue; }
      if (typeof job.id !== 'string' || typeof job.lease !== 'string' || typeof job.prompt !== 'string' || job.prompt.length > 120000 || typeof job.schema !== 'boolean' || !connection.scopeIds.includes(job.scopeId)) throw Error('Lo studio ha inviato un incarico incompatibile. Dispositivo fermato.');
      const controller = new AbortController();
      const stop = () => controller.abort(); shutdown.signal.addEventListener('abort', stop, { once: true });
      let renewing = false;
      const heartbeat = setInterval(async () => {
        if (renewing) return; renewing = true;
        try { await request(connection, '/api/device/heartbeat', { id: job.id, lease: job.lease }); }
        catch { controller.abort(); }
        finally { renewing = false; }
      }, 8000);
      let result;
      try { result = { text: await runCodex(job.prompt, { schema: job.schema, signal: controller.signal }) }; }
      catch { result = { error: true }; }
      finally { clearInterval(heartbeat); shutdown.signal.removeEventListener('abort', stop); }
      try { await request(connection, '/api/device/result', { id: job.id, lease: job.lease, ...result }); console.log(result.error ? 'Incarico interrotto.' : 'Risposta consegnata.'); }
      catch { console.error('Risultato non accettato o connessione persa. Nessuna riesecuzione automatica.'); }
    }
  } else throw Error('Comandi: status | pair <https://studio.example.com> | run | disconnect | repository:add <alias> <percorsoGitAssoluto> --scopes <ambiti> --checks <fileJSON> | repository:list | repository:remove <alias>');
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { shutdownCodex(); await storage.close(); await release(); }
