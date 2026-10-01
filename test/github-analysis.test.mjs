import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createGitHub } from '../lib/github.ts';

const commit = 'a'.repeat(40), tree = 'b'.repeat(40), token = 'github_pat_' + 'T'.repeat(40);
const digest = value => { const bytes = Buffer.from(value); return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex'); };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
async function fixture(files = { 'README.md': '# Product\nArchitecture overview\n', 'package.json': '{"name":"product"}\n', 'server.mjs': 'export const app = 1;\n', 'docs/tokens.md': '# Tokens\nMeasured usage is reported by the provider.\n', 'test/token.test.mjs': 'assert.equal(usage, 2);\n' }, options = {}) {
  const data = new Map(), requests = [], blobs = new Map(), entries = [], directories = new Set(); let scopes = [{ id: 'project', kind: 'project' }], transform, intercept;
  const storage = { read: async (key, fallback) => structuredClone(data.has(key) ? data.get(key) : fallback), write: async (key, value) => { data.set(key, structuredClone(value)); } };
  for (const [path, content] of Object.entries(files)) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index++) directories.add(parts.slice(0, index).join('/'));
    const bytes = Buffer.from(content), sha = digest(bytes); blobs.set(sha, bytes);
    entries.push({ path, type: 'blob', mode: '100644', sha, size: bytes.length });
  }
  for (const path of directories) entries.push({ path, type: 'tree', mode: '040000', sha: tree });
  const transport = async (input, init) => {
    const url = new URL(input); assert.equal(url.origin, 'https://api.github.com'); assert.equal(init.method, 'GET'); assert.equal(init.body, undefined); assert.equal(init.redirect, 'error'); assert.equal(init.headers.Authorization, `Bearer ${token}`);
    requests.push({ path: url.pathname, search: url.search, signal: init.signal });
    if (intercept) { const response = await intercept(url, init); if (response !== undefined) return response; }
    let result;
    if (url.pathname === '/repos/owner/product') result = { full_name: 'owner/product', default_branch: 'main', private: true, archived: false };
    else if (url.pathname.startsWith('/repos/owner/product/commits/')) result = { sha: commit, html_url: 'https://attacker.invalid', secret: token };
    else if (url.pathname === `/repos/owner/product/git/commits/${commit}`) result = { sha: commit, tree: { sha: tree }, parents: [] };
    else if (url.pathname === `/repos/owner/product/git/trees/${tree}`) { assert.equal(url.search, '?recursive=1'); result = { sha: tree, tree: entries, truncated: false }; }
    else if (url.pathname.startsWith('/repos/owner/product/git/blobs/')) { const sha = url.pathname.split('/').at(-1), bytes = blobs.get(sha); assert.ok(bytes); result = { sha, size: bytes.length, encoding: 'base64', content: bytes.toString('base64'), url: 'https://attacker.invalid', secret: token }; }
    else assert.fail(`Unexpected mock route ${url.pathname}`);
    return json(transform ? transform(url, result) : result);
  };
  const hub = createGitHub({ storage, workspace: { getSnapshot: async () => ({ scopes }) }, approvedRun: async () => assert.fail('Analysis must not load approved runs'), transport, now: () => Date.parse('2026-10-01T12:00:00Z'), ...options });
  const connection = await hub.save({ name: 'Read only', token, scopeIds: ['project'], repositories: ['owner/product'], allowPublish: false });
  const input = { connectionId: connection.id, scopeId: 'project', repository: 'Owner/Product', query: 'Explain token architecture' };
  return { hub, input, connection, entries, blobs, requests, data, scan: changes => hub.scanRepository({ ...input, ...changes }), transform: value => { transform = value; }, intercept: value => { intercept = value; }, scopes: value => { scopes = value; } };
}

test('repository analysis is GET-only, commit-pinned, scoped, and exposes only bounded evidence fields', async () => {
  const f = await fixture(); const before = structuredClone([...f.data]);
  const result = await f.scan();
  assert.equal(result.repository, 'owner/product'); assert.equal(result.ref, 'main'); assert.equal(result.commit, commit); assert.equal(result.connectionVersion, 1);
  assert.equal(result.url, `https://github.com/owner/product/tree/${commit}`); assert.equal(result.capturedAt, '2026-10-01T12:00:00.000Z');
  assert.deepEqual(Object.keys(result).sort(), ['repository', 'ref', 'commit', 'connectionVersion', 'url', 'files', 'coverage', 'skipped', 'capturedAt'].sort());
  assert.equal(result.files.length, 5); assert.deepEqual(result.coverage, { treeEntries: 7, eligibleFiles: 5, readFiles: 5, omittedFiles: 0, treeTruncated: false });
  for (const file of result.files) {
    assert.deepEqual(Object.keys(file).sort(), ['path', 'blobSha', 'text', 'startLine', 'endLine', 'truncated', 'url'].sort());
    assert.equal(digest(file.text), file.blobSha); assert.equal(file.url, `https://github.com/owner/product/blob/${commit}/${file.path}#L1-L${file.endLine}`);
    assert.equal(file.endLine, file.text.split('\n').length);
  }
  assert.deepEqual([...f.data], before); assert.equal(JSON.stringify(result).includes(token), false); assert.equal(JSON.stringify(result).includes('attacker.invalid'), false);
  assert.equal(f.requests.filter(request => request.path.includes('/commits/main')).length, 1);
  assert.ok(f.requests.some(request => request.path === `/repos/owner/product/git/commits/${commit}`));
});

test('explicit slash refs are encoded once and exact commit requests cannot resolve to another commit', async () => {
  const f = await fixture(); const result = await f.scan({ ref: 'feature/tokens' });
  assert.equal(result.ref, 'feature/tokens'); assert.ok(f.requests.some(request => request.path.endsWith('/commits/feature%2Ftokens')));
  assert.equal(f.requests.some(request => request.path === '/repos/owner/product'), false);
  await assert.rejects(f.scan({ ref: 'c'.repeat(40) }), { code: 'GITHUB_RESPONSE_INVALID' });
  for (const ref of ['../main', 'main?x=1', 'https://attacker.invalid/main', 'feature/\u202emain', `feature/${token}`]) {
    const count = f.requests.length; await assert.rejects(f.scan({ ref })); assert.equal(f.requests.length, count);
  }
});

test('local analysis authorization revalidates connection version, repository, scope and revocation without network', async () => {
  const f = await fixture(); const auth = changes => f.hub.authorizeAnalysis({ ...f.input, ...changes });
  assert.deepEqual(await auth(), { connectionId: f.connection.id, version: 1, repository: 'owner/product' });
  await assert.rejects(auth({ expectedVersion: 2 }), { code: 'GITHUB_CONFLICT' });
  for (const changes of [{ scopeId: 'elsewhere' }, { repository: 'owner/other' }]) { await assert.rejects(auth(changes), { code: 'GITHUB_SCOPE_DENIED' }); await assert.rejects(f.scan(changes), { code: 'GITHUB_SCOPE_DENIED' }); }
  f.scopes([{ id: 'project', kind: 'archive' }]); await assert.rejects(auth(), { code: 'GITHUB_SCOPE_DENIED' }); f.scopes([{ id: 'project', kind: 'project' }]);
  const changed = await f.hub.save({ ...f.connection, expectedVersion: 1, name: 'Changed' });
  await assert.rejects(auth({ expectedVersion: 1 }), { code: 'GITHUB_CONFLICT' });
  await f.hub.disconnect({ id: changed.id, expectedVersion: changed.version });
  await assert.rejects(auth(), { code: 'GITHUB_SCOPE_DENIED' }); await assert.rejects(f.scan(), { code: 'GITHUB_SCOPE_DENIED' });
  assert.equal(f.requests.length, 0);
  const removed = await fixture(); await removed.hub.save({ ...removed.connection, expectedVersion: 1, repositories: ['owner/other'] });
  await assert.rejects(removed.hub.authorizeAnalysis(removed.input), { code: 'GITHUB_SCOPE_DENIED' });
  await assert.rejects(removed.scan(), { code: 'GITHUB_SCOPE_DENIED' }); assert.equal(removed.requests.length, 0);
});

test('protected or credential-bearing filenames are never exposed and symlinks, submodules, generated and binary files are not read', async () => {
  const f = await fixture({ 'README.md': '# Safe', '.env': 'SECRET=unknown', 'credentials.txt': 'private', '.ssh/private.txt': 'private', [`${token}.md`]: 'private', '../escape.md': 'private', 'bad\u202ename.md': 'private', 'dist/output.js': 'generated', 'image.png': 'binary', 'linked.md': 'link', 'submodule': 'submodule', 'large.txt': 'too large' });
  Object.assign(f.entries.find(entry => entry.path === 'linked.md'), { mode: '120000' });
  Object.assign(f.entries.find(entry => entry.path === 'submodule'), { mode: '160000', type: 'commit' });
  f.entries.find(entry => entry.path === 'large.txt').size = 1024 * 1024 + 1;
  const result = await f.scan(); assert.deepEqual(result.files.map(file => file.path), ['README.md']);
  for (const name of ['.env', 'credentials.txt', '.ssh', token, '../escape.md', 'bad\u202ename.md']) assert.equal(JSON.stringify(result).includes(name), false);
  assert.deepEqual(new Set(result.skipped.map(item => item.reason)), new Set(['unsupported', 'generated', 'binary', 'oversized']));
  assert.equal(f.requests.filter(request => request.path.includes('/git/blobs/')).length, 1);
});

test('full blob verification precedes excerpts, secrets outside the excerpt and binary or empty content are excluded', async () => {
  const f = await fixture({ 'README.md': 'Safe\n', 'configuration.md': 'x'.repeat(5000) + '\n' + token, 'binary.txt': Buffer.from([1, 0, 3]), 'invalid.txt': Buffer.from([255, 254]), 'empty.txt': '\n  \n', 'generated.ts': '// Code generated automatically. DO NOT EDIT\nexport const value = 1;' });
  const result = await f.scan(); assert.deepEqual(result.files.map(file => file.path), ['README.md']);
  assert.equal(result.skipped.find(item => item.path === 'configuration.md').reason, 'secret');
  assert.equal(JSON.stringify(result).includes(token), false); assert.equal(result.coverage.omittedFiles, 5);
  const altered = await fixture({ 'README.md': 'Original' }); altered.transform((url, value) => url.pathname.includes('/git/blobs/') ? { ...value, content: Buffer.from('Altered!').toString('base64'), size: 8 } : value);
  await assert.rejects(altered.scan(), { code: 'GITHUB_RESPONSE_INVALID' });
});

test('selection keeps architectural categories and query matches deterministic within file and character budgets', async () => {
  const files = { 'README.md': '# Overview\n' + 'x'.repeat(7000), 'package.json': '{"name":"product"}\n', 'main.ts': 'export const app = 1;', 'docs/design.md': 'Architecture\n' + 'y'.repeat(5000), 'test/app.test.ts': 'test("app")' };
  for (let index = 0; index < 50; index++) files[`src/${index === 49 ? 'token' : String(index).padStart(2, '0')}.ts`] = Array.from({ length: 200 }, (_, line) => `line${line}: ${line === 150 ? 'token usage implementation' : 'source code'}`).join('\n');
  const f = await fixture(files), first = await f.scan(), second = await f.scan(); assert.deepEqual(first, second);
  assert.equal(first.files.length, 12); assert.ok(first.files.reduce((sum, file) => sum + file.text.length, 0) <= 8000);
  for (const path of ['README.md', 'package.json', 'main.ts', 'docs/design.md', 'test/app.test.ts', 'src/token.ts']) assert.ok(first.files.some(file => file.path === path));
  for (const file of first.files) { assert.ok(file.text.length <= 2000); assert.equal(file.endLine - file.startLine + 1, file.text.split('\n').length); }
  const focused = first.files.find(file => file.path === 'src/token.ts'); assert.ok(focused.startLine > 1); assert.match(focused.text, /token usage implementation/); assert.equal(focused.truncated, true);
  assert.equal(first.coverage.omittedFiles, 43); assert.equal(first.skipped.filter(item => item.reason === 'limit').length, 43);
});

test('one MiB blob limit, response bounds and base64 validation apply before content can enter evidence', async () => {
  const maximum = await fixture({ 'README.md': 'x'.repeat(1024 * 1024) }), result = await maximum.scan();
  assert.equal(result.files.length, 1); assert.equal(result.files[0].text.length, 2000); assert.equal(result.files[0].truncated, true);
  const oversized = await fixture({ 'README.md': 'Safe' }); oversized.entries[0].size = undefined;
  oversized.transform((url, value) => url.pathname.includes('/git/blobs/') ? { ...value, size: 1024 * 1024 + 1 } : value);
  assert.deepEqual((await oversized.scan()).skipped, [{ path: 'README.md', reason: 'oversized' }]);
  const malformed = await fixture(); malformed.transform((url, value) => url.pathname.includes('/git/blobs/') ? { ...value, content: '*invalid*' } : value);
  await assert.rejects(malformed.scan(), { code: 'GITHUB_RESPONSE_INVALID' });
  const response = await fixture(); response.intercept(() => new Response('{}', { headers: { 'content-length': String(8 * 1024 * 1024 + 1) } }));
  await assert.rejects(response.scan(), { code: 'GITHUB_RESPONSE_LIMIT' });
});

test('truncated trees remain explicitly partial and oversized trees retain at most 4000 validated entries', async () => {
  const partial = await fixture({ 'README.md': '# Safe' }); partial.transform((url, value) => url.pathname.includes('/git/trees/') ? { ...value, truncated: true } : value);
  assert.equal((await partial.scan()).coverage.treeTruncated, true);
  const files = {}; for (let index = 0; index < 4100; index++) files[`file-${index}.txt`] = 'Safe';
  const oversized = await fixture(files), result = await oversized.scan();
  assert.equal(result.coverage.treeEntries, 4000); assert.equal(result.coverage.eligibleFiles, 4000); assert.equal(result.coverage.treeTruncated, true);
  assert.equal(result.files.length, 12); assert.equal(result.skipped.length, 100);
  const invalid = await fixture(); invalid.transform((url, value) => url.pathname.includes('/git/trees/') ? { ...value, truncated: true, tree: [...value.tree, { path: 'bad.ts', mode: '100644', type: 'blob', sha: 'invalid' }] } : value);
  await assert.rejects(invalid.scan(), { code: 'GITHUB_RESPONSE_INVALID' });
});

test('ambiguous names and invalid tree metadata cannot become evidence; missing ancestors and unsafe descendants are excluded', async () => {
  for (const paths of [['README.md', 'Readme.md'], ['caf\u00e9.md', 'cafe\u0301.md']]) {
    const f = await fixture(Object.fromEntries(paths.map(path => [path, 'Safe']))); await assert.rejects(f.scan(), { code: 'GITHUB_RESPONSE_INVALID' });
  }
  const missing = await fixture({ 'not-returned/child.ts': 'export const secret = 1;' }); missing.entries.splice(missing.entries.findIndex(entry => entry.type === 'tree'), 1);
  assert.deepEqual((await missing.scan()).files, []); assert.equal(missing.requests.some(request => request.path.includes('/git/blobs/')), false);
  const link = await fixture({ 'parent/child.ts': 'safe' }); Object.assign(link.entries.find(entry => entry.path === 'parent'), { type: 'blob', mode: '120000' }); assert.deepEqual((await link.scan()).files, []);
});

test('auth failures, transport errors and malformed responses fail closed without raw diagnostics', async () => {
  for (const status of [401, 403, 404, 429, 500]) {
    const f = await fixture(); f.intercept(() => json({ message: token }, status));
    await assert.rejects(f.scan(), error => error.code === 'GITHUB_REQUEST_REJECTED' && !error.message.includes(token));
  }
  const f = await fixture(); f.intercept(() => { throw Object.assign(Error(token), { code: 'GITHUB_RESPONSE_INVALID' }); });
  await assert.rejects(f.scan(), error => error.code === 'GITHUB_TRANSPORT' && !error.message.includes(token));
  const malformed = await fixture(); malformed.intercept(() => new Response('{broken')); await assert.rejects(malformed.scan(), { code: 'GITHUB_RESPONSE_INVALID' });
});

test('abort and timeout bound even uncooperative mocked transports and do not emit credentials', async () => {
  const pre = await fixture(), controller = new AbortController(); controller.abort(Error(token));
  await assert.rejects(pre.scan({ signal: controller.signal }), { code: 'GITHUB_ABORTED' }); assert.equal(pre.requests.length, 0);
  const during = await fixture(), later = new AbortController(); during.intercept(() => { setTimeout(() => later.abort(Error(token)), 5); return new Promise(() => {}); });
  await assert.rejects(during.scan({ signal: later.signal }), error => error.code === 'GITHUB_ABORTED' && !error.message.includes(token)); assert.equal(during.requests[0].signal.aborted, true);
  const timeout = await fixture(undefined, { requestTimeoutMs: 10 }); timeout.intercept(() => new Promise(() => {}));
  await assert.rejects(timeout.scan(), { code: 'GITHUB_TIMEOUT' }); assert.equal(timeout.requests[0].signal.aborted, true);
  const revoked = await fixture(); revoked.intercept(url => { if (url.pathname.includes('/git/blobs/')) revoked.scopes([]); });
  await assert.rejects(revoked.scan(), { code: 'GITHUB_SCOPE_DENIED' });
});
