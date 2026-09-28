import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { validateRepositoryChecks } from './repository-work.mjs';

export type RepositoryCommand = { label: string; program: string; args: string[] };
export type RepositoryAnnouncement = { alias: string; name: string; head: string; branch: string | null; dirty: boolean; remote: string | null; checks: RepositoryCommand[]; scopeIds: string[]; policyHash: string };
export type RepositoryStage = 'preparing' | 'editing' | 'checking';
export type RepositoryReceipt = {
  version: 1; runId: string; baseCommit: string; alias: string; policyHash: string;
  edited: { text: string; usage: { inputTokens: number | null; outputTokens: number | null } | null; durationMs: number };
  beforeHash: string;
  diff: { patch: string; hash: string; files: { path: string; status: 'A' | 'M' | 'D'; additions: number; deletions: number }[]; stats: { files: number; additions: number; deletions: number }; truncated: false };
  checks: (RepositoryCommand & { status: 'passed' | 'failed' | 'error'; exitCode: number | null; output: string; durationMs: number; truncated?: boolean })[];
  dependencies?: { status: 'not-needed' | 'missing' | 'reused-read-only'; reason: string };
};
export type RepositoryLeaseJob = { id: string; lease: string; runId: string; scopeId: string; alias: string; baseCommit: string; policyHash: string; prompt: string; checks: RepositoryCommand[]; expiresAt: number };
type Device = { id: string; name: string; scopeIds: string[]; capabilities: string[]; revokedAt: number | null; expiresAt: number; lastSeenAt: number; online?: boolean };
type Devices = { authenticate: (token: string, capability: string) => Promise<Device>; touch: (token: string, capability: string) => Promise<Device>; snapshot: () => Promise<{ devices: Device[] }> };
type Storage = { read: (key: string, fallback?: unknown) => Promise<unknown>; write: (key: string, value: unknown) => Promise<unknown>; batch: (entries: { key: string; value: unknown }[]) => Promise<unknown> };
type Job = { id: string; deviceId: string; runId: string; scopeId: string; alias: string; baseCommit: string; policyHash: string; prompt: string | null; checks: RepositoryCommand[]; status: 'queued' | 'leased' | 'completed' | 'failed' | 'cancelled'; stage: RepositoryStage | null; createdAt: number; expiresAt: number; leaseExpiresAt: number | null; leaseHash: string | null; resultHash: string | null; resultExpiresAt: number | null; errorCode: string | null };
type State = { version: 1; inventories: { deviceId: string; announcedAt: number; repositories: RepositoryAnnouncement[] }[]; jobs: Job[] };
type RunInput = { deviceId: string; alias: string; scopeId: string; runId: string; baseCommit: string; policyHash: string; prompt: string; checks: RepositoryCommand[]; signal?: AbortSignal; onProgress?: (value: { stage: RepositoryStage; jobId: string }) => void | Promise<void> };
const KEY = 'repository-devices', LEASE_MS = 30_000, PRESENCE_MS = 45_000, INVENTORY_MS = 60_000, JOB_MS = 30 * 60_000, RESULT_MS = 24 * 60 * 60_000;
const SHA = /^[a-f0-9]{64}$/, stages: RepositoryStage[] = ['preparing', 'editing', 'checking'];
const fail = (message: string, code = 'REPOSITORY_DEVICE_INVALID', statusCode = 400) => Object.assign(Error(message), { code, status: statusCode, statusCode });
const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const copy = <T>(value: T): T => structuredClone(value);
const canonical = (value: unknown): unknown => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const resultHash = (value: unknown) => digest(JSON.stringify(canonical(value)));
const seed = (): State => ({ version: 1, inventories: [], jobs: [] });
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) throw fail('Dati repository remoto non validi.'); }
function text(value: unknown, max: number, empty = false): string { if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim())) throw fail('Campo repository remoto vuoto o troppo lungo.'); return value; }
function id(value: unknown): string { const output = text(value, 100); if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(output) || ['__proto__', 'constructor', 'prototype'].includes(output)) throw fail('Identificativo repository remoto non valido.'); return output; }
function integer(value: unknown, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw fail('Numero repository remoto non valido.'); return value as number; }
function hash(value: unknown): string { if (typeof value !== 'string' || !SHA.test(value)) throw fail('Impronta repository remoto non valida.'); return value; }
function commit(value: unknown): string { if (typeof value !== 'string' || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) throw fail('Commit remoto non valido.'); return value; }
function scopeList(value: unknown): string[] { if (!Array.isArray(value) || !value.length || value.length > 200 || new Set(value).size !== value.length) throw fail('Ambiti repository remoto non validi.'); return value.map(id); }
function checks(value: unknown): RepositoryCommand[] { const result = validateRepositoryChecks(value) as RepositoryCommand[]; if (JSON.stringify(result).length > 32000) throw fail('Configurazione controlli troppo grande.'); return result; }
// Reject recognizable credentials; this is not complete semantic secret detection.
function noSecrets(value: string, known: string[] = []): void {
  if (known.some(secret => secret.length >= 20 && value.includes(secret)) || /-----BEGIN[\s\S]{0,50}PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b|\beyJ[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\.[a-zA-Z0-9_-]{8,}\b/i.test(value)) throw fail('Rimuovi le credenziali dai dati del repository remoto.', 'REPOSITORY_DEVICE_SECRET', 400);
}
export function repositoryPolicyHash(input: { alias: string; checks: RepositoryCommand[]; scopeIds: string[] }): string {
  return digest(JSON.stringify({ alias: id(input.alias), checks: checks(input.checks).map(({ label, program, args }) => ({ label, program, args })), scopeIds: scopeList(input.scopeIds).sort() }));
}
function announcement(value: unknown): RepositoryAnnouncement {
  object(value, ['alias', 'name', 'head', 'branch', 'dirty', 'remote', 'checks', 'scopeIds', 'policyHash']);
  const alias = id(value.alias), name = text(value.name, 120), configured = checks(value.checks), scopeIds = scopeList(value.scopeIds);
  if (/[\r\n\\/]/.test(name) || typeof value.dirty !== 'boolean') throw fail('Nome o stato repository remoto non valido.');
  const branch = value.branch === null ? null : text(value.branch, 200);
  if (branch !== null && (/^[\\/]|[\0\r\n]/.test(branch))) throw fail('Branch remoto non valido.');
  let remote: string | null = null;
  if (value.remote !== null) {
    remote = text(value.remote, 2000); let url: URL; try { url = new URL(remote); } catch { throw fail('URL remoto non valido.'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.port || !url.hostname.includes('.')) throw fail('URL remoto non consentito.');
  }
  const result = { alias, name, head: commit(value.head), branch, dirty: value.dirty, remote, checks: configured, scopeIds, policyHash: hash(value.policyHash) };
  if (repositoryPolicyHash(result) !== result.policyHash) throw fail('La politica repository non corrisponde ai controlli annunciati.', 'REPOSITORY_POLICY_MISMATCH', 409);
  noSecrets(JSON.stringify(result)); return result;
}
function relativePath(value: unknown): string {
  const path = text(value, 1024);
  if (/^[\\/]|[\0\r\n\t\\]|^[a-zA-Z]:/.test(path) || path.split('/').some(part => !part || ['.', '..', '.git', '.codex', '.agents', '.ssh', '.aws', '.local', 'node_modules'].includes(part.toLowerCase())) || /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|\.npmrc|\.netrc|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519|[^/]+\.(?:p12|pfx|pem|key))$/i.test(path)) throw fail('Percorso patch remoto non consentito.');
  return path;
}
function gitQuoted(value: string): string {
  const escapes: Record<number, string> = { 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r', 34: '\\"', 92: '\\\\' };
  return '"' + [...Buffer.from(value, 'utf8')].map(byte => escapes[byte] ?? (byte < 32 || byte >= 127 ? '\\' + byte.toString(8).padStart(3, '0') : String.fromCharCode(byte))).join('') + '"';
}
function patchMetadata(patch: string, files: RepositoryReceipt['diff']['files']): void {
  const headers = new Map<string, RepositoryReceipt['diff']['files'][number]>();
  for (const file of files) {
    const a = 'a/' + file.path, b = 'b/' + file.path;
    for (const left of [a, gitQuoted(a)]) for (const right of [b, gitQuoted(b)]) headers.set(`diff --git ${left} ${right}`, file);
  }
  const seen = new Set<string>(); let current: RepositoryReceipt['diff']['files'][number] | undefined, additions = 0, deletions = 0, inHunk = false, status = 'M';
  const finish = () => { if (current && (current.additions !== additions || current.deletions !== deletions || current.status !== status)) throw fail('I metadati non corrispondono alla patch remota.', 'REPOSITORY_RECEIPT_INVALID', 409); };
  for (const line of patch.split('\n')) {
    if (line.startsWith('diff --git ')) {
      finish(); current = headers.get(line); if (!current || seen.has(current.path)) throw fail('Percorso nella patch diverso dall’elenco dei file.', 'REPOSITORY_RECEIPT_INVALID', 409);
      seen.add(current.path); additions = 0; deletions = 0; inHunk = false; status = 'M'; continue;
    }
    if (!current) { if (line.trim()) throw fail('Intestazione patch remota non valida.'); continue; }
    if (line.startsWith('@@ ')) { inHunk = true; continue; }
    if (inHunk) { if (line.startsWith('+')) additions++; else if (line.startsWith('-')) deletions++; continue; }
    if (line.startsWith('new file mode ')) status = 'A';
    if (line.startsWith('deleted file mode ')) status = 'D';
    for (const [prefix, part] of [['--- ', 'a/'], ['+++ ', 'b/']]) {
      if (!line.startsWith(prefix)) continue;
      const path = line.slice(prefix.length).replace(/\t$/, '');
      if (path !== '/dev/null' && path !== part + current.path && path !== gitQuoted(part + current.path)) throw fail('Percorso destinazione patch non autorizzato.', 'REPOSITORY_RECEIPT_INVALID', 409);
    }
  }
  finish(); if (seen.size !== files.length) throw fail('Elenco file non corrispondente alla patch.', 'REPOSITORY_RECEIPT_INVALID', 409);
}
function receipt(value: unknown, job: Job, known: string[] = []): RepositoryReceipt {
  object(value, ['version', 'runId', 'baseCommit', 'alias', 'policyHash', 'edited', 'beforeHash', 'diff', 'checks', 'dependencies']);
  if (value.version !== 1 || value.runId !== job.runId || value.baseCommit !== job.baseCommit || value.alias !== job.alias || value.policyHash !== job.policyHash) throw fail('La ricevuta non corrisponde all’incarico assegnato.', 'REPOSITORY_RECEIPT_MISMATCH', 409);
  object(value.edited, ['text', 'usage', 'durationMs']); text(value.edited.text, 128000); integer(value.edited.durationMs, JOB_MS);
  if (value.edited.usage !== null) { object(value.edited.usage, ['inputTokens', 'outputTokens']); for (const key of ['inputTokens', 'outputTokens']) if (value.edited.usage[key] !== null) integer(value.edited.usage[key]); }
  hash(value.beforeHash); object(value.diff, ['patch', 'hash', 'files', 'stats', 'truncated']);
  const patch = text(value.diff.patch, 2 * 1024 * 1024, true); if (Buffer.byteLength(patch) > 2 * 1024 * 1024 || value.diff.truncated !== false || digest(patch) !== hash(value.diff.hash)) throw fail('Patch remota incompleta o impronta errata.', 'REPOSITORY_RECEIPT_INVALID', 409);
  if (!Array.isArray(value.diff.files) || value.diff.files.length > 2000) throw fail('Elenco file patch non valido.');
  const paths = new Set<string>(); let additions = 0, deletions = 0;
  for (const file of value.diff.files) { object(file, ['path', 'status', 'additions', 'deletions']); const path = relativePath(file.path); if (paths.has(path) || !['A', 'M', 'D'].includes(String(file.status))) throw fail('File patch duplicato o tipo non valido.'); paths.add(path); additions += integer(file.additions, 2_000_000); deletions += integer(file.deletions, 2_000_000); }
  object(value.diff.stats, ['files', 'additions', 'deletions']); if (value.diff.stats.files !== paths.size || value.diff.stats.additions !== additions || value.diff.stats.deletions !== deletions || Boolean(patch.trim()) !== Boolean(paths.size)) throw fail('Statistiche patch remote incoerenti.');
  if (/^GIT binary patch$|^Binary files .* differ$|^(?:new file mode|old mode|new mode) (?:120000|160000)$/m.test(patch)) throw fail('Patch binaria o tipo file non supportato.');
  patchMetadata(patch, value.diff.files as RepositoryReceipt['diff']['files']);
  if (!Array.isArray(value.checks) || value.checks.length !== job.checks.length) throw fail('La ricevuta non contiene tutti i controlli configurati.', 'REPOSITORY_CHECKS_MISMATCH', 409);
  for (const [index, check] of value.checks.entries()) {
    object(check, ['label', 'program', 'args', 'status', 'exitCode', 'output', 'durationMs', 'truncated']);
    if (JSON.stringify({ label: check.label, program: check.program, args: check.args }) !== JSON.stringify(job.checks[index])) throw fail('Controlli diversi da quelli autorizzati.', 'REPOSITORY_CHECKS_MISMATCH', 409);
    if (!['passed', 'failed', 'error'].includes(String(check.status)) || check.truncated !== undefined && typeof check.truncated !== 'boolean') throw fail('Stato controllo non valido.');
    if (check.exitCode !== null && (!Number.isSafeInteger(check.exitCode) || (check.exitCode as number) < -255 || (check.exitCode as number) > 255)) throw fail('Codice uscita non valido.');
    if (check.status === 'passed' && (check.exitCode !== 0 || check.truncated === true) || check.status !== 'passed' && check.exitCode === 0) throw fail('Esito controllo remoto incoerente.');
    text(check.output, 12000, true); integer(check.durationMs, JOB_MS);
  }
  if (value.dependencies !== undefined) { object(value.dependencies, ['status', 'reason']); if (!['not-needed', 'missing', 'reused-read-only'].includes(String(value.dependencies.status))) throw fail('Dipendenze remote non valide.'); text(value.dependencies.reason, 1000); }
  const serialized = JSON.stringify(value); if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw fail('Ricevuta repository troppo grande.', 'REPOSITORY_RECEIPT_LIMIT', 413); noSecrets(serialized, known);
  return copy(value) as RepositoryReceipt;
}
function validatedState(value: unknown): State {
  try {
    object(value, ['version', 'inventories', 'jobs']);
    if (value.version !== 1 || !Array.isArray(value.inventories) || value.inventories.length > 20 || !Array.isArray(value.jobs) || value.jobs.length > 500 || Buffer.byteLength(JSON.stringify(value)) > 16 * 1024 * 1024) throw fail('Limite archivio repository remoto superato.');
    const deviceIds = new Set<string>(), jobIds = new Set<string>(), runIds = new Set<string>();
    for (const inventory of value.inventories) {
      object(inventory, ['deviceId', 'announcedAt', 'repositories']); id(inventory.deviceId); integer(inventory.announcedAt);
      if (deviceIds.has(inventory.deviceId as string) || !Array.isArray(inventory.repositories) || inventory.repositories.length > 30) throw fail('Catalogo repository remoto non valido.'); deviceIds.add(inventory.deviceId as string);
      const aliases = new Set<string>(); for (const raw of inventory.repositories) { const item = announcement(raw); if (aliases.has(item.alias)) throw fail('Alias duplicato.'); aliases.add(item.alias); }
    }
    for (const job of value.jobs) {
      object(job, ['id', 'deviceId', 'runId', 'scopeId', 'alias', 'baseCommit', 'policyHash', 'prompt', 'checks', 'status', 'stage', 'createdAt', 'expiresAt', 'leaseExpiresAt', 'leaseHash', 'resultHash', 'resultExpiresAt', 'errorCode']);
      for (const field of ['id', 'deviceId', 'runId', 'scopeId', 'alias']) id(job[field]); commit(job.baseCommit); hash(job.policyHash); checks(job.checks);
      if (jobIds.has(job.id as string) || runIds.has(job.runId as string) || !['queued', 'leased', 'completed', 'failed', 'cancelled'].includes(String(job.status)) || job.stage !== null && !stages.includes(job.stage as RepositoryStage)) throw fail('Stato incarico remoto non valido.');
      jobIds.add(job.id as string); runIds.add(job.runId as string); integer(job.createdAt); integer(job.expiresAt);
      if ((job.expiresAt as number) <= (job.createdAt as number) || (job.expiresAt as number) - (job.createdAt as number) > JOB_MS) throw fail('Scadenza incarico remoto non valida.');
      for (const field of ['leaseExpiresAt', 'resultExpiresAt']) if (job[field] !== null) integer(job[field]);
      for (const field of ['leaseHash', 'resultHash']) if (job[field] !== null) hash(job[field]);
      if (job.errorCode !== null && (typeof job.errorCode !== 'string' || !/^[A-Z_]{1,80}$/.test(job.errorCode))) throw fail('Errore remoto non valido.');
      if (['queued', 'leased'].includes(String(job.status))) { text(job.prompt, 120000); if (job.status === 'leased' && (!job.leaseHash || !job.leaseExpiresAt || !job.stage)) throw fail('Lease remoto mancante.'); }
      else if (job.prompt !== null) throw fail('Prompt conservato dopo completamento.');
      if (job.status === 'completed' && (!job.resultHash || !job.leaseHash)) throw fail('Ricevuta remota mancante.');
    }
    return value as State;
  } catch { throw fail('Archivio repository remoto danneggiato o incompatibile. I dati sono stati conservati.', 'REPOSITORY_DEVICE_CORRUPT', 503); }
}
const safeErrors = new Set(['WORKER_INTERRUPTED', 'LEASE_LOST', 'SANDBOX_UNAVAILABLE', 'REPOSITORY_SANDBOX_UNAVAILABLE', 'REPOSITORY_EDIT_FAILED', 'REPOSITORY_CHECK_FAILED', 'REPOSITORY_TIMEOUT', 'REPOSITORY_OUTPUT_LIMIT', 'REPOSITORY_INVALID', 'REPOSITORY_STALE_BASE', 'REPOSITORY_POLICY_CHANGED', 'REPOSITORY_BINARY_DIFF', 'REPOSITORY_UNSAFE_ENTRY', 'REPOSITORY_SOURCE_CHANGED', 'REPOSITORY_FAILED']);
const messages: Record<string, string> = {
  SANDBOX_UNAVAILABLE: 'Il sandbox del computer collegato non è disponibile. Nessuna esecuzione senza isolamento.',
  REPOSITORY_SANDBOX_UNAVAILABLE: 'Il sandbox del computer collegato non è disponibile. Nessuna esecuzione senza isolamento.',
  REPOSITORY_DEVICE_EXPIRED: 'Il computer non ha rinnovato l’incarico entro la scadenza. Nessuna ripetizione automatica.',
  REPOSITORY_POLICY_CHANGED: 'La configurazione del repository o i suoi permessi sono cambiati. Prepara un nuovo incarico.',
  WORKER_INTERRUPTED: 'Il lavoro remoto è stato interrotto. Verifica lo stato prima di creare una nuova revisione.',
};
const terminal = (job: Job, status: 'failed' | 'cancelled', code: string) => { job.status = status; job.errorCode = code; job.prompt = null; job.leaseExpiresAt = null; };

/** Scoped remote coding jobs. A lease may report a result once; expiry never
 * reassigns work. The authenticated worker is an execution trust boundary,
 * not a cryptographic attestation that its recorded commands really ran. */
export function createRepositoryDeviceHub({ storage, devices, now = Date.now, pollMs = 250 }: { storage: Storage; devices: Devices; now?: () => number; pollMs?: number }) {
  if (!Number.isInteger(pollMs) || pollMs < 1 || pollMs > 5000) throw fail('Intervallo polling non valido.');
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  const time = () => integer(now());
  const receiptKey = (jobId: string) => `${KEY}/result/${jobId}`;
  async function save(state: State, extra: { key: string; value: unknown }[] = []) { validatedState(state); await storage.batch([...extra, { key: KEY, value: state }]); }
  async function load() {
    const state = validatedState(await storage.read(KEY, seed())); let changed = false; const remove: { key: string; value: null }[] = [];
    for (const job of state.jobs) {
      if ((job.status === 'queued' || job.status === 'leased') && (job.expiresAt <= time() || job.status === 'leased' && job.leaseExpiresAt! <= time())) { terminal(job, 'failed', 'REPOSITORY_DEVICE_EXPIRED'); changed = true; }
      if (job.resultExpiresAt !== null && job.resultExpiresAt <= time()) { job.resultExpiresAt = null; remove.push({ key: receiptKey(job.id), value: null }); changed = true; }
    }
    if (changed) await save(state, remove); return state;
  }
  function activeDevice(device: Device | undefined, scopeId?: string, online = false): asserts device is Device {
    if (!device || device.revokedAt || device.expiresAt <= time() || !device.capabilities.includes('repository')) throw fail('Computer non autorizzato per i repository.', 'REPOSITORY_DEVICE_UNAUTHORIZED', 403);
    if (scopeId && !device.scopeIds.includes(scopeId)) throw fail('Il computer non è autorizzato per questo ambito.', 'REPOSITORY_DEVICE_SCOPE', 403);
    if (online && (device.online === false || !device.lastSeenAt || device.lastSeenAt <= time() - PRESENCE_MS)) throw fail('Il computer repository è offline. Avvialo prima di continuare.', 'REPOSITORY_DEVICE_OFFLINE', 409);
  }
  function authorizedRepository(state: State, device: Device, alias: string, scopeId: string, fresh: boolean, policyHash?: string) {
    activeDevice(device, scopeId, fresh);
    const inventory = state.inventories.find(item => item.deviceId === device.id), repository = inventory?.repositories.find(item => item.alias === alias);
    if (!inventory || !repository || !repository.scopeIds.includes(scopeId)) throw fail('Repository non annunciato o ambito non consentito.', 'REPOSITORY_DEVICE_SCOPE', 403);
    if (fresh && inventory.announcedAt <= time() - INVENTORY_MS) throw fail('Aggiorna il catalogo dal computer collegato prima di avviare il lavoro.', 'REPOSITORY_CATALOG_STALE', 409);
    if (policyHash && repository.policyHash !== policyHash) throw fail('La politica del repository è cambiata.', 'REPOSITORY_POLICY_CHANGED', 409);
    return repository;
  }
  const knownDevice = async (deviceId: string) => (await devices.snapshot()).devices.find(item => item.id === deviceId);
  function leaseJob(state: State, device: Device, payload: Record<string, unknown>) {
    id(payload.id); const lease = text(payload.lease, 100); if (!/^[a-zA-Z0-9_-]{43}$/.test(lease)) throw fail('Lease repository non valido.', 'REPOSITORY_STALE_LEASE', 409);
    const job = state.jobs.find(item => item.id === payload.id && item.deviceId === device.id);
    if (!job || !job.leaseHash || job.leaseHash !== digest(lease)) throw fail('Lease repository scaduto o non valido.', 'REPOSITORY_STALE_LEASE', 409);
    activeDevice(device, job.scopeId); authorizedRepository(state, device, job.alias, job.scopeId, false, job.policyHash);
    return job;
  }
  async function cancel(jobId: string, code = 'REPOSITORY_DEVICE_ABORTED') {
    await serial(async () => { const state = await load(), job = state.jobs.find(item => item.id === jobId); if (job && ['queued', 'leased'].includes(job.status)) { terminal(job, 'cancelled', code); await save(state); } });
  }
  return {
    catalog: () => serial(async () => {
      const state = await load(), current = await devices.snapshot();
      return { workers: current.devices.filter(item => !item.revokedAt && item.expiresAt > time() && item.capabilities.includes('repository')).map(device => {
        const inventory = state.inventories.find(item => item.deviceId === device.id), fresh = !!inventory && inventory.announcedAt > time() - INVENTORY_MS;
        return { id: device.id, name: device.name, online: Boolean(device.online && fresh), scopeIds: [...device.scopeIds], repositories: copy(inventory?.repositories.filter(repository => repository.scopeIds.some(scope => device.scopeIds.includes(scope))) || []) };
      }) };
    }),
    announce: (rawToken: string, payload: unknown) => serial(async () => {
      object(payload, ['repositories']); if (!Array.isArray(payload.repositories) || payload.repositories.length > 30) throw fail('Annuncia al massimo trenta repository.');
      const device = await devices.authenticate(rawToken, 'repository'); activeDevice(device);
      const repositories = payload.repositories.map(announcement), aliases = new Set<string>();
      for (const item of repositories) { if (aliases.has(item.alias) || item.scopeIds.some(scope => !device.scopeIds.includes(scope))) throw fail('Alias duplicato o ambito non autorizzato.', 'REPOSITORY_DEVICE_SCOPE', 403); aliases.add(item.alias); }
      noSecrets(JSON.stringify(repositories), [rawToken]); const state = await load();
      const inventory = { deviceId: device.id, announcedAt: time(), repositories }, previous = state.inventories.findIndex(item => item.deviceId === device.id);
      if (previous < 0) { if (state.inventories.length >= 20) throw fail('Catalogo dispositivi pieno.', 'REPOSITORY_DEVICE_FULL', 413); state.inventories.push(inventory); } else state.inventories[previous] = inventory;
      for (const job of state.jobs.filter(item => item.deviceId === device.id && ['queued', 'leased'].includes(item.status))) {
        if (!repositories.some(item => item.alias === job.alias && item.policyHash === job.policyHash && item.scopeIds.includes(job.scopeId))) terminal(job, 'cancelled', 'REPOSITORY_POLICY_CHANGED');
      }
      await devices.touch(rawToken, 'repository'); await save(state); return { ok: true };
    }),
    inspect: (input: { deviceId: string; alias: string; scopeId: string }) => serial(async () => {
      object(input, ['deviceId', 'alias', 'scopeId']); id(input.deviceId); id(input.alias); id(input.scopeId);
      const state = await load(), device = await knownDevice(input.deviceId); activeDevice(device, input.scopeId, true);
      return copy(authorizedRepository(state, device, input.alias, input.scopeId, true));
    }),
    async run(input: RunInput): Promise<RepositoryReceipt> {
      object(input, ['deviceId', 'alias', 'scopeId', 'runId', 'baseCommit', 'policyHash', 'prompt', 'checks', 'signal', 'onProgress']);
      for (const key of ['deviceId', 'alias', 'scopeId', 'runId'] as const) id(input[key]); commit(input.baseCommit); hash(input.policyHash); text(input.prompt, 120000); noSecrets(input.prompt);
      const configured = checks(input.checks); if (input.onProgress !== undefined && typeof input.onProgress !== 'function') throw fail('Avanzamento repository non valido.');
      if (input.signal?.aborted) throw fail('Lavoro repository annullato.', 'REPOSITORY_DEVICE_ABORTED', 499);
      const jobId = await serial(async () => {
        const state = await load(), device = await knownDevice(input.deviceId); activeDevice(device, input.scopeId, true);
        const repository = authorizedRepository(state, device, input.alias, input.scopeId, true, input.policyHash);
        if (JSON.stringify(repository.checks) !== JSON.stringify(configured)) throw fail('I controlli non corrispondono alla politica del computer.', 'REPOSITORY_CHECKS_MISMATCH', 409);
        if (state.jobs.some(job => job.runId === input.runId)) throw fail('Questo tentativo è già stato assegnato. Crea una nuova revisione.', 'REPOSITORY_RUN_USED', 409);
        if (state.jobs.length >= 500 || state.jobs.filter(job => ['queued', 'leased'].includes(job.status)).length >= 10) throw fail('Coda repository remoti piena.', 'REPOSITORY_DEVICE_FULL', 409);
        if (input.signal?.aborted) throw fail('Lavoro repository annullato.', 'REPOSITORY_DEVICE_ABORTED', 499);
        const createdAt = time(), job: Job = { id: randomUUID(), deviceId: device.id, runId: input.runId, scopeId: input.scopeId, alias: input.alias, baseCommit: input.baseCommit, policyHash: input.policyHash, prompt: input.prompt, checks: configured, status: 'queued', stage: null, createdAt, expiresAt: createdAt + JOB_MS, leaseExpiresAt: null, leaseHash: null, resultHash: null, resultExpiresAt: null, errorCode: null };
        state.jobs.push(job); await save(state); return job.id;
      });
      let previousStage: RepositoryStage | null = null;
      try {
        while (true) {
          if (input.signal?.aborted) throw fail('Lavoro repository annullato.', 'REPOSITORY_DEVICE_ABORTED', 499);
          const outcome = await serial(async () => {
            const state = await load(), job = state.jobs.find(item => item.id === jobId)!;
            if (['failed', 'cancelled'].includes(job.status)) throw fail(messages[job.errorCode || ''] || 'Il lavoro remoto non è stato completato. Verifica il computer prima di creare una nuova revisione.', job.errorCode || 'REPOSITORY_DEVICE_FAILED', 409);
            const device = await knownDevice(job.deviceId); activeDevice(device, job.scopeId);
            authorizedRepository(state, device, job.alias, job.scopeId, false, job.policyHash);
            if (job.status !== 'completed') return { stage: job.stage, result: null };
            if (job.resultExpiresAt === null) throw fail('La ricevuta repository è scaduta.', 'REPOSITORY_RECEIPT_EXPIRED', 409);
            const stored = await storage.read(receiptKey(job.id));
            if (!stored || resultHash(stored) !== job.resultHash) throw fail('Ricevuta repository non verificabile.', 'REPOSITORY_DEVICE_CORRUPT', 503);
            return { stage: job.stage, result: receipt(stored, job) };
          });
          if (input.signal?.aborted) throw fail('Lavoro repository annullato.', 'REPOSITORY_DEVICE_ABORTED', 499);
          if (outcome.stage && outcome.stage !== previousStage) { previousStage = outcome.stage; await input.onProgress?.({ stage: outcome.stage, jobId }); }
          if (outcome.result) return outcome.result;
          await new Promise<void>(resolve => { const done = () => { clearTimeout(timer); input.signal?.removeEventListener('abort', done); resolve(); }; const timer = setTimeout(done, pollMs); input.signal?.addEventListener('abort', done, { once: true }); });
        }
      } catch (error) { await cancel(jobId).catch(() => {}); throw error; }
    },
    claim: (rawToken: string) => serial(async (): Promise<{ job: RepositoryLeaseJob | null }> => {
      const device = await devices.touch(rawToken, 'repository'); activeDevice(device);
      const state = await load(); if (state.jobs.some(job => job.deviceId === device.id && job.status === 'leased')) return { job: null };
      const job = state.jobs.find(item => item.deviceId === device.id && item.status === 'queued'); if (!job) return { job: null };
      try { authorizedRepository(state, device, job.alias, job.scopeId, true, job.policyHash); }
      catch (error) { terminal(job, 'failed', 'REPOSITORY_POLICY_CHANGED'); await save(state); throw error; }
      noSecrets(job.prompt!, [rawToken]); const lease = randomBytes(32).toString('base64url'); job.status = 'leased'; job.leaseHash = digest(lease); job.leaseExpiresAt = Math.min(time() + LEASE_MS, job.expiresAt); job.stage = 'preparing'; await save(state);
      return { job: { id: job.id, lease, runId: job.runId, scopeId: job.scopeId, alias: job.alias, baseCommit: job.baseCommit, policyHash: job.policyHash, prompt: job.prompt!, checks: copy(job.checks), expiresAt: job.expiresAt } };
    }),
    heartbeat: (rawToken: string, payload: unknown) => serial(async () => {
      object(payload, ['id', 'lease', 'stage']); if (payload.stage !== undefined && !stages.includes(payload.stage as RepositoryStage)) throw fail('Fase repository non valida.');
      const device = await devices.touch(rawToken, 'repository'), state = await load(), job = leaseJob(state, device, payload);
      if (job.status !== 'leased') throw fail('Il lavoro non ha una lease attiva.', 'REPOSITORY_STALE_LEASE', 409);
      if (payload.stage !== undefined) { if (stages.indexOf(payload.stage as RepositoryStage) < stages.indexOf(job.stage!)) throw fail('La fase repository non può tornare indietro.'); job.stage = payload.stage as RepositoryStage; }
      job.leaseExpiresAt = Math.min(time() + LEASE_MS, job.expiresAt); await save(state); return { ok: true };
    }),
    finish: (rawToken: string, payload: unknown) => serial(async () => {
      object(payload, ['id', 'lease', 'result', 'error']); if (Object.hasOwn(payload, 'result') === Object.hasOwn(payload, 'error')) throw fail('Invia una ricevuta oppure un errore.');
      const device = await devices.authenticate(rawToken, 'repository'), state = await load(), job = leaseJob(state, device, payload);
      if (job.status !== 'leased' && job.status !== 'completed') throw fail('Risultato repository tardivo o annullato.', 'REPOSITORY_STALE_LEASE', 409);
      if (payload.result !== undefined) {
        const result = receipt(payload.result, job, [rawToken, String(payload.lease)]), fingerprint = resultHash(result);
        if (job.status === 'completed') { if (job.resultExpiresAt === null || fingerprint !== job.resultHash) throw fail('Ricevuta già consegnata con un risultato diverso o scaduto.', 'REPOSITORY_RECEIPT_CONFLICT', 409); return { ok: true }; }
        job.status = 'completed'; job.prompt = null; job.leaseExpiresAt = null; job.resultHash = fingerprint; job.resultExpiresAt = time() + RESULT_MS; job.errorCode = null;
        await devices.touch(rawToken, 'repository'); await save(state, [{ key: receiptKey(job.id), value: result }]);
      } else {
        if (job.status !== 'leased') throw fail('La ricevuta è già stata acquisita.', 'REPOSITORY_RECEIPT_CONFLICT', 409);
        object(payload.error, ['code', 'message']); const code = text(payload.error.code, 80); if (!/^[A-Z_]+$/.test(code)) throw fail('Codice errore worker non valido.');
        if (payload.error.message !== undefined) noSecrets(text(payload.error.message, 1000, true), [rawToken, String(payload.lease)]);
        terminal(job, 'failed', safeErrors.has(code) ? code : 'WORKER_FAILED'); await devices.touch(rawToken, 'repository'); await save(state);
      }
      return { ok: true };
    }),
    recover: () => serial(async () => {
      const state = await load(); for (const job of state.jobs) if (['queued', 'leased'].includes(job.status)) terminal(job, 'failed', 'WORKER_INTERRUPTED');
      for (const inventory of state.inventories) inventory.announcedAt = 0; await save(state); return { ok: true };
    }),
    cancelDevice: (deviceId: string) => serial(async () => {
      id(deviceId); const state = await load(); for (const job of state.jobs) if (job.deviceId === deviceId && ['queued', 'leased'].includes(job.status)) terminal(job, 'cancelled', 'REPOSITORY_DEVICE_REVOKED');
      state.inventories = state.inventories.filter(item => item.deviceId !== deviceId); await save(state); return { ok: true };
    }),
  };
}
