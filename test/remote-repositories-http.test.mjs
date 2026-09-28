import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { createArchive } from '../lib/archive.mjs';
import { createRepositoryRuntime } from '../lib/repository-runtime.mjs';
import { createRepositoryWorker } from '../lib/repository-worker.ts';

// Seed an exact-owner session to exercise hosted HTTP authorization without a
// live identity provider. A fake executable replaces only Codex; Git snapshots,
// worker protocol, encrypted journals and configured Node checks remain real.
test('hosted owner can review an explicitly scoped repository-only worker receipt with real Git/check evidence', { timeout: 25000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-remote-repository-http-'));
  const source = join(directory, 'source'), data = join(directory, 'hub'), bin = join(directory, 'fake-codex.cjs');
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: directory, env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: 'pipe' });
  git('init', '-q', source);
  await writeFile(join(source, 'value.mjs'), 'export const value = 1;\n');
  await writeFile(join(source, 'value.test.mjs'), "import assert from 'node:assert/strict'; import {value} from './value.mjs'; assert.equal(value, 2);\n");
  git('-C', source, 'add', '.'); git('-C', source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'base');
  const base = git('-C', source, 'rev-parse', 'HEAD').toString().trim();
  await writeFile(join(source, 'value.mjs'), 'export const value = 999; // owner uncommitted change\n');
  await writeFile(bin, `#!${process.execPath}
const fs=require('node:fs'),cp=require('node:child_process'),path=require('node:path');
const args=process.argv.slice(2),index=args.indexOf('-C'),cwd=index>=0?args[index+1]:process.cwd();
if(args.includes('login')){console.log('Logged in using ChatGPT');process.exit(0);}
if(args[0]==='sandbox'){const split=args.indexOf('--'),child=cp.spawnSync(args[split+1],args.slice(split+2),{cwd,env:process.env,encoding:'utf8'});process.stdout.write(child.stdout||'');process.stderr.write(child.stderr||'');process.exit(child.status??1);}
let input='';process.stdin.on('data',data=>input+=data);process.stdin.on('end',()=>{fs.writeFileSync(path.join(cwd,'value.mjs'),'export const value = 2;\\n');console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Prepared the scoped patch. Review the recorded command evidence.'}}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:17,output_tokens:7}}));});
`, { mode: 0o700 });
  const masterKey = randomBytes(32).toString('base64'), sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  const digest = value => createHash('sha256').update(value).digest('hex'), archive = createArchive({ directory: data, masterKey, mode: 'hybrid' }), now = Date.now();
  await archive.write('identity', { version: 1, generation: 0, flows: [], sessions: [{ id: 'fixture-owner', tokenHash: digest(sessionToken), principal: digest(JSON.stringify(['https://identity.example.com/', 'test-client', 'owner-subject'])), name: 'Owner', csrfToken: csrf, createdAt: now, lastSeenAt: now, expiresAt: now + 3600000 }] }); await archive.close();
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(done => probe.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_MODE: 'hybrid', FUORI_STUDIO_PUBLIC_URL: 'https://studio.example.com', FUORI_STUDIO_OIDC_ISSUER: 'https://identity.example.com', FUORI_STUDIO_OIDC_CLIENT_ID: 'test-client', FUORI_STUDIO_OIDC_CLIENT_SECRET: 'fixture-secret', FUORI_STUDIO_OWNER_SUBJECT: 'owner-subject', FUORI_STUDIO_MASTER_KEY: masterKey, FUORI_STUDIO_DATA_DIR: data, FUORI_STUDIO_CODEX_BIN: bin }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', stderr = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.on('data', bytes => stderr += bytes); const exited = once(child, 'exit');
  const workerStorage = createArchive({ directory: join(directory, 'worker-archive'), mode: 'local' });
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await workerStorage.close(); await rm(directory, { recursive: true, force: true }); });
  for (let index = 0; !output.includes('Fuori Studio') && index < 250; index++) { if (child.exitCode !== null) throw Error(stderr); await new Promise(done => setTimeout(done, 20)); } assert.match(output, /Fuori Studio/, stderr);
  async function transport(path, { payload, owner = false, headers = {}, signal } = {}) {
    return new Promise((done, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port, path, signal, method: payload === undefined ? 'GET' : 'POST', headers: { Host: 'studio.example.com', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }), ...(owner ? { Cookie: `__Host-fuori_session=${sessionToken}`, Origin: 'https://studio.example.com', 'X-CSRF-Token': csrf } : {}), ...headers } }, response => {
        const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => { const text = Buffer.concat(chunks).toString(); done({ status: response.statusCode, headers: response.headers, text, body: response.headers['content-type']?.includes('application/json') ? JSON.parse(text) : null }); });
      }); request.on('error', reject); request.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
  }
  async function request(path, options = {}, expected = 200) { const response = await transport(path, options); assert.equal(response.status, expected, `${path}: ${response.text}`); return response.body; }
  const owner = (path, payload) => request(path, { owner: true, ...(payload ? { payload } : {}) });
  async function pair(capabilities) { const invite = await owner('/api/devices', { action: 'pair', payload: { name: 'Fixture worker', scopeIds: ['business'], capabilities } }); return request('/api/device/pair', { payload: { code: invite.code } }); }
  await request('/api/repositories', {}, 401);
  await request('/api/repositories', { owner: true, payload: { action: 'register', payload: {} }, headers: { 'X-CSRF-Token': '' } }, 403);
  await request('/api/repositories', { owner: true, payload: {}, headers: { Origin: 'https://attacker.example' } }, 403);
  const connection = { ...await pair(['repository']), url: 'https://studio.example.com' }, textOnly = await pair(['execute']);
  await request('/api/device/repositories/announce', { payload: { repositories: [] }, headers: { Authorization: `Bearer ${textOnly.token}` } }, 401);
  await request('/api/device/claim', { payload: {}, headers: { Authorization: `Bearer ${connection.token}` } }, 401);
  await request('/api/repositories', { headers: { Authorization: `Bearer ${connection.token}` } }, 401);
  const runtime = createRepositoryRuntime({ directory: join(directory, 'worker-runs'), codexBinary: bin });
  const worker = createRepositoryWorker({ storage: workerStorage, runtime, connection, heartbeatMs: 50, request: async (path, payload, signal) => {
    const response = await transport(path, { payload, signal, headers: { Authorization: `Bearer ${connection.token}` } });
    if (response.status !== 200) throw Object.assign(Error(response.body?.error || 'Fixture request failed'), { statusCode: response.status });
    return response.body;
  } });
  const configured = [{ label: 'Value check', program: 'node', args: ['--test', 'value.test.mjs'] }];
  await worker.add({ alias: 'product', path: source, scopeIds: ['business'], checks: configured }); await worker.announce();
  const catalog = await owner('/api/repositories'); assert.equal(catalog.localAvailable, false); assert.equal(catalog.workers.length, 1); assert.equal(catalog.workers[0].online, true); assert.equal(JSON.stringify(catalog).includes(source), false);
  const access = await owner('/api/access'); assert.equal(access.executionTarget, 'local', 'no paired text target was selected'); assert.equal((await owner('/api/studio')).provider.ready, false, 'hosted Codex text execution remains unavailable');
  const project = (await owner('/api/operations', { action: 'createProject', payload: { title: 'Hosted owned product', scopeId: 'business' } })).projects[0];
  await request('/api/repositories', { owner: true, payload: { action: 'register', payload: { projectId: project.id, scopeId: 'business', executionTarget: connection.deviceId, repositoryAlias: 'product', path: source } } }, 400);
  const registered = await owner('/api/repositories', { action: 'register', payload: { projectId: project.id, scopeId: 'business', executionTarget: connection.deviceId, repositoryAlias: 'product' } });
  const repository = registered.repositories[0]; assert.equal(repository.dirty, true); assert.deepEqual(repository.checks, configured); assert.equal(repository.head, base); assert.equal(repository.executionTarget, connection.deviceId);
  let snapshot = await owner('/api/repositories', { action: 'create', payload: { repositoryId: repository.id, title: 'Correct value remotely', brief: 'Set the value to 2 and run the authorized test.' } }), run = snapshot.runs[0];
  await request('/api/repositories', { owner: true, payload: { action: 'approve', payload: { id: run.id, expectedVersion: run.version } } }, 409);
  const preview = await owner('/api/execution/preview', { kind: 'repository', id: run.id, expectedVersion: run.version });
  assert.equal(preview.budget.allowed, true); assert.equal(preview.requiredCalls, 1, 'only the repository worker is authorized; no text reviewer can run');
  await owner('/api/repositories', { action: 'start', payload: { id: run.id, expectedVersion: run.version, previewId: preview.previewId } });
  let processed;
  for (let attempt = 0; attempt < 150; attempt++) { processed = await worker.pollOnce(); if (processed.status === 'processed') break; await new Promise(done => setTimeout(done, 20)); } assert.equal(processed.status, 'processed');
  for (let attempt = 0; attempt < 150; attempt++) { snapshot = await owner('/api/repositories'); run = snapshot.runs[0]; if (run.status !== 'running') break; await new Promise(done => setTimeout(done, 20)); }
  assert.equal(run.status, 'review', JSON.stringify(run)); assert.equal(run.checksValid, true); assert.equal(run.checks[0].status, 'passed'); assert.equal(run.checks[0].exitCode, 0); assert.match(run.checks[0].output, /tests 1|pass 1/);
  assert.equal(run.baseCommit, base); assert.equal(run.editor.deviceId, connection.deviceId); assert.deepEqual(run.editor.usage, { inputTokens: 17, outputTokens: 7 }); assert.equal(run.review.status, 'unavailable', 'the optional text reviewer has no selected text worker');
  assert.equal(run.cwd, undefined); assert.equal(run.patch, undefined); assert.equal(JSON.stringify(snapshot).includes(source), false); assert.match(await readFile(join(source, 'value.mjs'), 'utf8'), /999/);
  const artifact = await transport('/api/repositories/patch?id=' + run.id, { owner: true }); assert.equal(artifact.status, 200); assert.match(artifact.headers['content-disposition'], /attachment/); assert.match(artifact.text, /\+export const value = 2/);
  await request('/api/repositories', { owner: true, payload: { action: 'proposeMemory', payload: { id: run.id, title: 'Too early', content: 'Needs approval.' } } }, 409);
  run = (await owner('/api/repositories', { action: 'approve', payload: { id: run.id, expectedVersion: run.version } })).runs[0]; assert.equal(run.status, 'completed');
  const remembered = await owner('/api/repositories', { action: 'proposeMemory', payload: { id: run.id, expectedVersion: run.version, title: 'Approved value convention', content: 'Use the reviewed value convention in this product.', type: 'decision' } }); assert.equal(remembered.workspace.memories.at(-1).status, 'proposed'); assert.equal(remembered.workspace.memories.at(-1).scopeId, 'business');
  const governance = await owner('/api/governance'); assert.equal(governance.daily.calls, 1); assert.equal(governance.metrics.deliveries.accepted, 1); assert.equal(governance.usageTotals.inputTokens, 17); assert.equal(governance.usageTotals.outputTokens, 7);
  assert.equal((await worker.status()).journal[0].status, 'delivered');
  await owner('/api/devices', { action: 'revoke', payload: { id: connection.deviceId } });
  await request('/api/device/repositories/claim', { payload: {}, headers: { Authorization: `Bearer ${connection.token}` } }, 401);
  assert.equal((await owner('/api/repositories')).workers.length, 0);
});
