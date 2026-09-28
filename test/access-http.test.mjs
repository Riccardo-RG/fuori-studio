import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createArchive } from '../lib/archive.mjs';

test('remote HTTP requires owner session, CSRF and exact origin; device tokens cannot read owner APIs', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-access-http-'));
  const key = randomBytes(32).toString('base64'), sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const archive = createArchive({ directory, masterKey: key, mode: 'hybrid' }), now = Date.now();
  await archive.write('identity', { version: 1, generation: 0, flows: [], sessions: [{ id: 'test-owner-session', tokenHash: digest(sessionToken), principal: digest(JSON.stringify(['https://identity.example.com/', 'test-client', 'owner-subject'])), name: 'Owner', csrfToken: csrf, createdAt: now, lastSeenAt: now, expiresAt: now + 3600000 }] });
  await archive.close();
  const portProbe = createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening'); const port = portProbe.address().port; await new Promise(done => portProbe.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: { ...process.env, PORT: String(port), FUORI_STUDIO_MODE: 'hybrid', FUORI_STUDIO_PUBLIC_URL: 'https://studio.example.com', FUORI_STUDIO_OIDC_ISSUER: 'https://identity.example.com', FUORI_STUDIO_OIDC_CLIENT_ID: 'test-client', FUORI_STUDIO_OIDC_CLIENT_SECRET: 'fixture-secret', FUORI_STUDIO_OWNER_SUBJECT: 'owner-subject', FUORI_STUDIO_MASTER_KEY: key, FUORI_STUDIO_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', errors = ''; child.stdout.on('data', bytes => log += bytes); child.stderr.on('data', bytes => errors += bytes);
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; !log.includes('Fuori Studio') && i < 200; i++) { if (child.exitCode !== null) throw Error(errors); await new Promise(done => setTimeout(done, 20)); }
  assert.match(log, /Fuori Studio/);
  async function request(path, { payload, owner = false, headers = {}, status = 200 } = {}) {
    const result = await new Promise((done, reject) => {
      const request = httpRequest({host:'127.0.0.1',port,path,method:payload===undefined?'GET':'POST',headers:{Host:'studio.example.com',...(payload===undefined?{}:{'Content-Type':'application/json'}),...(owner?{Cookie:`__Host-fuori_session=${sessionToken}`,Origin:'https://studio.example.com','X-CSRF-Token':csrf}:{}),...headers}}, response=>{
        const chunks=[]; response.on('data',chunk=>chunks.push(chunk)); response.on('end',()=>done({status:response.statusCode,text:Buffer.concat(chunks).toString()}));
      }); request.on('error',reject); request.end(payload===undefined?undefined:JSON.stringify(payload));
    });
    const body=JSON.parse(result.text); assert.equal(result.status,status,`${path}: ${JSON.stringify(body)}`); return body;
  }
  assert.equal((await request('/api/session')).authenticated, false);
  for (const endpoint of ['/api/studio', '/api/workspace', '/api/operations', '/api/providers', '/api/access', '/api/github', '/api/evaluations?scopeId=business']) await request(endpoint, { status: 401 });
  assert.equal((await request('/api/session', { owner: true })).authenticated, true);
  const access = await request('/api/access', { owner: true }); assert.equal(access.storage.encrypted, true);
  await request('/api/workspace', { payload: { action: 'createScope', payload: { name: 'Test', kind: 'project', parentId: 'business' } }, owner: true, headers: { 'X-CSRF-Token': '' }, status: 403 });
  await request('/api/workspace', { payload: {}, owner: true, headers: { Origin: 'https://attacker.example' }, status: 403 });
  await request('/api/session', { owner: true, headers: { Host: 'evil.example' }, status: 403 });
  const pairing = await request('/api/devices', { owner: true, payload: { action: 'pair', payload: { name: 'Fixture device', scopeIds: ['business'], capabilities: ['execute'] } } });
  assert.ok(pairing.code); assert.equal(pairing.serverUrl, 'https://studio.example.com');
  const device = await request('/api/device/pair', { payload: { code: pairing.code } });
  await request('/api/device/pair', { payload: { code: pairing.code }, status: 401 });
  const deviceHeaders = { Authorization: `Bearer ${device.token}` };
  await request('/api/workspace', { headers: deviceHeaders, status: 401 });
  await request('/api/github', { headers: deviceHeaders, status: 401 });
  await request('/api/evaluations?scopeId=business', { headers: deviceHeaders, status: 401 });
  await request('/api/device/sync', { payload: { scopeIds: ['business'], records: {}, bases: {}, scopes: [] }, headers: deviceHeaders, status: 401 });
  assert.equal((await request('/api/device/claim', { payload: {}, headers: deviceHeaders })).job, null);
  await request('/api/devices', { owner: true, payload: { action: 'target', payload: { id: device.deviceId } } });
  const studio = await request('/api/studio', { owner: true }); assert.equal(studio.provider.ready, true); assert.match(studio.provider.provider, /Fixture device/);
  await request('/api/devices', { owner: true, payload: { action: 'revoke', payload: { id: device.deviceId } } });
  await request('/api/device/claim', { payload: {}, headers: deviceHeaders, status: 401 });
  const secondPair = await request('/api/devices', {owner:true,payload:{action:'pair',payload:{name:'Private sync device',scopeIds:['personal'],capabilities:['sync']}}});
  const secondDevice = await request('/api/device/pair', {payload:{code:secondPair.code}});
  assert.deepEqual(await request('/api/device/disconnect', {payload:{},headers:{Authorization:`Bearer ${secondDevice.token}`}}),{ok:true});
  const connectionInput = { name: 'Private repositories', token: 'fixture-github-credential-123456', scopeIds: ['business'], repositories: ['owner/private'], allowPublish: false };
  await request('/api/github', { owner: true, payload: { action: 'save', payload: connectionInput }, headers: { 'X-CSRF-Token': '' }, status: 403 });
  const connection = await request('/api/github', { owner: true, payload: { action: 'save', payload: connectionInput } });
  assert.equal(connection.snapshot.connections[0].tokenConfigured, true);
  assert.ok(!JSON.stringify(connection).includes(connectionInput.token));
  await request('/api/github', { owner: true, payload: { action: 'publish', payload: { id: 'missing', expectedVersion: 1 } }, status: 404 });
  const workspace = await request('/api/workspace', { owner: true, payload: { action: 'saveMemory', payload: { scopeId: 'business', title: 'Runtime deployment', content: 'Use Node 24 for the studio.', type: 'fact', status: 'confirmed', source: 'Fixture owner', sharedWith: [], agentIds: [] } } });
  const memory = workspace.memories.at(-1);
  const evalInput = { scopeId: 'business', title: 'Runtime retrieval', query: 'runtime deployment', agentId: 'forge', expectedIds: [memory.id], forbiddenIds: [] };
  await request('/api/evaluations', { owner: true, payload: { action: 'saveCase', payload: evalInput }, headers: { 'X-CSRF-Token': '' }, status: 403 });
  const evaluations = await request('/api/evaluations', { owner: true, payload: { action: 'saveCase', payload: evalInput } }), item = evaluations.cases[0];
  const evaluation = await request('/api/evaluations', { owner: true, payload: { action: 'runCase', payload: { id: item.id, expectedVersion: item.version } } });
  assert.equal(evaluation.runs[0].status, 'passed'); assert.equal(evaluation.noAiCalls, true);
  await request('/api/evaluations?scopeId=unknown', { owner: true, status: 403 });
  await request('/api/evaluations', { owner: true, payload: { action: 'feedback', payload: { memoryId: memory.id, memoryVersion: memory.version, helpful: true } } });
  assert.equal((await request('/api/evaluations?scopeId=business', { owner: true })).feedback.length, 1);
  await request('/api/evaluations', { owner: true, payload: { action: 'removeCase', payload: { id: item.id, expectedVersion: item.version } } });
  assert.equal((await request('/api/evaluations?scopeId=business', { owner: true })).runs.length, 0);
  await request('/auth/logout', { owner: true, payload: {} });
  await request('/api/workspace', { owner: true, status: 401 });
});
