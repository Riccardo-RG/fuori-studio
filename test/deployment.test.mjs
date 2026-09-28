import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { deploymentSnapshot, loadSecretEnvironment } from '../lib/deployment.ts';

test('secret mounts are bounded, atomic, non-symlink and never echoed in diagnostics', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-secret-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'key'); await writeFile(file, 'private-secret\n');
  const env = { FUORI_STUDIO_MASTER_KEY_FILE: file }; await loadSecretEnvironment(env); assert.equal(env.FUORI_STUDIO_MASTER_KEY, 'private-secret');
  await assert.rejects(loadSecretEnvironment(env), /Configura solo/);
  await symlink(file, join(directory, 'link')); await assert.rejects(loadSecretEnvironment({ FUORI_STUDIO_MASTER_KEY_FILE: join(directory, 'link') }), /non è un segreto/);
  const invalid = { FUORI_STUDIO_MASTER_KEY_FILE: file, FUORI_STUDIO_OIDC_CLIENT_SECRET_FILE: directory };
  await assert.rejects(loadSecretEnvironment(invalid)); assert.equal(invalid.FUORI_STUDIO_MASTER_KEY, undefined);
  const json = JSON.stringify(deploymentSnapshot({ env })); assert.ok(!json.includes('private-secret')); assert.ok(!json.includes(file));
});

test('readiness distinguishes configured identity, authenticated owner and unverified external TLS', () => {
  const env = { FUORI_STUDIO_MODE: 'hybrid', FUORI_STUDIO_PUBLIC_URL: 'https://studio.example.com', FUORI_STUDIO_OIDC_ISSUER: 'https://id.example.com', FUORI_STUDIO_OIDC_CLIENT_ID: 'id', FUORI_STUDIO_OIDC_CLIENT_SECRET: 'secret', FUORI_STUDIO_OWNER_SUBJECT: 'owner' };
  const report = deploymentSnapshot({ env, storage: { encrypted: true, keySource: 'environment' }, authenticated: true, workers: [{ online: true, repositories: [{}] }], maintenance: { backups: [{ verifiedAt: '2026-09-28' }], lastVerification: { verifiedAt: '2026-09-28', records: 3 } } });
  const check = id => report.checks.find(item => item.id === id);
  assert.equal(check('https').status, 'unknown'); assert.equal(check('identity').status, 'ready'); assert.equal(report.workers.repositoryReady, 1);
  assert.equal(deploymentSnapshot({ env }).checks.find(item => item.id === 'identity').status, 'unknown');
  assert.equal(deploymentSnapshot({ nodeVersion: '12.0.0', env: {} }).checks[0].status, 'action');
  assert.equal(deploymentSnapshot({ env: { ...env, FUORI_STUDIO_PUBLIC_URL: 'https://secret@bad.example/path' } }).publicUrl, null);
});
