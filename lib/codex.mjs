import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = resolve(process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local'));
const scratchDir = resolve(dataDir, 'conversation');
const fallback = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
const activeChildren = new Set();
let codexPath = null;

async function resolveCodex() {
  if (codexPath) return codexPath;
  if (process.env.FUORI_STUDIO_CODEX_BIN) {
    await access(process.env.FUORI_STUDIO_CODEX_BIN);
    return (codexPath = process.env.FUORI_STUDIO_CODEX_BIN);
  }
  try { await access(fallback); return (codexPath = fallback); }
  catch { return (codexPath = 'codex'); }
}

export async function codexStatus() {
  try {
    const binary = await resolveCodex();
    return await new Promise(resolveResult => {
      const child = spawn(binary, ['login', 'status'], { stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '';
      const collect = data => { output = (output + data.toString()).slice(-8192); };
      child.stdout.on('data', collect);
      child.stderr.on('data', collect);
      const timer = setTimeout(() => child.kill(), 8000);
      child.on('error', () => { clearTimeout(timer); resolveResult({ ready: false, provider: 'Codex', reason: 'Codex non è disponibile sul Mac.' }); });
      child.on('close', code => {
        clearTimeout(timer);
        resolveResult({ ready: code === 0, provider: 'Codex', auth: /ChatGPT/i.test(output) ? 'ChatGPT' : 'Codex', reason: code === 0 ? null : 'Apri il terminale ed esegui codex login per collegare il team.' });
      });
    });
  } catch { return { ready: false, provider: 'Codex', reason: 'Il percorso di Codex non è disponibile.' }; }
}

function stopChild(child) {
  if (child.exitCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const timer = setTimeout(() => {
    if (child.exitCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }, 1500);
  timer.unref();
}
export function shutdownCodex() { for (const child of activeChildren) stopChild(child); }

// Preserve the existing isolated, ephemeral, read-only conversation runner.
export async function runCodex(prompt, { schema, signal } = {}) {
  if (signal?.aborted) throw Error('Richiesta interrotta.');
  const binary = await resolveCodex();
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  if (signal?.aborted) throw Error('Richiesta interrotta.');
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '-C', scratchDir];
  if (schema) args.push('--output-schema', resolve(root, 'lib/route.schema.json'));
  args.push('-');
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd: scratchDir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    activeChildren.add(child);
    child.once('close', () => activeChildren.delete(child));
    let buffer = '', reply = '', settled = false, bytes = 0;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolveRun(reply);
    };
    const abort = () => { stopChild(child); finish(Error('Richiesta interrotta.')); };
    const timeout = setTimeout(() => { stopChild(child); finish(Error('Codex sta impiegando troppo tempo. Riprova con una richiesta più breve.')); }, 180000);
    signal?.addEventListener('abort', abort, { once: true });
    const parseLine = line => {
      try {
        const event = JSON.parse(line);
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') reply = event.item.text || reply;
        // Never surface raw runtime errors, which may contain local credentials.
        // A transient diagnostic may precede a successful final reply.
      } catch { /* Non-JSON diagnostics are not assistant content. */ }
    };
    child.stdout.on('data', data => {
      if (settled) return;
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) { stopChild(child); return finish(Error('La risposta di Codex supera il limite consentito.')); }
      buffer += data.toString();
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { parseLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', () => {});
    child.on('error', error => finish(Error(error.code === 'ENOENT' ? 'Codex non è disponibile. Verifica il percorso dell’app.' : 'Non riesco ad avviare Codex.')));
    child.on('close', code => {
      if (buffer.trim()) parseLine(buffer);
      if (signal?.aborted) return finish(Error('Richiesta interrotta.'));
      if (code !== 0 || typeof reply !== 'string' || !reply.trim()) return finish(Error('Codex non ha restituito una risposta. Verifica l’accesso e riprova.'));
      if (reply.length > 128000) return finish(Error('La risposta di Codex supera il limite consentito.'));
      finish();
    });
    child.stdin.on('error', () => {});
    if (signal?.aborted) abort(); else child.stdin.end(prompt);
  });
}
