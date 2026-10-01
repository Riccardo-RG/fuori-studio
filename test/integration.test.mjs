import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

test('HTTP and chat use isolated durable scope context and block unauthorized handoffs', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-integration-'));
  const bin = join(directory, 'codex-stub');
  const prompts = join(directory, 'prompts.jsonl');
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('fs');
if(process.argv.includes('app-server'))process.exit(1);
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
fs.appendFileSync(process.env.TEST_PROMPTS,JSON.stringify({prompt})+'\\n');
const text=process.argv.includes('--output-schema')?JSON.stringify({message:'Risposta di prova del coordinatore.',needsInput:false,assignments:[{agentId:'forge',task:'Prepara una proposta.'}]}):'Risposta di prova dello specialista.';
setTimeout(()=>console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}})),120);
});
`, { mode: 0o700 });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening'); const port = reserve.address().port; await new Promise(done => reserve.close(done));
  let child;
  t.after(async () => { if (child && child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  async function start() {
    child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_DATA_DIR: directory, FUORI_STUDIO_CODEX_BIN: bin, TEST_PROMPTS: prompts }, stdio: ['ignore', 'pipe', 'pipe'] });
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Error('Server did not start')), 8000); let errors = '';
      child.stderr.on('data', d => errors += d);
      child.stdout.on('data', d => { if (String(d).includes('Fuori Studio')) { clearTimeout(timer); done(); } });
      child.on('exit', code => { clearTimeout(timer); if (code) reject(Error(errors)); });
    });
  }
  await start();
  const url = `http://127.0.0.1:${port}`;
  async function request(path, value, expected = 200, extra = {}) {
    const response = await fetch(url + path, value ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local', ...extra }, body: JSON.stringify(value) } : undefined);
    const raw = await response.text(); let result; try { result=JSON.parse(raw); } catch { result={error:raw}; } assert.equal(response.status, expected, JSON.stringify(result)); return result;
  }
  const mutate = (action, payload, expected) => request('/api/workspace', { action, payload }, expected);
  const note = (scopeId, title, more = {}) => ({ scopeId, title, content: title, type: 'preference', status: 'confirmed', source: 'integration fixture', sharedWith: [], agentIds: [], ...more });
  await mutate('saveMemory', note('personal', 'PERSONAL_SECRET'));
  await mutate('saveMemory', note('business', 'BUSINESS_FACT'));
  await mutate('saveMemory', note('business', 'UNCONFIRMED', { status: 'proposed' }));
  assert.equal((await request('/api/studio')).scopeId, 'business');
  await request('/api/workspace', { action: 'saveMemory', payload: note('business', 'BLOCKED_ORIGIN') }, 403, { Origin: 'https://example.com' });
  async function chat(scopeId, workflowId = null, agentIds = ['nova', 'forge']) {
    const receipt = await request('/api/execution/preview', { kind: 'chat', message: 'Aiutami con il prossimo passo.', scopeId, workflowId, agentIds });
    const response = await fetch(url + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }, body: JSON.stringify({ message: 'Aiutami con il prossimo passo.', scopeId, workflowId, previewId: receipt.previewId }) });
    assert.equal(response.status, 200); return response;
  }
  const first = await chat('business');
  await mutate('saveMemory', note('business', 'CONCURRENT'), 409);
  assert.match(await first.text(), /Risposta di prova dello specialista/);
  assert.equal((await request('/api/studio')).projectId, null, 'a conversation without a reviewed project must not acquire a demo project');
  let captured = (await readFile(prompts, 'utf8')).trim().split('\n').map(line => JSON.parse(line).prompt);
  assert.equal(captured.length, 2);
  assert.ok(captured.every(p => p.includes('BUSINESS_FACT') && !p.includes('PERSONAL_SECRET') && !p.includes('UNCONFIRMED')));
  const snapshot = await mutate('saveMemory', note('business', 'LEADER_ONLY', { agentIds: ['nova'] }));
  await request('/api/execution/preview', { kind: 'chat', message: 'Aiutami con il prossimo passo.', scopeId: 'business', agentIds: ['nova', 'forge'] }, 409);
  assert.equal((await readFile(prompts, 'utf8')).trim().split('\n').length, 2, 'restricted handoff fails before any paid call');
  assert.match(await (await chat('business', null, ['nova'])).text(), /non sono autorizzati/);
  captured = (await readFile(prompts, 'utf8')).trim().split('\n').map(line => JSON.parse(line).prompt);
  assert.equal(captured.length, 3, 'leader-only data blocks delegated prompt');
  const restricted = snapshot.memories.find(m => m.title === 'LEADER_ONLY');
  await mutate('deleteMemory', { id: restricted.id });
  const workflow = snapshot.workflows.find(w => w.scopeId === 'business');
  await mutate('saveWorkflow', { id: workflow.id, expectedVersion: workflow.version, status: 'ready' });
  assert.match(await (await chat('business', workflow.id)).text(), /Risposta di prova/);
  captured = (await readFile(prompts, 'utf8')).trim().split('\n').map(line => JSON.parse(line).prompt);
  assert.ok(captured.at(-1).includes(workflow.title));
  assert.ok(!captured.at(-1).includes('LEADER_ONLY'));
  await request('/api/conversation/scope', { scopeId: 'personal' });
  assert.equal((await request('/api/studio')).messages.length, 1);
  await request('/api/chat', { message: 'Wrong scope', scopeId: 'business' }, 409);
  await (await chat('personal')).text();
  captured = (await readFile(prompts, 'utf8')).trim().split('\n').map(line => JSON.parse(line).prompt);
  assert.ok(captured.at(-1).includes('PERSONAL_SECRET'));
  assert.ok(!captured.at(-1).includes('BUSINESS_FACT'));
  child.kill('SIGTERM'); await once(child, 'exit'); await start();
  const restored = await request('/api/studio');
  assert.equal(restored.scopeId, 'personal'); assert.equal(restored.messages.length, 4);
  const publicData = await fetch(url + '/.local/workspace.json'); assert.equal(publicData.status, 404);
});
