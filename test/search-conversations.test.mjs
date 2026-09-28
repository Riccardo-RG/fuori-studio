import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConversationStore } from '../lib/conversations.mjs';
import { createArchive } from '../lib/archive.mjs';

async function temporary(t) { const directory = await mkdtemp(join(tmpdir(), 'fuori-search-')); t.after(() => rm(directory, { recursive:true, force:true })); return directory; }

test('read-only conversation enumeration does not create a chat or change selected scope', async t => {
  const directory = await temporary(t), store = createConversationStore({ directory });
  assert.deepEqual(await store.list({ scopeIds:['business'] }), { conversations:[], truncated:false });
  assert.deepEqual(await readdir(directory), []);
  const personal = await store.select('personal'); personal.messages.push({ id:'message', role:'user', text:'Personal archived message' }); await store.save(personal);
  const current = await store.reset('personal');
  const before = await readFile(join(directory, 'chat-selection.json'), 'utf8');
  const listed = await store.list({ scopeIds:['personal'] }); assert.equal(listed.conversations.length, 2);
  assert.equal(listed.conversations.find(chat => chat.id === personal.id).archived, true);
  assert.equal((await store.original({ scopeId:'personal', conversationId:personal.id })).messages.at(-1).text, 'Personal archived message');
  assert.equal((await store.original({ scopeId:'personal', conversationId:current.id })).archived, false);
  assert.deepEqual((await store.list({ scopeIds:['business'] })).conversations, []);
  assert.equal(await readFile(join(directory, 'chat-selection.json'), 'utf8'), before);
  await assert.rejects(store.original({ scopeId:'business', conversationId:personal.id }), error => error.statusCode === 404);
  await assert.rejects(store.original({ scopeId:'personal', conversationId:'../escape' }));
});

test('encrypted archived conversations remain searchable after restart, without plaintext copies or revision writes', async t => {
  const directory = await temporary(t), archive = createArchive({ directory, masterKey:Buffer.alloc(32, 9).toString('base64') });
  t.after(() => archive.close());
  const store = createConversationStore({ directory, storage:archive });
  const old = await store.select('business'); old.messages.push({ id:'original-message', role:'user', text:'needle in encrypted archive' }); await store.save(old); await store.reset('business');
  await archive.write('migration/chat/history/private', { secret:'must never enumerate migration originals' });
  const history = await archive.entries('chat/history/'); assert.equal(history.total, 1); assert.equal(history.entries[0].value.id, old.id);
  await assert.rejects(archive.entries('chat')); await assert.rejects(archive.entries('migration/')); await assert.rejects(archive.entries('chat/history/', { limit:0 }));
  await archive.close();
  const reopened = createArchive({ directory, masterKey:Buffer.alloc(32, 9).toString('base64') }); t.after(() => reopened.close());
  const restarted = createConversationStore({ directory, storage:reopened });
  const recordsBefore = await reopened.entries('chat/');
  const listed = await restarted.list({ scopeIds:['business'] }); assert.equal(listed.conversations.length, 2);
  assert.equal(listed.conversations.find(chat => chat.archived).messages.at(-1).text, 'needle in encrypted archive');
  assert.equal((await restarted.original({ scopeId:'business', conversationId:old.id })).archived, true);
  assert.deepEqual(await reopened.entries('chat/'), recordsBefore);
  assert.deepEqual(await readdir(join(directory, 'history')), []);
});

test('bounded conversation enumeration reports partial results and does not follow history links', async t => {
  const directory = await temporary(t), store = createConversationStore({ directory });
  const chat = await store.load('business'); await store.reset('business');
  assert.equal((await store.list({ scopeIds:['business'], limit:1 })).truncated, true);
  const external = join(directory, 'external.json'); await writeFile(external, JSON.stringify({ id:'linked', scopeId:'business', messages:[{ id:'secret', role:'user', text:'outside' }] }));
  await symlink(external, join(directory, 'history', 'linked.json'));
  assert.equal((await store.list({ scopeIds:['business'] })).conversations.some(item => item.id === 'linked'), false);
  await assert.rejects(store.original({ scopeId:'business', conversationId:'linked' }));
  const original = await store.original({ scopeId:'business', conversationId:chat.id }); assert.equal(original.id, chat.id);
});
