import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitHub } from '../lib/github.ts';
import { createArchive } from '../lib/archive.mjs';

const base = 'a'.repeat(40), baseTree = 'b'.repeat(40), token = 'github_pat_' + 'S'.repeat(40);
const blobHash = text => { const bytes = Buffer.from(text); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
const digest = text => createHash('sha256').update(text).digest('hex');
const oldText = 'const value = 1;\n', newText = 'const value = 2;\n';
const patch = `diff --git a/app.js b/app.js\nindex ${blobHash(oldText)}..${blobHash(newText)} 100644\n--- a/app.js\n+++ b/app.js\n@@ -1 +1 @@\n-const value = 1;\n+const value = 2;\n`;
const files = [{ path: 'app.js', status: 'M', additions: 1, deletions: 1 }];
function memoryStorage() { const data = new Map(); return { data, read: async (key, fallback = null) => structuredClone(data.has(key) ? data.get(key) : fallback), write: async (key, value) => { data.set(key, structuredClone(value)); } }; }

function mockGitHub() {
  const branches = new Map([['main', base]]), commits = new Map([[base, { sha: base, tree: { sha: baseTree }, parents: [] }]]);
  const trees = new Map([[baseTree, [{ path: 'app.js', mode: '100644', type: 'blob', sha: blobHash(oldText) }]]]);
  const blobs = new Map([[blobHash(oldText), oldText]]), pulls = [], requests = []; let fault, transform;
  const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const transport = async (input, options) => {
    const url = new URL(input); assert.equal(url.origin, 'https://api.github.com'); assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Authorization, `Bearer ${token}`); assert.equal(options.headers['X-GitHub-Api-Version'], '2026-03-10');
    const method = options.method || 'GET', path = decodeURIComponent(url.pathname.replace('/repos/owner/product', ''));
    const body = options.body ? JSON.parse(options.body) : null; requests.push({ method, path, body, query: url.searchParams });
    const trigger = fault && fault.method === method && fault.path === path ? fault : null; if (trigger) fault = null;
    if (trigger?.when === 'before') { if (trigger.status) return response({ message: token }, trigger.status); throw Error(`Network failed with secret ${token}`); }
    let result, status = 200;
    if (method === 'GET' && path === '') result = { full_name: 'owner/product', private: true, default_branch: 'main', archived: false };
    else if (method === 'GET' && path.startsWith('/git/ref/heads/')) { const name = path.slice('/git/ref/heads/'.length); result = branches.has(name) ? { ref: 'refs/heads/' + name, object: { type: 'commit', sha: branches.get(name) } } : null; }
    else if (method === 'GET' && path.startsWith('/commits/')) { const ref = path.slice('/commits/'.length), commit = branches.get(ref) || ref; result = commits.get(commit) || null; }
    else if (method === 'GET' && path.startsWith('/git/commits/')) result = commits.get(path.slice('/git/commits/'.length)) || null;
    else if (method === 'GET' && path.startsWith('/git/trees/')) { const sha = path.slice('/git/trees/'.length); result = trees.has(sha) ? { sha, truncated: false, tree: trees.get(sha) } : null; }
    else if (method === 'GET' && path.startsWith('/git/blobs/')) { const sha = path.slice('/git/blobs/'.length), text = blobs.get(sha); result = text === undefined ? null : { sha, encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64') }; }
    else if (method === 'POST' && path === '/git/trees') {
      assert.equal(body.base_tree, baseTree); const entries = structuredClone(trees.get(body.base_tree));
      for (const item of body.tree) { const index = entries.findIndex(entry => entry.path === item.path); if (item.sha === null) { assert.ok(index >= 0); entries.splice(index, 1); } else { const sha = blobHash(item.content); blobs.set(sha, item.content); const entry = { path: item.path, type: 'blob', mode: item.mode, sha }; if (index >= 0) entries[index] = entry; else entries.push(entry); } }
      const sha = digest(JSON.stringify(entries)).slice(0, 40); trees.set(sha, entries); result = { sha, tree: entries, truncated: false }; status = 201;
    } else if (method === 'POST' && path === '/git/commits') {
      const sha = digest(JSON.stringify(body)).slice(0, 40); result = { sha, tree: { sha: body.tree }, parents: body.parents.map(sha => ({ sha })), message: body.message }; commits.set(sha, result); status = 201;
    } else if (method === 'POST' && path === '/git/refs') {
      const name = body.ref.replace('refs/heads/', ''); assert.notEqual(name, 'main'); if (branches.has(name)) return response({ message: 'Reference already exists' }, 422);
      branches.set(name, body.sha); result = { ref: body.ref, object: { type: 'commit', sha: body.sha } }; status = 201;
    } else if (method === 'GET' && path === '/pulls') { const name = url.searchParams.get('head').slice('owner:'.length); result = pulls.filter(pr => pr.head.ref === name && pr.base.ref === url.searchParams.get('base')); }
    else if (method === 'POST' && path === '/pulls') {
      assert.equal(body.draft, true); assert.equal(body.maintainer_can_modify, false);
      result = { number: pulls.length + 1, title: body.title, body: body.body, draft: true, head: { ref: body.head, sha: branches.get(body.head), repo: { full_name: 'owner/product' } }, base: { ref: body.base, sha: branches.get(body.base), repo: { full_name: 'owner/product' } } };
      pulls.push(result); status = 201;
    } else throw Error(`Unimplemented mock endpoint ${method} ${path}`);
    if (trigger?.when === 'after') throw Error(`Receipt lost ${token}`);
    if (transform) result = transform({ method, path, result });
    return result === null ? response({ message: 'Not found' }, 404) : response(result, status);
  };
  return { transport, branches, commits, trees, blobs, pulls, requests, fault: value => { fault = value; }, transform: value => { transform = value; }, writes: () => requests.filter(item => item.method !== 'GET') };
}
async function fixture(storage = memoryStorage()) {
  const api = mockGitHub(); let approved = true, availableScopes = ['development', 'personal'];
  const run = { id: 'run-1', version: 3, scopeId: 'development', title: 'Fix value', baseCommit: base, patchHash: digest(patch), patch, files: structuredClone(files), checks: [{ status: 'passed', exitCode: 0, truncated: false }] };
  const options = { storage, workspace: { getSnapshot: async () => ({ scopes: availableScopes.map(id => ({ id, kind: 'project' })) }) }, approvedRun: async ({ id }) => { if (!approved || id !== run.id) throw Object.assign(Error('Review required'), { code: 'REPOSITORY_REVIEW_REQUIRED' }); return structuredClone(run); }, transport: api.transport };
  const hub = createGitHub(options);
  const connection = await hub.save({ name: 'Product GitHub', token, scopeIds: ['development'], repositories: ['Owner/Product'], allowPublish: true });
  const preview = () => hub.preview({ runId: 'run-1', connectionId: connection.id, repository: 'owner/product', baseBranch: 'main', title: 'Fix value', body: 'Change value after real checks and human approval.' });
  return { api, hub, run, connection, preview, storage, restart: () => createGitHub(options), approve: value => { approved = value; }, scopes: value => { availableScopes = value; } };
}

test('GitHub credentials are write-only, scoped, optimistic and disconnected without any API writes', async () => {
  const f = await fixture(); assert.equal(f.connection.tokenConfigured, true); assert.equal(JSON.stringify(await f.hub.snapshot()).includes(token), false);
  assert.equal(f.api.requests.length, 0);
  for (const input of [{ scopeId: 'personal', repository: 'owner/product' }, { scopeId: 'development', repository: 'owner/other' }]) await assert.rejects(f.hub.inspect({ connectionId: f.connection.id, ...input }), { code: 'GITHUB_SCOPE_DENIED' });
  assert.equal(f.api.requests.length, 0);
  assert.deepEqual(await f.hub.inspect({ connectionId: f.connection.id, scopeId: 'development', repository: 'Owner/Product' }), { repository: 'owner/product', private: true, defaultBranch: 'main', archived: false, url: 'https://github.com/owner/product' });
  await assert.rejects(f.hub.save({ ...f.connection, expectedVersion: 9, name: 'Stale' }), { code: 'GITHUB_CONFLICT' });
  const changed = await f.hub.save({ ...f.connection, expectedVersion: 1, name: 'Read only', allowPublish: false });
  await assert.rejects(f.preview(), { code: 'GITHUB_WRITE_DENIED' });
  await f.hub.disconnect({ id: changed.id, expectedVersion: changed.version });
  await assert.rejects(f.hub.inspect({ connectionId: changed.id, scopeId: 'development', repository: 'owner/product' }), { code: 'GITHUB_SCOPE_DENIED' });
  assert.equal(f.api.writes().length, 0);
});

test('GitHub token and reconstructed candidate are stored in the encrypted archive, never public snapshot', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-github-')); const storage = createArchive({ directory, mode: 'local' });
  t.after(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const f = await fixture(storage); await f.preview(); const snapshot = await f.hub.snapshot();
  assert.equal(JSON.stringify(snapshot).includes(token), false); assert.equal(JSON.stringify(snapshot).includes(newText), false);
  const bytes = await readFile(join(directory, 'studio.sqlite')); assert.equal(bytes.includes(Buffer.from(token)), false); assert.equal(bytes.includes(Buffer.from(newText)), false);
});

test('private file reads resolve immutable commit and authenticate blob bytes, with no credential or path shortcuts', async () => {
  const f = await fixture(), input = { connectionId: f.connection.id, scopeId: 'development', repository: 'owner/product', ref: 'main', path: 'app.js' };
  assert.deepEqual(await f.hub.readFile(input), { text: oldText, commit: base, blobSha: blobHash(oldText), path: 'app.js', repository: 'owner/product', url: `https://github.com/owner/product/blob/${base}/app.js` });
  for (const path of ['../app.js', '.env', '.ssh/key', 'auth.json']) await assert.rejects(f.hub.readFile({ ...input, path }), { code: 'GITHUB_PATH_DENIED' });
  f.api.blobs.set(blobHash(oldText), 'changed'); await assert.rejects(f.hub.readFile(input), { code: 'GITHUB_RESPONSE_INVALID' });
  assert.equal(f.api.writes().length, 0);
});

test('private reads reject symlinks, truncated trees, case collisions and recognizable credentials', async () => {
  const inputFor = f => ({ connectionId: f.connection.id, scopeId: 'development', repository: 'owner/product', ref: 'main', path: 'app.js' });
  const link = await fixture(); link.api.trees.get(baseTree)[0].mode = '120000'; await assert.rejects(link.hub.readFile(inputFor(link)), { code: 'GITHUB_PATH_DENIED' });
  const folded = await fixture(); folded.api.trees.get(baseTree).push({ ...folded.api.trees.get(baseTree)[0], path: 'App.js' }); await assert.rejects(folded.hub.readFile(inputFor(folded)), { code: 'GITHUB_PATH_DENIED' });
  const truncated = await fixture(); truncated.api.transform(({ path, result }) => path.startsWith('/git/trees/') ? { ...result, truncated: true } : result); await assert.rejects(truncated.hub.readFile(inputFor(truncated)), { code: 'GITHUB_RESPONSE_INVALID' });
  const secret = await fixture(); const sha = blobHash(token); secret.api.trees.get(baseTree)[0].sha = sha; secret.api.blobs.set(sha, token); await assert.rejects(secret.hub.readFile(inputFor(secret)), { code: 'GITHUB_SECRET' });
});

test('preview performs reads only and publication sends the reviewed patch through a new branch and draft PR', async () => {
  const f = await fixture(), publication = await f.preview(); assert.equal(publication.status, 'preview'); assert.equal(f.api.writes().length, 0);
  const candidate = await f.storage.read(`github/candidate/${publication.id}`); assert.equal(candidate.entries[0].content, newText);
  const published = await f.hub.publish({ id: publication.id, expectedVersion: publication.version });
  assert.equal(published.status, 'published'); assert.equal(published.url, 'https://github.com/owner/product/pull/1');
  assert.deepEqual(f.api.writes().map(item => item.path), ['/git/trees', '/git/commits', '/git/refs', '/pulls']);
  assert.equal(f.api.writes()[0].body.tree[0].content, newText); assert.equal(f.api.branches.get('main'), base);
  assert.equal(f.api.pulls[0].body, publication.body); assert.equal(f.api.pulls[0].draft, true);
  const count = f.api.writes().length; assert.equal((await f.hub.publish({ id: published.id, expectedVersion: published.version })).url, published.url); assert.equal(f.api.writes().length, count);
});

test('human approval, exact run version, current base and connection permission are rechecked before writes', async () => {
  const unapproved = await fixture(); unapproved.approve(false); await assert.rejects(unapproved.preview(), { code: 'REPOSITORY_REVIEW_REQUIRED' }); assert.equal(unapproved.api.requests.length, 0);
  for (const mutation of [f => { f.run.version++; }, f => { f.api.branches.set('main', 'c'.repeat(40)); }, f => { f.run.checks[0].status = 'failed'; }, f => { f.scopes(['personal']); }]) {
    const f = await fixture(), publication = await f.preview(); mutation(f); await assert.rejects(f.hub.publish({ id: publication.id, expectedVersion: 1 })); assert.equal(f.api.writes().length, 0);
  }
  const permissions = await fixture(), publication = await permissions.preview(); await permissions.hub.save({ ...permissions.connection, expectedVersion: 1, allowPublish: false });
  await assert.rejects(permissions.hub.publish({ id: publication.id, expectedVersion: 1 }), { code: 'GITHUB_WRITE_DENIED' }); assert.equal(permissions.api.writes().length, 0);
});

test('multiple prepared previews cannot publish the same reviewed run twice', async () => {
  const f = await fixture(), first = await f.preview(), second = await f.preview(); await f.hub.publish({ id: first.id, expectedVersion: 1 });
  await assert.rejects(f.hub.publish({ id: second.id, expectedVersion: 1 }), { code: 'GITHUB_PUBLICATION_EXISTS' }); assert.equal(f.api.pulls.length, 1);
});

test('lost successful PR receipt reconciles after restart using only reads and cannot duplicate the PR', async () => {
  const f = await fixture(), publication = await f.preview(); f.api.fault({ method: 'POST', path: '/pulls', when: 'after' });
  await assert.rejects(f.hub.publish({ id: publication.id, expectedVersion: 1 }), { code: 'GITHUB_PUBLICATION_UNCERTAIN' }); assert.equal(f.api.pulls.length, 1);
  const restored = f.restart(), current = (await restored.snapshot()).publications[0], before = f.api.writes().length;
  await assert.rejects(restored.publish({ id: current.id, expectedVersion: current.version }), { code: 'GITHUB_RECONCILE_REQUIRED' });
  const settled = await restored.reconcile({ id: current.id, expectedVersion: current.version }); assert.equal(settled.status, 'published'); assert.equal(settled.url, 'https://github.com/owner/product/pull/1'); assert.equal(f.api.writes().length, before);
});

test('ambiguous absent PR is not recreated; branch-stage receipt recovery permits an explicit first PR request', async () => {
  const absent = await fixture(), first = await absent.preview(); absent.api.fault({ method: 'POST', path: '/pulls', when: 'before' });
  await assert.rejects(absent.hub.publish({ id: first.id, expectedVersion: 1 })); let current = (await absent.hub.snapshot()).publications[0]; const count = absent.api.writes().length;
  current = await absent.hub.reconcile({ id: current.id, expectedVersion: current.version }); assert.equal(current.status, 'uncertain');
  await assert.rejects(absent.hub.publish({ id: current.id, expectedVersion: current.version }), { code: 'GITHUB_RECONCILE_REQUIRED' }); assert.equal(absent.api.writes().length, count);
  const branchLost = await fixture(), second = await branchLost.preview(); branchLost.api.fault({ method: 'POST', path: '/git/refs', when: 'after' });
  await assert.rejects(branchLost.hub.publish({ id: second.id, expectedVersion: 1 })); current = (await branchLost.hub.snapshot()).publications[0]; const prior = branchLost.api.writes().length;
  current = await branchLost.hub.reconcile({ id: current.id, expectedVersion: current.version }); assert.equal(current.status, 'preview'); assert.equal(branchLost.api.writes().length, prior);
  const done = await branchLost.hub.publish({ id: current.id, expectedVersion: current.version }); assert.equal(done.status, 'published'); assert.equal(branchLost.api.writes().filter(item => item.path === '/git/refs').length, 1); assert.equal(branchLost.api.pulls.length, 1);
});

test('known rejected PR can resume only after reconciliation and a new human confirmation', async () => {
  const f = await fixture(), publication = await f.preview(); f.api.fault({ method: 'POST', path: '/pulls', when: 'before', status: 403 });
  await assert.rejects(f.hub.publish({ id: publication.id, expectedVersion: 1 })); let current = (await f.hub.snapshot()).publications[0];
  assert.equal(JSON.stringify(current).includes(token), false); current = await f.hub.reconcile({ id: current.id, expectedVersion: current.version }); assert.equal(current.status, 'preview');
  assert.equal((await f.hub.publish({ id: current.id, expectedVersion: current.version })).status, 'published'); assert.equal(f.api.pulls.length, 1);
});

test('uncertain tree write and interrupted process recover conservatively without external mutations', async () => {
  const f = await fixture(), publication = await f.preview(); f.api.fault({ method: 'POST', path: '/git/trees', when: 'after' });
  await assert.rejects(f.hub.publish({ id: publication.id, expectedVersion: 1 })); let current = (await f.hub.snapshot()).publications[0];
  const before = f.api.writes().length; current = await f.hub.reconcile({ id: current.id, expectedVersion: current.version }); assert.equal(current.status, 'preview'); assert.equal(f.api.writes().length, before);
  const state = await f.storage.read('github'); state.publications[0].status = 'publishing'; await f.storage.write('github', state);
  const restored = f.restart(); await restored.recover(); assert.equal((await restored.snapshot()).publications[0].status, 'uncertain'); assert.equal(f.api.writes().length, before);
});

test('a foreign branch or changed published commit cannot be overwritten or called reconciled', async () => {
  const f = await fixture(), publication = await f.preview(); f.api.branches.set(publication.branch, 'f'.repeat(40));
  await assert.rejects(f.hub.publish({ id: publication.id, expectedVersion: 1 }), { code: 'GITHUB_PUBLICATION_CONFLICT' }); assert.equal(f.api.writes().length, 0);
  const lost = await fixture(), next = await lost.preview(); lost.api.fault({ method: 'POST', path: '/pulls', when: 'after' }); await assert.rejects(lost.hub.publish({ id: next.id, expectedVersion: 1 }));
  lost.api.branches.set(next.branch, 'f'.repeat(40)); const current = (await lost.hub.snapshot()).publications[0], writes = lost.api.writes().length;
  await assert.rejects(lost.hub.reconcile({ id: current.id, expectedVersion: current.version }), { code: 'GITHUB_PUBLICATION_CONFLICT' }); assert.equal(lost.api.writes().length, writes);
});

test('altered candidate content and damaged state are refused before any write or public disclosure', async () => {
  const f = await fixture(), publication = await f.preview(), candidate = await f.storage.read(`github/candidate/${publication.id}`);
  candidate.entries[0].content = 'unreviewed change\n'; candidate.entries[0].newSha = blobHash(candidate.entries[0].content);
  await f.storage.write(`github/candidate/${publication.id}`, candidate);
  await assert.rejects(f.hub.publish({ id: publication.id, expectedVersion: 1 }), { code: 'GITHUB_CANDIDATE_CHANGED' }); assert.equal(f.api.writes().length, 0);
  const corrupted = await fixture(), state = await corrupted.storage.read('github'); state.connections[0].secretExtraField = token; await corrupted.storage.write('github', state);
  await assert.rejects(corrupted.hub.snapshot(), { code: 'GITHUB_CORRUPT' });
});

test('a destination branch advancing at PR creation is reported alongside the known created PR', async () => {
  const f = await fixture(), publication = await f.preview(); f.api.transform(({ method, path, result }) => method === 'POST' && path === '/pulls' ? { ...result, base: { ...result.base, sha: 'd'.repeat(40) } } : result);
  const published = await f.hub.publish({ id: publication.id, expectedVersion: 1 });
  assert.equal(published.status, 'published'); assert.equal(published.url, 'https://github.com/owner/product/pull/1'); assert.equal(published.baseCommit, base); assert.equal(published.actualBaseCommit, 'd'.repeat(40)); assert.equal(published.baseChanged, true); assert.match(published.error, /avanzato/);
  assert.equal((await f.hub.snapshot()).publications[0].baseChanged, true);
});
