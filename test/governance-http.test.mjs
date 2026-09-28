import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createArchive } from '../lib/archive.mjs';
import { createOperationsStore } from '../lib/operations.mjs';
import { createGovernance } from '../lib/governance.ts';

async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) { const result = await check(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw Error(`Timed out waiting for ${label}`);
}
async function fixture(t, prepare, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-governance-http-'));
  const bin = join(directory, 'codex-stub'), log = join(directory, 'calls.jsonl');
  const prepared = prepare ? await prepare(directory) : null;
  await writeFile(bin, `#!/usr/bin/env node
const fs=require('node:fs');
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',value=>prompt+=value);process.stdin.on('end',()=>{
fs.appendFileSync(process.env.TEST_CALL_LOG,JSON.stringify({prompt})+'\\n');
const plan={title:'Verified plan',nodes:[{key:'analyze',title:'Analyze',brief:'Prepare the supplied evidence.',agentId:'radar',dependsOn:[]},{key:'review',title:'Review',brief:'Review the approved evidence.',agentId:'nova',dependsOn:['analyze']}]};
const route={message:'Risposta concreta.',projectId:'portfolio',needsInput:false,assignments:[],memoryCandidates:[]};
const text=prompt.includes("Scomponi l'obiettivo")?JSON.stringify(plan):process.argv.includes('--output-schema')?JSON.stringify(route):'CONCRETE_RESULT';
setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})),prompt.includes('SLOW_TEST_MARKER')||(${Boolean(options.slowConnection)}&&prompt.includes('Reply with only the word OK.'))?30000:40);
});
`, { mode: 0o700 });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_MODE: 'local', FUORI_STUDIO_DATA_DIR: directory, FUORI_STUDIO_CODEX_BIN: bin, TEST_CALL_LOG: log }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  await new Promise((done, reject) => {
    let stderr = ''; const timeout = setTimeout(() => reject(Error(`Server did not start: ${stderr}`)), 10000);
    child.stderr.on('data', data => stderr += data);
    child.stdout.on('data', data => { if (String(data).includes('Fuori Studio')) { clearTimeout(timeout); done(); } });
    child.on('exit', code => { clearTimeout(timeout); if (code) reject(Error(stderr)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, payload, expected = 200, options = {}) {
    const response = await fetch(base + path, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }, body: JSON.stringify(payload), ...options } : options);
    const raw = await response.text(); assert.equal(response.status, expected, raw);
    return response.headers.get('content-type')?.includes('event-stream') ? raw : JSON.parse(raw);
  }
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const configure = async extra => { const { settings } = await request('/api/governance'); return request('/api/governance', { action: 'configure', payload: { expectedVersion: settings.version, dailyCallLimit: settings.dailyCallLimit, maxCallSeconds: settings.maxCallSeconds, autonomousRoutines: settings.autonomousRoutines, maxAutonomousRunsPerDay: settings.maxAutonomousRunsPerDay, ...extra } }); };
  const task = async id => (await request('/api/operations')).tasks.find(item => item.id === id);
  return { request, calls, configure, task, base, prepared };
}

test('HTTP provider/chat/task/plan calls share one durable budget, real review metrics and stable timeout/cancellation', async t => {
  const f = await fixture(t);
  await f.configure({ dailyCallLimit: 1 });
  await f.request('/api/providers/test', { id: 'codex' });
  assert.equal((await f.calls()).length, 1);
  const blocked = await f.request('/api/chat', { scopeId: 'business', message: 'A budget-blocked request.' });
  assert.match(blocked, /Limite giornaliero/); assert.equal((await f.calls()).length, 1);
  const project = (await f.request('/api/operations', { action: 'createProject', payload: { title: 'Governed product', scopeId: 'business' } })).projects[0];
  const queued = (await f.request('/api/operations', { action: 'createTask', payload: { projectId: project.id, title: 'Blocked task', brief: 'Budget should stop this task.', agentId: 'forge' } })).tasks[0];
  await f.request('/api/tasks/run', { id: queued.id, expectedVersion: queued.version });
  await until(async () => (await f.task(queued.id)).status === 'failed', 'budget-rejected task');
  assert.equal((await f.calls()).length, 1);
  assert.equal((await f.request('/api/governance')).daily.calls, 1);
  await f.configure({ dailyCallLimit: 10 });
  const draft = await f.request('/api/plans', { action: 'draft', payload: { projectId: project.id, brief: 'Prepare and review a measurable next milestone.' } });
  const graph = await f.request('/api/plans', { action: 'commit', payload: { id: draft.id } });
  assert.equal((await f.calls()).length, 2, 'committing a reviewed plan performs no AI call');
  const [parent, child] = graph.tasks.filter(item => item.planId);
  await f.request('/api/tasks/run', { id: child.id, expectedVersion: child.version }, 409);
  assert.equal((await f.calls()).length, 2);
  await f.request('/api/tasks/run', { id: parent.id, expectedVersion: parent.version });
  const delivery = await until(async () => { const item = await f.task(parent.id); return item.status === 'review' && item; }, 'parent delivery');
  await f.request('/api/governance', { action: 'saveOutcome', payload: { taskId: parent.id, helpful: true } }, 409);
  await f.request('/api/operations', { action: 'approveTask', payload: { id: parent.id, expectedVersion: delivery.version } });
  await f.request('/api/governance', { action: 'saveOutcome', payload: { taskId: parent.id, helpful: true, minutesSaved: 15 } });
  await f.request('/api/tasks/run', { id: child.id, expectedVersion: child.version });
  await until(async () => (await f.task(child.id)).status === 'review', 'dependent delivery');
  const metrics = await f.request('/api/governance');
  assert.equal(metrics.daily.calls, 4); assert.equal(metrics.metrics.deliveries.accepted, 1); assert.equal(metrics.metrics.deliveries.pending, 1); assert.equal(metrics.metrics.deliveries.acceptanceRatio, 1); assert.equal(metrics.feedback.minutesSaved, 15);
  assert.match((await f.calls()).at(-1).prompt, /CONSEGNE PRECEDENTI APPROVATE/);
  await f.configure({ maxCallSeconds: 1 });
  const timeout = await f.request('/api/chat', { scopeId: 'business', message: 'SLOW_TEST_MARKER timeout test.' });
  assert.match(timeout, /limite di tempo/);
  assert.equal((await f.request('/api/governance')).usageTotals.timedOut, 1);
  const abort = new AbortController();
  const response = await fetch(f.base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }, body: JSON.stringify({ scopeId: 'business', message: 'SLOW_TEST_MARKER cancellation test.' }), signal: abort.signal });
  await until(async () => (await f.request('/api/governance')).usageTotals.running === 1, 'reserved chat call');
  abort.abort(); await response.body.cancel().catch(() => {});
  await until(async () => (await f.request('/api/governance')).usageTotals.cancelled === 1, 'cancelled chat accounting');
  const final = await f.request('/api/governance');
  assert.equal(final.daily.calls, 6); assert.equal(final.usageTotals.running, 0);
});

test('automatic scheduler skips an already-claimed queued occurrence and leaves manual requests responsive', async t => {
  const f = await fixture(t, async directory => {
    const storage = createArchive({ directory, mode: 'local' }), governance = createGovernance({ storage });
    const settings = (await governance.snapshot()).settings;
    await governance.configure({ expectedVersion: settings.version, dailyCallLimit: 10, maxCallSeconds: 180, autonomousRoutines: true, maxAutonomousRunsPerDay: 2 });
    const operations = createOperationsStore({ directory, storage });
    const project = (await operations.mutate('createProject', { title: 'Routine project', scopeId: 'business' })).projects[0];
    const queued = [];
    for (const title of ['Already claimed', 'Next eligible']) {
      const routine = (await operations.mutate('createRoutine', { projectId: project.id, title, brief: 'Prepare a short text draft.', agentId: 'nova', enabled: true, intervalHours: 24, nextRunAt: new Date(Date.now() - 1000).toISOString() })).routines.at(-1);
      queued.push((await operations.mutate('claimDueRoutine', { id: routine.id, expectedVersion: routine.version })).tasks.at(-1));
    }
    await governance.claimRoutine({ routineId: queued[0].routineId, scopeId: queued[0].scopeId, occurrenceId: queued[0].id });
    await storage.close(); return queued;
  });
  const [claimed, next] = f.prepared;
  await until(async () => (await f.task(next.id)).status === 'review', 'second automatic occurrence');
  assert.equal((await f.task(claimed.id)).status, 'queued');
  assert.equal((await f.calls()).length, 1);
  const reply = await f.request('/api/chat', { scopeId: 'business', message: 'Manual follow-up after the routine.' });
  assert.match(reply, /Risposta concreta/);
  const state = await f.request('/api/governance');
  assert.equal(state.daily.autonomousRuns, 2); assert.equal(state.daily.calls, 2);
});

test('disconnecting a provider connection test cancels its reserved call and releases the mutation lock', async t => {
  const f = await fixture(t, undefined, { slowConnection: true });
  const controller = new AbortController();
  const pending = fetch(f.base + '/api/providers/test', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' },
    body: JSON.stringify({ id: 'codex' }), signal: controller.signal,
  });
  await until(async () => (await f.request('/api/governance')).usageTotals.running === 1 && (await f.calls()).length === 1, 'reserved connection test');
  controller.abort(); await assert.rejects(pending, { name: 'AbortError' });
  const cancelled = await until(async () => { const state = await f.request('/api/governance'); return state.usageTotals.cancelled === 1 && state; }, 'cancelled connection test');
  assert.equal(cancelled.daily.calls, 1); assert.equal(cancelled.usageTotals.running, 0); assert.equal(cancelled.usages[0].kind, 'connection_test');
  await f.request('/api/conversation/new', {});
  const reply = await f.request('/api/chat', { scopeId: 'business', message: 'Follow-up after cancelling the connection test.' });
  assert.match(reply, /Risposta concreta/);
  const final = await f.request('/api/governance');
  assert.equal(final.daily.calls, 2); assert.equal(final.usageTotals.cancelled, 1); assert.equal(final.usageTotals.succeeded, 1);
});
