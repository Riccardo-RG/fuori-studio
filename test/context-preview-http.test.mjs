import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  for (let attempt = 0; attempt < 250; attempt++) { const result = await check(); if (result) return result; await delay(20); }
  throw Error(`Timed out waiting for ${label}.`);
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-context-preview-http-'));
  const fakeCodex = join(directory, 'fake-codex'), log = join(directory, 'prompts.jsonl');
  await writeFile(fakeCodex, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',value=>prompt+=value);process.stdin.on('end',()=>{
  const router=process.argv.includes('--output-schema');
  fs.appendFileSync(process.env.TEST_PROMPT_LOG,JSON.stringify({prompt,router})+'\\n');
  const derived=/MEMORY_EXCLUSION_MARKER|SOURCE_EXCLUSION_MARKER/.test(prompt);
  const text=router?JSON.stringify({message:derived?'DERIVED_HISTORY_MARKER: an answer based on the original material.':'A fresh answer from the selected material.',projectId:'portfolio',needsInput:false,assignments:[{agentId:'forge',task:'Provide an independent implementation recommendation.'}],memoryCandidates:[]}):'A concrete specialist contribution.';
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
});
`, { mode: 0o700 });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_DATA_DIR: join(directory, 'data'), FUORI_STUDIO_MODE: 'local', FUORI_STUDIO_CODEX_BIN: fakeCodex, TEST_PROMPT_LOG: log }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', value => stdout += value); child.stderr.on('data', value => stderr += value);
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); });
  await until(() => { if (child.exitCode !== null) throw Error(stderr); return stdout.includes('Fuori Studio'); }, 'server startup');
  const base = `http://127.0.0.1:${port}`;
  async function request(path, payload, expected = 200) {
    const response = await fetch(base + path, payload === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }, body: JSON.stringify(payload) });
    const raw = await response.text();
    assert.equal(response.status, expected, `${path}: ${raw}`);
    if (response.headers.get('content-type')?.includes('text/event-stream')) {
      const events = raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.some(event => event.type === 'error'), false, raw);
      assert.ok(events.some(event => event.type === 'done'), raw);
      return events;
    }
    return JSON.parse(raw);
  }
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const workspace = (action, payload) => request('/api/workspace', { action, payload });
  const operations = (action, payload) => request('/api/operations', { action, payload });
  const preview = (input, expected) => request('/api/execution/preview', { kind: 'chat', workflowId: null, scopeId: 'business', ...input }, expected);
  const chat = (input, receipt, expected) => request('/api/chat', { scopeId: 'business', workflowId: null, ...input, ...(receipt ? { previewId: receipt.previewId } : {}) }, expected);
  return { request, workspace, operations, preview, chat, calls };
}

test('HTTP context previews bind chat permissions, exclusions, original workflow values and task execution without extra inference', { timeout: 20000 }, async t => {
  const f = await fixture(t);
  const project = (await f.operations('createProject', { title: 'Context preview project', scopeId: 'business' })).projects.at(-1);
  let memory = (await f.workspace('saveMemory', { scopeId: 'business', type: 'fact', title: 'Boundary specification review', content: 'Boundary specification review MEMORY_EXCLUSION_MARKER.', status: 'confirmed', source: 'User fixture', sharedWith: [], agentIds: [] })).memories.at(-1);
  const source = (await f.request('/api/sources', { action: 'importText', payload: { scopeId: 'business', title: 'Boundary specification review', text: 'Boundary specification review SOURCE_EXCLUSION_MARKER supplied requirements.' } })).source;
  const message = 'Review the boundary specification and recommend the next step.';
  const input = { message, projectId: project.id };

  await f.chat(input, null, 409);
  const mismatch = await f.preview(input);
  await f.chat({ ...input, message: 'A different request.' }, mismatch, 409);
  const stale = await f.preview(input);
  memory = (await f.workspace('saveMemory', { id: memory.id, expectedVersion: memory.version, content: memory.content + ' A reviewed update.' })).memories.at(-1);
  await f.chat(input, stale, 409);
  const withdrawnProvider = await f.preview(input);
  await f.request('/api/providers', { action: 'setScopePolicy', payload: { scopeId: 'business', connectionIds: [] } });
  await f.chat(input, withdrawnProvider, 403);
  await f.request('/api/providers', { action: 'setScopePolicy', payload: { scopeId: 'business', connectionIds: ['codex'] } });
  const oldBudget = await f.preview(input);
  await f.request('/api/budgets', { action: 'configureBudget', payload: { projectId: project.id, callLimit: 0, expectedVersion: 0 } });
  await f.chat(input, oldBudget, 409);
  const blocked = await f.preview(input); assert.equal(blocked.budget.allowed, false);
  await f.chat(input, blocked, 409);
  assert.equal((await f.calls()).length, 0, 'previews and rejected execution must never invoke the provider');
  await f.request('/api/budgets', { action: 'configureBudget', payload: { projectId: project.id, callLimit: 10, expectedVersion: 1 } });

  const leaderOnly = await f.preview(input);
  assert.deepEqual(leaderOnly.agentIds, ['nova']); assert.equal(leaderOnly.requiredCalls, 1);
  assert.ok(leaderOnly.steps[0].memories.some(item => item.id === memory.id && item.included));
  assert.ok(leaderOnly.steps[0].sources.some(item => item.id === source.id && item.included));
  const firstEvents = await f.chat(input, leaderOnly);
  assert.deepEqual(firstEvents.filter(event => event.type === 'message' && event.message.role === 'assistant').map(event => event.message.agentId), ['nova']);
  assert.ok(firstEvents.some(event => event.type === 'notice'), 'the stub tries to delegate to unauthorized forge');
  assert.equal((await f.calls()).length, 1);
  await f.chat(input, leaderOnly, 409);
  const studio = await f.request('/api/studio'), originalAnswer = studio.messages.find(item => item.text.includes('DERIVED_HISTORY_MARKER'));
  assert.ok(originalAnswer.context.memories.some(item => item.id === memory.id));
  assert.ok(originalAnswer.context.sources.some(item => item.id === source.id));

  const selection = { excludeMemoryIds: [memory.id], excludeSourceIds: [source.id], includeHistory: true };
  const followup = { message: 'Give a new recommendation using only the selected material.', projectId: project.id, agentIds: ['nova', 'forge'], selection };
  const reviewed = await f.preview(followup);
  assert.deepEqual(reviewed.agentIds, ['nova', 'forge']); assert.equal(reviewed.requiredCalls, 2);
  for (const step of reviewed.steps) {
    assert.ok(step.history.some(item => item.role === 'user' && item.text === message), 'history remains enabled');
    assert.equal(step.history.some(item => item.id === originalAnswer.id), false, 'derived answers must not reintroduce excluded material');
    assert.equal(step.memories.some(item => item.id === memory.id && item.included), false);
    assert.equal(step.sources.some(item => item.id === source.id && item.included), false);
  }
  const events = await f.chat(followup, reviewed);
  assert.deepEqual(events.filter(event => event.type === 'message' && event.message.role === 'assistant').map(event => event.message.agentId), ['nova', 'forge']);
  let calls = await f.calls(); assert.equal(calls.length, 3); assert.deepEqual(calls.map(call => call.router), [true, true, false]);
  for (const call of calls.slice(1)) assert.doesNotMatch(call.prompt, /MEMORY_EXCLUSION_MARKER|SOURCE_EXCLUSION_MARKER|DERIVED_HISTORY_MARKER/);

  const workflow = (await f.workspace('saveWorkflow', { scopeId: 'business', title: 'Structured fields without placeholders', input: 'Read the supplied case.', output: 'A concrete decision note.', status: 'ready', steps: [{ title: 'Assess', agentId: 'nova', output: 'Evaluate the available evidence.' }], inputFields: [{ key: 'objective', label: 'Objective', required: true, defaultValue: '' }, { key: 'deliverable', label: 'Deliverable', required: true, defaultValue: '' }] })).workflows.at(-1);
  const workflowInput = { message: 'Apply the selected procedure.', projectId: project.id, workflowId: workflow.id, expectedWorkflowVersion: workflow.version, selection: { ...selection, includeHistory: false } };
  await f.preview(workflowInput, 400);
  assert.equal((await f.calls()).length, 3);
  const populated = { ...workflowInput, inputValues: { objective: 'STRUCTURED_OBJECTIVE_MARKER', deliverable: 'STRUCTURED_DELIVERABLE_MARKER' } };
  const workflowPreview = await f.preview(populated);
  assert.equal(workflowPreview.steps[0].history.length, 0);
  await f.chat(populated, workflowPreview);
  calls = await f.calls(); assert.equal(calls.length, 4);
  assert.match(calls[3].prompt, /STRUCTURED_OBJECTIVE_MARKER/); assert.match(calls[3].prompt, /STRUCTURED_DELIVERABLE_MARKER/);
  assert.doesNotMatch(calls[3].prompt, /MEMORY_EXCLUSION_MARKER|SOURCE_EXCLUSION_MARKER|DERIVED_HISTORY_MARKER/);

  const task = (await f.operations('createTask', { projectId: project.id, title: 'Boundary specification review', brief: message, agentId: 'forge' })).tasks.at(-1);
  const taskSelection = { excludeMemoryIds: [memory.id], excludeSourceIds: [source.id] };
  const taskPreview = await f.request('/api/execution/preview', { kind: 'task', id: task.id, expectedVersion: task.version, selection: taskSelection });
  await f.request('/api/tasks/run', { id: task.id, expectedVersion: task.version, previewId: taskPreview.previewId });
  const delivered = await until(async () => { const current = (await f.request('/api/operations')).tasks.find(item => item.id === task.id); assert.notEqual(current.status, 'failed', JSON.stringify(current)); return current.status === 'review' && current; }, 'task review');
  assert.deepEqual(delivered.contextSelection, taskSelection);
  assert.deepEqual(delivered.steps[0].context.memories, []); assert.deepEqual(delivered.steps[0].context.sources, []);
  calls = await f.calls(); assert.equal(calls.length, 5);
  assert.doesNotMatch(calls[4].prompt, /MEMORY_EXCLUSION_MARKER|SOURCE_EXCLUSION_MARKER|DERIVED_HISTORY_MARKER/);
  assert.equal((await f.request('/api/governance')).daily.calls, 5);
});
