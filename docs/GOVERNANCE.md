# Execution limits and measured outcomes

Fuori Studio applies application-level limits before an AI call starts. These limits are independent of the account's provider quota, subscription, API billing or Codex usage window. They do not purchase credits, reset a provider limit or guarantee a monetary spending ceiling.

## Durable call reservations

`createGovernance()` stores settings, call reservations, autonomous-routine claims and user feedback in the encrypted archive under `governance`. The service uses the archive's transactional `update` operation: checking the daily allowance and reserving an attempt are one atomic write. Concurrent requests cannot all consume the same remaining allowance.

Defaults are fifty AI call attempts per UTC day, a 180-second call deadline, at most three simultaneous inference calls, and autonomous routines disabled. Configurable bounds are:

| Setting | Range | Meaning |
| --- | --- | --- |
| `dailyCallLimit` | 0–1,000 | Reserved AI attempts per UTC day; zero prevents new calls. |
| `maxCallSeconds` | 1–1,800 | Deadline supplied through an abort signal to the executing adapter. |
| `autonomousRoutines` | Boolean, off by default | Explicit owner permission for eligible scheduled work to start. |
| `maxAutonomousRunsPerDay` | 0–100 | Distinct automatically claimed routine occurrences per UTC day. |

Settings use optimistic versions. A stale browser cannot overwrite a newer policy. Changing limits applies to subsequent reservations; it does not reset counters or retroactively change an already reserved call's deadline. An adapter can impose a shorter limit: ordinary HTTP and chat Codex requests retain their 180-second ceiling, while repository editing has a separate ten-minute runtime ceiling. Increasing the governor deadline does not extend those adapter limits.

An attempt remains counted if it fails, is cancelled, times out or is interrupted by a restart. There are no automatic retries or refunds. A request rejected before reservation, such as a blocked provider, an exhausted budget or an already-aborted signal, does not consume a call. UTC day boundaries and the next reset timestamp are returned explicitly rather than inferred from the browser's timezone.

Deadlines propagate cancellation to the underlying adapter. A non-cooperating adapter cannot be forcibly stopped by a JavaScript promise; its in-process concurrency slot remains occupied until it actually settles. Supported adapters must honor the abort signal. Restart recovery marks unfinished reservations as `interrupted`, preserves their consumed allowance and leaves unavailable token counts unknown. Use one governance service for the server process, consistent with the application's exclusive archive ownership lock.

The ledger records call ID, scope, agent, execution kind, connection ID, timestamps, duration, status, normalized token counts and a small allowlist of error codes. It does not record prompts, responses, credentials or arbitrary provider error messages. Provider-reported token counts are retained when available; missing counts remain `null`. Metadata is evidence that an attempt was made, not proof that the requested task succeeded.

## Opt-in autonomous routines

Enabling autonomy records `autonomousEnabledAt`. Editing other settings preserves that timestamp; disabling and later enabling autonomy establishes a new timestamp. The scheduler can therefore restrict automatic execution to queued routine tasks created after the current opt-in, while still requiring the routine to remain enabled.

`claimRoutine({routineId, scopeId, occurrenceId})` transactionally reserves one occurrence. Pass the queued task ID as `occurrenceId`. Repeated requests for the same occurrence return `claimed: false`, including on later days. Without an occurrence ID, the service allows one claim for that routine/scope/day. A routine claim is separate from its subsequent AI call reservations: a multi-agent routine may consume several calls and remains subject to the ordinary call budget.

The scheduler must check available budget before claiming work, honor provider and scope policies, and avoid silently replaying failed or interrupted occurrences. A partially completed assignment requires explicit recovery according to the task executor's rules. Enabling routine autonomy does not automatically approve deliveries, save inferred memories globally, execute unregistered repository commands, publish code or send external messages.

## Outcome metrics

`aggregateOperations(operations, repositoryState)` is a pure calculation over saved task artifacts, repository decisions, execution metadata and events:

- **Deliveries:** artifacts submitted for human review, with accepted, revised and pending counts.
- **Acceptance ratio:** accepted divided by accepted plus revised. Pending deliveries are excluded, and no reviewed deliveries produces `null` rather than an invented percentage.
- **Cycle duration:** elapsed time between a recorded start and delivery event. Pauses within that interval are included; this is wall-clock cycle time, not human labor time or estimated savings.
- **Procedure acceptance:** the same decision counts grouped by stored workflow ID.
- **Failures:** current failed records and recorded failure events, shown separately.
- **Reported tokens:** available input/output counts with unknown-count indicators. Partial totals are explicitly incomplete; unavailable usage is never treated as zero.

The pure operations aggregate describes execution metadata currently retained with tasks/runs. The governance ledger is the authoritative count of governed AI attempts, including failed attempts and earlier calls no longer represented by a task's current step state. Do not add those two datasets together as if they were disjoint usage.

AI review text does not count as a passed automated check or a human approval. Repository check status comes from the process exit result recorded by the runtime. No automatic monetary cost estimate, profitability calculation or time-saving claim is generated from token counts or task duration.

Users can save an outcome for one task or repository run: whether it was useful, an optional estimate of minutes saved, and an optional short note. An updated assessment replaces that entity's previous assessment with a new feedback version. Minutes saved are explicitly self-reported, may be zero, and remain unknown when omitted. Aggregates label these values accordingly. The HTTP layer requires an existing, approved task or repository run in the current trusted owner space before saving feedback.

## Integration contract

The service exports `snapshot`, `configure`, generic `execute(meta, callback, parentSignal?)`, `claimRoutine`, `saveOutcome` and `recoverInterrupted`. Provider and repository integrations wrap actual inference execution with `execute`; scope/provider permission checks still happen before any data is sent. A call-count budget is not a substitute for authorization or a filesystem sandbox.

Snapshots return versioned settings, the UTC period, daily allowance, recent usage records, total and daily usage aggregates, recent user outcomes and explicitly self-reported feedback totals. Recent lists are bounded to 200 items; aggregate counters use the full retained ledger. The archive limits are 50,000 call records, 50,000 routine claims and 10,000 user outcomes. Reaching a ledger limit fails closed instead of silently deleting accounting history or making an unreserved AI call.

The implementation is strict TypeScript executed through Node 24's supported type stripping, with no runtime-only enum or transformation requirement. Tests cover concurrency, pre-call durable reservation, daily boundaries, cancellation, timeout, crash recovery, duplicate routine claims, stale settings/feedback versions, token uncertainty and human-review-based metrics.
