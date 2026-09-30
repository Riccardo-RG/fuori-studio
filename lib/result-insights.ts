import { accessible } from './context.mjs';

type Project = { id: string; title: string; scopeId: string };
type Task = { id: string; projectId: string; scopeId: string; workflowId?: string | null; status?: string; artifacts?: { decision?: string }[] };
type Run = { id: string; projectId: string; scopeId: string; status?: string; patchHash?: string | null; decision?: { status?: string } | null };
type Workflow = { id: string; title: string; scopeId: string; sharedWith?: string[] };
type Usage = { projectId?: string; taskId?: string; runId?: string; scopeId: string; status: string };
type Outcome = { taskId?: string; runId?: string; helpful: boolean; minutesSaved: number | null };

export type ResultInsightsContext = { operations?: { projects?: Project[]; tasks?: Task[] }; repositoryState?: { runs?: Run[] }; workflows?: Workflow[]; scopeId?: string };
type Counts = {
  assignments: number;
  deliveries: { approved: number; revised: number; pending: number; reviewed: number; approvalRatio: number | null };
  calls: { total: number; succeeded: number; failed: number; cancelled: number; timedOut: number; interrupted: number; running: number };
  feedback: { eligible: number; responses: number; helpful: number; unhelpful: number; missing: number; minutesSaved: number | null; minutesSavedEntries: number; selfReported: true };
};
type Group = Counts & { id: string; title: string; scopeIds: string[]; available: boolean };
const counts = (): Counts => ({ assignments: 0, deliveries: { approved: 0, revised: 0, pending: 0, reviewed: 0, approvalRatio: null }, calls: { total: 0, succeeded: 0, failed: 0, cancelled: 0, timedOut: 0, interrupted: 0, running: 0 }, feedback: { eligible: 0, responses: 0, helpful: 0, unhelpful: 0, missing: 0, minutesSaved: null, minutesSavedEntries: 0, selfReported: true } });

/** Joins retained facts by durable IDs. No model calls, inferred costs or usefulness scores. */
export function aggregateResultInsights(context: ResultInsightsContext = {}, ledger: { usages?: Usage[]; outcomes?: Outcome[] } = {}) {
  const projects = new Map((context.operations?.projects ?? []).map(project => [project.id, project]));
  const workflows = new Map((context.workflows ?? []).map(workflow => [workflow.id, workflow]));
  const ownsProject = (record: Task | Run) => projects.get(record.projectId)?.scopeId === record.scopeId;
  const tasks = (context.operations?.tasks ?? []).filter(ownsProject), runs = (context.repositoryState?.runs ?? []).filter(ownsProject);
  const taskById = new Map(tasks.map(task => [task.id, task])), runById = new Map(runs.map(run => [run.id, run]));
  const projectGroups = new Map<string, Group>(), workflowGroups = new Map<string, Group>();
  const eligible = new Set<string>(), assessed = new Set<string>();
  const inScope = (scopeId: string) => !context.scopeId || scopeId === context.scopeId;
  const projectMetadata = (id: string, scopeId: string) => { const record = projects.get(id); return record?.scopeId === scopeId ? record : undefined; };
  const workflowMetadata = (id: string, scopeId: string) => { const record = workflows.get(id); return accessible(record, scopeId) ? record : undefined; };
  function group(map: Map<string, Group>, id: string, scopeId: string, record?: { title: string }) {
    let value = map.get(id);
    if (!value) { value = { id, title: record?.title ?? id, scopeIds: [], available: Boolean(record), ...counts() }; map.set(id, value); }
    else if (!value.available && record) { value.title = record.title; value.available = true; }
    if (!value.scopeIds.includes(scopeId)) value.scopeIds.push(scopeId);
    return value;
  }
  function assignmentGroups(record: Task | Run): Group[] {
    return [group(projectGroups, record.projectId, record.scopeId, projectMetadata(record.projectId, record.scopeId)), ...('workflowId' in record && record.workflowId ? [group(workflowGroups, record.workflowId, record.scopeId, workflowMetadata(record.workflowId, record.scopeId))] : [])];
  }
  function addDelivery(value: Group, decision: string | undefined) {
    if (decision === 'approved') value.deliveries.approved++;
    else if (decision === 'changes_requested') value.deliveries.revised++;
    else if (!decision || decision === 'pending') value.deliveries.pending++;
  }
  for (const task of tasks.filter(task => inScope(task.scopeId))) {
    const values = assignmentGroups(task), approved = task.status === 'completed' && task.artifacts?.at(-1)?.decision === 'approved';
    if (approved) eligible.add(`task:${task.id}`);
    for (const value of values) { value.assignments++; for (const artifact of task.artifacts ?? []) addDelivery(value, artifact.decision); if (approved) value.feedback.eligible++; }
  }
  for (const run of runs.filter(run => inScope(run.scopeId))) {
    const values = assignmentGroups(run), approved = run.status === 'completed' && run.decision?.status === 'approved';
    if (approved) eligible.add(`run:${run.id}`);
    for (const value of values) {
      value.assignments++;
      if (run.patchHash && (['review', 'completed'].includes(run.status ?? '') || run.decision)) addDelivery(value, run.decision?.status);
      if (approved) value.feedback.eligible++;
    }
  }
  let callsWithoutProject = 0, callsWithoutProcedure = 0, unattributedFeedback = 0;
  for (const usage of ledger.usages ?? []) {
    if (!inScope(usage.scopeId)) continue;
    const task = usage.taskId ? taskById.get(usage.taskId) : undefined;
    // A task reference alone must not reattribute a ledger record to another project/scope.
    const matchingTask = task && task.scopeId === usage.scopeId && task.projectId === usage.projectId ? task : undefined;
    const values = usage.projectId ? [group(projectGroups, usage.projectId, usage.scopeId, projectMetadata(usage.projectId, usage.scopeId))] : [];
    if (!usage.projectId) callsWithoutProject++;
    if (matchingTask?.workflowId) values.push(group(workflowGroups, matchingTask.workflowId, usage.scopeId, workflowMetadata(matchingTask.workflowId, usage.scopeId)));
    else callsWithoutProcedure++;
    for (const value of values) {
      value.calls.total++;
      if (usage.status === 'timed_out') value.calls.timedOut++;
      else if (['succeeded', 'failed', 'cancelled', 'interrupted', 'running'].includes(usage.status)) value.calls[usage.status as 'succeeded' | 'failed' | 'cancelled' | 'interrupted' | 'running']++;
    }
  }
  for (const outcome of ledger.outcomes ?? []) {
    const record = outcome.taskId ? taskById.get(outcome.taskId) : outcome.runId ? runById.get(outcome.runId) : undefined;
    if (!record) { if (!context.scopeId) unattributedFeedback++; continue; }
    if (!inScope(record.scopeId)) continue;
    const key = `${outcome.taskId ? 'task' : 'run'}:${record.id}`;
    // The store keeps one latest assessment per assignment. Ignore detached or stale assessments.
    if (!eligible.has(key) || assessed.has(key)) continue;
    assessed.add(key);
    for (const value of assignmentGroups(record)) {
      value.feedback.responses++;
      if (outcome.helpful) value.feedback.helpful++; else value.feedback.unhelpful++;
      if (outcome.minutesSaved !== null) { value.feedback.minutesSaved = (value.feedback.minutesSaved ?? 0) + outcome.minutesSaved; value.feedback.minutesSavedEntries++; }
    }
  }
  function finish(groups: Map<string, Group>) {
    return [...groups.values()].map(value => {
      value.deliveries.reviewed = value.deliveries.approved + value.deliveries.revised;
      value.deliveries.approvalRatio = value.deliveries.reviewed ? value.deliveries.approved / value.deliveries.reviewed : null;
      value.feedback.missing = value.feedback.eligible - value.feedback.responses;
      value.scopeIds.sort();
      return value;
    }).sort((a, b) => b.deliveries.reviewed - a.deliveries.reviewed || b.calls.total - a.calls.total || a.id.localeCompare(b.id));
  }
  return { scopeId: context.scopeId ?? null, period: 'retained_history', projects: finish(projectGroups), procedures: finish(workflowGroups), coverage: { callsWithoutProject, callsWithoutProcedure, unattributedFeedback } };
}
