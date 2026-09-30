import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMemoryReview, createMemoryReview } from '../lib/memory-review.ts';

const now = Date.parse('2026-09-30T12:00:00Z'), day = 86_400_000;
const memory = (id, fields = {}) => ({ id, version: 2, scopeId: 'business', title: id, content: 'Use Node 24.', type: 'fact', status: 'confirmed', source: 'Owner note', updatedAt: new Date(now - 10 * day).toISOString(), sharedWith: [], agentIds: [], ...fields });
const snapshot = memories => ({ scopes: [{ id: 'business' }, { id: 'personal' }, { id: 'shared', kind: 'shared' }, { id: 'legacy', kind: 'archive' }], memories });

test('review uses conservative equality, keeps provenance and grants, and never mutates its input', async () => {
  const state = snapshot([
    memory('a', { content: 'Café  Node 24.', sharedWith: ['personal'], agentIds: ['forge'] }),
    memory('b', { content: 'Cafe\u0301\nNode 24.', version: 4, source: 'Another source' }),
    memory('case', { content: 'café Node 24.' }), memory('punctuation', { content: 'Café Node 24!' }),
    memory('symbol', { content: 'Café Node ²4.' }), memory('type', { content: 'Café Node 24.', type: 'decision' }),
  ]);
  const before = structuredClone(state), service = createMemoryReview({ workspace: { getSnapshot: async () => state }, now: () => now });
  const result = await service.snapshot({ scopeId: 'business' });
  assert.equal(result.duplicates.length, 1); assert.deepEqual(result.duplicates[0].memories.map(item => item.id), ['a', 'b']);
  assert.equal(result.duplicates[0].memories[1].version, 4); assert.equal(result.duplicates[0].memories[1].source, 'Another source');
  assert.deepEqual(result.duplicates[0].memories[0].agentIds, ['forge']); assert.equal(result.summary.reviewMemories, 2);
  assert.equal(result.readOnly, true); assert.equal(result.noAiCalls, true); assert.deepEqual(state, before);
  result.duplicates[0].memories[0].sharedWith.push('business'); assert.deepEqual(state, before);
});

test('age uses the exact updated timestamp, counts each memory once, and does not invalidate notes', () => {
  const result = buildMemoryReview(snapshot([
    memory('older', { updatedAt: new Date(now - 100 * day).toISOString() }),
    memory('boundary', { updatedAt: new Date(now - 90 * day).toISOString() }),
    memory('recent', { content: 'A different note.', updatedAt: new Date(now - 90 * day + 1).toISOString() }),
    memory('future', { content: 'Future note.', updatedAt: new Date(now + day).toISOString() }),
    memory('proposal', { content: 'Unconfirmed.', status: 'proposed', updatedAt: new Date(now - 200 * day).toISOString() }),
  ]), { scopeId: 'business', now });
  assert.deepEqual(result.aging.map(item => [item.id, item.ageDays, item.status]), [['older', 100, 'confirmed'], ['boundary', 90, 'confirmed']]);
  assert.deepEqual(result.summary, { total: 5, duplicateGroups: 1, duplicateMemories: 2, agingMemories: 2, reviewMemories: 2 });
  assert.equal(result.thresholdDays, 90); assert.equal(result.generatedAt, new Date(now).toISOString());
});

test('other scopes, common profile and explicit links never affect owned review findings or counts', () => {
  const result = buildMemoryReview(snapshot([
    memory('mine'), memory('secret', { scopeId: 'personal', title: 'Private title', source: 'Private source', updatedAt: new Date(now - 200 * day).toISOString(), sharedWith: ['business'] }),
    memory('profile', { scopeId: 'shared', content: 'Common profile.' }),
  ]), { scopeId: 'business', now });
  assert.deepEqual(result.summary, { total: 1, duplicateGroups: 0, duplicateMemories: 0, agingMemories: 0, reviewMemories: 0 });
  assert.doesNotMatch(JSON.stringify(result), /Private|secret|profile|personal/);
  for (const scopeId of ['*', 'missing', 'legacy', null]) assert.throws(() => buildMemoryReview(snapshot([]), { scopeId, now }));
  const common = buildMemoryReview(snapshot([memory('profile', { scopeId: 'shared' })]), { scopeId: 'shared', now });
  assert.equal(common.summary.total, 1);
});
