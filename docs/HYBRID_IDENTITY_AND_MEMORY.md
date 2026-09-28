# Hybrid access and assisted memory

Status: **implemented core, with explicit deployment limits**. Reviewed on 27 September 2026 against the primary documentation below. The comparison is documentary research, not an installed-product benchmark or security certification.

The app supports a complete local installation, optional OIDC authentication for one hosted owner, encrypted SQLite records, paired Codex computers, source-linked assisted memory, portable knowledge packages and manually initiated scope synchronization. Setting up an external identity application, HTTPS hosting and deployment secrets remains an operator responsibility. No cloud account, purchase or external deployment is created by installing the repository.

| Design area | Delivered behavior | Deliberate boundary |
| --- | --- | --- |
| Identity | OIDC exact-owner login, protected/revocable sessions | One owner per installation; no multi-tenant signup or teams |
| Secrets | Authenticated encrypted records, external hosted master key | Local file key fallback; no native keychain or end-to-end encryption claim |
| Paired runtime | Scoped one-use pairing, outbound worker, leases/revocation | Codex text adapter; no generic remote shell or tool runtime |
| Memory | Assisted default, opt-in safe categories, review/undo/suppression | Literal current-user evidence; no autonomous inferred fact consolidation |
| Sync | Explicit scope grants, current memories/procedures, conflicts and tombstones | Manual initiation; no cross-installation conversation/task replication |
| Portability | Readable scoped export and encrypted reimportable package | No credentials, sharing grants or entire conversation archive |

The following principles describe the rationale; where they discuss broader future options, this delivery table and the module guides define the actual capabilities. See [identity](IDENTITY.md), [security](SECURITY.md), [memory](MEMORY_DESIGN.md) and [portability](PORTABILITY.md).

## 1. Separate three identities

1. **Studio account:** the configured owner's identity, sessions and authorized devices. Multi-user workspace membership is not implemented.
2. **Execution device:** a particular local or remote worker with a revocable identity and a restricted set of capabilities.
3. **AI connection:** the provider account/API credential an authorized worker may use for a particular scope and role.

Signing into the studio must not silently authorize a new provider, upload local credentials or give a device access to every project. AI subscriptions and API credentials remain provider-specific.

The implementation uses maintained OIDC support and revocable sessions; passkeys, MFA and account recovery belong to the selected identity provider. Dedicated step-up verification for sensitive application changes is a future control, not an implemented guarantee. Authorization must be enforced on the server for every workspace record, object download and worker request. A UI scope picker is not an authorization boundary. Browser sessions should use secure cookie-based handling appropriate to the deployment, with CSRF protection and deliberate expiry/revocation. Local-only use can remain available without a cloud account.

Passkeys and session protections follow the [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html) and [session-management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html). The application uses `openid-client`; the operator selects a compatible OIDC identity provider. This review does not establish one identity vendor as universally best.

## 2. One product, three deployment choices

| Mode | Data placement | Execution and access |
| --- | --- | --- |
| Local | Projects, history, memory and connection settings stay on the selected computer | Local browser; selected AI services may still receive authorized prompts over the internet |
| Hybrid | A hosted studio owns its records; optional synchronization copies selected knowledge to or from an independent local installation | Signed-in dashboard, server-side API calls and an explicitly paired Codex text worker |
| Online | Hosted workspace and encrypted server archive, with operator-managed backups | Configured API calls run on the server; Codex still needs an available paired computer |

Local storage is not synonymous with offline inference. True offline generation requires a separately supported local model runtime; the current provider adapters do not supply it. Remote sign-in views the hosted studio's full authorized workspace, while knowledge sync transfers selected notes/procedures between independent installations. It does not replicate conversations, task history or document sources. Local repository execution is unavailable in remote modes and on paired text workers.

For hybrid access, pair a computer explicitly using a short-lived challenge and confirmation on the owning account/device. Give the paired worker a revocable, narrowly scoped identity and use an authenticated encrypted connection initiated from the device, rather than exposing its local HTTP port. Codex's existing login stays with the worker; it is not copied into the cloud. A runtime's login flow must remain officially supported by that runtime.

An offline worker must appear offline. Local jobs wait or fail with a clear state; they must not silently switch to a cloud provider or upload files. Cloud jobs can proceed only with the credentials and data already authorized for their selected execution target. Cross-device scheduling needs claims/leases, idempotency keys and stale-result rejection; these do not guarantee exactly-once effects in an external system.

Synchronization is a record-level feature, not copying `.local/` into a shared folder. Use stable record IDs, versions, deletion markers and explicit conflict handling. Both local and hosted single-owner installations now use the encrypted transactional SQLite archive. A shared multi-tenant database would require a separate authorization and storage design. Permissions and confirmed decisions must not use blind last-write-wins merges. Test reconnection, device revocation, concurrent edits, deletion propagation and backup restoration before enabling online use.

Provider keys are stored in encrypted application records. Local mode uses a private file key when no external master key is supplied; hosted operation requires an external master key. Native OS credential-store integration remains a future improvement. Keep keys out of prompts, browser persistence, synchronized memory and logs. Encryption in transit and at rest does not make a hosted orchestration service end-to-end encrypted or unable to read the data it processes. Do not make that claim without a different, verified key-management design.

## 3. Automatic capture is different from trusted memory

Keep four distinct records:

- **History and events:** messages, task results and explicit user actions. Saving that an artifact was approved is not proof that every sentence in it is true.
- **Durable knowledge:** useful facts, preferences, constraints and decisions, each with a source and an explicit scope.
- **Procedures:** reusable methods with inputs, steps and outputs; patterns extracted from one success are proposals, not automatically proven procedures.
- **Working context:** the bounded selection provided to an agent for one request. It is rebuilt from authorized current records rather than equated with the entire archive.

Recommended default: **assisted memory**. Extract a small number of candidates automatically and show a nonblocking inbox such as “3 things worth remembering.” Pending candidates are excluded from durable cross-conversation retrieval until approved. Their original messages can still appear in the source conversation's ordinary authorized history.

| Input | Recommended action |
| --- | --- |
| The explicit **Remember** control for a stored user message | Save within the selected authorized scope and show wording with undo; a chat sentence alone is not backend authorization |
| A clear recurring preference without an explicit save request | Propose by default; optionally save automatically when that category and scope have been enabled by the user |
| A hypothesis or inferred behavioral pattern | Curate it manually as a proposal; current assisted extraction accepts literal user evidence, not model-inferred facts |
| A possible replacement for a confirmed decision | Present the old and new wording and request a choice; retain supersession/version history |
| A bridge from personal context into business or a shared profile | Require explicit sharing approval; importance alone never widens access |
| Password, API key, access token or similar secret | Exclude from ordinary memory and direct the user to the connection/credential flow |

Provide per-scope modes: **Manual**, **Assisted** (default), and **Automatic for selected categories**. Global profile changes and cross-scope sharing keep separate controls. The implemented non-learning switch stops extraction for the selected scope. Its UI must separately explain whether history is still saved; a non-learning switch is not a promise of provider-side deletion or zero retention.

## 4. Extraction, consolidation and retrieval

Candidates should include source message/artifact IDs and versions, wording, type, scope, timestamp, sensitivity, whether the source is a user statement or a model inference, and the proposed operation. The server determines ownership and checks all permissions; model-produced IDs, instructions and confidence scores do not grant authority.

The application validates a candidate, removes duplicates, checks contradictions and routes it through the selected memory policy. Extract a few durable items after meaningful milestones, rather than processing every keystroke. Prefer returning candidates alongside an already authorized response where feasible. Extra background model calls require a configured budget/consent policy and must use a provider authorized for all source material; never send private data to a different “cheap extraction model” silently.

Accepted notes retain provenance and version history. Notes support edit/forget, while source-linked capture actions support version-checked undo. Memory pinning, background consolidation and automatic note expiry are not implemented; document sources have a separate expiry policy. Time-sensitive durable notes still need manual review. Deletion and revocation must invalidate dependent summaries and retrieval indexes so an old summary cannot silently recreate a forgotten note. Backup retention and copies already sent to providers require separate, honestly described handling.

Retrieval applies workspace, scope, agent, provider and record-version permissions before assembling context. Search can later combine lexical and semantic retrieval, but adding embeddings is not a substitute for authorization or correction. Display which notes and procedures were supplied to a response. Retrieved text remains evidence/data, not instructions that can change system rules.

## 5. Verified reference patterns

These observations inform our design; our approval policy is not claimed to be the default behavior of these products.

- **Paperclip** documents local trusted, authenticated private and authenticated public deployment. It separates platform access and provider connections. Its cloud-sync page explicitly retires the old host-to-host sync in favor of import/export: that is not evidence of continuous offline synchronization. [Deployment](https://docs.paperclip.ing/reference/deploy/overview/), [multi-user login](https://docs.paperclip.ing/how-to/enable-multi-user-login/), [Cloud Sync](https://docs.paperclip.ing/experimental/cloud-sync/).
- **OpenClaw** documents a gateway controlling state and remote nodes/tools, with private remote access patterns. That supports separating control from execution; our paired-device protocol is tested independently. [Remote access](https://docs.openclaw.ai/gateway/remote).
- **Claude** documents automatically maintained memory, explicit remember/edit/delete controls and separate project memory. Its page includes legacy behavior alongside the newer experience, so feature timing/defaults should not be generalized across every deployment. [Chat search and memory](https://support.claude.com/en/articles/11817273-use-claude-s-chat-search-and-memory-to-build-on-previous-context).
- **Codex** documents local memory as a separate store from ChatGPT memory, with controls for whether a chat can consume or contribute to memory. Background generation can wait for idle chats and account for remaining quota. These product capabilities do not automatically become features of our CLI adapter. [Memories](https://learn.chatgpt.com/docs/customization/memories).
- **LangMem/LangGraph** distinguish semantic, episodic and procedural memory, plus extraction during execution or in background. Persistent interrupts can implement human review, but the application must design its review policy. [Memory concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).
- **Letta** documents agent-managed durable memory and background consolidation. Its “Agent reviews before applying” setting means AI review, not human approval. Versioned memory helps inspect changes without certifying truth. [Memory and dreaming](https://docs.letta.com/configuration/memory), [MemFS](https://docs.letta.com/concepts/memfs).
- **Mem0** documents inferred extraction and a separate Platform Dream capability for supersession, merging and optional synthesis. Additive ingestion should not be confused with an absence of later consolidation; standard reads may still include superseded facts. [Add](https://docs.mem0.ai/core-concepts/memory-operations/add), [Dream](https://docs.mem0.ai/platform/features/dream).

We do not need to adopt all of these frameworks or services to implement the useful patterns. Any proposed dependency should demonstrate an advantage on our own privacy, correction, latency and cost tests.

## 6. Delivered core and remaining validation

1. Assisted proposals, review and deletion suppression are implemented. Measure precision, duplicate/conflict rates and correction effort on representative owned-product work.
2. Encrypted persistence, migration, backup and exact-owner OIDC are implemented and tested with fixtures. Verify backup restoration and the chosen live identity/deployment configuration before relying on hosted operation.
3. Authenticated device pairing, scope grants, explicit targets and stale-result rejection are implemented. Verify the chosen worker's real account, runtime, connectivity and revocation behavior in deployment.
4. Opt-in scope synchronization includes conflicts and deletion markers. Test representative concurrent edits and reconnects before making it part of daily work.
5. Narrow automatic-memory policies are available only by explicit scope/category opt-in. Deterministic safety tests do not establish real-world retrieval quality, proposal usefulness or complete sensitive-data detection.

Repository installation does not deploy a cloud service or link an external account. Startup migrates supported local JSON archives to the encrypted database. Automatic paid model calls are not added for memory extraction; candidates accompany an already authorized leader response. Real-world proposal precision, usefulness and correction effort still need evaluation on representative owner work; passing deterministic safety tests does not establish those metrics.
