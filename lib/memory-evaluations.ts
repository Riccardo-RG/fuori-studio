import { createHash, randomUUID } from 'node:crypto';
import { containsMemorySecret } from './memory-assistant.mjs';

interface Memory { id: string; version: number; scopeId: string; title: string; status: string; sharedWith: string[]; agentIds: string[]; }
interface WorkspaceSnapshot { scopes: Array<{ id: string; kind?: string }>; memories: Memory[]; }
interface Reference { id: string; version: number; authorization: string; }
interface EvaluationCase { id: string; version: number; scopeId: string; title: string; query: string; agentId: string; expected: Reference[]; forbidden: Reference[]; createdAt: string; updatedAt: string; }
interface EvaluationRun { id: string; caseId: string; caseVersion: number; scopeId: string; at: string; retrievalVersion: string; baselineHash: string; status: 'passed' | 'failed' | 'needs-review'; selected: Array<{ id: string; version: number; rank: number; truncated: boolean }>; matched: string[]; missing: string[]; forbidden: string[]; violations: string[]; stale: string[]; recall: number | null; expectedShare: number | null; elapsedMs: number; }
interface Feedback { memoryId: string; memoryVersion: number; scopeId: string; version: number; helpful: boolean; note: string; at: string; }
interface State { version: 1; cases: EvaluationCase[]; runs: EvaluationRun[]; feedback: Feedback[]; }
interface Options {
  storage: { read(key: string, fallback?: unknown): Promise<unknown>; write(key: string, value: unknown): Promise<unknown> };
  workspace: { getSnapshot(): Promise<WorkspaceSnapshot>; getContext(input: { scopeId: string; query: string; agentId: string }): Promise<{ memories: Array<Memory & { truncated?: boolean }> }> };
  now?: () => number;
}
const KEY = 'memory-evaluations', AGENTS = ['nova', 'radar', 'forge', 'muse', 'growth'];
const fail = (message: string, code = 'EVALUATION_INVALID', statusCode = 400) => Object.assign(Error(message), { code, statusCode });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const id = (value: unknown): string => { if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw fail('Identificativo non valido.'); return value; };
function text(value: unknown, max: number, empty = false): string { if (typeof value !== 'string' || value.length > max || value.includes('\0') || (!empty && !value.trim()) || containsMemorySecret(value)) throw fail('Testo non valido, troppo lungo o contenente possibili credenziali.'); return value.trim(); }
function fields(value: unknown, keys: string[]): asserts value is Record<string, unknown> { if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) throw fail('Campi di valutazione non validi.'); }
const revision = (actual: number, value: unknown) => { if (actual !== value) throw fail('La valutazione è cambiata. Ricarica prima di continuare.', 'VERSION_CONFLICT', 409); };
const eligible = (memory: Memory, scopeId: string, agentId: string) => memory.status === 'confirmed' && (memory.scopeId === scopeId || memory.scopeId === 'shared' || memory.sharedWith.includes(scopeId)) && (!memory.agentIds.length || memory.agentIds.includes(agentId));
const authorization = (memory: Memory) => hash([memory.scopeId, memory.status, [...memory.sharedWith].sort(), [...memory.agentIds].sort()]);
const baseline = (snapshot: WorkspaceSnapshot, item: EvaluationCase) => {
  const labels = new Set([...item.expected, ...item.forbidden].map(ref => ref.id));
  return hash([snapshot.scopes.find(scope => scope.id === item.scopeId), snapshot.memories.filter(memory => labels.has(memory.id) || eligible(memory, item.scopeId, item.agentId)).map(memory => [memory.id, memory.version, authorization(memory)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
};
const reference = (memory: Memory): Reference => ({ id: memory.id, version: memory.version, authorization: authorization(memory) });
function staleReferences(item: EvaluationCase, snapshot: WorkspaceSnapshot): string[] {
  return [...item.expected, ...item.forbidden].filter(ref => { const memory = snapshot.memories.find(memory => memory.id === ref.id); return !memory || memory.version !== ref.version || authorization(memory) !== ref.authorization; }).map(ref => ref.id);
}
function validate(value: unknown): State {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.cases) || value.cases.length > 100 || !Array.isArray(value.runs) || value.runs.length > 500 || !Array.isArray(value.feedback) || value.feedback.length > 2000) throw fail('Archivio valutazioni non valido.', 'EVALUATION_CORRUPT', 503);
  const caseIds = new Set<string>(), runIds = new Set<string>();
  for (const item of value.cases) {
    if (!object(item) || caseIds.has(id(item.id)) || !Number.isSafeInteger(item.version) || Number(item.version) < 1 || !AGENTS.includes(String(item.agentId)) || !Array.isArray(item.expected) || !Array.isArray(item.forbidden) || item.expected.length + item.forbidden.length < 1 || item.expected.length + item.forbidden.length > 60) throw fail('Caso di valutazione non valido.', 'EVALUATION_CORRUPT', 503);
    id(item.scopeId); text(item.title, 160); text(item.query, 4000); const refs = new Set<string>();
    for (const ref of [...item.expected, ...item.forbidden]) { if (!object(ref) || refs.has(id(ref.id)) || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1 || typeof ref.authorization !== 'string' || !/^[a-f0-9]{64}$/.test(ref.authorization)) throw fail('Riferimento di valutazione non valido.', 'EVALUATION_CORRUPT', 503); refs.add(ref.id as string); }
    caseIds.add(item.id as string);
  }
  for (const run of value.runs) {
    if (!object(run) || runIds.has(id(run.id)) || !caseIds.has(id(run.caseId)) || !['passed', 'failed', 'needs-review'].includes(String(run.status)) || !Number.isSafeInteger(run.caseVersion) || !Array.isArray(run.selected) || run.selected.length > 2000 || typeof run.baselineHash !== 'string' || !/^[a-f0-9]{64}$/.test(run.baselineHash)) throw fail('Risultato di valutazione non valido.', 'EVALUATION_CORRUPT', 503);
    id(run.scopeId);
    for (const key of ['matched', 'missing', 'forbidden', 'violations', 'stale']) { if (!Array.isArray(run[key]) || run[key].length > 2000) throw fail('Risultato di valutazione non valido.', 'EVALUATION_CORRUPT', 503); (run[key] as unknown[]).forEach(id); }
    for (const selected of run.selected) if (!object(selected) || !Number.isSafeInteger(selected.version) || !Number.isSafeInteger(selected.rank) || typeof selected.truncated !== 'boolean' || !id(selected.id)) throw fail('Selezione non valida.', 'EVALUATION_CORRUPT', 503);
    for (const key of ['recall', 'expectedShare']) if (run[key] !== null && (typeof run[key] !== 'number' || run[key] < 0 || run[key] > 1)) throw fail('Misura non valida.', 'EVALUATION_CORRUPT', 503);
    runIds.add(run.id as string);
  }
  const feedbackIds = new Set<string>();
  for (const item of value.feedback) {
    if (!object(item) || feedbackIds.has(id(item.memoryId)) || !Number.isSafeInteger(item.memoryVersion) || !Number.isSafeInteger(item.version) || typeof item.helpful !== 'boolean') throw fail('Feedback non valido.', 'EVALUATION_CORRUPT', 503);
    id(item.scopeId); text(item.note, 1000, true); feedbackIds.add(item.memoryId as string);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 8 * 1024 * 1024) throw fail('Archivio valutazioni pieno.', 'EVALUATION_CAPACITY', 409);
  return structuredClone(value) as unknown as State;
}

/** Deterministic retrieval evaluation. Labels come from the owner, never an AI judge. */
export function createMemoryEvaluations({ storage, workspace, now = Date.now }: Options) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => { const next = queue.then(fn); queue = next.catch(() => {}); return next; };
  const load = async () => validate(await storage.read(KEY, { version: 1, cases: [], runs: [], feedback: [] }));
  const save = async (state: State) => { validate(state); await storage.write(KEY, state); };
  const date = () => new Date(now()).toISOString();
  const scope = (snapshot: WorkspaceSnapshot, scopeId: unknown) => { const found = snapshot.scopes.find(scope => scope.id === id(scopeId)); if (!found || ['shared', 'archive'].includes(found.kind || '')) throw fail('Scegli un ambito di lavoro per la valutazione.', 'EVALUATION_SCOPE_DENIED', 403); return found.id; };
  const find = (state: State, caseId: unknown) => { const found = state.cases.find(item => item.id === id(caseId)); if (!found) throw fail('Caso non trovato.', 'NOT_FOUND', 404); return found; };
  async function view(state: State, scopeId: string) {
    const snapshot = await workspace.getSnapshot(); scope(snapshot, scopeId);
    const cases = state.cases.filter(item => item.scopeId === scopeId).map(item => ({ ...item, stale: staleReferences(item, snapshot) }));
    const runs = state.runs.filter(run => run.scopeId === scopeId).map(run => ({ ...run, current: cases.some(item => item.id === run.caseId && item.version === run.caseVersion && !item.stale.length && run.baselineHash === baseline(snapshot, item)) }));
    const latest = cases.map(item => runs.filter(run => run.caseId === item.id && run.current).at(-1)).filter((run): run is typeof runs[number] => Boolean(run));
    return { cases, runs, feedback: state.feedback.filter(item => snapshot.memories.some(memory => memory.id === item.memoryId && (memory.scopeId === scopeId || memory.scopeId === 'shared' || memory.sharedWith.includes(scopeId)))).map(item => ({ ...item, current: snapshot.memories.some(memory => memory.id === item.memoryId && memory.version === item.memoryVersion) })),
      candidates: snapshot.memories.map(({ id, title, scopeId, status, sharedWith, agentIds, version }) => ({ id, title, scopeId, status, sharedWith, agentIds, version })),
      summary: { cases: cases.length, stale: cases.filter(item => item.stale.length).length, measured: latest.length, passed: latest.filter(run => run.status === 'passed').length, failed: latest.filter(run => run.status === 'failed').length },
      limits: { cases: 100, runs: 500, expected: 30, forbidden: 30 }, retrievalVersion: 'lexical-v1', noAiCalls: true };
  }
  return {
    snapshot: ({ scopeId }: { scopeId: string }) => serial(async () => view(await load(), scopeId)),
    saveCase: (input: unknown) => serial(async () => {
      fields(input, ['id', 'expectedVersion', 'scopeId', 'title', 'query', 'agentId', 'expectedIds', 'forbiddenIds']);
      const state = await load(), snapshot = await workspace.getSnapshot(), scopeId = scope(snapshot, input.scopeId);
      if (!AGENTS.includes(String(input.agentId))) throw fail('Agente non valido.');
      const agentId = String(input.agentId), previous = input.id ? find(state, input.id) : null;
      if (previous) { revision(previous.version, input.expectedVersion); if (previous.scopeId !== scopeId) throw fail('Il caso deve restare nel suo ambito.'); }
      else if (state.cases.length >= 100) throw fail('Limite di 100 casi raggiunto. Rimuovi quelli inutilizzati.', 'EVALUATION_CAPACITY', 409);
      const references = (value: unknown, expected: boolean) => {
        if (!Array.isArray(value) || value.length > 30 || new Set(value).size !== value.length) throw fail('Seleziona fino a 30 memorie distinte per gruppo.');
        return value.map(value => { const memory = snapshot.memories.find(memory => memory.id === id(value)); if (!memory || expected && !eligible(memory, scopeId, agentId)) throw fail('Una memoria attesa non è confermata o autorizzata per questo agente.', 'EVALUATION_MEMORY_DENIED', 403); return reference(memory); });
      };
      const expected = references(input.expectedIds, true), forbidden = references(input.forbiddenIds || [], false);
      if (!expected.length && !forbidden.length || expected.some(ref => forbidden.some(other => other.id === ref.id))) throw fail('Scegli almeno una memoria, senza sovrapporre i gruppi.');
      const item: EvaluationCase = { id: previous?.id || randomUUID(), version: (previous?.version || 0) + 1, scopeId, title: text(input.title, 160), query: text(input.query, 4000), agentId, expected, forbidden, createdAt: previous?.createdAt || date(), updatedAt: date() };
      state.cases = state.cases.filter(other => other.id !== item.id); state.cases.push(item); await save(state); return view(state, scopeId);
    }),
    removeCase: (input: unknown) => serial(async () => {
      fields(input, ['id', 'expectedVersion']); const state = await load(), item = find(state, input.id); revision(item.version, input.expectedVersion); scope(await workspace.getSnapshot(), item.scopeId);
      state.cases = state.cases.filter(other => other.id !== item.id); state.runs = state.runs.filter(run => run.caseId !== item.id); await save(state); return view(state, item.scopeId);
    }),
    runCase: (input: unknown) => serial(async () => {
      fields(input, ['id', 'expectedVersion']); const state = await load(), item = find(state, input.id); revision(item.version, input.expectedVersion);
      if (state.runs.length >= 500) throw fail('Limite di 500 prove raggiunto. Rimuovi un caso con la sua cronologia prima di continuare.', 'EVALUATION_CAPACITY', 409);
      const snapshot = await workspace.getSnapshot(); scope(snapshot, item.scopeId); const started = now(), stale = staleReferences(item, snapshot), baselineHash = baseline(snapshot, item);
      const run: EvaluationRun = { id: randomUUID(), caseId: item.id, caseVersion: item.version, scopeId: item.scopeId, at: date(), retrievalVersion: 'lexical-v1', baselineHash, status: 'needs-review', selected: [], matched: [], missing: [], forbidden: [], violations: [], stale, recall: null, expectedShare: null, elapsedMs: 0 };
      if (!stale.length) {
        const context = await workspace.getContext({ scopeId: item.scopeId, query: item.query, agentId: item.agentId });
        if (baseline(await workspace.getSnapshot(), item) !== baselineHash) throw fail('Le memorie sono cambiate durante la prova. Rilanciala sul contesto attuale.', 'EVALUATION_CONTEXT_CHANGED', 409);
        run.selected = context.memories.map((memory, index) => ({ id: memory.id, version: memory.version, rank: index + 1, truncated: Boolean(memory.truncated) }));
        const selectedIds = new Set(run.selected.map(memory => memory.id));
        run.matched = item.expected.filter(ref => selectedIds.has(ref.id)).map(ref => ref.id);
        run.missing = item.expected.filter(ref => !selectedIds.has(ref.id)).map(ref => ref.id);
        run.forbidden = item.forbidden.filter(ref => selectedIds.has(ref.id)).map(ref => ref.id);
        run.violations = run.selected.filter(selected => { const memory = snapshot.memories.find(memory => memory.id === selected.id); return !memory || memory.version !== selected.version || !eligible(memory, item.scopeId, item.agentId); }).map(memory => memory.id);
        run.recall = item.expected.length ? run.matched.length / item.expected.length : null;
        run.expectedShare = run.selected.length ? run.matched.length / run.selected.length : null;
        run.status = run.missing.length || run.forbidden.length || run.violations.length || selectedIds.size !== run.selected.length || run.selected.length > 8 ? 'failed' : 'passed';
      }
      run.elapsedMs = Math.max(0, now() - started); state.runs.push(run); await save(state); return view(state, item.scopeId);
    }),
    feedback: (input: unknown) => serial(async () => {
      fields(input, ['memoryId', 'memoryVersion', 'expectedVersion', 'helpful', 'note']); const state = await load(), snapshot = await workspace.getSnapshot();
      const memory = snapshot.memories.find(memory => memory.id === id(input.memoryId));
      if (!memory || memory.status !== 'confirmed') throw fail('La memoria non è più disponibile.', 'NOT_FOUND', 404);
      revision(memory.version, input.memoryVersion); if (typeof input.helpful !== 'boolean') throw fail('Indica se la memoria è utile.');
      const previous = state.feedback.find(item => item.memoryId === memory.id); if (previous) revision(previous.version, input.expectedVersion);
      state.feedback = state.feedback.filter(item => item.memoryId !== memory.id);
      state.feedback.push({ memoryId: memory.id, memoryVersion: memory.version, scopeId: memory.scopeId, version: (previous?.version || 0) + 1, helpful: input.helpful, note: text(input.note || '', 1000, true), at: date() });
      await save(state); return { saved: true };
    }),
  };
}
