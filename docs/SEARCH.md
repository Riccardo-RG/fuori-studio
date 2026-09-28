# Local studio search

Studio search retrieves saved work without an AI provider, embeddings, external requests, or usage charges. Open **Search the studio** or press **Command/Ctrl + Shift + F**. Search starts in the active conversation scope. Enter a few words, select a content type if useful, and open a result to read its saved original and provenance.

## What is searched

- Current and archived conversations, including messages from conversations replaced with **New conversation**. Welcome messages are excluded.
- Memories and decisions, including proposed records with their status clearly shown.
- Imported document passages, pasted text, saved pages, GitHub sources, and saved research. Stale documents remain searchable and are marked as needing refresh; this does not make them eligible for agent context.
- Task briefs and saved deliverable versions, with their project and approval status.
- Repository run briefs, summaries, reviews, decisions, and changed filenames. Search does not read worktrees, execute commands, or regenerate patches.
- Saved workflow descriptions, inputs, steps, and outputs.

Search matches every entered term, ignores case and accents, and supports literal word fragments. Terms can match across a record's title, body, and displayed source metadata. Title matches rank ahead of body matches; exact phrase matches receive a bonus. Equal scores use the saved update time and a stable record key. Ranking never asks a model to judge relevance. A result is a saved record, document, or conversation message, rather than an inferred answer.

## Scope boundaries

Conversations, documents, tasks, deliverables, and repository runs are visible only in their owning scope. Memories and workflows also follow their existing explicit sharing rules: records in **Shared profile** and records whose `sharedWith` list names the selected scope are included. Parent and child scopes do not inherit access. A shared record retains its original scope and is labelled as shared in the result.

**All scopes** is an explicit selector choice for this single-owner studio. It is never the initial search scope. Search uses the existing authenticated owner routes; the scope selector is an information boundary inside that owner's archive, not a multi-user permission system.

Original retrieval checks current scope visibility again. A memory whose sharing was withdrawn after a search cannot be retrieved through the old result. Search never changes sharing permissions, selected conversation, confirmed memory, task state, or AI context.

## Originals and navigation

Every result opens a read-only preview retrieved from its owning store. The preview displays scope, record version/status, dates, and relevant source details. Document previews retain page or line references. Conversation previews identify the conversation and message, highlight the matching message, and show nearby messages. Archived conversations remain readable without replacing the active chat.

**Open in studio** navigates supported current results to the existing conversation, memory/workflow editor, source viewer, task, or repository review. Deliverables link to their parent task. Archived conversation results stay in their original preview. Saved HTTP(S) sources also provide a separate external link, opened only when selected.

## Limits and failure behavior

- Queries: at most 300 characters and 32 distinct terms.
- Results: 30 per UI page; the API allows 1–100 and offsets up to 100,000.
- Conversation enumeration: up to 5,000 matching conversations and 10,000 history records scanned. A partial-history notice appears if this bound is reached, including when the searched portion has no matches. No unseen records are implied to be absent.
- Document and record original previews: up to 120,000 characters. Conversation previews show up to 12 neighbouring messages on each side, with each message capped at 60,000 characters. Truncated previews are labelled.
- All other stored collections retain their existing archive limits. Search runs on demand against the current stores; there is no separate persistent plaintext index or cache to become stale.

A failed store read returns an error rather than a deceptively complete empty search. The user can retry. Search input is debounced, superseded reads are cancelled in the browser, and stale responses cannot overwrite a newer query. Expired sessions close the search and clear its displayed data. Imported/user text is escaped before rendering; it cannot become HTML or instructions.

Encrypted history is enumerated using `archive.entries('chat/history/', { offset, limit })`. Enumeration decrypts existing records in memory, with namespace validation and a maximum of 1,000 records per internal page. It does not enumerate migration copies. Conversation `list` and `original` methods use existing reads rather than the mutating load/select/reset path. Legacy file reads reject symbolic links and oversized files. Startup migration remains owned by the existing conversation lifecycle. Document search uses `sources.searchSnapshot({ scopeIds })` to validate the requested scopes once and read their saved passages in a single archive read; unselected source bodies are not returned to the search service.

## Integration

```js
const search = createStudioSearch({
  workspace: workspaceStore,
  conversations,
  sources,
  operations: operationsStore,
  repositories: repositoryWork,
});
```

Authenticated read-only routes:

- `GET /api/search?scopeId=business&q=launch&kinds=memory,decision&offset=0&limit=30`
- `GET /api/search/original?scopeId=business&sourceScopeId=business&kind=conversation&id=MESSAGE_ID&conversationId=CONVERSATION_ID`

`scopeId=*` requests all scopes explicitly. Omit `kinds` to search every supported type. The search response includes `results`, `total`, `offset`, `limit`, `hasMore`, `partial`, and `localOnly`. Each result carries a typed `target`, provenance, and the original retrieval URL. The original route returns `result`, `blocks`, and `truncated` and never accepts a filesystem path or external URL to fetch.

The frontend `createSearchPanel({ onOpenOriginal })` exposes `open({ scopeId, scopes, query? })`, `setContext({ scopeId, scopes })`, `close()`, and `dispose()`. The optional navigation callback receives the complete result, including `result.target`; it should resolve to `false` only if navigation could not be completed. The search stylesheet uses the studio's theme variables, native modal keyboard focus, responsive layouts, and reduced-motion preferences. English copy is provided by `dist/locales/search.en.js` through the central i18n dictionary.

## Focused verification

```sh
node --test test/search.test.mjs test/search-conversations.test.mjs test/search-sources.test.mjs test/search-http.test.mjs test/conversations.test.mjs
```

Tests cover every content kind, archived originals, encrypted history after restart, read-only enumeration, scope and explicit-sharing boundaries, withdrawal of sharing, all-scope opt-in, deterministic accent-insensitive matching, paging, invalid input, symlink rejection, and safe snippet markup. They use local fixtures and never call a paid provider.
