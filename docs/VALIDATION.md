# Version 0.4 validation

Validation recorded on 28 September 2026 with Node 24 on macOS 13.6.3. These results describe this checkout; CI must rerun the checks after subsequent changes.

## Automated checks

- `npm run check`: JavaScript syntax checks and strict TypeScript checking passed.
- `npm test`: 192 tests passed, with no failures or skipped tests. This includes temporary HTTP servers, encrypted archives, identity, provider authorization, source provenance, repository work, dependency handoffs, recovery, cancellation and automation limits.
- `npm run test:offline`: the subset excluding listening HTTP fixtures passed. Use this subset with the syntax/type check when configuring this repository for network-disabled execution; it does not replace the full developer suite.
- `npm audit --omit=dev --audit-level=high`: no reported runtime dependency vulnerabilities at the time of the check. This is a point-in-time advisory check, not a security certification.

## Browser workflow

A disposable archive and the real application server were exercised at desktop and mobile sizes. The flow created a project, imported text and Markdown sources, previewed and committed a two-task plan, verified its dependency gate, ran and approved the prerequisite, registered a temporary Git repository, prepared a change, executed a real Node test, inspected the patch, recorded human approval, proposed memory and recorded outcome feedback. An existing uncommitted edit in the original repository was preserved.

The AI executable was deliberately simulated for this test. Git snapshots, filesystem operations, Node checks, HTTP handlers, encrypted persistence and browser interactions were real. No paid inference or personal credentials were used. Separate browser checks covered failed checks, stale revisions, escaped untrusted text, source links, scope changes, mobile fullscreen and the actual WebGL world. No browser JavaScript errors were observed in the complete workflow.

## External services and remaining prerequisites

Public HTTPS and anonymous GitHub repository metadata imports were verified using the actual restricted transport. Live OpenAI web search and other paid provider calls were not exercised; those require separately configured credentials and scope permission. Hosted OIDC login and a real paired second computer were not deployed as part of this local validation.

Real Codex repository editing remains blocked on the inspected host by its sandbox preflight error, `TIOCSTI`. Tests with a fake executable do not establish Codex compatibility. The application retains isolation and requires a compatible runtime/host before a real repository assignment can execute. See [repository compatibility](REPOSITORY_WORK.md#host-compatibility-diagnostic).
