import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationStore } from '../lib/conversations.mjs';
import { contextEvidence, contextMessages, historyFor } from '../lib/context.mjs';

test('conversation migration keeps mixed legacy history out of new scopes; switching survives restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-conversations-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const original = { id: 'original', messages: [{ id: 'one', role: 'user', text: 'old mixed private context' }] };
  await writeFile(join(directory, 'chat.json'), JSON.stringify(original));
  const store = createConversationStore({ directory });
  assert.equal(await store.selection(), 'business');
  assert.equal((await store.load('business')).messages.some(m => m.text.includes('private')), false);
  assert.equal((await store.load('legacy')).messages[0].text, original.messages[0].text);
  const personal = await store.select('personal'); personal.messages.push({ id: 'two', role: 'user', text: 'personal only' }); await store.save(personal);
  const fresh = createConversationStore({ directory });
  assert.equal(await fresh.selection(), 'personal');
  assert.equal((await fresh.load('personal')).messages.at(-1).text, 'personal only');
  assert.equal((await fresh.load('business')).messages.some(m => m.text.includes('personal only')), false);
  const next = await fresh.reset('personal');
  assert.notEqual(next.id, personal.id);
  assert.equal(JSON.parse(await readFile(join(directory, 'history', `${personal.id}.json`), 'utf8')).messages.at(-1).text, 'personal only');
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'chat.json'), 'utf8')), original);
});

test('corrupt conversation is retained; path traversal rejected; queue can recover', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fuori-conversations-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const store = createConversationStore({ directory });
  await store.load('business');
  await writeFile(join(directory, 'conversations', 'business.json'), 'broken');
  await assert.rejects(store.load('business'), /conservato/);
  assert.equal(await readFile(join(directory, 'conversations', 'business.json'), 'utf8'), 'broken');
  for(const literal of ['null','false','0','""']){
    await writeFile(join(directory, 'conversations', 'business.json'), literal);
    await assert.rejects(store.load('business'), /conservato/);
    assert.equal(await readFile(join(directory, 'conversations', 'business.json'), 'utf8'), literal);
  }
  await assert.rejects(store.load('../personal'), /non valido/);
  assert.equal((await store.load('personal')).scopeId, 'personal');
});

test('workflow provenance remains transitive when the next turn has no selected workflow', () => {
  const workflow = {id:'workflow',title:'Private process',scopeId:'personal',sharedWith:['business'],version:1,status:'ready'};
  const context = {scope:{id:'business',name:'Business'},memories:[],workflow};
  const first = {id:'first',role:'assistant',text:'Private process results',context:contextEvidence(context)};
  const second = {id:'second',role:'assistant',text:'Paraphrased private process',context:contextEvidence({...context,workflow:null},[first])};
  assert.equal(second.context.workflows[0].id, workflow.id);
  const snapshot={memories:[],workflows:[workflow]};
  assert.equal(contextMessages([second],{scopeId:'business',agentId:'nova',snapshot}).length,1);
  workflow.sharedWith=[];
  assert.equal(contextMessages([second],{scopeId:'business',agentId:'nova',snapshot}).length,0);
});

test('restricted, withdrawn and revised memory cannot return through generated history', () => {
  const memory = { id: 'private', title: 'private', scopeId: 'personal', sharedWith: ['business'], status: 'confirmed', agentIds: ['nova'], version: 1 };
  const snapshot = { memories: [memory], workflows: [] };
  const context = { scope: { id: 'business', name: 'Business' }, memories: [memory], workflow: null };
  const first = { id: 'first', role: 'assistant', agentId: 'nova', text: 'secret detail', context: contextEvidence(context) };
  assert.equal(contextMessages([first], { scopeId: 'business', agentId: 'forge', snapshot }).length, 0);
  const inherited = { id: 'second', role: 'assistant', agentId: 'nova', text: 'paraphrase', context: contextEvidence({ ...context, memories: [] }, [first]) };
  assert.equal(inherited.context.memories[0].id, 'private');
  assert.equal(historyFor([inherited], { scopeId: 'business', agentId: 'forge', snapshot }), '');
  assert.match(historyFor([inherited], { scopeId: 'business', agentId: 'nova', snapshot }), /paraphrase/);
  memory.sharedWith = [];
  assert.equal(contextMessages([first, inherited], { scopeId: 'business', agentId: 'nova', snapshot }).length, 0);
  memory.sharedWith = ['business']; memory.version = 2;
  assert.equal(contextMessages([first, inherited], { scopeId: 'business', agentId: 'nova', snapshot }).length, 0);
});
