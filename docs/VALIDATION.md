# Version 0.5 validation

Validation recorded on 28 September 2026 with Node 24 on macOS 13.6.3. These results describe the final local checkout. CI and deployment acceptance must run against the actual published revision and destination host.

## Automated checks

- `npm run check`: syntax checks for 89 JavaScript modules and strict TypeScript checking passed.
- `npm test`: **268 tests passed**, with zero failures or skipped tests. Coverage includes encrypted persistence, OIDC/CSRF, provider and scope policy, remote repository leases/receipts, real temporary Git changes/checks, backup authentication and restore resets, GitHub publication/reconciliation, and memory evaluation.
- The offline subset was verified during implementation. The full final suite includes those tests as well as HTTP fixtures. `npm run test:offline` remains the selected command for network-disabled repository verification; it is not a replacement for the full developer suite.
- `git diff --check` passed. Docker/Compose configuration received static review and YAML parsing. A CI job now builds the image and boots a disposable hosted configuration to check `/healthz`; that new CI job has not run on GitHub as part of this local session.
- A fresh `npm audit --omit=dev --audit-level=high` was requested but **not executed**: automatic approval review denied sending the private dependency tree to the external registry without explicit authorization. No current advisory result is claimed. Runtime dependencies were not changed in this release.

## Remote repository execution

An authenticated hosted HTTP fixture paired a device with repository capability only, registered its worker-local policy, ran the actual worker with an injected AI executable, produced a Git patch and executed a real Node check. The original dirty checkout was preserved. The owner reviewed and approved the returned artifact and proposed memory. Usage reports reached the governor. Separate tests exercised scope/policy changes, lease expiry, cancellation, revocation, receipt tampering, restart and redelivery without repeating an edit.

The injected AI is explicit test infrastructure. These results do not establish that a paid model or real Codex sandbox works on a particular computer.

## Backup and restore

Disposable archives exercised every-record authenticated decryption, SQLite integrity, wrong keys, corruption, symlink rejection, digest changes, private permissions and concurrent managed backups. Restore tests required a new destination, preserved source files and project data, revoked previous sessions/devices/sync, disabled autonomy and blocked incomplete restores. HTTP tests verified owner access, CSRF, exact hosts and encrypted downloads; no HTTP restore or delete route exists.

The existing local archive was separately backed up and verified before restarting the updated preview. That encrypted copy remains outside Git. This is a local preservation step, not proof of off-host retention.

## GitHub

Adapter tests used an injected fixed-host GitHub transport. Independent security tests exercised credential redaction, permission/approval revocation during publication, path collisions and secret-bearing errors. Actual Git-generated patches validated byte-exact reconstruction, full-index blob hashes, newline variants, executable modes, empty files and UTF-8 paths.

Tests covered read-only previews, exact candidate verification, stale bases, ambiguous write outcomes, restart recovery, reconciliation without duplicate PR creation and the base-branch race reported by a known-created PR. No real GitHub token was used and no external branch or PR was created.

## Browser workflows

The real application server ran on a separate loopback port with a disposable encrypted archive. Sixteen integrated checks exercised archive verification and downloaded backup SHA-256, an owner-labeled memory case, private-scope exclusion, real retrieval, correction in the actual memory editor, stale-label detection, reviewed labels and another run, versioned feedback, scope switching, and write-only fixture GitHub connection save/disconnect.

The browser blocked external destinations, and Codex pointed to a nonexistent fixture path. No AI request or external GitHub request was made. Desktop 1440 px and mobile 390 px layouts were checked with zero JavaScript errors or horizontal overflow. Separate mocked-browser tests covered publication preview/confirmation, uncertain reconciliation, the advanced-base warning, repository-to-GitHub navigation, keyboard controls and night mode.

## External acceptance still required

The web container, public DNS/TLS, real OIDC account, live private GitHub token and second execution computer were not deployed here. Docker is not installed on this development Mac. Use [deployment](DEPLOYMENT.md), [recovery](DEPLOYMENT_RECOVERY.md), [remote execution](REMOTE_EXECUTION.md) and [GitHub](GITHUB.md) to perform those checks on the chosen environment.

Real Codex repository editing remains blocked on the previously inspected macOS 13.6.3 host by its `TIOCSTI` sandbox preflight failure. The new implementation does not disable or bypass that sandbox and no further runtime probes were performed. A compatible execution host/runtime is required. See [the diagnostic](REPOSITORY_WORK.md#host-compatibility-diagnostic).

Memory tests verify deterministic retrieval behavior. No production memory library has been declared accurate or useful without representative owner-labeled cases. These measurements are available through [memory evaluation](MEMORY_EVALUATION.md); passing presence checks does not prove answer accuracy or complete context.

## 0.6.0 — Italian/English and editable team names (2026-09-28)

- Full suite: **278 tests passed**, zero failures or skips. Includes four localization boundary/catalog tests, five team-store tests and one hosted team HTTP test.
- Syntax check: 98 JavaScript modules; strict TypeScript check passed. `git diff --check` passed.
- Browser checks used disposable local archives, a fake Codex executable and blocked external requests. No live AI calls or production archive mutations were used for QA.
- Verified initial browser-language choice, explicit preference persistence, switching without reload, cross-tab changes, blocked-storage fallback and the language selector before login. Desktop 1440px and mobile 390px/day/night layouts had no horizontal overflow or JavaScript errors.
- Verified project/memory/workflow/evaluation drafts, conditional export and memory-policy controls, remote repository/check rows, GitHub dependent selections and selected upload files survive a language change. User-owned strings matching translation keys remain verbatim.
- Team checks covered owner/session/CSRF enforcement, stale revisions, unique names, durable encrypted storage, failed-write recovery and stable IDs. Browser checks covered harmless rendering of HTML-like names, reload persistence, live nameplates/cards, duplicate/conflict errors and unchanged provider assignments and memory permissions.
- The real local server was restarted after confirming no chat/task/repository execution was active. `/healthz` and the authenticated/local team endpoint returned 200 with all five profiles.

Artifacts from this run are under `/private/tmp/fuori-studio-qa/i18n/` and `/private/tmp/fuori-studio-qa/team-localization/` on the development machine. Additional targeted scripts are `i18n-workspace.cjs`, `experience-i18n-qa.cjs`, `team-ui-qa.cjs` in `/private/tmp/fuori-studio-qa/`, and `/private/tmp/workflows-i18n-qa.cjs`. These are local QA artifacts, not installed runtime dependencies or CI browser coverage.

Raw external/provider and some server diagnostics retain their original language; stored knowledge and historical responses are deliberately not rewritten. AI language-following is a prompt instruction, not a verified live-model guarantee. No new dependency audit or deployment was performed in this release.

## Productivity update — 2026-09-28

- Targeted automated checks: **37 passed**, zero failures or skips: GitHub adapters/safety/checks and the operations HTTP integration (29), plus workflow learning and localization boundaries (8). The nine new GitHub checks tests are included in the 29, not an additional run count. The full suite was deliberately not repeated for this increment.
- `npm run check` passed: syntax for 103 modules and strict TypeScript. `git diff --check` passed. No runtime dependency was added.
- Workflow learning checks exercise preview without persistence or AI output copying, original scope/provenance, approval/version revalidation, restricted/stale memory, explicit truncation and actual HTTP reuse as queued task steps.
- GitHub fixtures cover exact commit resolution, read-only access, missing/neutral/skipped/pending/failing states, partial errors, response limits, scope revocation, secret redaction and result-link validation. No live GitHub credential or CI result was used.
- Eleven focused browser assertions/workflows passed against a disposable archive. They covered the combined review inbox and badge, exclusion of superseded patch attempts, approved delivery → edited ready workflow → queued assignment, cross-scope navigation, preserved drafts during language changes, manual GitHub failure/partial/empty results, keyboard shortcuts, and 390px mobile night layouts. No horizontal overflow or JavaScript errors were observed.
- Browser GitHub responses were injected at the HTTP boundary; backend checks used the separate transport fixtures. AI execution used a fake local executable. The temporary repository had a real isolated patch and Node check, while its original dirty checkout remained separate. External browser requests were blocked. No paid model calls were made for these checks.
- The real local instance was restarted gracefully after confirming chat, assignments and repository work were idle. Health, team and new quick-action asset endpoints returned 200. The separate QA server was stopped. No remote deployment or Git push was performed.

Local browser artifacts: `/private/tmp/fuori-studio-qa/productivity/`, with scripts `productivity.cjs` and `productivity-followup.cjs` in its parent directory. These are local QA artifacts, not CI browser coverage. Existing live-provider, deployment and host-compatibility limits still apply.

## Context and control update — 2026-09-28

- Final automated verification covers **331 passing tests**. One full run exercised 329 tests; eight existing HTTP fixtures initially failed because they bypassed the new required preview. Those fixtures were updated to preview first and all eight passed on targeted reruns, retaining their authorization, usage, cancellation, patch and source-isolation assertions. Two additional regressions passed for zero-call finalization evidence and concurrent receipt consumption. The full suite was not repeated unnecessarily.
- `npm run check` passed: syntax for 121 JavaScript modules and strict TypeScript. The final two frontend copy/draft changes were syntax checked separately. `git diff --check` passed. No dependency was added or updated.
- New coverage includes scope-isolated search and original retrieval, archived conversations, workflow field validation/interpolation/versioning, portability, exact context exclusions, derived-history filtering, explicit agent authorization, expiring/changed/target-bound/single-use receipts, atomic project/assignment budgets, stable project identity and repository revision accounting. HTTP fixtures capture actual fake-provider prompts; previews and rejected starts produce no inference.
- A disposable real server and encrypted archive supported browser checks of search → original editor, populated workflow → queued task → preview → execution, exclusion persistence, zero-budget blocking, selected chat agents/history, cancellation preserving the draft, and Italian/English language changes. Desktop 1440 px and mobile 390 px/night layouts had no horizontal overflow, browser errors or external requests. The core pass used exactly one fake-provider call.
- A focused browser follow-up confirmed the translated local destination, unsaved budget preservation across language changes, plan preview cancellation preserving the brief, and repository preview cancellation retaining queued state and the original dirty checkout. It made zero additional AI calls; the disposable server was then stopped.
- QA artifacts are under `/private/tmp/fuori-studio-qa/context-integrated/` on the development machine. These are local evidence, not installed browser-test dependencies or CI browser coverage.
- The actual local preview was restarted only after confirming no chat, task or repository run was active. Existing encrypted data was retained. No real AI call, external GitHub request, dependency audit, publication or hosted deployment was performed for this update; the external acceptance limitations above still apply.

## Daily product quality update — 2026-09-30

- **41 distinct focused automated tests passed** across Today, memory review, scoped result insights/rendering, governance, execution previews, localization and the affected HTTP flows. The full suite was not repeated for this predominantly read-only increment. HTTP fixtures use temporary encrypted archives and fake or unavailable Codex executables, never live services.
- `npm run check` passed: syntax for 133 modules and strict TypeScript. The final small Today rendering refinement was separately syntax checked. `git diff --check` passed; 78 local documentation links resolved. No dependency was added or updated.
- New domain checks cover dependency-based ordering, saved progress, superseded repository attempts, routine windows, bounded lists, private/foreign-project exclusion, conservative duplicate detection and 90-day review hints. Scoped insights use the full retained ledger, preserve missing feedback/minutes, and cannot borrow current private titles after a project moves or workflow sharing is revoked.
- The new HTTP integration verifies all three read-only routes, invalid scopes/projects and hostile Origin rejection. It compares every encrypted archive record's ciphertext and revision before/after, as well as workspace/operations snapshots and zero AI call usage.
- **10 integrated browser checks passed** on a disposable real server: Today navigation, current/all-scope filtering and original work details; duplicate-memory review into the existing editor; populated project/procedure usefulness cards; Budget tab arrow navigation; daily-budget recovery into Routine settings, preserved exclusion choices and ordinary-cancel clearing; retained checkbox focus; visible injected repository-start 409 errors; and Italian/English layouts. Screenshots at 1440 px Italian/day and 390 px English/night had no horizontal overflow or JavaScript errors. The browser blocked external destinations and used exactly one fake task execution. No real AI call or GitHub request was made by QA.
- Local browser artifacts: `/private/tmp/fuori-studio-qa/product-improvements/report.json` and adjacent screenshots. The disposable server was stopped after verification.
- The real local server had stopped and left an instance lock. The recorded PID was verified dead and `lsof` found no open archive process before only that stale lock was removed. The updated server then started with the existing archive; health, Today, memory review and scoped governance endpoints returned 200. No fixture records were inserted into the real archive.
- Live provider, hosted deployment, second-device and external CI acceptance remain separate from these checks. Monetary savings, answer accuracy and actual business value are not inferred from passing software tests or recorded call counts.
