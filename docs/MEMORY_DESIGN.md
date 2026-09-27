# Hybrid memory and context

## One archive, explicit scopes

The base scopes are Business (**Imprenditoria**), Development (**Sviluppo**), Consulting (**Consulenza**), Personal (**Personale**), Shared profile (**Profilo condiviso**) and Legacy conversation (**Conversazione iniziale**). Owned projects normally get a dedicated child scope. Consulting clients can also have their own spaces.

A scope's parent is organizational only. A project under Business does not automatically receive Business notes. Each record can explicitly grant access to additional scopes through `sharedWith`. The Shared profile is globally available, so only deliberately general information should be stored there. Sharing does not anonymize a note.

## Records and retrieval

A memory has a title, content, source, type (`fact`, `preference`, `decision`, `pattern`), status (`proposed`, `confirmed`), version, scope, optional agent allowlist, and revision history. Empty `agentIds` means all agents authorized by the scope rules. Proposals never enter model prompts. Confirmation expresses the user's decision to use a note; it is not independent fact verification.

Retrieval selects at most eight authorized confirmed notes using deterministic lexical relevance, reserving room for preference/decision constraints. Content excerpts and workflow fields are bounded; truncated excerpts are marked. This is not vector search or a full-document knowledge base.

Each response or task step records its context references, including versions. References propagate through previous generated outputs. Removing, changing, or withdrawing a referenced note prevents an old dependent response from entering a new chat prompt. Existing visible history and copies already sent to providers are not erased.

## Handoffs and provider destinations

An instruction or intermediate output may paraphrase a source. Recipient access is therefore checked against all transitive references, not just the newly selected notes. A restricted coordinator note can prevent delegation to an unauthorized specialist. A multi-step task preflights its planned handoffs and checks again before each call.

An external provider must be permitted both for the active scope and for every source scope of referenced memories/procedures. Sharing a note into another project does not silently change where that note may be sent. Default provider access is local Codex only; an explicit empty allowlist denies all services.

The server blocks memory/provider changes while work is actively using a context snapshot. A paused task can become invalid if its source context changes. Resume then refuses the old dependencies; restart the assignment from its first step, or create a new assignment when its procedure changed.

## Procedures

Procedures contain input requirements, ordered agent steps, expected outputs, versions, sources and scope sharing. Only `ready` procedures can be used. Initial examples are editable drafts, not previously executed work.

Attaching a procedure to **chat** supplies instructions. Selecting one when creating an **assignment** snapshots its bounded step instructions into persisted executable steps. Those steps currently perform analysis and text drafting only. The executor verifies that the ready procedure still matches the task before running it; material edits require a new assignment.

## Learning from accepted work

A completed, approved delivery can be used to prepare an editable pattern/decision proposal. It keeps task/version provenance, stays in the task's scope, and preserves the intersection of source-note agent restrictions. It is never automatically confirmed or shared. Source notes must still be available at the recorded versions.

A user can intentionally curate a new generalized note after reading an output. This is an explicit new record; the application does not provide automatic anonymization or retroactive deletion of user-copied text.

## Storage and limits

`workspace.json` holds versioned records; conversations are separate per-scope files. The original mixed conversation is preserved and imported only into Legacy. There are no invented user memories on first launch.

Workspace limits: 200 scopes, 2,000 memories, 300 procedures, 12 steps per procedure, 8 MiB archive. Writes are serialized, validated and atomically replaced. Corruption fails closed rather than resetting an archive. The server uses an exclusive data-directory ownership lock. This remains single-process JSON persistence, not a transactional multi-user database.
