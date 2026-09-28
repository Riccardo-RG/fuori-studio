import test from 'node:test';
import assert from 'node:assert/strict';
import { createStudioSearch, SEARCH_KINDS } from '../lib/studio-search.ts';
import { highlightSearchText } from '../dist/search.js';

function fixture() {
  const calls = [];
  const workspace = { scopes:[{ id:'business', name:'Business' }, { id:'personal', name:'Personal' }, { id:'client', name:'Client' }, { id:'shared', name:'Shared' }], memories:[
    { id:'owned', scopeId:'business', type:'fact', title:'Caffè launch', content:'The launch meeting is Tuesday', source:'Planning note', status:'confirmed', version:2, sharedWith:[] },
    { id:'shared', scopeId:'shared', type:'preference', title:'Style', content:'Launch documents use short sentences', sharedWith:[] },
    { id:'decision', scopeId:'personal', type:'decision', title:'Launch budget', content:'Keep the launch below 2000', sharedWith:['business'] },
    { id:'secret', scopeId:'client', type:'fact', title:'Secret launch', content:'Classified acme details', sharedWith:[] },
  ], workflows:[{ id:'workflow', scopeId:'personal', title:'Launch process', description:'Collect and verify facts', output:'Brief', sharedWith:['business'] }] };
  const chats = [{ id:'chat-now', scopeId:'business', archived:false, createdAt:'2026-01-02T00:00:00Z', messages:[{ id:'welcome', role:'assistant', text:'Launch welcome', welcome:true }, { id:'current', role:'user', text:'Launch launch Wednesday', createdAt:'2026-01-02T00:00:00Z' }] }, { id:'chat-old', scopeId:'business', archived:true, messages:[{ id:'archived', role:'user', text:'Launch archived original message' }, { id:'reply', role:'assistant', text:'Archived answer' }] }, { id:'secret-chat', scopeId:'client', archived:true, messages:[{ id:'secret-message', role:'user', text:'Launch hidden client conversation' }] }];
  const documents = [{ source:{ id:'document', title:'Launch guide', scopeId:'business', kind:'document', filename:'guide.pdf', version:1, status:'stale' }, segments:[{ text:'An irrelevant introduction', page:1 }, { text:'Launch original text: café discussion', page:7 }] }, { source:{ id:'private-doc', title:'Launch private', scopeId:'personal', kind:'document' }, segments:[{ text:'Private document contents' }] }];
  const operations = { projects:[{ id:'project', title:'Business project', scopeId:'business' }], tasks:[{ id:'task', projectId:'project', scopeId:'business', title:'Launch plan', brief:'Create the release plan', artifacts:[{ id:'artifact', title:'Launch deliverable', content:'The saved launch deliverable', version:1, decision:'approved' }] }, { id:'private-task', projectId:'project', scopeId:'client', title:'Launch private task', brief:'Secret task' }] };
  const repositories = { repositories:[{ id:'repo', name:'Studio' }], runs:[{ id:'run', repositoryId:'repo', scopeId:'business', title:'Launch patch', brief:'Prepare a launch patch', summary:'Fixed the launcher', review:{ text:'Review verified launch behavior' }, baseCommit:'a'.repeat(40) }] };
  const search = createStudioSearch({ workspace:{ getSnapshot:async () => workspace }, conversations:{ list:async ({ scopeIds }) => { calls.push('conversations'); return { conversations:chats.filter(chat => scopeIds.includes(chat.scopeId)), truncated:false }; }, original:async ({ scopeId, conversationId }) => { const found = chats.find(chat => chat.id === conversationId && chat.scopeId === scopeId); if (!found) throw Object.assign(Error('Not found'), { statusCode:404 }); return found; } }, sources:{ allMetadata:async () => { calls.push('documents'); return documents.map(document => document.source); }, detail:async ({ id, scopeId }) => { const document = documents.find(document => document.source.id === id && document.source.scopeId === scopeId); if (!document) throw Error('Not found'); return document; } }, operations:{ getSnapshot:async () => operations }, repositories:{ snapshot:async () => repositories } });
  return { search, workspace, calls };
}

test('unified retrieval includes all content kinds, explicit sharing and archived messages, with source navigation', async () => {
  const { search } = fixture();
  const results = await search.search({ scopeId:'business', query:'launch' });
  assert.deepEqual(new Set(results.results.map(result => result.kind)), new Set(SEARCH_KINDS));
  assert.equal(results.localOnly, true); assert.equal(results.partial, false);
  const ids = results.results.map(result => result.target.id);
  for (const forbidden of ['secret', 'private-doc', 'secret-message', 'private-task', 'welcome']) assert.ok(!ids.includes(forbidden));
  const decision = results.results.find(result => result.kind === 'decision');
  assert.equal(decision.scopeId, 'personal'); assert.equal(decision.provenance.sharing, 'explicit');
  assert.equal(results.results.find(result => result.target.id === 'shared').provenance.sharing, 'shared');
  const archive = results.results.find(result => result.target.id === 'archived');
  assert.equal(archive.target.archived, true); assert.equal(archive.provenance.conversationId, 'chat-old');
  const originalParams = Object.fromEntries(new URL(archive.originalUrl, 'http://localhost').searchParams);
  const original = await search.original(originalParams);
  assert.equal(original.blocks[0].text, 'Launch archived original message'); assert.equal(original.blocks[1].text, 'Archived answer');
  assert.equal(original.result.target.messageId, 'archived');
  const document = results.results.find(result => result.kind === 'document');
  assert.equal(document.provenance.page, 7); assert.equal(document.status, 'stale'); assert.match(document.snippet, /original text/);
  assert.match(document.originalUrl, /sourceScopeId=business/);
  const artifact = results.results.find(result => result.kind === 'deliverable'); assert.equal(artifact.target.taskId, 'task');
});

test('explicit all-scopes search is opt-in; retrieval rechecks sharing and rejects scope bypass', async () => {
  const { search, workspace } = fixture();
  const all = await search.search({ scopeId:'*', query:'launch' });
  assert.ok(all.results.some(result => result.target.id === 'secret'));
  assert.ok(all.results.some(result => result.target.id === 'secret-message'));
  await assert.rejects(search.original({ scopeId:'business', sourceScopeId:'client', kind:'memory', id:'secret' }), error => error.statusCode === 404);
  await assert.rejects(search.original({ scopeId:'business', sourceScopeId:'client', kind:'conversation', id:'secret-message', conversationId:'secret-chat' }), error => error.statusCode === 404);
  await assert.rejects(search.search({ scopeId:'no-such-scope', query:'launch' }), error => error.statusCode === 404);
  assert.equal((await search.original({ scopeId:'business', kind:'decision', id:'decision' })).result.scopeId, 'personal');
  workspace.memories.find(memory => memory.id === 'decision').sharedWith = [];
  await assert.rejects(search.original({ scopeId:'business', kind:'decision', id:'decision' }), error => error.statusCode === 404);
  assert.ok(!(await search.search({ scopeId:'business', query:'launch' })).results.some(result => result.target.id === 'decision'));
});

test('matching is deterministic, accent-insensitive, AND-based, paginated and kind-scoped', async () => {
  const { search, calls } = fixture();
  const accented = await search.search({ scopeId:'business', query:'CAFFE Tuesday', kinds:['memory'] });
  assert.deepEqual(accented.results.map(result => result.target.id), ['owned']);
  assert.deepEqual(calls, []);
  const all = await search.search({ scopeId:'business', query:'launch' });
  const first = await search.search({ scopeId:'business', query:'launch', limit:3 });
  const second = await search.search({ scopeId:'business', query:'launch', offset:3, limit:3 });
  assert.deepEqual([...first.results, ...second.results].map(result => result.key), all.results.slice(0, 6).map(result => result.key));
  assert.equal(first.hasMore, true); assert.equal(first.total, all.total);
  assert.equal((await search.search({ scopeId:'business', query:'launch nonexistent' })).total, 0);
  assert.equal((await search.search({ scopeId:'business', query:'guide café', kinds:['document'] })).results[0].provenance.page, 7);
  const empty = await search.search({ scopeId:'business', query:'   ' }); assert.equal(empty.total, 0);
});

test('invalid queries, bounds and targets fail closed; preview markup stays inert', async () => {
  const { search } = fixture();
  for (const payload of [{ query:'x'.repeat(301) }, { query:'launch\0' }, { limit:0 }, { limit:101 }, { offset:-1 }, { offset:1.1 }, { kinds:['unknown'] }, { kinds:[] }]) await assert.rejects(search.search({ scopeId:'business', query:'launch', ...payload }), error => error.statusCode === 400);
  await assert.rejects(search.original({ scopeId:'business', kind:'conversation', id:'../secret', conversationId:'chat-old' }), error => error.statusCode === 400);
  await assert.rejects(search.original({ scopeId:'business', kind:'conversation', id:'wrong', conversationId:'chat-old' }), error => error.statusCode === 404);
  assert.equal(highlightSearchText('<img src=x onerror="alert(1)">Launch</img>', 'launch'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;<mark>Launch</mark>&lt;/img&gt;');
  assert.equal(highlightSearchText('a+b [x]', 'a+b'), '<mark>a</mark>+<mark>b</mark> [x]');
});
