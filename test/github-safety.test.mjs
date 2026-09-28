import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHub } from '../lib/github.ts';

const blobHash = text => createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
const token = 'ghp_' + 'a'.repeat(32), base = '1'.repeat(40), baseTree = '2'.repeat(40), resultTree = '3'.repeat(40), resultCommit = '4'.repeat(40);
const original = 'before\n', replacement = 'after\n', originalSha = blobHash(original);
const patch = `diff --git a/a.txt b/a.txt\nindex ${originalSha}..${blobHash(replacement)} 100644\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-before\n+after\n`;
const response = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

async function fixture({ onTree, failure, entries } = {}) {
  const records = new Map(), calls = [], state = { authorized: true, scopeActive: true }, refs = new Map();
  const run = { id: 'reviewed-run', version: 4, scopeId: 'business', title: 'Reviewed fix', baseCommit: base, patchHash: createHash('sha256').update(patch).digest('hex'), patch, files: [{ path: 'a.txt', status: 'M', additions: 1, deletions: 1 }], checks: [{ status: 'passed', exitCode: 0 }] };
  const service = createGitHub({
    storage: { read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), write: async (key, value) => records.set(key, structuredClone(value)) },
    workspace: { getSnapshot: async () => ({ scopes: [{ id: 'business', kind: state.scopeActive ? 'owned' : 'archive' }, { id: 'personal', kind: 'personal' }] }) },
    approvedRun: async () => { if (!state.authorized) throw Object.assign(Error('Human approval was withdrawn'), { code: 'REVIEW_REQUIRED' }); return structuredClone(run); },
    transport: async (url, options) => {
      assert.equal(new URL(url).origin, 'https://api.github.com'); assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${token}`);
      const method = options.method || 'GET', path = new URL(url).pathname; calls.push({ method, path });
      if (failure) throw failure;
      if (path === '/repos/owner/project') return response({ full_name: 'owner/project', private: true, default_branch: 'main' });
      if (path === '/repos/owner/project/git/ref/heads/main') return response({ ref: 'refs/heads/main', object: { type: 'commit', sha: base } });
      if (path === `/repos/owner/project/git/commits/${base}`) return response({ sha: base, tree: { sha: baseTree }, parents: [] });
      if (path === '/repos/owner/project/commits/main') return response({ sha: base });
      if (path === `/repos/owner/project/git/trees/${baseTree}`) return response({ sha: baseTree, truncated: false, tree: entries || [{ path: 'a.txt', mode: '100644', type: 'blob', sha: originalSha }] });
      if (path === `/repos/owner/project/git/blobs/${originalSha}`) return response({ sha: originalSha, content: Buffer.from(original).toString('base64'), encoding: 'base64', size: Buffer.byteLength(original) });
      if (method === 'GET' && path.startsWith('/repos/owner/project/git/ref/heads/fuori-studio/')) { const branch = path.slice('/repos/owner/project/git/ref/heads/'.length); return refs.has(branch) ? response({ ref: `refs/heads/${branch}`, object: { type: 'commit', sha: refs.get(branch) } }) : response({}, 404); }
      if (method === 'POST' && path.endsWith('/git/trees')) { onTree?.(state); return response({ sha: resultTree }); }
      if (method === 'POST' && path.endsWith('/git/commits')) return response({ sha: resultCommit, tree: { sha: resultTree }, parents: [{ sha: base }] });
      throw Error(`Unexpected fixture operation: ${method} ${path}`);
    },
  });
  const connection = await service.save({ name: 'Private projects', token, scopeIds: ['business'], repositories: ['owner/project'], allowPublish: true });
  const preview = () => service.preview({ runId: run.id, connectionId: connection.id, repository: 'owner/project', baseBranch: 'main', title: run.title, body: 'Reviewed by owner.' });
  return { service, connection, preview, calls, state, records };
}

test('a connector cannot expose its token through public repository metadata or cross scope/repository grants', async () => {
  const { service, connection, calls } = await fixture();
  const initial = calls.length;
  await assert.rejects(service.save({ name: 'Misplaced credential', token, scopeIds: ['business'], repositories: [`owner/${token}`], allowPublish: false }), { code: 'GITHUB_SECRET' });
  await assert.rejects(service.inspect({ connectionId: connection.id, scopeId: 'personal', repository: 'owner/project' }), { code: 'GITHUB_SCOPE_DENIED' });
  await assert.rejects(service.inspect({ connectionId: connection.id, scopeId: 'business', repository: 'owner/other' }), { code: 'GITHUB_SCOPE_DENIED' });
  assert.equal(calls.length, initial);
  assert.equal(JSON.stringify(await service.snapshot()).includes(token), false);
});

test('scope or human approval withdrawn after the tree write prevents commit/branch/PR publication', async () => {
  for (const revoke of ['approval', 'scope']) {
    const { service, preview, calls, records } = await fixture({ onTree: state => { if (revoke === 'approval') state.authorized = false; else state.scopeActive = false; } });
    const item = await preview();
    await assert.rejects(service.publish({ id: item.id, expectedVersion: item.version }), { code: 'GITHUB_PUBLICATION_UNCERTAIN' });
    assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.path), ['/repos/owner/project/git/trees']);
    assert.equal(records.get('github').publications[0].status, 'uncertain');
  }
});

test('case collisions and file ancestors in the immutable base tree cannot be read or implicitly replaced', async () => {
  for (const [path, entries] of [
    ['A.TXT', [{ path: 'a.txt', mode: '100644', type: 'blob', sha: originalSha }]],
    ['parent/child.txt', [{ path: 'parent', mode: '100644', type: 'blob', sha: originalSha }]],
    ['link/file.txt', [{ path: 'link', mode: '120000', type: 'blob', sha: originalSha }]],
  ]) {
    const { service, connection, calls } = await fixture({ entries });
    await assert.rejects(service.readFile({ connectionId: connection.id, scopeId: 'business', repository: 'owner/project', ref: 'main', path }), { code: 'GITHUB_PATH_DENIED' });
    assert.equal(calls.some(call => call.path.includes('/git/blobs/')), false);
    assert.equal(calls.some(call => call.method === 'POST'), false);
  }
});

test('untrusted transport errors never leak credentials even with a GitHub-looking error code', async () => {
  const failure = Object.assign(Error(`Authorization failed for Bearer ${token}`), { code: 'GITHUB_TRANSPORT' });
  const { service, connection } = await fixture({ failure });
  await assert.rejects(service.inspect({ connectionId: connection.id, scopeId: 'business', repository: 'owner/project' }), error => {
    assert.equal(String(error.message).includes(token), false); assert.equal(error.code, 'GITHUB_TRANSPORT'); return true;
  });
});

test('a second connector cannot persist another connector credential in public metadata or poison the archive', async () => {
  const records = new Map(), secret = 'private_token_alpha_123456789', another = 'private_token_beta_123456789';
  const service = createGitHub({
    storage: { read: async (key, fallback) => structuredClone(records.get(key) ?? fallback), write: async (key, value) => records.set(key, structuredClone(value)) },
    workspace: { getSnapshot: async () => ({ scopes: [{ id: 'business', kind: 'owned' }] }) },
    approvedRun: async () => { throw Error('No execution expected'); }, transport: async () => { throw Error('No API request expected'); },
  });
  await service.save({ name: 'First', token: secret, scopeIds: ['business'], repositories: ['owner/project'], allowPublish: false });
  await assert.rejects(service.save({ name: `Accidental ${secret}`, token: another, scopeIds: ['business'], repositories: ['owner/project'], allowPublish: false }));
  const state = await service.snapshot();
  assert.equal(state.connections.length, 1); assert.equal(JSON.stringify(state).includes(secret), false);
});
