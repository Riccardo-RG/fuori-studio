# Operational self-awareness

Agents receive a bounded description of Fuori Studio and read-only operational facts so they can explain how the running installation works. This is evidence-based application knowledge, not access to a model's hidden reasoning, weights or provider billing. Remaining account capacity is included only when explicitly reported by the supported provider integration.

The execution preview exposes this material under each agent's collapsed **Operational availability / Disponibilità operativa** section. It answers two practical questions first: what capacity is reported by the service and permitted by the app, and what this agent can do in the proposed execution. Measured account allowances are shown separately from app call budgets; missing provider data stays explicitly unavailable. Opening this section makes no AI inference call and grants no additional permission.

The first view shows available provider-account observations, applicable app call allowances, resets, and capabilities for this execution. **System knowledge and context** expands startup identity, technical facts, source excerpts, provider configuration and selected-context counts. **Technical usage details** separately expands retained call/token reports and available metadata from authorized prior responses. Exact token counts are supplementary evidence, not the primary measure of whether the service has capacity remaining.

This knowledge accompanies chat, text-task and dependency-plan requests, and repository editor/reviewer requests. Ask questions such as “How much can we still do?”, “What can you do in this task?”, “Which service will answer me?”, “How do your memory permissions work?”, or “Which version of Fuori Studio are you using?”. The answer should explain available evidence and identify missing observations, rather than imply unrestricted access to the running process.

## Availability and capabilities

The app's remaining work allowance is the lowest remaining count among the applicable installation, project and assignment limits. Zero means an app limit has been reached. The daily limit is shared across the installation and resets at the reported UTC time; project and assignment budgets are lifetime ceilings. These values do not establish the provider account's remaining allowance, reset schedule, subscription tier or service availability. A positive app allowance does not guarantee a successful provider call.

For local Codex authenticated with ChatGPT, Fuori Studio can read the official app-server account-rate-limit response. Each reported bucket shows its primary/secondary window's remaining percentage, window duration and provider-reported reset, plus the observation time. These limits are shared across the whole account, including use outside Fuori Studio. They are not this app's personal allocation or a prediction of how many requests will succeed. API connections, paired-computer execution and unavailable/error responses currently keep account capacity unknown.

The collector is read-only, has a four-second deadline and caches observations for up to 60 seconds. It performs no inference, purchase or limit reset. Credentials, account identifiers, credits and billing fields are excluded from the resulting knowledge packet. The interface reports ordinary usage as allowed or unavailable only when `ordinaryUsageAllowed` is an explicit boolean; a missing value stays unknown. A displayed percentage or reset time does not independently establish permission, automatic recovery or guaranteed success. See the official [Codex account rate-limit protocol](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt).

**Capabilities authorized for this execution** describes permissions for this specific execution, not everything Fuori Studio supports elsewhere or every physical tool present in a provider runtime. Analysis of supplied materials and consultation of supplied technical excerpts are distinct from direct repository editing, autonomous web research, publishing/pushing changes and autonomous memory writes. For example, a separately authorized repository-editor run can allow editing the managed isolated copy while an ordinary text conversation is not authorized for it. Each supplied capability is marked authorized or not authorized for this execution, with its description. Missing capability metadata is displayed as unavailable information, not an inferred permission. The panel does not change grants or start another workflow.

Agents receive the same bounded availability and capability facts so they can explain what they can do now and distinguish an app limit from unknown account capacity. The absence of provider quota telemetry must remain explicit even when token reports are present.

## Code and documentation evidence

At server startup, Fuori Studio captures a bounded, allowlisted snapshot of its own implementation and documentation. The snapshot records application version, Git commit when available, whether local changes existed at startup, capture time, and source digests. Topic selection chooses relevant facts and bounded excerpts for a question or brief; the complete repository is not copied into every request.

The allowlist is defined in `lib/studio-knowledge.ts`. Capture accepts at most 256 KiB per file and 2 MiB overall. An agent's selected evidence has at most six excerpts, each capped at 24 lines and 1,800 characters, with at most 9,000 characters in total. Missing, oversized or unsafe files are unavailable, not silently substituted with arbitrary files. Source digests identify full captured files, even when an excerpt is partial.

This source access is read-only and restricted to the built-in source selection. It is not a general filesystem browser or a new repository-execution grant. Credentials, environment files, archive contents, arbitrary local paths, and unrelated repositories are not part of this source snapshot. Normal scope, source and provider restrictions continue to apply to the separately selected memories and documents.

Source evidence includes its repository-relative path, line range, content and digest. Agents are instructed to distinguish what is supported by these excerpts from operational observations or unavailable information, and to cite concrete paths and lines for implementation claims. Excerpts are data, not executable instructions. The preview escapes their contents and displays them as text.

If source files change after startup, the preview reports that the agent still receives the startup snapshot. Restart the server to capture the updated version. A commit alone does not prove a clean checkout; startup local changes are shown separately. The snapshot is evidence of the inspected installation, not a guarantee about every external service or future execution.

## Runtime facts and usage

Operational context is prepared for the current agent and active scope. Usage is further limited to the selected project when applicable. These counts describe retained recorded history before the proposed execution; they are not an estimate of the next response's consumption. Metadata about previous responses is included only when those responses belong to the authorized selected history.

The distinction between these quantities is intentional; token details remain a secondary disclosure in the interface:

- **Studio calls:** application dispatches recorded by Fuori Studio. Daily, project and assignment budgets constrain these calls; they do not count all internal model or tool operations in a provider.
- **Reported tokens:** input and output values actually returned by the provider integration. Missing counts remain unknown. Known partial totals are accompanied by the number of calls with missing counts; they must not be described as complete usage.
- **Account limits:** provider-reported windows are available for supported local ChatGPT-authenticated Codex execution. Missing or unsupported telemetry remains unknown. Account-wide allowances are not inferred from app calls or token totals.
- **Billing:** monetary costs, credits and invoices are not supplied by this feature or inferred from app usage.

For Codex, a local default is a configuration choice, not the identity of a verified model. When the adapter does not report the actual model, the preview says so. Agents must also distinguish configured API models from capabilities or behavior not established by the recorded data.

Local Codex and updated paired workers capture input/output counts from valid CLI `turn.completed` reports. Older records, legacy workers, absent or malformed reports, and failed/interrupted calls can remain unmeasured. Cached-input and reasoning-token breakdowns are not retained. The observation of a login type does not reveal an account's tier, quota or billing details.

The knowledge packet explains that input consumption may include instructions, conversation history, selected memories, documents and other supplied context, while output consumption depends on generated content and what the service reports. In a group chat, the coordinator may involve up to three authorized specialists, each making a separate studio call. Extra code/documentation evidence itself adds context; the bounded selection keeps it relevant but cannot promise a fixed token cost.

## Read-only HTTP inspection

Owner-authorized clients can inspect built-in technical knowledge through `GET /api/system/knowledge?q=...` and an allowlisted startup source excerpt through `GET /api/system/source?path=...&start=...&end=...`. They use the existing authentication and origin protections, make no AI call, and do not expose arbitrary filesystem access. Source reads are capped at 60 lines and 6,000 characters. These endpoints expose application source evidence, not a cross-scope runtime ledger or credentials; per-agent operational facts are prepared through the normal execution preview.

Chat, task, dependency-plan and repository execution retain technical identity, source references and operational provenance with their results. The runtime snapshot records the facts prepared before dispatch, while reported usage for the newly completed response is separate. Manual starts expose these facts in the execution preview; an explicitly authorized autonomous routine need not have an interactive review for each run. Account-limit observations retain their timestamp; saved snapshots and response token counts are not continuously refreshed account telemetry.

## Boundaries

Knowledge of the implementation does not grant the ability to change it, execute arbitrary tools, access another agent's restricted context, inspect credentials, or publish code. Repository editing retains its separate permissions and review flow. The preview offers no switch that expands those permissions.

An agent can explain recorded actions and supplied context, but cannot recover private model reasoning or reconstruct unrecorded events. Prompt grounding improves the evidence available to a model; it does not guarantee that every generated statement will be correct. Check the cited excerpts and the recorded runtime facts when an answer matters.

See [execution preview](EXECUTION_PREVIEW.md), [provider adapters](PROVIDERS.md), [call budgets](BUDGETS.md), and [security boundaries](SECURITY.md) for the surrounding controls.
