import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { randomBytes, createHash } from 'node:crypto';
import { createArchive } from '../lib/archive.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) { for (let attempt = 0; attempt < 250; attempt++) { const result = await check(); if (result) return result; await delay(20); } throw Error(`Timed out waiting for ${label}`); }
async function fixture(t, { hybrid = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-budgets-http-')), binary = join(directory, 'codex-stub'), log = join(directory, 'calls.jsonl');
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',value=>prompt+=value);process.stdin.on('end',()=>{fs.appendFileSync(process.env.TEST_CALL_LOG,JSON.stringify({prompt})+'\\n');if(prompt.includes('BUDGET_TEST_FORCE_FAILURE'))process.exit(1);console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Verified fake deliverable.'}}));});
`, { mode: 0o700 });
  const masterKey = randomBytes(32).toString('base64'), sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  if (hybrid) {
    const digest = value => createHash('sha256').update(value).digest('hex'), now = Date.now(), archive = createArchive({ directory, masterKey, mode: 'hybrid' });
    await archive.write('identity', { version: 1, generation: 0, flows: [], sessions: [{ id: 'budget-owner', tokenHash: digest(sessionToken), principal: digest(JSON.stringify(['https://identity.example.com/', 'test-client', 'owner-subject'])), name: 'Owner', csrfToken: csrf, createdAt: now, lastSeenAt: now, expiresAt: now + 3600000 }] }); await archive.close();
  }
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(done => probe.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_MODE: hybrid ? 'hybrid' : 'local', FUORI_STUDIO_DATA_DIR: directory, FUORI_STUDIO_CODEX_BIN: binary, TEST_CALL_LOG: log, ...(hybrid ? { FUORI_STUDIO_PUBLIC_URL: 'https://studio.example.com', FUORI_STUDIO_OIDC_ISSUER: 'https://identity.example.com', FUORI_STUDIO_OIDC_CLIENT_ID: 'test-client', FUORI_STUDIO_OIDC_CLIENT_SECRET: 'fixture-secret', FUORI_STUDIO_OWNER_SUBJECT: 'owner-subject', FUORI_STUDIO_MASTER_KEY: masterKey } : {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', bytes => stdout += bytes); child.stderr.on('data', bytes => stderr += bytes); const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); });
  await until(() => { if (child.exitCode !== null) throw Error(stderr); return stdout.includes('Fuori Studio'); }, `server start: ${stderr}`);
  async function request(path, payload, status = 200, { owner = true, headers = {} } = {}) {
    const response = await new Promise((done, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: payload === undefined ? 'GET' : 'POST', headers: { Host: hybrid ? 'studio.example.com' : `127.0.0.1:${port}`, ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(hybrid ? owner ? { Cookie: `__Host-fuori_session=${sessionToken}`, Origin: 'https://studio.example.com', 'X-CSRF-Token': csrf } : {} : { 'X-Fuori-Studio': 'local' }), ...headers } }, res => { const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => done({ status: res.statusCode, text: Buffer.concat(chunks).toString() })); }); req.on('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
    const value = JSON.parse(response.text); assert.equal(response.status, status, `${path}: ${response.text}`); return value;
  }
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const mutate = (action, payload, status) => request('/api/operations', { action, payload }, status);
  const project = async (title = 'Budget project', scopeId = 'business') => (await mutate('createProject', { title, scopeId })).projects.at(-1);
  const task = async (projectId, more = {}) => (await mutate('createTask', { projectId, title: 'Budget assignment', brief: 'Produce a short test deliverable.', agentId: 'forge', ...more })).tasks.at(-1);
  const getTask = async id => (await request('/api/operations')).tasks.find(item => item.id === id);
  const configure = (payload, status) => request('/api/budgets', { action: 'configureBudget', payload }, status);
  const preview = task => request('/api/execution/preview', { kind: 'task', id: task.id, expectedVersion: task.version });
  const start = (task, plan, status) => request('/api/tasks/run', { id: task.id, expectedVersion: task.version, ...(plan ? { previewId: plan.previewId } : {}) }, status);
  return { request, calls, mutate, project, task, getTask, configure, preview, start };
}

test('HTTP budget writes derive trusted project/task identities and reject ownership or ancestry spoofing', async t => {
  const f = await fixture(t), first = await f.project(), second = await f.project('Different project', 'personal'), task = await f.task(first.id);
  const setting = { projectId: first.id, taskId: task.id, callLimit: 3, expectedVersion: 0 };
  await f.configure({ ...setting, projectId: second.id }, 404);
  await f.configure({ ...setting, scopeId: 'personal' }, 400);
  await f.configure({ ...setting, budgetRunId: 'reset-my-counter' }, 400);
  await f.configure({ ...setting, runId: 'ambiguous' }, 400);
  await f.configure({ ...setting, projectId: 'missing' }, 400);
  await f.configure({ ...setting, taskId: 'missing' }, 404);
  await f.configure({ projectId: first.id, runId: 'missing', callLimit: 3, expectedVersion: 0 }, 404);
  assert.equal((await f.request('/api/budgets')).entries.length, 0);
  const saved = await f.configure(setting), entry = saved.entries.find(item => item.taskId === task.id);
  assert.equal(entry.scopeId, 'business'); assert.equal(entry.projectId, first.id); assert.equal(entry.callLimit, 3);
  await f.configure({ ...setting, callLimit: 9 }, 409);
  assert.equal((await f.request('/api/budgets')).entries.find(item => item.taskId === task.id).callLimit, 3);
  assert.equal((await f.calls()).length, 0);
});

test('HTTP preview blocks a multi-agent task before any paid dispatch and actual calls share project/assignment ceilings', async t => {
  const f = await fixture(t), project = await f.project();
  const workflow = (await f.request('/api/workspace', { action: 'saveWorkflow', payload: { scopeId: 'business', title: 'Analyze then review', input: 'Brief', output: 'Reviewed output', status: 'ready', steps: [{ title: 'Analyze', agentId: 'forge', output: 'Draft the proposal.' }, { title: 'Review', agentId: 'nova', output: 'Review the previous draft.' }] } })).workflows.at(-1);
  let task = await f.task(project.id, { workflowId: workflow.id });
  await f.configure({ projectId: project.id, taskId: task.id, callLimit: 1, expectedVersion: 0 });
  await f.configure({ projectId: project.id, callLimit: 2, expectedVersion: 0 });
  const blocked = await f.preview(task);
  assert.equal(blocked.requiredCalls, 2); assert.equal(blocked.budget.allowed, false); assert.deepEqual(blocked.budget.blocking, ['ASSIGNMENT_CALL_LIMIT']);
  await f.start(task, blocked, 409); await f.start(task, null, 409);
  assert.equal((await f.getTask(task.id)).status, 'queued'); assert.equal((await f.calls()).length, 0);
  await f.configure({ projectId: project.id, taskId: task.id, callLimit: 2, expectedVersion: 1 });
  const ready = await f.preview(task); assert.equal(ready.budget.allowed, true);
  await f.start(task, ready);
  task = await until(async () => { const current = await f.getTask(task.id); assert.notEqual(current.status, 'failed', JSON.stringify(current)); return current.status === 'review' && current; }, 'two-agent delivery');
  assert.equal((await f.calls()).length, 2);
  const budgets = await f.request('/api/budgets'), assignment = budgets.entries.find(item => item.taskId === task.id), overall = budgets.entries.find(item => item.projectId === project.id && !item.taskId && !item.runId);
  assert.equal(assignment.used, 2); assert.equal(assignment.remaining, 0); assert.equal(overall.used, 2); assert.equal(overall.remaining, 0); assert.equal(assignment.usage.inputTokens, null); assert.equal(assignment.usage.unknownInputCount, 2);
  const another = await f.task(project.id, { title: 'Different assignment' }), projectBlocked = await f.preview(another);
  assert.equal(projectBlocked.budget.allowed, false); assert.ok(projectBlocked.budget.blocking.includes('PROJECT_CALL_LIMIT')); await f.start(another, projectBlocked, 409);
  task = (await f.mutate('requestChanges', { id: task.id, expectedVersion: task.version, feedback: 'Refine the same assignment.' })).tasks.find(item => item.id === task.id);
  const revision = await f.preview(task); assert.equal(revision.budget.assignment.used, 2); assert.equal(revision.budget.allowed, false); await f.start(task, revision, 409);
  assert.equal((await f.calls()).length, 2);
});

test('HTTP start binds the receipt to its task and fresh budget, and failed attempts remain charged', async t => {
  const f = await fixture(t), project = await f.project(), first = await f.task(project.id), second = await f.task(project.id, { title: 'Another task', brief: 'BUDGET_TEST_FORCE_FAILURE' });
  const firstPreview = await f.preview(first); await f.start(second, firstPreview, 409);
  await f.configure({ projectId: project.id, taskId: first.id, callLimit: 0, expectedVersion: 0 }); await f.start(first, firstPreview, 409);
  assert.equal((await f.calls()).length, 0);
  await f.configure({ projectId: project.id, taskId: second.id, callLimit: 1, expectedVersion: 0 });
  await f.start(second, await f.preview(second));
  const failed = await until(async () => { const current = await f.getTask(second.id); return current.status === 'failed' && current; }, 'failed fake call');
  assert.equal((await f.calls()).length, 1);
  const report = await f.preview(failed); assert.equal(report.budget.assignment.used, 1); assert.equal(report.budget.assignment.usage.failed, 1); assert.equal(report.budget.allowed, false);
  await f.start(failed, report, 409); assert.equal((await f.calls()).length, 1);
  const governance = await f.request('/api/governance'); assert.equal(governance.daily.calls, 1); assert.equal(governance.usageTotals.failed, 1);
});

test('HTTP budgets and preview require the owner session and mutation CSRF in hosted mode', async t => {
  const f = await fixture(t, { hybrid: true });
  await f.request('/api/budgets', undefined, 401, { owner: false });
  await f.request('/api/budgets', { action: 'configureBudget', payload: {} }, 401, { owner: false });
  await f.request('/api/execution/preview', { kind: 'task', id: 'missing' }, 401, { owner: false });
  const project = await f.project();
  const payload = { action: 'configureBudget', payload: { projectId: project.id, callLimit: 7, expectedVersion: 0 } };
  await f.request('/api/budgets', payload, 403, { headers: { 'X-CSRF-Token': '' } });
  await f.request('/api/budgets', payload, 403, { headers: { Origin: 'https://attacker.example' } });
  await f.request('/api/execution/preview', { kind: 'task', id: 'missing' }, 403, { headers: { 'X-CSRF-Token': '' } });
  assert.equal((await f.request('/api/budgets')).entries.length, 0);
  const result = await f.request('/api/budgets', payload); assert.equal(result.entries[0].callLimit, 7);
  assert.equal((await f.calls()).length, 0);
});

test('a zero project budget also blocks its planning call before fake Codex dispatch', async t => {
  const f = await fixture(t), project = await f.project();
  await f.configure({ projectId: project.id, callLimit: 0, expectedVersion: 0 });
  const preview = await f.request('/api/execution/preview', { kind: 'plan', projectId: project.id, brief: 'Plan a small project milestone.' });
  assert.equal(preview.budget.allowed, false);
  await f.request('/api/plans', { action: 'draft', payload: { projectId: project.id, brief: 'Plan a small project milestone.', previewId: preview.previewId } }, 409);
  assert.equal((await f.calls()).length, 0);
  assert.equal((await f.request('/api/governance')).daily.calls, 0);
});
