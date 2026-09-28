# GitHub test results

Use **GitHub → Test results** or the same button on a connection to choose an authorized repository and a branch, tag or commit. The reference defaults to `main`. A published PR's **Test results** button reads its recorded publication commit directly.

Each read resolves the reference to a SHA, then requests the latest check runs and combined commit statuses for that exact SHA. The dialog displays the SHA, fetch time, individual states and verified GitHub result links. Refresh is manual; opening the GitHub panel or a publication does not contact GitHub for checks. The feature does not start or rerun workflows.

Fine-grained tokens need Contents, Checks and Commit statuses read permissions. Existing connection, scope and repository restrictions apply. Credentials stay on the server, and all requests use the existing fixed `api.github.com` transport with redirects disabled. Result links are restricted to HTTPS GitHub pages in the selected repository. External CI links, logs, annotations and API-provided URLs are never fetched.

No checks is a distinct outcome, not a passing result. Neutral, skipped, cancelled, timed-out, failed, pending and unknown results remain distinct. A partial or rejected response never produces a passing summary. The viewer does not infer merge eligibility, required checks, or the status of a PR's synthetic merge commit. A newer branch head or PR commit needs a separate read.

The result is ephemeral and does not change the encrypted archive schema. `checks({ connectionId, scopeId, repository, ref })` returns `repository`, `ref`, `commitSha`, `fetchedAt`, `state`, `complete`, `checks` and `errors`. Each check has `id`, `source`, `name`, `state` and an optional verified `url`. Error entries contain only a source and an application error code.

Reads use at most three GET requests. Each response retains the existing 8 MiB and timeout limits. Each result group has a 100-entry cap, with pagination or inconsistent counts reported as incomplete. A valid group remains visible if the other group fails. Nothing is persisted, polled or automatically retried.

API references: [check runs for a Git reference](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference), [combined commit statuses](https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference).

Offline coverage: `node --test test/github-checks.test.mjs` (Node 24).
