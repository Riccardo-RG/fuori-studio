# Deploying a private studio

The supported layout is one web process and one encrypted archive per owner. A browser on a phone, tablet or computer connects to the HTTPS studio. Authorized workers run repository jobs on separate computers. The web image does not install Codex, receive its login, mount source checkouts or expose a Docker socket.

Local development remains `npm ci` followed by `npm start` on Node 24. An Intel development computer does not constrain the browser devices that can use the hosted product. A worker's real AI runtime and OS sandbox must be checked independently; changing the web host does not prove that an existing worker is compatible.

## Requirements

- A Linux host with a maintained Docker Engine and Docker Compose v2, enough disk space for the archive, snapshots and backups, and outbound HTTPS for identity and configured AI services.
- A domain whose DNS points to that host, with TCP ports 80 and 443 available to the proxy.
- A confidential OIDC application and the exact owner's subject, configured as described in [Identity and access](IDENTITY.md).
- Two separately managed secret files: the archive master key and OIDC client secret. Preserve an independent recovery copy of the archive key.

The checked-in images use `node:24-bookworm-slim` and `caddy:2-alpine`. For a release, select reviewed image digests through `FUORI_STUDIO_NODE_IMAGE` and `FUORI_STUDIO_CADDY_IMAGE`, build and test them on the destination architecture, and record those digests with the release. The examples are not a claim that a mutable tag is immutable or has been scanned.

## Configure and start

Keep the secret files outside the repository and build context. Generate a new archive key only for a new installation; an existing archive must retain its original key. Run the following with Node 24, substituting a private directory you control:

```sh
umask 077
mkdir -p /absolute/private/studio-secrets
node -e "require('node:fs').writeFileSync('/absolute/private/studio-secrets/archive-key', require('node:crypto').randomBytes(32).toString('base64') + '\n', {flag: 'wx', mode: 0o600})"
```

Save the provider's client secret as `/absolute/private/studio-secrets/oidc-client-secret` through your secret manager or editor. Do not paste either secret into shell arguments, the Compose file, Git or an agent prompt. Both must be regular files, not symbolic links, containing a single value. The application rejects an empty, oversized or ambiguous secret source.

The web container runs as UID/GID 1000. With local Compose file secrets, the host's file permissions must allow that container identity to read each file. On a Linux host without user-namespace remapping, an administrator can set owner `1000:1000` and mode `0400` on the two files. With rootless Docker or user-namespace remapping, use the corresponding host identity. Do not make the secrets world-readable. Compose's bind-mounted file secrets do not reliably remap ownership using a `uid` declaration; check access on the actual host. Only the studio service receives these mounts. [Docker's secret guide](https://docs.docker.com/compose/how-tos/use-secrets/) explains the per-service mounts and `_FILE` convention; Fuori Studio implements that convention in its startup loader.

Create a private deployment environment file outside the checkout with non-secret configuration and paths:

```dotenv
FUORI_STUDIO_DOMAIN=studio.example.com
FUORI_STUDIO_OIDC_ISSUER=https://identity.example.com
FUORI_STUDIO_OIDC_CLIENT_ID=registered-client-id
FUORI_STUDIO_OWNER_SUBJECT=exact-immutable-subject
FUORI_STUDIO_OIDC_CLIENT_AUTH=client_secret_basic
FUORI_STUDIO_MASTER_KEY_PATH=/absolute/private/studio-secrets/archive-key
FUORI_STUDIO_OIDC_CLIENT_SECRET_PATH=/absolute/private/studio-secrets/oidc-client-secret
```

Register the exact callback `https://studio.example.com/auth/callback` with the provider. `FUORI_STUDIO_DOMAIN` is a hostname only, without a scheme, path, wildcard or spaces. Then, from the repository:

```sh
docker compose --env-file /absolute/private/studio-deploy.env config --quiet
docker compose --env-file /absolute/private/studio-deploy.env build --pull studio
docker compose --env-file /absolute/private/studio-deploy.env run --rm --no-deps studio node scripts/doctor.mjs
docker compose --env-file /absolute/private/studio-deploy.env up -d
docker compose --env-file /absolute/private/studio-deploy.env ps
```

The doctor command diagnoses configuration without calling an AI or opening the archive. Its unknown checks are expected before startup. The web service's health check requests `/healthz` with the configured public host and receives only an availability result. It does not prove DNS, TLS, provider authentication, backup recovery or successful AI execution.

The application listener is available only on the Compose network, with no published port 4386. The Caddy proxy publishes 80 and 443, preserves the public Host, caps request bodies at 20 MB and persists certificate state. Caddy attempts automatic public certificates after DNS and network prerequisites are satisfied; see its [reverse proxy guide](https://caddyserver.com/docs/quick-starts/reverse-proxy). This Compose network permits outbound service traffic; it is not an egress firewall. Add host/network controls and traffic rate limits appropriate to the hosting environment.

The web process has a read-only root filesystem, a bounded temporary filesystem, no Linux capabilities, process/memory/CPU limits and a writable named volume only at `/data`. Caddy has separate certificate volumes and the port-binding capability. Review the [Compose service reference](https://docs.docker.com/reference/compose-file/services/) when adapting these limits to another orchestrator. Do not scale the studio service above one replica or share its archive between processes.

## Verify the actual installation

Open the public URL from another device. Complete owner sign-in and verify that a different account is denied. Open **Accesso → Preparazione** to inspect the authenticated session, archive encryption, worker presence and maintenance evidence. An HTTPS configuration check remains an external verification item because the server cannot certify the browser's public route.

Create and download a verified encrypted backup, store it away from the host, and perform the [restore drill](DEPLOYMENT_RECOVERY.md) in a fresh directory. The archive key is not inside the backup. Restoring data and proving you still have the right key are part of installation acceptance, not optional consequences of a healthy process.

Pair a worker and authorize a repository using [Paired repository workers](REMOTE_EXECUTION.md). Run a small assignment with real checks, inspect its diff and approve it manually. Until this succeeds on the selected host, AI sandbox compatibility remains unverified. Configure per-project scope permissions and use the product's limits before enabling any recurring work.

## Optional Linux worker service

`deploy/fuori-studio-worker.service` is an example for a dedicated unprivileged account named `fuori-studio-worker`, with home `/var/lib/fuori-studio-worker`. Install this checkout and Node 24 at the paths shown in the unit, or edit the paths to match the host. Install a supported Codex CLI independently and verify its normal sandbox; no sandbox bypass is enabled by the unit.

Keep application files in `/opt/fuori-studio` read-only to the worker. Place trusted source checkouts and prepared dependencies under `/srv/fuori-studio-repositories`, also read-only to the service. Give the account private ownership of `/var/lib/fuori-studio-worker`. The service writes isolated execution snapshots, its own local encrypted archive and Codex state there. Its archive key, pairing credential and local Codex login are separate from the hosted studio's master key and OIDC secret.

Before enabling the service, stop any existing instance and perform login, pairing and repository authorization as that account, with the same `FUORI_STUDIO_DEVICE_DIR`, `FUORI_STUDIO_CODEX_BIN` and `CODEX_HOME` paths as the unit. Use the one-time pairing prompt and explicit checks file described in the worker guide. Never copy the hosted server's secret configuration to the worker. Install the reviewed unit and enable it through the host's systemd administrator workflow. Pairing alone is not permission to read every local repository.

The worker makes outbound HTTPS requests and needs no inbound port. The service deliberately leaves Linux namespaces available to the AI sandbox. Do not add systemd syscall/namespace restrictions until they have been tested with the exact runtime; a sandbox failure must remain a failed job. The unit has restart limits and does not rerun uncertain paid work after an interruption.

## Updates, shutdown and limitations

Make and download a verified backup before upgrading. Rebuild the reviewed release, stop the old process gracefully, and start one replacement using the same data volume and master key. `docker compose down` stops the installation without deleting its named volumes; do not add `--volumes` when retaining data. Pin dependencies and review migration/recovery documentation before rolling back across versions.

An unclean kill may leave the exclusive `server.lock` in the data directory. Restart is deliberately blocked until an operator confirms that no process or container can use that archive and removes only the stale lock. PID reuse across container restarts is not proof of ownership. Stop the service and all recovery jobs before lock recovery; do not automate lock deletion or delete the archive to make startup succeed.

The deployment files have been reviewed and can be checked statically, but Docker is not installed on the development Mac used for this change. An actual image build, container startup, public TLS/OIDC exchange, target-host sandbox run and off-host restore remain deployment acceptance steps. Local fixture tests do not substitute for those external checks.
