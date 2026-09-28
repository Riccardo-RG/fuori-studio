# Identity and access

Fuori Studio supports one owner per studio installation. Local mode does not require an online account. Hybrid and online modes require an explicitly configured OpenID Connect (OIDC) identity provider and an exact owner subject. They do not offer public registration or assign ownership to the first visitor.

The studio account, AI service connections, and paired execution devices are separate identities. Signing into the studio never uploads a Codex login or grants another user access to it. OIDC tokens are used only to validate the owner at sign-in; access, refresh, and ID tokens are not kept in the studio archive.

## Configure remote access

Use a maintained OIDC provider, directly or through your identity broker. Google supports OIDC. GitHub's general OAuth login is not itself an interchangeable OIDC issuer; use a broker that supports GitHub if that is the preferred sign-in experience. Passkeys and multifactor authentication can be enforced by the chosen provider. Fuori Studio does not implement its own password database, passkey enrollment, account recovery, or identity-provider administration.

1. Register a confidential web application at the identity provider. Set the exact redirect URL to `https://your-studio.example/auth/callback`. Enable the authorization code flow and PKCE with S256.
2. Obtain the provider's **issuer identifier**, client ID, client secret, and the immutable OIDC `sub` assigned to your account for that client. The subject must come from the provider's administrative/account tooling or another trusted provider workflow. An email address, username, GitHub handle, or display name is not a substitute for this identifier. Pairwise subjects can differ between clients.
3. Configure the following variables in the server's secret/environment configuration. `.env.example` contains an editable template.

   | Variable | Meaning |
   | --- | --- |
   | `FUORI_STUDIO_MODE` | `local` (default), `hybrid`, or `online` |
   | `FUORI_STUDIO_PUBLIC_URL` | Exact HTTPS origin, for example `https://studio.example.com`; no subpath |
   | `FUORI_STUDIO_OIDC_ISSUER` | HTTPS issuer identifier, not the `.well-known` document URL |
   | `FUORI_STUDIO_OIDC_CLIENT_ID` | Registered confidential client identifier |
   | `FUORI_STUDIO_OIDC_CLIENT_SECRET` | Server-only client credential |
   | `FUORI_STUDIO_OWNER_SUBJECT` | Exact, case-sensitive allowed `sub` |
   | `FUORI_STUDIO_OIDC_CLIENT_AUTH` | `client_secret_basic` (default) or `client_secret_post`, matching provider configuration |

4. Serve the public origin through HTTPS and forward it to the studio server according to the deployment configuration. Keep the private listener inaccessible from the public network except through the configured proxy. Do not rewrite the advertised public origin from incoming `Forwarded` or `X-Forwarded-*` values. Configure trusted host routing and proxy request/rate limits.
5. Start the configured server. If using a local `.env` file, Node 24 supports `node --env-file=.env server.mjs`. The plain Node process does not automatically read `.env` files. Keep this file out of version control.
6. Open the public origin and choose the sign-in action. Only the configured issuer and subject can reach the studio. Try a different account to verify rejection before sharing the URL.

Missing or insecure configuration causes remote mode to refuse startup. Discovery is deferred until sign-in; provider outages do not silently turn the installation into an unauthenticated local studio. Changing the issuer, client ID, or owner subject invalidates existing owner sessions on the next request.

The application currently supports a single process per archive and a single owner. Other accounts require separate studio installations and archives. This is not a multitenant workspace or organization invitation system.

## Sessions and browser protection

- Authorization uses code flow with fresh PKCE, state, and nonce values. A ten-minute, one-use login transaction is bound to a secure browser cookie and consumed before the code exchange. Callback parameters do not choose the issuer or return URL.
- The maintained `openid-client` library validates the protocol response, audience, issuer, nonce, expiry, and ID token signature using the issuer's JWKS. Metadata and protocol endpoints must use HTTPS. No insecure discovery escape hatch is enabled.
- A successful login rotates the browser session. Session bearer tokens contain 256 random bits; only their SHA-256 hashes are stored. Cookies use the `__Host-` prefix, `Secure`, `HttpOnly`, `SameSite=Lax`, and `Path=/`, without a `Domain` attribute.
- Sessions expire after eight hours absolutely or one hour of inactivity. Activity timestamps are refreshed at most once every five minutes, so idle expiry may occur up to five minutes earlier than the last request plus one hour. At most twenty live owner sessions are retained; the least recently active session is removed when needed.
- Server-side sessions and temporary login transactions use the encrypted archive storage contract. Revocation is immediate for subsequent requests and persists across restarts. Revoking all sessions also invalidates unfinished login exchanges, including an exchange already waiting for its provider response.
- All authenticated mutations require the configured exact `Origin` and the session's `X-CSRF-Token` header. The read-only `/api/session` response provides that token to the same-origin application. Cross-site mutation requests are rejected. The OIDC callback is the narrow exception to the server's cross-site navigation filter; its state, cookie, nonce, and PKCE checks remain mandatory.
- Login starts are bounded to ten attempts per network address per fifteen minutes within each process, with additional caps on pending transactions and rate-limit entries. A reverse proxy should also bound public traffic; this in-process limiter is not distributed protection.
- Authentication responses are never cached. Unauthenticated requests to protected APIs must be rejected by the server before reading any studio data. Static UI assets and `/api/session` can be served before login.

Local mode retains the loopback host/origin protections and the `X-Fuori-Studio: local` mutation header. It deliberately trusts the local device user; selecting local mode is not an authentication strategy for a publicly reachable listener.

## HTTP contract

`GET /api/session` returns a safe public status:

```json
{
  "mode": "hybrid",
  "authRequired": true,
  "authenticated": false,
  "user": null,
  "csrfToken": null,
  "loginUrl": "/auth/login",
  "session": null,
  "capabilities": { "singleOwner": true, "oidc": true }
}
```

After authentication, `user` contains `{ "name": "...", "role": "owner" }`; `session` contains an opaque non-secret ID and numeric `createdAt`, `lastSeenAt`, and `expiresAt` timestamps in milliseconds. The status also includes the session CSRF token. It never includes OIDC subject, client secret, provider tokens, or the session bearer token. In local mode the owner is already authenticated, `loginUrl`, `session`, and `csrfToken` are `null`.

| Endpoint | Method | Behavior |
| --- | --- | --- |
| `/auth/login` | GET | Start same-origin sign-in; redirects to the configured provider |
| `/auth/callback` | GET | Validate one-use callback and redirect to `/` after success |
| `/auth/sessions` | GET | List authenticated owner's sessions with timestamps and a `current` flag |
| `/auth/logout` | POST | JSON `{}`; revoke the current session and clear its cookie |
| `/auth/sessions/revoke` | POST | JSON `{ "id": "..." }`, `{ "others": true }`, or `{ "all": true }`; revoke the selected sessions |

Mutations use `Content-Type: application/json` and the CSRF header. Authentication errors use `{ "error": "..." }` with a suitable HTTP status, without raw provider responses or database details. Logout ends the Fuori Studio session; it does not log the user out of the identity provider or disconnect an AI service.

## Recovery and validation

Revoke a lost browser session from another authenticated browser. If every browser is unavailable, an administrator can change the allowed owner subject/client configuration through the trusted server environment; old sessions will no longer authenticate. Use the identity provider's recovery process to restore the actual account. Never create a public first-owner claim route as a recovery shortcut.

`test/identity.test.mjs` covers configuration failures, unauthorized owner subjects, callback replay, duplicate cookies/state, CSRF, session rotation/expiry, durable revocation, storage failures, rate limits, and revocation during an in-flight exchange. It also exercises real `openid-client` with locally generated RSA-signed ID tokens and a mocked HTTPS transport, verifying that an incorrect signature, audience, issuer, nonce, or expiry is rejected. These tests do not replace a deployment check against the configured provider, TLS proxy, and domain.

Protocol references: [openid-client documentation](https://github.com/panva/openid-client/tree/main/docs), [authorization code checks](https://github.com/panva/openid-client/blob/main/docs/interfaces/AuthorizationCodeGrantChecks.md), [signature validation](https://github.com/panva/openid-client/blob/main/docs/functions/enableNonRepudiationChecks.md), and [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).
