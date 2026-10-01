# AI call budgets

Fuori Studio enforces three concurrent ceilings on its server:

| Ceiling | Default | Period |
| --- | ---: | --- |
| Installation | 50 AI calls | UTC calendar day; resets at midnight UTC |
| Project | 200 AI calls | Lifetime, including all assignments and revisions |
| Assignment | 12 AI calls | Lifetime of a text task or repository assignment, including revisions |

A lower remaining allowance always wins. Project and assignment limits accept whole numbers from 0 to 50,000. Zero prevents further calls. Raising a limit retains all previous usage; lowering it below usage prevents new calls but does not cancel a call already running. The installation's existing concurrency and duration limits remain in effect.

A call is one dispatch made by Fuori Studio to a configured AI provider or Codex execution. A repository editor dispatch and its independent textual review count separately. Drafting a plan consumes its selected project budget even before the plan has created assignments. Local and connected-computer editor dispatches use the same server ledger. A Codex dispatch may perform multiple internal model/tool operations that Fuori Studio cannot independently meter. These limits therefore constrain application dispatches, not a provider's monetary bill or every internal model request.

## Durable enforcement

Before dispatch, the server checks all ceilings and commits a `running` reservation in the encrypted SQLite archive. The checks and reservation use the archive's `BEGIN IMMEDIATE` transaction; concurrent requests cannot both consume the last allowance. A failed, cancelled, timed-out, or interrupted attempt remains charged. A request rejected before reservation consumes nothing. After a restart, in-progress records become `interrupted` and remain in lifetime and applicable daily counts.

Project and assignment identities come from stored operations and repository records. HTTP handlers validate ownership and derive scope and project; browser-provided budget ancestry is never trusted. A project keeps the same lifetime counter if it moves to another scope; the stable project ID, not its current scope, identifies the budget. Text-task revisions retain the same task identity. Repository revisions keep their actual run ID in the ledger and share the original ancestor's `budgetRunId`, resolved by following the stored revision chain. A revision cannot reset the allowance by obtaining a new run ID.

Both the provider adapter and repository editor require an execution governor. Missing configuration fails with `GOVERNANCE_UNAVAILABLE`; it does not silently execute without accounting. Connected-computer work is reserved on the controlling server before remote dispatch. The worker does not receive permission to bypass the controlling server's budget.

The existing global ledger is migrated additively. Historical records without project attribution remain visible as unattributed calls; the application does not guess a project or retroactively invent assignment ownership. Unassigned chat, connection tests, and other explicitly global calls use the installation limit. Their absence from project counts is visible in the budget panel.

## User controls and reporting

The settings budget panel selects a project and optionally a text or repository assignment. It reports actual used/remaining call counts, the lifetime limit, and the global daily allowance. Changes use optimistic versions; stale saves are rejected so one settings screen cannot overwrite another's change silently. Repository revisions appear under one original assignment budget.

Only provider-reported input and output token counts are recorded. Local Codex and updated paired workers report valid counts from the CLI's `turn.completed` event. Missing or malformed reports, legacy workers, older saved calls, and failed or interrupted executions can still have unknown metrics. Missing token counts remain `null`, with explicit counts of calls lacking each metric. A partial sum is not presented as complete. No monetary bill, credit balance, or currency conversion is guessed.

The [system knowledge preview](SYSTEM_AWARENESS.md) also supplies each agent's usage in the active scope and, when selected, project. These counts cover retained history before dispatch. They are distinct from the installation-wide daily allowance and do not include the response about to be generated.

Before an explicit start, `governance.preflight({...trustedTarget, requiredCalls})` reports all applicable ceilings, available calls, and blocking limit codes. This is a read-only advisory check, not a reservation or a guarantee that capacity will remain available. Each actual dispatch performs its own atomic check. A parallel start or a settings change can exhaust capacity after preview; in that case the next call stops before contacting the AI service.

The owner reviews these allowances alongside context and destinations in [the execution preview](EXECUTION_PREVIEW.md). Chat can be attributed to a project in its current scope; plan drafting uses its selected project. Explicit task and repository starts additionally use their assignment allowance.

## Integration

- `governance.budgets(filter?)` returns defaults, daily counts, observed/configured project and assignment entries, and unattributed counts. A filter with scope/project can report a new project's default before its first call.
- `governance.configureBudget({...trustedTarget, callLimit, expectedVersion})` creates or updates a lifetime limit. Use version `0` for a not-yet-configured limit.
- `governance.execute({...trustedTarget, agentId, connectionId, kind}, invoke, signal)` reserves and accounts for one dispatch.
- `repositoryWork.budgetTarget({id})` returns trusted scope/project/current run/canonical ancestor identity.
- `repositoryWork.preview({id, expectedVersion, selection?})` prepares editor/reviewer context and connection plans without AI calls. The internal `previewPlan` passed to `start` pins this selection through editing and review. HTTP handlers must only pass a server-issued, revalidated plan, never one supplied by the browser.

The budget endpoints expose reads and versioned configuration only. Execution and preflight routes resolve their own trusted identities. Error codes are `DAILY_CALL_LIMIT`, `PROJECT_CALL_LIMIT`, `ASSIGNMENT_CALL_LIMIT`, and `GOVERNANCE_UNAVAILABLE`; budget exhaustion uses HTTP 429.

Use `GET /api/budgets` to read the snapshot and `POST /api/budgets` with `{action:"configureBudget",payload:{projectId,taskId?|runId?,callLimit,expectedVersion}}` to configure a limit. Omit assignment IDs for the project ceiling, or supply exactly one. See the [HTTP API](API.md#limits-and-outcomes) for ownership, version and authentication rules.

## Focused verification

Tests use fake providers/runtimes and temporary archives; no paid service is contacted. `test/scoped-budgets.test.mjs` covers default caps, concurrent reservations, failed calls, version conflicts, durable SQLite reopening, daily rollover, revision identity, provider metadata, and missing-governor rejection. `test/repository-work.test.mjs` covers selected/pinned preview contexts, canonical revision attribution, and preventing local/remote dispatch when the governor refuses a call.
