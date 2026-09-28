import { defaultArchive } from './archive.mjs';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const AGENTS = ['nova', 'radar', 'forge', 'muse', 'growth'];
const TASK_STATES = ['queued', 'running', 'paused', 'review', 'completed', 'failed'];
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_EVENTS = 100;
const clone = value => JSON.parse(JSON.stringify(value));
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const seed = () => ({ version: 1, projects: [], tasks: [], routines: [] });
function error(message, code = 'VALIDATION_ERROR', status = 400) {
  return Object.assign(new Error(message), { code, status, statusCode: status });
}
function object(value, label = 'Payload', allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![null, Object.prototype].includes(Object.getPrototypeOf(value))) throw error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (['__proto__', 'constructor', 'prototype'].includes(key) || (allowed && !allowed.includes(key))) throw error(`${label} contains an unsupported field: ${key}.`);
  return value;
}
function text(value, label, limit, optional = false) {
  if (typeof value !== 'string' || value.length > limit || (!optional && !value.trim()) || value.includes('\u0000')) throw error(`${label} must contain ${optional ? '0' : '1'}–${limit} characters.`);
  return value.trim();
}
function id(value, label = 'Identifier') {
  const clean = text(value, label, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(clean) || ['__proto__', 'constructor', 'prototype'].includes(clean)) throw error(`${label} is invalid.`);
  return clean;
}
function member(value, allowed, label) {
  if (!allowed.includes(value)) throw error(`${label} is invalid.`);
  return value;
}
function list(value, label, limit) {
  if (!Array.isArray(value) || value.length > limit) throw error(`${label} must be an array with at most ${limit} entries.`);
  return value;
}
function date(value, label = 'Date') {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) throw error(`${label} is invalid.`);
  return new Date(value).toISOString();
}
function bool(value, label) {
  if (typeof value !== 'boolean') throw error(`${label} must be a boolean.`);
  return value;
}
function jsonData(value, label, limit = 96_000) {
  const seen = new Set();
  const visit = (entry, depth) => {
    if (depth > 20) throw error(`${label} is nested too deeply.`);
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return;
    if (typeof entry === 'number' && Number.isFinite(entry)) return;
    if (typeof entry !== 'object' || seen.has(entry)) throw error(`${label} must be JSON data.`);
    seen.add(entry);
    if (Array.isArray(entry)) { if (entry.length > 3000) throw error(`${label} is too large.`); }
    else object(entry, label);
    for (const item of Object.values(entry)) visit(item, depth + 1);
    seen.delete(entry);
  };
  visit(value, 0);
  const serialized = JSON.stringify(value);
  if (!serialized || Buffer.byteLength(serialized) > limit) throw error(`${label} is too large.`);
  return JSON.parse(serialized);
}
function metadata(record) {
  id(record.id);
  if (!Number.isSafeInteger(record.version) || record.version < 1) throw error('Record version is invalid.');
  date(record.createdAt);
  date(record.updatedAt);
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) throw error('Record timestamps are invalid.');
}
function find(snapshot, collection, identifier) {
  id(identifier);
  const record = snapshot[collection].find(item => item.id === identifier);
  if (!record) throw error(`${collection === 'projects' ? 'Project' : collection === 'tasks' ? 'Task' : 'Routine'} not found.`, 'NOT_FOUND', 404);
  return record;
}
function expected(record, payload, required = true) {
  if (!own(payload, 'expectedVersion') && !required) return;
  if (!Number.isSafeInteger(payload.expectedVersion) || payload.expectedVersion < 1) throw error('Provide the current expectedVersion.', 'VERSION_CONFLICT', 409);
  if (payload.expectedVersion !== record.version) throw error('This record changed. Reload before saving.', 'VERSION_CONFLICT', 409);
}
function allowedState(task, statuses) {
  if (!statuses.includes(task.status)) throw error(`This action is unavailable while the task is ${task.status}.`, 'INVALID_STATE', 409);
}
function activeExecution(task, payload) {
  allowedState(task, ['running']);
  if (payload.executionId !== task.executionId) throw error('This execution has expired or was interrupted.', 'STALE_EXECUTION', 409);
  expected(task, payload, false);
}
function touch(record) {
  record.version += 1;
  record.updatedAt = new Date(Math.max(Date.now(), Date.parse(record.updatedAt))).toISOString();
}
function event(task, type, message) {
  task.events.push({ type, message: message.slice(0, 2000), createdAt: new Date().toISOString() });
  task.events = task.events.slice(-MAX_EVENTS);
}
function clearStep(step) {
  step.status = 'pending';
  for (const field of ['output', 'context', 'execution', 'error']) delete step[field];
}
function resetIncomplete(task) {
  for (const step of task.steps) if (step.status !== 'completed') clearStep(step);
}
function interval(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw error('intervalHours must be a finite number.');
  return Math.min(720, Math.max(1, value));
}
function newSteps(value, agentId, title, brief) {
  const incoming = value ?? [{ title, agentId, instruction: brief }];
  list(incoming, 'Steps', 16);
  if (!incoming.length) throw error('A task needs at least one step.');
  return incoming.map(step => {
    object(step, 'Step', ['title', 'agentId', 'instruction']);
    return { id: randomUUID(), title: text(step.title, 'Step title', 160), agentId: member(step.agentId ?? agentId, AGENTS, 'Agent'), instruction: text(step.instruction, 'Step instruction', 16000), status: 'pending' };
  });
}
function newTask(snapshot, payload, routineId = null) {
  const project = find(snapshot, 'projects', payload.projectId);
  if (own(payload, 'scopeId') && payload.scopeId !== project.scopeId) throw error('The task scope must match its project.');
  const title = text(payload.title, 'Task title', 160);
  const brief = text(payload.brief ?? title, 'Task brief', 16000);
  const agentId = member(payload.agentId ?? 'nova', AGENTS, 'Agent');
  const now = new Date().toISOString();
  const dependencies = payload.dependencies ?? [];
  list(dependencies, 'Dependencies', 16);
  if (new Set(dependencies).size !== dependencies.length) throw error('Duplicate dependency.');
  for (const dependency of dependencies) if (find(snapshot, 'tasks', dependency).projectId !== project.id) throw error('Dependencies must belong to the same project.');
  const task = {
    id: randomUUID(), projectId: project.id, scopeId: project.scopeId, title, brief, agentId,
    workflowId: payload.workflowId == null ? null : id(payload.workflowId, 'Workflow'),
    status: 'queued', executionId: null, routineId,
    steps: newSteps(payload.steps, agentId, title, brief), artifacts: [], events: [], version: 1, createdAt: now, updatedAt: now,
    ...(dependencies.length ? { dependencies } : {}),
    ...(payload.planId ? { planId: id(payload.planId), planTitle: text(payload.planTitle, 'Plan title', 160) } : {}),
    ...(payload.inputContext ? { inputContext: jsonData(payload.inputContext, 'Input context') } : {}),
  };
  event(task, 'created', routineId ? 'Created by an enabled local routine.' : 'Task created and queued.');
  snapshot.tasks.push(task);
  return task;
}
function validateSnapshot(snapshot) {
  object(snapshot, 'Operations archive', ['version', 'projects', 'tasks', 'routines']);
  if (snapshot.version !== 1) throw error('Unsupported operations archive version.');
  list(snapshot.projects, 'Projects', 300);
  list(snapshot.tasks, 'Tasks', 2000);
  list(snapshot.routines, 'Routines', 300);
  for (const collection of ['projects', 'tasks', 'routines']) {
    const ids = new Set();
    for (const record of snapshot[collection]) {
      object(record, 'Record'); metadata(record);
      if (ids.has(record.id)) throw error('Duplicate record identifier.');
      ids.add(record.id);
    }
  }
  for (const project of snapshot.projects) {
    text(project.title, 'Project title', 160); text(project.description, 'Description', 8000, true);
    id(project.scopeId, 'Scope'); member(project.kind, ['owned', 'client'], 'Project kind');
  }
  for (const routine of snapshot.routines) {
    find(snapshot, 'projects', routine.projectId); text(routine.title, 'Routine title', 160);
    text(routine.brief, 'Routine brief', 12000); member(routine.agentId, AGENTS, 'Agent');
    if (routine.workflowId !== null) id(routine.workflowId, 'Workflow');
    if (interval(routine.intervalHours) !== routine.intervalHours) throw error('Routine interval is invalid.');
    date(routine.nextRunAt); bool(routine.enabled, 'Enabled');
  }
  for (const task of snapshot.tasks) {
    const project = find(snapshot, 'projects', task.projectId);
    if (task.scopeId !== project.scopeId) throw error('Task scope and project do not match.');
    if (task.dependencies) {
      list(task.dependencies, 'Dependencies', 16);
      if (new Set(task.dependencies).size !== task.dependencies.length) throw error('Duplicate dependency.');
      for (const dependency of task.dependencies) {
        const parent = find(snapshot, 'tasks', dependency);
        if (parent.projectId !== task.projectId || snapshot.tasks.indexOf(parent) >= snapshot.tasks.indexOf(task)) throw error('Dependencies must reference an earlier task in the same project.');
      }
    }
    if (task.planId) { id(task.planId); text(task.planTitle, 'Plan title', 160); }
    if (task.inputContext) jsonData(task.inputContext, 'Input context');
    text(task.title, 'Task title', 160); text(task.brief, 'Task brief', 16000); member(task.agentId, AGENTS, 'Agent');
    if (task.workflowId !== null) id(task.workflowId, 'Workflow');
    if (task.routineId !== null) find(snapshot, 'routines', task.routineId);
    member(task.status, TASK_STATES, 'Task status');
    if (task.status === 'running') id(task.executionId, 'Execution');
    else if (task.executionId !== null) throw error('An inactive task cannot retain an execution token.');
    list(task.steps, 'Steps', 16); list(task.artifacts, 'Artifacts', 100); list(task.events, 'Events', MAX_EVENTS);
    if (!task.steps.length) throw error('A task must contain steps.');
    const stepIds = new Set(); let running = 0; let precedingComplete = true;
    for (const step of task.steps) {
      object(step, 'Step'); id(step.id); text(step.title, 'Step title', 160);
      if (stepIds.has(step.id)) throw error('Duplicate step identifier.');
      stepIds.add(step.id);
      member(step.agentId, AGENTS, 'Agent'); text(step.instruction, 'Step instruction', 16000);
      member(step.status, ['pending', 'running', 'completed', 'failed'], 'Step status');
      if (step.status === 'completed' && !precedingComplete) throw error('Completed steps must precede unfinished steps.');
      if (step.status === 'failed' && task.status !== 'failed') throw error('Failed steps require a failed task.');
      if (step.status === 'running') { running += 1; if (!precedingComplete) throw error('Step dependencies are incomplete.'); }
      if (step.status !== 'completed') precedingComplete = false;
      if (step.status === 'completed') text(step.output, 'Step output', 120000);
      else if (own(step, 'output')) text(step.output, 'Step output', 120000, true);
      for (const field of ['context', 'execution']) if (own(step, field)) jsonData(step[field], field);
      if (own(step, 'error')) text(step.error, 'Step error', 4000);
    }
    if (running > 1 || (task.status !== 'running' && running)) throw error('Running step state is inconsistent.');
    if (['review', 'completed'].includes(task.status) && !task.steps.every(step => step.status === 'completed')) throw error('A delivered task must have completed steps.');
    const artifactIds = new Set();
    task.artifacts.forEach((artifact, index) => {
      object(artifact, 'Artifact'); id(artifact.id);
      if (artifactIds.has(artifact.id) || artifact.version !== index + 1) throw error('Artifact history is inconsistent.');
      artifactIds.add(artifact.id);
      text(artifact.title, 'Artifact title', 160); text(artifact.content, 'Artifact content', 240000); date(artifact.createdAt);
      member(artifact.decision, ['pending', 'approved', 'changes_requested'], 'Review decision');
      if (artifact.decision === 'pending' && (task.status !== 'review' || index !== task.artifacts.length - 1)) throw error('Only the current review artifact can be pending.');
      if (artifact.decision === 'approved' && (task.status !== 'completed' || index !== task.artifacts.length - 1)) throw error('An approved artifact must complete its task.');
      if (own(artifact, 'feedback')) text(artifact.feedback, 'Review feedback', 6000, artifact.decision !== 'changes_requested');
      if (artifact.decision === 'changes_requested' && !artifact.feedback?.trim()) throw error('Requested changes need feedback.');
      for (const field of ['context', 'execution']) if (own(artifact, field)) jsonData(artifact[field], field, 384000);
    });
    if (task.status === 'review' && task.artifacts.at(-1)?.decision !== 'pending') throw error('Review requires a pending artifact.');
    if (task.status === 'completed' && task.artifacts.at(-1)?.decision !== 'approved') throw error('Completion requires an approved artifact.');
    for (const item of task.events) { object(item, 'Event'); text(item.type, 'Event type', 60); text(item.message, 'Event message', 2000); date(item.createdAt); }
  }
  return snapshot;
}

// This store coordinates one server process. The application owns the data-directory lock.
export function createOperationsStore({ directory, storage } = {}) {
  if (typeof directory !== 'string' || !directory.trim()) throw error('An operations directory is required.');
  const folder = resolve(directory), file = resolve(folder, 'operations.json');
  let queue = Promise.resolve();
  const serial = fn => { const result = queue.then(fn); queue = result.catch(() => {}); return result; };
  async function persist(snapshot) {
    validateSnapshot(snapshot);
    const serialized = JSON.stringify(snapshot, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw error('The operations archive is full.', 'OPERATIONS_FULL', 413);
    if (storage) { await storage.write('operations', snapshot); return; }
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = resolve(folder, `.operations-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(serialized, 'utf8'); await handle.sync(); await handle.close(); handle = null;
      await rename(temporary, file);
    } finally {
      await handle?.close().catch(() => {});
      await unlink(temporary).catch(failure => { if (failure.code !== 'ENOENT') throw failure; });
    }
  }
  async function load() {
    if (storage) return storage.load('operations', file, seed, validateSnapshot);
    let serialized;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_BYTES) throw error('Invalid archive size.');
      serialized = await readFile(file, 'utf8');
    } catch (failure) {
      if (failure.code === 'ENOENT') { const snapshot = seed(); await persist(snapshot); return snapshot; }
      if (failure.code !== 'VALIDATION_ERROR') throw failure;
      throw error('The operations archive is invalid and has been preserved.', 'OPERATIONS_CORRUPT', 503);
    }
    try {
      if (Buffer.byteLength(serialized) > MAX_BYTES) throw error('Invalid archive size.');
      return validateSnapshot(JSON.parse(serialized));
    } catch { throw error('The operations archive is damaged or incompatible. Restore a valid copy; the original file has been preserved.', 'OPERATIONS_CORRUPT', 503); }
  }
  return {
    getSnapshot: () => serial(async () => clone(await load())),
    recoverInterrupted: () => serial(async () => {
      const snapshot = await load(); let changed = false;
      for (const task of snapshot.tasks) if (task.status === 'running') {
        resetIncomplete(task); task.status = 'paused'; task.executionId = null;
        event(task, 'interrupted', 'Execution was interrupted by a server restart. Completed steps were retained; resume explicitly.'); touch(task); changed = true;
      }
      if (changed) await persist(snapshot);
      return clone(snapshot);
    }),
    mutate: (action, payload = {}) => serial(async () => {
      object(payload);
      const snapshot = await load();
      if (action === 'createProject') {
        object(payload, 'Project', ['title', 'description', 'scopeId', 'kind']);
        const now = new Date().toISOString();
        snapshot.projects.push({ id: randomUUID(), title: text(payload.title, 'Project title', 160), description: text(payload.description ?? '', 'Description', 8000, true), scopeId: id(payload.scopeId, 'Scope'), kind: member(payload.kind ?? 'owned', ['owned', 'client'], 'Project kind'), version: 1, createdAt: now, updatedAt: now });
      } else if (action === 'saveProject') {
        object(payload, 'Project', ['id', 'expectedVersion', 'title', 'description', 'scopeId', 'kind']);
        const project = find(snapshot, 'projects', payload.id); expected(project, payload);
        if (own(payload, 'scopeId') && payload.scopeId !== project.scopeId && (snapshot.tasks.some(task => task.projectId === project.id) || snapshot.routines.some(routine => routine.projectId === project.id))) throw error('A project with tasks or routines cannot change scope.', 'INVALID_STATE', 409);
        for (const field of ['title', 'description', 'scopeId', 'kind']) if (own(payload, field)) project[field] = payload[field];
        touch(project);
      } else if (action === 'createTask') {
        object(payload, 'Task', ['projectId', 'scopeId', 'title', 'brief', 'agentId', 'workflowId', 'steps', 'dependencies']);
        newTask(snapshot, payload);
      } else if (action === 'createTaskGraph') {
        object(payload, 'Plan', ['projectId', 'title', 'nodes', 'context']);
        find(snapshot, 'projects', payload.projectId);
        const planTitle = text(payload.title, 'Plan title', 160), planId = randomUUID();
        list(payload.nodes, 'Plan nodes', 8);
        if (!payload.nodes.length) throw error('A plan needs at least one task.');
        const mapped = new Map();
        for (const node of payload.nodes) {
          object(node, 'Plan node', ['key', 'title', 'brief', 'agentId', 'dependsOn']);
          const key = id(node.key);
          if (mapped.has(key)) throw error('Duplicate plan node.');
          list(node.dependsOn ?? [], 'Plan dependencies', 8);
          if ((node.dependsOn || []).some(parent => !mapped.has(parent))) throw error('Order plan dependencies before the tasks that use them; cycles are not allowed.');
          const task = newTask(snapshot, { projectId: payload.projectId, title: node.title, brief: node.brief, agentId: node.agentId, dependencies: (node.dependsOn || []).map(parent => mapped.get(parent)), planId, planTitle, inputContext: payload.context });
          mapped.set(key, task.id);
        }
      } else if (['createRoutine', 'updateRoutine'].includes(action)) {
        object(payload, 'Routine', ['id', 'expectedVersion', 'projectId', 'title', 'brief', 'agentId', 'workflowId', 'intervalHours', 'nextRunAt', 'enabled']);
        const existing = action === 'updateRoutine' ? find(snapshot, 'routines', payload.id) : null;
        if (existing) expected(existing, payload);
        else if (own(payload, 'id') || own(payload, 'expectedVersion')) throw error('New routines cannot specify an identifier or version.');
        const now = new Date().toISOString();
        const candidate = existing ? clone(existing) : { id: randomUUID(), agentId: 'nova', workflowId: null, intervalHours: 24, enabled: false, version: 1, createdAt: now, updatedAt: now };
        for (const field of ['projectId', 'title', 'brief', 'agentId', 'workflowId', 'intervalHours', 'nextRunAt', 'enabled']) if (own(payload, field)) candidate[field] = payload[field];
        find(snapshot, 'projects', candidate.projectId);
        candidate.title = text(candidate.title, 'Routine title', 160);
        candidate.brief = text(candidate.brief ?? candidate.title, 'Routine brief', 12000);
        candidate.intervalHours = interval(candidate.intervalHours);
        candidate.nextRunAt = date(candidate.nextRunAt ?? new Date(Date.now() + candidate.intervalHours * 3600000).toISOString(), 'Next run');
        if (existing) { touch(candidate); snapshot.routines[snapshot.routines.indexOf(existing)] = candidate; } else snapshot.routines.push(candidate);
      } else if (action === 'claimDueRoutine') {
        object(payload, 'Routine claim', ['id', 'now', 'steps', 'expectedVersion']);
        const routine = find(snapshot, 'routines', payload.id);
        const now = payload.now == null ? Date.now() : Date.parse(date(payload.now));
        const due = Date.parse(routine.nextRunAt);
        if (!routine.enabled || now < due) return clone(snapshot);
        expected(routine, payload, false);
        // Recurrence only advances while the local server is running; missed slots coalesce.
        newTask(snapshot, { ...routine, ...(own(payload, 'steps') ? { steps: payload.steps } : {}) }, routine.id);
        const period = routine.intervalHours * 3600000;
        routine.nextRunAt = new Date(due + (Math.floor((now - due) / period) + 1) * period).toISOString();
        touch(routine);
      } else {
        const fields = {
          startTask: ['id', 'expectedVersion'], restartTask: ['id', 'expectedVersion'],
          startStep: ['id', 'stepId', 'executionId', 'expectedVersion'],
          completeStep: ['id', 'stepId', 'executionId', 'expectedVersion', 'output', 'context', 'execution'],
          failTask: ['id', 'executionId', 'expectedVersion', 'error'],
          pauseTask: ['id', 'expectedVersion', 'message'],
          submitArtifact: ['id', 'executionId', 'expectedVersion', 'title', 'content', 'context', 'execution'],
          approveTask: ['id', 'expectedVersion', 'feedback'], requestChanges: ['id', 'expectedVersion', 'feedback'],
        };
        if (!own(fields, action)) throw error('Unknown operations action.');
        object(payload, 'Task action', fields[action]);
        const task = find(snapshot, 'tasks', payload.id);
        if (['restartTask', 'pauseTask', 'approveTask', 'requestChanges'].includes(action)) expected(task, payload);
        else if (action === 'startTask') expected(task, payload, false);
        else activeExecution(task, payload);
        if (action === 'startTask') {
          for (const dependency of task.dependencies || []) {
            const parent = find(snapshot, 'tasks', dependency);
            if (parent.status !== 'completed' || parent.artifacts.at(-1)?.decision !== 'approved') throw error('Approva prima le consegne da cui dipende questo incarico.', 'DEPENDENCY_PENDING', 409);
          }
          allowedState(task, ['queued', 'failed', 'paused']); resetIncomplete(task);
          task.status = 'running'; task.executionId = randomUUID(); event(task, 'started', 'Task execution started.');
        } else if (action === 'restartTask') {
          allowedState(task, ['queued', 'failed', 'paused']); task.steps.forEach(clearStep);
          task.status = 'queued'; task.executionId = null; event(task, 'restarted', 'All steps were reset; earlier artifacts and review history were preserved.');
        } else if (action === 'startStep' || action === 'completeStep') {
          const step = task.steps.find(item => item.id === id(payload.stepId, 'Step'));
          if (!step) throw error('Step not found.', 'NOT_FOUND', 404);
          if (action === 'startStep') {
            if (step.status !== 'pending' || task.steps.some(item => item.status === 'running') || !task.steps.slice(0, task.steps.indexOf(step)).every(item => item.status === 'completed')) throw error('Complete earlier steps before starting this step.', 'INVALID_STATE', 409);
            step.status = 'running'; event(task, 'step_started', step.title);
          } else {
            if (step.status !== 'running') throw error('Only a running step can complete.', 'INVALID_STATE', 409);
            step.output = text(payload.output, 'Step output', 120000);
            for (const field of ['context', 'execution']) if (own(payload, field)) step[field] = jsonData(payload[field], field);
            step.status = 'completed'; event(task, 'step_completed', step.title);
          }
        } else if (action === 'failTask') {
          const message = text(payload.error, 'Execution error', 4000);
          for (const step of task.steps) if (step.status === 'running') { step.status = 'failed'; step.error = message; }
          task.status = 'failed'; task.executionId = null; event(task, 'failed', message);
        } else if (action === 'pauseTask') {
          allowedState(task, ['queued', 'running']); resetIncomplete(task); task.status = 'paused'; task.executionId = null;
          event(task, 'paused', own(payload, 'message') ? text(payload.message, 'Pause message', 2000) : 'Task paused by the user. Completed steps were retained.');
        } else if (action === 'submitArtifact') {
          if (!task.steps.every(step => step.status === 'completed')) throw error('Complete every step before submitting an artifact.', 'INVALID_STATE', 409);
          const artifact = { id: randomUUID(), version: task.artifacts.length + 1, title: text(payload.title ?? task.title, 'Artifact title', 160), content: text(payload.content, 'Artifact content', 240000), createdAt: new Date().toISOString(), decision: 'pending' };
          for (const field of ['context', 'execution']) artifact[field] = jsonData(own(payload, field) ? payload[field] : { steps: task.steps.filter(step => own(step, field)).map(step => ({ stepId: step.id, agentId: step.agentId, [field]: step[field] })) }, field, 384000);
          task.artifacts.push(artifact); task.status = 'review'; task.executionId = null; event(task, 'submitted', 'Artifact submitted for human review.');
        } else if (action === 'approveTask') {
          allowedState(task, ['review']); const artifact = task.artifacts.at(-1); artifact.decision = 'approved';
          if (own(payload, 'feedback')) artifact.feedback = text(payload.feedback, 'Review feedback', 6000, true);
          task.status = 'completed'; event(task, 'approved', 'The user approved the artifact.');
        } else if (action === 'requestChanges') {
          allowedState(task, ['review']); const artifact = task.artifacts.at(-1);
          artifact.feedback = text(payload.feedback, 'Review feedback', 6000); artifact.decision = 'changes_requested';
          task.steps.forEach(clearStep); task.status = 'queued'; task.executionId = null;
          event(task, 'changes_requested', artifact.feedback);
        }
        touch(task);
      }
      await persist(snapshot);
      return clone(snapshot);
    }),
  };
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const operationsStore = createOperationsStore({ storage: defaultArchive, directory: process.env.FUORI_STUDIO_DATA_DIR || resolve(root, '.local') });
export default operationsStore;
