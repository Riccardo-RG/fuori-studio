import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { trustedOrigin } from './sync.mjs';
import { validateRepositoryChecks } from './repository-work.mjs';
import { repositoryPolicyHash } from './repository-devices.ts';

export interface WorkerStorage { read(key: string, fallback?: unknown): Promise<unknown>; write(key: string, value: unknown): Promise<unknown>; }
export interface RepositoryCommand { label: string; program: string; args: string[]; }
export interface WorkerConnection { url: string; token: string; deviceId: string; name?: string; scopeIds: string[]; capabilities: string[]; expiresAt: number; }
export interface RepositoryInspection { path: string; name: string; head: string; branch: string | null; dirty: boolean; remote: string | null; }
export interface WorkerDependencies { status: 'not-needed' | 'missing' | 'reused-read-only'; reason: string; }
export interface WorkerEdit { text: string; usage?: { inputTokens: number | null; outputTokens: number | null } | null; durationMs: number; }
export interface WorkerDiff { patch: string; hash: string; files: Array<{ path: string; status: string; additions?: number; deletions?: number }>; stats: { files: number; additions: number; deletions: number }; truncated: false; }
export interface WorkerCheck extends RepositoryCommand { exitCode: number | null; output: string; durationMs: number; status: 'passed' | 'failed' | 'error'; truncated?: boolean; }
export interface RepositoryWorkerRuntime {
  inspect(path: string): Promise<RepositoryInspection>;
  prepare(input: { path: string; baseCommit: string; runId: string }): Promise<{ cwd: string; baseCommit: string; dependencies?: WorkerDependencies }>;
  edit(input: { cwd: string; prompt: string; signal: AbortSignal }): Promise<WorkerEdit>;
  check(input: { cwd: string; command: RepositoryCommand; signal: AbortSignal }): Promise<WorkerCheck>;
  diff(input: { cwd: string; baseCommit: string }): Promise<WorkerDiff>;
}
export interface RepositoryJob { id: string; lease: string; runId: string; scopeId: string; alias: string; baseCommit: string; policyHash: string; prompt: string; checks: RepositoryCommand[]; expiresAt: number; }
export interface RepositoryReceipt { version: 1; runId: string; baseCommit: string; alias: string; policyHash: string; edited: WorkerEdit; beforeHash: string; diff: WorkerDiff; checks: WorkerCheck[]; dependencies?: WorkerDependencies; }
interface RepositoryPolicy { alias: string; path: string; scopeIds: string[]; checks: RepositoryCommand[]; policyHash: string; updatedAt: string; server: string; deviceId: string; }
interface WorkerFailure { code: string; message: string; }
interface Delivery { id: string; lease: string; result?: RepositoryReceipt; error?: WorkerFailure; }
type JournalStatus = 'running' | 'pending' | 'delivered' | 'rejected';
interface JournalEntry {
  key: string; server: string; deviceId: string; jobId: string; runId: string; alias: string; scopeId: string;
  baseCommit: string; policyHash: string; fingerprint: string; expiresAt: number; lease: string;
  status: JournalStatus; stage: 'preparing' | 'editing' | 'checking'; startedAt: string; completedAt: string | null;
  delivery: Delivery | null; resultHash: string | null; attempts: number; retryAt: number; errorCode: string | null;
}
interface WorkerState { version: 1; policies: RepositoryPolicy[]; journal: JournalEntry[]; }
export interface RepositoryWorkerOptions {
  storage: WorkerStorage; runtime: RepositoryWorkerRuntime; connection: WorkerConnection;
  request: (path: string, payload: unknown, signal?: AbortSignal) => Promise<unknown>;
  now?: () => number; heartbeatMs?: number; requestTimeoutMs?: number;
}
const KEY = 'repository-worker', PREFIX = '/api/device/repositories/';
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const aliasPattern = /^[a-z][a-z0-9_-]{0,59}$/;
const clone = <T>(value: T): T => structuredClone(value);
const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const failure = (message: string, code = 'WORKER_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode, status: statusCode });
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): string => { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw failure('Identificativo worker non valido.'); return value; };
function scopes(value: unknown): string[] { if (!Array.isArray(value) || !value.length || value.length > 200 || new Set(value).size !== value.length) throw failure('Scegli ambiti distinti e autorizzati.'); return value.map(id).sort(); }
function alias(value: unknown): string { if (typeof value !== 'string' || !aliasPattern.test(value)) throw failure('Alias: usa una lettera iniziale e fino a 60 lettere minuscole, numeri, trattini o underscore.'); return value; }
function commands(value: unknown): RepositoryCommand[] { return validateRepositoryChecks(value) as RepositoryCommand[]; }
function codeOf(error: unknown): string { return object(error) && typeof error.code === 'string' ? error.code : 'WORKER_FAILED'; }
function safeFailure(error: unknown): WorkerFailure {
  const code = codeOf(error);
  const accepted = /^(?:WORKER_[A-Z_]+|LEASE_LOST|SANDBOX_UNAVAILABLE|REPOSITORY_[A-Z_]+)$/.test(code) ? code : 'WORKER_FAILED';
  return { code: accepted, message: accepted === 'WORKER_INTERRUPTED' ? 'Worker interrotto. Nessuna riesecuzione automatica.' : accepted === 'LEASE_LOST' ? 'Autorizzazione di esecuzione persa. Nessuna riesecuzione automatica.' : accepted === 'SANDBOX_UNAVAILABLE' ? 'Sandbox del computer non disponibile. Nessuna esecuzione senza isolamento.' : 'Il lavoro repository non è stato completato. Verifica il computer prima di creare un nuovo incarico.' };
}
function validateState(raw: unknown): WorkerState {
  if (!object(raw) || raw.version !== 1 || !Array.isArray(raw.policies) || raw.policies.length > 100 || !Array.isArray(raw.journal) || raw.journal.length > 10000) throw failure('Archivio worker non valido.', 'WORKER_CORRUPT', 503);
  const aliases = new Set<string>(), keys = new Set<string>();
  for (const item of raw.policies) {
    if (!object(item) || typeof item.path !== 'string' || !isAbsolute(item.path) || item.path.includes('\0') || typeof item.updatedAt !== 'string' || !Number.isFinite(Date.parse(item.updatedAt))) throw failure('Politica repository non valida.', 'WORKER_CORRUPT', 503);
    const selectedAlias = alias(item.alias), selectedScopes = scopes(item.scopeIds), checks = commands(item.checks);
    id(item.deviceId); if (typeof item.server !== 'string' || trustedOrigin(item.server) !== item.server) throw failure('Studio della politica non valido.', 'WORKER_CORRUPT', 503);
    if (aliases.has(selectedAlias) || item.policyHash !== repositoryPolicyHash({ alias: selectedAlias, checks, scopeIds: selectedScopes })) throw failure('Politica repository incoerente.', 'WORKER_CORRUPT', 503);
    aliases.add(selectedAlias);
  }
  for (const entry of raw.journal) {
    if (!object(entry) || typeof entry.key !== 'string' || !HASH.test(entry.key) || keys.has(entry.key) || !['running', 'pending', 'delivered', 'rejected'].includes(String(entry.status)) || typeof entry.lease !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(entry.lease) || typeof entry.startedAt !== 'string' || !Number.isFinite(Date.parse(entry.startedAt)) || !Number.isSafeInteger(entry.attempts) || Number(entry.attempts) < 0 || typeof entry.expiresAt !== 'number' || !Number.isFinite(entry.expiresAt) || typeof entry.retryAt !== 'number' || !Number.isFinite(entry.retryAt)) throw failure('Registro esecuzioni worker non valido.', 'WORKER_CORRUPT', 503);
    id(entry.jobId); id(entry.runId); id(entry.deviceId); id(entry.scopeId); alias(entry.alias);
    if (typeof entry.server !== 'string' || trustedOrigin(entry.server) !== entry.server || typeof entry.baseCommit !== 'string' || !COMMIT.test(entry.baseCommit) || typeof entry.policyHash !== 'string' || !HASH.test(entry.policyHash) || typeof entry.fingerprint !== 'string' || !HASH.test(entry.fingerprint)) throw failure('Identità incarico worker non valida.', 'WORKER_CORRUPT', 503);
    if (entry.key !== hash([entry.server, entry.deviceId, entry.jobId]) || (entry.delivery !== null && (!object(entry.delivery) || entry.delivery.id !== entry.jobId || entry.delivery.lease !== entry.lease || entry.resultHash !== hash(entry.delivery)))) throw failure('Consegna worker incoerente.', 'WORKER_CORRUPT', 503);
    if (entry.status === 'pending' && !entry.delivery) throw failure('Consegna worker mancante.', 'WORKER_CORRUPT', 503);
    keys.add(entry.key);
  }
  return raw as unknown as WorkerState;
}

export function createRepositoryWorker({ storage, runtime, connection: inputConnection, request, now = Date.now, heartbeatMs = 8000, requestTimeoutMs = 15000 }: RepositoryWorkerOptions) {
  const connection = clone(inputConnection), server = trustedOrigin(connection.url);
  id(connection.deviceId); scopes(connection.scopeIds);
  if (!connection.capabilities?.includes('repository') || typeof connection.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(connection.token) || !Number.isFinite(connection.expiresAt)) throw failure('Il collegamento non abilita i repository.', 'WORKER_CAPABILITY_DENIED', 403);
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 10 || heartbeatMs > 10000 || !Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 10 || requestTimeoutMs > 15000) throw failure('Intervallo worker non valido.');
  let queue: Promise<unknown> = Promise.resolve(), busy = false, recovered = false;
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  const stamp = () => new Date(now()).toISOString();
  const authorized = () => { if (connection.expiresAt <= now()) throw failure('Collegamento repository scaduto. Associa di nuovo il computer.', 'WORKER_UNAUTHORIZED', 401); };
  const load = async () => validateState(await storage.read(KEY, { version: 1, policies: [], journal: [] }));
  async function save(state: WorkerState): Promise<void> {
    const receipts = state.journal.filter(item => ['delivered', 'rejected'].includes(item.status) && item.delivery).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    for (const entry of receipts.slice(2)) entry.delivery = null;
    validateState(state);
    if (Buffer.byteLength(JSON.stringify(state)) > 28 * 1024 * 1024) throw failure('Registro worker pieno. Nessuna nuova esecuzione consentita.', 'WORKER_STORAGE_FULL', 413);
    await storage.write(KEY, state);
  }
  async function update(key: string, fn: (entry: JournalEntry) => void): Promise<JournalEntry> { return serial(async () => { const state = await load(), entry = state.journal.find(item => item.key === key); if (!entry) throw failure('Registro incarico non trovato.', 'WORKER_CORRUPT', 503); fn(entry); await save(state); return clone(entry); }); }
  async function call(path: string, payload: unknown, signal?: AbortSignal): Promise<unknown> {
    authorized(); if (signal?.aborted) throw failure('Worker interrotto.', 'WORKER_INTERRUPTED', 499);
    const controller = new AbortController(); let rejectAbort: (reason: unknown) => void = () => {};
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const stop = (timeout: boolean) => { const error = failure(timeout ? 'Collegamento worker scaduto.' : 'Worker interrotto.', timeout ? 'WORKER_NETWORK_TIMEOUT' : 'WORKER_INTERRUPTED', timeout ? 408 : 499); controller.abort(error); rejectAbort(error); };
    const abort = () => stop(false); signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(true), requestTimeoutMs);
    try { return await Promise.race([Promise.resolve().then(() => { if (signal?.aborted) stop(false); if (controller.signal.aborted) throw controller.signal.reason; return request(PREFIX + path, payload, controller.signal); }), aborted]); }
    finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
  async function recover(): Promise<void> {
    await serial(async () => {
      if (recovered) return;
      const state = await load();
      for (const entry of state.journal.filter(item => item.status === 'running')) {
        entry.status = 'pending'; entry.completedAt = stamp(); entry.errorCode = 'WORKER_INTERRUPTED';
        entry.delivery = { id: entry.jobId, lease: entry.lease, error: safeFailure(failure('Worker riavviato.', 'WORKER_INTERRUPTED')) }; entry.resultHash = hash(entry.delivery); entry.retryAt = now();
      }
      for (const entry of state.journal.filter(item => item.status === 'pending' && (item.server !== server || item.deviceId !== connection.deviceId))) { entry.status = 'rejected'; entry.errorCode = 'WORKER_CONNECTION_CHANGED'; }
      await save(state); recovered = true;
    });
  }
  function parseJob(value: unknown): RepositoryJob {
    if (!object(value) || Object.keys(value).some(key => !['id', 'lease', 'runId', 'scopeId', 'alias', 'baseCommit', 'policyHash', 'prompt', 'checks', 'expiresAt'].includes(key))) throw failure('Manifest repository non valido.', 'WORKER_MANIFEST_DENIED', 403);
    id(value.id); id(value.runId); id(value.scopeId); alias(value.alias);
    if (typeof value.lease !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value.lease) || typeof value.baseCommit !== 'string' || !COMMIT.test(value.baseCommit) || typeof value.policyHash !== 'string' || !HASH.test(value.policyHash) || typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > 120000 || value.prompt.includes('\0') || typeof value.expiresAt !== 'number' || value.expiresAt <= now() || value.expiresAt > now() + 31 * 60000) throw failure('Manifest repository scaduto o non valido.', 'WORKER_MANIFEST_DENIED', 403);
    const checks = commands(value.checks);
    return { ...(value as unknown as RepositoryJob), checks };
  }
  async function deliver(entry: JournalEntry, signal?: AbortSignal): Promise<boolean> {
    if (entry.status !== 'pending' || !entry.delivery || entry.retryAt > now()) return false;
    if (entry.server !== server || entry.deviceId !== connection.deviceId) return false;
    if (now() > Date.parse(entry.completedAt || entry.startedAt) + 86400000) { await update(entry.key, item => { item.status = 'rejected'; item.errorCode = 'WORKER_DELIVERY_EXPIRED'; }); return false; }
    try {
      const response = await call('result', entry.delivery, signal);
      if (!object(response) || response.ok !== true) throw failure('Consegna non riconosciuta.', 'WORKER_DELIVERY_INVALID', 502);
      await update(entry.key, item => { item.status = 'delivered'; item.attempts++; item.retryAt = 0; }); return true;
    } catch (error) {
      const status = object(error) ? Number(error.statusCode ?? error.status) : 0;
      await update(entry.key, item => { item.attempts++; item.retryAt = now() + 10000; if (status >= 400 && status < 500 && ![408, 429, 499].includes(status)) { item.status = 'rejected'; item.errorCode = status === 401 || status === 403 ? 'WORKER_UNAUTHORIZED' : 'WORKER_DELIVERY_REJECTED'; } });
      return false;
    }
  }
  async function flush(signal?: AbortSignal): Promise<void> {
    const entries = await serial(async () => (await load()).journal.filter(item => item.status === 'pending' && item.server === server && item.deviceId === connection.deviceId).map(clone));
    for (const entry of entries) { if (signal?.aborted) return; await deliver(entry, signal); }
  }
  function validateReceipt(receipt: RepositoryReceipt): void {
    if (!receipt.edited || typeof receipt.edited.text !== 'string' || !receipt.edited.text.trim() || receipt.edited.text.length > 128000 || !Number.isFinite(receipt.edited.durationMs) || receipt.edited.durationMs < 0 || !HASH.test(receipt.beforeHash)) throw failure('Risultato editor non valido.', 'WORKER_RECEIPT_INVALID');
    const diff = receipt.diff;
    if (!diff || typeof diff.patch !== 'string' || Buffer.byteLength(diff.patch) > 2 * 1024 * 1024 || diff.truncated !== false || hash(diff.patch) !== diff.hash || !Array.isArray(diff.files) || diff.files.length > 2000 || diff.stats?.files !== diff.files.length || !Number.isSafeInteger(diff.stats.additions) || !Number.isSafeInteger(diff.stats.deletions)) throw failure('Patch worker non valida o incompleta.', 'WORKER_RECEIPT_INVALID');
    for (const check of receipt.checks) if (!['passed', 'failed', 'error'].includes(check.status) || typeof check.output !== 'string' || check.output.length > 12000 || !Number.isFinite(check.durationMs) || check.durationMs < 0 || (check.status === 'passed' ? check.exitCode !== 0 : check.status === 'failed' ? !Number.isInteger(check.exitCode) || check.exitCode === 0 : check.exitCode !== null)) throw failure('Esito controllo non valido.', 'WORKER_RECEIPT_INVALID');
    if (Buffer.byteLength(JSON.stringify(receipt)) > 4 * 1024 * 1024) throw failure('Consegna worker troppo grande.', 'WORKER_RECEIPT_INVALID', 413);
  }
  async function execute(job: RepositoryJob, policy: RepositoryPolicy, entry: JournalEntry, parentSignal?: AbortSignal): Promise<void> {
    const controller = new AbortController(); let stage: JournalEntry['stage'] = 'preparing', leaseLost = false, renewing = false;
    const stop = () => controller.abort(failure('Worker interrotto.', 'WORKER_INTERRUPTED', 499));
    const checkActive = () => { if (controller.signal.aborted || parentSignal?.aborted) throw failure('Worker interrotto.', leaseLost ? 'LEASE_LOST' : 'WORKER_INTERRUPTED', 499); };
    parentSignal?.addEventListener('abort', stop, { once: true }); if (parentSignal?.aborted) stop();
    const heartbeat = async () => {
      if (renewing || controller.signal.aborted) return; renewing = true;
      try { const response = await call('heartbeat', { id: job.id, lease: job.lease, stage }, controller.signal); if (!object(response) || response.ok !== true) throw failure('Lease non valido.', 'LEASE_LOST', 409); }
      catch { leaseLost = true; controller.abort(failure('Lease perso.', 'LEASE_LOST', 409)); }
      finally { renewing = false; }
    };
    const timer = setInterval(() => { void heartbeat(); }, heartbeatMs);
    const expiry = setTimeout(() => { leaseLost = true; controller.abort(failure('Lease scaduto.', 'LEASE_LOST', 409)); }, Math.max(1, job.expiresAt - now()));
    let delivery: Delivery;
    try {
      await heartbeat(); checkActive();
      const inspected = await runtime.inspect(policy.path); checkActive();
      if (inspected.head !== job.baseCommit || inspected.path !== policy.path) throw failure('Base repository cambiata.', 'REPOSITORY_STALE_BASE', 409);
      const prepared = await runtime.prepare({ path: policy.path, baseCommit: job.baseCommit, runId: 'remote-' + entry.key.slice(0, 48) }); checkActive();
      if (prepared.baseCommit !== job.baseCommit || typeof prepared.cwd !== 'string' || !isAbsolute(prepared.cwd)) throw failure('Snapshot non valido.', 'WORKER_RECEIPT_INVALID');
      stage = 'editing'; await update(entry.key, item => { item.stage = stage; }); await heartbeat(); checkActive();
      const edited = await runtime.edit({ cwd: prepared.cwd, prompt: job.prompt, signal: controller.signal }); checkActive();
      const before = await runtime.diff({ cwd: prepared.cwd, baseCommit: job.baseCommit }); checkActive();
      stage = 'checking'; await update(entry.key, item => { item.stage = stage; }); await heartbeat(); checkActive();
      const checks: WorkerCheck[] = [];
      for (const command of policy.checks) {
        const result = await runtime.check({ cwd: prepared.cwd, command: clone(command), signal: controller.signal }); checkActive();
        if (result.label !== command.label || result.program !== command.program || JSON.stringify(result.args) !== JSON.stringify(command.args) || typeof result.output !== 'string') throw failure('Il controllo eseguito non corrisponde alla politica locale.', 'WORKER_RECEIPT_INVALID');
        const truncated = result.output.length > 12000 || result.truncated === true;
        checks.push({ ...clone(command), exitCode: truncated ? null : result.exitCode, status: truncated ? 'error' : result.status, output: truncated ? result.output.slice(0, 11800) + `\n[Output troncato; codice originale: ${result.exitCode}. Evidenza incompleta: il controllo non abilita l’approvazione.]` : result.output, durationMs: result.durationMs, truncated });
      }
      const diff = await runtime.diff({ cwd: prepared.cwd, baseCommit: job.baseCommit }); checkActive();
      const result: RepositoryReceipt = { version: 1, runId: job.runId, baseCommit: job.baseCommit, alias: job.alias, policyHash: job.policyHash, edited: { text: edited.text, usage: edited.usage ?? null, durationMs: edited.durationMs }, beforeHash: before.hash, diff, checks, ...(prepared.dependencies ? { dependencies: prepared.dependencies } : {}) };
      validateReceipt(result); delivery = { id: job.id, lease: job.lease, result };
    } catch (error) { delivery = { id: job.id, lease: job.lease, error: safeFailure(leaseLost ? failure('Lease perso.', 'LEASE_LOST') : controller.signal.aborted ? failure('Worker interrotto.', 'WORKER_INTERRUPTED') : error) }; }
    finally { clearInterval(timer); clearTimeout(expiry); parentSignal?.removeEventListener('abort', stop); }
    const finished = await update(entry.key, item => { item.status = 'pending'; item.completedAt = stamp(); item.delivery = delivery; item.resultHash = hash(delivery); item.errorCode = delivery.error?.code || null; item.retryAt = now(); });
    if (!parentSignal?.aborted) await deliver(finished, parentSignal);
  }
  async function catalog() {
    authorized(); const policies = await serial(async () => clone((await load()).policies.filter(item => item.server === server && item.deviceId === connection.deviceId))), repositories = [], blocked: Array<{ alias: string; code: string }> = [];
    for (const policy of policies) {
      try {
        if (policy.scopeIds.some(scopeId => !connection.scopeIds.includes(scopeId))) throw failure('Politica fuori ambito.', 'WORKER_SCOPE_DENIED', 403);
        const inspected = await runtime.inspect(policy.path);
        if (inspected.path !== policy.path) throw failure('Il percorso autorizzato è cambiato.', 'WORKER_PATH_CHANGED', 403);
        repositories.push({ alias: policy.alias, name: inspected.name, head: inspected.head, branch: inspected.branch, dirty: inspected.dirty, remote: inspected.remote, checks: clone(policy.checks), scopeIds: clone(policy.scopeIds), policyHash: policy.policyHash });
      } catch (error) { blocked.push({ alias: policy.alias, code: safeFailure(error).code }); }
    }
    return { repositories, blocked };
  }
  return {
    recover,
    async add({ alias: selected, path, scopeIds, checks }: { alias: string; path: string; scopeIds: string[]; checks: RepositoryCommand[] }) {
      if (busy) throw failure('Ferma il worker prima di cambiare le autorizzazioni.', 'WORKER_BUSY', 409);
      authorized(); alias(selected); const approvedScopes = scopes(scopeIds), approvedChecks = commands(checks);
      if (approvedScopes.some(scopeId => !connection.scopeIds.includes(scopeId))) throw failure('Gli ambiti devono essere inclusi nel collegamento del dispositivo.', 'WORKER_SCOPE_DENIED', 403);
      if (typeof path !== 'string' || !isAbsolute(path)) throw failure('Seleziona un percorso Git assoluto.');
      const inspected = await runtime.inspect(path);
      return serial(async () => { const state = await load(); if (state.policies.filter(item => item.server === server && item.deviceId === connection.deviceId && item.alias !== selected).length >= 30) throw failure('Autorizza al massimo trenta repository per questo collegamento.', 'WORKER_POLICY_FULL', 413); const policy: RepositoryPolicy = { alias: selected, path: inspected.path, scopeIds: approvedScopes, checks: approvedChecks, policyHash: repositoryPolicyHash({ alias: selected, checks: approvedChecks, scopeIds: approvedScopes }), updatedAt: stamp(), server, deviceId: connection.deviceId }; const old = state.policies.findIndex(item => item.alias === selected); if (old >= 0) state.policies[old] = policy; else state.policies.push(policy); await save(state); return clone(policy); });
    },
    async remove(selected: string) { if (busy) throw failure('Ferma il worker prima di cambiare le autorizzazioni.', 'WORKER_BUSY', 409); alias(selected); return serial(async () => { const state = await load(); state.policies = state.policies.filter(item => item.alias !== selected); await save(state); return { removed: selected }; }); },
    list: () => serial(async () => clone((await load()).policies.filter(item => item.server === server && item.deviceId === connection.deviceId))),
    status: () => serial(async () => { const state = await load(); return { policies: state.policies.map(({ path, ...item }) => clone(item)), journal: state.journal.slice(-100).reverse().map(({ delivery, lease, fingerprint, key, server: ignoredServer, deviceId: ignoredDevice, ...item }) => ({ ...clone(item), hasReceipt: Boolean(delivery?.result) })), pending: state.journal.filter(item => item.status === 'pending').length }; }),
    catalog,
    async announce(signal?: AbortSignal) { const inventory = await catalog(); await call('announce', { repositories: inventory.repositories }, signal); return inventory; },
    async pollOnce(signal?: AbortSignal) {
      if (busy) throw failure('Worker già in esecuzione.', 'WORKER_BUSY', 409);
      busy = true;
      try {
        await recover(); await flush(signal); if (signal?.aborted) return { status: 'interrupted' };
        const state = await serial(load);
        if (state.journal.length >= 10000 || state.journal.filter(item => item.status === 'pending').length >= 2) return { status: 'delivery-pending' };
        const response = await call('claim', {}, signal);
        if (!object(response) || !Object.hasOwn(response, 'job')) throw failure('Risposta incarico non valida.', 'WORKER_MANIFEST_DENIED', 403);
        if (response.job === null) return { status: 'idle' };
        const job = parseJob(response.job), key = hash([server, connection.deviceId, job.id]);
        const fingerprint = hash({ ...job, lease: undefined });
        const previous = state.journal.find(item => item.key === key || item.server === server && item.deviceId === connection.deviceId && item.runId === job.runId);
        if (previous) {
          if (previous.key === key && previous.fingerprint === fingerprint && previous.status === 'pending') await deliver(previous, signal);
          return { status: 'duplicate', jobId: job.id };
        }
        const policy = state.policies.find(item => item.alias === job.alias && item.server === server && item.deviceId === connection.deviceId);
        const policyValid = policy && connection.scopeIds.includes(job.scopeId) && policy.scopeIds.includes(job.scopeId) && policy.policyHash === job.policyHash && JSON.stringify(policy.checks) === JSON.stringify(job.checks);
        const entry: JournalEntry = { key, server, deviceId: connection.deviceId, jobId: job.id, runId: job.runId, alias: job.alias, scopeId: job.scopeId, baseCommit: job.baseCommit, policyHash: job.policyHash, fingerprint, expiresAt: job.expiresAt, lease: job.lease, status: 'running', stage: 'preparing', startedAt: stamp(), completedAt: null, delivery: null, resultHash: null, attempts: 0, retryAt: 0, errorCode: null };
        await serial(async () => { const fresh = await load(); if (fresh.journal.some(item => item.key === key)) throw failure('Incarico già registrato.', 'WORKER_DUPLICATE', 409); fresh.journal.push(entry); await save(fresh); });
        if (!policyValid || !policy) {
          const rejected = await update(key, item => { item.status = 'pending'; item.completedAt = stamp(); item.errorCode = 'WORKER_POLICY_DENIED'; item.delivery = { id: job.id, lease: job.lease, error: safeFailure(failure('Politica non autorizzata.', 'WORKER_POLICY_DENIED', 403)) }; item.resultHash = hash(item.delivery); item.retryAt = now(); });
          await deliver(rejected, signal); return { status: 'policy-denied', jobId: job.id };
        }
        await execute(job, policy, entry, signal);
        return { status: 'processed', jobId: job.id };
      } finally { busy = false; }
    },
  };
}
