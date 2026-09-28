import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { createArchive } from '../lib/archive.mjs';

test('hosted setup and encrypted backup require owner access, preserve CSRF and expose no restore endpoint', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-setup-http-'));
  const key = randomBytes(32).toString('base64');
  const sessionToken = randomBytes(32).toString('base64url'), csrf = randomBytes(32).toString('base64url');
  const digest = value => createHash('sha256').update(value).digest('hex');
  const marker = `private-owner-note-${randomBytes(24).toString('hex')}`;
  const archive = createArchive({ directory, masterKey: key, mode: 'hybrid' }), now = Date.now();
  await archive.write('identity', { version: 1, generation: 0, flows: [], sessions: [{
    id: 'setup-owner-session', tokenHash: digest(sessionToken),
    principal: digest(JSON.stringify(['https://identity.example.com/', 'test-client', 'owner-subject'])),
    name: 'Owner', csrfToken: csrf, createdAt: now, lastSeenAt: now, expiresAt: now + 3600000,
  }] });
  await archive.write('setup-test-private-note', { text: marker });
  await archive.close();
  const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(done => probe.close(done));
  const child = spawn(process.execPath, ['server.mjs'], { cwd: resolve('.'), env: {
    ...process.env, PORT: String(port), FUORI_STUDIO_MODE: 'hybrid', FUORI_STUDIO_BIND: '127.0.0.1',
    FUORI_STUDIO_PUBLIC_URL: 'https://studio.example.com', FUORI_STUDIO_OIDC_ISSUER: 'https://identity.example.com',
    FUORI_STUDIO_OIDC_CLIENT_ID: 'test-client', FUORI_STUDIO_OIDC_CLIENT_SECRET: 'fixture-secret',
    FUORI_STUDIO_OWNER_SUBJECT: 'owner-subject', FUORI_STUDIO_MASTER_KEY: key, FUORI_STUDIO_DATA_DIR: directory,
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '', errors = ''; child.stdout.on('data', bytes => log += bytes); child.stderr.on('data', bytes => errors += bytes);
  const exited = once(child, 'exit');
  t.after(async () => { if (child.exitCode === null) child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); });
  for (let i = 0; !log.includes('Fuori Studio') && i < 200; i++) {
    if (child.exitCode !== null) throw Error(errors);
    await new Promise(done => setTimeout(done, 20));
  }
  assert.match(log, /Fuori Studio/, errors);
  async function request(path, { payload, owner = false, headers = {}, status = 200, method = payload === undefined ? 'GET' : 'POST', binary = false } = {}) {
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
    return binary ? response : JSON.parse(response.bytes.toString());
  }

  assert.deepEqual(await request('/healthz'), { ok: true });
  await request('/healthz', { headers: { Host: 'other.example.com' }, status: 403 });
  for (const path of ['/api/setup', '/api/maintenance/backup?id=not-an-id']) await request(path, { status: 401 });
  const setup = await request('/api/setup', { owner: true });
  assert.equal(setup.mode, 'hybrid'); assert.equal(setup.publicUrl, 'https://studio.example.com');
  assert.equal(setup.storage.encrypted, true); assert.equal(setup.storage.keySource, 'environment');
  assert.equal(setup.checks.find(check => check.id === 'identity').status, 'ready');
  assert.equal(setup.checks.find(check => check.id === 'https').status, 'unknown');
  assert.equal(setup.maintenance.lastVerification, null); assert.deepEqual(setup.maintenance.backups, []);
  assert.equal(JSON.stringify(setup).includes(key), false); assert.equal(JSON.stringify(setup).includes(marker), false);

  const pairing = await request('/api/devices', { owner: true, payload: { action: 'pair', payload: { name: 'Setup fixture', scopeIds: ['business'], capabilities: ['repository'] } } });
  const device = await request('/api/device/pair', { payload: { code: pairing.code } });
  const deviceHeaders = { Authorization: `Bearer ${device.token}` };
  await request('/api/setup', { headers: deviceHeaders, status: 401 });
  await request('/api/maintenance', { headers: deviceHeaders, payload: { action: 'backup' }, status: 401 });
  await request('/api/maintenance', { owner: true, payload: { action: 'backup' }, headers: { 'X-CSRF-Token': '' }, status: 403 });
  await request('/api/maintenance', { owner: true, payload: { action: 'backup' }, headers: { Origin: 'https://other.example.com' }, status: 403 });
  const verified = await request('/api/maintenance', { owner: true, payload: { action: 'verify' } });
  assert.equal(verified.maintenance.lastVerification.ok, true); assert.ok(verified.maintenance.lastVerification.records > 1);
  assert.ok(Number.isFinite(Date.parse(verified.maintenance.lastVerification.verifiedAt)));
  assert.equal(verified.checks.find(check => check.id === 'integrity').status, 'ready');
  const backed = await request('/api/maintenance', { owner: true, payload: { action: 'backup' } });
  assert.equal(backed.maintenance.backups.length, 1);
  const backup = backed.maintenance.backups[0];
  assert.ok(Number.isFinite(Date.parse(backup.verifiedAt))); assert.ok(backup.records > 1);
  assert.match(backup.sha256, /^[a-f0-9]{64}$/);
  assert.equal(backed.checks.find(check => check.id === 'backup').status, 'ready');
  const downloadPath = `/api/maintenance/backup?id=${backup.id}`;
  await request(downloadPath, { status: 401 }); await request(downloadPath, { headers: deviceHeaders, status: 401 });
  const download = await request(downloadPath, { owner: true, binary: true });
  assert.equal(download.headers['content-type'], 'application/octet-stream');
  assert.equal(download.headers['cache-control'], 'no-store');
  assert.equal(download.headers['content-disposition'], `attachment; filename="${backup.filename}"`);
  assert.equal(download.bytes.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(download.bytes.length, backup.bytes); assert.equal(digest(download.bytes), backup.sha256);
  assert.deepEqual(download.bytes, await readFile(join(directory, 'backups', backup.filename)));
  for (const secret of [marker, key, sessionToken, csrf, 'fixture-secret', device.token]) assert.equal(download.bytes.includes(Buffer.from(secret)), false);
  for (const id of ['../../archive.sqlite', '', backup.filename]) await request(`/api/maintenance/backup?id=${encodeURIComponent(id)}`, { owner: true, status: 400 });
  await request('/api/maintenance/backup?id=00000000-0000-4000-8000-000000000000', { owner: true, status: 404 });
  for (const action of ['restore', 'delete']) await request('/api/maintenance', { owner: true, payload: { action, id: backup.id }, status: 400 });
  await request('/api/maintenance/restore', { owner: true, payload: { id: backup.id }, status: 404 });
  await request(downloadPath, { owner: true, method: 'DELETE', status: 403 });
  assert.equal((await request('/api/setup', { owner: true })).maintenance.backups.length, 1);
});
