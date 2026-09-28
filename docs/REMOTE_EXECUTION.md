# Paired repository workers

A paired repository worker lets the authenticated studio coordinate a code change on an explicitly authorized computer. The server stores the assignment, patch, check evidence, review and approval. The worker reads a local Git repository, edits an isolated snapshot, executes locally approved checks, and returns a receipt. Approval does not apply, push, merge or publish the patch.

Repository execution is a separate device capability named `repository`. Existing `execute` tokens permit text inference only; `sync` tokens permit selected knowledge synchronization only. A pairing may enable either text execution, repository execution, or both. Repository capability does not grant arbitrary access to the worker's filesystem.

## Prerequisites

- Node 24 and this version of Fuori Studio on the worker.
- A compatible Codex CLI, authenticated locally with `codex login`.
- A reachable HTTPS studio with owner authentication and a protected archive key.
- A trusted local Git repository with a committed baseline and existing dependencies needed by the configured checks.

The worker retains its local Codex authentication. Pairing never uploads Codex credentials to the studio, repository, patch or knowledge archive. A connection test is not a successful sandbox compatibility test. A host whose Codex sandbox fails preflight cannot execute repository work; there is no unrestricted fallback or OS security bypass. See [Repository work](REPOSITORY_WORK.md) for the current host compatibility diagnostic.

## Pair and authorize a repository

Generate a pairing code in the studio's **Access and devices** panel, selecting the **Repository** capability and the permitted workspace scopes. On the worker:

```sh
npm run device -- pair https://studio.example.com
```

Enter the one-use code at the prompt. It is not placed in a shell argument or a saved command. To use a separate worker archive, set `FUORI_STUDIO_DEVICE_DIR` to a private absolute directory before running these commands. The default is `.local/device` within the installation.

Create a local JSON file containing the exact checks you approve. Program and arguments are separate values; there is no shell command string:

```json
[
  { "label": "Type and syntax checks", "program": "npm", "args": ["run", "check"] },
  { "label": "Offline tests", "program": "npm", "args": ["run", "test:offline"] }
]
```

Then authorize a stable alias and an absolute Git root:

```sh
npm run device -- repository:add product /absolute/path/to/product --scopes development --checks ./approved-checks.json
npm run device -- repository:list
npm run device -- run
```

Use real scope IDs from the pairing, separated by commas when selecting more than one. The local policy cannot authorize a scope missing from the pairing. Checks use the same supported command policy as local repository work, and one to twelve checks are required. Approving a package script also approves the executable code that script invokes inside the sandbox; use repositories and checks you trust.

For Fuori Studio itself, `npm run check` and `npm run test:offline` are the intended restricted checks. HTTP integration suites bind network sockets and must be run separately in a developer environment that permits them. No package installation or network access is enabled automatically.

Only aliases, repository names, committed HEADs, branch names, dirty flags, sanitized GitHub remotes, checks, scope IDs and policy hashes enter the remote catalog. Absolute source paths stay in the encrypted worker policy. The policy hash is SHA-256 of canonical JSON containing the alias, ordered checks, and sorted scope IDs.

Each policy is also bound locally to the studio HTTPS origin and paired device identity. Re-pairing with another studio or a new identity does not silently republish prior repository authorizations. Authorize the required aliases again after pairing. Up to thirty repositories can be advertised for one connection.

Stop the worker before changing its local policy; the device archive has an exclusive process lock:

```sh
npm run device -- repository:remove product
npm run device -- repository:add product /absolute/path/to/product --scopes development --checks ./revised-checks.json
npm run device -- run
```

The next announcement updates the studio catalog. Changing a policy invalidates jobs that depend on the old policy. Removing an alias does not delete the repository, snapshots, previous receipts, or journal.

## Execution boundaries

The worker validates the received manifest and compares its scope, alias, policy hash and exact check arguments with its local policy before invoking any repository runtime method. It confirms that the source HEAD still matches the requested commit. Uncommitted and untracked files are not copied into the run, and the original checkout is never edited.

The isolated runtime retains its normal protections: no Git hooks, no inherited service secrets, restricted filesystem access, no command network access, bounded execution/output, rejected symlinks and submodules, and no unsandboxed fallback. Existing Node dependencies may be mounted read-only only when the source manifest and lockfile match the committed snapshot.

A worker services at most one active job at a time. When paired for both capabilities, the same loop handles repository and text jobs sequentially. A long repository job can delay text work; the worker does not start a second local editor concurrently.

The worker announces its catalog approximately every twenty seconds while idle. During a repository job, it renews the lease every eight seconds and reports `preparing`, `editing`, or `checking`. A failed heartbeat, revocation, lost lease, job deadline or shutdown aborts active editing/checks. The bounded Git preparation stage may finish before observing cancellation, but cancellation is checked before any subsequent AI call.

The worker sends the editor summary, usage when available, pre-check patch hash, final complete patch and file statistics, exact check commands and actual process results. Check logs are capped at 12,000 characters each. A truncated log is an explicit check error and cannot justify approval. If checks modify the patch, the different hashes remain visible for the server's approval gate.

The authenticated worker is a trust boundary. A receipt verifies protocol consistency and provenance; it is not hardware attestation that an arbitrary paired computer honestly ran its checks. Pair only computers you control.

## Interruption and delivery recovery

The encrypted worker journal records an assignment before preparation or editing begins. It binds the job and logical run IDs to the studio and paired device. A known job or run is never automatically executed again, even if the server sends it another time.

After execution, the complete result or a safe failure is durably written before the result POST. If the connection fails after the server accepted the receipt, the worker resends the exact stored delivery. The server accepts an identical duplicate within its retention window and rejects a different receipt. Delivery retries do not regenerate a summary, rerun checks or make another paid editing call.

At startup, journal entries interrupted during execution become explicit failures. They are reported using their original lease if it is still accepted; an expired/revoked lease leaves a retained rejection status. Restarting the worker never resumes paid execution from an uncertain point. Start a new assignment explicitly after inspecting the previous result.

Receipt delivery is retried after transient failures with a ten-second delay, for at most twenty-four hours. Permanent authorization or stale-result rejection stops delivery retries. At most two pending deliveries are allowed before new claims pause. The latest two settled receipts remain in the worker journal; compact job/run records remain to prevent replay. The journal stops accepting new work at 10,000 records or its bounded archive capacity. It does not erase replay protection automatically to make room.

```sh
npm run device -- status
npm run device -- disconnect
```

Status shows capabilities, local aliases, approved scopes/check names, pending deliveries and recent journal outcomes without printing tokens or leases. `repository:list` additionally shows the local paths to the operator on that computer. Disconnect removes the local pairing credential and attempts remote revocation; if the studio is unreachable, revoke the device from the studio as well. Local encrypted policies, receipts and isolated snapshots are retained for inspection and backup.

## Protocol and verification

The worker uses authenticated POST endpoints:

- `/api/device/repositories/announce`
- `/api/device/repositories/claim`
- `/api/device/repositories/heartbeat`
- `/api/device/repositories/result`

Each endpoint requires the paired bearer token with repository capability. HTTPS redirects are refused. A result is limited to a complete textual patch of at most 2 MiB and 2,000 files, a bounded receipt of at most 4 MiB, and the exact configured check set. Binary changes and incomplete patches cannot be exported through this workflow.

`lib/repository-worker.ts` owns local policy, validation, bounded transport, execution and durable delivery. `lib/repository-devices.ts` owns server inventory, addressing, leases, validation and idempotent receipts. `scripts/device.mjs` is the local operator interface. All policy and journal records use the encrypted archive.

The worker tests inject the editing runtime and transport, verify durable replay protection, revoked leases, output bounds, exact checks, interruption and encryption, and exercise a real paired-device hub contract. They make no paid AI calls and do not establish compatibility of a particular host's real Codex sandbox.
