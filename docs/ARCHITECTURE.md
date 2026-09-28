# Architecture and stack decisions

Status: implemented single-owner local/hybrid architecture, 2026-09-28.

## Runtime and dependency policy

Use **Node.js 24 LTS**, native ECMAScript modules, native HTTP/fetch, and the Node test runner. Node's official [release policy](https://nodejs.org/en/about/previous-releases) recommends supported LTS releases for production. `.nvmrc`, package engines and CI select the same major. Three.js and the maintained openid-client OIDC implementation are pinned in the lockfile. Three.js is copied locally during installation; authentication protocols are not implemented from scratch.

The browser uses modular JavaScript, semantic HTML and CSS, plus an isolated Three.js scene. Keeping this working client avoids introducing a second UI runtime or rewriting the scene while the domain model is changing. The server exposes narrow JSON endpoints with runtime validation, rather than sharing unvalidated browser objects with model adapters.

This is a deliberate stack for a local application, not a claim that one framework is universally best. A typed component framework is a possible future UI migration if state complexity outgrows these modules. That migration must preserve contracts, accessibility and end-to-end tests; a framework switch alone does not establish quality. The established adapters and browser remain JavaScript. New planning, governance and source services use strict TypeScript; Node 24 executes erasable types without a separate build. `tsc --noEmit` checks these modules in CI. This is an incremental migration: it does not claim that every JavaScript module is statically checked. Runtime validation still protects external inputs.

## Module boundaries

```text
Browser (app / knowledge / operations / world)
          │ local HTTP JSON + chat SSE
          ▼
server.mjs — identity/CSRF enforcement, request validation, configuration lock, scheduler
          ├─ chat.mjs — scoped history + leader/specialist conversation
          ├─ executor.mjs — task execution, provenance, recovery boundaries
          ├─ workspace.mjs / context.mjs — scoped memory and procedures
          ├─ operations.mjs — project/task state machine and versions
          ├─ providers.mjs — credentials, policy, normalized model responses
          │      └─ codex.mjs — local Codex process adapter
          ├─ repository-work.mjs / repository-runtime.mjs — isolated code and captured checks
          ├─ repository-devices.ts / repository-worker.ts — scoped remote work and durable receipts
          ├─ github.ts / github-patch.ts — fixed-host account access and exact reviewed publication
          ├─ deployment.ts / maintenance.ts — readiness, secret mounts and verified backups
          ├─ memory-evaluations.ts — owner-labeled retrieval measurements and feedback
          ├─ plans.ts / governance.ts — dependencies, call reservations and measured outcomes
          ├─ sources.ts — bounded source ingestion, provenance and retrieval
          ├─ identity.mjs / devices.mjs — owner sessions and paired execution
          ├─ memory-assistant.mjs / portability.mjs — source-linked capture and portable packages
          ├─ sync.mjs — selective knowledge replication and conflicts
          └─ archive.mjs / instance-lock.mjs — encrypted SQLite and single-process ownership
```

The orchestration engine and provider store have injectable dependencies for deterministic tests. Provider adapters produce `{text, usage, provider, durationMs}`. They do not decide project state or approve output. The operations store enforces legal transitions and uses a fresh execution token on each run, rejecting late output from cancelled runs.

## Persistence decision

The production stores persist validated domain snapshots in a versioned SQLite database through `archive.mjs`. Each payload is authenticated AES-256-GCM ciphertext bound to its record name and revision. Full-synchronous WAL transactions cover record writes, batch operations and atomic workspace imports. Conversation reset archives the old thread and creates its replacement in one transaction. A single process lock owns the data directory; domain queues serialize mutations. Test factories can still use isolated legacy JSON fixtures.

Database schema migration uses `user_version`. Validated legacy JSON is retained inside encrypted migration records before plaintext files are retired. Missing keys, corruption and divergent sources fail closed. Backup uses SQLite's online backup API while the application is stopped for a coherent domain snapshot. The local key file is a documented fallback, not an OS keychain. Remote deployments require an external master key.

This remains a bounded single-owner architecture. SQLite records are not a distributed multi-tenant data model: project creation plus creation of a dedicated scope still spans domain operations and can leave an unused scope if the second operation fails. Do not run several server processes or share the data directory over a network filesystem. A hosted multi-tenant product would require per-tenant authorization and a separately designed relational data model, rather than turning on open registration.

The Node SQLite API is isolated in one adapter and exercised on the selected Node 24 runtime; application-level validation and tests do not imply a security certification. Avoid introducing Redis, a vector service or a workflow platform without a demonstrated need. Embeddings cannot replace retrieval authorization.

## Execution semantics

Only one durable assignment runs at a time; its ordered steps may use different configured services. Chat can delegate up to three independent specialist replies, but chat and a task do not start concurrently through the HTTP API. Each completed task step is persisted before the next starts. Browser disconnection does not cancel tasks; chat streaming disconnection cancels that chat turn.

Pause cancels the current provider request and retains completed steps. Resume reruns the unfinished step, which can incur a new provider charge. No exactly-once remote execution guarantee exists if a provider completed a request before local interruption. There is no automatic paid retry or provider fallback.

Every provider call checks scope policy and all inherited context dependencies. A delivery is assembled from completed step outputs and enters `review`. User approval changes it to `completed`; requested changes queue a new run and retain previous artifact versions.

## Scheduling

Every 30 seconds while the server is running, enabled due routines atomically create queued assignments and advance their next due time. Missed intervals coalesce into one queued occurrence rather than replaying a backlog. By default the routine does not start a model call. Explicitly enabled autonomy can start new eligible routine tasks after a durable occurrence claim and within daily call/run limits. Preflight failures pause work for manual attention; automatic claims are not retried. Closing the browser does not stop the server; stopping the server stops scheduling. There are no webhook, OS wake, desktop notification or always-on guarantees.

## Quality gates

- Syntax checks discover application modules automatically, excluding vendored code.
- Unit tests cover archive validation, revisions, transitions, policy enforcement and redaction.
- Integration tests exercise the HTTP boundary, isolated task/chat context, restart, recovery and invalidated handoffs using disposable data.
- Browser verification covers the real local UI, review/revision flow and small-screen overflow.
- CI repeats automated checks with an isolated workspace and no user credentials.

## Current limitations

No multi-tenant accounts, arbitrary browser control, embeddings, estimated-dollar accounting or hard monetary spend caps. Repository editing is local and sandboxed; configured checks are explicit executable code. Public GitHub and URL connectors are read-only. Live research uses the authorized OpenAI web-search tool only. Hosted identity needs a real OIDC application and HTTPS deployment; passkeys are delegated to the identity provider. Knowledge sync is explicitly initiated and does not replicate independent chat/task histories. Local inference without a network provider is not implemented.

## Hybrid and portability contracts

The cloud controller owns its workspace and may queue a Codex request for a specifically paired computer. The computer polls outbound HTTPS and keeps its local Codex login. Leases are renewed, expired work is not automatically reassigned, and results are accepted once. Device grants are checked for all prompt source scopes. API providers remain separately configured execution destinations.

Knowledge synchronization performs a record-level three-way merge against saved hashes. Conflicting edits and deletion-versus-edit cases remain reviewable. Tombstones survive reconnection and re-pairing; local sharing grants and revision history never travel. Explicit copy/restore creates a new record with review. The remote browser can access the same full hosted workspace; this is different from synchronizing two independent installations.

Portable packages contain selected confirmed memories and ready procedures. Readable JSON/Markdown is useful to other tools. Encrypted packages use a separate user passphrase, not the installation master key. Import previews are private and expire; atomic import receipts make retries idempotent. Imported notes and procedures require local review before retrieval or execution.

## Localization boundary

The browser uses explicit Italian/English catalogs and native `Intl` formatting. UI language is a per-browser preference, independent of identity and stored knowledge. Literal application markup is translated before opaque user data is substituted; language updates do not reload the page or start AI work. See [Localization](LOCALIZATION.md) for contributor rules and preserved data boundaries.

Team display names are stored in a versioned `team-profiles` encrypted record. Owner-only updates use the existing context mutation lock, require idle execution and reject stale revisions. Prompt role selection and authorization continue to use fixed agent IDs; user-supplied display names are explicitly data. No name changes are replicated through selective memory synchronization.
