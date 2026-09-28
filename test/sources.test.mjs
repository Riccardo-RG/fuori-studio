import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArchive } from '../lib/archive.mjs';
import { createSourceStore, isPublicSourceAddress } from '../lib/sources.ts';

function fixture(options = {}) {
  const records = new Map();
  const storage = { read: async (key, fallback) => structuredClone(records.has(key) ? records.get(key) : fallback), write: async (key, value) => { records.set(key, structuredClone(value)); } };
  const workspace = { getSnapshot: async () => ({ scopes: [{ id: 'owned' }, { id: 'personal' }, { id: 'shared' }] }) };
  const store = createSourceStore({ storage, workspace, ...options });
  return { store, storage, workspace, records };
}
async function directory(t) { const path = await realpath(await mkdtemp(join(tmpdir(), 'fuori-sources-'))); t.after(() => rm(path, { recursive: true, force: true })); return path; }
const response = (text, mimeType = 'text/plain', statusCode = 200, headers = {}) => ({ statusCode, headers: { 'content-type': mimeType, ...headers }, body: Buffer.from(text) });
const publicDns = async () => [{ address: '93.184.216.34', family: 4 }];
function textPdf(value) {
  const stream = `BT /F1 12 Tf 72 720 Td (${value}) Tj ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.7\n', offsets = [0];
  for (let i = 0; i < objects.length; i++) { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('sources remain scoped, cited as documents, versioned and separate from memory', async () => {
  const f = fixture();
  const imported = await f.store.importText({ scopeId: 'owned', title: 'Roadmap', text: '# Product roadmap\n\nLaunch the studio in December.' });
  assert.equal(imported.source.kind, 'text'); assert.equal(imported.source.untrusted, true); assert.equal(imported.source.version, 1); assert.equal(imported.source.refreshable, false);
  assert.equal(imported.segments[0].lineStart, 1); assert.equal(imported.segments[0].lineEnd, 3);
  await f.store.importText({ scopeId: 'personal', title: 'Private', text: 'December private travel.' });
  const result = await f.store.retrieve({ scopeId: 'owned', query: 'December launch' });
  assert.equal(result.sources.length, 1); assert.equal(result.passages[0].sourceId, imported.source.id); assert.doesNotMatch(JSON.stringify(result), /private travel/);
  assert.deepEqual((await f.store.snapshot({ scopeId: 'shared' })).sources, []);
  assert.deepEqual((await f.store.retrieve({ scopeId: 'owned', query: '' })).passages, []);
  await assert.rejects(f.store.detail({ id: imported.source.id, scopeId: 'personal' }), { code: 'NOT_FOUND' });
  await assert.rejects(f.store.importText({ scopeId: 'missing', title: 'Invalid', text: 'content' }), { code: 'NOT_FOUND' });
  assert.deepEqual([...f.records.keys()], ['sources']);
});

test('large text splits with references, retrieval remains bounded, and input limits fail rather than truncate imports', async () => {
  const { store } = fixture({ maxTextChars: 9000 });
  const imported = await store.importText({ scopeId: 'owned', title: 'Patterns', text: 'pattern '.repeat(800) });
  assert.ok(imported.segments.length > 1); assert.ok(imported.segments.every(segment => segment.text.length <= 2201));
  const result = await store.retrieve({ scopeId: 'owned', query: 'pattern', limit: 1, maxChars: 2300 });
  assert.equal(result.passages.length, 1); assert.equal(result.truncated, true);
  await assert.rejects(store.importText({ scopeId: 'owned', title: 'Too much', text: 'x'.repeat(9001) }));
  await assert.rejects(store.importDocument({ scopeId: 'owned', title: 'Bad', filename: 'a.txt', mimeType: 'text/plain', dataBase64: 'not base64!' }));
  await assert.rejects(store.importDocument({ scopeId: 'owned', title: 'Secret', filename: '.env', mimeType: 'text/plain', dataBase64: Buffer.from('secret').toString('base64') }));
});

test('actual PDF extraction preserves page citations and rejects binary or invalid uploads', async () => {
  const { store } = fixture();
  const pdf = textPdf('Entrepreneur strategy document');
  const imported = await store.importDocument({ scopeId: 'owned', title: 'Strategy PDF', filename: 'strategy.pdf', mimeType: 'application/pdf', dataBase64: pdf.toString('base64') });
  assert.equal(imported.segments[0].page, 1); assert.equal(imported.segments[0].lineStart, null); assert.match(imported.segments[0].text, /Entrepreneur strategy document/);
  assert.equal(imported.source.bytes, pdf.length);
  await assert.rejects(store.importDocument({ scopeId: 'owned', title: 'Bad PDF', filename: 'bad.pdf', mimeType: 'application/pdf', dataBase64: Buffer.from('not a PDF').toString('base64') }));
  await assert.rejects(store.importDocument({ scopeId: 'owned', title: 'Binary', filename: 'binary.txt', mimeType: 'text/plain', dataBase64: Buffer.from([0, 255]).toString('base64') }), { code: 'SOURCE_ENCODING_INVALID' });
});

test('address rules reject loopback, mapped, multicast, documentation and reserved networks', () => {
  for (const ip of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.31.2.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.51.100.2', '203.0.113.2', '198.19.0.1', '224.0.0.1', '::', '::1', '::ffff:127.0.0.1', '::ffff:c0a8:101', '2001:db8::1', '2001::1', '2002:7f00:1::', 'fc00::1', 'fe80::1', 'ff00::1', '3ffe::1', '3fff::1', 'not-an-ip']) assert.equal(isPublicSourceAddress(ip), false, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(isPublicSourceAddress(ip), true, ip);
});

test('URL importer pins checked DNS addresses and strips executable HTML from extracted text', async () => {
  const requests = [];
  const { store } = fixture({ resolveHost: publicDns, transport: async (url, address, options) => { requests.push({ url: url.href, address, maxBytes: options.maxBytes }); return response('<html><script>stealSecrets()</script><style>body{}</style><h1>Public roadmap</h1><p>Grow &amp; improve.</p></html>', 'text/html'); } });
  const imported = await store.importUrl({ scopeId: 'owned', url: 'https://docs.real-site.com/roadmap#section' });
  assert.equal(requests[0].address.address, '93.184.216.34'); assert.equal(requests[0].url, 'https://docs.real-site.com/roadmap');
  assert.match(imported.segments[0].text, /Public roadmap/); assert.match(imported.segments[0].text, /Grow & improve/); assert.doesNotMatch(imported.segments[0].text, /stealSecrets|body\{/);
  assert.equal(imported.source.refreshable, true); assert.equal(imported.source.url, requests[0].url);
});

test('private DNS, mixed answers, credentials, non-HTTPS and redirects to private addresses are blocked before transport', async () => {
  let calls = 0;
  const transport = async () => { calls++; return response('should not load'); };
  const privateStore = fixture({ resolveHost: async () => [{ address: '127.0.0.1', family: 4 }], transport }).store;
  for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://2130706433/', 'https://user:password@docs.real-site.com/', 'http://docs.real-site.com/', 'https://docs.real-site.com:8443/', 'https://test.local/', 'https://public.real-site.com/']) await assert.rejects(privateStore.importUrl({ scopeId: 'owned', url }), { code: 'SOURCE_URL_DENIED' });
  assert.equal(calls, 0);
  const mixed = fixture({ resolveHost: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }], transport }).store;
  await assert.rejects(mixed.importUrl({ scopeId: 'owned', url: 'https://docs.real-site.com/' }), { code: 'SOURCE_URL_DENIED' }); assert.equal(calls, 0);
  const redirect = fixture({ resolveHost: publicDns, transport: async () => { calls++; return response('', 'text/plain', 302, { location: 'https://169.254.169.254/latest/meta-data/' }); } }).store;
  await assert.rejects(redirect.importUrl({ scopeId: 'owned', url: 'https://docs.real-site.com/' }), { code: 'SOURCE_URL_DENIED' }); assert.equal(calls, 1);
});

test('URL reads enforce deadlines, redirect count, content type, compression and byte caps', async () => {
  const make = overrides => fixture({ resolveHost: publicDns, ...overrides }).store;
  const args = { scopeId: 'owned', url: 'https://docs.real-site.com/' };
  await assert.rejects(make({ requestTimeoutMs: 20, resolveHost: async () => new Promise(() => {}) }).importUrl(args), { code: 'SOURCE_TIMEOUT' });
  await assert.rejects(make({ transport: async () => response('', 'text/plain', 302, { location: '/again' }) }).importUrl(args), { code: 'SOURCE_REDIRECT_LIMIT' });
  await assert.rejects(make({ transport: async () => response('binary', 'image/png') }).importUrl(args), { code: 'SOURCE_MIME_DENIED' });
  await assert.rejects(make({ transport: async () => response('compressed', 'text/plain', 200, { 'content-encoding': 'gzip' }) }).importUrl(args), { code: 'SOURCE_ENCODING_INVALID' });
  await assert.rejects(make({ maxDocumentBytes: 5, transport: async () => response('too many bytes') }).importUrl(args), { code: 'SOURCE_TOO_LARGE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(make({ transport: async () => response('text') }).importUrl({ ...args, signal: controller.signal }), { code: 'SOURCE_ABORTED' });
});

test('GitHub connector reads public repository or issue JSON with no private access or write operations', async () => {
  const urls = [];
  const { store } = fixture({ resolveHost: publicDns, transport: async url => { urls.push(url.href); return response(JSON.stringify({ title: 'Fix source import', body: 'A detailed public issue.', state: 'open', updated_at: '2026-09-28T00:00:00Z' }), 'application/json'); } });
  const imported = await store.importUrl({ scopeId: 'owned', url: 'https://github.com/owner/product/issues/42' });
  assert.deepEqual(urls, ['https://api.github.com/repos/owner/product/issues/42']); assert.equal(imported.source.kind, 'github'); assert.match(imported.segments[0].text, /A detailed public issue/);
  await assert.rejects(store.importUrl({ scopeId: 'owned', url: 'https://github.com/owner/product/pulls/42' }), { code: 'SOURCE_GITHUB_URL_INVALID' });
  const privateStore = fixture({ resolveHost: publicDns, transport: async () => response('{"private":true}', 'application/json') }).store;
  await assert.rejects(privateStore.importUrl({ scopeId: 'owned', url: 'https://github.com/owner/product' }));
});

test('source freshness, optimistic versions and deletion stay correct across a pending refresh', async () => {
  let clock = Date.parse('2026-09-28T00:00:00Z'), release, refreshStarted;
  const started = new Promise(resolve => { refreshStarted = resolve; });
  let count = 0;
  const { store } = fixture({ now: () => clock, resolveHost: publicDns, transport: async () => { count++; if (count === 2) { refreshStarted(); await new Promise(resolve => { release = resolve; }); } return response('Version ' + count); } });
  const initial = await store.importUrl({ scopeId: 'owned', url: 'https://docs.real-site.com/' });
  clock += 8 * 86400000; assert.equal((await store.allMetadata())[0].status, 'stale');
  assert.deepEqual((await store.retrieve({ scopeId: 'owned', query: 'Version' })).passages, []);
  const refreshing = store.refresh({ id: initial.source.id, scopeId: 'owned', version: 1 }); await started;
  await assert.rejects(store.remove({ id: initial.source.id, scopeId: 'owned', version: 9 }), { code: 'VERSION_CONFLICT' });
  await store.remove({ id: initial.source.id, scopeId: 'owned', version: 1 }); release();
  await assert.rejects(refreshing, { code: 'NOT_FOUND' }); assert.deepEqual(await store.allMetadata(), []);
  assert.deepEqual((await store.retrieve({ scopeId: 'owned', query: 'Version' })).passages, []);
});

test('folder ingestion requires explicit roots, skips secrets/dependencies/symlinks and refreshes only authorized files', async t => {
  const root = await directory(t), folder = join(root, 'project'); await mkdir(folder);
  await writeFile(join(folder, 'guide.md'), '# Product context\nUseful source material');
  await writeFile(join(folder, '.env'), 'private credential'); await mkdir(join(folder, 'node_modules')); await writeFile(join(folder, 'node_modules/private.txt'), 'private dependency');
  await symlink('/etc/passwd', join(folder, 'external.txt')); await mkdir(join(folder, 'real')); await writeFile(join(folder, 'real/inside.txt'), 'safe file'); await symlink(join(folder, 'real'), join(folder, 'alias'));
  const { store } = fixture({ allowedRoots: async () => [folder] });
  const imported = await store.importFolder({ scopeId: 'owned', path: folder });
  assert.equal(imported.imported.length, 2); assert.equal(imported.skipped.length, 4); assert.doesNotMatch(JSON.stringify(await store.allMetadata()), /private credential|passwd/);
  await assert.rejects(store.importFolder({ scopeId: 'owned', path: root }), { code: 'SOURCE_PATH_DENIED' });
  await assert.rejects(store.importFolder({ scopeId: 'owned', path: join(folder, 'alias') }), { code: 'SOURCE_PATH_DENIED' });
  const selected = imported.imported.find(item => item.filename === 'guide.md');
  await writeFile(join(folder, 'guide.md'), 'Updated context'); const updated = await store.refresh({ id: selected.id, scopeId: 'owned', version: 1 });
  assert.equal(updated.source.version, 2); assert.match(updated.segments[0].text, /Updated context/);
  const online = fixture({ mode: 'hybrid', allowedRoots: [folder] }).store;
  await assert.rejects(online.importFolder({ scopeId: 'owned', path: folder }), { code: 'SOURCE_LOCAL_ONLY' });
  await assert.rejects(fixture().store.importFolder({ scopeId: 'owned', path: folder }), { code: 'SOURCE_PATH_DENIED' });
});

test('web research requires explicit consent, passes exact scope/provider and stores cited dated evidence only', async () => {
  const calls = [];
  let clock = Date.parse('2026-09-28T00:00:00Z');
  const { store } = fixture({ now: () => clock, search: async input => { calls.push(input); return { text: 'Research answer with references.', citations: [{ url: 'https://docs.real-site.com/article', title: 'Primary source' }], searchCalls: 1, provider: 'openai', usage: { inputTokens: 42 } }; } });
  await assert.rejects(store.searchWeb({ scopeId: 'owned', connectionId: 'openai-work', query: 'Find sources', consent: false }), { code: 'SOURCE_RESEARCH_CONSENT' }); assert.equal(calls.length, 0);
  const result = await store.searchWeb({ scopeId: 'owned', connectionId: 'openai-work', query: 'Find sources', domains: ['docs.real-site.com'], consent: true });
  assert.equal(calls[0].scopeId, 'owned'); assert.equal(calls[0].connectionId, 'openai-work'); assert.deepEqual(calls[0].domains, ['docs.real-site.com']);
  assert.equal(result.source.kind, 'research'); assert.equal(result.source.untrusted, true); assert.equal(result.citationSources[0].title, 'Primary source'); assert.equal(result.research.searchCalls, 1);
  clock += 2 * 86400000; assert.equal((await store.allMetadata())[0].status, 'stale');
  const uncited = fixture({ search: async () => ({ text: 'Unsupported claim', citations: [] }) }).store;
  await assert.rejects(uncited.searchWeb({ scopeId: 'owned', connectionId: 'openai-work', query: 'Research', consent: true }), { code: 'SOURCE_RESEARCH_NO_CITATIONS' });
});

test('source archive persists encrypted text and corruption fails closed', async t => {
  const root = await directory(t), archive = createArchive({ directory: root, mode: 'local', masterKey: undefined }); t.after(() => archive.close());
  const f = fixture({ storage: archive });
  const secret = 'proprietary-source-never-in-plaintext-database';
  await f.store.importText({ scopeId: 'owned', title: 'Private strategy', text: secret });
  for (const file of ['studio.sqlite', 'studio.sqlite-wal']) assert.equal((await readFile(join(root, file))).includes(Buffer.from(secret)), false);
  const restarted = createSourceStore({ storage: archive, workspace: f.workspace }); assert.equal((await restarted.retrieve({ scopeId: 'owned', query: 'proprietary' })).passages[0].text, secret);
  const invalid = await archive.read('sources'); invalid.records[0].segments[0].text = 'tampered source'; await archive.write('sources', invalid);
  await assert.rejects(restarted.allMetadata(), { code: 'SOURCE_ARCHIVE_INVALID' });
});
