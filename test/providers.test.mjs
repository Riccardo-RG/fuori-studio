import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProviderStore } from '../lib/providers.mjs';

const KEY = 'test-credential-never-print-in-public-output';
const completion = (text = 'A useful answer.') => ({ choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 7 } });
const json = (value, options) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' }, ...options });
async function fixture(t, fetchImpl = async () => json(completion())) {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-providers-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, file: join(directory, 'providers.json'), store: createProviderStore({ directory, fetchImpl }) };
}
async function connect(store, type = 'deepseek', more = {}) {
  const result = await store.mutate('saveConnection', { name: `Test ${type}`, type, model: `${type}-model`, apiKey: KEY, ...more });
  return result.connections.at(-1).id;
}
async function enable(store, id, agentId = 'nova', scopeId = 'business') {
  await store.mutate('assignAgent', { agentId, connectionId: id });
  await store.mutate('setScopePolicy', { scopeId, connectionIds: ['codex', id] });
}

test('defaults are local Codex only and snapshots never expose credentials', async t => {
  let calls = 0;
  const { store, directory, file } = await fixture(t, async () => { calls++; return json(completion()); });
  const initial = await store.getSnapshot();
  assert.deepEqual(initial.connections.map(item => item.id), ['codex']);
  assert.ok(Object.values(initial.assignments).every(id => id === 'codex'));
  assert.deepEqual(initial.policies, {});
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const id = await connect(store);
  const snapshot = await store.getSnapshot();
  assert.equal(snapshot.connections[1].configured, true);
  assert.equal(snapshot.connections[1].hasKey, true);
  assert.equal(JSON.stringify(snapshot).includes(KEY), false);
  assert.equal(JSON.stringify(snapshot).includes('apiKey'), false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).connections[0].apiKey, KEY);
  const restored = createProviderStore({ directory });
  assert.deepEqual(await restored.getSnapshot(), snapshot);
  snapshot.connections[1].name = 'Mutated outside';
  snapshot.assignments.nova = id;
  assert.notEqual((await store.getSnapshot()).connections[1].name, 'Mutated outside');
  assert.equal((await store.getSnapshot()).assignments.nova, 'codex');
  assert.equal(calls, 0, 'configuration and status must not make billable calls');
});

test('scope authorization is explicit and fail-closed for assigned and overridden services', async t => {
  let calls = 0;
  const { store } = await fixture(t, async () => { calls++; return json(completion()); });
  const id = await connect(store);
  await store.mutate('assignAgent', { agentId: 'nova', connectionId: id });
  for (const scopeId of ['business', 'shared', 'client-one']) {
    await assert.rejects(store.execute({ agentId: 'nova', scopeId, prompt: 'PRIVATE CONTEXT' }), { code: 'PROVIDER_NOT_ALLOWED', status: 403 });
    await assert.rejects(store.assertAllowed({ agentId: 'forge', scopeId, connectionId: id }), { code: 'PROVIDER_NOT_ALLOWED' });
  }
  assert.equal(calls, 0);
  await store.mutate('setScopePolicy', { scopeId: 'business', connectionIds: [id] });
  assert.equal((await store.assertAllowed({ agentId: 'nova', scopeId: 'business' })).id, id);
  await store.execute({ agentId: 'nova', scopeId: 'business', prompt: 'AUTHORIZED CONTEXT' });
  assert.equal(calls, 1);
  await assert.rejects(store.assertAllowed({ agentId: 'forge', scopeId: 'business' }), { code: 'PROVIDER_NOT_ALLOWED' });
  await store.mutate('setScopePolicy', { scopeId: 'business', connectionIds: [] });
  await assert.rejects(store.execute({ agentId: 'nova', scopeId: 'business', prompt: 'REVOKED' }), { code: 'PROVIDER_NOT_ALLOWED' });
  assert.equal(calls, 1);
});

test('keys can be retained or rotated, but not reused across a provider type change', async t => {
  let receivedKey;
  const { store } = await fixture(t, async (_url, options) => { receivedKey = options.headers.Authorization; return json(completion()); });
  const id = await connect(store);
  await store.mutate('saveConnection', { id, name: 'Renamed', type: 'deepseek', model: 'another-model', apiKey: '' });
  await store.testConnection({ id });
  assert.equal(receivedKey, `Bearer ${KEY}`);
  await store.mutate('saveConnection', { id, name: 'Renamed', type: 'deepseek', model: 'another-model', apiKey: 'replacement-private-key' });
  await store.testConnection({ id });
  assert.equal(receivedKey, 'Bearer replacement-private-key');
  await assert.rejects(store.mutate('saveConnection', { id, name: 'Changed', type: 'openrouter', model: 'test-model' }), { code: 'VALIDATION_ERROR' });
  const missing = await connect(store, 'openai', { apiKey: '' });
  await assert.rejects(store.mutate('assignAgent', { agentId: 'forge', connectionId: missing }), { code: 'PROVIDER_NOT_CONFIGURED' });
  await assert.rejects(store.testConnection({ id: missing }), { code: 'PROVIDER_NOT_CONFIGURED' });
});

test('deletion never silently reassigns an agent or broadens a scope policy', async t => {
  const { store } = await fixture(t);
  const id = await connect(store);
  await enable(store, id);
  await assert.rejects(store.mutate('deleteConnection', { id }), { code: 'PROVIDER_IN_USE' });
  assert.equal((await store.getSnapshot()).assignments.nova, id);
  await store.mutate('assignAgent', { agentId: 'nova', connectionId: 'codex' });
  await store.mutate('setScopePolicy', { scopeId: 'business', connectionIds: [id] });
  const deleted = await store.mutate('deleteConnection', { id });
  assert.deepEqual(deleted.policies.business, []);
  await assert.rejects(store.assertAllowed({ agentId: 'nova', scopeId: 'business' }), { code: 'PROVIDER_NOT_ALLOWED' });
  await assert.rejects(store.mutate('deleteConnection', { id: 'codex' }), { code: 'VALIDATION_ERROR' });
});

test('invalid input and arbitrary endpoints cannot enter the archive', async t => {
  const { store } = await fixture(t);
  for (const payload of [
    { name: 'Bad', type: 'deepseek', model: 'model', apiKey: KEY, baseURL: 'http://127.0.0.1' },
    { name: 'Bad', type: 'http', model: 'model', apiKey: KEY },
    { name: 'Bad', type: 'openai', model: 'https://attacker.example/model', apiKey: KEY },
    { name: KEY, type: 'deepseek', model: 'model', apiKey: KEY },
    { name: 'Bad', type: 'deepseek', model: 'model', apiKey: 'key\r\ninjected: true' },
    JSON.parse('{"__proto__":{"polluted":true}}'),
  ]) await assert.rejects(store.mutate('saveConnection', payload), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.mutate('setScopePolicy', { scopeId: '__proto__', connectionIds: ['codex'] }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.mutate('setScopePolicy', { scopeId: 'business', connectionIds: ['codex', 'codex'] }), { code: 'VALIDATION_ERROR' });
  await assert.rejects(store.mutate('setScopePolicy', { scopeId: 'business', connectionIds: ['missing'] }), { code: 'NOT_FOUND' });
  assert.equal((await store.getSnapshot()).connections.length, 1);
  assert.equal(Object.prototype.polluted, undefined);
});

test('concurrent changes are serialized and rejected mutations do not poison the queue', async t => {
  const { store } = await fixture(t);
  const results = await Promise.allSettled([
    ...Array.from({ length: 10 }, (_, i) => connect(store, 'deepseek', { name: `Connection ${i}` })),
    store.mutate('not-supported', {}),
    connect(store, 'openai'),
  ]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 11);
  assert.equal((await store.getSnapshot()).connections.length, 12);
});

test('corrupt, incompatible or symlinked secret stores fail closed without overwriting data', async t => {
  const { store, file, directory } = await fixture(t);
  await connect(store);
  const backup = await readFile(file, 'utf8');
  for (const broken of ['{"apiKey":"' + KEY, JSON.stringify({ ...JSON.parse(backup), version: 99 }), JSON.stringify({ ...JSON.parse(backup), assignments: { nova: 'missing' } })]) {
    await writeFile(file, broken);
    await assert.rejects(store.getSnapshot(), error => error.code === 'PROVIDERS_CORRUPT' && !error.message.includes(KEY));
    await assert.rejects(connect(store), { code: 'PROVIDERS_CORRUPT' });
    assert.equal(await readFile(file, 'utf8'), broken);
  }
  await writeFile(file, backup);
  assert.equal((await store.getSnapshot()).connections.length, 2);
  const target = join(directory, 'outside.json');
  await writeFile(target, backup);
  await rm(file);
  await symlink(target, file);
  await assert.rejects(store.getSnapshot(), { code: 'PROVIDERS_CORRUPT' });
  assert.equal(await readFile(target, 'utf8'), backup);
});

for (const type of ['openai', 'anthropic', 'openrouter', 'deepseek']) {
  test(`${type} uses the fixed native endpoint and exposes only assistant text and normalized usage`, async t => {
    let request;
    const response = type === 'openai'
      ? { status: 'completed', output: [{ type: 'reasoning', summary: [{ text: 'hidden reasoning' }] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Final text.' }] }], usage: { input_tokens: 11, output_tokens: 7 } }
      : type === 'anthropic'
        ? { content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'text', text: 'Final text.' }], stop_reason: 'end_turn', usage: { input_tokens: 11, output_tokens: 7 } }
        : { ...completion('Final text.'), reasoning: 'hidden reasoning' };
    const { store } = await fixture(t, async (url, options) => { request = { url, ...options, body: JSON.parse(options.body) }; return json(response); });
    const id = await connect(store, type);
    await enable(store, id);
    const result = await store.execute({ agentId: 'nova', scopeId: 'business', prompt: 'A harmless request.' });
    assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7 });
    assert.equal(result.text, 'Final text.');
    assert.deepEqual(result.provider, { id, type, model: `${type}-model` });
    assert.ok(result.durationMs >= 0);
    assert.equal(request.url, { openai: 'https://api.openai.com/v1/responses', anthropic: 'https://api.anthropic.com/v1/messages', openrouter: 'https://openrouter.ai/api/v1/chat/completions', deepseek: 'https://api.deepseek.com/chat/completions' }[type]);
    assert.equal(request.redirect, 'error');
    assert.equal(request.body.stream, false);
    assert.equal(request.body.tools, undefined);
    assert.equal(JSON.stringify(request.body).includes(KEY), false);
    if (type === 'openai') { assert.equal(request.body.store, false); assert.equal(request.body.max_output_tokens, 4096); }
    else assert.equal(request.body.max_tokens, 4096);
    if (type === 'anthropic') { assert.equal(request.headers['x-api-key'], KEY); assert.equal(request.headers['anthropic-version'], '2023-06-01'); }
    else assert.equal(request.headers.Authorization, `Bearer ${KEY}`);
  });
}

test('coordinator schema accompanies external requests and testing sends only a tiny fixed prompt', async t => {
  const requests = [];
  const { store } = await fixture(t, async (_url, options) => { requests.push(JSON.parse(options.body)); return json(completion('OK')); });
  const id = await connect(store);
  await enable(store, id);
  await store.execute({ agentId: 'nova', scopeId: 'business', prompt: 'MY PRIVATE CONTEXT', schema: true });
  assert.match(requests[0].messages[0].content, /JSON Schema/);
  assert.match(requests[0].messages[0].content, /needsInput/);
  const result = await store.testConnection({ id });
  assert.equal(result.ok, true);
  assert.equal(requests[1].messages[0].content, 'Reply with only the word OK.');
  assert.equal(requests[1].max_tokens, 64);
  assert.equal(JSON.stringify(requests[1]).includes('MY PRIVATE CONTEXT'), false);
  assert.equal(requests.length, 2, 'no fallback or background probes');
});

test('HTTP errors and transport exceptions cannot leak upstream bodies, credentials or causes', async t => {
  let status = 401;
  const { store } = await fixture(t, async () => {
    if (status === 0) throw Object.assign(new Error(`authorization=${KEY}`), { code: 'PROVIDER_AUTH', cause: KEY });
    return new Response(`Provider failure contains ${KEY}`, { status });
  });
  const id = await connect(store);
  for (const value of [401, 403, 429, 400, 404, 422, 500, 0]) {
    status = value;
    await assert.rejects(store.testConnection({ id }), error => {
      assert.equal(error.message.includes(KEY), false);
      assert.equal(JSON.stringify(error).includes(KEY), false);
      assert.equal(error.cause, undefined);
      assert.equal(error.status, 502);
      return true;
    });
  }
});

test('tool-only, invalid and truncated responses are rejected rather than invented or retried', async t => {
  let response;
  const { store } = await fixture(t, async () => response());
  const id = await connect(store);
  for (const [body, code] of [
    [{ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ name: 'exec' }] } }] }, 'PROVIDER_EMPTY'],
    [{ choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' }] }, 'PROVIDER_INCOMPLETE'],
    [{ error: { message: KEY } }, 'PROVIDER_RESPONSE'],
    [{}, 'PROVIDER_EMPTY'],
  ]) { response = () => json(body); await assert.rejects(store.testConnection({ id }), { code }); }
  response = () => new Response('malformed ' + KEY);
  await assert.rejects(store.testConnection({ id }), error => error.code === 'PROVIDER_RESPONSE' && !error.message.includes(KEY));
});

test('response byte limits apply to streamed bodies as well as announced size', async t => {
  let declared = true;
  const { store } = await fixture(t, async () => declared
    ? new Response('short', { headers: { 'content-length': '2000000' } })
    : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); controller.enqueue(new Uint8Array(1024)); controller.close(); } })));
  const id = await connect(store);
  await assert.rejects(store.testConnection({ id }), { code: 'PROVIDER_OUTPUT_LIMIT' });
  declared = false;
  await assert.rejects(store.testConnection({ id }), { code: 'PROVIDER_OUTPUT_LIMIT' });
});

test('known credentials are rejected in prompts and redacted if the provider echoes them', async t => {
  let calls = 0;
  const { store } = await fixture(t, async () => { calls++; return json(completion('Echo: ' + KEY)); });
  const id = await connect(store);
  await enable(store, id);
  await assert.rejects(store.execute({ agentId: 'nova', scopeId: 'business', prompt: 'Accidental paste ' + KEY }), { code: 'PROVIDER_SECRET_IN_PROMPT' });
  assert.equal(calls, 0);
  const result = await store.testConnection({ id });
  assert.equal(result.text, 'Echo: [REDACTED]');
  assert.equal(JSON.stringify(result).includes(KEY), false);
});

test('cancellation stops before a call or aborts the active transport without fallback', async t => {
  let calls = 0, started;
  const entered = new Promise(resolve => { started = resolve; });
  const { store } = await fixture(t, async (_url, { signal }) => {
    calls++; started();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error(KEY)), { once: true }));
  });
  const id = await connect(store);
  const early = new AbortController(); early.abort();
  await assert.rejects(store.testConnection({ id, signal: early.signal }), { code: 'ABORTED' });
  assert.equal(calls, 0);
  const controller = new AbortController();
  const pending = store.testConnection({ id, signal: controller.signal });
  await entered; controller.abort();
  await assert.rejects(pending, error => error.code === 'ABORTED' && !error.message.includes(KEY));
  assert.equal(calls, 1);
});

test('the server deadline aborts a stalled transport and returns a safe timeout', async t => {
  const { store } = await fixture(t, async (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(Error(KEY)), { once: true })));
  const id = await connect(store);
  const original = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => original(callback, ms === 180000 ? 5 : ms, ...args);
  try { await assert.rejects(store.testConnection({ id }), { code: 'PROVIDER_TIMEOUT', status: 504 }); }
  finally { globalThis.setTimeout = original; }
});
