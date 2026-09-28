# Agent systems: product context for Fuori Studio

Research date: **27 September 2026**. This is a documentary review of official documentation and repositories, not a market ranking or a hands-on benchmark. Competitor products were not installed or connected, and their output quality was not compared experimentally. Documentation can describe a different release from the one available for a particular deployment. Pin the version, hosting mode, and adapter contract before integrating a system.

The current implementation described below was inspected locally. Mock tests establish application behavior; they do not establish provider availability or intelligence, real-world output quality, or performance against competitors.

## 1. What Fuori Studio should own

Fuori Studio is primarily a working environment for its owner's **proprietary products**, supporting growth as an entrepreneur and software developer. Consulting is a secondary use case. Its useful distinction is the continuity between a product brief, scoped context, assigned work, a reviewable delivery, and an explicit decision. Integrating more model brands does not by itself create that value.

Roles, models, runtimes, and orchestration are separate concepts:

- A **role** has responsibilities, context access, and instructions. Several roles can use the same model or service.
- A **model/provider** generates outputs under its own API and account terms.
- A **runtime** gives a model tools, execution state, and an environment. Calling a text API does not automatically supply the capabilities of a coding agent.
- An **orchestration application** owns work records, routing, permissions, review, and recovery across executions.

Anthill, forest, beach, and mountain are graphic themes. Animals are decorative. Worker activity can reflect real task state, but the scenery is not the orchestration architecture and does not demonstrate autonomous work.

### Implemented in this repository

| Capability | Current behavior | Boundary |
| --- | --- | --- |
| Scoped context and hybrid memory | Separate conversations, confirmed notes, assisted capture, provenance, version history and bounded retrieval | No semantic/vector search or automatic promotion of generated statements into facts |
| Owned and client projects | Projects group work within an explicit scope; owned products are the default priority | Parent scopes do not implicitly grant access to their contents |
| Durable assignments | Tasks preserve a brief, responsible role, ordered steps, status, outputs and execution metadata; reviewed plans add dependencies | Task steps produce text; code editing and live research have separate explicit workflows |
| Reviewable deliveries | Versioned text artifacts can be approved or returned for changes | A model cannot approve its own delivery |
| Recovery | Interrupted work is recoverable; completed steps can be preserved while incomplete work is retried, subject to current context permissions | This is not a guarantee of exactly-once effects in arbitrary external systems |
| AI connections | Local Codex plus OpenAI, Anthropic, DeepSeek, and OpenRouter API connections, assigned per role | External services need the user's valid API credentials and explicit scope policies; no silent fallback |
| Routines and limits | Enabled routines queue tasks; explicit autonomy can start new eligible occurrences within durable daily call/run limits | No automatic retries, monetary billing guarantee or wake of a stopped server |
| Repository work | Isolated committed baseline, configured checks, optional AI review and a captured patch for human approval | Requires compatible local Codex sandbox; no merge or publication, and the inspected macOS host fails preflight |
| Sources and research | Scoped document/PDF text, public URLs/GitHub snapshots and allowed folders; explicit OpenAI web search with citations | Read-only snapshots; no private document accounts, browser automation or OCR |
| Identity and storage | Exact-owner OIDC, encrypted SQLite records, scoped paired devices and selective knowledge sync | One owner and one server process; external deployment setup remains necessary |
| Outcomes | Human review decisions, execution cycles, reported usage and separately labeled user feedback | No invented costs or estimated savings |
| Reusable learning | An approved artifact can inform a proposed note for user review | Proposed notes remain excluded from confirmed context until explicitly accepted |

See [Product direction](../PRODUCT.md), [Provider connections](PROVIDERS.md), and [Architecture](ARCHITECTURE.md) for the implementation and deployment boundaries. Neither this feature set nor the competitor review demonstrates that a mixed-provider team reasons better than one well-configured agent.

## 2. The categories behind “multi-agent”

The term can mean several named participants in a chat, subprocesses with separate context, a workflow of agents, or an organization retaining responsibility for weeks. Those are different levels.

| System | Central objects | Main layer | Relevance to Fuori Studio |
| --- | --- | --- | --- |
| **Paperclip** | Company, agent, issue, goal, heartbeat | Persistent work management and control plane | Responsibilities, task lifecycle, review, budgets, and operational visibility |
| **Codex CLI/app** | Chat/thread, turns, workspace, subagents | Work execution environment with parallel delegation | Existing local engine; already has multi-agent capabilities |
| **CrewAI** | Agent, Task, Crew, Flow | Python framework; AMP adds an operating platform | Specialized roles and mixed deterministic/agent-driven processes |
| **LangGraph / LangSmith** | Graph, state, thread, checkpoint, run | Orchestration runtime; observability and deployment platform | Explicit transitions, pauses, recovery, and evaluation |
| **Microsoft Agent Framework** | Agent, session, workflow, executor | Framework with hosting integrations | Typed orchestration and durable hosted workflows |
| **OpenHands** | Agent, conversation, workspace, tools | Software-agent runtime/SDK, with separate applications and automation | An execution engine that could sit behind a product-specific interface |
| **OpenClaw** | Gateway, agents, sessions, channels, automation | Operational assistant/gateway | Channels, events, continuity, and action controls |

This classification is our architectural reading, not a taxonomy shared verbatim by the vendors. Sources: [Paperclip](https://github.com/paperclipai/paperclip/blob/master/docs/start/what-is-paperclip.md), [Codex subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents), [CrewAI](https://docs.crewai.com/core-concepts/Agents), [LangGraph](https://docs.langchain.com/oss/python/langgraph/overview), [Microsoft Agent Framework](https://learn.microsoft.com/en-us/agent-framework/overview/), [OpenHands SDK](https://docs.openhands.dev/sdk/arch/overview), and [OpenClaw](https://docs.openclaw.ai/concepts/multi-agent).

## 3. Paperclip: what it coordinates

The project reviewed is [paperclipai/paperclip](https://github.com/paperclipai/paperclip). Paperclip organizes agents executed by different runtimes. It defines goals and reporting relationships, assigns issues, records activity, and applies policies. It is not a new language model. Codex, Claude Code, a local process, or an HTTP service can perform the actual work. [Two-layer architecture](https://github.com/paperclipai/paperclip/blob/master/docs/start/what-is-paperclip.md).

The documented work cycle is:

1. An organization defines a goal and agents' responsibilities.
2. An issue retains identity, state, assignee, and relationships to other work.
3. An assignment, mention, schedule, or human action wakes an agent.
4. Its runtime receives context, examines its assignments, and claims work.
5. The agent delivers a result or records a blocker and progress.
6. Work passes to another agent or waits for a person.

Atomic issue checkout prevents two agents from claiming ownership simultaneously. It does not, by itself, isolate all shared files or external services; that is an inference about the scope of the mechanism. [Key concepts](https://docs.paperclip.ing/guides/welcome/key-concepts/), [heartbeat protocol](https://github.com/paperclipai/paperclip/blob/master/docs/guides/agent-developer/heartbeat-protocol.md).

### Budgets, approvals, and evidence are different controls

- **Budgets:** the documentation describes monthly company/agent limits and lifetime project limits, warnings, and pausing subsequent heartbeats at the threshold. Accounting depends on adapter reports. An application threshold is not proof that an already running request can never exceed it; subscription quotas are not interchangeable with API charges. [Costs](https://docs.paperclip.ing/guides/day-to-day/costs/).
- **Governance:** hiring, strategy, and budget exceptions can produce approve/reject/revision requests. Some guides describe hiring approval as mandatory while API references make it policy-dependent. Check the configuration rather than assuming every consequential action always has a gate. [Approvals](https://docs.paperclip.ing/guides/day-to-day/approvals/), [API reference](https://github.com/paperclipai/paperclip/blob/master/skills-releases/paperclip/v0/references/api-reference.md).
- **Delivery review:** an execution policy can intercept issue completion and route it to a reviewer and approver. These configurable stages govern completion; they are different from technical permission to run a command or publish content. [Execution policy](https://docs.paperclip.ing/guides/power/execution-policy/).
- **Audit and inspection:** the activity log records mutations, actors, and timestamps; execution transcripts provide additional detail. Seeing a final answer is different from reconstructing who authorized a change. A normal event log is not necessarily tamper-proof. [Activity log](https://docs.paperclip.ing/guides/day-to-day/activity-log/).

Routines define repeatable work launched through schedules, webhooks, or manual/API invocation. They retain run history linked to resulting issues. Heartbeats are execution windows, while routines define the work to launch. The documentation recommends waking agents for actual events instead of frequent idle polling. [Heartbeats and routines](https://docs.paperclip.ing/guides/projects-workflow/routines/).

### Paperclip can use Codex

The `codex_local` adapter runs local Codex with session continuity, managed homes, and injected Paperclip instructions/skills. The comparison therefore includes **Paperclip operating above Codex**, rather than an exclusive choice between them. Runtime permissions, directory access, authentication, and provider availability remain integration concerns. An adapter does not imply access to every desktop-app feature. [Codex adapter](https://docs.paperclip.ing/reference/adapters/codex/).

Current adapter documentation also distinguishes selectable local adapters from HTTP/process runtimes configured through APIs or imports. “Supports a runtime” does not always mean “ready in a dropdown with no configuration.” [Adapters overview](https://docs.paperclip.ing/reference/adapters/overview/).

For Fuori Studio, the useful lesson is explicit responsibility and enforced review. It is not a claim that Paperclip makes the underlying model more capable.

## 4. Codex: compare against its actual capabilities

Codex documents subagents with separate contexts, parallel delegation, result collection, and controls to steer or stop agents. CLI/app inspection surfaces depend on the release. Calling Codex a single-agent chat would misrepresent the baseline. [Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents).

Worktrees isolate checkouts for parallel work. Scheduled tasks can continue existing context or create independent executions and use skills/plugins. Local project tasks still depend on the machine, app, and directories being available; scheduling alone does not imply always-on cloud execution. [Worktrees](https://learn.chatgpt.com/docs/environments/git-worktrees), [scheduled tasks](https://learn.chatgpt.com/docs/automations?surface=app).

The app-server exposes threads, authentication, approvals, and events for custom clients. That is a different integration boundary from reading a command's final text. Transport support and experimental limitations need verification for the chosen version. [App-server](https://learn.chatgpt.com/docs/app-server).

Also distinguish the Codex product from OpenAI APIs. The reviewed API documentation describes a managed Codex harness, durable sessions, tools, and subagents; the surrounding application still needs to be built. Do not transfer authentication, availability, or billing assumptions from the desktop app to an API. [Agents API](https://developers.openai.com/api/docs/guides/agents-api/overview), [runtime selection](https://developers.openai.com/api/docs/guides/agents).

The pages reviewed did not establish a persistent company reporting chart or monthly per-employee budget as native Codex objects. This is a limitation of the reviewed evidence, not proof that external applications cannot add them. For focused work on one repository, Codex alone can be sufficient; an additional management layer should justify its complexity with better coordination and outcomes.

## 5. Frameworks and application responsibilities

### CrewAI

Crews combine roles, tools, and tasks. Flows organize state, events, conditions, and branches. Flow persistence is an application mechanism with a default SQLite backend and replaceable implementations. [Agents and crews](https://docs.crewai.com/core-concepts/Agents), [Flow persistence](https://docs.crewai.com/en/concepts/flows).

The documentation covers model/provider choice, tool/MCP integration, human input, and feedback pauses. AMP adds deployment, APIs, and tracing and should be distinguished from the Python package. A crew manager coordinating a run is not automatically equivalent to Paperclip's persistent company registry. [LLMs](https://docs.crewai.com/en/concepts/llms), [human-in-the-loop](https://docs.crewai.com/en/learn/human-in-the-loop), [AMP](https://docs.crewai.com/enterprise/introduction).

### LangGraph and LangSmith

LangGraph combines code nodes and model decisions with state and interruptions. Checkpoints can support continuation and failure recovery, but an in-memory backend does not survive process restart. `interrupt()` can pause a flow until external input arrives. These execution checkpoints should be distinguished from long-term stored facts or preferences. [Overview](https://docs.langchain.com/oss/python/langgraph/overview), [persistence](https://docs.langchain.com/oss/python/langgraph/persistence), [interrupts](https://docs.langchain.com/oss/python/langgraph/interrupts).

LangSmith adds observability, evaluation, and deployment. Its Agent Server manages threads/runs and supports scheduled work on existing or new threads. These platform functions should not be attributed indiscriminately to the standalone LangGraph library. The scheduling guide reviewed uses UTC. [Deployment cron](https://docs.langchain.com/langsmith/cron-jobs), [data plane](https://docs.langchain.com/langsmith/data-plane).

### Microsoft Agent Framework and AutoGen

Microsoft presents Agent Framework as the successor to AutoGen and Semantic Kernel. AutoGen is in maintenance mode; comparisons based only on older group-chat examples omit the current offering. [Framework overview](https://learn.microsoft.com/en-us/agent-framework/overview/), [AutoGen repository](https://github.com/microsoft/autogen).

Agent Framework combines providers, tools/MCP, sessions, middleware, and workflows. Human interactions use explicit requests/responses, including pending requests preserved by checkpoints. The Durable Task extension adds distributed continuation, timers, and events, separately from local workflow checkpoints. Evaluate scheduling, infrastructure, and user controls together with the hosting component. [Human-in-the-loop](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop), [Durable Extension](https://learn.microsoft.com/en-us/agent-framework/hosting/azure-functions).

## 6. Execution runtimes and gateways

### OpenHands

The Software Agent SDK separates agent behavior, conversations, tools, and workspaces. Agent Server exposes execution to remote clients, with local or isolated workspace options and model/tool/skill/MCP integration. [Architecture](https://docs.openhands.dev/sdk/arch/overview).

Persistence retains conversation state and events. `TaskToolSet` delegates to resumable subagents identified by ID; the specific documented pattern is synchronous and blocking, so it does not establish that every delegation runs in parallel. Action confirmation policies and risk analysis are distinct controls. [Conversation persistence](https://docs.openhands.dev/sdk/guides/convo-persistence), [TaskToolSet](https://docs.openhands.dev/sdk/guides/task-tool-set), [security](https://docs.openhands.dev/sdk/guides/security).

The repositories separate automation services for cron, webhooks, history, and dispatch from the SDK executing conversations. The library alone should not be described as the entire platform. [SDK boundaries](https://github.com/OpenHands/software-agent-sdk), [Automation](https://github.com/OpenHands/automation).

### OpenClaw

The gateway routes messages to agents with separate workspaces, identities, configurations, and sessions. Bindings connect channels/accounts to agents; routing is not itself a reporting hierarchy. Documentation also covers subagents, background work, and automation. [Multi-agent routing](https://docs.openclaw.ai/concepts/multi-agent), [automation](https://docs.openclaw.ai/automation).

Providers, plugins, channels, and tools can be integrated. Execution approvals can be directed to the operator and retain bounded authorizations. Command permission remains different from approving a business deliverable. Scheduling and background behavior must be checked against the installed version. [Features](https://docs.openclaw.ai/concepts/features), [automation release documentation](https://docs.openclaw.ai/releases/2026.8.1/automations-and-scheduling), [execution approvals](https://docs.openclaw.ai/tools/exec-approvals).

## 7. Additional product references

These systems were reviewed for specific patterns, not ranked against the frameworks above:

| Reference | Documented pattern | Potential application to Fuori Studio |
| --- | --- | --- |
| [Relevance AI Workforces](https://relevanceai.com/docs/get-started/core-concepts/workforces) | Specialized agents, mandatory or agent-chosen handoffs, conditional paths, and inspection of inputs/outputs | Make reusable product processes explicit and inspectable; add conditions only when a real brief needs them |
| [Conductor](https://www.conductor.build/docs/concepts/parallel-agents) | Separate workspaces for independently deliverable changes; shared workspaces for agents collaborating on one branch | Repository isolation with clear review paths and deliberate sharing boundaries |
| [Superset](https://docs.superset.sh/) | Parallel coding work, isolated Git worktrees, multiple agent runtimes, and integrated diff/review actions | Evaluate how execution and review can fit into one daily workspace |
| [Gas Town](https://github.com/gastownhall/gastown) | Persistent work identities and records, coordination, handoffs, and recovery around coding agents | Learn from work surviving session replacement; avoid adopting organizational complexity without need |
| [Dify](https://www.dify.ai/workflows) | Visual workflows combining model calls, retrieval, tools, branches, triggers, and human review | Future integrations and repeatable processes, with visible execution and human checkpoints |

Conductor here means the product at `conductor.build`; Superset means the coding application, not Apache Superset. These references do not establish that Fuori Studio must adopt their runtime, copy their interface, or install every listed framework.

## 8. Capability comparison and interpretation

“Native” means documented for the component named, not automatically enabled. “Build/verify” means the reviewed sources do not establish an equivalent ready-made capability with the same semantics; it does not mean impossible.

| System | Persistent work | Organization | Budget control | Human intervention |
| --- | --- | --- | --- | --- |
| Paperclip | Issues, assignments, runs, runner context | Native company hierarchy | Company, agent, and project policies | Governance, review gates, comments, reassignment, pause |
| Codex | Threads, sessions, artifacts, workspaces | Roles/subagents; company hierarchy not established by this review | Equivalent employee budget not established | Execution approvals and steering of chats/agents |
| CrewAI | Persisted Flow state; configure backend and lifecycle | Workflow roles and managers | Build/verify at platform level | Input/feedback; distinguish AMP features |
| LangGraph / LangSmith | Checkpoints, threads, stores with explicit backend | Application-defined graph/supervisor | Build/verify | Interrupt, input/state changes, continuation |
| Microsoft Agent Framework | Sessions/checkpoints; Durable Extension for durable hosting | Code-defined patterns | Build/verify | Requests/responses, tool approval, continuation |
| OpenHands | Conversations, events, resumable subtasks | Parent/subagent relation; company registry not established | Metrics are not proof of monthly company enforcement | Confirmation policies and conversation lifecycle |
| OpenClaw | Agent sessions and automation state | Routing/identity; company hierarchy not established | Company budget equivalence not verified | Operational approvals and task/automation controls |

Model and tool flexibility also has different boundaries. Paperclip delegates to adapters; Codex provides runtime tools and integrations according to its interface; CrewAI and Microsoft Agent Framework expose framework extension points; LangGraph leaves node/tool choices to the developer; OpenHands supplies a software-agent runtime; OpenClaw adds channels and gateway routing. The linked sections above identify those boundaries.

Do not equate token accounting with a monetary hard stop, a debug trace with an immutable audit trail, chat persistence with exactly-once external execution, or an MCP interface with already configured credentials and permissions. A provider connection is not a tool integration, and a model disagreement is not evidence that the second answer is correct.

## 9. Next decisions for Fuori Studio

These are product judgments drawn from the review, not measured competitor advantages:

1. **Validate the owned-product loop first.** Run real briefs through scoped context, tasks, steps, artifacts, revision, and approval. Measure useful deliveries, correction effort, and coordination time before increasing agent count.
2. **Extend execution with explicit capabilities.** Read-only research, document ingestion, and isolated repository work now have explicit bounded workflows; authenticated write connectors remain a further gate. Each needs data boundaries, provenance, and tested action permissions. Approving a text artifact must not silently authorize publication or a repository write.
3. **Separate role identity from model choice.** Keep project records and permissions stable while changing a role's connection. Compare actual briefs before claiming a cheaper, faster, or more capable model assignment.
4. **Bound unattended work.** Routines queue by default; optional autonomy uses durable occurrence claims and daily call/run limits. Evaluate real outcomes before broadening it to external event triggers, retries or notifications.
5. **Keep deployment boundaries explicit.** Encrypted SQLite, exact-owner OIDC and scoped paired execution are implemented. They do not supply multi-tenant isolation or an already configured online service; deployment, account access and live runtime compatibility still require verification.
6. **Evaluate composition only against a concrete need.** Fuori Studio can continue using direct adapters or later integrate an orchestration platform such as Paperclip. A full task with failure, retry, review, and delivery is a better evaluation than a feature-list comparison.

The proposed advantage is less manual coordination around useful product work. It must be demonstrated through completed, reviewable outcomes; neither a 3D office nor a list of connected model providers establishes it on its own.

For the subsequent review of platform authentication, local/online access and automatic memory, see [Hybrid access and assisted memory](HYBRID_IDENTITY_AND_MEMORY.md). That document separates the delivered core from broader design recommendations and unverified real-world outcomes.
