/** Presentation-only state. It never changes permissions, tasks, or model execution. */
export function daylightMode(value) {
  return ['auto', 'day', 'night'].includes(value) ? value : 'auto';
}

export function isNight(mode, date = new Date()) {
  const selected = daylightMode(mode);
  return selected === 'night' || (selected === 'auto' && (date.getHours() < 7 || date.getHours() >= 19));
}

const identities = {
  shared: ['#b28b58', 'Profilo comune', 'shared'], profile: ['#b28b58', 'Profilo comune', 'shared'],
  personal: ['#bc87a7', 'Personale', 'personal'], business: ['#62a28b', 'Imprenditoria', 'projects'],
  development: ['#7b9dbf', 'Sviluppo', 'code'], consulting: ['#ba9967', 'Consulenza', 'context'],
  project: ['#819ece', 'Progetto', 'projects'], client: ['#b49acb', 'Cliente', 'context'],
  archive: ['#9d9d94', 'Archivio', 'memory']
};

export function scopeIdentity(scope = {}) {
  const key = identities[scope.id] ? scope.id : scope.kind;
  const [base, label, icon] = identities[key] || identities.project;
  let color = base;
  if (['project', 'client'].includes(scope.kind)) {
    let hash = 0;
    for (const char of String(scope.id || 'project')) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    color = ['#819ece', '#75ac9a', '#b59acb', '#c39876', '#93a66e', '#7eafbb'][hash % 6];
  }
  return {color, label, icon, kind: scope.kind || key || 'project', name: scope.name || label};
}

/** Load is an activity proxy, not a claim about an AI model's cognitive difficulty. */
export function repositoryActivityTasks(runs = []) {
  return runs.map(run => ({
    ...run,
    id: `repository:${run.id}`,
    events: (run.events || []).map(event => ({ ...event, createdAt: event.createdAt || event.at })),
    steps: [
      { agentId: 'forge', title: 'Preparazione e verifica del codice', status: run.status === 'running' && run.stage !== 'reviewing' ? 'running' : 'completed' },
      { agentId: 'nova', title: 'Revisione della modifica', status: run.status === 'running' && run.stage === 'reviewing' ? 'running' : run.status === 'running' ? 'pending' : 'completed' },
    ],
  }));
}

export function deriveActivity({tasks = [], chat = {}, now = Date.now()} = {}) {
  const running = tasks.filter(task => task.status === 'running');
  const active = new Set(chat.running ? chat.activeAgentIds || [] : []);
  for (const task of running) for (const step of task.steps || []) if (step.status === 'running' && step.agentId) active.add(step.agentId);
  const collaboration = running.find(task => new Set((task.steps || []).map(step => step.agentId).filter(Boolean)).size > 1);
  const participants = collaboration
    ? [...new Set(collaboration.steps.map(step => step.agentId).filter(Boolean))]
    : chat.running ? [...new Set(chat.participantIds || [])] : [];
  const collaboratingIds = participants.length > 1 ? participants : [];
  const steps = running.reduce((count, task) => count + (task.steps || []).filter(step => ['pending', 'running'].includes(step.status)).length, 0);
  const started = running.map(task => Date.parse(task.startedAt || task.events?.filter(event => event.type === 'started').at(-1)?.createdAt || task.updatedAt)).filter(Number.isFinite);
  if (chat.running && Number.isFinite(chat.startedAt)) started.push(chat.startedAt);
  const elapsed = started.length ? Math.max(0, now - Math.min(...started)) : 0;
  const busy = running.length > 0 || Boolean(chat.running);
  const load = busy ? Math.min(1, .15 + active.size * .15 + Math.min(steps, 6) * .045 + Math.min(elapsed / 300000, 1) * .18) : 0;
  const failed = tasks.filter(task => task.status === 'failed').sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];
  const failureEvent = failed?.events?.filter(event => event.type === 'error' || event.type === 'failed').at(-1);
  const problemKey = chat.problemKey || (failed ? `task:${failed.id}:${failed.version || 0}:${failureEvent?.createdAt || failed.updatedAt || ''}` : null);
  return {
    load, problemKey, activeAgentIds: [...active], collaboratingIds,
    label: problemKey ? 'Un problema da risolvere' : load >= .7 ? 'Studio in fermento' : load > 0 ? 'Il lavoro prende forma' : 'Spazio alle idee',
    meeting: collaboratingIds.length ? {
      taskId: collaboration?.id || null,
      title: collaboration?.title || 'Una risposta, più punti di vista',
      stage: collaboration?.steps.find(step => step.status === 'running')?.title || 'Collaborazione in chat',
      participants: collaboratingIds, activeAgentIds: [...active]
    } : null
  };
}
