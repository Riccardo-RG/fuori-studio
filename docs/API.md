# HTTP API

## Operational self-knowledge

The existing owner session, exact-origin and Host checks apply to these read-only endpoints. They do not invoke a model or read arbitrary filesystem paths.

- `GET /api/system/knowledge?q=...` returns startup `identity`, `sourceChanged`, selected `topics`, `facts`, bounded source `evidence`, and `limitations`. The optional query is at most 12,000 characters. Identity includes package version, startup Git metadata when available, capture time, and a source digest. Changes on disk do not replace captured source text; restart the server to refresh it.
- `GET /api/system/source?path=...&start=...&end=...` returns an excerpt from an explicitly allowlisted startup source. `start` and `end` are one-based line numbers. Results include path, line range, digest, text and truncation status, capped at 60 lines and 6,000 characters. Unknown/private paths and invalid ranges return 404. No writes or arbitrary paths are supported.

Execution-preview steps additionally return `systemAwareness`, containing this knowledge plus allowlisted runtime facts: execution-specific authorized capabilities, applicable app-call allowances, configured provider, and observed local Codex account-limit windows when available. Account quotas are shared across that Codex account, not scoped to a studio agent or project; API, paired-worker and unavailable quota observations remain `null`. Monetary cost and unobserved model identity are unknown. Runtime usage aggregates the entire retained ledger for the current agent and scope, and the selected project when present. The single-use preview receipt covers this data; changed quota values, usage, budgets or technical-source status require a new preview. A quota refresh timestamp alone does not invalidate identical reviewed values; the dispatched packet retains the original reviewed observation time. Chat/task results retain a bounded provenance record in `execution.systemAwareness`; plan drafts and repository editor/reviewer results retain analogous records. See [operational self-awareness](SYSTEM_AWARENESS.md).

Base URL: `http://127.0.0.1:4386` (or the configured `PORT`). Local mode is single-user and loopback-only. In hybrid/online modes use the configured HTTPS origin; every owner endpoint below requires the authenticated owner session.

Owner writes use `POST` and `Content-Type: application/json`. Local mode requires `X-Fuori-Studio: local`; remote mode requires the session cookie, exact `Origin` and `X-CSRF-Token` from `/api/session`. The server rejects foreign hosts/origins and browser cross-site requests. Normal JSON bodies are limited to 120,000 bytes; portable import preview allows 16 MiB, device sync 8 MiB and other worker requests 600,000 bytes. Errors return `{ "error": "..." }` with an appropriate HTTP status. Corrupt stores fail closed. Concurrent configuration changes return `409`; callers should refresh rather than blindly retry a paid operation.

## Reads

| Endpoint | Response |
| --- | --- |
| `GET /api/studio` | Selected conversation, messages, `scopeId`, `workflowId`, `busy`, and leader connection status |
| `GET /api/workspace` | `{version, scopes, memories, workflows, memoryAssistant, syncTombstones, ...}` |
| `GET /api/session` | Public login status; authenticated responses include the page CSRF token |
| `GET /api/access` | Owner-only mode, redacted devices, selected target, storage and sync status |
| `GET /api/setup` | Owner-only readiness evidence, repository-worker availability and backup metadata |
| `GET /healthz` | Public minimal `{ok:true}` after host/origin checks; `503` when stopping or archive key-check fails |
| `GET /api/operations` | `{version, projects, tasks, routines, scheduler}` |
| `GET /api/providers` | Redacted `{version, connections, assignments, policies}`; never API keys |
| `GET /api/team/capabilities` | Owner-only `{version, profiles}` mapping stable agent IDs to curated specialties |
| `POST /api/team/capabilities` | `{id, profileId, expectedVersion}`; requires idle execution and returns updated preferences; no AI calls |
| `GET /api/search?scopeId=…&q=…&kinds=…&offset=0&limit=30` | Local scoped results, provenance, original targets, paging and partial-history indicator |
| `GET /api/search/original?scopeId=…&sourceScopeId=…&kind=…&id=…&conversationId=…` | Visibility-revalidated saved original, bounded blocks and truncation indicator |
| `GET /api/budgets` | Daily allowance, project/assignment lifetime limits and usage, defaults and unattributed calls |

A configured provider is not necessarily authenticated, funded or reachable. Codex availability uses a separate CLI login check. Provider token counts are reports, not billing reconciliation.

## Memory and conversations

`POST /api/workspace` accepts `{action, payload}`. Actions are `createScope`, `saveMemory`, `deleteMemory`, `saveWorkflow`, `deleteWorkflow`, `setMemoryPolicy`, `reviewMemoryCandidate`, `undoMemoryAction`; the response is a workspace snapshot. Existing-record saves can include `expectedVersion` for optimistic conflict detection (the UI supplies it).

```json
{
  "action": "saveMemory",
  "payload": {
    "scopeId": "business",
    "type": "decision",
    "title": "Product focus",
    "content": "Prioritize owned products.",
    "status": "proposed",
    "source": "User decision",
    "sharedWith": [],
    "agentIds": []
  }
}
```

`POST /api/conversation/scope {scopeId}` selects an existing scope. `POST /api/conversation/new {}` archives and resets the selected conversation.

`POST /api/chat {message, scopeId, workflowId?, repositoryAnalysisId?, previewId}` returns Server-Sent Events. Obtain the receipt from the execution preview first. Events include `message`, `status`, `context`, `memory`, `notice`, `error`, and `done`; each event is JSON in a `data:` frame. Scope, procedure, analysis identity and receipt are checked before streaming begins. Chat disconnect cancels its active request. A chat message does not create a persistent assignment. An optional `repositoryAnalysisId` selects the fixed, separately prepared analysis described below; it does not let a model select repositories or fetch new files.

Chat project focus comes only from the owner's execution preview. The selected real project's title and description are included for each authorized participant and calls count toward that project. The model cannot select or overwrite a project. New conversations have no project; legacy demo IDs and unavailable project references are ignored when restoring focus.

`POST /api/conversation/task-preview {scopeId,conversationId,messageId}` prepares an editable assignment from a saved user or assistant message, excluding the welcome message. It returns `{id,expiresAt,sourceDigest,title,brief,source,projects,agentIds,agentId}`. Projects are owned projects in the original scope; agent choices respect every inherited context reference. Drafts last fifteen minutes and are limited to twenty per server process. No AI call or budget reservation occurs.

`POST /api/conversation/task {draftId,projectId,title,brief,agentId}` saves exactly one queued task and returns `{taskId,operations}`. The source, scope, permissions and original evidence are revalidated. The full brief is limited to 16,000 characters; oversized messages are rejected without silently truncating their content. Original evidence remains in `task.inputContext` even if the brief is edited. Immutable `task.origin` identifies the source and receipt. Retrying the same receipt and normalized fields returns the existing task, including after restart; changed retry fields return `409`. Only unsaved drafts expire. Creation never starts the task: execution requires its own reviewed preview. Generic task creation rejects submitted provenance. See [conversation assignments](CONVERSATION_TASKS.md).

## Search

Search defaults to the supplied scope; `scopeId=*` explicitly searches all owner scopes. `kinds` is an optional comma-separated subset of `conversation,memory,decision,document,task,deliverable,repository,workflow`. Queries allow 300 characters and 32 terms; `limit` is 1–100 and `offset` is 0–100,000. The response includes `results`, `total`, `hasMore`, `partial` and `localOnly`. Memories/workflows follow explicit sharing; other records remain in their owning scope. Original retrieval checks visibility again. Supply `conversationId` for a conversation message. These GET routes neither start AI nor switch the active conversation. See [local search](SEARCH.md).

## Execution preview

`POST /api/execution/preview` requires owner mutation authorization and an idle studio, but makes no AI call. Its target is one of:

```text
{kind:"chat", message, scopeId, workflowId?, repositoryAnalysisId?, agentIds?, projectId?, inputValues?, expectedWorkflowVersion?, selection?}
{kind:"task", id, expectedVersion?, selection?}
{kind:"repository", id, expectedVersion, selection?}
{kind:"plan", projectId, brief, selection?}
```

`selection` accepts `excludeMemoryIds`, `excludeSourceIds` (at most 200 unique IDs each), and the chat-only `includeHistory` boolean. Chat defaults to the required `nova` coordinator; authorized specialist IDs may be selected explicitly. Project attribution must belong to the current scope. Exclusions never expand permissions or remove necessary inherited evidence.

For a repository analysis, `message.trim()` must equal its stored goal and `workflowId` must be absent or null. The three stages are fixed to `forge`, `growth`, then `nova`; arbitrary participant selection cannot change that order. History defaults to excluded and can be explicitly included with `selection.includeHistory:true`. Prepared repository sources are required evidence and cannot be excluded while reusing that analysis identity. The response includes `repositoryAnalysis` metadata and `requiredCalls:3`. Each stage exposes its actual provider/destination, sources and inherited evidence for review. Currently all three stages must use the built-in connection with both ID and type `codex`, targeting this computer. OpenAI API connections, other providers and paired workers are rejected rather than substituted. Local Codex execution still sends the reviewed context to OpenAI; it is not offline inference.

The response returns a ten-minute, single-use `previewId`, `expiresAt`, work identity, participating roles, prepared context/provenance, provider/destination details and an advisory call-budget preflight. Pass `previewId` to the matching chat, task start, repository start or plan draft request. The server rebuilds and compares the prepared plan before consuming the receipt. Missing, expired, mismatched or changed previews return `409` before dispatch; clients must refresh and review. Receipts are lost on server restart. Each actual dispatch still performs its own atomic budget reservation. See [execution preview](EXECUTION_PREVIEW.md).

## Projects and assignments

`POST /api/operations {action, payload}` exposes only these user-facing actions:

| Action | Payload |
| --- | --- |
| `createProject` | `{title, description?, scopeId, kind?: "owned" or "client", createScope?: boolean}` |
| `saveProject` | `{id, expectedVersion, title?, description?, scopeId?, kind?}` |
| `createTask` | `{projectId, title, brief?, agentId?, workflowId?, template?, inputValues?, expectedWorkflowVersion?}` |
| `approveTask` | `{id, expectedVersion, feedback?}` |
| `requestChanges` | `{id, expectedVersion, feedback}` |
| `restartTask` | `{id, expectedVersion}` |
| `createRoutine` | `{projectId, title, brief?, agentId?, workflowId?, inputValues?, expectedWorkflowVersion?, intervalHours?, nextRunAt?, enabled?}` |
| `updateRoutine` | `{id, expectedVersion, ...changedRoutineFields}` |

Responses are operations snapshots. IDs are generated by the server. Projects default to `owned`. With `createScope: true`, `scopeId` identifies the parent container; a dedicated project scope is created and its ID is stored on the project. With `false` or omission, the selected existing scope is used. Project names for dedicated scopes are limited to 100 characters. A project with tasks/routines cannot change scope.

Task steps come from the selected ready procedure, the built-in `template: "product-brief"` (brief → supplied-material analysis → product proposal → delivery), or the single-agent brief. A template and workflow ID cannot be combined. Clients cannot post internal step outputs or approve a task through a generated model response. Internal store actions such as `completeStep`, `submitArtifact`, `failTask` and `claimDueRoutine` are not HTTP-accessible.

`saveWorkflow` can include optional `inputFields`: up to four `{key,label,required,defaultValue}` definitions for `materials`, `objective`, `constraints`, and `deliverable`. When using a fielded workflow, supply raw `inputValues` and its current `expectedWorkflowVersion`; the server validates required/default values and compiles the trusted stored snapshot. `updateRoutine` accepts the same per-use fields when changing a workflow. Client-supplied compiled `workflowInputs` are not accepted. See [workflow field limits and substitution](WORKFLOW_FIELDS.md).

| Endpoint | Payload / behavior |
| --- | --- |
| `POST /api/tasks/run` | `{id, expectedVersion?, previewId}`; consumes the reviewed preview, preflights access, starts background work and returns a snapshot immediately |
| `POST /api/tasks/pause` | `{id, expectedVersion?}`; cancels the unfinished request and retains completed steps |
| `POST /api/tasks/memory` | `{id, title, content, type?: "pattern" or "decision"}`; creates a proposed note from a completed approved delivery; returns workspace snapshot |

```text
queued ──start──▶ running ──all steps saved──▶ review ──approve──▶ completed
                    │                          │
                    ├──pause/recovery──▶ paused│
                    └──error───────────▶ failed└──request changes──▶ queued

paused / failed ──resume──▶ running (keeps completed steps)
paused / failed / queued ──restart──▶ queued (clears all step outputs)
```

Each run has an internal execution token. Late results from a cancelled or previous run cannot update it. Artifacts retain sequential versions, decisions, feedback and context references. Requested changes preserve the old artifact and reset steps for a new version.

## Routines

Intervals are clamped to 1–720 hours. New routines default to disabled. Dates are ISO timestamps; browser forms convert local times to ISO. An enabled due routine atomically creates a **queued** task and moves the due time strictly into the future. Missed intervals coalesce. Scheduling runs every 30 seconds while the server runs. Tasks stay queued by default. Explicit governance opt-in can start enabled routine occurrences created after that opt-in, subject to daily call/run limits and scope/provider checks. Claimed occurrences are not automatically retried, and failures require manual attention. Unavailable procedures leave the routine due and expose a scheduler error.

## AI connections

`POST /api/providers {action, payload}` supports `saveConnection`, `deleteConnection`, `assignAgent`, and `setScopePolicy`. See [the provider contract](PROVIDERS.md#server-module-contract) for exact fields. `POST /api/providers/test {id}` explicitly performs a tiny potentially billable request with no project context.

Provider configuration and memory writes are blocked while chat, task or repository execution uses their snapshot. Every model call is checked against the active scope and the source scopes of its context. No automatic paid retry, destination fallback, arbitrary URL or user-defined header is accepted.

## Data record summaries

- Task: identity, project/scope, brief, responsible agent, optional procedure, status, ordered steps, artifact versions, bounded events, optimistic version and timestamps.
- Step: identity, title, agent, instruction, state, output, context evidence, provider/usage/duration metadata and optional error.
- Artifact: identity/version, title/content, creation time, review decision/feedback, context and per-step execution metadata.
- Routine: project, task template, cadence, next due time, enablement and version.

The UI must render record content as text, not executable HTML. A reference records supplied context; it is not a verified citation.

## Identity and paired devices

`GET /auth/login` starts OIDC. `GET /auth/callback` accepts only the cookie-bound single-use authorization response. `GET /auth/sessions` returns the owner's active sessions. `POST /auth/logout {}` revokes the current session; `POST /auth/sessions/revoke` accepts exactly one of `{id}`, `{all:true}`, `{others:true}`. These mutations require normal remote CSRF protection. The immutable configured issuer/subject identifies the sole owner.

`POST /api/devices {action,payload}` accepts:

- `pair`: `{name,scopeIds,capabilities:["execute","sync","repository"]}` (any nonempty subset), returns a one-time `{code,expiresAt,serverUrl}`. Available only in authenticated remote modes. Each capability is independent.
- `target`: `{id:"local"|deviceId}`. Remote mode requires a paired device for Codex; local execution is local-mode only.
- `revoke`: `{id}`. Stops future claims and rejects active late results without returning device credentials.

Workers use outbound HTTPS and `Authorization: Bearer <device-token>`, not owner cookies. `POST /api/device/pair {code}` consumes a pairing code and returns the sole copy of a scoped token. `/api/device/claim {}` returns one addressed job or `job:null`; `/heartbeat {id,lease}` renews its lease, `/result {id,lease,text|error}` completes it. `/disconnect {}` revokes that calling device and returns only `{ok:true}`. Device tokens cannot read owner APIs. Inputs and outputs are bounded; stale/replayed results return `409`.

## Assisted and portable memory

Policy mutation: `setMemoryPolicy {scopeId,expectedVersion?,mode:"manual"|"assisted"|"automatic",learningEnabled,automaticTypes:["preference"|"pattern"]}`. `reviewMemoryCandidate` accepts the candidate ID/current version, approve/reject decision, optional edited wording, and explicit conflict choice. `undoMemoryAction {id}` cannot overwrite a later version. Source-linked candidates arrive alongside an already authorized leader response; no extra extraction call is made.

`POST /api/memory/remember {scopeId,conversationId,messageId,sourceVersion?,title?,content?,type?}` looks up the stored user source and returns `{snapshot,memory,actionId}`. A posted source identifier never grants access to another conversation. Model candidate ingestion is an internal method, not an HTTP command.

Portable routes are owner-only and require an idle studio:

| Endpoint | Payload | Result |
| --- | --- | --- |
| `/api/memory/export` | `{scopeIds,format:"encrypted"|"json"|"markdown",passphrase?}` | `{filename,mime,content,counts,warnings}` for browser download |
| `/api/memory/preview-import` | `{content,passphrase?,targetScopeId}` | Private expiring `importId`, counts and preview items |
| `/api/memory/import` | `{importId}` | Workspace snapshot, imported/skipped counts; retry-safe receipt |

Encrypted exports need a passphrase of at least 12 characters. JSON/Markdown are plaintext. Only confirmed notes and ready procedures are exported; provider credentials, history, grants and revision archives are excluded. Import creates new proposed notes/draft procedures and never overwrites an existing record. See [portability](PORTABILITY.md).

## Knowledge synchronization

`POST /api/sync {action,payload}` supports `connect {url,code}`, `disconnect {}`, `configure {scopeIds}`, `run {}` and `resolve {id,expectedVersion,choice:"local"|"remote"}`. Connect requires an HTTPS origin and a code with sync capability. No scopes are enabled implicitly. Run is explicit; conflicts keep both texts and need review. Resolve updates the local choice; a following run reconciles it remotely without overwriting any intervening remote edit.

`POST /api/device/sync` is the scoped worker protocol. It exchanges current records, baseline hashes, selected scope metadata and tombstones. Revision history, sharing grants, memory policy and credentials are never replicated. A tombstoned record cannot reappear under the same ID; retain useful text through a new reviewed record instead. Corruption or incompatible protocols fail closed rather than partially importing unvalidated data.

## Repository work

`GET /api/repositories` returns capability metadata (`available`, `localAvailable`, `localOnly`), remote worker catalogs, registered repositories and lightweight runs. Local mode includes a suggested source path. Patch text and isolated checkout paths are not embedded in run lists. Remote workers expose aliases rather than their local filesystem paths.

`POST /api/repositories {action,payload}` accepts:

```text
register       { projectId, scopeId, path, checks: [{label, program, args}] }
register       { projectId, scopeId, executionTarget: deviceId, repositoryAlias }
refresh        { id, expectedVersion }
create         { repositoryId, title, brief }
start          { id, expectedVersion, previewId }
pause          { id, expectedVersion }
approve        { id, expectedVersion }
requestChanges { id, expectedVersion, feedback }
proposeMemory  { id, expectedVersion?, title, content, type: "decision" | "pattern" }
```

Start consumes the matching execution preview, durably claims one queued run and returns before execution completes. Raw `selection`, `contextSelection` or `previewPlan` cannot be posted to bypass preview. Poll the GET endpoint for stage/check/review updates. Revision creates a new queued run with a parent link and preserves the earlier artifact, context exclusions and original assignment budget. Approval checks the immutable patch hash and actual configured check results. It never publishes or merges. The memory response includes the workspace snapshot alongside the repository snapshot. `GET /api/repositories/patch?id=…` returns an authenticated text attachment; missing, corrupted or unavailable patches fail closed.

Remote registration gets its checks from the worker's local policy; browser paths and commands are refused. Refresh updates the recorded HEAD and policy after checking the worker. Creating or starting a remote run requires the current manifest and authorized scope.

Repository workers use these separate token-authenticated POST routes:

```text
/api/device/repositories/announce  { repositories: [...] }
/api/device/repositories/claim     {}
/api/device/repositories/heartbeat { id, lease, stage? }
/api/device/repositories/result    { id, lease, result? | error? }
```

Only `repository` capability accepts them. Results allow an 8 MiB request and carry the exact run, alias, policy hash, base commit, check manifest, patch and usage. A 30-second lease must be renewed; execution is bounded to thirty minutes. Delivery of the same completed receipt can be retried for twenty-four hours. A revoked device, expired lease or different result cannot complete the job. There is no reassignment or automatic edit retry. See [the worker protocol](REMOTE_EXECUTION.md).

## Learning reusable workflows

`POST /api/workflows/learn {action,payload}` requires owner mutation authorization and an idle studio. `preview` accepts `{taskId,expectedVersion}` and returns `{origin,truncated,workflow}` without saving anything or calling an AI service. Only the latest approved text delivery of a completed task qualifies. Brief and step instructions become editable workflow fields; model outputs, documents and memory contents are not copied.

`save` accepts `{taskId,expectedVersion,workflow:{title,description,input,output,steps,status,inputFields?}}` and returns `{snapshot,workflowId}`. Steps contain `{title,agentId,output}`; status is `draft` or `ready`. The server rechecks approval, task version and original context references. Restricted, unavailable or changed context blocks derivation. Scope and provenance are server assigned, and initial sharing is empty. Submitted scope, sharing, source or existing workflow identifiers are rejected. The resulting record uses the existing versioned workflow store and portability format. See [reusable workflows](PRODUCTIVITY.md) and [field definitions](WORKFLOW_FIELDS.md).

## Maintenance

`POST /api/maintenance {action:"backup"|"verify"}` requires the owner's mutation authorization and an idle studio. It returns the setup snapshot. `verify` checks the current archive; `backup` creates a new encrypted SQLite snapshot and verifies its records before recording the file digest. Neither action performs a restore.

`GET /api/maintenance/backup?id=…` downloads an owner-only encrypted attachment selected by its registered ID. Files are validated against encrypted metadata and never selected by a browser-supplied path. No encryption key is included. Restore and explicit backup removal are CLI-only operations; see [recovery](DEPLOYMENT_RECOVERY.md).

## Dependency plans

`POST /api/plans {action:"draft",payload:{projectId,brief,previewId}}` consumes the matching execution preview, makes one explicit coordinator call charged to the project, and returns a validated proposal with `id`, `title`, `nodes`, project ID and a fifteen-minute expiry. The proposal's expiry is separate from the preview receipt's ten-minute lifetime. Nodes contain a key, title, brief, responsible agent and ordered `dependsOn` keys. A proposal is not a task and does not authorize execution.

`POST /api/plans {action:"commit",payload:{id}}` atomically creates queued tasks from that exact proposal. It makes no AI call. Cycles, missing references, duplicate keys and invalid roles are rejected. Created tasks carry `planId`, `planTitle`, predecessor task IDs and inherited source evidence. Starting a dependent task requires each predecessor's latest delivery to be approved. Each original memory and document evidence set is revalidated before merging context references or dispatching a call. Fresh retrieval cannot conceal an older source version used to draft a task or predecessor result.

At most twenty proposals can await review; the limit is checked before a coordinator call. Uncommitted proposals expire or are lost on server restart. Committing claims the proposal once, preventing concurrent duplicate graphs; failed preflight restores it until expiry. Committed tasks persist in the operations archive.

## Limits and outcomes

`GET /api/governance?scopeId=...` returns settings, UTC period/reset, daily allowances, recorded usage, user feedback, `metrics` derived from actual task/repository records, and `insights` for project/procedure comparisons. The optional validated scope filters only `insights`; existing installation counters remain explicitly global. Omit it to compare all scopes. Insights aggregate the full retained ledger, not the last 200 display records. See [governance](GOVERNANCE.md).

`POST /api/governance {action:"configure",payload:{expectedVersion,dailyCallLimit,maxCallSeconds,autonomousRoutines,maxAutonomousRunsPerDay}}` saves limits while idle. Enabling autonomy establishes a server-side opt-in timestamp. Only enabled routine tasks created after that timestamp can start automatically.

`POST /api/governance {action:"saveOutcome",payload:{taskId|runId,helpful,minutesSaved?,note?,expectedVersion?}}` records feedback for an existing approved delivery. Exactly one entity ID is required. Missing minutes remain unknown, not zero. Both mutations return a refreshed governance snapshot.

`POST /api/budgets {action:"configureBudget",payload:{projectId,taskId?|runId?,callLimit,expectedVersion}}` sets a project or assignment lifetime ceiling while idle. Omit both assignment IDs for a project limit; otherwise supply exactly one. The server derives trusted scope and revision ancestry from stored records and checks project ownership. Limits allow 0–50,000 calls; version `0` creates a previously unconfigured limit. Defaults are 200 project calls and 12 assignment calls, enforced alongside the daily installation allowance. Failed and interrupted reservations remain charged; revisions do not reset usage. Missing token reports stay unknown. See [budgets and atomic enforcement](BUDGETS.md).

## Sources and read-only connectors

`GET /api/sources?scopeId=…` lists scoped source metadata, connector capabilities and import limits. `GET /api/sources/detail?scopeId=…&id=…` returns extracted segments and citation URLs; it does not return original PDF bytes or local path credentials.

`POST /api/sources {action,payload}` supports:

```text
importText     { scopeId, title, text, filename? }
importDocument { scopeId, title, filename, mimeType, dataBase64 }
importUrl      { scopeId, url, title? }
importGitHub   { scopeId, connectionId, repository, ref, path, title? }
importFolder   { scopeId, path }
refresh        { id, scopeId, version }
remove         { id, scopeId, version }
searchWeb      { scopeId, connectionId, query, domains?, consent: true }
```

Imports and refresh return `{source,segments,citationSources}`; research adds execution metadata. Folder import reports imported metadata and skipped entries. Removal returns the removed ID. Read the source list again after mutations. Source actions require an idle studio; research and URL/PDF work receive disconnect cancellation.

PDF/text uploads are bounded to 8 MiB input, 600,000 extracted characters and 200 PDF pages. The JSON HTTP ceiling is 12 MiB to accommodate base64. Text-based PDF extraction does not perform OCR. Local folder roots are the app directory, explicitly registered repositories and optional `FUORI_STUDIO_SOURCE_ROOTS`; remote mode cannot use local folder import. Connectors are read-only. URL retrieval permits bounded public HTTPS requests with DNS/redirect checks, not authenticated browsing or arbitrary endpoints.

Authenticated GitHub file import uses a separately configured connection, repository/scope allowlists and a selected ref/path. It resolves a commit, authenticates the blob SHA and records an immutable commit URL. Refresh rechecks the current connection permission and records a new source version. Imported snapshots remain until removed or expired; disconnecting the account prevents new reads but does not erase an intentionally imported copy.

## Authenticated GitHub

`GET /api/github` returns redacted connections and publication metadata. Tokens and reconstructed candidate file bodies are excluded. `POST /api/github {action,payload}` returns `{result,snapshot}` and requires owner mutation authorization plus an idle studio:

```text
save       { id?, expectedVersion?, name, token?, scopeIds, repositories, allowPublish }
disconnect { id, expectedVersion }
inspect    { connectionId, scopeId, repository }
checks     { connectionId, scopeId, repository, ref }
preview    { runId, connectionId, repository, baseBranch, title, body }
publish    { id, expectedVersion }
reconcile  { id, expectedVersion }
```

`checks` returns an ephemeral `{repository,ref,commitSha,fetchedAt,state,complete,checks,errors}` result. Each check includes `{id,source,name,state,url?}`. Missing results remain distinct from success; unavailable or truncated groups set `complete:false`. It performs at most three fixed-host GET requests and never starts or reruns a workflow. See [GitHub checks](GITHUB_CHECKS.md).

Repository names use `owner/repository`. Tokens are write-only, and publication permission is independent of read access. Preview requires a currently approved run, complete checks and the exact GitHub base; it makes no external writes. Publish creates an isolated branch and draft PR after explicit confirmation. Reconcile reads remote state after an uncertain result; it does not blindly resend writes. GitHub cannot atomically pin a PR's target branch against concurrent changes, so an advanced base is reported for renewed review. No merge endpoint is exposed. See [GitHub operation](GITHUB.md).

## Read-only repository analysis

Status: the backend/API and browser entry points are implemented, with injected-fixture and fake-provider verification. These checks do not establish that a real GitHub account or AI destination is configured or has been exercised. The browser entry points are **Analizza repository** in chat and **Confronta repository** in the GitHub panel. See [the analysis workflow and limits](REPOSITORY_ANALYSIS.md).

`POST /api/repository-analysis/prepare` accepts only:

```json
{
  "scopeId": "business",
  "goal": "Compare the selected products and recommend the next priorities.",
  "targets": [
    { "connectionId": "connection-id", "repository": "owner/product", "ref": "main" }
  ]
}
```

The owner mutation/CSRF boundary and idle-studio requirement apply. `scopeId` must be the current conversation's active operative scope. `goal` is nonempty and at most 6,000 characters. `targets` contains one to five distinct `owner/repository` names with explicitly authorized connection IDs; optional `ref` is a branch, tag or commit, otherwise the repository's default branch is resolved. Connection scope and repository grants are checked before reading and again before persistence. Preparation uses bounded fixed-host GitHub GET requests, makes no AI call and reserves no AI budget.

The response is `{id,scopeId,goal,createdAt,repositories}`. Each repository includes the resolved ref/commit, immutable URL, connection ID/version, coverage, file paths/blob hashes/line ranges/truncation flags, and the imported source's ID/scope/title/version/digest. It excludes credentials and duplicated source bodies. One bounded source document per repository is imported into the encrypted Sources archive as an atomic batch; analysis metadata is saved separately. Cancelling the later preview, disconnecting, or a metadata-write failure after source import does not roll back those documents. No files, branches, PRs or tests are written or executed on GitHub.

The scanner retains at most 4,000 tree entries and 12 file excerpts per repository, at most 2,000 characters per excerpt and 8,000 excerpt characters per repository. Assembled documents are bounded to 12,000 characters each and 50,000 characters across the selection. Coverage reports observed `treeEntries`, `eligibleFiles`, `readFiles`, `omittedFiles` and `treeTruncated`; it does not claim complete coverage of a truncated tree. The analysis ledger holds at most 40 preparations and refuses additional entries without evicting user documents.

After preparation, request a chat execution preview with the returned `repositoryAnalysisId`, the stored goal as `message`, and the same scope. Review each destination and all required source material, then pass the matching ID and receipt to `/api/chat`. The fixed sequence is technical analysis (`forge`), product/business analysis (`growth`), and synthesis (`nova`), with three model calls on a fully completed run. The preview and dispatch require the built-in `codex` connection on this computer; API connections including OpenAI, other providers and paired workers are not allowed for this mode. Nothing silently reassigns an agent or changes an execution target. A failed or cancelled stage stops later stages; completed messages remain recorded and no fallback or automatic retry occurs. Every actual dispatch still checks provider/source permissions and reserves its applicable call budget.

Connection grants/version and source current status/version/digest are revalidated when building or consuming the preview and before every stage. Changed or missing evidence invalidates reuse; a new preparation is required for a changed goal or refreshed code. Revoking the GitHub connection blocks reuse of the prepared analysis but does not delete already imported local sources. Generic Sources retrieval retains its normal local-snapshot semantics until those documents are removed. History is excluded by default; opting in remains subject to the normal scope, source and handoff checks. `importTextBatch` is an internal source-store operation and is not a public `/api/sources` action.

## Memory evaluation

`GET /api/evaluations?scopeId=…` returns cases, ordered results, owner feedback, candidate metadata and a summary of current measurements. It never calls an AI. `POST /api/evaluations {action,payload}` accepts:

```text
saveCase   { id?, expectedVersion?, scopeId, title, query, agentId, expectedIds, forbiddenIds }
runCase    { id, expectedVersion }
removeCase { id, expectedVersion }
feedback   { memoryId, memoryVersion, expectedVersion?, helpful, note? }
```

Case mutations return the scoped evaluation snapshot. Feedback returns `{saved:true}`; refresh the GET endpoint afterwards. Positive labels must be confirmed and accessible for the selected scope/agent. Negative labels may identify owner-visible notes from other scopes without copying their contents into the evaluated context. Changed labels produce `needs-review`; historical results are excluded from current aggregates. Removing a case removes its run history. See [measurement definitions](MEMORY_EVALUATION.md).


## Daily action queue and memory maintenance

- `GET /api/today?scopeId=business&projectId=...` returns `generatedAt`, selected scope/project, available projects, counts and groups (`review`, `interrupted`, `running`, `ready`, `waiting`), upcoming routines and a stale-source count. Scope is required; `*` explicitly selects all scopes. Optional `projectId` must belong to a displayed scope. Groups retain full counts but display at most 12 items each; routine preview displays at most 8. Each item points to its existing task or repository detail; no route here starts or changes work. `ready` means queued with approved task dependencies, not a guarantee that provider, context or budget preflight will pass. See [Today](TODAY.md).
- `GET /api/memory/review?scopeId=business` returns a read-only review of notes owned by exactly that active scope: `summary`, conservative `duplicates`, and confirmed `aging` notes not updated for at least 90 days. It excludes linked notes owned elsewhere, uses no AI and makes no merge/delete/status changes. Missing or malformed scope is 400; unknown/archive scope is 403. See [memory review](MEMORY_REVIEW.md).

Both endpoints use the existing owner/session, host and origin boundary. They do not accept mutations, contact providers or change call usage.
