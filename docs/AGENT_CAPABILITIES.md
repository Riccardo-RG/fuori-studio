# Agent specialties and verifiable handoffs

Fuori Studio keeps five stable agent identities and lets the owner assign one of eleven instruction profiles to each. This expands the team's useful roles without expanding its permissions, provider calls, or default headcount. Open a colleague's card, choose **Specialty**, review the expected deliverable and save. **Restore original role** selects the default; save to apply it.

Profiles are studio-wide preferences. They guide conversations, drafted plans and textual task steps. Nova remains the coordinator even when given another specialty. Existing queued work uses the current profile at its next reviewed start; previous outputs retain their recorded profile. Repository implementation remains a separate authorized workflow and its execution role is unchanged.

| Profile | Intended contribution |
| --- | --- |
| Coordination | A reasoned decision, owner and next step |
| Research and evidence | Synthesis of supplied sources, limitations and open questions |
| Product and engineering | A technical proposal with acceptance criteria and risks |
| Content and communication | A draft for a stated audience and purpose |
| Business and revenue | A bounded commercial experiment and decision criterion |
| Code review | Evidence-backed findings ordered by impact |
| Quality and testing | Test scenarios with preconditions, steps and expected results |
| User experience | A proposed flow with rationale and validation questions |
| Product strategy | A product brief with priorities, trade-offs and success criteria |
| Technical writing | A guide or specification with prerequisites, examples and limits |
| Data analysis | A traceable method, explicit assumptions and proportionate conclusions |

The default assignments are coordination for `nova`, research for `radar`, engineering for `forge`, communication for `muse`, and business for `growth`. Any existing member can take any profile. Neither selecting “Research” nor “Code review” adds browsing or repository access to chat. Chat and ordinary tasks analyse the supplied material and produce text. Use Sources to collect web material and Repository for authorized code changes and configured checks.

## What changed in execution

The coordinator sees the actual configured specialties and their output contracts. It chooses only authorized contributors, with a maximum of three specialists as before. Each assignment should specify a result, constraints and success criterion. Tasks that depend on an unwritten result belong in a sequential plan rather than parallel chat delegation. A plan's final review should depend on the result it evaluates; assigning another identity alone is not evidence of an independent or correct review.

Specialists receive their own role, skills and expected deliverable. Their shared quality contract asks them to distinguish evidence, inference and assumptions; cite only available sources and locations; state unperformed checks; and hand off results, limitations and the next necessary action. Previous model outputs remain proposals to evaluate, not established facts or instructions. The contract does not impose long sections on brief answers. Only the coordinator receives the full routing roster, avoiding redundant instructions in specialist calls.

These are instruction and execution-control improvements, not a claim of measured model-quality gains. Models can still omit criteria or make mistakes. Human artifact approval, source provenance, scoped memory and provider restrictions remain the enforcement mechanisms. No automatic evaluator loop, new provider, paid call or tool installation was added.

## Storage, preview and access guarantees

- `GET /api/team/capabilities` returns `{version, profiles}`. `POST` accepts only `{id, profileId, expectedVersion}` with a known agent and curated profile.
- The endpoint uses the same owner authentication, CSRF protections and idle requirement as team renaming. Worker device tokens cannot change profiles. Changing a profile never changes names, provider assignments, budgets or memory access.
- The separate encrypted archive record `agent-capabilities` has schema version 1. It is written atomically through the archive, with serialized optimistic updates. Concurrent saves from the same version produce one winner and a conflict. A failed write preserves the last saved state. Corrupt records fail closed. The existing `team-profiles` names record and its API remain unchanged.
- Every prepared chat/task step carries profile ID, preferences version and catalog version. Execution receipts fingerprint that data alongside context, provider and budget. Changing any specialty invalidates pending receipts before a provider call. Uncommitted plan proposals also require an unchanged roster; regenerate a plan after changing specialties.
- A run records its profile metadata in chat message execution metadata and completed task-step execution metadata. Resumed work retains completed results and applies newly reviewed profiles only to remaining calls. Existing source-scope and inherited-output checks still apply.
- Pending editor choices and their original expected version survive language changes and cross-tab refresh. A stale save reports a conflict; close and reopen the colleague to reload before saving. Merely choosing a profile or resetting the selection does not persist it.
- Browser tabs receive a refresh signal after saving. Full archive backups include the encrypted preference record; workspace memory export and device memory synchronization do not grant or distribute team configuration authority.

The catalog is application code (`dist/agent-profiles.js`), with an explicit catalog version. It accepts no custom prompt text, arbitrary identities or capability grants. Increment the catalog version whenever its instruction meaning changes so reviewed executions cannot silently change contracts after a deployment.

## Research and implementation decisions

Research checked against official documentation on 30 September 2026:

| Reference | Relevant pattern | Fuori Studio decision |
| --- | --- | --- |
| [Anthropic: Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Composable workflows; routing and orchestrator/worker patterns; evaluator loops benefit from clear criteria | Improve routing, deliverables and review criteria within existing calls. Avoid adding an automatic evaluation loop without measured benefit. |
| [LangGraph: Workflows and agents](https://docs.langchain.com/oss/javascript/langgraph/workflows-agents) | Explicit sequential/parallel paths, structured routing, persistence and observable steps | Preserve the existing task graph and reviewed execution boundary. Reject changed configuration rather than silently rerouting approved work. |
| [CrewAI: Agents](https://docs.crewai.com/en/concepts/agents) and [Tasks](https://docs.crewai.com/en/concepts/tasks) | Explicit roles, goals, tools, task context and expected outputs | Make specialties and expected deliverables visible and include them in task-specific instructions. Keep tool access distinct from role descriptions. |
| [Paperclip: Agents](https://docs.paperclip.ing/guides/org/agents/) and [Agents API](https://docs.paperclip.ing/reference/api/agents/) | Agent identity/configuration, adapters, delegation and scoped permission controls | Keep familiar colleagues and their stable IDs; add independently versioned specialty preferences without changing authorization. |

This comparison supports the design choices; it is not a benchmark proving Fuori Studio is better than those products. Framework migration, extra permanent identities, automatic multi-agent deliberation and autonomous web or repository tools were not needed for this increment. Future expansion should follow observed task failures and a representative evaluation set: accepted deliverables, source accuracy, actionable review findings, latency and calls per completed task. Test quality gains before increasing default inference.

## Validation

The focused offline suite covers durable specialty assignment, strict input and corrupt-state rejection, optimistic conflicts and failed writes; owner/CSRF/device isolation; stale chat/task receipts before inference; stale plan commit rejection; saved execution metadata; existing source and memory boundaries; task interruption; names compatibility; English catalog contracts; and mocked chat/task execution. Tests use fixture providers or stub executables and no live AI service.
