import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

// Prevent two local servers from independently overwriting the same JSON archives.
export async function acquireInstanceLock(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = resolve(directory, 'server.lock');
  const token = randomUUID();
  async function attempt() {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let previous;
      try { previous = JSON.parse(await readFile(file, 'utf8')); } catch { throw Error('Archivio bloccato: server.lock non leggibile. Verifica che non ci siano altri server prima di rimuoverlo.'); }
      let alive = true;
      if (Number.isSafeInteger(previous.pid) && previous.pid > 0) {
        try { process.kill(previous.pid, 0); } catch (cause) { if (cause.code === 'ESRCH') alive = false; }
      }
      if (alive) throw Error('Un altro server sta usando questo archivio. Chiudilo oppure scegli FUORI_STUDIO_DATA_DIR diverso.');
      // Read-then-unlink reclamation races with another startup. Require explicit recovery.
      throw Error('Il server precedente si è interrotto. Verifica che nessun server usi questo archivio, rimuovi server.lock dalla cartella dati e riavvia. I dati sono stati conservati.');
    }
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    await handle.sync();
    await handle.close();
  }
  await attempt();
  return async () => {
    try { const owner = JSON.parse(await readFile(file, 'utf8')); if (owner.token === token) await unlink(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
}
