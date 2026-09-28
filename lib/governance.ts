import { randomUUID } from 'node:crypto';
import { defaultArchive } from './archive.mjs';

export type GovernanceSettings = { version: number; dailyCallLimit: number; maxCallSeconds: number; autonomousRoutines: boolean; maxAutonomousRunsPerDay: number; autonomousEnabledAt: string | null };
export type BudgetTarget = { scopeId: string; projectId?: string; taskId?: string; runId?: string; budgetRunId?: string };
export type CallMeta = BudgetTarget & { agentId: string; kind: string; connectionId: string };
type BudgetSetting = BudgetTarget & { callLimit: number; version: number; updatedAt: string };
export type CallStatus = 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
export type UsageRecord = CallMeta & { id: string; day: string; status: CallStatus; startedAt: string; finishedAt: string | null; durationMs: number | null; inputTokens: number | null; outputTokens: number | null; errorCode: string | null };
export type Outcome = { id: string; taskId?: string; runId?: string; helpful: boolean; minutesSaved: number | null; note: string; version: number; createdAt: string; updatedAt: string };
type RoutineClaim = { id: string; routineId: string; scopeId: string; occurrenceId: string; day: string; createdAt: string };
type State = { version: 1; settings: GovernanceSettings; usages: UsageRecord[]; routineClaims: RoutineClaim[]; outcomes: Outcome[]; budgets: BudgetSetting[] };
type Storage = { read: (key: string, fallback?: unknown) => Promise<unknown>; update: (key: string, fn: (value: unknown) => unknown, fallback?: unknown) => Promise<unknown> };
type ErrorWithCode = Error & { code?: unknown };
type UsageLike = { inputTokens?: unknown; outputTokens?: unknown };
type ExecutionLike = { usage?: UsageLike | null };
type EventLike = { type?: string; createdAt?: string; at?: string };
type ArtifactLike = { decision?: string };
type TaskLike = { id: string; workflowId?: string | null; status?: string; artifacts?: ArtifactLike[]; events?: EventLike[]; steps?: { execution?: ExecutionLike }[] };
type RepositoryRunLike = { id: string; status?: string; patchHash?: string | null; decision?: { status?: string } | null; events?: EventLike[]; editor?: ExecutionLike | null; review?: (ExecutionLike & { status?: string }) | null };

const KEY = 'governance', MAX_CONCURRENT = 3;
const DEFAULT_PROJECT_CALL_LIMIT = 200, DEFAULT_ASSIGNMENT_CALL_LIMIT = 12;
const TARGET_KEYS = ['scopeId', 'projectId', 'taskId', 'runId', 'budgetRunId'];
const fail = (message: string, code = 'GOVERNANCE_INVALID', statusCode = 400) => Object.assign(new Error(message), { code, statusCode, status: statusCode });
const copy = <T>(value: T): T => structuredClone(value);
const seed = (): State => ({ version: 1, settings: { version: 1, dailyCallLimit: 50, maxCallSeconds: 180, autonomousRoutines: false, maxAutonomousRunsPerDay: 3, autonomousEnabledAt: null }, usages: [], routineClaims: [], outcomes: [], budgets: [] });
function object(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) throw fail('Configurazione dei limiti non valida.');
}
function identifier(value: unknown, label = 'Identificativo'): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw fail(`${label} non valido.`);
  return value;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw fail(`${label}: scegli un intero tra ${min} e ${max}.`);
  return value;
}
function target(value: BudgetTarget): BudgetTarget {
  identifier(value.scopeId);
  for (const key of ['projectId', 'taskId', 'runId', 'budgetRunId'] as const) if (value[key] !== undefined) identifier(value[key]);
  if ((value.taskId && value.runId) || ((value.taskId || value.runId) && !value.projectId) || (value.budgetRunId && !value.runId)) throw fail('Il budget deve appartenere a un progetto e a un solo incarico.');
  return { scopeId: value.scopeId, ...(value.projectId ? { projectId: value.projectId } : {}), ...(value.taskId ? { taskId: value.taskId } : {}), ...(value.runId ? { runId: value.budgetRunId || value.runId } : {}) };
}
// Projects have globally unique durable IDs. A legitimate scope move must not
// create a fresh budget; scope stays attribution, not the counter's identity.
const budgetKey = (value: BudgetTarget): string => { const item = target(value); return JSON.stringify([item.projectId ?? null, item.taskId ? 'task' : item.runId ? 'run' : 'project', item.taskId ?? item.runId ?? null]); };
function budgetReport(state: State, value: BudgetTarget) {
  const item = target(value), assignment = Boolean(item.taskId || item.runId), setting = state.budgets.find(entry => budgetKey(entry) === budgetKey(item));
  const records = state.usages.filter(record => record.projectId === item.projectId && (!assignment || budgetKey(record) === budgetKey(item)));
  const callLimit = setting?.callLimit ?? (assignment ? DEFAULT_ASSIGNMENT_CALL_LIMIT : DEFAULT_PROJECT_CALL_LIMIT);
  return { ...item, period: 'lifetime', callLimit, version: setting?.version ?? 0, configured: Boolean(setting), used: records.length, remaining: Math.max(0, callLimit - records.length), usage: usageTotals(records) };
}
function settings(value: unknown): GovernanceSettings {
  object(value, ['version', 'dailyCallLimit', 'maxCallSeconds', 'autonomousRoutines', 'maxAutonomousRunsPerDay', 'autonomousEnabledAt']);
  if (typeof value.autonomousRoutines !== 'boolean') throw fail('Indica esplicitamente se abilitare le routine autonome.');
  const enabledAt = value.autonomousEnabledAt ?? null;
  if (enabledAt !== null && (typeof enabledAt !== 'string' || enabledAt.length > 32 || !/^\d{4}-\d\d-\d\dT/.test(enabledAt) || !Number.isFinite(Date.parse(enabledAt)))) throw fail('Data di abilitazione delle routine non valida.');
  return { version: integer(value.version, 1, Number.MAX_SAFE_INTEGER, 'Versione'), dailyCallLimit: integer(value.dailyCallLimit, 0, 1000, 'Chiamate giornaliere'), maxCallSeconds: integer(value.maxCallSeconds, 1, 1800, 'Durata massima'), autonomousRoutines: value.autonomousRoutines, maxAutonomousRunsPerDay: integer(value.maxAutonomousRunsPerDay, 0, 100, 'Routine autonome giornaliere'), autonomousEnabledAt: enabledAt };
}
function checked(value: unknown): State {
  object(value, ['version', 'settings', 'usages', 'routineClaims', 'outcomes', 'budgets']);
  // Additive migration: older global reservations retain their original attribution.
  if (value.budgets === undefined) value.budgets = [];
  if (value.version !== 1 || !Array.isArray(value.usages) || value.usages.length > 50000 || !Array.isArray(value.routineClaims) || value.routineClaims.length > 50000 || !Array.isArray(value.outcomes) || value.outcomes.length > 10000) throw fail('Archivio dei limiti non valido o pieno.', 'GOVERNANCE_CORRUPT', 503);
  value.settings = settings(value.settings);
  if (!Array.isArray(value.budgets) || value.budgets.length > 10000) throw fail('Archivio dei budget non valido o pieno.', 'GOVERNANCE_CORRUPT', 503);
  const budgetIds = new Set<string>();
  for (const entry of value.budgets as BudgetSetting[]) {
    object(entry, [...TARGET_KEYS, 'callLimit', 'version', 'updatedAt']);
    const key = budgetKey(entry);
    if (!entry.projectId || budgetIds.has(key) || !Number.isFinite(Date.parse(entry.updatedAt))) throw fail('Budget duplicato o non valido.', 'GOVERNANCE_CORRUPT', 503);
    integer(entry.callLimit, 0, 50000, 'Limite di chiamate'); integer(entry.version, 1, Number.MAX_SAFE_INTEGER, 'Versione budget'); budgetIds.add(key);
  }
  const usageIds = new Set<string>();
  for (const record of value.usages as UsageRecord[]) {
    object(record, ['id', ...TARGET_KEYS, 'agentId', 'kind', 'connectionId', 'day', 'status', 'startedAt', 'finishedAt', 'durationMs', 'inputTokens', 'outputTokens', 'errorCode']);
    target(record);
    identifier(record.id); identifier(record.scopeId); identifier(record.agentId); identifier(record.kind); identifier(record.connectionId);
    if (usageIds.has(record.id) || !['running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted'].includes(record.status) || !/^\d{4}-\d\d-\d\d$/.test(record.day) || !Number.isFinite(Date.parse(record.startedAt)) || (record.finishedAt !== null && !Number.isFinite(Date.parse(record.finishedAt)))) throw fail('Registro delle chiamate non valido.', 'GOVERNANCE_CORRUPT', 503);
    for (const field of ['durationMs', 'inputTokens', 'outputTokens'] as const) if (record[field] !== null && (!Number.isSafeInteger(record[field]) || record[field]! < 0)) throw fail('Metriche di utilizzo non valide.', 'GOVERNANCE_CORRUPT', 503);
    if (record.errorCode !== null && (typeof record.errorCode !== 'string' || !/^[A-Z_]{1,80}$/.test(record.errorCode))) throw fail('Codice errore non valido.', 'GOVERNANCE_CORRUPT', 503);
    usageIds.add(record.id);
  }
  for (const claim of value.routineClaims as RoutineClaim[]) {
    object(claim, ['id', 'routineId', 'scopeId', 'occurrenceId', 'day', 'createdAt']);
    identifier(claim.id); identifier(claim.routineId); identifier(claim.scopeId);
    if (typeof claim.occurrenceId !== 'string' || claim.occurrenceId.length > 210 || !/^\d{4}-\d\d-\d\d$/.test(claim.day) || !Number.isFinite(Date.parse(claim.createdAt))) throw fail('Registro routine non valido.', 'GOVERNANCE_CORRUPT', 503);
  }
  for (const outcome of value.outcomes as Outcome[]) {
    object(outcome, ['id', 'taskId', 'runId', 'helpful', 'minutesSaved', 'note', 'version', 'createdAt', 'updatedAt']);
    identifier(outcome.id); identifier(outcome.taskId ?? outcome.runId);
    if (Boolean(outcome.taskId) === Boolean(outcome.runId) || typeof outcome.helpful !== 'boolean' || typeof outcome.note !== 'string' || outcome.note.length > 2000 || (outcome.minutesSaved !== null && (typeof outcome.minutesSaved !== 'number' || !Number.isFinite(outcome.minutesSaved) || outcome.minutesSaved < 0 || outcome.minutesSaved > 10080))) throw fail('Feedback non valido.', 'GOVERNANCE_CORRUPT', 503);
    integer(outcome.version, 1, Number.MAX_SAFE_INTEGER, 'Versione feedback');
    if (!Number.isFinite(Date.parse(outcome.createdAt)) || !Number.isFinite(Date.parse(outcome.updatedAt))) throw fail('Data feedback non valida.');
  }
  return value as unknown as State;
}
const tokenCount = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
function tokens(records: (UsageLike | null | undefined)[]) {
  const input = records.map(record => tokenCount(record?.inputTokens)), output = records.map(record => tokenCount(record?.outputTokens));
  return { inputTokens: input.some(value => value !== null) ? input.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null, outputTokens: output.some(value => value !== null) ? output.reduce<number>((sum, value) => sum + (value ?? 0), 0) : null, unknownInputCount: input.filter(value => value === null).length, unknownOutputCount: output.filter(value => value === null).length, complete: records.length > 0 && input.every(value => value !== null) && output.every(value => value !== null) };
}
function usageTotals(records: UsageRecord[]) {
  return { calls: records.length, succeeded: records.filter(record => record.status === 'succeeded').length, failed: records.filter(record => record.status === 'failed').length, cancelled: records.filter(record => record.status === 'cancelled').length, timedOut: records.filter(record => record.status === 'timed_out').length, interrupted: records.filter(record => record.status === 'interrupted').length, running: records.filter(record => record.status === 'running').length, ...tokens(records) };
}
function feedbackTotals(outcomes: Outcome[]) {
  const timed = outcomes.filter(outcome => outcome.minutesSaved !== null);
  return { responses: outcomes.length, helpful: outcomes.filter(outcome => outcome.helpful).length, unhelpful: outcomes.filter(outcome => !outcome.helpful).length, minutesSaved: timed.length ? timed.reduce((sum, outcome) => sum + (outcome.minutesSaved ?? 0), 0) : null, minutesSavedEntries: timed.length, selfReported: true };
}
function safeErrorCode(cause: unknown): string {
  const known = new Set(['PROVIDER_AUTH', 'PROVIDER_RATE_LIMIT', 'PROVIDER_REQUEST', 'PROVIDER_HTTP', 'PROVIDER_OUTPUT_LIMIT', 'REPOSITORY_TIMEOUT', 'REPOSITORY_OUTPUT_LIMIT', 'SANDBOX_UNAVAILABLE', 'REPOSITORY_SANDBOX_UNAVAILABLE']);
  const code = (cause as ErrorWithCode | null)?.code;
  return typeof code === 'string' && known.has(code) ? code : 'CALL_FAILED';
}

export function createGovernance({ storage = defaultArchive as Storage, clock = () => Date.now() }: { storage?: Storage; clock?: () => number } = {}) {
  const active = new Set<string>();
  let initializing: Promise<void> | null = null;
  const current = () => { const value = clock(); if (!Number.isFinite(value)) throw fail('Orologio non valido.'); return value; };
  const stamp = () => new Date(current()).toISOString();
  const day = () => stamp().slice(0, 10);
  async function initialize(): Promise<void> {
    if (!initializing) initializing = storage.update(KEY, raw => {
      const state = checked(raw), finishedAt = stamp();
      for (const record of state.usages.filter(item => item.status === 'running')) { record.status = 'interrupted'; record.finishedAt = finishedAt; record.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(record.startedAt)); record.errorCode = 'PROCESS_INTERRUPTED'; }
      return state;
    }, seed()).then(() => {});
    return initializing;
  }
  function view(state: State) {
    const currentDay = day(), dailyCalls = state.usages.filter(record => record.day === currentDay).length, routineRuns = state.routineClaims.filter(record => record.day === currentDay).length;
    return { settings: copy(state.settings), period: { day: currentDay, resetAt: new Date(Date.parse(`${currentDay}T00:00:00.000Z`) + 86400000).toISOString() }, daily: { calls: dailyCalls, remaining: Math.max(0, state.settings.dailyCallLimit - dailyCalls), autonomousRuns: routineRuns, autonomousRemaining: Math.max(0, state.settings.maxAutonomousRunsPerDay - routineRuns) }, limits: { maxConcurrentCalls: MAX_CONCURRENT }, usages: copy(state.usages.slice(-200).reverse()), usageTotals: usageTotals(state.usages), dailyUsage: usageTotals(state.usages.filter(record => record.day === currentDay)), outcomes: copy(state.outcomes.slice(-200).reverse()), feedback: feedbackTotals(state.outcomes) };
  }
  const snapshot = async () => { await initialize(); return view(checked(await storage.read(KEY, seed()))); };
  function preflightView(state: State, payload: BudgetTarget & { requiredCalls: number }) {
    const item = target(payload), requiredCalls = integer(payload.requiredCalls, 0, 1000, 'Chiamate previste'), daily = view(state).daily;
    const project = item.projectId ? budgetReport(state, { scopeId: item.scopeId, projectId: item.projectId }) : null;
    const assignment = item.taskId || item.runId ? budgetReport(state, item) : null;
    const remaining = Math.min(daily.remaining, project?.remaining ?? Infinity, assignment?.remaining ?? Infinity);
    const blocking = [...(daily.remaining < requiredCalls ? ['DAILY_CALL_LIMIT'] : []), ...(project && project.remaining < requiredCalls ? ['PROJECT_CALL_LIMIT'] : []), ...(assignment && assignment.remaining < requiredCalls ? ['ASSIGNMENT_CALL_LIMIT'] : [])];
    return { target: item, requiredCalls, allowed: !blocking.length, blocking, remaining, daily: { ...daily, callLimit: state.settings.dailyCallLimit, period: 'UTC_day', resetAt: view(state).period.resetAt }, project, assignment, advisory: true };
  }
  async function budgets(filter: Partial<BudgetTarget> = {}) {
    object(filter, TARGET_KEYS);
    for (const key of TARGET_KEYS as (keyof BudgetTarget)[]) if (filter[key] !== undefined) identifier(filter[key]);
    if (filter.taskId || filter.runId || filter.budgetRunId) target(filter as BudgetTarget);
    await initialize(); const state = checked(await storage.read(KEY, seed()));
    const candidates = new Map<string, BudgetTarget>();
    for (const record of [...state.usages, ...state.budgets]) {
      if (!record.projectId) continue;
      const item = target(record), project = { scopeId: item.scopeId, projectId: item.projectId };
      candidates.set(budgetKey(project), project); candidates.set(budgetKey(item), item);
    }
    if (filter.scopeId && filter.projectId) { const item = target(filter as BudgetTarget); candidates.set(budgetKey(item), item); const project = { scopeId: item.scopeId, projectId: item.projectId }; candidates.set(budgetKey(project), project); }
    const entries = [...candidates.values()].filter(item => (!filter.scopeId || item.scopeId === filter.scopeId) && (!filter.projectId || item.projectId === filter.projectId) && (!filter.taskId || !item.taskId && !item.runId || item.taskId === filter.taskId) && (!filter.runId || !item.taskId && !item.runId || item.runId === (filter.budgetRunId || filter.runId))).map(item => budgetReport(state, item));
    return { defaults: { projectCallLimit: DEFAULT_PROJECT_CALL_LIMIT, assignmentCallLimit: DEFAULT_ASSIGNMENT_CALL_LIMIT, period: 'lifetime' }, daily: { ...view(state).daily, callLimit: state.settings.dailyCallLimit }, period: view(state).period, entries, unattributedCalls: state.usages.filter(record => !record.projectId && (!filter.scopeId || record.scopeId === filter.scopeId)).length };
  }
  async function finalize(id: string, status: CallStatus, result: unknown, errorCode: string | null): Promise<void> {
    await storage.update(KEY, raw => {
      const state = checked(raw), record = state.usages.find(item => item.id === id);
      if (!record || record.status !== 'running') return state;
      const usage = result && typeof result === 'object' ? (result as ExecutionLike).usage : null;
      record.status = status; record.finishedAt = stamp(); record.durationMs = Math.max(0, Date.parse(record.finishedAt) - Date.parse(record.startedAt)); record.inputTokens = tokenCount(usage?.inputTokens); record.outputTokens = tokenCount(usage?.outputTokens); record.errorCode = errorCode;
      return checked(state);
    }, seed());
  }
  return {
    snapshot, budgets,
    async preflight(payload: BudgetTarget & { requiredCalls: number }) {
      object(payload, [...TARGET_KEYS, 'requiredCalls']); target(payload); integer(payload.requiredCalls, 0, 1000, 'Chiamate previste');
      await initialize(); return preflightView(checked(await storage.read(KEY, seed())), payload);
    },
    async configureBudget(payload: BudgetTarget & { expectedVersion: number; callLimit: number }) {
      object(payload, [...TARGET_KEYS, 'expectedVersion', 'callLimit']);
      const item = target(payload); if (!item.projectId) throw fail('Seleziona un progetto per configurare il budget.');
      integer(payload.callLimit, 0, 50000, 'Limite di chiamate'); integer(payload.expectedVersion, 0, Number.MAX_SAFE_INTEGER, 'Versione budget'); await initialize();
      await storage.update(KEY, raw => {
        const state = checked(raw), existing = state.budgets.find(entry => budgetKey(entry) === budgetKey(item));
        if (payload.expectedVersion !== (existing?.version ?? 0)) throw fail('Il budget è cambiato. Ricarica prima di salvarlo.', 'VERSION_CONFLICT', 409);
        if (!existing && state.budgets.length >= 10000) throw fail('Registro budget pieno.', 'GOVERNANCE_FULL', 413);
        const next = { ...item, callLimit: payload.callLimit, version: (existing?.version ?? 0) + 1, updatedAt: stamp() };
        if (existing) state.budgets.splice(state.budgets.indexOf(existing), 1, next); else state.budgets.push(next);
        return state;
      }, seed());
      return budgets();
    },
    async configure(payload: { expectedVersion: number; dailyCallLimit: number; maxCallSeconds: number; autonomousRoutines: boolean; maxAutonomousRunsPerDay: number }) {
      object(payload, ['expectedVersion', 'dailyCallLimit', 'maxCallSeconds', 'autonomousRoutines', 'maxAutonomousRunsPerDay']); await initialize();
      const state = await storage.update(KEY, raw => {
        const state = checked(raw);
        if (payload.expectedVersion !== state.settings.version) throw fail('I limiti sono cambiati. Ricarica prima di salvarli.', 'VERSION_CONFLICT', 409);
        state.settings = settings({ version: state.settings.version + 1, dailyCallLimit: payload.dailyCallLimit, maxCallSeconds: payload.maxCallSeconds, autonomousRoutines: payload.autonomousRoutines, maxAutonomousRunsPerDay: payload.maxAutonomousRunsPerDay, autonomousEnabledAt: payload.autonomousRoutines ? state.settings.autonomousRoutines && state.settings.autonomousEnabledAt ? state.settings.autonomousEnabledAt : stamp() : null });
        return state;
      }, seed());
      return view(checked(state));
    },
    async execute<T>(meta: CallMeta, fn: (signal: AbortSignal) => Promise<T>, parentSignal?: AbortSignal): Promise<T> {
      object(meta, [...TARGET_KEYS, 'agentId', 'kind', 'connectionId']); target(meta);
      identifier(meta.scopeId); identifier(meta.agentId); identifier(meta.kind); identifier(meta.connectionId);
      if (typeof fn !== 'function') throw fail('Esecutore non valido.');
      if (parentSignal?.aborted) throw fail('Chiamata annullata prima dell’avvio.', 'CALL_CANCELLED', 499);
      await initialize();
      const reservationId = randomUUID();
      const reserved = checked(await storage.update(KEY, raw => {
        const state = checked(raw);
        if (parentSignal?.aborted) throw fail('Chiamata annullata prima dell’avvio.', 'CALL_CANCELLED', 499);
        if (state.usages.length >= 50000) throw fail('Registro chiamate pieno. Nessuna chiamata avviata.', 'GOVERNANCE_FULL', 413);
        if (state.usages.filter(record => record.day === day()).length >= state.settings.dailyCallLimit) throw fail('Limite giornaliero di chiamate raggiunto. Nessun servizio AI è stato contattato.', 'DAILY_CALL_LIMIT', 429);
        const allowance = preflightView(state, { ...target(meta), requiredCalls: 1 });
        if (allowance.project && allowance.project.remaining < 1) throw fail('Budget di chiamate del progetto esaurito. Aumenta il limite prima di continuare.', 'PROJECT_CALL_LIMIT', 429);
        if (allowance.assignment && allowance.assignment.remaining < 1) throw fail('Budget di chiamate dell’incarico esaurito. Le revisioni condividono lo stesso limite.', 'ASSIGNMENT_CALL_LIMIT', 429);
        if (Math.max(active.size, state.usages.filter(record => record.status === 'running').length) >= MAX_CONCURRENT) throw fail('Sono già attive tre chiamate AI. Attendi il completamento.', 'CALL_CONCURRENCY_LIMIT', 429);
        state.usages.push({ ...copy(meta), id: reservationId, day: day(), status: 'running', startedAt: stamp(), finishedAt: null, durationMs: null, inputTokens: null, outputTokens: null, errorCode: null });
        return state;
      }, seed()));
      active.add(reservationId);
      const controller = new AbortController();
      let abortReason: ErrorWithCode | null = null, rejectAbort: (reason: unknown) => void = () => {};
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const abort = (timeout: boolean) => {
        if (abortReason) return;
        abortReason = fail(timeout ? 'La chiamata ha superato il limite di tempo configurato.' : 'La chiamata è stata annullata.', timeout ? 'CALL_TIMEOUT' : 'CALL_CANCELLED', timeout ? 408 : 499);
        controller.abort(abortReason); rejectAbort(abortReason);
      };
      const parentAbort = () => abort(false);
      parentSignal?.addEventListener('abort', parentAbort, { once: true });
      const timer = setTimeout(() => abort(true), reserved.settings.maxCallSeconds * 1000);
      const pending = Promise.resolve().then(() => { if (parentSignal?.aborted) abort(false); if (controller.signal.aborted) throw abortReason; return fn(controller.signal); });
      pending.then(() => active.delete(reservationId), () => active.delete(reservationId));
      try {
        const result = await Promise.race([pending, aborted]);
        clearTimeout(timer); parentSignal?.removeEventListener('abort', parentAbort);
        await finalize(reservationId, 'succeeded', result, null);
        return result;
      } catch (cause) {
        const reason = abortReason as ErrorWithCode | null;
        const status = reason?.code === 'CALL_TIMEOUT' ? 'timed_out' : reason ? 'cancelled' : 'failed';
        await finalize(reservationId, status, null, reason?.code === 'CALL_TIMEOUT' ? 'CALL_TIMEOUT' : reason ? 'CALL_CANCELLED' : safeErrorCode(cause));
        throw abortReason ?? cause;
      } finally { clearTimeout(timer); parentSignal?.removeEventListener('abort', parentAbort); }
    },
    async claimRoutine(payload: { routineId: string; scopeId: string; occurrenceId?: string }) {
      object(payload, ['routineId', 'scopeId', 'occurrenceId']); identifier(payload.routineId); identifier(payload.scopeId);
      if (payload.occurrenceId !== undefined) identifier(payload.occurrenceId);
      await initialize();
      let claimed = false, result: RoutineClaim | undefined;
      await storage.update(KEY, raw => {
        const state = checked(raw), occurrenceId = payload.occurrenceId ?? `${payload.routineId}:${day()}`;
        if (!state.settings.autonomousRoutines) throw fail('Le routine autonome sono disattivate.', 'AUTONOMY_DISABLED', 409);
        const previous = state.routineClaims.find(item => item.routineId === payload.routineId && item.scopeId === payload.scopeId && item.occurrenceId === occurrenceId);
        if (previous) { result = previous; return state; }
        if (state.routineClaims.length >= 50000) throw fail('Registro routine pieno.', 'GOVERNANCE_FULL', 413);
        if (state.routineClaims.filter(item => item.day === day()).length >= state.settings.maxAutonomousRunsPerDay) throw fail('Limite giornaliero di routine autonome raggiunto.', 'AUTONOMOUS_RUN_LIMIT', 429);
        result = { id: randomUUID(), routineId: payload.routineId, scopeId: payload.scopeId, occurrenceId, day: day(), createdAt: stamp() }; state.routineClaims.push(result); claimed = true;
        return state;
      }, seed());
      return { ...copy(result!), claimed };
    },
    async saveOutcome(payload: { taskId?: string; runId?: string; helpful: boolean; minutesSaved?: number; note?: string; expectedVersion?: number }) {
      object(payload, ['taskId', 'runId', 'helpful', 'minutesSaved', 'note', 'expectedVersion']);
      if (Boolean(payload.taskId) === Boolean(payload.runId) || typeof payload.helpful !== 'boolean') throw fail('Scegli un incarico o una patch e indica se il risultato è stato utile.');
      identifier(payload.taskId ?? payload.runId);
      if (payload.minutesSaved !== undefined && (typeof payload.minutesSaved !== 'number' || !Number.isFinite(payload.minutesSaved) || payload.minutesSaved < 0 || payload.minutesSaved > 10080)) throw fail('Tempo risparmiato: indica da 0 a 10.080 minuti.');
      if (payload.note !== undefined && (typeof payload.note !== 'string' || payload.note.length > 2000 || payload.note.includes('\0'))) throw fail('Nota del feedback non valida.');
      await initialize();
      const state = await storage.update(KEY, raw => {
        const state = checked(raw), existing = state.outcomes.find(item => payload.taskId ? item.taskId === payload.taskId : item.runId === payload.runId);
        if (payload.expectedVersion !== undefined && payload.expectedVersion !== (existing?.version ?? 0)) throw fail('Il feedback è cambiato. Ricarica prima di salvarlo.', 'VERSION_CONFLICT', 409);
        if (!existing && state.outcomes.length >= 10000) throw fail('Registro feedback pieno.', 'GOVERNANCE_FULL', 413);
        const updatedAt = stamp();
        const outcome: Outcome = { id: existing?.id ?? randomUUID(), ...(payload.taskId ? { taskId: payload.taskId } : { runId: payload.runId }), helpful: payload.helpful, minutesSaved: payload.minutesSaved ?? null, note: payload.note?.trim() ?? '', version: (existing?.version ?? 0) + 1, createdAt: existing?.createdAt ?? updatedAt, updatedAt };
        if (existing) state.outcomes[state.outcomes.indexOf(existing)] = outcome; else state.outcomes.push(outcome);
        return checked(state);
      }, seed());
      return view(checked(state));
    },
    async recoverInterrupted() {
      await initialize();
      const state = await storage.update(KEY, raw => {
        const state = checked(raw), finishedAt = stamp();
        for (const record of state.usages.filter(item => item.status === 'running' && !active.has(item.id))) { record.status = 'interrupted'; record.finishedAt = finishedAt; record.durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(record.startedAt)); record.errorCode = 'PROCESS_INTERRUPTED'; }
        return state;
      }, seed());
      return view(checked(state));
    },
  };
}

export function aggregateOperations(operations: { tasks?: TaskLike[] } = {}, repositoryState: { runs?: RepositoryRunLike[] } = {}) {
  const tasks = operations.tasks ?? [], runs = repositoryState.runs ?? [];
  const decisions = tasks.flatMap(task => task.artifacts ?? []).map(artifact => artifact.decision ?? 'pending');
  decisions.push(...runs.filter(run => run.patchHash && (['review', 'completed'].includes(run.status ?? '') || run.decision)).map(run => run.decision?.status ?? 'pending'));
  const countDecisions = (values: string[]) => {
    const accepted = values.filter(value => value === 'approved').length, revised = values.filter(value => value === 'changes_requested').length, reviewed = accepted + revised;
    return { total: values.length, accepted, revised, pending: values.filter(value => value === 'pending').length, reviewed, acceptanceRatio: reviewed ? accepted / reviewed : null };
  };
  const items: { kind: 'task' | 'repository'; id: string; durationMs: number }[] = [];
  for (const [kind, records, deliveryType] of [['task', tasks, 'submitted'], ['repository', runs, 'review']] as const) {
    for (const record of records) {
      let start: number | null = null;
      for (const event of record.events ?? []) {
        const at = Date.parse(event.createdAt ?? event.at ?? ''); if (!Number.isFinite(at)) continue;
        if (event.type === 'started' && start === null) start = at;
        else if (event.type === deliveryType && start !== null) { if (at >= start) items.push({ kind, id: record.id, durationMs: at - start }); start = null; }
        else if (['failed', 'interrupted', 'restarted'].includes(event.type ?? '')) start = null;
      }
    }
  }
  const workflows = [...new Set(tasks.map(task => task.workflowId).filter((value): value is string => Boolean(value)))];
  const executions: (ExecutionLike | null | undefined)[] = [...tasks.flatMap(task => (task.steps ?? []).filter(step => step.execution).map(step => step.execution)), ...runs.flatMap(run => [run.editor, ...(run.review?.status === 'completed' ? [run.review] : [])]).filter(Boolean)];
  return { deliveries: countDecisions(decisions), cycles: { count: items.length, averageMs: items.length ? items.reduce((total, item) => total + item.durationMs, 0) / items.length : null, items }, procedures: workflows.map(workflowId => ({ workflowId, ...countDecisions(tasks.filter(task => task.workflowId === workflowId).flatMap(task => task.artifacts ?? []).map(artifact => artifact.decision ?? 'pending')) })), failures: { current: [...tasks, ...runs].filter(record => record.status === 'failed').length, events: [...tasks, ...runs].flatMap(record => record.events ?? []).filter(event => event.type === 'failed').length }, tokens: tokens(executions.map(execution => execution?.usage)) };
}
