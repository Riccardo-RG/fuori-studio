import test from 'node:test';
import assert from 'node:assert/strict';
import { createSourceStore } from '../lib/sources.ts';

test('source search snapshot reads the archive once, returns only selected known scopes and never refreshes', async () => {
  const records = new Map(); let reads = 0, writes = 0;
  const storage = { read:async (key, fallback) => { reads++; return structuredClone(records.get(key) || fallback); }, write:async (key, value) => { writes++; records.set(key, structuredClone(value)); } };
  const workspace = { getSnapshot:async () => ({ scopes:[{ id:'business' }, { id:'personal' }, { id:'shared' }] }) };
  const store = createSourceStore({ storage, workspace, transport:async () => { throw Error('Search must not fetch'); }, search:async () => { throw Error('Search must not call AI'); } });
  await store.importText({ scopeId:'business', title:'One', text:'First business document' });
  await store.importText({ scopeId:'business', title:'Two', text:'Second business document' });
  await store.importText({ scopeId:'personal', title:'Private', text:'Private information' });
  await store.importText({ scopeId:'shared', title:'Shared scope only', text:'Not automatically shared as a source' });
  const writesBefore = writes, readsBefore = reads;
  const found = await store.searchSnapshot({ scopeIds:['business'] });
  assert.equal(reads, readsBefore + 1); assert.equal(writes, writesBefore); assert.equal(found.length, 2);
  assert.doesNotMatch(JSON.stringify(found), /Private information|Not automatically shared/);
  assert.equal((await store.searchSnapshot({ scopeIds:['personal'] }))[0].segments[0].text, 'Private information');
  assert.equal((await store.searchSnapshot({ scopeIds:['business', 'personal', 'shared'] })).length, 4);
  await assert.rejects(store.searchSnapshot({ scopeIds:['*'] }));
  await assert.rejects(store.searchSnapshot({ scopeIds:['unknown'] }), error => error.statusCode === 404);
  await assert.rejects(store.searchSnapshot({ scopeIds:[] }));
});
