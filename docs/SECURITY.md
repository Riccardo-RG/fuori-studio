# Security, backup and recovery

## Supported trust boundary

Fuori Studio is a single-user application bound to loopback. It has no internet-facing authentication or multi-tenant access control. Do not bind it to a public interface, expose it through a tunnel, or assume scope labels separate different logged-in users.

The HTTP server checks Host, Origin and cross-site browser requests. Writes require JSON and `X-Fuori-Studio: local`. Static files are served only from the real frontend directory; local data and symlink escapes are not served. Content Security Policy blocks remote scripts and framing. These controls do not protect against malware or another process running as the same operating-system user.

## Credentials and data destinations

Codex uses the existing local CLI login. Fuori Studio does not copy that login into the repository. API connection keys are kept server-side in `.local/providers.json`, mode `0600`; the containing directory is created with mode `0700`. Public provider responses expose configuration flags, not keys. Upstream error bodies are not returned to the browser. Keys are not kept in browser localStorage.

The keys are **not encrypted at rest**. Protect the computer, use disk encryption, and exclude the private archive from untrusted sync/backup locations. Never paste keys into tasks or memories; ordinary content is intentionally sent to models when selected.

OpenRouter is an additional routing intermediary. Direct adapters send to fixed vendor HTTPS endpoints. No arbitrary endpoint URLs are accepted. Scope policies apply to both current and referenced source scopes. Missing policy allows only Codex. Missing usage is unknown; billing can occur even when a request is cancelled or fails locally after remote completion.

## Models and tools

External API adapters send no executable tools. The Codex adapter is ephemeral, read-only, and instructed not to use tools. A read-only sandbox and prompt instruction are not the same as an OS isolation boundary that makes every read impossible. Only run the application with a trusted local Codex installation. Repository write tools, publication, email and web research are not exposed as product capabilities.

Generated text is treated as untrusted data. Review output before using it, executing copied commands or confirming it as memory. Provider output cannot directly approve a delivery or mutate stored memory.

## Backup

1. Pause running work and stop the server cleanly.
2. Copy the entire private data directory to a protected destination. Include conversations, workspace, operations and provider configuration if you intend to restore connections.
3. Keep API-key-containing backups private or encrypted with your operating-system backup tools.
4. Restore to a new directory first, remove only its copied `server.lock`, and start with `FUORI_STUDIO_DATA_DIR=/absolute/restored/path`.
5. Verify projects, memory versions and deliverables before switching back to normal use.

Do not back up only one archive during an active run: cross-file changes are not one database transaction. No automated backup service is implemented.

## Recovery

Writes are atomic replacements; malformed archives are preserved and cause an error. Never “fix” corruption by silently initializing empty state. Keep the original copy for diagnosis, then restore a known-good backup.

On clean shutdown, active tasks are paused and the server lock is released. On startup, interrupted running tasks become paused. Existing locks, including stale locks after a crash, fail closed. Automatic read-then-unlink reclamation is avoided because concurrent startups could remove each other’s lock. If manual lock removal is needed, first verify no server still uses the directory. PID reuse may conservatively report an unrelated live process as an owner.

This implementation is designed for one process on one local filesystem. Network-mounted shared data directories and concurrent copies of the archive are unsupported.
