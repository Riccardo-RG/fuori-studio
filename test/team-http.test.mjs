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

test('team names require owner access and CSRF, reject stale edits, and persist without AI calls', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-team-http-'));
  const key = randomBytes(32).toString('base64'), sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const archive = createArchive({ directory, masterKey: key, mode: 'hybrid' }), now = Date.now();
  await archive.write('identity', { version: 1, generation: 0, flows: [], sessions: [{
    id: 'team-owner-session', tokenHash: digest(sessionToken),
    principal: digest(JSON.stringify(['https://identity.example.com/', 'test-client', 'owner-subject'])),
    name: 'Owner', csrfToken: csrf, createdAt: now, lastSeenAt: now, expiresAt: now + 3600000,
  }] });
  await archive.close();
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: {
    ...process.env, PORT: String(port), FUORI_STUDIO_MODE: 'hybrid', FUORI_STUDIO_BIND: '127.0.0.1',
    FUORI_STUDIO_PUBLIC_URL: 'https://studio.example.com', FUORI_STUDIO_OIDC_ISSUER: 'https://identity.example.com',
    FUORI_STUDIO_OIDC_CLIENT_ID: 'test-client', FUORI_STUDIO_OIDC_CLIENT_SECRET: 'fixture-secret',
    FUORI_STUDIO_OWNER_SUBJECT: 'owner-subject', FUORI_STUDIO_MASTER_KEY: key, FUORI_STUDIO_DATA_DIR: directory,
    FUORI_STUDIO_CODEX_BIN: join(directory, 'intentionally-unavailable-codex'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', errors = ''; child.stdout.on('data', bytes => log += bytes); child.stderr.on('data', bytes => errors += bytes);
  const exited = once(child, 'exit'); let stopped = false;
  async function stop() { if (!stopped) { stopped = true; if (child.exitCode === null) child.kill('SIGTERM'); await exited; } }
  t.after(async () => { await stop(); await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; !log.includes('Fuori Studio') && i < 200; i++) {
    if (child.exitCode !== null) throw Error(errors);
    await new Promise(done => setTimeout(done, 20));
  }
  assert.match(log, /Fuori Studio/, errors);
  async function request(path, { payload, owner = false, headers = {}, status = 200, method = payload === undefined ? 'GET' : 'POST' } = {}) {
    const response = await new Promise((done, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers: {
        Host: 'studio.example.com', ...(payload === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(owner ? { Cookie: `__Host-fuori_session=${sessionToken}`, Origin: 'https://studio.example.com', 'X-CSRF-Token': csrf } : {}), ...headers,
      } }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => done({ status: res.statusCode, headers: res.headers, bytes: Buffer.concat(chunks) }));
      }); req.on('error', reject); req.end(payload === undefined ? undefined : JSON.stringify(payload));
    });
    assert.equal(response.status, status, `${path}: ${response.bytes.toString().slice(0, 500)}`);
    assert.equal(response.headers['cache-control'], 'no-store');
    return JSON.parse(response.bytes.toString());
  }
  const payload = { id: 'radar', name: 'Research partner', expectedVersion: 1 };
  await request('/api/team', { status: 401 });
  await request('/api/team', { payload, status: 401 });
  const initial = await request('/api/team', { owner: true });
  assert.equal(initial.version, 1); assert.equal(initial.names.radar, 'Raffaele');
  assert.deepEqual(Object.keys(initial.names).sort(), ['forge', 'growth', 'muse', 'nova', 'radar']);
  const pairing = await request('/api/devices', { owner: true, payload: { action: 'pair', payload: { name: 'Team fixture device', scopeIds: ['business'], capabilities: ['repository'] } } });
  const device = await request('/api/device/pair', { payload: { code: pairing.code } });
  const deviceHeaders = { Authorization: `Bearer ${device.token}` };
  await request('/api/team', { headers: deviceHeaders, status: 401 });
  await request('/api/team', { headers: deviceHeaders, payload, status: 401 });
  await request('/api/team', { owner: true, payload, headers: { 'X-CSRF-Token': '' }, status: 403 });
  await request('/api/team', { owner: true, payload, headers: { Origin: 'https://other.example.com' }, status: 403 });
  assert.deepEqual(await request('/api/team', { owner: true }), initial);
  const renamed = await request('/api/team', { owner: true, payload });
  assert.equal(renamed.version, 2); assert.equal(renamed.names.radar, payload.name); assert.equal(renamed.names.forge, initial.names.forge);
  await request('/api/team', { owner: true, payload: { id: 'forge', name: 'Developer', expectedVersion: 1 }, status: 409 });
  await request('/api/team', { owner: true, payload: { id: 'unknown', name: 'Unknown', expectedVersion: 2 }, status: 400 });
  await request('/api/team', { owner: true, payload: { id: 'forge', name: 'RESEARCH PARTNER', expectedVersion: 2 }, status: 400 });
  await request('/api/team', { owner: true, payload: { id: 'forge', name: 'Developer', expectedVersion: 2, role: 'leader' }, status: 400 });
  assert.deepEqual(await request('/api/team', { owner: true }), renamed);
  const governance = await request('/api/governance', { owner: true }); assert.equal(governance.daily.calls, 0);
  for (const secret of [key, sessionToken, csrf, device.token, 'fixture-secret']) assert.equal(JSON.stringify(renamed).includes(secret), false);
  await stop();
  const persisted = createArchive({ directory, masterKey: key, mode: 'hybrid' });
  try { assert.deepEqual(await persisted.read('team-profiles'), { schemaVersion: 1, version: 2, names: renamed.names }); }
  finally { await persisted.close(); }
});
