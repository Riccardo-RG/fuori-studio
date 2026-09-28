# Development

Use Node 24 LTS, `npm ci`, `npm run check`, and `npm test`. Keep `package-lock.json` committed. Use disposable `FUORI_STUDIO_DATA_DIR` directories for development tests; never add fixture messages or fake credentials to a user's archive.

## Boundaries

- Keep request parsing and authorization in the HTTP layer; state transitions belong in stores.
- Keep provider adapters separate from workflow state and UI code.
- All model destinations must be checked against active and source-scope policies.
- Persist context references with every derived response. Handoffs must not bypass agent restrictions.
- Never expose a generic internal store mutation or arbitrary endpoint URL through the public API.
- Prefer explicit user approval for artifact acceptance. A model cannot approve its own work.
- Treat cancellation, late results, process restart and stale UI versions as normal cases to test.

## Tests

The Node test runner covers stores, provider adapters, context provenance and HTTP flows. Provider tests inject mocked fetch responses; integration tests use a temporary fake Codex executable. They must not depend on paid API calls or a developer's credentials. Loopback binding must be allowed by the test environment.

Browser checks should use a temporary archive, the real HTTP server and a fake provider. Check desktop and mobile, keyboard focus, dialog errors, project isolation, review/revision, routine creation and provider-secret redaction. Decorative WebGL rendering must not block access to the work UI.

## Changes and documentation

Keep user-facing copy in Italian and documentation in English. Update README, relevant guides and API contracts when behavior changes. Describe implemented behavior separately from roadmap items. Do not claim static typing, database transactions, encryption, autonomous research or real-provider validation unless those features were actually implemented and verified.

Avoid migrations just to add a fashionable framework. Add dependencies for a concrete capability, pin reproducible versions, review maintenance and security, and add tests around the relevant integration boundary. Production stores must use the encrypted archive adapter. Test factory support for legacy JSON is not an alternative hosted backend. Hosted mode must keep exact-owner OIDC and CSRF protections. Multiple server processes and multi-tenant registration require a new authorization/storage design; never weaken the local boundary to approximate them.

New domain services should use strict TypeScript with erasable syntax supported by Node 24. Keep runtime validation at every external boundary; types do not validate HTTP, model, filesystem or archive data. `npm run check` includes `tsc --noEmit`. Existing JavaScript modules may be migrated incrementally when touched for a substantive change; avoid untested renames or framework migrations for appearance alone.

Repository, source, provider and automation changes require meaningful tests with temporary data and injected transports/runtimes. The full developer suite (`npm test`) includes localhost HTTP servers. Configure `npm run check` and `npm run test:offline` for Fuori Studio repository runs inside the network-disabled sandbox; `test:offline` excludes HTTP integration files and `integration.test.mjs`. It does not replace the full developer suite. Record which checks actually ran and report a sandbox incompatibility separately from a code failure. Do not run paid AI, publish code, reuse personal credentials or weaken a sandbox to make the suite pass. Keep generated checkouts, fixtures, archive keys and browser artifacts outside Git.
