# Read-only repository analysis

Status: backend/API and browser workflow implemented, with injected-fixture and fake-provider verification. Desktop/mobile checks covered preparation, reviewed sources and destinations, cancellation without AI dispatch, and a confirmed three-stage sequence. These checks do not establish live GitHub/AI success, that an account is already connected, or that an existing server process has loaded the updated code.

Repository analysis prepares a bounded sample of one to five explicitly authorized GitHub projects, then uses a separately confirmed chat execution to compare their technical state and product opportunities. It is distinct from single-file import, ordinary chat and the Repository workflow that edits an isolated checkout. A message containing a GitHub URL does not silently activate it.

## Preparation and explicit execution

1. Configure a separate GitHub connection with repository **Contents: read**, the intended scope and an explicit repository allowlist. Existing `gh` and Codex logins are not reused. Publication permission is unnecessary for this analysis.
2. In the active operative scope, choose **Analizza repository** in chat or **Confronta repository** in the GitHub panel. The **Analizza e confronta repository** dialog accepts a goal of at most 6,000 characters and one to five distinct repository selections. Each optional branch, tag or commit selects the source revision; omission resolves that repository's default branch.
3. Choose **Leggi repository e prepara anteprima**, which calls `POST /api/repository-analysis/prepare`. This reads GitHub and saves source documents locally, but does not call an AI model or reserve AI budget. The response contains an analysis ID and metadata for its pinned sources.
4. The **Cosa sa questo agente?** execution preview uses that `repositoryAnalysisId`, its unchanged goal as `message` and the same scope. No workflow can be attached. Review the required repository sources, any additional context, actual providers/destinations and the three-call budget. History defaults to excluded; explicit inclusion retains all normal scope and source checks.
5. Choose **Conferma e avvia** to submit the matching preview through `/api/chat`. The server runs the three fixed stages below. Repository selection, call sequence and destinations are fixed by the reviewed application plan, not selected by the model. A new start always requires its own review and confirmation.

The current destination is restricted to the built-in **Codex locale** connection (`id:codex`, `type:codex`) on this computer, for all three agents. If assignments differ, explicitly select Codex in **Servizi AI** and review again; no automatic reassignment or provider fallback occurs. OpenAI API connections, other providers and paired workers are not allowed in this mode. The Codex process is local, but it sends the reviewed prompt and repository excerpts to OpenAI: this is not offline inference.

| Stage | Agent ID | Expected contribution |
| --- | --- | --- |
| Technical comparison | `forge` | Observed architecture, code-supported capabilities, documented intentions, existing but unexecuted tests, risks and reuse opportunities |
| Product and business analysis | `growth` | Options relative to the user's goal, tradeoffs and qualitative effort; commercial assumptions and missing user/market information remain explicit |
| Synthesis | `nova` | Prioritized recommendation, evidence and disagreements, plus proposed next steps and a 30/60/90-day plan with validation criteria |

A completed sequence makes three AI calls. Each later stage receives bounded earlier contributions as claims to evaluate, not independently verified facts. Those handoffs retain their source dependencies. Failure or cancellation stops the remaining stages; already completed messages stay in the conversation. There is no automatic paid retry, provider fallback, task creation or publication. The normal per-dispatch budget reservation still applies, so a reviewed preflight is not a promise that every later call will succeed.

## What the sample proves

Every target is resolved to an immutable commit. The GitHub reader checks tree entries and verifies full blob bytes against their Git object identifiers before extracting text. It selects representative architecture categories and query-relevant candidates; this is a bounded sample, not an exhaustive audit.

Source documents identify the repository, commit, captured ref/time, observed coverage and each excerpt's path and line range. Saved analysis metadata also records blob hashes, immutable GitHub URLs, connection versions and source IDs/versions/digests. Analysts should cite `repository@commit`, path and lines that actually appear in their supplied evidence.

Documentation describes intent, not necessarily implementation. A test file proves only that the file exists in the captured sample, not that the test runs or passes. Code alone cannot establish users, demand, traction, revenue, operating costs or commercial viability. The analysis instructions separate technical observations, commercial hypotheses and missing information. An empty readable sample must be reported as insufficient evidence; omitted files must not be described as inspected.

Preparation does not install packages, mutate a checkout, execute tests or shell commands, write to GitHub, crawl issues or publish PRs. The subsequent analysis is intended to reason over supplied evidence, not execute repository work. Read-only describes the repository boundary; preparation still saves selected source content in the studio, and confirmed analysis sends it to the reviewed Codex/OpenAI destination.

Analysis dispatch uses a separate `inputOnly` Codex mode: the CLI receives explicit tool-disabling settings, no discovered project instructions or host skills, disabled web search and empty MCP/plugin configuration, alongside the existing read-only sandbox and ephemeral session. Unexpected non-conversational events stop the run and reject its result. These are application/CLI controls, not an additional OS isolation guarantee; a reported tool event may already have occurred before detection. An incompatible CLI or managed configuration can reject execution, and the studio must not retry with weaker settings.

## Bounds and partial coverage

| Boundary | Maximum |
| --- | ---: |
| Repositories per preparation | 5 distinct repositories |
| Goal length | 6,000 characters |
| Retained Git tree entries per repository | 4,000 |
| Selected text files per repository | 12 |
| One excerpt | 2,000 characters |
| Excerpt text per repository | 8,000 characters |
| Assembled source document | 12,000 characters |
| All assembled source documents | 50,000 characters |
| Retained analysis preparations | 40 |

Coverage contains `treeEntries`, `eligibleFiles`, `readFiles`, `omittedFiles` and `treeTruncated`. These describe the observed bounded tree; a truncated tree may contain additional unknown files. Unsafe paths, protected names, symlinks, submodules, binary/generated material, oversized files and detected secrets are excluded as appropriate. Protected or credential-bearing filenames are not exposed in skipped-item reports. Secret-pattern filtering is not proof that arbitrary proprietary code contains no confidential information: inspect the source material and destinations before confirming AI execution.

Assembled-document limits include provenance headers, so exceptionally long paths or source combinations can fail before import. The chat preview also checks room for context, system knowledge and subsequent handoffs before any model call. Reduce the selection or exclude optional context when it is too large. The archive refuses new preparations at capacity; it never silently evicts user documents to make room.

## Permissions, freshness and retention

Preparation requires owner mutation authorization, an idle studio, the current conversation scope and an active non-archive scope. Both the GitHub token and the studio's repository/scope allowlist must authorize every read. Credentials remain in the encrypted connection archive and are not copied into documents, previews, prompts or analysis metadata.

One immutable text source per repository is committed in a single source-store batch. The separate analysis record references those sources rather than duplicating their excerpts. It is stored through the encrypted production archive. If scanning, validation or authorization fails before import, no partial set of source documents is imported. If saving the analysis index fails after the source batch commits, the explicit imports remain; failure is reported and no analysis is started.

Closing or cancelling the preview after preparation is not a rollback. The chat retains the prepared draft so it can be reviewed again; **Annulla analisi preparata** discards that draft, not the imported sources. Imported sources remain in the selected scope, and any completed analysis messages remain in the conversation. Removing or revoking a GitHub connection does not erase those existing copies. They retain ordinary Sources retrieval semantics until the owner removes them; credential revocation is not deletion of previously acquired content.

Reusing the prepared analysis requires its original connection grants/version and source current status/version/digest to remain valid. These are checked when loading the analysis, when rebuilding and consuming its preview, and before each execution stage. A changed goal, invalidated source or changed connection configuration requires new preparation. Advancing a remote branch does not alter the already pinned sample; explicitly prepare again to analyze newer code.

Normal provider authorization applies to each active scope and all inherited source scopes, in addition to this mode's built-in-Codex/local-target restriction. Selecting a GitHub repository grants no new AI-provider permission. Required repository sources cannot be excluded while keeping the same analysis identity. Optional memories, other documents and history remain governed by the existing execution preview and access controls.

## API and implementation

Preparation body:

```json
{
  "scopeId": "business",
  "goal": "Compare the selected products and recommend the next priorities.",
  "targets": [
    { "connectionId": "connection-id", "repository": "owner/product", "ref": "main" }
  ]
}
```

The response is `{id,scopeId,goal,createdAt,repositories}`. It contains only provenance and coverage metadata; source text is available through the existing owner-scoped Sources detail route and the subsequent execution preview. Pass `repositoryAnalysisId` in both the chat preview and the matching `/api/chat` body. The goal is compared with the trimmed message. A preview returns the fixed `forge → growth → nova` participants, `requiredCalls:3` and the prepared analysis metadata. See [HTTP API](API.md#read-only-repository-analysis) for authentication, receipts and error behavior.

`lib/github.ts` owns bounded fixed-host reads and local grant revalidation. `lib/repository-analysis.ts` owns input/output validation, source assembly, metadata persistence and reuse checks. The source service's `importTextBatch` is internal and is deliberately absent from the public `/api/sources` action list. `lib/chat.mjs` owns the three-stage prompts, provider checks, handoffs and saved conversation results.

The GitHub reader and analysis-store tests inject transports/scanners and isolated storage. They cover bounds, provenance, read-only requests, scope isolation, revocation/version changes, source changes, cancellation, partial-preparation failure, batch atomicity and ledger capacity. Relevant fixture suites include `test/github-analysis.test.mjs`, `test/repository-analysis.test.mjs`, `test/repository-analysis-http.test.mjs` and `test/repository-analysis-ui.test.mjs`. Desktop/mobile browser verification used two fixture repositories and a fake provider: preparation and cancelled preview made no AI dispatch, while a confirmed run saved three responses with the expected source provenance. No real private repository or paid AI call was used; these tests do not prove access to a real account or successful model behavior.
