import { createHash } from 'node:crypto';

export type PatchFile = { path: string; status: 'A' | 'M' | 'D'; additions: number; deletions: number };
export type BaseFile = { content: Buffer; sha: string; mode: '100644' | '100755' };
export type AppliedFile = { path: string; mode: '100644' | '100755'; content: string | null; oldSha: string | null; newSha: string | null };
export type PatchOptions = { patch: string; files: PatchFile[]; readBase: (path: string) => Promise<BaseFile | null> };
const MAX_PATCH = 4 * 1024 * 1024, MAX_FILE = 1024 * 1024, MAX_TOTAL = 8 * 1024 * 1024;
const ZERO = '0'.repeat(40), MODES = new Set(['100644', '100755']);
const fail = (message = 'Patch Git non valida o non supportata.') => Object.assign(Error(message), { code: 'GITHUB_PATCH_INVALID', statusCode: 409 });
const digest = (value: Buffer) => createHash('sha1').update(`blob ${value.length}\0`).update(value).digest('hex');
function utf8(value: Buffer): string {
  if (value.length > MAX_FILE || value.includes(0)) throw fail('File binario o oltre il limite di 1 MiB.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(value); } catch { throw fail('Sono supportati soltanto file UTF-8.'); }
}
function safePath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || /^[\\/]|^[A-Za-z]:|[\x00-\x1f\x7f\\]/.test(value) || Buffer.from(value).toString('utf8') !== value || value.split('/').some(part => !part || ['.', '..', '.git', '.codex', '.agents', '.ssh', '.aws', '.local', 'node_modules'].includes(part.toLowerCase())) || /(?:^|\/)(?:\.env(?:\.(?!example$|sample$|template$)[^/]+)?|\.npmrc|\.netrc|credentials(?:\.json)?|auth\.json|id_rsa|id_ed25519|[^/]+\.(?:p12|pfx|pem|key))$/i.test(value)) throw fail('Percorso della patch non consentito.');
  return value;
}
// Git's core.quotePath encoding quotes UTF-8 bytes with three-digit octal escapes.
function quoted(value: string): string {
  return '"' + [...Buffer.from(value)].map(byte => byte === 34 ? '\\"' : byte === 92 ? '\\\\' : byte < 32 || byte >= 127 ? '\\' + byte.toString(8).padStart(3, '0') : String.fromCharCode(byte)).join('') + '"';
}
const pathForms = (prefix: string, path: string) => [prefix + path, quoted(prefix + path)];
const linesOf = (value: string): string[] => value.match(/[^\n]*\n|[^\n]+$/g) || [];
const number = (value: string): number => { const n = Number(value); if (!Number.isSafeInteger(n) || n < 0 || n > MAX_FILE + 1) throw fail(); return n; };

/** Apply only the reviewed full-index patch to immutable GitHub base blobs.
 * Nothing is executed and no fuzzy/context-offset matching is allowed. */
export async function applyRepositoryPatch({ patch, files, readBase }: PatchOptions): Promise<AppliedFile[]> {
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > MAX_PATCH || patch.includes('\0') || Buffer.from(patch).toString('utf8') !== patch || !Array.isArray(files) || files.length > 200 || typeof readBase !== 'function') throw fail('Patch o elenco file oltre i limiti consentiti.');
  if (!files.length) { if (patch !== '') throw fail(); return []; }
  if (!patch.endsWith('\n')) throw fail('Patch incompleta: manca la terminazione finale.');
  const headers = new Map<string, PatchFile>(), paths = new Set<string>();
  for (const file of files) {
    if (!file || typeof file !== 'object') throw fail('Metadati del file non validi.');
    safePath(file.path);
    if (!['A', 'M', 'D'].includes(file.status) || !Number.isSafeInteger(file.additions) || file.additions < 0 || !Number.isSafeInteger(file.deletions) || file.deletions < 0 || file.additions > MAX_FILE || file.deletions > MAX_FILE) throw fail('Metadati del file non validi.');
    const folded = file.path.normalize('NFC').toLowerCase();
    if (paths.has(folded) || [...paths].some(path => folded.startsWith(path + '/') || path.startsWith(folded + '/'))) throw fail('Percorsi duplicati o in conflitto nella patch.');
    paths.add(folded);
    for (const a of pathForms('a/', file.path)) for (const b of pathForms('b/', file.path)) headers.set(`diff --git ${a} ${b}`, file);
  }
  const lines = patch.slice(0, -1).split('\n'), blocks: { file: PatchFile; lines: string[] }[] = [], seen = new Set<string>();
  let current: typeof blocks[number] | undefined;
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      const file = headers.get(line);
      if (!file || seen.has(file.path)) throw fail('Le intestazioni non corrispondono ai file revisionati.');
      seen.add(file.path); current = { file, lines: [] }; blocks.push(current);
    } else { if (!current) throw fail(); current.lines.push(line); }
  }
  if (seen.size !== files.length) throw fail('La patch non contiene tutti i file revisionati.');
  const results: AppliedFile[] = []; let total = 0;
  for (const { file, lines: body } of blocks) {
    let cursor = 0, oldMode: string | undefined, newMode: string | undefined, indexMode: string | undefined;
    let oldSha: string | undefined, newSha: string | undefined, removedPath = false, addedPath = false, kind: PatchFile['status'] = 'M';
    const fields = new Set<string>();
    const once = (key: string) => { if (fields.has(key)) throw fail('Intestazione patch duplicata.'); fields.add(key); };
    while (cursor < body.length && !body[cursor].startsWith('@@ ')) {
      const line = body[cursor++]; let match: RegExpExecArray | null;
      if ((match = /^(new file mode|deleted file mode|old mode|new mode) (\d{6})$/.exec(line))) {
        once(match[1]); if (!MODES.has(match[2])) throw fail('Link simbolici, sottomoduli e modi speciali non sono supportati.');
        if (match[1] === 'new file mode') { kind = 'A'; newMode = match[2]; }
        if (match[1] === 'deleted file mode') { kind = 'D'; oldMode = match[2]; }
        if (match[1] === 'old mode') oldMode = match[2];
        if (match[1] === 'new mode') newMode = match[2];
      } else if ((match = /^index ([a-f0-9]{40})\.\.([a-f0-9]{40})(?: (\d{6}))?$/.exec(line))) {
        once('index'); oldSha = match[1]; newSha = match[2]; indexMode = match[3];
        if (indexMode && !MODES.has(indexMode)) throw fail();
      } else if (line.startsWith('--- ') || line.startsWith('+++ ')) {
        const old = line.startsWith('--- '); once(old ? '---' : '+++');
        const value = line.slice(4).replace(/\t$/, '');
        if (value !== '/dev/null' && !pathForms(old ? 'a/' : 'b/', file.path).includes(value)) throw fail('Percorso hunk diverso dal file revisionato.');
        if (old) removedPath = value === '/dev/null'; else addedPath = value === '/dev/null';
      } else throw fail('Formato Git non supportato: usa una patch testuale senza rinominazioni.');
    }
    if (kind !== file.status || fields.has('new file mode') && fields.has('deleted file mode')) throw fail('Tipo modifica incoerente.');
    if (kind !== 'M' && (fields.has('old mode') || fields.has('new mode') || indexMode)) throw fail();
    if (kind === 'M' && fields.has('old mode') !== fields.has('new mode')) throw fail();
    if (fields.has('---') !== fields.has('+++')) throw fail();
    const hasHunks = cursor < body.length;
    if (hasHunks !== fields.has('---') || hasHunks && (!oldSha || !newSha || removedPath !== (kind === 'A') || addedPath !== (kind === 'D'))) throw fail('Intestazioni dei blocchi non coerenti.');
    if (!fields.has('index') && !(kind === 'M' && oldMode && newMode && oldMode !== newMode && !hasHunks)) throw fail('Sono richieste le impronte Git complete.');
    if (fields.has('index') && (kind === 'A' ? oldSha !== ZERO || newSha === ZERO : kind === 'D' ? newSha !== ZERO || oldSha === ZERO : oldSha === ZERO || newSha === ZERO)) throw fail('Impronte di aggiunta o rimozione non coerenti.');
    if (kind === 'M' && indexMode && (oldMode || newMode)) throw fail();
    if (kind === 'M' && fields.has('index') && !indexMode && !oldMode) throw fail('Modo Git mancante.');
    const base = await readBase(file.path);
    if (base !== null && (!base || typeof base !== 'object')) throw fail('Blob base non valido.');
    if (kind === 'A' ? base !== null : base === null) throw fail('Il file di base non corrisponde all’aggiunta o alla modifica revisionata.');
    let source = '', actualOld: string | null = null;
    if (base) {
      if (!Buffer.isBuffer(base.content) || !MODES.has(base.mode) || !/^[a-f0-9]{40}$/.test(base.sha)) throw fail('Blob base non valido.');
      source = utf8(base.content); actualOld = digest(base.content);
      if (actualOld !== base.sha || oldSha && oldSha !== actualOld || (oldMode || indexMode) && base.mode !== (oldMode || indexMode)) throw fail('Il contenuto o il modo del file base è cambiato.');
    }
    const effectiveMode = newMode || indexMode || base?.mode;
    if (!effectiveMode || !MODES.has(effectiveMode)) throw fail('Modo destinazione non valido.');
    const before = linesOf(source), after: string[] = []; let oldCursor = 0, additions = 0, deletions = 0;
    while (cursor < body.length) {
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(body[cursor++]);
      if (!match) throw fail('Blocco della patch non valido.');
      const oldStart = number(match[1]), oldCount = match[2] === undefined ? 1 : number(match[2]);
      const newStart = number(match[3]), newCount = match[4] === undefined ? 1 : number(match[4]);
      if ((!oldCount && !newCount) || oldCount && !oldStart || newCount && !newStart) throw fail();
      const oldIndex = oldCount ? oldStart - 1 : oldStart, newIndex = newCount ? newStart - 1 : newStart;
      if (oldIndex < oldCursor || oldIndex > before.length) throw fail('Posizione del blocco non valida.');
      after.push(...before.slice(oldCursor, oldIndex)); oldCursor = oldIndex;
      if (newIndex !== after.length) throw fail('Posizione destinazione del blocco non valida.');
      let oldRead = 0, newRead = 0;
      while (oldRead < oldCount || newRead < newCount) {
        const line = body[cursor++];
        if (typeof line !== 'string' || ![' ', '+', '-'].includes(line[0])) throw fail('Blocco incompleto.');
        let content = line.slice(1) + '\n';
        if (body[cursor] === '\\ No newline at end of file') { cursor++; content = content.slice(0, -1); }
        if (line[0] !== '+') { oldRead++; if (oldRead > oldCount || oldCursor >= before.length || before[oldCursor++] !== content) throw fail('Il contesto della patch non corrisponde esattamente al file base.'); }
        if (line[0] !== '-') { newRead++; if (newRead > newCount) throw fail(); after.push(content); }
        if (line[0] === '+') additions++; if (line[0] === '-') deletions++;
      }
    }
    after.push(...before.slice(oldCursor));
    if (after.slice(0, -1).some(line => !line.endsWith('\n'))) throw fail('Terminazione di riga incoerente.');
    const content = after.join(''), output = Buffer.from(content);
    if (output.length > MAX_FILE || (total += output.length) > MAX_TOTAL || additions !== file.additions || deletions !== file.deletions) throw fail('Contenuto o conteggi diversi dai dati revisionati.');
    if (kind === 'D' && content !== '') throw fail('La rimozione non elimina tutto il file.');
    const actualNew = kind === 'D' ? null : digest(output);
    if (newSha && newSha !== (actualNew || ZERO)) throw fail('L’impronta del risultato non corrisponde alla patch.');
    // Empty A/D files can legitimately have index metadata and no hunks.
    if (!hasHunks && kind === 'M' && (!oldMode || !newMode || oldMode === newMode)) throw fail('Patch priva di modifica verificabile.');
    results.push({ path: file.path, mode: effectiveMode as AppliedFile['mode'], content: kind === 'D' ? null : content, oldSha: actualOld, newSha: actualNew });
  }
  return results;
}
