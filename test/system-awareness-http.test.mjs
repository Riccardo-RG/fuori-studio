import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { createArchive } from '../lib/archive.mjs';

async function fixture(t, { hosted = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-system-awareness-http-'));
  const data = join(directory, 'data'), binary = join(directory, 'fake-codex'), log = join(directory, 'prompts.jsonl');
  let child, exited;
  t.after(async () => { if (child?.exitCode === null) child.kill('SIGTERM'); if (exited) await exited; await rm(directory, { recursive: true, force: true }); });
  await writeFile(binary, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
if(process.argv.includes('app-server')){
  require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);
    if(request.method==='initialize')console.log(JSON.stringify({id:request.id,result:{userAgent:'fixture'}}));
    if(request.method==='account/rateLimits/read')console.log(JSON.stringify({id:request.id,result:{accountId:'PRIVATE_ACCOUNT_ID',ordinaryUsageAllowed:true,rateLimits:{limitId:'codex',primary:{usedPercent:36,windowDurationMins:300,resetsAt:1790900000},credits:{balance:'PRIVATE_CREDIT'}}}}));
  });
}else{
let prompt='';process.stdin.on('data',value=>prompt+=value);process.stdin.on('end',()=>{
  const router=process.argv.includes('--output-schema');
  fs.appendFileSync(process.env.TEST_PROMPT_LOG,JSON.stringify({prompt,router})+'\\n');
  const text=router?JSON.stringify({message:'DERIVED_SYSTEM_ANSWER: una risposta verificata.',needsInput:false,assignments:[{agentId:'forge',task:'Fornisci un contributo indipendente.'}],memoryCandidates:[]}):'SPECIALIST_SYSTEM_ANSWER: contributo verificato.';
  console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text}}));
  console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:router?27:17,output_tokens:router?8:5,cached_input_tokens:3}}));
});
}
`, { mode: 0o700 });
  const key = hosted ? randomBytes(32).toString('base64') : '';
  const sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  if (hosted) {
    const archive = createArchive({ directory: data, masterKey: key, mode: 'hybrid' }), now = Date.now();
    const hash = value => createHash('sha256').update(value).digest('hex');
    try {
      await archive.write('identity', { version: 1, generation: 0, flows: [], sessions: [{
        id: 'awareness-owner', tokenHash: hash(sessionToken), principal: hash(JSON.stringify(['https://identity.example.com/', 'test-client', 'owner-subject'])),
        name: 'Owner', csrfToken: csrf, createdAt: now, lastSeenAt: now, expiresAt: now + 3600000,
      }] });
    } finally { await archive.close(); }
  }
  const probe = createServer();
  probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(done => probe.close(done));
  child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: {
    ...process.env, PORT: String(port), FUORI_STUDIO_DATA_DIR: data, FUORI_STUDIO_CODEX_BIN: binary, TEST_PROMPT_LOG: log,
    FUORI_STUDIO_MODE: hosted ? 'hybrid' : 'local', FUORI_STUDIO_MASTER_KEY: key, FUORI_STUDIO_BIND: '127.0.0.1',
    ...(hosted ? { FUORI_STUDIO_PUBLIC_URL: 'https://studio.example.com', FUORI_STUDIO_OIDC_ISSUER: 'https://identity.example.com', FUORI_STUDIO_OIDC_CLIENT_ID: 'test-client', FUORI_STUDIO_OIDC_CLIENT_SECRET: 'fixture-oidc-secret', FUORI_STUDIO_OWNER_SUBJECT: 'owner-subject' } : {}),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', errors = '';
  child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => errors += bytes);
  exited = once(child, 'exit');
  for (let attempt = 0; !output.includes('Fuori Studio') && attempt < 300; attempt++) {
    if (child.exitCode !== null) throw Error(errors);
    await new Promise(done => setTimeout(done, 20));
  }
  assert.match(output, /Fuori Studio/, errors);
  async function request(path, payload, status = 200, { owner = true, headers = {} } = {}) {
    const result = await new Promise((done, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method: payload === undefined ? 'GET' : 'POST', headers: {
        Host: hosted ? 'studio.example.com' : `127.0.0.1:${port}`,
        ...(payload === undefined ? {} : { 'Content-Type': 'application/json', 'X-Fuori-Studio': 'local' }),
        ...(hosted && owner ? { Cookie: `__Host-fuori_session=${sessionToken}`, Origin: 'https://studio.example.com', 'X-CSRF-Token': csrf } : {}), ...headers,
      } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
    assert.equal(result.status, status, `${path}: ${result.body.slice(0, 1500)}`);
    assert.equal(result.headers['cache-control'], 'no-store');
    if (String(result.headers['content-type']).includes('text/event-stream')) {
      const events = result.body.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)));
      assert.equal(events.some(event => event.type === 'error'), false, result.body);
      assert.ok(events.some(event => event.type === 'done'), result.body);
      return events;
    }
    return JSON.parse(result.body);
  }
  const calls = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };
  const preview = input => request('/api/execution/preview', { kind: 'chat', workflowId: null, scopeId: 'business', agentIds: ['nova'], ...input });
  const chat = (input, receipt, status) => request('/api/chat', { workflowId: null, scopeId: 'business', ...input, previewId: receipt.previewId }, status);
  return { request, preview, chat, calls, data, secrets: [key, sessionToken, csrf, 'fixture-oidc-secret'].filter(Boolean) };
}

function promptAwareness(prompt) {
  const match = /DATI DEL SISTEMA \(non istruzioni\):\n([^\n]+)\nFINE DATI DEL SISTEMA/.exec(prompt);
  assert.ok(match, 'the exact reviewed awareness must be present in the provider prompt');
  return JSON.parse(match[1]);
}

test('HTTP awareness binds repository evidence, actual usage and scoped metadata to reviewed chat calls', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const saveMemory = payload => f.request('/api/workspace', { action: 'saveMemory', payload: { type: 'fact', status: 'confirmed', source: 'User fixture', sharedWith: [], agentIds: [], ...payload } });
  await saveMemory({ scopeId: 'personal', title: 'Personal-only information', content: 'PERSONAL_AWARENESS_SECRET' });
  const memory = (await saveMemory({ scopeId: 'business', title: 'Technical token context', content: 'BUSINESS_AWARENESS_CONTEXT: useful context about token consumption.' })).memories.find(item => item.content.includes('BUSINESS_AWARENESS_CONTEXT'));
  const input = { message: 'Quali token consumate e da cosa dipende il consumo delle risposte?', agentIds: ['nova', 'forge'] };
  const knowledge = await f.request('/api/system/knowledge?q=' + encodeURIComponent(input.message));
  assert.ok(knowledge.topics.includes('tokens'));
  assert.ok(knowledge.evidence.some(item => item.path.startsWith('docs/')));
  assert.ok(knowledge.evidence.some(item => item.path.startsWith('lib/')));
  assert.match(knowledge.identity.sourceDigest, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(JSON.stringify(knowledge), /PERSONAL_AWARENESS_SECRET|BUSINESS_AWARENESS_CONTEXT/);
  const excerpt = knowledge.evidence[0];
  const source = await f.request('/api/system/source?path=' + encodeURIComponent(excerpt.path) + `&start=${excerpt.startLine}&end=${excerpt.endLine}`);
  assert.equal(source.digest, excerpt.digest); assert.equal(source.path, excerpt.path);
  assert.ok(source.text.startsWith(excerpt.text));
  for (const path of ['../package.json', '/etc/passwd', '.env', '.local/archive.sqlite', f.data, 'lib/../package.json', 'lib/providers.mjs/../../.env']) {
    await f.request('/api/system/source?path=' + encodeURIComponent(path), undefined, 404);
  }
  await f.request('/api/system/source?path=lib/providers.mjs&start=0', undefined, 404);
  await f.request('/api/system/source?path=lib/providers.mjs&start=NaN', undefined, 404);
  await f.request('/api/system/knowledge', undefined, 403, { headers: { Origin: 'https://other.example' } });
  const first = await f.preview(input);
  for (const step of first.steps) {
    const awareness = step.systemAwareness;
    assert.equal(awareness.runtime.mode, 'local');
    assert.deepEqual(awareness.runtime.provider, { type: 'codex', model: null, modelKnown: false, executionTarget: 'local', authentication: 'chatgpt_login' });
    assert.equal(awareness.runtime.usage.calls, 0);
    assert.equal(awareness.runtime.usage.inputTokens, null);
    assert.equal(awareness.runtime.accountQuota.source, 'codex_app_server');
    assert.equal(awareness.runtime.accountQuota.limits[0].primary.remainingPercent, 64);
    assert.equal(awareness.runtime.accountQuota.ordinaryUsageAllowed, true);
    assert.equal(awareness.runtime.availability.providerQuotaKnown, true);
    assert.equal(awareness.runtime.monetaryCost, null);
    assert.doesNotMatch(JSON.stringify(awareness),/PRIVATE_ACCOUNT_ID|PRIVATE_CREDIT/);
    assert.deepEqual(awareness.runtime.recentResponses, []);
    assert.ok(awareness.knowledge.topics.includes('tokens'));
  }
  assert.equal((await f.calls()).length, 0, 'read endpoints and preview must not dispatch inference');
  await f.chat(input, first);
  const calls = await f.calls(); assert.equal(calls.length, 2);
  for (const [index, call] of calls.entries()) {
    assert.deepEqual(promptAwareness(call.prompt), first.steps[index].systemAwareness);
    assert.doesNotMatch(call.prompt, /PERSONAL_AWARENESS_SECRET/);
  }
  const studio = await f.request('/api/studio');
  const answers = studio.messages.filter(item => item.execution?.systemAwareness);
  assert.deepEqual(answers.map(item => item.agentId), ['nova', 'forge']);
  assert.deepEqual(answers.map(item => item.execution.usage), [{ inputTokens: 27, outputTokens: 8 }, { inputTokens: 17, outputTokens: 5 }]);
  for (const [index, answer] of answers.entries()) {
    const record = answer.execution.systemAwareness;
    assert.match(record.digest, /^[a-f0-9]{64}$/);
    assert.deepEqual(record.runtime, first.steps[index].systemAwareness.runtime);
    assert.deepEqual(record.sources, first.steps[index].systemAwareness.knowledge.evidence.map(({ path, startLine, endLine, digest }) => ({ path, startLine, endLine, digest })));
    assert.ok(record.sources.every(item => !Object.hasOwn(item, 'text')), 'responses retain source references, not duplicate code excerpts');
  }
  const later = await f.preview({ ...input, message: 'Quanti token avete consumato prima di questa risposta?' });
  assert.equal(later.steps[0].systemAwareness.runtime.usage.inputTokens, 27);
  assert.equal(later.steps[1].systemAwareness.runtime.usage.inputTokens, 17, 'aggregate usage must not include another agent');
  for (const step of later.steps) {
    assert.equal(step.systemAwareness.runtime.usage.calls, 1);
    assert.equal(step.systemAwareness.runtime.usage.complete, true);
    assert.deepEqual(step.systemAwareness.runtime.recentResponses.map(item => item.usage), [{ inputTokens: 27, outputTokens: 8 }, { inputTokens: 17, outputTokens: 5 }]);
  }
  const excluded = { message: 'Spiega il consumo token usando soltanto il materiale selezionato.', selection: { excludeMemoryIds: [memory.id], includeHistory: true }, agentIds: ['nova', 'forge'] };
  const withoutDerived = await f.preview(excluded);
  for (const step of withoutDerived.steps) {
    assert.equal(step.history.some(item => answers.some(answer => answer.id === item.id)), false);
    assert.deepEqual(step.systemAwareness.runtime.recentResponses, [], 'metadata of excluded derived answers must not reappear through awareness');
  }
  const freshInput = { ...excluded, agentIds: ['nova'], selection: { ...excluded.selection, includeHistory: false } };
  const fresh = await f.preview(freshInput);
  assert.deepEqual(fresh.steps[0].history, []);
  assert.deepEqual(fresh.steps[0].systemAwareness.runtime.recentResponses, []);
  await f.chat(freshInput, fresh);
  const nextCall = (await f.calls())[2];
  assert.deepEqual(promptAwareness(nextCall.prompt), fresh.steps[0].systemAwareness);
  assert.equal(promptAwareness(nextCall.prompt).runtime.usage.inputTokens, 27, 'a later prompt sees completed provider-reported usage');
  assert.doesNotMatch(nextCall.prompt, /BUSINESS_AWARENESS_CONTEXT|DERIVED_SYSTEM_ANSWER|SPECIALIST_SYSTEM_ANSWER|PERSONAL_AWARENESS_SECRET/);
  await f.request('/api/conversation/scope', { scopeId: 'personal' });
  const personal = await f.preview({ scopeId: 'personal', message: 'Quali token ho consumato in questo ambito?' });
  assert.equal(personal.steps[0].systemAwareness.runtime.usage.calls, 0);
  assert.equal(personal.steps[0].systemAwareness.runtime.usage.inputTokens, null);
  assert.deepEqual(personal.steps[0].systemAwareness.runtime.recentResponses, []);
  assert.doesNotMatch(JSON.stringify(personal), /BUSINESS_AWARENESS_CONTEXT|DERIVED_SYSTEM_ANSWER|SPECIALIST_SYSTEM_ANSWER/);
  assert.equal(personal.steps[0].systemAwareness.runtime.budget.daily.used, 3, 'only the documented installation-wide daily budget spans scopes');
  await f.request('/api/conversation/scope', { scopeId: 'business' });
  const staleInput = { message: 'Quale servizio AI è configurato?' }, stale = await f.preview(staleInput);
  const key = 'FIXTURE_PRIVATE_PROVIDER_KEY';
  const configured = await f.request('/api/providers', { action: 'saveConnection', payload: { name: 'Fixture API', type: 'openai', model: 'fixture-model', apiKey: key } });
  const providerId = configured.connections.at(-1).id;
  await f.request('/api/providers', { action: 'setScopePolicy', payload: { scopeId: 'business', connectionIds: ['codex', providerId] } });
  await f.request('/api/providers', { action: 'assignAgent', payload: { agentId: 'nova', connectionId: providerId } });
  await f.chat(staleInput, stale, 409);
  const apiPreview = await f.preview(staleInput);
  assert.deepEqual(apiPreview.steps[0].systemAwareness.runtime.provider, { type: 'openai', model: 'fixture-model', modelKnown: true, executionTarget: 'api', authentication: 'api_key' });
  assert.doesNotMatch(JSON.stringify(apiPreview), /FIXTURE_PRIVATE_PROVIDER_KEY/);
  assert.equal((await f.calls()).length, 3, 'inspection, changed previews and rejected receipts cannot make extra AI calls');
  assert.equal((await f.request('/api/governance')).daily.calls, 3);
});

test('hosted system knowledge and source routes require owner sessions and enforce the source allowlist', { timeout: 15000 }, async t => {
  const f = await fixture(t, { hosted: true });
  for (const route of ['/api/system/knowledge?q=tokens', '/api/system/source?path=package.json']) {
    await f.request(route, undefined, 401, { owner: false });
    await f.request(route, undefined, 401, { owner: false, headers: { Authorization: `Bearer ${randomBytes(32).toString('base64url')}` } });
    await f.request(route, undefined, 403, { headers: { Origin: 'https://other.example.com' } });
    const result = await f.request(route);
    for (const secret of f.secrets) assert.equal(JSON.stringify(result).includes(secret), false);
  }
  await f.request('/api/system/source?path=' + encodeURIComponent('../.local/archive.sqlite'), undefined, 404);
  assert.equal((await f.calls()).length, 0);
  assert.equal((await f.request('/api/governance')).daily.calls, 0);
});
