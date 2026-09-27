# Architecture and stack decisions

Status: implemented local architecture, 2026-09-27.

## Runtime and dependency policy

Use **Node.js 24 LTS**, native ECMAScript modules, native HTTP/fetch, and the Node test runner. Node's official [release policy](https://nodejs.org/en/about/previous-releases) recommends supported LTS releases for production. `.nvmrc`, package engines and CI select the same major. Three.js is pinned by the lockfile and copied locally during installation.

The browser uses modular JavaScript, semantic HTML and CSS, plus an isolated Three.js scene. Keeping this working client avoids introducing a second UI runtime or rewriting the scene while the domain model is changing. The server exposes narrow JSON endpoints with runtime validation, rather than sharing unvalidated browser objects with model adapters.

This is a deliberate stack for a local application, not a claim that one framework is universally best. A typed component framework and TypeScript would be appropriate when UI/state complexity outgrows these modules. That migration must preserve contracts, accessibility and end-to-end tests; a framework switch alone does not establish quality. The current codebase is JavaScript and is **not** statically type-checked.

## Module boundaries

```text
Browser (app / knowledge / operations / world)
          │ local HTTP JSON + chat SSE
          ▼
server.mjs — request validation, local access, configuration lock, scheduler
          ├─ chat.mjs — scoped history + leader/specialist conversation
          ├─ executor.mjs — task execution, provenance, recovery boundaries
          ├─ workspace.mjs / context.mjs — scoped memory and procedures
          ├─ operations.mjs — project/task state machine and versions
          ├─ providers.mjs — credentials, policy, normalized model responses
          │      └─ codex.mjs — local Codex process adapter
          └─ conversations.mjs / instance-lock.mjs — durable local ownership
```

The orchestration engine and provider store have injectable dependencies for deterministic tests. Provider adapters produce `{text, usage, provider, durationMs}`. They do not decide project state or approve output. The operations store enforces legal transitions and uses a fresh execution token on each run, rejecting late output from cancelled runs.

## Persistence decision

Each store validates a versioned JSON archive and uses serialized atomic replacement with private file permissions. The process lock prevents independent server instances writing the same data directory. Invalid archives are preserved and fail closed. An interrupted run becomes paused after startup, keeping completed steps.

This design is inspectable and sufficient for the current bounded, single-user process. It is not a substitute for database transactions, query indexes, append-only audit storage or multi-process locks across distributed machines. Event history is bounded. Creating a project plus its dedicated scope spans two archives; a failed second write may leave an unused scope, never a silently discarded memory archive.

**Migration gate:** adopt SQLite transactions and schema migrations for growing local datasets/background workers; use PostgreSQL with tenant-aware authorization if hosting multiple users. Do not add Redis, a vector database or a workflow platform before their requirements exist. Node's built-in SQLite API is still marked release candidate in the [current Node 24 documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html); this delivery does not depend on it or claim to use SQLite.

## Execution semantics

Only one durable assignment runs at a time; its ordered steps may use different configured services. Chat can delegate up to three independent specialist replies, but chat and a task do not start concurrently through the HTTP API. Each completed task step is persisted before the next starts. Browser disconnection does not cancel tasks; chat streaming disconnection cancels that chat turn.

Pause cancels the current provider request and retains completed steps. Resume reruns the unfinished step, which can incur a new provider charge. No exactly-once remote execution guarantee exists if a provider completed a request before local interruption. There is no automatic paid retry or provider fallback.

Every provider call checks scope policy and all inherited context dependencies. A delivery is assembled from completed step outputs and enters `review`. User approval changes it to `completed`; requested changes queue a new run and retain previous artifact versions.

## Scheduling

Every 30 seconds while the server is running, enabled due routines atomically create queued assignments and advance their next due time. Missed intervals coalesce into one queued occurrence rather than replaying a backlog. The routine does not start a model call. Closing the browser does not stop the server; stopping the server stops scheduling. There are no webhook, OS wake, desktop notification or always-on guarantees.

## Quality gates

- Syntax checks discover application modules automatically, excluding vendored code.
- Unit tests cover archive validation, revisions, transitions, policy enforcement and redaction.
- Integration tests exercise the HTTP boundary, isolated task/chat context, restart, recovery and invalidated handoffs using disposable data.
- Browser verification covers the real local UI, review/revision flow and small-screen overflow.
- CI repeats automated checks with an isolated workspace and no user credentials.

## Current limitations

No remote-user authentication, encrypted key vault, repository tools, browsing tools, embeddings, arbitrary tool execution, estimated-dollar accounting, hard spend caps, or full agent runtimes for external API providers. These are explicit capabilities to design and test before adding, not hidden behind a “connected” badge.
