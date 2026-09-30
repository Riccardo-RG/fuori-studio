interface Memory {
  id: string; version: number; scopeId: string; title: string; content: string;
  type: string; status: string; source: string; updatedAt: string;
  sharedWith: string[]; agentIds: string[];
}
interface WorkspaceSnapshot { scopes: Array<{ id: string; kind?: string }>; memories: Memory[]; }
interface ReviewInput { scopeId: unknown; now?: number; }
const DAY = 86_400_000, THRESHOLD_DAYS = 90;
const fail = (message: string, code = 'MEMORY_REVIEW_INVALID', statusCode = 400) => Object.assign(Error(message), { code, statusCode });
// Preserve case, punctuation and symbols: similar claims are not duplicates.
const normalized = (content: string) => content.normalize('NFC').replace(/\s+/gu, ' ').trim();

/** Inspection only. Age is a review hint; it never changes retrieval or validity. */
export function buildMemoryReview(snapshot: WorkspaceSnapshot, { scopeId, now = Date.now() }: ReviewInput) {
  if (typeof scopeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(scopeId)) throw fail('Ambito di revisione non valido.');
  const scope = snapshot.scopes.find(item => item.id === scopeId);
  if (!scope || scope.kind === 'archive') throw fail('Scegli un ambito attivo per rivedere le sue memorie.', 'MEMORY_REVIEW_SCOPE_DENIED', 403);
  if (!Number.isFinite(now)) throw fail('Data di revisione non valida.');
  // Shared/linked records are deliberately excluded unless this is their owner
  // scope. Both findings and counts must obey the same isolation boundary.
  const memories = snapshot.memories.filter(item => item.scopeId === scopeId).map(item => ({
    id: item.id, version: item.version, scopeId: item.scopeId, title: item.title, content: item.content,
    type: item.type, status: item.status, source: item.source, updatedAt: item.updatedAt,
    ageDays: Number.isFinite(Date.parse(item.updatedAt)) ? Math.max(0, Math.floor((now - Date.parse(item.updatedAt)) / DAY)) : null,
    sharedWith: [...item.sharedWith], agentIds: [...item.agentIds],
  })).sort((a, b) => a.id.localeCompare(b.id));
  const groups = new Map<string, typeof memories>();
  for (const memory of memories) {
    const content = normalized(memory.content);
    if (!content) continue;
    const key = JSON.stringify([memory.type, content]);
    const group = groups.get(key) || [];
    group.push(memory); groups.set(key, group);
  }
  const duplicates = [...groups.values()].filter(group => group.length > 1).map(group => ({ id: group[0]!.id, reason: 'same-content' as const, memories: group }));
  const aging = memories.filter(item => item.status === 'confirmed' && item.ageDays !== null && item.ageDays >= THRESHOLD_DAYS)
    .sort((a, b) => b.ageDays! - a.ageDays! || a.id.localeCompare(b.id));
  const duplicateIds = duplicates.flatMap(group => group.memories.map(item => item.id));
  return {
    scopeId, generatedAt: new Date(now).toISOString(), thresholdDays: THRESHOLD_DAYS, noAiCalls: true, readOnly: true,
    summary: { total: memories.length, duplicateGroups: duplicates.length, duplicateMemories: duplicateIds.length, agingMemories: aging.length, reviewMemories: new Set([...duplicateIds, ...aging.map(item => item.id)]).size },
    duplicates, aging,
  };
}

export function createMemoryReview({ workspace, now = Date.now }: { workspace: { getSnapshot(): Promise<WorkspaceSnapshot> }; now?: () => number }) {
  return { snapshot: async ({ scopeId }: { scopeId: unknown }) => buildMemoryReview(await workspace.getSnapshot(), { scopeId, now: now() }) };
}
