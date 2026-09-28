# Backup verification and recovery

Fuori Studio stores application records in an AES-256-GCM encrypted SQLite database. A backup contains provider credentials, configured GitHub tokens and private work inside authenticated ciphertext. It does **not** include the encryption key, environment configuration, repository checkouts, isolated work directories, or backup files stored alongside the database. Keep the encryption key in a different protected location from database copies. Losing either the database or its matching key prevents recovery.

## Create and verify a copy

In **Accesso → Preparazione**, select **Crea backup verificato**. The server creates an exclusive encrypted SQLite snapshot under the private data directory's `backups/`, checks SQLite integrity and schema, authenticates every record with the current key, and records a SHA-256 digest in the encrypted live archive. Download that copy and move it to separately managed storage. A successful download verifies the recorded digest again. Authentication, the owner's session, and CSRF protections apply to the browser operations.

**Verifica l’archivio** checks the current live database, including its current WAL snapshot. Its timestamp describes that verification only. It does not reverify every historical backup, confirm off-server storage, or prove a future restore will work. Perform a restore drill as described below.

At most 30 managed backup copies are registered. There is no automatic deletion or remote deletion route. Stop the studio before using the maintenance CLI:

```sh
npm run maintenance -- list
npm run maintenance -- remove <backup-id>
```

Removal permanently deletes the identified local copy; export and verify a separate copy first. The CLI refuses symlinks and arbitrary paths. It can remove an index entry for a file already missing after an interrupted removal. Restart the studio when maintenance finishes.

For a standalone copy outside the managed index, stop the studio and run:

```sh
npm run backup -- /secure/backup-location/studio-backup.sqlite
```

The destination must not exist. This command obtains the application instance lock, creates and verifies the encrypted copy, and refuses to run against an active studio archive. A standalone copy is not listed in the browser's managed backup index.

## Restore into a new directory

Use Node 24 and a compatible checkout of this application. Never overwrite the active data directory. The restore command requires a **nonexistent** destination directory with an existing parent, including for a drill. An existing empty directory is also refused.

For an archive that used a local binary `archive.key`:

```sh
npm run restore -- /secure/studio-backup.sqlite \
  --into /secure/studio-restored \
  --key-file /separate-key-storage/archive.key
```

For an archive encrypted with an external base64 master key, provide `FUORI_STUDIO_MASTER_KEY` through your secret manager or configure a text secret mount:

```sh
FUORI_STUDIO_MASTER_KEY_FILE=/run/secrets/studio_master_key \
  npm run restore -- /secure/studio-backup.sqlite --into /secure/studio-restored
```

The `_FILE` value contains the path to a text file holding the base64 secret. A local `archive.key` instead contains exactly 32 raw bytes. Do not confuse these two formats. Direct and `_FILE` configuration are mutually exclusive, as are an external master key and `--key-file`. Neither CLI prints key contents.

The command authenticates the source before creating the destination, obtains an exclusive instance lock, copies into private files, authenticates the copy, and performs the recovery changes in one encrypted transaction. It verifies the result again and releases the lock only after successful completion. Source files remain unchanged. Backup verification uses a private encrypted temporary copy because SQLite can otherwise create WAL sidecars even when opened read-only.

Recovery preserves memories, conversations, projects, task history, provider configuration, approved results and source documents. It deliberately resets:

- Owner sessions and unfinished login flows. Sign in again using the configured exact OIDC owner.
- Device pairings, device tokens, worker inventories, pending remote jobs, worker connections and local worker repository permissions. Pair again and explicitly authorize repositories and checks.
- Knowledge synchronization credentials and selections. Reconnect and select scopes again.
- Pending portable import previews. Open a new preview before importing.
- Managed backup metadata, because those separate files are not in the restored database.
- Autonomous routine permission and every individual enabled routine. Review and enable them explicitly only after the installation is verified.

Interrupted tasks and repository executions retain their history. Normal startup recovery moves interrupted work into its existing paused/interrupted state; it does not automatically rerun an AI call. Interrupted GitHub publications require read-only reconciliation before another explicit publication attempt. Provider API credentials and configured GitHub tokens **remain encrypted in the restored archive**: inspect them and rotate them if the recovery follows a compromise. Expired or revoked upstream credentials do not become valid again through restoration.

If restoration fails after creating the destination, its lock remains and prevents normal application startup. Preserve it for inspection and repeat recovery into a different new directory. Do not remove that lock to turn a partial restore into a working installation.

## Verify and cut over

1. Keep the original installation stopped or isolated. Retain the untouched source database and key.
2. Start the restored instance with `FUORI_STUDIO_DATA_DIR` pointing to the new directory and the matching key configuration. For hosted use also configure the external key, HTTPS origin, OIDC client and exact owner subject from your separately retained deployment configuration.
3. Sign in, inspect a known project and private memory, run **Verifica l’archivio**, and create/download a fresh managed backup. Confirm provider scope permissions before sending any AI request.
4. Pair the intended worker again, register its repository aliases and approved checks, and perform a small, reviewable execution on a disposable repository. A live AI runtime must be verified on that worker; database verification does not test sandbox compatibility.
5. Change the service's data-directory mount only after the restored instance passes inspection. Keep the former directory as a separately protected rollback copy until your retention policy permits removal.

The database alone does not restore DNS, TLS certificates, OIDC configuration, external API permissions, worker logins or Git repositories. Those require their own operational backup and recovery procedures. Browser-based memory export is a different feature: it carries selected knowledge, not a complete installation backup.

## Crash locks

Normal shutdown releases `server.lock`. A crash can leave a stale lock. The studio refuses to guess whether another process or restored copy still owns it. For a normal installation crash, first establish that no process is using that exact data directory, preserve a backup, then remove only the stale lock and restart. This is an operator action. It is **not** the recovery procedure for a failed restore, whose directory should remain blocked.

## Validation scope

Automated tests use disposable encrypted archives. They cover every-record authentication, corruption and wrong keys, verification without plaintext disclosure, digest changes, permissions, symlink rejection, concurrent backup requests, retention capacity, existing/live restore destinations, local and external secret keys, preserved source data, and reset access/autonomy. HTTP tests cover authenticated browser access separately. These are controlled recovery drills; operators must still test their own mounted storage, secrets and hosted deployment before relying on them.
