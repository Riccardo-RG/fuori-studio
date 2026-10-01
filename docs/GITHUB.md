# Authenticated GitHub projects

The GitHub connection supports importing selected text files from private repositories with immutable provenance, preparing bounded read-only multi-repository analysis, and publishing a human-approved repository result as a new branch and draft pull request. The connection does not merge pull requests, update the default branch, install repository dependencies, or share GitHub credentials with an AI agent.

This connection is separate from studio login, AI provider connections, paired workers and any temporary GitHub CLI login used to develop Fuori Studio itself. No existing `gh` or Codex credential is discovered or reused.

## Connect a repository

Create a GitHub fine-grained personal access token limited to the repositories you intend to use. For file imports and read-only analysis preparation, grant repository **Contents: read**. Publishing requires **Contents: write** and **Pull requests: write**, in addition to selecting publication permission inside Fuori Studio. Respect organization approval requirements and choose an expiration appropriate to your workflow. A connection saved in the studio does not prove the remote token is valid; use **Verifica accesso** to read repository metadata.

Open the **GitHub** tab in the work panel. Enter a descriptive name, the token, explicit workspace scopes, and repository names in `owner/repository` form. Enable publication only for connections that need it. The studio does not widen access to every repository visible to the token. GitHub's token permissions and the studio's scope/repository allowlist must both permit an operation.

The token is an input-only field. It is stored in the encrypted server archive and omitted from API snapshots, source records, prompts, patches and memory exports. Editing a connection with an empty token retains its existing secret; removing a connection deletes the current local credential. Revoke or rotate the token at GitHub as well when it is no longer needed. Full encrypted installation backups contain connection credentials and require the separately held archive key.

Token-backed API calls go only to `https://api.github.com` using the versioned REST interface. Redirects are refused. Error messages do not include raw provider response bodies or transport exceptions. Each request has a fifteen-second deadline and each serialized operation has a sixty-second network budget; responses, tree traversal, file count and stored candidates are bounded. Recognizable secrets and the configured token are rejected in public metadata and imported/published text. Pattern matching cannot establish that arbitrary project text contains no secret; review content before importing or publishing it.

## Import private project context

Choose **Acquisisci un file** in the GitHub panel, then a connection, allowed repository, branch/tag/commit and relative file path. The server resolves the reference to an immutable commit, traverses its Git tree and verifies the file's Git blob SHA against its downloaded bytes. The resulting source retains repository, commit, blob SHA, path and a link pinned to that commit. Updating the branch afterward does not silently rewrite the previously imported source.

Imports currently accept regular UTF-8 text files of up to 1 MiB. Binary files, symlinks, submodules, sensitive configuration paths and ambiguous names that collide by case or Unicode normalization are rejected. Single-file import does not read the rest of the checkout. Refresh is an explicit source operation and rechecks the connection and scope authorization. The separate analysis sampler below does not import an entire checkout either.

Imported content remains an untrusted source in its selected scope. Its instructions are not agent or owner instructions. Removing a GitHub connection blocks future reads and refreshes; it does not erase a document already imported into the encrypted source archive. Remove or mark that source stale separately if it should no longer contribute to context. Source freshness and provider/scope policies still apply when the text is used by an agent.

GitHub documents the underlying [Git blob API](https://docs.github.com/en/rest/git/blobs), which supplies encoded content and the object identifier. Fuori Studio additionally verifies the bytes and follows only validated tree entries rather than a returned download URL.

## Prepare a read-only repository analysis

Choose **Analizza repository** in chat or **Confronta repository** in the GitHub panel. The dialog accepts an explicit objective and one to five authorized repositories in the current operative scope. **Leggi repository e prepara anteprima** resolves each selected ref to a commit, reads a bounded Git tree, verifies selected blobs and captures a representative text sample. README, manifests, entry points, documentation and tests are candidates; query relevance helps rank the sample. This preparation does not run code, execute tests, inspect every file, fetch issues or infer market demand from source code.

Preparation makes no AI call. It imports one source document per repository and stores immutable commit/file/line provenance plus explicit coverage. The next operation is a separate execution preview showing source material, provider destinations and the three sequential calls: technical analysis by `forge`, product analysis by `growth`, then synthesis by `nova`. The stored goal is locked, workflows cannot be combined with this mode, and optional chat history is excluded by default. A failed stage stops the remaining sequence.

This analysis currently permits only the built-in **Codex locale** connection on this computer for all three agents. OpenAI API connections, other providers and paired workers are not supported for this mode, and the studio does not silently change assignments or targets. Review each destination and confirm every analysis start. Local Codex sends the reviewed excerpts to OpenAI; local preparation and storage do not mean offline inference.

Connection permission/version and source current status/version/digest are rechecked before use. Revocation blocks future preparation and reuse of a prepared analysis; it does not erase copies already imported into the local archive. Cancelling after preparation also leaves those sources available under their existing scope. Remove an imported document if it should no longer participate in ordinary source retrieval. GitHub credentials never enter the source documents or model prompts, but reviewed source excerpts are sent to the AI destinations explicitly confirmed for the analysis.

The browser flow has been checked with injected repository fixtures and a fake provider, including cancellation before dispatch and the three-stage sequence. Those checks do not establish live GitHub or provider success. See [repository analysis](REPOSITORY_ANALYSIS.md) for limits, retention, evidence rules and the API sequence.

## Publish a reviewed change

Read existing CI outcomes through **Risultati test / Test results** on a connection or published PR. The viewer resolves a branch or tag to an exact commit and shows check runs and commit statuses, including partial and missing results. It does not dispatch workflows or determine merge eligibility. See [test results](GITHUB_CHECKS.md) for read permissions and limits. Workflow execution still depends on the repository's configured [GitHub Actions events](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows).

1. Register the project repository locally or through a paired worker. For a private repository, first prepare its trusted checkout and dependencies on that computer using your normal Git workflow. The worker keeps its own local authorization; the web connector does not transmit a token to that checkout.
2. Run the assignment in its isolated repository environment. Inspect the complete patch and the actual configured check results. Approve the result in the studio. An unapproved result, failed/truncated check, changed patch or stale approval cannot be published.
3. Choose **Prepara PR** for the approved run. Select an allowed GitHub connection, repository and base branch, and review the exact title and body. Preparation reads GitHub but creates no Git objects, branches or pull requests. The branch's current commit must match the run's tested base.
4. Inspect the prepared target, branch, base commit, patch fingerprint and file list. Choose the explicit publication action. The server rechecks approval, run version, connection version, permissions, candidate integrity and the current base before writing.
5. Follow the returned GitHub link. Review the draft PR and its CI results before deciding what to do on GitHub. The studio has no merge or default-branch update endpoint.

Publication applies the full-index patch to authenticated base file contents with exact context, line counts, modes and old/new Git blob hashes. It preserves UTF-8, newline conventions, empty files and executable mode changes. It rejects binary changes, unsafe paths, renames, symlinks, submodules, fuzzy application and inconsistent manifests. Current publication limits are 100 changed files, a 2 MiB patch, 1 MiB per base file and a 4 MiB reconstructed candidate. Changes outside these limits remain reviewable/exportable through the repository workflow but require another publication method.

The encrypted candidate and its metadata are saved atomically by the production archive. A separate digest binds the reconstructed entries to the reviewed preview. On confirmation, the adapter creates a tree based on the recorded base tree, a commit with exactly one recorded parent, a new `fuori-studio/<publication-id>` branch, then a draft PR. It never force-updates or deletes an existing reference. Repository automation may run in response to this branch or PR just as it would for a normal push.

GitHub's [tree API](https://docs.github.com/en/rest/git/trees) preserves unmodified entries through `base_tree`; its [commit API](https://docs.github.com/en/rest/git/commits) accepts the explicit parent; the [reference API](https://docs.github.com/en/rest/git/refs) creates the separate branch. Changes to GitHub Actions workflow files may require the token's additional Workflows permission and can be rejected by repository policies. The studio never broadens token permissions automatically.

The [pull request API](https://docs.github.com/en/rest/pulls/pulls) supports creating a draft against a named base branch, but does not provide an atomic expected-base-commit precondition. The base can advance between the final check and PR creation. When GitHub reports this race, the studio retains the known-created PR URL, records `actualBaseCommit` and `baseChanged`, and shows that the original checks do not cover the advanced destination. Inspect the new comparison and rerun checks on GitHub before merging.

## Disconnects and uncertain outcomes

Every external write has a durable intent recorded before it is sent. There are no automatic POST retries. Restarting the studio changes interrupted publications to **Esito da verificare**; it does not publish them again.

The **Verifica esito** action makes read-only requests. It checks the generated branch, exact commit parent/tree, and matching pull requests across open and closed states. A lost successful PR response can therefore become a confirmed publication without creating another PR. A branch that differs from the recorded candidate is never overwritten or accepted as the studio's result.

If the branch exists and no PR request was sent, reconciliation can return to a prepared state. A new explicit confirmation sends the first PR request using that same branch. A definite API rejection can also permit a new confirmation after reconciliation. If a PR request's outcome is ambiguous and no PR is visible, the studio keeps it uncertain: a missing response is not proof that creation failed. Verify again or inspect GitHub manually. This deliberate limit prevents duplicate PRs during delayed or lost responses.

Failures before a branch write can leave unreferenced Git objects. Reconciliation may safely prepare a new attempt once it confirms no branch exists; it never removes objects or branches from the repository. To rotate credentials while retaining reconciliation, update the existing connection's token. Disconnecting removes that connection identity and prevents further reconciliation through it; inspect unfinished publications on GitHub before disconnecting. Existing imported sources and publication audit records remain available.

## Implementation and validation

`lib/github.ts` owns encrypted connections, scoped reads, immutable previews, publication intents and reconciliation. `lib/github-patch.ts` implements strict patch reconstruction. The authenticated `/api/github` route exposes snapshots and explicit mutations; private file imports enter through the existing source service. Each mutation retains the studio's normal owner authentication, exact-origin and CSRF protections.

The automated tests use an injected GitHub transport and an encrypted temporary archive. They cover actual Git-generated patch formats, scope/approval changes during publication, credential redaction, blob integrity, unsafe paths, stale bases, candidate alteration, duplicate previews, lost responses, restart recovery and the final base-branch race. These fixtures perform no real GitHub writes and do not establish that a particular token, organization policy or hosted deployment has been configured successfully. The deployment acceptance check requires a deliberately chosen repository and a human-confirmed draft PR.
