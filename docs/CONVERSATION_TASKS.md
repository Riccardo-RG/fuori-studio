# Queued assignments from saved conversation messages

A saved user or assistant message can become an owner-reviewed assignment for an owned project in the message's scope. Welcome messages are excluded. The owner reviews the project, title, complete brief, and responsible agent before saving. Saving creates one queued text assignment; its existing execution preview and explicit start remain required.

Use **Create task** below a saved chat message. The dialog retains edits across language changes and permission refreshes, and can create an owned project in the same scope without losing the brief. A changed source requires explicitly restarting from the updated message. After saving, the task shows its inherited context and offers **Read the original**, which opens the saved source reader without replacing the active conversation; archived messages remain readable.

The chat's project focus also follows the real project selected in its execution preview. Every authorized participant receives that project's title and description. The coordinator no longer invents a project from the old demonstration catalog, and the UI restores the last reviewed selection for the next message in the same conversation.

Drafting and saving make no provider request, consume no AI-call reservation, and do not require a configured provider. Provider permissions, including policies of shared memories' original scopes, are checked by the normal executor before a subsequent run.

## HTTP contract

Both endpoints use the existing authenticated owner/device policy, local CSRF protection, mutation lock, and idle guard.

`POST /api/conversation/task-preview`

```json
{"scopeId":"business","conversationId":"saved-conversation-id","messageId":"saved-message-id"}
```

The response contains `id`, `expiresAt`, `sourceDigest`, `title`, `brief`, `source`, `projects`, `agentIds`, and `agentId`. `source` contains only `scopeId`, `conversationId`, `messageId`, source `agentId`, and source `createdAt`; the latter two may be null. `projects` contains current owned projects in the source scope. `agentIds` lists agents allowed to receive every referenced memory and workflow. The default `agentId` is the source agent if eligible, otherwise Nova if eligible, otherwise the first eligible agent.

The title is a proposed excerpt of the first line; the entire saved message is preserved as the initial brief. Messages longer than 16,000 characters are rejected rather than silently shortened. The preview is in memory only, expires after 15 minutes, and retains at most 20 outstanding receipts, evicting the oldest when necessary. No task is written. The source is read from its saved current or archived conversation without changing the active conversation. A renewed preview has a new receipt; compare `sourceDigest` before preserving edits from an earlier draft.

`POST /api/conversation/task`

```json
{"draftId":"preview-receipt-id","projectId":"owned-project-id","title":"Reviewed title","brief":"Reviewed complete brief","agentId":"forge"}
```

The response is `{taskId, operations}`, where `operations` is the current operations snapshot. The request accepts no scope override, custom steps, workflow, evidence, provenance, execution flags, or source content. Title and brief limits are 160 and 16,000 characters. The assignment has one pending step and `status: "queued"`.

## Provenance and inherited context

Before creating a task, the server rereads the saved message and checks its identity, full source digest, operational scope, destination ownership/scope, and responsible agent. Missing, revised, expired, withdrawn, forgotten, or inaccessible source evidence blocks creation. Sources must still match their original scope, version, and digest. Memories must retain their version and confirmed status; workflows must retain their version and ready status. Legacy single `context.workflow` references are also retained in the normalized `workflows` list.

The server preserves the entire normalized original evidence in `task.inputContext`, even if the reviewed brief omits the original material. Each later execution step inherits and revalidates that evidence. Context exclusion controls cannot strip evidence already embedded in the source. Removing words from a brief therefore cannot broaden recipients or bypass source-scope provider policies.

The server also atomically saves immutable `task.origin`:

```text
kind: "conversation"
receiptId: preview receipt ID
scopeId, conversationId, messageId: saved source identity
sourceDigest: SHA-256 of canonical full source identity, role, agent, timestamp, text and context
requestDigest: SHA-256 of canonical normalized projectId, title, brief and responsible agentId
agentId: source agent ID or null
createdAt: source timestamp or null
```

Origin contains no copied source title or private memory content. Generic HTTP task creation cannot supply `origin` or `inputContext`, and the internal `createConversationTask` mutation is not exposed through `/api/operations`.

## Retries and recovery

Each receipt can create exactly one task. Task and provenance are persisted in one operations mutation; the store independently enforces unique receipts. A repeated save with the same normalized fields returns the existing task without another write, including after a lost response, receipt expiry, process restart, or later removal of the original message. A changed retry returns 409. This recovery path acknowledges an existing task and does not create or run new work.

Unsaved receipts disappear when the server restarts and must be renewed. A definite source/eligibility conflict requires a refreshed preview. On an uncertain network response, retain and retry the same receipt and exact request rather than immediately generating another receipt.

## Verification

`test/conversation-tasks.test.mjs` covers complete source preservation, editable drafts, saved/archived/user messages, stale and withdrawn evidence, agent visibility, ownership, bounded receipts, durable concurrent retries, internal provenance protection, and inherited executor/provider guards. `test/conversation-tasks-http.test.mjs` verifies the routes, CSRF boundary, protected internal mutation, restart retry, and zero model calls using disposable fixture storage.
