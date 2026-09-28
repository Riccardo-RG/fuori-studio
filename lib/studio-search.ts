/** Deterministic, local retrieval over the existing archive. No embedding/provider calls. */
export const SEARCH_KINDS = ['conversation', 'memory', 'decision', 'document', 'task', 'deliverable', 'repository', 'workflow'] as const;
export type SearchKind = typeof SEARCH_KINDS[number];
type Scope = { id: string; name: string };
type RecordBase = { id: string; scopeId: string; title?: string; createdAt?: string; updatedAt?: string; version?: number; status?: string };
type Memory = RecordBase & { type: string; content: string; source?: string; sharedWith?: string[] };
type Workflow = RecordBase & { description?: string; input?: string; output?: string; source?: string; steps?: { title?: string; output?: string }[]; sharedWith?: string[] };
type Message = { id: string; text: string; role: string; agentId?: string; createdAt?: string; welcome?: boolean };
type Conversation = RecordBase & { messages: Message[]; archived: boolean };
type Artifact = { id: string; title?: string; content: string; createdAt?: string; version?: number; decision?: string };
type Task = RecordBase & { brief?: string; projectId: string; artifacts?: Artifact[] };
type Run = RecordBase & { brief?: string; summary?: string; baseCommit?: string; repositoryId: string; review?: { text?: string }; decision?: { feedback?: string; status?: string }; files?: { path: string }[] };
type Source = RecordBase & { filename?: string | null; url?: string | null; kind: string; retrievedAt?: string; digest?: string };
type Segment = { text: string; page?: number | null; lineStart?: number | null; lineEnd?: number | null };
type WorkspaceSnapshot = { scopes: Scope[]; memories: Memory[]; workflows: Workflow[] };
export interface SearchOptions {
  workspace: { getSnapshot(): Promise<WorkspaceSnapshot> };
  conversations: { list(input: { scopeIds: string[] }): Promise<{ conversations: Conversation[]; truncated: boolean }>; original(input: { scopeId: string; conversationId: string }): Promise<Conversation> };
  sources: { allMetadata(): Promise<Source[]>; detail(input: { scopeId: string; id: string }): Promise<{ source: Source; segments: Segment[] }>; searchSnapshot?(input: { scopeIds: string[] }): Promise<{ source: Source; segments: Segment[] }[]> };
  operations: { getSnapshot(): Promise<{ tasks: Task[]; projects: { id: string; title: string; scopeId: string }[] }> };
  repositories: { snapshot(): Promise<{ runs: Run[]; repositories: { id: string; name?: string; path?: string }[] }> };
}
export interface SearchInput { scopeId: string; query: string; kinds?: string[]; offset?: number; limit?: number }
export interface OriginalInput { scopeId: string; kind: string; id: string; sourceScopeId?: string; conversationId?: string }
export interface SearchTarget { kind: SearchKind; id: string; scopeId: string; conversationId?: string; messageId?: string; taskId?: string; archived?: boolean }
export interface SearchResult {
  key: string; kind: SearchKind; title: string; snippet: string; scopeId: string; scopeName: string;
  updatedAt: string | null; status: string | null; version: number | null;
  provenance: { sharing: 'scope' | 'shared' | 'explicit'; source?: string; filename?: string; url?: string; page?: number; lineStart?: number; lineEnd?: number; conversationId?: string; messageId?: string; archived?: boolean; projectTitle?: string; commit?: string };
  target: SearchTarget; originalUrl: string;
}
type Entry = Omit<SearchResult, 'snippet' | 'originalUrl'> & { body: string; segments?: Segment[]; blocks: Block[] };
type Block = { label: string; text: string; role?: string; id?: string; createdAt?: string };
const fail = (message: string, statusCode = 400) => Object.assign(Error(message), { code: statusCode === 404 ? 'NOT_FOUND' : 'SEARCH_INVALID', statusCode, status: statusCode });
const str = (value: unknown) => typeof value === 'string' ? value : '';
const combine = (...values: unknown[]) => values.map(str).filter(Boolean).join('\n\n');
const normalize = (value: string) => value.normalize('NFKD').replace(/\p{M}/gu, '').toLocaleLowerCase('en');
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const visible = (record: RecordBase & { sharedWith?: string[] }, scopeId: string) => scopeId === '*' || record.scopeId === scopeId || record.scopeId === 'shared' || record.sharedWith?.includes(scopeId);
const exactScope = (record: { scopeId: string }, scopeId: string) => scopeId === '*' || record.scopeId === scopeId;
const safeURL = (value: unknown) => { try { const url = new URL(str(value)); return ['http:', 'https:'].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } };
function identifier(value: unknown): string { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(value)) throw fail('Identificativo di ricerca non valido.'); return value; }
function validateScope(snapshot: WorkspaceSnapshot, scopeId: string) { if (scopeId !== '*' && !snapshot.scopes.some(scope => scope.id === identifier(scopeId))) throw fail('Ambito non trovato.', 404); }
function selectedKinds(kinds?: string[]): SearchKind[] {
  if (kinds === undefined) return [...SEARCH_KINDS];
  if (!Array.isArray(kinds) || !kinds.length || kinds.length > SEARCH_KINDS.length || kinds.some(kind => !SEARCH_KINDS.includes(kind as SearchKind))) throw fail('Tipi di ricerca non validi.');
  return [...new Set(kinds)] as SearchKind[];
}
function snippet(text: string, terms: string[], max = 260): string {
  const compact = text.replace(/\s+/g, ' ').trim(), folded = normalize(compact);
  const positions = terms.map(term => folded.indexOf(term)).filter(index => index >= 0), at = positions.length ? Math.min(...positions) : 0;
  // Accent folding can change indices slightly; context padding retains the match.
  const start = Math.max(0, at - 70), end = Math.min(compact.length, start + max);
  return `${start ? '…' : ''}${compact.slice(start, end)}${end < compact.length ? '…' : ''}`;
}
function score(entry: Entry, terms: string[], phrase: string): number {
  const title = normalize(entry.title), body = normalize(entry.body), source = normalize(combine(entry.provenance.source, entry.provenance.filename, entry.provenance.projectTitle));
  if (!terms.every(term => title.includes(term) || body.includes(term) || source.includes(term))) return 0;
  return terms.reduce((sum, term) => sum + (title.includes(term) ? 8 : 0) + (body.includes(term) ? 2 : 0) + (source.includes(term) ? 1 : 0), 0) + (title.includes(phrase) ? 12 : 0) + (body.includes(phrase) ? 3 : 0);
}
export function createStudioSearch({ workspace, conversations, sources, operations, repositories }: SearchOptions) {
  function base(snapshot: WorkspaceSnapshot, selectedScope: string, kind: SearchKind, record: RecordBase & { sharedWith?: string[] }, title: string, body: string, target: Partial<SearchTarget> = {}): Entry {
    return { key: `${kind}:${target.conversationId ? target.conversationId + ':' : ''}${record.id}`, kind, title: title || record.id, body, scopeId: record.scopeId, scopeName: snapshot.scopes.find(scope => scope.id === record.scopeId)?.name || record.scopeId, updatedAt: record.updatedAt || record.createdAt || null, status: record.status || null, version: record.version || null, provenance: { sharing: record.scopeId === selectedScope || selectedScope === '*' ? 'scope' : record.scopeId === 'shared' ? 'shared' : 'explicit' }, target: { kind, id: record.id, scopeId: record.scopeId, ...target }, blocks: [{ label: 'content', text: body }] };
  }
  async function collect(snapshot: WorkspaceSnapshot, scopeId: string, kinds: SearchKind[]): Promise<{ entries: Entry[]; partial: boolean }> {
    const entries: Entry[] = []; let partial = false;
    for (const memory of snapshot.memories) {
      const kind = memory.type === 'decision' ? 'decision' : 'memory';
      if (!kinds.includes(kind) || !visible(memory, scopeId)) continue;
      const entry = base(snapshot, scopeId, kind, memory, str(memory.title), memory.content); entry.provenance.source = memory.source;
      entry.blocks = [{ label: 'content', text: memory.content }, { label: 'source', text: str(memory.source) }]; entries.push(entry);
    }
    if (kinds.includes('workflow')) for (const workflow of snapshot.workflows.filter(record => visible(record, scopeId))) {
      const body = combine(workflow.description, workflow.input, ...(workflow.steps || []).map(step => combine(step.title, step.output)), workflow.output);
      const entry = base(snapshot, scopeId, 'workflow', workflow, str(workflow.title), body); entry.provenance.source = workflow.source; entries.push(entry);
    }
    if (kinds.includes('conversation')) {
      const found = await conversations.list({ scopeIds: snapshot.scopes.filter(scope => scopeId === '*' || scope.id === scopeId).map(scope => scope.id) }); partial ||= found.truncated;
      for (const conversation of found.conversations) {
        if (!exactScope(conversation, scopeId)) continue;
        const firstUser = conversation.messages.find(message => message.role === 'user' && !message.welcome)?.text;
        for (const message of conversation.messages.filter(item => !item.welcome)) {
          const entry = base(snapshot, scopeId, 'conversation', { ...conversation, id: message.id, createdAt: message.createdAt || conversation.createdAt }, str(firstUser || message.text).replace(/\s+/g, ' ').slice(0, 120), message.text, { conversationId: conversation.id, messageId: message.id, archived: conversation.archived });
          entry.provenance.conversationId = conversation.id; entry.provenance.messageId = message.id; entry.provenance.archived = conversation.archived;
          entries.push(entry);
        }
      }
    }
    if (kinds.includes('document')) {
      const scoped = sources.searchSnapshot ? await sources.searchSnapshot({ scopeIds: snapshot.scopes.filter(scope => scopeId === '*' || scope.id === scopeId).map(scope => scope.id) })
        : await Promise.all((await sources.allMetadata()).filter(source => exactScope(source, scopeId)).map(metadata => sources.detail({ id: metadata.id, scopeId: metadata.scopeId })));
      for (const { source, segments } of scoped) {
        if (!exactScope(source, scopeId)) continue;
        const entry = base(snapshot, scopeId, 'document', { ...source, updatedAt: source.retrievedAt }, str(source.title), segments.map(segment => segment.text).join('\n\n'));
        entry.segments = segments; entry.provenance.filename = source.filename || undefined; entry.provenance.url = safeURL(source.url); entries.push(entry);
      }
    }
    if (kinds.includes('task') || kinds.includes('deliverable')) {
      const state = await operations.getSnapshot();
      for (const task of state.tasks.filter(item => exactScope(item, scopeId))) {
        if (kinds.includes('task')) { const entry = base(snapshot, scopeId, 'task', task, str(task.title), str(task.brief)); entry.provenance.projectTitle = state.projects.find(project => project.id === task.projectId)?.title; entries.push(entry); }
        if (kinds.includes('deliverable')) for (const artifact of task.artifacts || []) {
          const entry = base(snapshot, scopeId, 'deliverable', { ...artifact, scopeId: task.scopeId, status: artifact.decision }, str(artifact.title || task.title), artifact.content, { taskId: task.id });
          entry.provenance.projectTitle = state.projects.find(project => project.id === task.projectId)?.title; entries.push(entry);
        }
      }
    }
    if (kinds.includes('repository')) {
      const state = await repositories.snapshot();
      for (const run of state.runs.filter(item => exactScope(item, scopeId))) {
        const entry = base(snapshot, scopeId, 'repository', run, str(run.title), combine(run.brief, run.summary, run.review?.text, run.decision?.feedback, ...(run.files || []).map(file => file.path)));
        entry.provenance.commit = run.baseCommit; entry.blocks = [{ label: 'brief', text: str(run.brief) }, { label: 'result', text: str(run.summary) }, { label: 'review', text: str(run.review?.text) }, { label: 'decision', text: str(run.decision?.feedback || run.decision?.status) }]; entries.push(entry);
      }
    }
    return { entries, partial };
  }
  function result(entry: Entry, scopeId: string, terms: string[]): SearchResult {
    const { body, segments, blocks: _blocks, ...record } = entry;
    const best = segments?.map(segment => ({ segment, matches: terms.filter(term => normalize(segment.text).includes(term)).length })).sort((a, b) => b.matches - a.matches)[0]?.segment;
    if (best) record.provenance = { ...record.provenance, page: best.page || undefined, lineStart: best.lineStart || undefined, lineEnd: best.lineEnd || undefined };
    const query = new URLSearchParams({ scopeId, sourceScopeId: entry.scopeId, kind: entry.kind, id: entry.target.id });
    if (entry.target.conversationId) query.set('conversationId', entry.target.conversationId);
    return { ...record, snippet: snippet(best?.text || body || entry.provenance.source || '', terms), originalUrl: `/api/search/original?${query}` };
  }
  return {
    search: async ({ scopeId, query, kinds, offset = 0, limit = 30 }: SearchInput) => {
      if (typeof query !== 'string' || query.length > 300 || query.includes('\0')) throw fail('Usa al massimo 300 caratteri per la ricerca.');
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw fail('Limiti di ricerca non validi.');
      const selected = selectedKinds(kinds), snapshot = await workspace.getSnapshot(); validateScope(snapshot, scopeId);
      const phrase = normalize(query.trim()), terms = [...new Set(phrase.match(/[\p{L}\p{N}_-]+/gu) || [])];
      if (terms.length > 32) throw fail('Usa al massimo 32 parole per la ricerca.');
      if (!terms.length) return { results: [], total: 0, offset, limit, hasMore: false, partial: false, kinds: selected, scopeId, query: query.trim(), localOnly: true };
      const collected = await collect(snapshot, scopeId, selected);
      const ranked = collected.entries.map(entry => ({ entry, score: score(entry, terms, phrase) })).filter(item => item.score > 0).sort((a, b) => b.score - a.score || lexical(b.entry.updatedAt || '', a.entry.updatedAt || '') || lexical(a.entry.key, b.entry.key));
      return { results: ranked.slice(offset, offset + limit).map(({ entry }) => result(entry, scopeId, terms)), total: ranked.length, offset, limit, hasMore: offset + limit < ranked.length, partial: collected.partial, kinds: selected, scopeId, query: query.trim(), localOnly: true };
    },
    original: async ({ scopeId, kind, id, sourceScopeId, conversationId }: OriginalInput) => {
      identifier(id); const selected = selectedKinds([kind]), snapshot = await workspace.getSnapshot(); validateScope(snapshot, scopeId);
      if (sourceScopeId !== undefined) { identifier(sourceScopeId); validateScope(snapshot, sourceScopeId); }
      if (kind === 'conversation') {
        const originalScope = sourceScopeId || scopeId;
        if (originalScope === '*' || (scopeId !== '*' && originalScope !== scopeId)) throw fail('Originale non trovato in questo ambito.', 404);
        const conversation = await conversations.original({ scopeId: originalScope, conversationId: identifier(conversationId) });
        const index = conversation.messages.findIndex(message => message.id === id && !message.welcome);
        if (index < 0) throw fail('Messaggio non trovato.', 404);
        const start = Math.max(0, index - 12), selectedMessages = conversation.messages.slice(start, index + 13);
        const entry = base(snapshot, scopeId, 'conversation', { ...conversation, id }, str(conversation.messages.find(message => message.role === 'user')?.text || conversation.messages[index].text).replace(/\s+/g, ' ').slice(0, 120), conversation.messages[index].text, { conversationId: conversation.id, messageId: id, archived: conversation.archived });
        entry.provenance.archived = conversation.archived; entry.provenance.conversationId = conversation.id; entry.provenance.messageId = id;
        return { result: result(entry, scopeId, []), blocks: selectedMessages.map(message => ({ label: 'message', text: message.text.slice(0, 60000), role: message.role, id: message.id, createdAt: message.createdAt })), truncated: selectedMessages.length < conversation.messages.length || selectedMessages.some(message => message.text.length > 60000), totalMessages: conversation.messages.length };
      }
      const found = (await collect(snapshot, scopeId, selected)).entries.find(entry => entry.target.id === id && (!sourceScopeId || entry.scopeId === sourceScopeId));
      if (!found) throw fail('Originale non trovato in questo ambito.', 404);
      const blocks = found.segments ? found.segments.map(segment => ({ label: 'passage', text: segment.text, page: segment.page, lineStart: segment.lineStart, lineEnd: segment.lineEnd })) : found.blocks.filter(block => block.text);
      let remaining = 120000, truncated = false;
      const bounded = blocks.flatMap(block => { if (remaining <= 0) { truncated = true; return []; } const text = block.text.slice(0, remaining); truncated ||= text.length < block.text.length; remaining -= text.length; return [{ ...block, text }]; });
      return { result: result(found, scopeId, []), blocks: bounded, truncated };
    },
  };
}
