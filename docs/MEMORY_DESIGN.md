# Hybrid memory and context

## One archive, explicit scopes

The base scopes are Business (**Imprenditoria**), Development (**Sviluppo**), Consulting (**Consulenza**), Personal (**Personale**), Shared profile (**Profilo condiviso**) and Legacy conversation (**Conversazione iniziale**). Owned projects normally get a dedicated child scope. Consulting clients can also have their own spaces.

A scope's parent is organizational only. A project under Business does not automatically receive Business notes. Each record can explicitly grant access to additional scopes through `sharedWith`. The Shared profile is globally available, so only deliberately general information should be stored there. Sharing does not anonymize a note.

## Records and retrieval

A memory has a title, content, source, type (`fact`, `preference`, `decision`, `pattern`), status (`proposed`, `confirmed`), version, scope, optional agent allowlist, and revision history. Empty `agentIds` means all agents authorized by the scope rules. Proposals never enter model prompts. Confirmation expresses the user's decision to use a note; it is not independent fact verification.

Retrieval selects at most eight authorized confirmed notes using deterministic lexical relevance, reserving room for preference/decision constraints. Content excerpts and workflow fields are bounded; truncated excerpts are marked. This memory selector is separate from the document-source service. It does not perform vector search or load every document into a prompt.

Each response or task step records its context references, including versions. References propagate through previous generated outputs. Removing, changing, or withdrawing a referenced note prevents an old dependent response from entering a new chat prompt. Existing visible history and copies already sent to providers are not erased.

## Handoffs and provider destinations

An instruction or intermediate output may paraphrase a source. Recipient access is therefore checked against all transitive references, not just the newly selected notes. A restricted coordinator note can prevent delegation to an unauthorized specialist. A multi-step task preflights its planned handoffs and checks again before each call.

An external provider must be permitted both for the active scope and for every source scope of referenced memories/procedures. Sharing a note into another project does not silently change where that note may be sent. Default provider access is local Codex only; an explicit empty allowlist denies all services.

The server blocks memory/provider changes while work is actively using a context snapshot. A paused task can become invalid if its source context changes. Resume then refuses the old dependencies; restart the assignment from its first step, or create a new assignment when its procedure changed.

## Procedures

Procedures contain input requirements, ordered agent steps, expected outputs, versions, sources and scope sharing. Only `ready` procedures can be used. Initial examples are editable drafts, not previously executed work.

Attaching a procedure to **chat** supplies instructions. Selecting one when creating an **assignment** snapshots its bounded step instructions into persisted executable steps. Those steps currently perform analysis and text drafting only. The executor verifies that the ready procedure still matches the task before running it; material edits require a new assignment.

## Learning from accepted work

A completed, approved text delivery or repository patch can produce an editable pattern/decision proposal. It keeps task/version or run/patch provenance, stays in the original scope, and preserves the intersection of source-note agent restrictions. It is never automatically confirmed or shared. Each original memory, procedure and document reference is checked before context references are combined, so later retrieval cannot hide an obsolete source version.

A user can intentionally curate a new generalized note after reading an output. This is an explicit new record; the application does not provide automatic anonymization or retroactive deletion of user-copied text.

## Assisted memory capture

Each scope has a versioned policy: **Manual**, **Assisted** (the default), or **Automatic** with an explicit allowlist of `preference` and/or `pattern`. The separate `learningEnabled` switch stops inferred proposals and automatic saving without deleting conversation history or disabling a deliberate user save. Shared profile and Legacy do not receive automatic capture.

The coordinator can return up to three `memoryCandidates` alongside its normal structured answer. There is no second inference request, background extraction call, or hidden provider fallback. Providers returning the previous response shape remain compatible. Candidate output uses some of the normal response token budget.

The model supplies only a title, type, content and quote. The server retrieves the actual latest user message, checks its conversation and scope, derives its message ID and SHA-256 content version, and requires content and quote to be identical verbatim substrings of that message. Invented source IDs, extra sharing fields, paraphrases, unsupported facts and oversized batches are rejected. A digest verifies correspondence to the stored source; it does not establish factual truth.

Accepted candidates enter a separate review inbox and are excluded from retrieval. Users can edit, approve or reject them. The inbox shows the source quote, scope, sensitivity flag and possible existing-note conflicts. Conflict matching is deterministic lexical/title matching, not a guarantee of semantic contradiction detection. A detected conflict requires an explicit choice to keep both or replace a specific current version. Replacement preserves that note's existing agent and scope restrictions.

Automatic saving is deliberately narrow. It requires an opted-in type, no detected sensitivity or conflict, an ordinary direct preference or recurring-pattern statement in supported Italian/English forms, and a quote equal to the entire latest user message. Quoted fragments from another person's statement, uncertain claims and memory/permission instructions stay pending. Facts and decisions always require review. Secret and sensitivity detection are conservative heuristics rather than an exhaustive classifier; Assisted is the default precisely because language is ambiguous.

An explicit **Remember** action can save a current user message directly into its selected scope, with optional user edits and a visible undo action. It verifies immutable message/conversation IDs and, when supplied, a source content version. Assistant outputs remain available through the existing user-curated note editor; they are not treated as new user facts automatically.

## Versions, undo and forgetting

Approval, policy changes and undo enforce version checks. Undo cannot overwrite a later edit. Replacing a note and undoing that replacement create successive versions. Removing a newly saved note removes its associated action/proposal copies. Secret-like strings are rejected from new and edited notes; provider credentials belong to service connections.

Rejected proposals retain a suppression hash for both their normalized content and source message. Deleting a note also suppresses its previous revision contents, removes related candidate/action copies and clears conflict previews. These hashes prevent repeated extraction from the same source or equivalent text. They are local metadata and are not exported with portable memory. An explicit later user save can intentionally create new knowledge.

Deletion also creates a durable synchronization tombstone, so an offline or newly paired device cannot recreate a deleted record under its old ID. Memory portability imports are different: they require preview and explicit confirmation, use new IDs and remain proposed/draft. See [PORTABILITY.md](PORTABILITY.md).

Forgetting a note does not remove the user's original visible conversation, erase copies already sent to an AI provider, or rewrite historical backups. The next prompt excludes generated responses dependent on withdrawn note versions. Restoring an old full backup is an explicit restoration of its historical state and must be handled separately from current-state synchronization.

## Storage and limits

The running application stores the versioned workspace and per-scope conversations in the encrypted SQLite archive. Legacy JSON stores are validated and migrated through the archive adapter; store factories still support JSON-only fixtures for isolated tests. The original mixed conversation is preserved and imported only into Legacy. There are no invented user memories on first launch.

Workspace limits: 200 scopes, 2,000 memories, 300 procedures, 12 steps per procedure, 2,000 assisted candidates/actions, 20,000 suppression hashes/tombstones, and an 8 MiB serialized workspace. Writes are serialized, validated and committed atomically. Corruption fails closed rather than resetting an archive. The server uses an exclusive data-directory ownership lock. A workspace remains one trusted owner space; authentication does not turn record scope labels into independent customer tenancy.

The API keeps policy/review/undo mutations under `/api/workspace`; verified explicit saves use `/api/memory/remember`. Candidate ingestion and synchronization/import transaction helpers are internal store methods, not arbitrary user-selected workspace mutation actions. Tests cover source spoofing, stale messages, cross-scope capture, no-learning, sensitive/secret content, duplicates, conflicts, undo after edits, deletion suppression, synchronization tombstones, encrypted export and idempotent proposed imports.

## Documents and execution evidence

Sources are stored separately from memories. Importing a PDF, URL, GitHub snapshot or folder file does not turn its statements into confirmed facts. Retrieval uses bounded current extracts from the exact active scope, retaining source ID, version, content digest and page/line references. Documents do not inherit scope sharing from the global profile or parent projects.

Conversation history and dependent deliverables retain source references. A changed, stale or deleted document invalidates reuse of affected context; an old generated answer cannot quietly reintroduce it. Repository and text delivery memory actions also validate source evidence before proposing a new decision. The owner's deliberate memory review remains the point at which a reusable pattern is accepted. Source collections are not included in portable-memory packages or selective knowledge sync.
