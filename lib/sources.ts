import { createHash, randomUUID } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import { isIP } from 'node:net';
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';

export interface SourceStorage { read(key: string, fallback?: unknown): Promise<unknown>; write(key: string, value: unknown): Promise<unknown>; }
export interface SourceWorkspace { getSnapshot(): Promise<{ scopes: Array<{ id: string; kind?: string }> }>; }
export interface Citation { url: string; title: string; startIndex?: number; endIndex?: number; }
export interface ResearchResult { text: string; citations: Citation[]; sources?: Citation[]; searchCalls?: number; usage?: unknown; provider?: string | { id: string; type: string; model: string }; durationMs?: number; }
export interface ResearchInput { scopeId: string; connectionId: string; query: string; domains?: string[]; signal?: AbortSignal; }
export interface SourceSegment { id: string; text: string; page: number | null; lineStart: number | null; lineEnd: number | null; }
export type SourceKind = 'text' | 'document' | 'url' | 'folder-file' | 'github' | 'research';
export interface SourceMetadata {
  id: string; scopeId: string; kind: SourceKind; title: string; filename: string | null; url: string | null;
  version: number; digest: string; createdAt: string; retrievedAt: string; staleAt: string | null;
  status: 'current' | 'stale'; bytes: number; segmentCount: number; untrusted: true; refreshable: boolean;
  github?: { repository: string; commit: string; blobSha: string; path: string };
}
export interface GitHubSourceInput { scopeId: string; connectionId: string; repository: string; ref: string; path: string; title?: string; signal?: AbortSignal; }
export interface GitHubSourceFile { text: string; commit: string; blobSha: string; path: string; repository: string; url: string; }
interface Origin { type: 'manual' | 'url' | 'file' | 'github-file'; path?: string; url?: string; connectionId?: string; repository?: string; ref?: string; }
interface SourceRecord extends Omit<SourceMetadata, 'status' | 'segmentCount' | 'untrusted' | 'refreshable'> { segments: SourceSegment[]; citationSources: Citation[]; origin: Origin; }
interface SourceState { version: 1; records: SourceRecord[]; }
export interface SourceDetail { source: SourceMetadata; segments: SourceSegment[]; citationSources: Citation[]; }
export interface PinnedAddress { address: string; family: 4 | 6; }
export interface UrlResponse { statusCode: number; headers: Record<string, string | undefined>; body: Buffer; }
export interface SourceOptions {
  storage: SourceStorage; workspace: SourceWorkspace; mode?: 'local' | 'online' | 'hybrid';
  allowedRoots?: string[] | (() => Promise<string[]>);
  search?: (input: ResearchInput) => Promise<ResearchResult>;
  github?: (input: GitHubSourceInput) => Promise<GitHubSourceFile>;
  resolveHost?: (hostname: string) => Promise<PinnedAddress[]>;
  transport?: (url: URL, address: PinnedAddress, options: { maxBytes: number; signal: AbortSignal }) => Promise<UrlResponse>;
  now?: () => number; maxDocumentBytes?: number; maxTextChars?: number; maxRecords?: number; requestTimeoutMs?: number;
}
const KEY = 'sources', MAX_ARCHIVE_BYTES = 20 * 1024 * 1024, SEGMENT_CHARS = 2200, MAX_SEGMENTS = 1000;
const BLOCKED_PARTS = new Set(['.git', '.local', '.codex', '.agents', '.ssh', '.aws', '.azure', '.config', '.cache', 'node_modules', 'vendor', 'dist', 'build', 'coverage', '.next', '.venv', 'venv']);
const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.rst', '.csv', '.json', '.yaml', '.yml', '.toml', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.css', '.html', '.sql', '.sh', '.go', '.rs']);
const fail = (message: string, code = 'SOURCE_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode, status: statusCode });
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const clone = <T>(value: T): T => structuredClone(value);
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function bounded(value: unknown, max: number, label: string): string { if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0')) throw fail(`${label} non valido o troppo lungo.`); return value.trim(); }
function identifier(value: unknown): string { const result = bounded(value, 100, 'Identificativo'); if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(result)) throw fail('Identificativo non valido.'); return result; }
function safeFilename(value: unknown): string { const name = bounded(value, 255, 'Nome documento'); if (/[\r\n/\\]/.test(name) || name === '.' || name === '..' || forbidden(name)) throw fail('Nome documento non consentito.'); return name; }
function forbidden(path: string): boolean { return path.split(/[\\/]/).some(part => BLOCKED_PARTS.has(part.toLowerCase()) || /^(?:\.env(?:\..*)?|\.npmrc|\.netrc|auth\.json|credentials(?:\.json)?|id_rsa|id_ed25519)$/i.test(part) || /\.(?:pem|key|p12|pfx|sqlite|db)$/i.test(part)); }
const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

/** Only globally routable addresses are accepted; every DNS answer is checked. */
export function isPublicSourceAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const [a, b, c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    if (normalized.includes('.') || normalized.includes('%')) return false;
    const first = Number.parseInt(normalized.split(':')[0], 16);
    if (!Number.isInteger(first) || first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x3ffe || first === 0x3fff) return false;
    if (first === 0x2001) { const second = Number.parseInt(normalized.split(':')[1] || '0', 16); if (second < 0x0200 || second === 0x0db8) return false; }
    return true;
  }
  return false;
}
function publicUrl(value: unknown): URL {
  const raw = bounded(value, 2048, 'URL'); let url: URL;
  try { url = new URL(raw); } catch { throw fail('URL non valido.'); }
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !hostname.includes('.') && !isIP(hostname) || /(?:^|\.)(?:localhost|local|internal|home|lan|test|invalid|example)$/.test(hostname) || (isIP(hostname) && !isPublicSourceAddress(hostname))) throw fail('Sono consentiti soltanto URL HTTPS pubblici, senza credenziali o porte personalizzate.', 'SOURCE_URL_DENIED', 403);
  url.hash = ''; return url;
}
async function defaultResolve(hostname: string): Promise<PinnedAddress[]> { const answers = await lookup(hostname, { all: true, verbatim: true }); return answers.map(answer => ({ address: answer.address, family: answer.family as 4 | 6 })); }
async function defaultTransport(url: URL, address: PinnedAddress, options: { maxBytes: number; signal: AbortSignal }): Promise<UrlResponse> {
  return new Promise((resolveRequest, reject) => {
    const req = request(url, { method: 'GET', agent: false, family: address.family, signal: options.signal, lookup: (_host, _options, callback) => callback(null, address.address, address.family), headers: { Accept: 'text/html,text/plain,text/markdown,application/pdf,application/json;q=0.8', 'Accept-Encoding': 'identity', 'User-Agent': 'FuoriStudio/0.3 SourceReader' } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.once('error', reject);
      const contentLength = Number(response.headers['content-length']);
      if (Number.isFinite(contentLength) && contentLength > options.maxBytes) { response.destroy(fail('La fonte supera la dimensione massima.', 'SOURCE_TOO_LARGE', 413)); return; }
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > options.maxBytes) response.destroy(fail('La fonte supera la dimensione massima.', 'SOURCE_TOO_LARGE', 413)); else chunks.push(chunk); });
      response.once('end', () => resolveRequest({ statusCode: response.statusCode || 0, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(',') : value])), body: Buffer.concat(chunks) }));
    });
    req.once('error', reject); req.end();
  });
}
function htmlText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '').replace(/<\/(?:p|div|section|article|li|h[1-6]|tr)>|<br\b[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&(?:nbsp|amp|lt|gt|quot|apos);|&#(?:x[0-9a-f]+|\d+);/gi, entity => { const named: Record<string, string> = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" }; if (named[entity.toLowerCase()]) return named[entity.toLowerCase()]; const point = Number.parseInt(entity.replace(/^&#x?/i, '').replace(/;$/, ''), /^&#x/i.test(entity) ? 16 : 10); return Number.isInteger(point) && point > 0 && point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : ' '; }).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}
function segmentsFromText(input: string, page: number | null = null): SourceSegment[] {
  const lines = input.replace(/\r\n?/g, '\n').split('\n'), segments: SourceSegment[] = [];
  let chunk = '', first = 1, last = 1;
  const flush = () => { if (chunk.trim()) segments.push({ id: randomUUID(), text: chunk.trim(), page, lineStart: page === null ? first : null, lineEnd: page === null ? last : null }); chunk = ''; };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (let offset = 0; offset < Math.max(1, line.length); offset += SEGMENT_CHARS) {
      const part = line.slice(offset, offset + SEGMENT_CHARS);
      if (chunk.length + part.length + 1 > SEGMENT_CHARS) flush();
      if (!chunk) first = i + 1; last = i + 1; chunk += part + '\n';
    }
  }
  flush(); return segments;
}
async function pdfSegments(data: Buffer, maxChars: number, signal?: AbortSignal): Promise<SourceSegment[]> {
  if (signal?.aborted) throw fail('Estrazione interrotta.', 'SOURCE_ABORTED', 499);
  return new Promise((resolvePdf, reject) => {
    const worker = new Worker(new URL('./source-pdf-worker.mjs', import.meta.url), { workerData: { data, maxPages: 200, maxChars }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
    let settled = false;
    const finish = (error?: Error, pages?: Array<{ page: number; text: string }>) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); void worker.terminate(); if (error) reject(error); else resolvePdf((pages || []).flatMap(page => segmentsFromText(page.text, page.page))); };
    const abort = () => finish(fail('Estrazione interrotta.', 'SOURCE_ABORTED', 499));
    const timer = setTimeout(() => finish(fail('Il PDF richiede troppo tempo per essere letto.', 'SOURCE_PDF_TIMEOUT', 408)), 15000);
    worker.once('error', () => finish(fail('Impossibile leggere questo PDF.', 'SOURCE_PDF_INVALID')));
    worker.once('exit', () => { if (!settled) finish(fail('Estrazione PDF interrotta.', 'SOURCE_PDF_INVALID')); });
    worker.once('message', (message: unknown) => { if (!record(message) || !Array.isArray(message.pages)) { finish(fail('PDF protetto, non valido o oltre i limiti di estrazione.', 'SOURCE_PDF_INVALID')); return; } const pages = message.pages as Array<{ page: number; text: string }>; if (pages.some(page => !record(page) || !Number.isInteger(page.page) || typeof page.text !== 'string')) { finish(fail('Risposta PDF non valida.', 'SOURCE_PDF_INVALID')); return; } finish(undefined, pages); });
    signal?.addEventListener('abort', abort, { once: true });
  });
}
function validateState(value: unknown): SourceState {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.records) || value.records.length > 500) throw fail('Archivio fonti non valido.', 'SOURCE_ARCHIVE_INVALID', 503);
  const ids = new Set<string>();
  for (const item of value.records) {
    if (!record(item) || typeof item.id !== 'string' || ids.has(item.id) || !Number.isSafeInteger(item.version) || Number(item.version) < 1 || !Array.isArray(item.segments) || item.segments.length > MAX_SEGMENTS || !Array.isArray(item.citationSources) || !record(item.origin)) throw fail('Fonte archiviata non valida.', 'SOURCE_ARCHIVE_INVALID', 503);
    identifier(item.id); identifier(item.scopeId); bounded(item.title, 200, 'Titolo');
    if (!['text', 'document', 'url', 'folder-file', 'github', 'research'].includes(String(item.kind)) || !['manual', 'url', 'file', 'github-file'].includes(String(item.origin.type)) || typeof item.digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.digest) || !Number.isSafeInteger(item.bytes) || Number(item.bytes) < 0) throw fail('Metadati fonte non validi.', 'SOURCE_ARCHIVE_INVALID', 503);
    for (const date of [item.createdAt, item.retrievedAt, ...(item.staleAt === null ? [] : [item.staleAt])]) if (typeof date !== 'string' || !Number.isFinite(Date.parse(date)) || date !== new Date(date).toISOString()) throw fail('Data fonte non valida.', 'SOURCE_ARCHIVE_INVALID', 503);
    if (item.filename !== null) safeFilename(item.filename);
    if (item.url !== null) publicUrl(item.url);
    if (item.origin.type === 'url') publicUrl(item.origin.url);
    if (item.origin.type === 'github-file') {
      identifier(item.origin.connectionId);
      if (!record(item.github) || item.kind !== 'github' || item.origin.repository !== item.github.repository || item.origin.path !== item.github.path || typeof item.github.repository !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(item.github.repository) || typeof item.github.commit !== 'string' || !/^[a-f0-9]{40}$/.test(item.github.commit) || typeof item.github.blobSha !== 'string' || !/^[a-f0-9]{40}$/.test(item.github.blobSha) || typeof item.github.path !== 'string' || forbidden(item.github.path)) throw fail('Provenienza GitHub non valida.', 'SOURCE_ARCHIVE_INVALID', 503);
      bounded(item.origin.ref, 255, 'Riferimento GitHub');
    }
    if (item.origin.type === 'file' && (typeof item.origin.path !== 'string' || !isAbsolute(item.origin.path) || forbidden(item.origin.path))) throw fail('Origine locale non valida.', 'SOURCE_ARCHIVE_INVALID', 503);
    if (item.citationSources.length > 100) throw fail('Troppe citazioni.', 'SOURCE_ARCHIVE_INVALID', 503);
    for (const citation of item.citationSources) { if (!record(citation)) throw fail('Citazione non valida.'); publicUrl(citation.url); bounded(citation.title, 500, 'Titolo citazione'); }
    for (const segment of item.segments) {
      if (!record(segment) || typeof segment.text !== 'string' || !segment.text.trim() || segment.text.includes('\0') || segment.text.length > SEGMENT_CHARS + 1 || typeof segment.id !== 'string' || (segment.page !== null && (!Number.isInteger(segment.page) || Number(segment.page) < 1 || Number(segment.page) > 200))) throw fail('Testo fonte non valido.', 'SOURCE_ARCHIVE_INVALID', 503);
      identifier(segment.id);
      if (segment.page !== null ? segment.lineStart !== null || segment.lineEnd !== null : !Number.isInteger(segment.lineStart) || !Number.isInteger(segment.lineEnd) || Number(segment.lineStart) < 1 || Number(segment.lineEnd) < Number(segment.lineStart)) throw fail('Riferimenti documento non validi.', 'SOURCE_ARCHIVE_INVALID', 503);
    }
    if (digest(JSON.stringify(item.segments.map(segment => ({ text: segment.text, page: segment.page, lineStart: segment.lineStart, lineEnd: segment.lineEnd })))) !== item.digest) throw fail('Impronta documento non valida.', 'SOURCE_ARCHIVE_INVALID', 503);
    ids.add(item.id);
  }
  return value as unknown as SourceState;
}

export function createSourceStore({ storage, workspace, mode = 'local', allowedRoots = [], search, github, resolveHost = defaultResolve, transport = defaultTransport, now = Date.now, maxDocumentBytes = 8 * 1024 * 1024, maxTextChars = 600000, maxRecords = 300, requestTimeoutMs = 15000 }: SourceOptions) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(operation: () => Promise<T>): Promise<T> => { const result = queue.then(operation); queue = result.catch(() => {}); return result; };
  const load = async () => validateState(await storage.read(KEY, { version: 1, records: [] }));
  const timestamp = () => new Date(now()).toISOString();
  const metadata = (source: SourceRecord): SourceMetadata => { const { segments, origin, citationSources, ...rest } = source; return { ...clone(rest), segmentCount: segments.length, status: source.staleAt && Date.parse(source.staleAt) <= now() ? 'stale' : 'current', untrusted: true, refreshable: origin.type !== 'manual' }; };
  const detail = (source: SourceRecord): SourceDetail => ({ source: metadata(source), segments: clone(source.segments), citationSources: clone(source.citationSources) });
  async function scope(scopeId: string): Promise<string> { identifier(scopeId); if (!(await workspace.getSnapshot()).scopes.some(item => item.id === scopeId)) throw fail('Ambito non trovato.', 'NOT_FOUND', 404); return scopeId; }
  async function save(state: SourceState): Promise<void> { validateState(state); if (state.records.length > maxRecords || Buffer.byteLength(JSON.stringify(state)) > MAX_ARCHIVE_BYTES) throw fail('Archivio fonti pieno: rimuovi alcuni documenti prima di importarli.', 'SOURCE_ARCHIVE_FULL', 413); await storage.write(KEY, state); }
  const find = (state: SourceState, id: string, scopeId: string): SourceRecord => { const found = state.records.find(item => item.id === identifier(id) && item.scopeId === scopeId); if (!found) throw fail('Fonte non trovata in questo ambito.', 'NOT_FOUND', 404); return found; };
  const checkVersion = (source: SourceRecord, version: number) => { if (!Number.isSafeInteger(version) || version !== source.version) throw fail('La fonte è cambiata: ricarica prima di continuare.', 'VERSION_CONFLICT', 409); };
  function make(input: { scopeId: string; kind: SourceKind; title: string; filename?: string | null; url?: string | null; segments: SourceSegment[]; bytes: number; origin: Origin; citationSources?: Citation[] }): SourceRecord {
    if (!input.segments.length || !input.segments.some(segment => segment.text.trim())) throw fail('Il documento non contiene testo leggibile. I PDF scansionati richiedono OCR esterno.', 'SOURCE_EMPTY');
    if (input.segments.length > MAX_SEGMENTS || input.segments.reduce((sum, segment) => sum + segment.text.length, 0) > maxTextChars) throw fail('Il testo estratto supera il limite.', 'SOURCE_TOO_LARGE', 413);
    const retrievedAt = timestamp();
    return { id: randomUUID(), scopeId: input.scopeId, kind: input.kind, title: bounded(input.title, 200, 'Titolo'), filename: input.filename || null, url: input.url || null, version: 1, digest: digest(JSON.stringify(input.segments.map(({ text, page, lineStart, lineEnd }) => ({ text, page, lineStart, lineEnd })))), createdAt: retrievedAt, retrievedAt, staleAt: input.origin.type === 'manual' ? null : new Date(now() + 7 * 86400000).toISOString(), bytes: input.bytes, segments: input.segments, origin: input.origin, citationSources: input.citationSources || [] };
  }
  async function store(source: SourceRecord): Promise<SourceDetail> { return serial(async () => { const state = await load(); state.records.push(source); await save(state); return detail(source); }); }
  async function fromGitHub(input: GitHubSourceInput): Promise<SourceRecord> {
    if (!github) throw fail('Collegamento GitHub autenticato non configurato.', 'SOURCE_GITHUB_UNAVAILABLE', 409);
    identifier(input.connectionId); bounded(input.ref, 255, 'Riferimento GitHub');
    if (typeof input.path !== 'string' || !input.path || input.path.length > 1000 || input.path.startsWith('/') || /[\\\0\r\n]/.test(input.path) || input.path.split('/').some(part => !part || part === '.' || part === '..') || forbidden(input.path) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository)) throw fail('Percorso GitHub non consentito.', 'SOURCE_GITHUB_PATH_DENIED', 403);
    const result = await github(input);
    if (!result || result.path !== input.path || result.repository.toLowerCase() !== input.repository.toLowerCase() || !/^[a-f0-9]{40}$/.test(result.commit) || !/^[a-f0-9]{40}$/.test(result.blobSha) || typeof result.text !== 'string' || result.text.includes('\0') || result.text.length > maxTextChars) throw fail('La fonte GitHub non è verificabile.', 'SOURCE_GITHUB_INVALID', 409);
    const bytes = Buffer.from(result.text, 'utf8');
    if (createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== result.blobSha) throw fail('Il contenuto non corrisponde al blob GitHub.', 'SOURCE_GITHUB_INVALID', 409);
    const url = `https://github.com/${result.repository}/blob/${result.commit}/${result.path.split('/').map(encodeURIComponent).join('/')}`;
    const source = make({ scopeId: input.scopeId, kind: 'github', title: input.title || `${result.repository}: ${result.path}`, filename: safeFilename(basename(result.path)), url, segments: segmentsFromText(result.text), bytes: bytes.length, origin: { type: 'github-file', connectionId: input.connectionId, repository: result.repository, ref: input.ref, path: result.path } });
    source.github = { repository: result.repository, commit: result.commit, blobSha: result.blobSha, path: result.path };
    return source;
  }
  async function extract(data: Buffer, mimeType: string, filename?: string, signal?: AbortSignal): Promise<SourceSegment[]> {
    if (data.length > maxDocumentBytes) throw fail('Documento troppo grande.', 'SOURCE_TOO_LARGE', 413);
    if (mimeType === 'application/pdf' || filename?.toLowerCase().endsWith('.pdf')) { if (!data.subarray(0, 1024).includes(Buffer.from('%PDF-'))) throw fail('Il file non è un PDF valido.'); return pdfSegments(data, maxTextChars, signal); }
    if (!['text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/json'].includes(mimeType)) throw fail('Formato non supportato: importa testo, Markdown o PDF.', 'SOURCE_MIME_DENIED');
    let content: string; try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw fail('Il documento deve usare testo UTF-8.', 'SOURCE_ENCODING_INVALID'); }
    if (content.includes('\0') || content.length > maxTextChars) throw fail('Documento binario o testo troppo grande.', 'SOURCE_TOO_LARGE', 413);
    return segmentsFromText(mimeType === 'text/html' ? htmlText(content) : content);
  }
  async function fetchUrl(input: string, signal?: AbortSignal): Promise<{ url: URL; body: Buffer; mimeType: string }> {
    let url = publicUrl(input); const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    const abortable = <T>(operation: Promise<T>): Promise<T> => new Promise((resolveOperation, reject) => { const stop = () => reject(fail('Lettura fonte interrotta o scaduta.', signal?.aborted ? 'SOURCE_ABORTED' : 'SOURCE_TIMEOUT', signal?.aborted ? 499 : 408)); if (controller.signal.aborted) { stop(); return; } controller.signal.addEventListener('abort', stop, { once: true }); operation.then(resolveOperation, reject).finally(() => controller.signal.removeEventListener('abort', stop)); });
    try {
      for (let redirects = 0; redirects <= 3; redirects++) {
        const hostname = url.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) as 4 | 6 }] : await abortable(resolveHost(hostname));
        if (!addresses.length || addresses.some(address => !isPublicSourceAddress(address.address) || isIP(address.address) !== address.family)) throw fail('La fonte risolve verso un indirizzo privato o riservato.', 'SOURCE_URL_DENIED', 403);
        const response = await abortable(transport(url, addresses[0], { maxBytes: maxDocumentBytes, signal: controller.signal }));
        if (response.body.length > maxDocumentBytes) throw fail('La fonte supera la dimensione massima.', 'SOURCE_TOO_LARGE', 413);
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) { if (redirects === 3 || !response.headers.location) throw fail('Troppi reindirizzamenti nella fonte.', 'SOURCE_REDIRECT_LIMIT'); url = publicUrl(new URL(response.headers.location, url).href); continue; }
        if (response.statusCode !== 200) throw fail(`La fonte ha risposto con HTTP ${response.statusCode}.`, 'SOURCE_HTTP_ERROR', 502);
        if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') throw fail('La fonte richiede una compressione non supportata.', 'SOURCE_ENCODING_INVALID');
        const mimeType = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
        if (!['text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/pdf', 'application/json'].includes(mimeType)) throw fail('Il sito non restituisce un documento supportato.', 'SOURCE_MIME_DENIED');
        return { url, body: response.body, mimeType };
      }
      throw fail('Reindirizzamento non valido.');
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
  async function fromUrl({ scopeId, url: input, title, signal }: { scopeId: string; url: string; title?: string; signal?: AbortSignal }): Promise<SourceRecord> {
    const original = publicUrl(input); let fetchTarget = original.href, kind: SourceKind = 'url';
    if (original.hostname === 'github.com') {
      const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:\/(issues)\/(\d+))?\/?$/.exec(original.pathname);
      if (!match || original.search) throw fail('Per GitHub scegli l’URL pubblico di un repository o di una issue.', 'SOURCE_GITHUB_URL_INVALID');
      fetchTarget = `https://api.github.com/repos/${match[1]}/${match[2]}${match[3] ? `/issues/${match[4]}` : ''}`; kind = 'github';
    }
    const fetched = await fetchUrl(fetchTarget, signal);
    let segments: SourceSegment[], selectedTitle = title;
    if (kind === 'github') {
      if (fetched.url.hostname !== 'api.github.com' || fetched.mimeType !== 'application/json') throw fail('Risposta GitHub inattesa.');
      let payload: unknown; try { payload = JSON.parse(fetched.body.toString('utf8')); } catch { throw fail('Risposta GitHub non valida.'); }
      if (!record(payload) || payload.private === true) throw fail('Il connettore legge soltanto repository pubblici.');
      selectedTitle ||= typeof payload.title === 'string' ? payload.title : typeof payload.full_name === 'string' ? payload.full_name : original.pathname;
      const content = ['Fonte GitHub pubblica: ' + original.href, typeof payload.full_name === 'string' ? `Repository: ${payload.full_name}` : '', typeof payload.description === 'string' ? payload.description : '', typeof payload.title === 'string' ? `Issue: ${payload.title}` : '', typeof payload.state === 'string' ? `Stato: ${payload.state}` : '', typeof payload.body === 'string' ? payload.body : '', typeof payload.updated_at === 'string' ? `Aggiornata: ${payload.updated_at}` : '', typeof payload.language === 'string' ? `Linguaggio: ${payload.language}` : '', typeof payload.default_branch === 'string' ? `Branch predefinito: ${payload.default_branch}` : ''].filter(Boolean).join('\n\n');
      if (content.length > maxTextChars) throw fail('Testo GitHub troppo grande.', 'SOURCE_TOO_LARGE', 413); segments = segmentsFromText(content);
    } else segments = await extract(fetched.body, fetched.mimeType, undefined, signal);
    return make({ scopeId, kind, title: selectedTitle || original.hostname + original.pathname, url: kind === 'github' ? original.href : fetched.url.href, segments, bytes: fetched.body.length, origin: { type: 'url', url: original.href } });
  }
  async function allowedPath(path: string): Promise<string> {
    if (mode !== 'local') throw fail('Le cartelle sono disponibili soltanto sullo studio locale.', 'SOURCE_LOCAL_ONLY', 409);
    if (!isAbsolute(path) || path.includes('\0') || forbidden(path)) throw fail('Cartella o file non consentito.', 'SOURCE_PATH_DENIED', 403);
    const roots = typeof allowedRoots === 'function' ? await allowedRoots() : allowedRoots;
    const canonicalRoots = await Promise.all(roots.map(async root => ({ original: resolve(root), canonical: await realpath(root) })));
    const canonical = await realpath(path), input = resolve(path);
    const selectedRoot = canonicalRoots.find(root => inside(root.canonical, canonical) && (inside(root.original, input) || inside(root.canonical, input)));
    if (!selectedRoot || (await lstat(path)).isSymbolicLink()) throw fail('Scegli una cartella fra le radici locali autorizzate.', 'SOURCE_PATH_DENIED', 403);
    const lexicalRoot = inside(selectedRoot.canonical, input) ? selectedRoot.canonical : selectedRoot.original;
    if (resolve(selectedRoot.canonical, relative(lexicalRoot, input)) !== canonical) throw fail('Collegamento simbolico nel percorso non consentito.', 'SOURCE_PATH_DENIED', 403);
    let current = selectedRoot.canonical;
    for (const part of relative(selectedRoot.canonical, canonical).split(sep).filter(Boolean)) { current = join(current, part); if ((await lstat(current)).isSymbolicLink()) throw fail('Collegamento simbolico non consentito.', 'SOURCE_PATH_DENIED', 403); }
    return canonical;
  }
  async function fromFile(scopeId: string, path: string, title?: string): Promise<SourceRecord> {
    const canonical = await allowedPath(path), file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    let bytes: Buffer;
    try {
      const limit = Math.min(maxDocumentBytes, 512000), info = await file.stat();
      if (!info.isFile() || info.size > limit) throw fail('File non regolare o troppo grande.', 'SOURCE_TOO_LARGE', 413);
      // A growing or replaced file must not bypass the stat bound or export
      // bytes opened through a directory changed during authorization.
      const buffer = Buffer.alloc(limit + 1); let offset = 0;
      while (offset < buffer.length) { const result = await file.read(buffer, offset, buffer.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
      if (offset > limit) throw fail('Il file è cresciuto oltre la dimensione massima.', 'SOURCE_TOO_LARGE', 413);
      const after = await lstat(canonical), afterCanonical = await allowedPath(canonical);
      if (afterCanonical !== canonical || after.isSymbolicLink() || after.dev !== info.dev || after.ino !== info.ino || after.size !== info.size || after.mtimeMs !== info.mtimeMs) throw fail('Il file è cambiato durante la lettura: riprova.', 'SOURCE_FILE_CHANGED', 409);
      bytes = buffer.subarray(0, offset);
    } finally { await file.close(); }
    return make({ scopeId, kind: 'folder-file', title: title || basename(path), filename: basename(path), bytes: bytes.length, segments: await extract(bytes, 'text/plain'), origin: { type: 'file', path: canonical } });
  }
  const connectors = [
    { id: 'documents', name: 'Documenti', enabled: true, readOnly: true, capabilities: ['text', 'markdown', 'pdf-pages'], limitations: 'PDF con testo incorporato; nessun OCR o esecuzione di contenuti.' },
    { id: 'web', name: 'Pagine HTTPS', enabled: true, readOnly: true, capabilities: ['single-url', 'refresh'], limitations: 'Pagine pubbliche statiche; nessun login, browser o crawling automatico.' },
    { id: 'github', name: 'GitHub pubblico', enabled: true, readOnly: true, capabilities: ['repository-metadata', 'issue-body', 'refresh'], limitations: 'Nessuna credenziale; nessuna scrittura, repository privato o importazione implicita di commenti.' },
    { id: 'github-private', name: 'File GitHub autorizzati', enabled: Boolean(github), readOnly: true, capabilities: ['selected-file', 'commit-provenance', 'refresh'], limitations: 'File di testo selezionati, con ambiti e repository autorizzati. La copia importata rimane fino a rimozione o scadenza; revocare una connessione impedisce nuove letture.' },
    { id: 'folders', name: 'Cartelle autorizzate', enabled: mode === 'local', readOnly: true, capabilities: ['selected-folder', 'text-files', 'refresh'], limitations: 'Solo radici configurate; file sensibili, dipendenze e collegamenti esclusi.' },
    { id: 'research', name: 'Ricerca web AI', enabled: Boolean(search), readOnly: true, capabilities: ['opt-in-query', 'citations'], limitations: 'Richiede una connessione OpenAI API autorizzata; ogni ricerca è esplicita e può avere un costo.' },
  ];
  return {
    allMetadata: () => serial(async () => (await load()).records.map(metadata)),
    // Local search takes one scoped archive snapshot, avoiding one full archive
    // decryption per document. It never refreshes or fetches a source.
    searchSnapshot: async ({ scopeIds }: { scopeIds: string[] }) => {
      if (!Array.isArray(scopeIds) || !scopeIds.length || scopeIds.length > 200) throw fail('Ambiti di ricerca non validi.');
      const selected = new Set(scopeIds.map(identifier)), known = new Set((await workspace.getSnapshot()).scopes.map(item => item.id));
      if ([...selected].some(id => !known.has(id))) throw fail('Ambito non trovato.', 'NOT_FOUND', 404);
      return serial(async () => (await load()).records.filter(item => selected.has(item.scopeId)).map(detail));
    },
    snapshot: async ({ scopeId }: { scopeId: string }) => { await scope(scopeId); return serial(async () => ({ sources: (await load()).records.filter(item => item.scopeId === scopeId).map(metadata), connectors: clone(connectors), limits: { maxDocumentBytes, maxTextChars, maxRecords, maxFolderFiles: 60 } })); },
    detail: async ({ id, scopeId }: { id: string; scopeId: string }) => { await scope(scopeId); return serial(async () => detail(find(await load(), id, scopeId))); },
    importText: async ({ scopeId, title, text, filename }: { scopeId: string; title: string; text: string; filename?: string }) => { await scope(scopeId); const content = bounded(text, maxTextChars, 'Testo'); return store(make({ scopeId, kind: 'text', title, filename: filename ? safeFilename(filename) : null, segments: segmentsFromText(content), bytes: Buffer.byteLength(content), origin: { type: 'manual' } })); },
    // Internal composition primitive, deliberately absent from the HTTP action allowlist.
    // Validate all documents before one durable write; never leave a partial batch.
    importTextBatch: async (input: { scopeId: string; documents: Array<{ title: string; text: string; filename?: string }> }): Promise<SourceDetail[]> => {
      if (!record(input) || Object.keys(input).some(key => !['scopeId', 'documents'].includes(key)) || !Array.isArray(input.documents) || !input.documents.length || input.documents.length > 5) throw fail('Gruppo di documenti non valido.');
      await scope(input.scopeId);
      const imported = input.documents.map(document => {
        if (!record(document) || Object.keys(document).some(key => !['title', 'text', 'filename'].includes(key))) throw fail('Documento del gruppo non valido.');
        const content = bounded(document.text, maxTextChars, 'Testo');
        return make({ scopeId: input.scopeId, kind: 'text', title: document.title, filename: document.filename === undefined ? null : safeFilename(document.filename), segments: segmentsFromText(content), bytes: Buffer.byteLength(content), origin: { type: 'manual' } });
      });
      return serial(async () => { await scope(input.scopeId); const state = await load(); state.records.push(...imported); await save(state); return imported.map(detail); });
    },
    importDocument: async ({ scopeId, title, filename, mimeType, dataBase64, signal }: { scopeId: string; title: string; filename: string; mimeType: string; dataBase64: string; signal?: AbortSignal }) => { await scope(scopeId); safeFilename(filename); if (typeof dataBase64 !== 'string' || dataBase64.length > Math.ceil(maxDocumentBytes / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(dataBase64)) throw fail('Documento codificato non valido o troppo grande.', 'SOURCE_TOO_LARGE', 413); const data = Buffer.from(dataBase64, 'base64'); if (data.toString('base64') !== dataBase64) throw fail('Codifica documento non valida.'); return store(make({ scopeId, kind: 'document', title, filename, segments: await extract(data, mimeType, filename, signal), bytes: data.length, origin: { type: 'manual' } })); },
    importUrl: async (input: { scopeId: string; url: string; title?: string; signal?: AbortSignal }) => { await scope(input.scopeId); return store(await fromUrl(input)); },
    importGitHub: async (input: GitHubSourceInput) => { await scope(input.scopeId); return store(await fromGitHub(input)); },
    importFolder: async ({ scopeId, path }: { scopeId: string; path: string }) => {
      await scope(scopeId); const folder = await allowedPath(path); if (!(await lstat(folder)).isDirectory()) throw fail('Seleziona una cartella.');
      const imported: SourceRecord[] = [], skipped: Array<{ path: string; reason: string }> = []; let count = 0, total = 0;
      const visit = async (directory: string, depth: number): Promise<void> => {
        if (depth > 8) { skipped.push({ path: relative(folder, directory), reason: 'Profondità massima raggiunta.' }); return; }
        for (const item of await readdir(directory, { withFileTypes: true })) {
          if (++count > 2000) throw fail('La cartella contiene troppi elementi.', 'SOURCE_TOO_LARGE', 413);
          const file = join(directory, item.name), name = relative(folder, file);
          if (item.isSymbolicLink() || forbidden(name)) { if (skipped.length < 100) skipped.push({ path: name, reason: 'Percorso protetto o collegamento simbolico.' }); continue; }
          if (item.isDirectory()) { await visit(file, depth + 1); continue; }
          if (!item.isFile() || !TEXT_EXTENSIONS.has(extname(item.name).toLowerCase())) continue;
          if (imported.length >= 60) throw fail('Importa una sottocartella con al massimo 60 file di testo.', 'SOURCE_TOO_LARGE', 413);
          try { const source = await fromFile(scopeId, file, name); total += source.bytes; if (total > 2 * 1024 * 1024) throw fail('La cartella supera 2 MiB di testo.', 'SOURCE_FOLDER_TOO_LARGE', 413); imported.push(source); } catch (error) { if (record(error) && error.code === 'SOURCE_FOLDER_TOO_LARGE') throw error; if (skipped.length < 100) skipped.push({ path: name, reason: error instanceof Error ? error.message : 'File non leggibile.' }); }
        }
      };
      await visit(folder, 0);
      return serial(async () => { const state = await load(); state.records.push(...imported); await save(state); return { imported: imported.map(metadata), skipped }; });
    },
    refresh: async ({ id, scopeId, version, signal }: { id: string; scopeId: string; version: number; signal?: AbortSignal }) => {
      await scope(scopeId); const source = await serial(async () => clone(find(await load(), id, scopeId))); checkVersion(source, version);
      const refreshed = source.origin.type === 'url' && source.origin.url ? await fromUrl({ scopeId, url: source.origin.url, title: source.title, signal }) : source.origin.type === 'file' && source.origin.path ? await fromFile(scopeId, source.origin.path, source.title) : source.origin.type === 'github-file' ? await fromGitHub({ scopeId, connectionId: source.origin.connectionId!, repository: source.origin.repository!, ref: source.origin.ref!, path: source.origin.path!, title: source.title, signal }) : null;
      if (!refreshed) throw fail('Per aggiornare questo documento, importa una nuova versione.', 'SOURCE_NOT_REFRESHABLE', 409);
      return serial(async () => { const state = await load(), current = find(state, id, scopeId); checkVersion(current, version); Object.assign(current, refreshed, { id: source.id, version: source.version + 1, createdAt: source.createdAt }); await save(state); return detail(current); });
    },
    remove: async ({ id, scopeId, version }: { id: string; scopeId: string; version: number }) => { await scope(scopeId); return serial(async () => { const state = await load(), source = find(state, id, scopeId); checkVersion(source, version); state.records = state.records.filter(item => item.id !== id); await save(state); return { removed: id }; }); },
    retrieve: async ({ scopeId, query, limit = 8, maxChars = 12000 }: { scopeId: string; query: string; limit?: number; maxChars?: number }) => {
      await scope(scopeId); if (typeof query !== 'string' || query.length > 24000 || query.includes('\0')) throw fail('Richiesta di consultazione non valida.'); if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(maxChars) || maxChars < 100 || maxChars > 30000) throw fail('Limiti di consultazione non validi.');
      return serial(async () => { const sources = (await load()).records.filter(item => item.scopeId === scopeId && metadata(item).status === 'current'); const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{3,}/gu) || [])].slice(0, 60); const ranked = sources.flatMap(source => source.segments.map(segment => ({ source, segment, score: terms.reduce((sum, term) => sum + ((segment.text.toLowerCase().includes(term) ? 1 : 0) + (source.title.toLowerCase().includes(term) ? 2 : 0)), 0) }))).filter(item => item.score > 0).sort((a, b) => b.score - a.score || b.source.retrievedAt.localeCompare(a.source.retrievedAt));
        const selected: typeof ranked = []; let chars = 0; for (const item of ranked) { if (selected.length >= limit || chars + item.segment.text.length > maxChars) continue; selected.push(item); chars += item.segment.text.length; }
        return { sources: [...new Map(selected.map(item => [item.source.id, metadata(item.source)])).values()], passages: selected.map(({ source, segment }) => ({ sourceId: source.id, sourceVersion: source.version, title: source.title, url: source.url, page: segment.page, lineStart: segment.lineStart, lineEnd: segment.lineEnd, text: segment.text })), truncated: selected.length < ranked.length };
      });
    },
    searchWeb: async ({ scopeId, connectionId, query, domains, consent, signal }: ResearchInput & { consent: true }) => {
      await scope(scopeId); if (consent !== true) throw fail('Conferma l’invio di questa ricerca al provider selezionato.', 'SOURCE_RESEARCH_CONSENT', 403); if (!search) throw fail('Ricerca web non configurata.', 'SOURCE_RESEARCH_UNAVAILABLE', 409); identifier(connectionId); bounded(query, 4000, 'Ricerca');
      if (domains && (!Array.isArray(domains) || domains.length > 10 || domains.some(domain => typeof domain !== 'string' || !/^[a-zA-Z0-9.-]{1,253}$/.test(domain)))) throw fail('Domini ricerca non validi.');
      const result = await search({ scopeId, connectionId, query, domains, signal }); const content = bounded(result.text, maxTextChars, 'Risultato ricerca');
      const citations = [...(result.citations || []), ...(result.sources || [])].map(citation => ({ url: publicUrl(citation.url).href, title: bounded(citation.title || citation.url, 500, 'Titolo fonte') })).filter((citation, index, all) => all.findIndex(item => item.url === citation.url) === index).slice(0, 100);
      if (!citations.length) throw fail('La ricerca non ha restituito citazioni verificabili.', 'SOURCE_RESEARCH_NO_CITATIONS', 502);
      const source = make({ scopeId, kind: 'research', title: `Ricerca: ${query}`.slice(0, 200), segments: segmentsFromText(content), bytes: Buffer.byteLength(content), origin: { type: 'manual' }, citationSources: citations }); source.staleAt = new Date(now() + 86400000).toISOString();
      const saved = await store(source); return { ...saved, research: { searchCalls: result.searchCalls, usage: result.usage, provider: result.provider, durationMs: result.durationMs } };
    },
  };
}
