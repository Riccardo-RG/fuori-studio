import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, limit = 5000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) { const result = await check(); if (result) return result; await delay(25); }
  throw Error(`Timed out waiting for ${label}.`);
}
async function freePort() {
  const server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}

test('HTTP operations cover reviewed task versions, provider boundaries, protected internals, restart and instance lock', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-operations-http-'));
  const binary = join(directory, 'codex-stub'); const prompts = join(directory, 'prompts.jsonl');
  await writeFile(binary, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('login')) { console.log('Logged in using ChatGPT'); process.exit(0); }
let prompt = '';
process.stdin.on('data', data => prompt += data);
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.TEST_PROMPTS, JSON.stringify({ prompt }) + '\\n');
  const text = process.argv.includes('--output-schema') ? JSON.stringify({ message: 'Coordinator fixture', projectId: 'portfolio', needsInput: false, assignments: [] }) : 'Reviewed fixture contribution';
  setTimeout(() => console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } })), 80);
});
`, { mode: 0o700 });
  const port = await freePort(); const base = `http://127.0.0.1:${port}`; const children = new Set(); let child;
  const spawnServer = testPort => {
    const instance = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(testPort), FUORI_STUDIO_DATA_DIR: directory, FUORI_STUDIO_CODEX_BIN: binary, TEST_PROMPTS: prompts }, stdio: ['ignore', 'pipe', 'pipe'] });
    instance.log = ''; instance.errors = ''; instance.stdout.on('data', value => instance.log += value); instance.stderr.on('data', value => instance.errors += value);
    instance.exited = once(instance, 'exit'); children.add(instance); return instance;
  };
  const stop = async instance => { if (instance.exitCode === null && instance.signalCode === null) instance.kill('SIGTERM'); await instance.exited; };
  t.after(async () => { await Promise.all([...children].map(stop)); await rm(directory, { recursive: true, force: true }); });
  async function start() {
    child = spawnServer(port);
    await until(() => { if (child.exitCode !== null) throw Error(child.errors); return child.log.includes('Fuori Studio'); }, 'server startup');
  }
  await start();
  async function request(path, payload, expected = 200) {
    const response = await fetch(base + path, payload === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }, body: JSON.stringify(payload) });
    const raw = await response.text(); let value; try { value = JSON.parse(raw); } catch { value = { raw }; }
    assert.equal(response.status, expected, `${path}: ${raw}`); return value;
  }
  const runTask = async (payload, expected = 200) => {
    const preview = await request('/api/execution/preview', { kind: 'task', ...payload }, expected);
    if (expected !== 200) return preview;
    return request('/api/tasks/run', { ...payload, previewId: preview.previewId });
  };
  const mutate = (action, payload, expected) => request('/api/operations', { action, payload }, expected);
  const memoryMutation = (action, payload, expected) => request('/api/workspace', { action, payload }, expected);
  const getTask = async id => (await request('/api/operations')).tasks.find(task => task.id === id);
  const readyTask = id => until(async () => { const task = await getTask(id); if (task.status === 'failed') throw Error(task.events.at(-1).message); return task.status === 'review' ? task : false; }, 'task review');
  const promptCount = async () => { try { return (await readFile(prompts, 'utf8')).trim().split('\n').filter(Boolean).length; } catch (error) { if (error.code === 'ENOENT') return 0; throw error; } };

  const project = (await mutate('createProject', { title: 'Owned HTTP product', description: 'Durable project fixture', scopeId: 'business' })).projects[0];
  assert.equal(project.kind, 'owned');
  const flow = (await memoryMutation('saveWorkflow', { scopeId: 'business', title: 'Two-stage review', input: 'Brief', output: 'Deliverable', status: 'ready', steps: [{ title: 'Analyze', agentId: 'forge', output: 'Analyze supplied evidence.' }, { title: 'Draft', agentId: 'forge', output: 'Prepare the final proposal.' }] })).workflows.at(-1);
  const privateNote = (await memoryMutation('saveMemory', { scopeId: 'personal', title: 'Shared personal criterion', content: 'PERSONAL_POLICY_MARKER', type: 'preference', status: 'confirmed', source: 'HTTP fixture', sharedWith: ['business'], agentIds: ['forge'] })).memories.at(-1);
  let task = (await mutate('createTask', { projectId: project.id, title: 'First deliverable', agentId: 'forge', workflowId: flow.id })).tasks[0];
  assert.equal(task.steps.length, 2);
  await mutate('startTask', { id: task.id }, 400);
  await mutate('startStep', { id: task.id, stepId: task.steps[0].id, executionId: 'fake' }, 400);
  await mutate('submitArtifact', { id: task.id, content: 'Injected' }, 400);
  await request('/api/tasks/run', { id: task.id, expectedVersion: task.version }, 409);
  await runTask({ id: task.id, expectedVersion: task.version });
  await memoryMutation('deleteMemory', { id: privateNote.id }, 409);
  task = await readyTask(task.id);
  assert.equal(await promptCount(), 2);
  task = (await mutate('requestChanges', { id: task.id, expectedVersion: task.version, feedback: 'Make the acceptance criteria explicit.' })).tasks[0];
  await runTask({ id: task.id, expectedVersion: task.version }); task = await readyTask(task.id);
  assert.equal(task.artifacts.length, 2); assert.equal(task.artifacts[0].decision, 'changes_requested');
  task = (await mutate('approveTask', { id: task.id, expectedVersion: task.version })).tasks[0];
  const proposal = (await request('/api/tasks/memory', { id: task.id, title: 'Approved reusable criterion', content: 'Review measurable criteria.', type: 'pattern' })).memories.at(-1);
  assert.equal(proposal.status, 'proposed'); assert.deepEqual(proposal.agentIds, ['forge']);

  // Learning cannot broaden a delivery's restricted memory permissions.
  await request('/api/workflows/learn',{action:'preview',payload:{taskId:task.id,expectedVersion:task.version}},409);
  const learningProject=(await mutate('createProject',{title:'Learning fixture',scopeId:'development',kind:'owned'})).projects.at(-1);
  let learningTask=(await mutate('createTask',{projectId:learningProject.id,title:'Reusable method',brief:'Review acceptance criteria.',agentId:'forge'})).tasks.at(-1);
  await runTask({id:learningTask.id,expectedVersion:learningTask.version});learningTask=await readyTask(learningTask.id);
  learningTask=(await mutate('approveTask',{id:learningTask.id,expectedVersion:learningTask.version})).tasks.find(item=>item.id===learningTask.id);
  const learnInput={taskId:learningTask.id,expectedVersion:learningTask.version},preview=await request('/api/workflows/learn',{action:'preview',payload:learnInput});
  const {scopeId:ignoredScope,source:ignoredSource,sharedWith:ignoredSharing,...recipe}=preview.workflow;
  const learned=await request('/api/workflows/learn',{action:'save',payload:{...learnInput,workflow:{...recipe,status:'ready'}}});
  const savedRecipe=learned.snapshot.workflows.find(item=>item.id===learned.workflowId);assert.equal(savedRecipe.scopeId,'development');assert.deepEqual(savedRecipe.sharedWith,[]);
  const repeated=(await mutate('createTask',{projectId:learningProject.id,title:'Use reviewed workflow',brief:'New materials.',workflowId:learned.workflowId,inputValues:{objective:'Review this case',deliverable:'A criteria checklist'},expectedWorkflowVersion:savedRecipe.version})).tasks.at(-1);
  assert.equal(repeated.status,'queued');assert.equal(repeated.steps[0].instruction,savedRecipe.steps[0].output);

  const secret = 'fixture-api-secret-not-for-public-responses';
  const publicProviders = await request('/api/providers', { action: 'saveConnection', payload: { name: 'Fixture OpenAI', type: 'openai', model: 'fixture-model', apiKey: secret } });
  assert.ok(!JSON.stringify(publicProviders).includes(secret));
  for (const path of ['/api/providers', '/api/operations', '/api/workspace']) assert.ok(!JSON.stringify(await request(path)).includes(secret));
  await request('/.local/providers.json', undefined, 404);
  await request('/api/providers', { action: 'setScopePolicy', payload: { scopeId: 'personal', connectionIds: [] } });
  const blocked = (await mutate('createTask', { projectId: project.id, title: 'Blocked by source scope', agentId: 'forge' })).tasks.at(-1);
  const count = await promptCount();
  await runTask({ id: blocked.id }, 403);
  assert.equal(await promptCount(), count); assert.equal((await getTask(blocked.id)).status, 'queued');
  await request('/api/providers', { action: 'setScopePolicy', payload: { scopeId: 'personal', connectionIds: ['codex'] } });

  const duplicate = spawnServer(await freePort());
  const [exitCode] = await duplicate.exited;
  assert.notEqual(exitCode, 0); assert.match(duplicate.errors, /altro server|archivio/);
  assert.equal((await request('/api/operations')).tasks[0].status, 'completed');
  const routine = (await mutate('createRoutine', { projectId: project.id, title: 'Restart routine', workflowId: flow.id, agentId: 'forge', enabled: true, intervalHours: 24, nextRunAt: '2026-01-01T00:00:00.000Z' })).routines[0];
  await stop(child); await start();
  const queued = await until(async () => (await request('/api/operations')).tasks.find(item => item.routineId === routine.id), 'routine queue after restart');
  assert.equal(queued.status, 'queued'); assert.equal(queued.steps.length, 2); assert.equal(await promptCount(), count);
  const restored = await getTask(task.id);
  assert.equal(restored.status, 'completed'); assert.equal(restored.artifacts.length, 2);
  assert.equal((await request('/api/workspace')).memories.find(item => item.id === proposal.id).status, 'proposed');
  const templateTask = (await mutate('createTask', { projectId: project.id, title: 'New owned product brief', brief: 'Explore the next milestone.', template: 'product-brief' })).tasks.at(-1);
  assert.equal(templateTask.status, 'queued'); assert.equal(templateTask.steps.length, 4);
  assert.deepEqual(templateTask.steps.map(step => step.agentId), ['nova', 'radar', 'forge', 'muse']);
  assert.equal(templateTask.workflowId, null);
  await mutate('createTask', { projectId: project.id, title: 'Unknown template', template: 'untrusted-template' }, 400);
  await mutate('createTask', { projectId: project.id, title: 'Ambiguous template', template: 'product-brief', workflowId: flow.id }, 400);
});
