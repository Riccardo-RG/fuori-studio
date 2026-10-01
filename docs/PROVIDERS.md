# AI connections

Fuori Studio can assign a different AI connection to each of its five roles. A role is a set of instructions and responsibilities; it is not a separate subscription. Several roles can share one connection, and the coordinator can use a different connection from the specialists.

The ordinary provider adapters support text conversations and structured coordination. Separate explicit workflows add local Codex repository editing and OpenAI API web research. Selecting a connection does not itself give an API model a browser, shell, repository access or the capabilities of Claude Code. The studio may start text tasks through separately enabled routines; only the explicit research action supplies the supported web-search tool. Choosing Anthropic means using its Messages API, not launching Claude Code.

## Supported connections

| Connection type | Execution path | Authentication |
| --- | --- | --- |
| `codex` | Local CLI, or the explicitly selected paired computer | Existing Codex login on the execution computer |
| `openrouter` | OpenRouter Chat Completions | An OpenRouter API key |
| `openai` | OpenAI Responses API | An OpenAI API key |
| `anthropic` | Anthropic Messages API | An Anthropic API key |
| `deepseek` | DeepSeek Chat Completions | A DeepSeek API key |

Codex is built in and cannot be deleted. Every role initially uses it. The app does not sign in to Codex, export its credentials, or exchange a Codex subscription for another provider's access. `configured: true` on the built-in connection means that it does not need an API key in the connection store; it does not prove that the CLI is installed, authenticated, or has remaining quota. The separate Codex status check tests local availability and login.

An API connection needs the provider's own key, account access to the chosen model, and any required credits. A consumer chat subscription does not automatically supply API credit. Provider access, availability, prices, retention terms, and limits remain the provider's responsibility; check the account you actually connect.

Model identifiers are entered explicitly. There is no embedded list that claims to be the latest model catalog. Use an identifier supported by the chosen endpoint, including the provider prefix when OpenRouter requires it. The connection name is just a local label.

## Setup flow

1. Create a connection with a name, supported type, exact model identifier, and API key. Saving only writes local configuration; it does not make a model request.
2. Use the explicit connection test if desired. This sends only `Reply with only the word OK.` with a 64-token output ceiling for API connections (the local Codex probe uses its normal process limits). It is a real, potentially billable request and contains no project context. Some reasoning models may use the small allowance before producing text; a failed test is not automatically proof that the key is wrong.
3. Assign the connection to a role. An external connection without a key cannot be assigned.
4. Authorize the connection for the relevant context scopes. Assignment does not grant permission to transmit a scope's data.
5. Start a conversation. The configured model receives the context selected by the conversation layer. The other roles retain their own assignments.

An omitted or blank API key when editing preserves the current key. Enter a new value to rotate it. To remove a saved key completely, reassign any agents using that connection and delete the connection. Changing a connection's provider type requires a new connection, preventing an existing provider key or scope approval from being reused for another service by accident.

## Scope consent

Without an explicit scope policy, only `codex` is allowed. A policy is a list of **connection IDs**, not provider names. An empty list permits no connection. A new connection, even of an already used provider type, needs its own authorization.

The conversation layer must authorize every source scope included in a prompt, including explicitly shared memories, referenced historical context, a shared profile, and a selected workflow. Authorizing a destination scope does not grant access to its source scopes. The provider store validates one scope at a time; it deliberately does not load the workspace or infer cross-scope permissions. The HTTP/conversation integration must check that a scope exists and enforce the full source set before calling `execute`.

`execute` also checks the active scope immediately before dispatch. A blocked, unconfigured, removed, or failed connection does not fall back to Codex or another service. No request is automatically retried. Deleting a connection still assigned to a role is rejected. Deleting an unused connection removes it from policy lists without adding another connection.

Changing a policy controls future dispatches. It cannot retract data already sent to a provider. Stop an active conversation before changing its configuration. A gateway such as OpenRouter sends requests onward under its own routing and data policies; authorizing that connection includes that external route. Fuori Studio does not control or audit the gateway's downstream infrastructure.

## Credentials and local storage

Provider records are encrypted inside `.local/studio.sqlite`, or the configured `FUORI_STUDIO_DATA_DIR`. The production singleton always uses the encrypted archive; standalone factory tests can inject an isolated legacy JSON backend. Existing `providers.json` is validated, encrypted with a migration backup, and retired after a durable database commit.

Records use AES-256-GCM with a separate deployment key. Local mode can generate `archive.key` with mode `0600`; remote modes require an external master key. This is not an operating-system keychain and does not protect against another process with the same OS permissions or a compromised running server. Protect and back up the key separately. See [security guidance](SECURITY.md).

Public snapshots contain metadata, `configured` and `hasKey`, never a key fragment. Keys are sent in provider authentication headers, never deliberately included in model prompts. Known credentials are rejected in outgoing prompts and literal credential echoes are redacted. Keys do not travel through knowledge sync or portable memory. Encrypted migration backups can retain older credentials; deleting an active connection is not cryptographic erasure of backups.

API keys entered in the settings form necessarily pass from that browser to the local server. The app must not retain them in browser storage, public state, chat history, analytics, or logs. The server-side store cannot erase a credential that a user independently pasted into a chat message; remove such messages separately and rotate any exposed key.

Provider HTTP error bodies, raw transport exceptions, and Codex runtime diagnostics are not returned to the browser. Errors use fixed, actionable messages. A malformed, oversized, incompatible, tampered or symlinked archive fails closed and is not reset automatically. Restore a valid private backup or repair the file locally; do not paste its contents into chat. Use one server process per data directory: the mutation queue coordinates writes inside that process, not across several independently running servers.

## Execution limits

External requests use native server-side `fetch` with fixed HTTPS endpoints and redirects disabled:

| Type | Endpoint |
| --- | --- |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| OpenAI | `https://api.openai.com/v1/responses` |
| Anthropic | `https://api.anthropic.com/v1/messages` |
| DeepSeek | `https://api.deepseek.com/chat/completions` |

Arbitrary base URLs, custom headers, local gateways, and proxy endpoints cannot be entered through connection settings. OpenAI requests set `store: false`; this disables response storage for that API feature and is not a universal promise of zero retention across providers.

Every external call has a 180-second deadline, a 4,096-token output ceiling, a 120,000-character prompt ceiling including appended schema instructions, a 1 MiB response-body limit, and a 128,000-character extracted-text limit. The test request uses a 64-token output ceiling. A model may have stricter limits or count reasoning against the output allowance. Character limits are not token estimates or guarantees that every model's context window will fit.

Cancellation aborts the local HTTP request; it does not guarantee that the remote provider stops computation immediately or refunds already processed tokens. External replies are buffered rather than streamed token by token. Ordinary conversation calls return assistant text. Reasoning-only or tool-only replies, malformed JSON envelopes, empty replies, and replies explicitly marked incomplete are rejected. These calls supply no tools and execute no model-requested actions. Explicit research requests separately enable OpenAI web search and retain its returned citations and search metadata.

For coordination, external requests receive the JSON schema as an additional prompt instruction. This is portable guidance, not provider-enforced strict structured output. The conversation layer must parse and validate the returned JSON before using its assignments. An incompatible model can fail coordination even when ordinary text generation works.

Codex retains the existing `codex exec` behavior: ephemeral execution, ignored user configuration, read-only sandbox, no repository requirement, and the `.local/conversation` scratch directory. It uses the existing schema file for structured coordination and a 180-second process timeout. Shutdown and cancellation terminate the child process group. This extraction does not turn the chat runner into a coding or browsing workflow.

Returned usage is normalized to `{ inputTokens, outputTokens }` from the provider's response. Local Codex and updated paired workers read valid counts from the CLI's `turn.completed` event. Missing or malformed reports, legacy worker responses, older saved calls, and failed or interrupted executions retain unknown counts (`null`), not zero. Cached-input and reasoning-token breakdowns are not retained. This implementation does not estimate dollar charges, enforce monetary budgets, pool subscriptions, synchronize provider credits, or reconcile invoices. Token fields are provider reports, not audited billing totals.

Each agent also receives bounded [system knowledge and scoped operational facts](SYSTEM_AWARENESS.md) explaining these boundaries. The configured API model is not independent verification of the model actually executed; Codex's effective model remains unknown when the adapter does not report it. A login type does not establish a subscription tier, remaining account quota or monetary cost.

## Server module contract

`createProviderStore({ directory, fetchImpl, storage, codexRunner, codexAuthorization, executionPolicy })` creates a store; `providerStore` is the application's default instance. `fetchImpl` is an optional test injection and is not configurable through HTTP. The production `executionPolicy` delegates to the shared governor before inference dispatch; permissions remain a separate check.

- `getSnapshot()` returns `{ version, connections, assignments, policies }` without credentials.
- `mutate(action, payload)` performs one serialized change and returns the same redacted snapshot.
- `assertAllowed({ agentId, scopeId, connectionId? })` checks a role's assigned connection, or an explicitly supplied connection, against one scope and returns public metadata.
- `execute({ agentId, scopeId, connectionId?, prompt, schema?, signal? })` dispatches exactly one authorized request and returns `{ text, usage, provider: { id, type, model }, durationMs }`.
- `testConnection({ id, signal? })` explicitly runs the small connection probe and returns the same result plus `ok: true` and `testedAt`.

Supported mutations:

```text
saveConnection  { id?, name, type, model, apiKey? }
deleteConnection { id }
assignAgent     { agentId, connectionId }
setScopePolicy  { scopeId, connectionIds }
```

Role IDs are `nova`, `radar`, `forge`, `muse`, and `growth`. Connection IDs are generated by the store. Errors carry a safe message plus `code`, `status`, and `statusCode`. The HTTP layer remains responsible for authenticating or restricting callers, origin checks, request size limits, source-scope validation, configuration changes during active work, and user-visible consent before a billable test.

`lib/codex.mjs` exports `runCodex(prompt, { schema, signal })`, `runCodexResult(prompt, { schema, signal })`, `codexStatus()`, and `shutdownCodex()`. `runCodex` preserves the text-string contract for existing callers; `runCodexResult` returns `{ text, usage: { inputTokens, outputTokens } }` and is used by the provider adapter and updated paired workers. Counts must be nonnegative safe integers; unavailable values remain `null`. The provider store also accepts legacy injected runners that return text, with unknown usage. A truthy Codex schema flag uses the existing coordinator schema file.

## Verification and references

Run `node --test test/providers.test.mjs`. The tests inject mock HTTP responses and use temporary private directories; they do not ask for credentials, contact real providers, or incur API charges. They cover authorization before dispatch, revocation, redaction, persistence, endpoint restrictions, adapter payloads, malformed and oversized responses, cancellation, and timeouts. Passing mock tests does not prove that a particular account or model is currently accessible.

Protocol references checked during implementation:

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode): JSON events include `turn.completed` usage; the adapter retains available input/output counts.
- [OpenAI Responses API migration guide](https://developers.openai.com/api/docs/guides/migrate-to-responses)
- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [OpenRouter Chat Completions API](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion)
- [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)

## Paired execution

In authenticated remote modes, built-in Codex requires a selected paired computer. The worker initiates outbound HTTPS requests and keeps its own Codex login. Both the active scope and each source scope must be in the device grant as well as the provider allowlist. Execution-capable device credentials cannot read owner endpoints or synchronize knowledge without that separate capability.

A queued job has a deadline; an active lease must be renewed. Revocation, cancellation, expiration and server restart reject late results. A lease is never reassigned automatically because inference may already have happened. A failed delivery can still have incurred provider usage. The UI reports device presence separately from identity and provider configuration.


## Explicit web research

`providerStore.research({scopeId,connectionId,query,domains?,signal?})` requires an authorized OpenAI API connection and a model supporting Responses `web_search`. There is no Codex or other-provider fallback. The request uses a maximum of three tool calls, optional allowed-domain filters, no stored response, and explicit source inclusion. A completed search event and usable URL citations are required before saving research; a generated URL alone is insufficient. Search can incur tool charges in addition to model usage, and the studio does not infer a monetary total from call counts.

All actual provider calls, connection tests and repository editing calls pass through the execution governor. Permissions are checked independently. See [governance](GOVERNANCE.md), [repository work](REPOSITORY_WORK.md), and the official [web search API](https://developers.openai.com/api/docs/guides/tools-web-search).
