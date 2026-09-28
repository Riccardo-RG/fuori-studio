# Security, backup and recovery

## Supported boundary

One installation has one owner and one server process. Scope permissions separate the owner's contexts and AI destinations; they are not separate user accounts or tenants. Multi-tenant SaaS, public registration, invitations and team RBAC are not implemented.

`local` mode binds to loopback and relies on the OS account. Never expose this mode through a public tunnel. `hybrid` and `online` require an HTTPS public origin, external master key and explicitly configured OIDC owner. Every owner API requires a valid server-side session. The identity provider handles passkeys, MFA and recovery. See [identity setup](IDENTITY.md).

The server validates Host, Origin, JSON bodies and cross-site requests. Remote writes require a per-session CSRF token and exact configured Origin. OIDC callbacks are the narrow cross-site navigation exception, protected by one-use cookie-bound state, nonce and PKCE. Static files are restricted to the real frontend directory. CSP excludes remote scripts and framing. Reverse proxies must preserve the configured Host, terminate TLS and restrict direct backend access.

## Encryption and credentials

Production stores use `studio.sqlite`, with AES-256-GCM authenticated encryption per record. Record key and revision are authenticated additional data. SQLite transactions, full synchronization and a process lock protect committed state; payloads in WAL and backups remain encrypted. Metadata such as record keys, sizes and timestamps is not hidden. This is application record encryption, not whole-file SQLCipher encryption.

Local mode generates a 32-byte `archive.key` with private permissions. Remote modes require a separately managed `FUORI_STUDIO_MASTER_KEY`. The local file key is **not an OS keychain**. Theft of both database and key permits decryption, and the running server necessarily sees plaintext. Use OS disk encryption and protect the host. This is not end-to-end encryption.

Codex credentials stay in the Codex installation on the execution computer. Provider API keys and paired-device credentials stay in the encrypted server/worker archive; public snapshots omit them. Memory export and sync exclude credential records. Keys entered in settings pass through the authenticated browser request but are not stored in browser localStorage. Provider error bodies and raw Codex diagnostics are not exposed.

Selected prompts can leave the machine for the chosen AI provider. Policies cover active and inherited source scopes. No provider fallback occurs. External text adapters expose no executable tools. Chat Codex runs ephemerally with ignored user configuration and a read-only sandbox. The separate repository runtime uses an isolated committed snapshot, restricted filesystem reads/writes and disabled command network access; sandbox failure blocks execution. A prompt saying not to use tools is not an OS guarantee that every local file is unreadable.

## Devices and synchronization

The owner issues a 5-minute random, one-use pairing code for specific scopes and capabilities. Device credentials expire after 30 days and can be revoked immediately. Workers initiate outbound HTTPS; they do not expose the local studio port. Devices claim only work addressed to them. Execution and synchronization capabilities do not grant owner API access.

Jobs require a current device token and one-use lease. Expired, cancelled, revoked or restarted executions reject late results. There is no automatic re-execution after a lost lease and no exactly-once inference guarantee. Cancellation cannot retract information or charges already incurred at a provider.

Knowledge sync transfers current selected-scope notes and procedures, not local revision archives, provider credentials or sharing grants. Three-way comparison surfaces divergent edits. Durable deletion markers prevent an old device from silently recreating a forgotten record. Restore useful text as a new reviewed note if needed. Revocation prevents future requests but cannot erase an already downloaded copy.

## Memory trust and deletion

AI output is untrusted. Candidate extraction accepts bounded, source-verified literal statements from the current user message. Assisted mode proposes; automatic mode is opt-in per scope and limited to selected safe categories. Conflicts, sensitive claims and sharing require review. Rules detect common secrets and sensitive patterns, but are not a complete DLP classifier.

Forgetting invalidates durable retrieval and dependent generated context. Suppression hashes stop automatic recreation from the same source/content. It does not erase original chat messages, data already sent to providers, encrypted migration snapshots or existing backups. History retention, provider retention and backup retention are separate responsibilities. Portable imports are explicit user actions and enter as proposals with new IDs, never silently restoring deleted sync IDs.

## Migration, backup and restoration

Legacy JSON is validated before migration. Original bytes and digest are committed as an encrypted migration backup alongside the live record, then the unchanged plaintext source is retired. Invalid, divergent, symlinked or changed sources stop migration and remain intact. Conversation archives are migrated at startup, including inactive scopes and history. Unknown files in the private directory are not automatically deleted.

For a consistent backup:

1. Pause work and stop the server cleanly.
2. Run `npm run backup -- /secure/location/studio-backup.sqlite`. An existing destination is never overwritten.
3. Back up `archive.key` separately, or retain the deployment master key in your secret manager. Recovery requires the matching key.
4. Restore the database as `studio.sqlite` into a new private directory and supply the matching key. Do not reuse a live directory or copy a running WAL database with ordinary file copy.
5. Start with `FUORI_STUDIO_DATA_DIR=/absolute/restored/path`, verify memories, projects and deliveries, then switch the normal installation.

The backup includes sensitive encrypted data, provider credentials and migration history. Memory export is the safer choice for sharing selected knowledge with another tool. Old backups can retain deleted records or keys; manage retention separately. No managed backup service or secure SSD erasure is claimed.

Corruption and missing/wrong keys fail closed. A crash may leave `server.lock`. Before removing it manually, verify no process uses that directory. Network-mounted shared archives, concurrent server processes and replication of raw SQLite files are unsupported.


## Repository and source capabilities

Repository checkouts under the private data directory contain plaintext source files. They are not encrypted merely because the archive is encrypted. Captured patch artifacts and metadata are encrypted records; neither working checkouts nor source documents enter knowledge sync or portable memory by default. Git hooks/configuration, symlinks, submodules and protected file paths are restricted. Owner-configured checks are executable code; use trusted source and inspect the evidence.

Source URL requests reject private/local addresses, revalidate redirects, bound body sizes and time, and do not run page JavaScript. Local folder imports are limited to configured or registered repository roots, skip sensitive paths and reject symlinks. Importing a source never grants it instruction authority. Native provider web search sends only the explicitly requested query, uses the existing scope authorization, and exposes provider-returned citations. Source content can be inaccurate even when retrieval succeeded.

AI attempts are reserved durably before dispatch. Daily counts include failures and interruptions; missing token data remains unknown. These are application controls, not a provider billing guarantee.
