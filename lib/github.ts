import { createHash, randomUUID } from 'node:crypto';
import { applyRepositoryPatch } from './github-patch.ts';

type Storage = { read(key: string, fallback?: unknown): Promise<unknown>; write(key: string, value: unknown): Promise<unknown>; batch?(entries: Array<{ key: string; value: unknown }>): Promise<unknown> };
type Workspace = { getSnapshot(): Promise<{ scopes: Array<{ id: string; kind?: string }> }> };
type File = { path: string; status: 'A' | 'M' | 'D'; additions: number; deletions: number };
type ApprovedRun = { id: string; version: number; scopeId: string; title: string; baseCommit: string; patchHash: string; patch: string; files: File[]; checks: Array<{ status: string; exitCode?: number | null; truncated?: boolean }> };
type Connection = { id: string; version: number; name: string; token: string; scopeIds: string[]; repositories: string[]; allowPublish: boolean; createdAt: string };
type Entry = { path: string; mode: '100644' | '100755'; content: string | null; oldSha: string | null; newSha: string | null };
type Stage = 'tree' | 'commit' | 'branch' | 'pull_request';
type Publication = { id: string; version: number; status: 'preview' | 'publishing' | 'published' | 'uncertain'; runId: string; scopeId: string; connectionId: string; repository: string; baseBranch: string; baseCommit: string; patchHash: string; candidateDigest: string; files: File[]; title: string; body: string; branch: string; createdAt: string; url?: string; error?: string; stage?: Stage; treeSha?: string; commitSha?: string; actualBaseCommit?: string; baseChanged?: boolean; pullRequested?: boolean; rejected?: boolean };
type Candidate = { version: 1; runVersion: number; connectionVersion: number; baseTree: string; entries: Entry[]; patchHash: string };
type State = { version: 1; connections: Connection[]; publications: Publication[] };
export type GitHubOptions = { storage: Storage; workspace: Workspace; approvedRun(input: { id: string }): Promise<ApprovedRun>; transport?: typeof fetch; now?: () => number; requestTimeoutMs?: number };
const KEY = 'github', API = 'https://api.github.com', SHA = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
const MAX_RESPONSE = 8 * 1024 * 1024, MAX_FILE = 1024 * 1024;
const internalErrors = new WeakSet<object>();
const fail = (message: string, code = 'GITHUB_INVALID', statusCode = 400) => { const error = Object.assign(Error(message), { code, statusCode, status: statusCode }); internalErrors.add(error); return error; };
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const blobHash = (bytes: Buffer) => createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const canonical = (value: unknown): unknown => value && typeof value === 'object' ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const candidateDigest = (value: Candidate) => hash(JSON.stringify(canonical(value)));
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> { if (!record(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('Dati GitHub non validi.'); }
function integer(value: unknown, min = 0) { if (!Number.isSafeInteger(value) || (value as number) < min) throw fail('Versione GitHub non valida.'); }
function text(value: unknown, max: number, empty = false): string { if (typeof value !== 'string' || value.length > max || value.includes('\0') || !empty && !value.trim()) throw fail('Campo GitHub vuoto o troppo lungo.'); return value; }
function id(value: unknown): string { const valueId = text(value, 100); if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(valueId)) throw fail('Identificativo GitHub non valido.'); return valueId; }
function sha(value: unknown): string { if (typeof value !== 'string' || !SHA.test(value)) throw fail('Impronta GitHub non valida.', 'GITHUB_RESPONSE_INVALID', 502); return value; }
function repo(value: unknown): string { const name = text(value, 200); if (!/^[a-zA-Z0-9][a-zA-Z0-9-]{0,99}\/[a-zA-Z0-9_.-]{1,100}$/.test(name) || name.split('/').some(part => part === '.' || part === '..') || name.endsWith('.git')) throw fail('Indica il repository come proprietario/nome, senza URL o suffisso .git.'); return name.toLowerCase(); }
function branch(value: unknown): string { const name = text(value, 200); if (name.startsWith('-') || /[\s\x00-\x1f\x7f~^:?*\[\\]|\.\.|@\{|\/\/|^\/|\/$|\.$/.test(name) || name.split('/').some(part => part.startsWith('.') || part.endsWith('.lock')) || name === '@') throw fail('Nome branch non valido.'); return name; }
function filePath(value: unknown): string {
  const path = text(value, 1024);
  if (/^[\/\\]|[\x00-\x1f\x7f\\]|^[a-zA-Z]:/.test(path) || path.split('/').some(part => !part || ['.', '..', '.git', '.codex', '.agents', '.ssh', '.aws', '.azure', '.local', 'node_modules'].includes(part.toLowerCase())) || /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|\.npmrc|\.netrc|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519|[^/]+\.(?:p12|pfx|pem|key|sqlite|db))$/i.test(path)) throw fail('Percorso GitHub non consentito.', 'GITHUB_PATH_DENIED', 403);
  return path;
}
function noSecrets(value: string, token = '') {
  if (token && value.toLowerCase().includes(token.toLowerCase()) || /-----BEGIN[\s\S]{0,50}PRIVATE KEY-----|\b(?:sk-(?:proj-|ant-)?[a-z0-9_-]{16,}|gh[pousr]_[a-z0-9_]{20,}|github_pat_[a-z0-9_]{20,}|AKIA[A-Z0-9]{16})\b/i.test(value)) throw fail('Rimuovi le credenziali dal contenuto prima di continuare.', 'GITHUB_SECRET', 400);
}
const segment = (value: string) => encodeURIComponent(value);
const refPath = (value: string) => value.split('/').map(segment).join('/');
function expected(value: unknown, version: number) { if (!Number.isSafeInteger(value) || value !== version) throw fail('La configurazione è cambiata. Ricarica e ripeti la revisione.', 'GITHUB_CONFLICT', 409); }
function publicConnection(item: Connection) { return { id: item.id, version: item.version, name: item.name, scopeIds: [...item.scopeIds], repositories: [...item.repositories], allowPublish: item.allowPublish, createdAt: item.createdAt, tokenConfigured: true }; }
function publicPublication(item: Publication) { return clone({ id: item.id, version: item.version, status: item.status, runId: item.runId, scopeId: item.scopeId, connectionId: item.connectionId, repository: item.repository, baseBranch: item.baseBranch, baseCommit: item.baseCommit, patchHash: item.patchHash, files: item.files, title: item.title, body: item.body, branch: item.branch, createdAt: item.createdAt, ...(item.url ? { url: item.url } : {}), ...(item.error ? { error: item.error } : {}), ...(item.treeSha ? { treeSha: item.treeSha } : {}), ...(item.commitSha ? { commitSha: item.commitSha } : {}), ...(item.actualBaseCommit ? { actualBaseCommit: item.actualBaseCommit, baseChanged: item.baseChanged === true } : {}) }); }
function validateState(raw: unknown): State {
  try {
    object(raw, ['version', 'connections', 'publications']);
    if (raw.version !== 1 || !Array.isArray(raw.connections) || !Array.isArray(raw.publications) || raw.connections.length > 20 || raw.publications.length > 200) throw Error();
    const connections = new Set<string>(), publications = new Set<string>(), tokens: string[] = [];
    for (const item of raw.connections) {
      object(item, ['id', 'version', 'name', 'token', 'scopeIds', 'repositories', 'allowPublish', 'createdAt']);
      const connectionId = id(item.id); if (connections.has(connectionId)) throw Error(); connections.add(connectionId);
      integer(item.version, 1); const token = text(item.token, 512); if (token.length < 20 || !/^[a-zA-Z0-9_-]+$/.test(token)) throw Error(); tokens.push(token);
      const name = text(item.name, 100); if (/[\r\n]/.test(name) || typeof item.allowPublish !== 'boolean') throw Error(); noSecrets(name, token);
      if (!Array.isArray(item.scopeIds) || !item.scopeIds.length || item.scopeIds.length > 200 || new Set(item.scopeIds).size !== item.scopeIds.length) throw Error(); item.scopeIds.forEach(id);
      if (!Array.isArray(item.repositories) || !item.repositories.length || item.repositories.length > 30 || new Set(item.repositories).size !== item.repositories.length) throw Error(); for (const name of item.repositories) if (repo(name) !== name) throw Error();
      if (!Number.isFinite(Date.parse(text(item.createdAt, 40)))) throw Error();
    }
    for (const connection of raw.connections) for (const token of tokens) noSecrets(JSON.stringify(publicConnection(connection as Connection)), token);
    for (const item of raw.publications) {
      object(item, ['id', 'version', 'status', 'runId', 'scopeId', 'connectionId', 'repository', 'baseBranch', 'baseCommit', 'patchHash', 'candidateDigest', 'files', 'title', 'body', 'branch', 'createdAt', 'url', 'error', 'stage', 'treeSha', 'commitSha', 'actualBaseCommit', 'baseChanged', 'pullRequested', 'rejected']);
      const publicationId = id(item.id); if (publications.has(publicationId)) throw Error(); publications.add(publicationId); integer(item.version, 1);
      for (const field of ['runId', 'scopeId', 'connectionId']) id(item[field]);
      if (!['preview', 'publishing', 'published', 'uncertain'].includes(String(item.status)) || repo(item.repository) !== item.repository || item.branch !== `fuori-studio/${publicationId}`) throw Error();
      branch(item.baseBranch); sha(item.baseCommit); if (typeof item.patchHash !== 'string' || !HASH.test(item.patchHash) || typeof item.candidateDigest !== 'string' || !HASH.test(item.candidateDigest)) throw Error();
      text(item.title, 240); text(item.body, 20000, true); if (/[\r\n]/.test(item.title as string) || !Number.isFinite(Date.parse(text(item.createdAt, 40)))) throw Error();
      if (!Array.isArray(item.files) || !item.files.length || item.files.length > 100) throw Error(); const paths = new Set<string>();
      for (const file of item.files) { object(file, ['path', 'status', 'additions', 'deletions']); const path = filePath(file.path); if (paths.has(path) || !['A', 'M', 'D'].includes(String(file.status))) throw Error(); paths.add(path); integer(file.additions); integer(file.deletions); }
      if (item.stage !== undefined && !['tree', 'commit', 'branch', 'pull_request'].includes(String(item.stage))) throw Error();
      for (const field of ['treeSha', 'commitSha', 'actualBaseCommit']) if (item[field] !== undefined) sha(item[field]);
      for (const field of ['baseChanged', 'pullRequested', 'rejected']) if (item[field] !== undefined && typeof item[field] !== 'boolean') throw Error();
      if (item.error !== undefined) text(item.error, 1000);
      if (item.url !== undefined && (typeof item.url !== 'string' || !new RegExp(`^https://github\\.com/${String(item.repository).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/pull/[1-9][0-9]*$`).test(item.url))) throw Error();
      if (item.status === 'published' && (!item.url || !item.commitSha || !item.treeSha)) throw Error();
      for (const token of tokens) noSecrets(JSON.stringify(item), token);
    }
    return raw as State;
  } catch { throw fail('Archivio GitHub incompatibile o danneggiato. I dati sono stati conservati.', 'GITHUB_CORRUPT', 503); }
}

/** Fixed-host GitHub access. Credentials stay in the encrypted server archive. */
export function createGitHub({ storage, workspace, approvedRun, transport = fetch, now = Date.now, requestTimeoutMs = 15000 }: GitHubOptions) {
  let queue: Promise<unknown> = Promise.resolve(), operationDeadline = 0;
  const serial = <T>(operation: () => Promise<T>): Promise<T> => { const result = queue.then(async () => { operationDeadline = Date.now() + 60000; try { return await operation(); } finally { operationDeadline = 0; } }); queue = result.catch(() => {}); return result; };
  const stamp = () => new Date(now()).toISOString();
  async function load(): Promise<State> {
    const raw = await storage.read(KEY, { version: 1, connections: [], publications: [] });
    return validateState(raw);
  }
  function checkState(state: State) { validateState(state); if (Buffer.byteLength(JSON.stringify(state)) > 5 * 1024 * 1024) throw fail('Limite archivio GitHub raggiunto.', 'GITHUB_CAPACITY', 409); }
  async function persist(state: State) { checkState(state); await storage.write(KEY, state); }
  const snapshotOf = (state: State) => ({ connections: state.connections.map(publicConnection), publications: state.publications.map(publicPublication) });
  async function scopes(ids: unknown): Promise<string[]> {
    if (!Array.isArray(ids) || !ids.length || ids.length > 200) throw fail('Seleziona almeno un ambito GitHub.');
    const list = ids.map(id), known = (await workspace.getSnapshot()).scopes;
    if (new Set(list).size !== list.length || list.some(value => !known.some(scope => scope.id === value && scope.kind !== 'archive'))) throw fail('Ambito GitHub non disponibile.', 'GITHUB_SCOPE_DENIED', 403);
    return list;
  }
  async function authorize(state: State, connectionId: string, scopeId: string, repository: string, write = false): Promise<Connection> {
    await scopes([scopeId]); const connection = state.connections.find(item => item.id === id(connectionId));
    if (!connection || !connection.scopeIds.includes(scopeId) || !connection.repositories.includes(repository)) throw fail('Collegamento non autorizzato per questo ambito e repository.', 'GITHUB_SCOPE_DENIED', 403);
    if (write && !connection.allowPublish) throw fail('La pubblicazione non è abilitata per questo collegamento.', 'GITHUB_WRITE_DENIED', 403);
    return connection;
  }
  async function request(connection: Connection, path: string, { method = 'GET', body, missing = false }: { method?: 'GET' | 'POST'; body?: unknown; missing?: boolean } = {}): Promise<unknown> {
    if (!path.startsWith('/repos/') || path.includes('#')) throw fail('Endpoint GitHub non consentito.');
    const remaining = operationDeadline - Date.now(); if (remaining <= 0) throw fail('L’operazione GitHub ha superato un minuto. Nessuna scrittura viene ripetuta automaticamente.', 'GITHUB_TIMEOUT', 408);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), Math.min(remaining, requestTimeoutMs));
    try {
      const response = await transport(API + path, { method, redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${connection.token}`, 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'FuoriStudio/0.5', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.status === 404 && missing) { await response.body?.cancel(); return null; }
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(fail(response.status === 401 || response.status === 403 ? 'GitHub ha rifiutato le credenziali o i permessi. Controlla scadenza, repository e autorizzazioni.' : response.status === 404 ? 'Repository o risorsa GitHub non disponibile per questo collegamento.' : 'GitHub non ha accettato la richiesta. Verifica lo stato prima di ripetere.', 'GITHUB_REQUEST_REJECTED', 502), { rejected: response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status) }); }
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE || response.headers.get('link')?.includes('rel="next"')) throw fail('Risposta GitHub troppo grande o incompleta.', 'GITHUB_RESPONSE_LIMIT', 502);
      const reader = response.body?.getReader(); if (!reader) throw fail('Risposta GitHub vuota.', 'GITHUB_RESPONSE_INVALID', 502);
      const chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > MAX_RESPONSE) throw fail('Risposta GitHub troppo grande.', 'GITHUB_RESPONSE_LIMIT', 502); chunks.push(value); } } finally { await reader.cancel(); }
      try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw fail('Risposta GitHub non valida.', 'GITHUB_RESPONSE_INVALID', 502); }
    } catch (error) {
      if (record(error) && internalErrors.has(error)) throw error;
      throw fail('Connessione GitHub interrotta. Nessuna richiesta di scrittura viene ripetuta automaticamente.', 'GITHUB_TRANSPORT', 502);
    } finally { clearTimeout(timer); }
  }
  async function metadata(connection: Connection, repository: string) {
    const value = await request(connection, `/repos/${repository}`);
    if (!record(value) || typeof value.full_name !== 'string' || value.full_name.toLowerCase() !== repository || typeof value.private !== 'boolean' || typeof value.default_branch !== 'string') throw fail('Repository GitHub restituito non corrispondente.', 'GITHUB_RESPONSE_INVALID', 502);
    return { repository, private: value.private, defaultBranch: branch(value.default_branch), archived: value.archived === true, url: `https://github.com/${repository}` };
  }
  async function head(connection: Connection, repository: string, value: string, missing = false) {
    const result = await request(connection, `/repos/${repository}/git/ref/heads/${refPath(value)}`, { missing });
    if (result === null) return null;
    if (!record(result) || result.ref !== `refs/heads/${value}` || !record(result.object) || result.object.type !== 'commit') throw fail('Riferimento GitHub non valido.', 'GITHUB_RESPONSE_INVALID', 502);
    return sha(result.object.sha);
  }
  async function commitTree(connection: Connection, repository: string, commit: string) {
    const value = await request(connection, `/repos/${repository}/git/commits/${sha(commit)}`);
    if (!record(value) || value.sha !== commit || !record(value.tree)) throw fail('Commit GitHub non corrispondente.', 'GITHUB_RESPONSE_INVALID', 502);
    return { tree: sha(value.tree.sha), parents: Array.isArray(value.parents) ? value.parents.map(item => record(item) ? sha(item.sha) : '') : [] };
  }
  function treeReader(connection: Connection, repository: string, root: string) {
    const cache = new Map<string, Array<{ path: string; mode: string; type: string; sha: string }>>(); let fetched = 0;
    async function tree(treeSha: string) {
      const cached = cache.get(treeSha); if (cached) return cached;
      if (++fetched > 200) throw fail('Troppi percorsi GitHub in una singola operazione.', 'GITHUB_RESPONSE_LIMIT', 413);
      const value = await request(connection, `/repos/${repository}/git/trees/${sha(treeSha)}`);
      if (!record(value) || value.sha !== treeSha || value.truncated !== false || !Array.isArray(value.tree) || value.tree.length > 20000) throw fail('Albero GitHub incompleto.', 'GITHUB_RESPONSE_INVALID', 502);
      const paths = new Set<string>();
      const entries = value.tree.map(entry => { if (!record(entry) || typeof entry.path !== 'string' || !entry.path || entry.path.includes('/') || paths.has(entry.path) || typeof entry.mode !== 'string' || typeof entry.type !== 'string') throw fail('Voce albero GitHub non valida.', 'GITHUB_RESPONSE_INVALID', 502); paths.add(entry.path); return { path: entry.path, mode: entry.mode, type: entry.type, sha: sha(entry.sha) }; });
      cache.set(treeSha, entries); return entries;
    }
    return async (path: string): Promise<{ content: Buffer; sha: string; mode: '100644' | '100755' } | null> => {
      const parts = filePath(path).split('/'); let current = root;
      for (let index = 0; index < parts.length; index++) {
        const entries = await tree(current), folded = parts[index].normalize('NFC').toLowerCase();
        if (entries.some(item => item.path !== parts[index] && item.path.normalize('NFC').toLowerCase() === folded)) throw fail('Il percorso collide con un nome esistente per maiuscole o Unicode.', 'GITHUB_PATH_DENIED', 403);
        const entry = entries.find(item => item.path === parts[index]);
        if (!entry) return null;
        if (index < parts.length - 1) { if (entry.type !== 'tree' || entry.mode !== '040000') throw fail('Il percorso attraversa un file o un collegamento.', 'GITHUB_PATH_DENIED', 403); current = entry.sha; continue; }
        if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw fail('Collegamenti e sottomoduli non sono supportati.', 'GITHUB_PATH_DENIED', 403);
        const value = await request(connection, `/repos/${repository}/git/blobs/${entry.sha}`);
        if (!record(value) || value.sha !== entry.sha || value.encoding !== 'base64' || typeof value.content !== 'string' || !Number.isSafeInteger(value.size) || (value.size as number) > MAX_FILE || (value.size as number) < 0) throw fail('File GitHub non valido o troppo grande.', 'GITHUB_RESPONSE_INVALID', 502);
        const normalized = value.content.replace(/\n/g, ''); if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) throw fail('Codifica del file GitHub non valida.', 'GITHUB_RESPONSE_INVALID', 502);
        const content = Buffer.from(normalized, 'base64');
        if (content.length !== value.size || blobHash(content) !== entry.sha || content.includes(0) || !Buffer.from(content.toString('utf8'), 'utf8').equals(content)) throw fail('File GitHub binario, alterato o non UTF-8.', 'GITHUB_RESPONSE_INVALID', 502);
        noSecrets(content.toString('utf8'), connection.token); return { content, sha: entry.sha, mode: entry.mode as '100644' | '100755' };
      }
      return null;
    };
  }
  async function validRun(publication: Publication, candidate: Candidate, connection: Connection) {
    expected(connection.version, candidate.connectionVersion);
    const run = await approvedRun({ id: publication.runId });
    if (run.version !== candidate.runVersion || run.scopeId !== publication.scopeId || run.baseCommit !== publication.baseCommit || run.patchHash !== publication.patchHash || hash(run.patch) !== publication.patchHash) throw fail('L’incarico approvato è cambiato. Prepara una nuova anteprima.', 'GITHUB_RUN_CHANGED', 409);
    if (!run.checks.length || run.checks.some(check => check.status !== 'passed' || check.exitCode !== 0 || check.truncated)) throw fail('L’incarico non ha tutti i controlli riusciti.', 'GITHUB_REVIEW_REQUIRED', 409);
  }
  async function candidateFor(publication: Publication): Promise<Candidate> {
    const value = await storage.read(`${KEY}/candidate/${publication.id}`);
    if (!record(value) || value.version !== 1 || value.patchHash !== publication.patchHash || !Array.isArray(value.entries) || !value.entries.length || value.entries.length > 100 || !Number.isSafeInteger(value.runVersion) || !Number.isSafeInteger(value.connectionVersion)) throw fail('Anteprima GitHub mancante o danneggiata.', 'GITHUB_CORRUPT', 503);
    object(value, ['version', 'runVersion', 'connectionVersion', 'baseTree', 'entries', 'patchHash']); sha(value.baseTree);
    if (candidateDigest(value as Candidate) !== publication.candidateDigest || value.entries.length !== publication.files.length) throw fail('L’anteprima è stata alterata. Nessuna pubblicazione eseguita.', 'GITHUB_CANDIDATE_CHANGED', 409);
    const paths = new Set<string>();
    for (const entry of value.entries) {
      object(entry, ['path', 'mode', 'content', 'oldSha', 'newSha']); const path = filePath(entry.path), file = publication.files.find(item => item.path === path);
      if (paths.has(path) || !file || !['100644', '100755'].includes(String(entry.mode))) throw fail('File anteprima incoerente.', 'GITHUB_CANDIDATE_CHANGED', 409); paths.add(path);
      if (entry.oldSha !== null) sha(entry.oldSha); if (entry.newSha !== null) sha(entry.newSha);
      if (entry.content !== null) { const content = text(entry.content, MAX_FILE, true); if (Buffer.byteLength(content) > MAX_FILE || blobHash(Buffer.from(content)) !== entry.newSha) throw fail('Contenuto anteprima alterato.', 'GITHUB_CANDIDATE_CHANGED', 409); }
      if (file.status === 'A' && (entry.oldSha !== null || entry.newSha === null || entry.content === null) || file.status === 'D' && (entry.oldSha === null || entry.newSha !== null || entry.content !== null) || file.status === 'M' && (entry.oldSha === null || entry.newSha === null || entry.content === null)) throw fail('Tipo modifica anteprima incoerente.', 'GITHUB_CANDIDATE_CHANGED', 409);
    }
    return value as Candidate;
  }
  function publicationFor(state: State, input: { id: string; expectedVersion: number }) { const publication = state.publications.find(item => item.id === id(input.id)); if (!publication) throw fail('Anteprima non trovata.', 'GITHUB_NOT_FOUND', 404); expected(input.expectedVersion, publication.version); return publication; }
  function matchingPr(value: unknown, publication: Publication): { url: string; actualBaseCommit: string; baseChanged: boolean } | null {
    if (!record(value) || !Number.isSafeInteger(value.number) || (value.number as number) <= 0 || !record(value.head) || !record(value.base) || !record(value.head.repo) || !record(value.base.repo)) return null;
    if (value.head.ref !== publication.branch || value.head.sha !== publication.commitSha || value.base.ref !== publication.baseBranch || String(value.head.repo.full_name).toLowerCase() !== publication.repository || String(value.base.repo.full_name).toLowerCase() !== publication.repository) return null;
    const actualBaseCommit = sha(value.base.sha);
    return { url: `https://github.com/${publication.repository}/pull/${value.number}`, actualBaseCommit, baseChanged: actualBaseCommit !== publication.baseCommit };
  }
  function markPublished(publication: Publication, result: { url: string; actualBaseCommit: string; baseChanged: boolean }) { Object.assign(publication, result, { status: 'published' }); if (result.baseChanged) publication.error = 'PR creata, ma il branch di destinazione è avanzato rispetto ai controlli approvati. Verifica il confronto e riesegui i controlli su GitHub prima del merge.'; else delete publication.error; }
  async function findPr(connection: Connection, publication: Publication) {
    const query = new URLSearchParams({ state: 'all', head: `${publication.repository.split('/')[0]}:${publication.branch}`, base: publication.baseBranch, per_page: '100' });
    const value = await request(connection, `/repos/${publication.repository}/pulls?${query}`);
    if (!Array.isArray(value)) throw fail('Elenco pull request non valido.', 'GITHUB_RESPONSE_INVALID', 502);
    const matches = value.map(item => matchingPr(item, publication)).filter(item => item !== null);
    if (value.length !== matches.length || matches.length > 1) throw fail('Una pull request esistente non corrisponde all’anteprima. Verifica GitHub.', 'GITHUB_PUBLICATION_CONFLICT', 409);
    return matches[0] || null;
  }
  async function verifyBranch(connection: Connection, publication: Publication) {
    const actual = await head(connection, publication.repository, publication.branch, true);
    if (!actual) return false;
    if (!publication.commitSha || actual !== publication.commitSha || !publication.treeSha) throw fail('Il branch esistente non corrisponde al risultato preparato.', 'GITHUB_PUBLICATION_CONFLICT', 409);
    const commit = await commitTree(connection, publication.repository, actual);
    if (commit.tree !== publication.treeSha || commit.parents.length !== 1 || commit.parents[0] !== publication.baseCommit) throw fail('Il commit pubblicato non corrisponde all’anteprima.', 'GITHUB_PUBLICATION_CONFLICT', 409);
    return true;
  }
  return {
    snapshot: () => serial(async () => snapshotOf(await load())),
    recover: () => serial(async () => { const state = await load(); let changed = false; for (const item of state.publications) if (item.status === 'publishing') { item.status = 'uncertain'; item.version++; item.error = 'Pubblicazione interrotta. Verifica l’esito senza ripetere la creazione.'; changed = true; } if (changed) await persist(state); return snapshotOf(state); }),
    save: (input: { id?: string; expectedVersion?: number; name: string; token?: string; scopeIds: string[]; repositories: string[]; allowPublish: boolean }) => serial(async () => {
      const state = await load(), existing = input.id ? state.connections.find(item => item.id === id(input.id)) : undefined;
      if (input.id && !existing) throw fail('Collegamento non trovato.', 'GITHUB_NOT_FOUND', 404);
      if (existing) expected(input.expectedVersion, existing.version);
      if (!existing && state.connections.length >= 20) throw fail('Limite collegamenti GitHub raggiunto.', 'GITHUB_CAPACITY', 409);
      const token = input.token === undefined || input.token === '' ? existing?.token : text(input.token, 512).trim();
      if (!token || token.length < 20 || !/^[a-zA-Z0-9_-]+$/.test(token)) throw fail('Inserisci un token GitHub valido.');
      if (typeof input.allowPublish !== 'boolean' || !Array.isArray(input.repositories) || !input.repositories.length || input.repositories.length > 30) throw fail('Specifica repository e permessi GitHub.');
      const repositories = [...new Set(input.repositories.map(repo))];
      const name = text(input.name, 100).trim(); if (/[\r\n]/.test(name)) throw fail('Nome collegamento non valido.'); noSecrets(name, token);
      noSecrets(JSON.stringify({ name, repositories, scopeIds: input.scopeIds }), token);
      const connection: Connection = { id: existing?.id || randomUUID(), version: (existing?.version || 0) + 1, name, token, scopeIds: await scopes(input.scopeIds), repositories, allowPublish: input.allowPublish, createdAt: existing?.createdAt || stamp() };
      if (existing) state.connections[state.connections.indexOf(existing)] = connection; else state.connections.push(connection);
      await persist(state); return publicConnection(connection);
    }),
    disconnect: (input: { id: string; expectedVersion: number }) => serial(async () => { const state = await load(), connection = state.connections.find(item => item.id === id(input.id)); if (!connection) throw fail('Collegamento non trovato.', 'GITHUB_NOT_FOUND', 404); expected(input.expectedVersion, connection.version); state.connections = state.connections.filter(item => item !== connection); await persist(state); return { disconnected: connection.id }; }),
    inspect: (input: { connectionId: string; scopeId: string; repository: string }) => serial(async () => { const state = await load(), repository = repo(input.repository), connection = await authorize(state, input.connectionId, input.scopeId, repository); return metadata(connection, repository); }),
    readFile: (input: { connectionId: string; scopeId: string; repository: string; ref: string; path: string }) => serial(async () => {
      const state = await load(), repository = repo(input.repository), path = filePath(input.path), connection = await authorize(state, input.connectionId, input.scopeId, repository), reference = branch(input.ref);
      noSecrets(path + '\n' + reference, connection.token);
      const resolved = await request(connection, `/repos/${repository}/commits/${segment(reference)}`);
      if (!record(resolved)) throw fail('Commit GitHub non valido.', 'GITHUB_RESPONSE_INVALID', 502);
      const commit = sha(resolved.sha), root = (await commitTree(connection, repository, commit)).tree;
      const file = await treeReader(connection, repository, root)(path); if (!file) throw fail('File GitHub non trovato.', 'GITHUB_NOT_FOUND', 404);
      return { text: file.content.toString('utf8'), commit, blobSha: file.sha, path, repository, url: `https://github.com/${repository}/blob/${commit}/${path.split('/').map(segment).join('/')}` };
    }),
    preview: (input: { runId: string; connectionId: string; repository: string; baseBranch: string; title: string; body: string }) => serial(async () => {
      const state = await load(); if (state.publications.length >= 200) throw fail('Limite anteprime GitHub raggiunto.', 'GITHUB_CAPACITY', 409);
      const run = await approvedRun({ id: id(input.runId) }), repository = repo(input.repository), connection = await authorize(state, input.connectionId, run.scopeId, repository, true), baseBranch = branch(input.baseBranch);
      if (state.publications.some(item => item.runId === run.id && item.repository === repository && item.status !== 'preview')) throw fail('Questo incarico ha già una pubblicazione. Controllane l’esito.', 'GITHUB_PUBLICATION_EXISTS', 409);
      if (!SHA.test(run.baseCommit) || !HASH.test(run.patchHash) || hash(run.patch) !== run.patchHash || !run.files.length || run.files.length > 100 || Buffer.byteLength(run.patch) > 2 * 1024 * 1024) throw fail('Patch non pubblicabile: verifica impronta e limiti (100 file, 2 MiB).');
      const title = text(input.title || run.title, 240).trim(), body = text(input.body, 20000, true); if (/[\r\n]/.test(title)) throw fail('Il titolo deve essere su una riga.'); noSecrets(title + '\n' + body + '\n' + run.patch, connection.token);
      if ((await metadata(connection, repository)).archived) throw fail('Il repository GitHub è archiviato.', 'GITHUB_WRITE_DENIED', 409);
      if (await head(connection, repository, baseBranch) !== run.baseCommit) throw fail('Il branch GitHub è avanzato rispetto all’incarico. Prepara e verifica una nuova modifica.', 'GITHUB_STALE_BASE', 409);
      const baseTree = (await commitTree(connection, repository, run.baseCommit)).tree;
      const entries = await applyRepositoryPatch({ patch: run.patch, files: run.files, readBase: treeReader(connection, repository, baseTree) });
      if (Buffer.byteLength(JSON.stringify(entries)) > 4 * 1024 * 1024) throw fail('Anteprima GitHub troppo grande.', 'GITHUB_CAPACITY', 413);
      const candidate: Candidate = { version: 1, runVersion: run.version, connectionVersion: connection.version, baseTree, entries, patchHash: run.patchHash };
      const publicationId = randomUUID(), publication: Publication = { id: publicationId, version: 1, status: 'preview', runId: run.id, scopeId: run.scopeId, connectionId: connection.id, repository, baseBranch, baseCommit: run.baseCommit, patchHash: run.patchHash, candidateDigest: candidateDigest(candidate), files: clone(run.files), title, body, branch: `fuori-studio/${publicationId}`, createdAt: stamp() };
      await validRun(publication, candidate, connection);
      state.publications.push(publication); checkState(state);
      if (storage.batch) await storage.batch([{ key: `${KEY}/candidate/${publicationId}`, value: candidate }, { key: KEY, value: state }]);
      else { await storage.write(`${KEY}/candidate/${publicationId}`, candidate); await persist(state); }
      return publicPublication(publication);
    }),
    publish: (input: { id: string; expectedVersion: number }) => serial(async () => {
      const state = await load(), publication = publicationFor(state, input);
      if (publication.status === 'published') return publicPublication(publication);
      if (publication.status !== 'preview') throw fail('Prima verifica l’esito della pubblicazione interrotta.', 'GITHUB_RECONCILE_REQUIRED', 409);
      if (state.publications.some(item => item.id !== publication.id && item.runId === publication.runId && item.repository === publication.repository && item.status !== 'preview')) throw fail('Un’altra anteprima di questo incarico è già stata pubblicata o deve essere verificata.', 'GITHUB_PUBLICATION_EXISTS', 409);
      const connection = await authorize(state, publication.connectionId, publication.scopeId, publication.repository, true), candidate = await candidateFor(publication);
      await validRun(publication, candidate, connection);
      if (await head(connection, publication.repository, publication.baseBranch) !== publication.baseCommit) throw fail('Il branch GitHub è cambiato. Prepara un nuovo incarico e una nuova anteprima.', 'GITHUB_STALE_BASE', 409);
      const priorBranch = await head(connection, publication.repository, publication.branch, true);
      if (priorBranch && !await verifyBranch(connection, publication)) throw fail('Branch già esistente.', 'GITHUB_PUBLICATION_CONFLICT', 409);
      if (publication.pullRequested) throw fail('La creazione della PR è già stata tentata. Verifica l’esito.', 'GITHUB_RECONCILE_REQUIRED', 409);
      publication.status = 'publishing'; publication.version++; delete publication.error; delete publication.rejected; await persist(state);
      const intent = async (stage: Stage) => { await authorize(state, connection.id, publication.scopeId, publication.repository, true); await validRun(publication, candidate, connection); publication.stage = stage; if (stage === 'pull_request') publication.pullRequested = true; await persist(state); };
      try {
        if (!priorBranch) {
          await intent('tree');
          const value = await request(connection, `/repos/${publication.repository}/git/trees`, { method: 'POST', body: { base_tree: candidate.baseTree, tree: candidate.entries.map(entry => ({ path: entry.path, mode: entry.mode, type: 'blob', ...(entry.content === null ? { sha: null } : { content: entry.content }) })) } });
          if (!record(value)) throw fail('Albero creato non valido.', 'GITHUB_RESPONSE_INVALID', 502); publication.treeSha = sha(value.sha); await persist(state);
          await intent('commit');
          const commit = await request(connection, `/repos/${publication.repository}/git/commits`, { method: 'POST', body: { message: `${publication.title}\n\nFuori Studio publication: ${publication.id}\nPatch SHA-256: ${publication.patchHash}`, tree: publication.treeSha, parents: [publication.baseCommit] } });
          if (!record(commit) || !record(commit.tree) || commit.tree.sha !== publication.treeSha || !Array.isArray(commit.parents) || commit.parents.length !== 1 || !record(commit.parents[0]) || commit.parents[0].sha !== publication.baseCommit) throw fail('Commit creato non corrispondente.', 'GITHUB_RESPONSE_INVALID', 502);
          publication.commitSha = sha(commit.sha); await persist(state);
          if (await head(connection, publication.repository, publication.baseBranch) !== publication.baseCommit) throw fail('Il branch base è cambiato durante la preparazione.', 'GITHUB_STALE_BASE', 409);
          await intent('branch');
          const reference = await request(connection, `/repos/${publication.repository}/git/refs`, { method: 'POST', body: { ref: `refs/heads/${publication.branch}`, sha: publication.commitSha } });
          if (!record(reference) || reference.ref !== `refs/heads/${publication.branch}` || !record(reference.object) || reference.object.sha !== publication.commitSha) throw fail('Branch creato non corrispondente.', 'GITHUB_RESPONSE_INVALID', 502);
        }
        if (!await verifyBranch(connection, publication)) throw fail('Branch non disponibile.', 'GITHUB_PUBLICATION_CONFLICT', 409);
        const existing = await findPr(connection, publication);
        if (existing) { markPublished(publication, existing); publication.version++; await persist(state); return publicPublication(publication); }
        if (await head(connection, publication.repository, publication.baseBranch) !== publication.baseCommit) throw fail('Il branch base è cambiato. Il branch preparato resta disponibile per la revisione.', 'GITHUB_STALE_BASE', 409);
        await intent('pull_request');
        const response = await request(connection, `/repos/${publication.repository}/pulls`, { method: 'POST', body: { title: publication.title, body: publication.body, head: publication.branch, base: publication.baseBranch, draft: true, maintainer_can_modify: false } });
        const result = matchingPr(response, publication); if (!result) throw fail('La risposta della PR non corrisponde alla modifica.', 'GITHUB_RESPONSE_INVALID', 502);
        markPublished(publication, result); publication.version++; await persist(state); return publicPublication(publication);
      } catch (error) {
        publication.status = 'uncertain'; publication.version++; publication.rejected = record(error) && error.rejected === true;
        publication.error = publication.rejected ? 'GitHub ha rifiutato un passaggio. Verifica lo stato prima di riprovare.' : 'Esito da verificare: il branch o la PR potrebbero essere già presenti. Nessuna ripetizione automatica.';
        await persist(state); throw fail(publication.error, 'GITHUB_PUBLICATION_UNCERTAIN', 409);
      }
    }),
    reconcile: (input: { id: string; expectedVersion: number }) => serial(async () => {
      const state = await load(), publication = publicationFor(state, input);
      if (publication.status === 'published') return publicPublication(publication);
      if (!['uncertain', 'publishing'].includes(publication.status)) throw fail('Questa anteprima non richiede una verifica.', 'GITHUB_RECONCILE_REQUIRED', 409);
      const connection = await authorize(state, publication.connectionId, publication.scopeId, publication.repository);
      const exists = await verifyBranch(connection, publication);
      if (exists) {
        const result = await findPr(connection, publication);
        if (result) { markPublished(publication, result); }
        else if (!publication.pullRequested || publication.rejected) { publication.status = 'preview'; publication.pullRequested = false; publication.error = 'Branch verificato. Una nuova conferma può creare la PR.'; }
        else { publication.status = 'uncertain'; publication.error = 'La richiesta PR ha esito incerto e non è ancora visibile. Verifica nuovamente o controlla GitHub; la creazione non viene ripetuta.'; }
      } else if (publication.stage === 'tree' || publication.stage === 'commit' || publication.rejected && !publication.pullRequested) {
        publication.status = 'preview'; delete publication.treeSha; delete publication.commitSha; delete publication.stage; publication.error = 'Nessun branch pubblicato. Puoi confermare nuovamente la preparazione.';
      } else { publication.status = 'uncertain'; publication.error = 'Branch non rilevato ma una scrittura potrebbe essere stata accettata. Verifica nuovamente senza ripetere la pubblicazione.'; }
      publication.version++; await persist(state); return publicPublication(publication);
    }),
  };
}
