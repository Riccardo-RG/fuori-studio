# Operating the studio

The interface is Italian. This guide names its visible controls so they are easy to find.

## Projects and scopes

Open **Progetti** and create your product. `Owned` is the default classification; use a client project only for actual consulting. A dedicated project scope separates its chat and memory. To reuse a company-wide decision, explicitly share that one note with the project.

A project is currently a work container, not a connected repository. Do not enter an API key into a project brief, memory, task, or chat. Use the password field in **Servizi AI**.

## Assignments and review

Create an assignment with a concrete brief: intended audience, available facts, constraints, and acceptance criteria. Choose one responsible agent, or a ready procedure whose steps assign the relevant roles. A procedure must be available in the project's scope.

Starting sends authorized context to the configured services. Work continues if you reload or close the browser, provided the server stays running. Inspect step status and returned usage in the task detail. **Pause** cancels the unfinished call; **Resume** keeps completed steps. If source context changed, restart from the beginning. When a procedure itself changed, create a new task from its current version.

In **Da decidere**, read the entire delivery and check claims that require outside evidence. Approve acceptable output or request changes with specific feedback. Previous versions remain visible. Markdown export produces a local download; it does not publish or send the document.

## Reusable knowledge

Use **Memoria** for stable information, preferences, decisions and patterns. Proposed notes are excluded from AI context. Review the wording, source, scope and allowed agents before confirming.

After accepting a delivery, prepare a memory proposal from the task. Prefer a reusable lesson rather than copying the entire delivery. The proposal is scoped, attributed to the task version and remains unconfirmed. Explicitly generalize sensitive details before sharing a method elsewhere.

## Services and permissions

Configure an API service using its exact model ID and your API key, then assign it to an agent. Enable that connection for the scopes whose data it may receive. A shared note's source scope must also allow the connection. There is no implicit fallback to another provider.

A connection is configured when credentials and model are present, not necessarily reachable or funded. **Test connection** makes a tiny request that can be billed. Model catalog access, quotas and features depend on the account. The default Codex connection uses the existing machine login.

## Routines

Create a routine, choose an interval and next due time, and explicitly enable it. The running server checks for due work every 30 seconds. Each occurrence becomes a queued task to review and start. This deliberately separates scheduling from paid execution.

The server must be running; your laptop being asleep or offline can delay queue creation. When it resumes, missed occurrences coalesce into one. Disabling a routine leaves already-created tasks intact.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Service not allowed | Add the connection to the current scope and all source scopes used by the task |
| Codex unavailable | Verify `codex login status` and `FUORI_STUDIO_CODEX_BIN` |
| Context changed on resume | Restart the task; create a new task if the procedure changed |
| Task paused after restart | Inspect completed steps, then resume explicitly |
| Model request rejected | Check exact model ID, API compatibility, balance and key permissions |
| Archive cannot be read | Stop the server, keep the original file, restore a verified backup |
| Another server owns the archive | Stop the other instance or use a separate data directory |
| Provider connection changed but chat badge is old | Reload the page |

See [security and recovery](SECURITY.md) before deleting or replacing a local data file.
