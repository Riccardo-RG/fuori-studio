type Scope = { id: string; name: string };
type Project = { id: string; scopeId: string; title: string };
type Step = { title: string; status: string };
type Task = { id: string; projectId: string; scopeId: string; title: string; status: string; updatedAt?: string; createdAt?: string; dependencies?: string[]; steps?: Step[]; artifacts?: { decision?: string }[] };
type Run = { id: string; projectId: string; scopeId: string; title: string; status: string; parentRunId?: string | null; updatedAt?: string; createdAt?: string; decision?: { status?: string } | null };
type Routine = { id: string; projectId: string; title: string; enabled: boolean; nextRunAt: string };
type Source = { scopeId: string; status: string };
type Workspace = { scopes: Scope[] };
type Operations = { projects: Project[]; tasks: Task[]; routines: Routine[] };
type Input = { scopeId: string; projectId?: string | null };
type Dependencies = {
  workspace: { getSnapshot(): Promise<Workspace> };
  operations: { getSnapshot(): Promise<Operations> };
  repositories: { snapshot(): Promise<{ runs: Run[] }> };
  sources: { allMetadata(): Promise<Source[]> };
  now?: () => number;
};
type Group = 'running' | 'review' | 'interrupted' | 'ready' | 'waiting';
type Item = { id: string; kind: 'task' | 'repository'; title: string; projectId: string; projectTitle: string; scopeId: string; status: string; updatedAt: string; progress: { completed: number; total: number; next: string | null } | null; dependencies: { id: string; title: string | null; available: boolean }[]; unblocks: number };
const fail = (message: string, statusCode = 400) => Object.assign(Error(message), { statusCode });
const approved = (task: Task | undefined) => task?.status === 'completed' && task.artifacts?.at(-1)?.decision === 'approved';

/** A read-only action queue, not an automatic planner or an execution readiness check. */
export function buildToday(workspace: Workspace, operations: Operations, runs: Run[], sources: Source[], input: Input, now = Date.now()) {
  if (!input || typeof input.scopeId !== 'string' || (input.scopeId !== '*' && !workspace.scopes.some(scope => scope.id === input.scopeId))) throw fail('Ambito non trovato.', 404);
  const projects = operations.projects.filter(project => input.scopeId === '*' || project.scopeId === input.scopeId);
  if (input.projectId != null && (typeof input.projectId !== 'string' || !projects.some(project => project.id === input.projectId))) throw fail('Progetto non disponibile in questo ambito.', 404);
  const selectedProjects = projects.filter(project => !input.projectId || project.id === input.projectId);
  const projectMap = new Map(selectedProjects.map(project => [project.id, project]));
  // Join to actual project ownership before following dependencies or rendering titles.
  const tasks = operations.tasks.filter(task => projectMap.get(task.projectId)?.scopeId === task.scopeId);
  const allTasks = new Map(operations.tasks.map(task => [task.id, task]));
  const unresolved = (task: Task) => (task.dependencies || []).filter(id => {
    const parent = allTasks.get(id);
    return parent?.projectId !== task.projectId || parent.scopeId !== task.scopeId || !approved(parent);
  });
  const groups: Record<Group, Item[]> = { running: [], review: [], interrupted: [], ready: [], waiting: [] };
  const pendingByTask = new Map(tasks.map(task => [task.id, unresolved(task)]));
  const unlockCounts = new Map<string, number>();
  for (const task of tasks) { const pending = pendingByTask.get(task.id)!; if (task.status === 'queued' && pending.length === 1) unlockCounts.set(pending[0], (unlockCounts.get(pending[0]) || 0) + 1); }
  for (const task of tasks) {
    if (task.status === 'completed') continue;
    const missing = pendingByTask.get(task.id)!;
    const group = task.status === 'running' ? 'running' : task.status === 'review' ? 'review' : ['paused', 'failed'].includes(task.status) ? 'interrupted' : task.status === 'queued' ? missing.length ? 'waiting' : 'ready' : null;
    if (!group) continue;
    const steps = task.steps || [];
    groups[group].push({ id: task.id, kind: 'task', title: task.title, projectId: task.projectId, projectTitle: projectMap.get(task.projectId)!.title, scopeId: task.scopeId, status: task.status, updatedAt: task.updatedAt || task.createdAt || '', progress: { completed: steps.filter(step => step.status === 'completed').length, total: steps.length, next: steps.find(step => step.status !== 'completed')?.title || null }, dependencies: missing.map(id => { const parent = allTasks.get(id), available = parent?.projectId === task.projectId && parent.scopeId === task.scopeId; return { id, title: available ? parent!.title : null, available }; }), unblocks: unlockCounts.get(task.id) || 0 });
  }
  const superseded = new Set(runs.map(run => run.parentRunId).filter(Boolean));
  for (const run of runs) {
    const project = projectMap.get(run.projectId);
    if (!project || project.scopeId !== run.scopeId || superseded.has(run.id) || run.decision?.status === 'changes_requested') continue;
    const group = run.status === 'running' ? 'running' : run.status === 'review' ? 'review' : ['paused', 'failed'].includes(run.status) ? 'interrupted' : run.status === 'queued' ? 'ready' : null;
    if (group) groups[group].push({ id: run.id, kind: 'repository', title: run.title, projectId: run.projectId, projectTitle: project.title, scopeId: run.scopeId, status: run.status, updatedAt: run.updatedAt || run.createdAt || '', progress: null, dependencies: [], unblocks: 0 });
  }
  for (const items of Object.values(groups)) items.sort((a, b) => b.unblocks - a.unblocks || a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id));
  const nextRoutines = operations.routines.filter(routine => routine.enabled && projectMap.has(routine.projectId) && Number.isFinite(Date.parse(routine.nextRunAt)) && Date.parse(routine.nextRunAt) <= now + 86_400_000).sort((a, b) => a.nextRunAt.localeCompare(b.nextRunAt)).map(routine => ({ id: routine.id, title: routine.title, projectId: routine.projectId, projectTitle: projectMap.get(routine.projectId)!.title, nextRunAt: routine.nextRunAt, overdue: Date.parse(routine.nextRunAt) <= now }));
  const sourceScopes = new Set(input.projectId ? selectedProjects.map(project => project.scopeId) : workspace.scopes.filter(scope => input.scopeId === '*' || scope.id === input.scopeId).map(scope => scope.id));
  return { scopeId: input.scopeId, projectId: input.projectId || null, generatedAt: new Date(now).toISOString(), readOnly: true, noAiCalls: true, projects, counts: Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, items.length])), groups: Object.fromEntries(Object.entries(groups).map(([key, items]) => [key, { total: items.length, items: items.slice(0, 12) }])), routines: { total: nextRoutines.length, items: nextRoutines.slice(0, 8) }, staleSources: sources.filter(source => sourceScopes.has(source.scopeId) && source.status === 'stale').length };
}

export function createTodayService({ workspace, operations, repositories, sources, now = Date.now }: Dependencies) {
  return { async snapshot(input: Input) {
    const [knowledge, work, repositoryState, documents] = await Promise.all([workspace.getSnapshot(), operations.getSnapshot(), repositories.snapshot(), sources.allMetadata()]);
    return buildToday(knowledge, work, repositoryState.runs, documents, input, now());
  } };
}
