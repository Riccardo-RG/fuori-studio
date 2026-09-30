# Daily action queue and interrupted work

**Today / Oggi** turns stored work into a read-only list of decisions and next steps. It opens from the quick-action bar, the work tabs, or Command/Control K. It uses no model inference and never starts, approves or schedules work just because the panel is opened.

## Scope and project boundaries

The default is the active conversation scope. **All scopes** is an explicit choice; an optional project filter further narrows the list. Tasks and repository runs are joined to their actual project/scope before rendering. Dependency links expose titles only for predecessors in the same project and scope. A missing or foreign reference is shown as unavailable, not followed into another project.

## Reading the queue

- **Needs decision:** current text deliveries and repository attempts requiring review. Text deliveries whose approval would satisfy another queued assignment's final dependency appear first. The remaining order is oldest update first; no AI priority score is invented.
- **Needs recovery:** paused or failed work. Text assignments show completed and remaining steps. Resuming preserves completed outputs and rechecks evidence and limits. Starting over clears intermediate outputs and prepares a new explicit start, while delivery versions remain recorded. Repository attempts instead retain their existing patch/check evidence and use a new revision in a clean checkout.
- **In progress:** work already running. Opening details does not start another execution.
- **Next starts:** queued work with no outstanding task dependencies. The execution preview must still validate context, services and budgets before dispatch.
- **Waiting for other deliveries:** blocked tasks, with direct links to eligible predecessor details.

Superseded repository attempts stay in history but are excluded from the current action list. Each group shows its total and at most 12 entries, with a link to the full work panel. The panel does not assign due dates to undated work.

The routine preview includes enabled schedules due within the next 24 hours, including overdue entries, and displays at most eight. Existing scheduling/autonomy settings remain authoritative. Source review counts refer to the displayed scopes (or the selected project's scope), not inferred source-to-project associations. Memory review always names the active scope explicitly and links to [the existing editor flow](MEMORY_REVIEW.md).

## Refresh and recovery

Opening the panel or using **Refresh** reads current saved state. Existing task/repository polling refreshes the panel when record versions change. Requests are cancelled on scope changes; stale responses cannot overwrite a newer scope. Server-side evidence, version and budget checks remain authoritative when a linked action is opened.

Budget recovery now distinguishes daily limits (configured under Routines) from project/assignment lifetime ceilings (Budget). Daily reset timestamps come from the server and are labeled UTC. Visiting those settings retains one matching preview draft in memory; it is cleared on an ordinary cancel, successful confirmation or session expiry. No automatic retry or budget increase occurs.

## Implementation and verification

`lib/today.ts` is a deterministic typed projection over workspace, operations, repository and source stores. `GET /api/today` is owner-protected and read-only. Unit cases cover dependency ordering, progress preservation, superseded revisions, scope/project isolation, routine windows and bounded previews. Tests use stored fixtures rather than live AI services. Browser checks and HTTP evidence are recorded in [validation](VALIDATION.md).
