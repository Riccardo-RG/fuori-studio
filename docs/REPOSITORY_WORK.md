# Repository work

Fuori Studio can turn a development brief into an isolated code change, execute configured checks, request an independent AI review, and present the resulting patch for human approval. Use **Projects → Repository** on the local installation or select an explicitly authorized repository worker from a hosted studio. This workflow is separate from ordinary text chat.

## First project

1. Create or select an owned project in the intended context scope. For this product, use **Fuori Studio**.
2. Register its absolute local Git repository path. The form suggests this installation's source directory in local mode. The path belongs to the computer running the server, not an arbitrary browser computer.
3. Configure at least one real check as a program and argument list. The form suggests `npm run check` and `npm test`, but choose checks compatible with the repository and sandbox before registration. Register only repositories and check commands you trust: tests and package scripts are executable code.
4. Commit the source changes that should form the baseline before creating an assignment. Each assignment records its base commit; local edits, untracked files and ignored files are not silently copied into the run.
5. Describe a bounded problem and start the assignment explicitly. Saving a repository or brief does not run AI.
6. Inspect changed files, the complete exported patch, actual command results and the AI review. Request changes creates a fresh assignment; it never overwrites an earlier delivery.
7. Approve only after reviewing the patch. Approval records a decision inside the studio; it does not modify the original checkout, merge, push or publish anything.
8. Optionally propose a reusable decision or pattern as memory. The proposal retains the approved run as its source and remains excluded from retrieval until reviewed in Memory.

## Evidence, not generated claims

Big Fonz is the editing role and must use the built-in Codex connection, executed locally or by the selected repository worker. Riccardo is the reviewer and uses his separately configured text connection. An API connection can review the supplied text but cannot edit the repository through this workflow. Both roles must be authorized for the project scope and every inherited memory source. A repository worker does not require a text-execution grant; its local policy, scopes and check manifest are independent.

The editor's summary, the process results, and the AI review are separate records. A model saying “tests passed” is not a successful check. Approval requires a nonempty captured patch and successful configured checks. If the checks change the candidate patch, their evidence cannot be reused to approve a different change. A missing or failed AI review is displayed explicitly and does not replace the check requirements; the owner can still approve a complete patch whose configured checks passed. Each original editor/reviewer context reference is validated before reuse, so a newer retrieval cannot conceal stale provenance.

Each delivery has an immutable base commit, patch hash, changed-file list, captured check output and timestamps. The patch is stored separately from the lightweight run snapshot. Downloading a patch does not run Git or call a provider.

## Execution and recovery

One chat, text assignment or repository assignment may execute through the server at a time. Configuration and knowledge mutations that could change authorization are blocked while execution is active. Browser disconnection does not stop a repository run. Pause and server shutdown cancel its process group; interrupted runs are retained for inspection. A retry uses **Request changes** to create a new run on the same recorded base commit, with a fresh isolated checkout and the prior feedback. The superseded patch remains inspectable and cannot then be approved. To use a newer baseline, create a new assignment after committing it. There is no automatic paid retry or fallback to another provider.

The runtime uses argument arrays, output and time limits, disabled Git hooks, a reduced process environment, and a named Codex permissions profile with restricted reads, isolated writes and disabled command network access. It never falls back to unrestricted shell execution when the sandbox is unavailable. A sandbox preflight failure is an execution failure, not evidence of a code failure. An unsupported operating system or incompatible Codex CLI must be corrected before starting real work.

Configured checks run with command networking disabled. Suites that bind loopback ports or contact services may fail because of that policy, even when their code is correct. For **Fuori Studio**, configure `npm run check` and `npm run test:offline`. The latter excludes HTTP integration files and `integration.test.mjs`; it is a selected suite, not a replacement for the full `npm test` run in a developer environment that permits loopback servers. Other repositories need their own appropriate commands. Inspect the actual result; do not enable network access implicitly or report unrun tests as passed. Existing Node dependencies can be reused read-only only when the source manifest and lockfile match the committed baseline; no dependency installation is performed.

Use the local filesystem for trusted proprietary source. Sandboxing and an isolated checkout are not a virtual machine or an assertion that arbitrary hostile repositories are safe. Do not commit secrets to source. The studio does not copy Codex authentication into a repository, patch, memory export or synchronization package.

## Current boundaries

- Remote repository execution requires its own device capability and a locally registered alias, scope allowlist and check manifest. Existing text or sync tokens do not grant repository access. See [remote execution](REMOTE_EXECUTION.md).
- The workflow uses the committed baseline. Changes in the owner's working directory are preserved and excluded.
- No network installation, Git push, GitHub authentication, pull request creation or merge occurs automatically. The reviewed patch is the handoff artifact for the normal repository review process.
- This repository workflow does not crawl issues, research the web or poll CI. Its editor and optional reviewer consume the shared AI call budget; actual monetary charges are not capped by that counter.
- Repository metadata, patches and logs belong to the private installation archive. Knowledge export and sync transfer reviewed knowledge only, not source code or repository history.

## Interfaces

`lib/repository-runtime.mjs` handles Git snapshots, bounded processes, sandboxed editing/checks and patch capture. `lib/repository-work.mjs` owns the durable lifecycle, context authorization, review and memory handoff. Both accept injected dependencies for tests. The browser panel consumes the authenticated HTTP endpoints documented in [API](API.md).

`lib/repository-devices.ts` owns scoped leases and authenticated receipts on the studio. `lib/repository-worker.ts` owns the local repository policy and durable delivery journal. A disconnected worker retries delivery of a saved result; it never reruns a paid edit automatically. The authorized worker is a trust boundary: receipt hashes detect inconsistency, but do not independently prove that a compromised worker executed its reported commands.

Official Codex references consulted: [non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode) and [security](https://learn.chatgpt.com/docs/security). Installed CLI help is checked for the actual available sandbox flags; a documentation example is not treated as proof that a runtime works on a particular host.


## Host compatibility diagnostic

The available Codex CLI must support `exec --ignore-user-config --ignore-rules` and named permission profiles for `codex sandbox`. Fuori Studio performs an innocuous sandbox preflight before editing or checks. During development, the bundled Codex 0.158 alpha and official 0.157.1 both failed this preflight on macOS 13.6.3 with `TIOCSTI`; this is an upstream runtime/OS compatibility issue, also reported in the [official Codex issue tracker](https://github.com/openai/codex/issues/45119). The application preserves this as a blocked execution rather than removing isolation. Use a compatible supported runtime/host; do not disable OS security or bypass sandboxing to run a repository. Automated repository tests use an explicitly injected fake runtime and real temporary Git/test commands, and are not proof of live Codex execution on an affected host.
