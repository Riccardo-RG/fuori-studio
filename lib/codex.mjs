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
// Explicit tool-surface controls for reviewed-input analysis. These are CLI
// settings, not an OS isolation guarantee; managed configuration still applies.
const INPUT_ONLY_DISABLED_FEATURES = Object.freeze([
  'shell_tool', 'unified_exec', 'unified_exec_tty', 'shell_snapshot', 'shell_snapshot_v2',
  'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'multi_agent_v2', 'agent_message_board',
  'browser_use', 'browser_use_external', 'browser_use_full_cdp_access', 'computer_use',
  'image_generation', 'view_image', 'artifact', 'workspace_dependencies',
  'code_mode', 'code_mode_host', 'code_mode_only', 'code_mode_prewarm',
  'memories', 'external_agent_memory_import', 'skill_search', 'skill_mcp_dependency_install',
  'tool_suggest', 'goals', 'request_permissions_tool', 'standalone_web_search', 'sleep_tool',
]);
function inputOnlyArguments() {
  return ['--strict-config', '--ignore-rules',
    ...INPUT_ONLY_DISABLED_FEATURES.flatMap(feature => ['--disable', feature]),
    '--enable', 'skip_host_skill_discovery',
    ...['web_search="disabled"', 'tools.view_image=false', 'project_doc_max_bytes=0', 'mcp_servers={}', 'plugins={}', 'approval_policy="never"', 'allow_login_shell=false'].flatMap(value => ['-c', value]),
  ];
}
function conversationalEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return false;
  if (['thread.started', 'turn.started', 'turn.completed', 'turn.failed', 'error'].includes(event.type)) return true;
  return ['item.started', 'item.updated', 'item.completed'].includes(event.type) && ['agent_message', 'reasoning', 'error'].includes(event.item?.type);
}

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
  if (child.exitCode !== null || child.signalCode !== null) return;
  try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    }
  }, 1500);
  child.once('close', () => clearTimeout(timer));
  timer.unref();
}
export function shutdownCodex() { for (const child of activeChildren) stopChild(child); }

const quotaObject = value => value && typeof value === 'object' && !Array.isArray(value);
const quotaId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,99}$/.test(value) && !['constructor', 'prototype'].includes(value);
const quotaInteger = value => Number.isSafeInteger(value) && value >= 0;
function quotaWindow(value) {
  if (!quotaObject(value) || !quotaInteger(value.usedPercent)) return null;
  const reset = quotaInteger(value.resetsAt) && value.resetsAt <= 8640000000000 ? new Date(value.resetsAt * 1000).toISOString() : null;
  return { usedPercent: value.usedPercent, remainingPercent: Math.max(0, Math.min(100, 100 - value.usedPercent)), windowDurationMins: quotaInteger(value.windowDurationMins) && value.windowDurationMins > 0 ? value.windowDurationMins : null, resetsAt: reset };
}
function quotaSnapshot(result, observedAt) {
  if (!quotaObject(result)) return null;
  const ordinaryUsageAllowed = typeof result.ordinaryUsageAllowed === 'boolean' ? result.ordinaryUsageAllowed : null;
  const entries = quotaObject(result.rateLimitsByLimitId)
    ? Object.entries(result.rateLimitsByLimitId)
    : quotaObject(result.rateLimits) ? [[quotaId(result.rateLimits.limitId) ? result.rateLimits.limitId : 'legacy', result.rateLimits]] : [];
  const limits = entries.filter(([id]) => quotaId(id)).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).slice(0, 32).flatMap(([id, value]) => {
    if (!quotaObject(value)) return [];
    const primary = quotaWindow(value.primary), secondary = quotaWindow(value.secondary);
    return primary || secondary ? [{ id, primary, secondary }] : [];
  });
  if (!limits.length && ordinaryUsageAllowed === null) return null;
  return { source: 'codex_app_server', observedAt, ordinaryUsageAllowed, limits };
}

/** Read account-wide limits without starting a thread, model turn or login flow. */
export function createCodexAccountLimits({ resolveBinary = resolveCodex, spawnProcess = spawn, now = Date.now, timeoutMs = 4000, cacheMs = 60000 } = {}) {
  let cached = null, expiresAt = 0, pending = null;
  function collect() {
    return new Promise(resolveResult => {
      let child = null, settled = false, buffer = '', bytes = 0, stage = 'initialize';
      const finish = result => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (child) { child.stdin.destroy(); stopChild(child); }
        resolveResult(result);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      Promise.resolve().then(resolveBinary).then(binary => {
        if (settled) return;
        child = spawnProcess(binary, ['app-server', '--listen', 'stdio://'], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        activeChildren.add(child);
        child.once('close', () => activeChildren.delete(child));
        const send = value => { if (!settled) child.stdin.write(JSON.stringify(value) + '\n'); };
        const parseLine = line => {
          let event; try { event = JSON.parse(line); } catch { return; }
          if (!quotaObject(event)) return;
          // Never fulfill server-initiated requests (approvals, auth or tools).
          if (typeof event.method === 'string' && Object.hasOwn(event, 'id')) return finish(null);
          if (stage === 'initialize' && event.id === 1) {
            if (event.error || !quotaObject(event.result)) return finish(null);
            stage = 'limits';
            send({ method: 'initialized', params: {} });
            send({ id: 2, method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true, supportsLunaReserve: false } });
          } else if (stage === 'limits' && event.id === 2) {
            finish(event.error ? null : quotaSnapshot(event.result, new Date(now()).toISOString()));
          }
        };
        child.stdout.on('data', data => {
          if (settled) return;
          bytes += data.length;
          if (bytes > 256 * 1024) return finish(null);
          buffer += data.toString();
          let end;
          while (!settled && (end = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, end); buffer = buffer.slice(end + 1); parseLine(line); }
        });
        child.stderr.on('data', data => { bytes += data.length; if (!settled && bytes > 256 * 1024) finish(null); });
        child.stdin.on('error', () => finish(null));
        child.on('error', () => finish(null));
        child.on('close', code => { if (!settled && code === 0 && buffer.trim()) parseLine(buffer); finish(null); });
        send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'fuori_studio', title: 'Fuori Studio', version: '0.6.0' } } });
      }).catch(() => finish(null));
    });
  }
  return async () => {
    if (!pending && now() < expiresAt) return structuredClone(cached);
    if (!pending) pending = collect().catch(() => null).then(value => { cached = value; expiresAt = now() + cacheMs; return value; }).finally(() => { pending = null; });
    return structuredClone(await pending);
  };
}
export const codexAccountLimits = createCodexAccountLimits();

// Keep the string API available for callers that only need assistant text.
export async function runCodex(prompt, options = {}) {
  return (await runCodexResult(prompt, options)).text;
}

// Preserve the existing isolated, ephemeral, read-only conversation runner.
export async function runCodexResult(prompt, { schema, signal, inputOnly = false } = {}) {
  if (typeof inputOnly !== 'boolean') throw Error('La modalità di analisi Codex non è valida.');
  if (signal?.aborted) throw Error('Richiesta interrotta.');
  const binary = await resolveCodex();
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  if (signal?.aborted) throw Error('Richiesta interrotta.');
  const args = ['exec', '--ignore-user-config', '--ephemeral', '--skip-git-repo-check', '--sandbox', 'read-only', '--json', '--color', 'never', '-C', scratchDir];
  if (inputOnly) args.push(...inputOnlyArguments());
  if (schema) args.push('--output-schema', resolve(root, 'lib/route.schema.json'));
  args.push('-');
  return new Promise((resolveRun, reject) => {
    const child = spawn(binary, args, { cwd: scratchDir, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    activeChildren.add(child);
    child.once('close', () => activeChildren.delete(child));
    let buffer = '', reply = '', settled = false, bytes = 0;
    let usage = { inputTokens: null, outputTokens: null };
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error); else resolveRun({ text: reply, usage });
    };
    const abort = () => { stopChild(child); finish(Error('Richiesta interrotta.')); };
    const timeout = setTimeout(() => { stopChild(child); finish(Error('Codex sta impiegando troppo tempo. Riprova con una richiesta più breve.')); }, 180000);
    signal?.addEventListener('abort', abort, { once: true });
    // Secondary detection only: a reported tool action may already have run.
    // Stop instead of treating such a run as an input-only analysis success.
    const unexpectedActivity = () => { stopChild(child); finish(Object.assign(Error('Analisi interrotta: Codex ha segnalato un’attività non consentita per gli estratti forniti.'), { code: 'CODEX_INPUT_ONLY_ACTIVITY' })); };
    const parseLine = line => {
      if (settled) return;
      try {
        const event = JSON.parse(line);
        if (inputOnly && !conversationalEvent(event)) return unexpectedActivity();
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') reply = event.item.text || reply;
        if (event.type === 'turn.completed') {
          const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
          usage = { inputTokens: count(event.usage?.input_tokens), outputTokens: count(event.usage?.output_tokens) };
        }
        // Never surface raw runtime errors, which may contain local credentials.
        // A transient diagnostic may precede a successful final reply.
      } catch { if (inputOnly && line.trim()) unexpectedActivity(); /* Never return non-JSON diagnostics as assistant content. */ }
    };
    child.stdout.on('data', data => {
      if (settled) return;
      bytes += data.length;
      if (bytes > 2 * 1024 * 1024) { stopChild(child); return finish(Error('La risposta di Codex supera il limite consentito.')); }
      buffer += data.toString();
      let end;
      while (!settled && (end = buffer.indexOf('\n')) >= 0) { parseLine(buffer.slice(0, end)); buffer = buffer.slice(end + 1); }
    });
    child.stderr.on('data', () => {});
    child.on('error', error => finish(Error(error.code === 'ENOENT' ? 'Codex non è disponibile. Verifica il percorso dell’app.' : 'Non riesco ad avviare Codex.')));
    child.on('close', code => {
      if (settled) return;
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
