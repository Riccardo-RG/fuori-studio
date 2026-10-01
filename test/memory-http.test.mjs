import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';

test('chat captures provenance from the paid leader response once, reviews it, and ignores further proposals with learning off', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-memory-http-'));
  const bin = join(directory, 'codex-stub'), prompts = join(directory, 'prompts.jsonl');
  const statement = 'Preferisco documentazione tecnica in inglese.';
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('fs');
if(process.argv.includes('app-server'))process.exit(1);
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
let prompt='';process.stdin.on('data',d=>prompt+=d);process.stdin.on('end',()=>{
fs.appendFileSync(process.env.TEST_PROMPTS,JSON.stringify({prompt})+'\\n');
const text=JSON.stringify({message:'Risposta con preferenza rilevata.',projectId:'portfolio',needsInput:false,assignments:[],memoryCandidates:[{type:'preference',title:'Lingua documentazione',content:${JSON.stringify(statement)},quote:${JSON.stringify(statement)}}]});
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
});
`, { mode: 0o700 });
  const reserve = createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_DATA_DIR: directory, FUORI_STUDIO_CODEX_BIN: bin, FUORI_STUDIO_MODE: 'local', TEST_PROMPTS: prompts }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill('SIGTERM'); await once(child, 'exit'); } await rm(directory, { recursive: true, force: true }); });
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(Error('Server did not start')), 10000); let errors = '';
    child.stderr.on('data', data => errors += data);
    child.stdout.on('data', data => { if (String(data).includes('Fuori Studio')) { clearTimeout(timer); done(); } });
    child.on('exit', code => { clearTimeout(timer); if (code) reject(Error(errors)); });
  });
  const base = `http://127.0.0.1:${port}`;
  async function request(path, body, expected = 200) {
    if (path === '/api/chat' && expected === 200) {
      const receipt = await request('/api/execution/preview', { kind: 'chat', ...body });
      body = { ...body, previewId: receipt.previewId };
    }
    const response = await fetch(base + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }, body: JSON.stringify(body) } : {});
    assert.equal(response.status, expected);
    return response.headers.get('content-type')?.includes('text/event-stream') ? response.text() : response.json();
  }
  const events = await request('/api/chat', { scopeId: 'business', message: statement });
  assert.match(events, /"type":"memory"/);
  const studio = await request('/api/studio');
  const snapshot = await request('/api/workspace');
  const candidate = snapshot.memoryAssistant.candidates[0];
  assert.equal(candidate.source.conversationId, studio.id);
  assert.equal(candidate.source.messageId, studio.messages.find(item => item.role === 'user').id);
  assert.equal(snapshot.memories.length, 0);
  assert.equal((await readFile(prompts, 'utf8')).trim().split('\n').length, 1, 'memory extraction uses no second inference');
  const approved = await request('/api/workspace', { action: 'reviewMemoryCandidate', payload: { id: candidate.id, expectedVersion: 1, decision: 'approve' } });
  assert.equal(approved.memories[0].content, statement);
  const policy = approved.memoryAssistant.policies.find(item => item.scopeId === 'business');
  await request('/api/workspace', { action: 'setMemoryPolicy', payload: { scopeId: 'business', expectedVersion: policy.version, mode: 'assisted', learningEnabled: false, automaticTypes: [] } });
  const disabled = await request('/api/chat', { scopeId: 'business', message: statement });
  assert.doesNotMatch(disabled, /"type":"memory"/);
  const saved = await request('/api/memory/remember', { scopeId: 'business', conversationId: studio.id, messageId: studio.messages.find(item => item.role === 'user').id });
  assert.equal(saved.memory.content, statement);
  assert.equal(saved.duplicate, true);
  await request('/api/memory/remember', { scopeId: 'personal', conversationId: studio.id, messageId: studio.messages.find(item => item.role === 'user').id }, 409);
  const portable = await request('/api/memory/export', { scopeIds: ['business'], format: 'encrypted', passphrase: 'A long export test passphrase' });
  assert.equal(portable.counts.memories, 1);
  assert.doesNotMatch(portable.content, /Preferisco documentazione/);
  const preview = await request('/api/memory/preview-import', { content: portable.content, passphrase: 'A long export test passphrase', targetScopeId: 'development' });
  assert.equal(preview.counts.memories, 1);
  const imported = await request('/api/memory/import', { importId: preview.importId });
  assert.equal(imported.imported.memories, 1);
  assert.equal(imported.snapshot.memories.find(item => item.scopeId === 'development').status, 'proposed');
  assert.equal((await readFile(prompts, 'utf8')).trim().split('\n').length, 2, 'export and import never call an AI service');
});
