# Reusable workflow fields

Workflows can define up to four reusable text fields: `materials`, `objective`,
`constraints`, and `deliverable`. Each field has an editable label, an explicit
required flag, and an optional default value. The workflow editor exposes these
settings; task, routine, and chat forms collect the values for that use. Preparing
or validating fields makes no AI calls.

Chat presents the per-use form within [the execution preview](EXECUTION_PREVIEW.md);
tasks and routines collect values when prepared and retain the compiled snapshot.
Review the selected agents, context and [call budgets](BUDGETS.md) before starting.

The optional `inputFields` property contains objects with exactly `key`, `label`,
`required`, and `defaultValue`. Labels allow 100 characters; individual defaults
and values allow 4,000 characters; combined values allow 12,000 characters. Keys
must be unique. Existing archives without `inputFields` retain their behavior and
do not acquire new fields or revisions during loading. Saving changes uses the
existing workflow version checks. Approved-task recipes start with empty fields:
objective and deliverable are required, while materials and constraints are optional.
When an approved task already used fields, learning restores its current authorized
source templates and field definitions instead of copying the populated instructions.
All defaults are cleared. A changed, unavailable, or unshared source blocks learning
until the user reviews the work again.

Use `{{materials}}`, `{{objective}}`, `{{constraints}}`, and `{{deliverable}}` in
workflow materials, step output instructions, or expected output. Only enabled
fields can be referenced when fields are configured. The resolver replaces each
placeholder once with a quoted JSON string. Placeholders inside a supplied value
remain literal text. The resolved brief and individual step instructions must
still fit their 16,000-character limits; oversized expansions fail before execution.

A missing value uses its default. An explicitly supplied blank value remains blank
and fails validation for a required field. Values retain their original whitespace.
These values are reference data; they cannot grant access, change scope, select a
different agent, or override execution rules. HTML rendering escapes labels and
values. The executor's data boundary remains necessary: quoting text does not make
untrusted instructions safe to obey.

## Integration contract

`lib/workflow-inputs.mjs` provides deterministic helpers:

- `resolveWorkflowInputs(workflow, {inputValues, expectedWorkflowVersion})`
  returns `hydratedWorkflow`, `resolvedInputs`, and an optional `workflowInputs` snapshot.
- `prepareWorkflowTask(workflow, {brief, inputValues, expectedWorkflowVersion})`
  returns the composed `brief`, executable `steps`, and optional `workflowInputs`.
- `hydrateWorkflowFromSnapshot(workflow, workflowInputs)` checks the current
  workflow version and field definitions before restoring the compiled workflow.
- `validateWorkflowFields`, `validateWorkflowTemplates`, and
  `validateWorkflowInputSnapshot` enforce the persistence boundaries.

Pass the complete authorized workspace workflow to these helpers. Context summaries
can truncate templates and must not be used for compilation. Fielded workflows
require the current `expectedWorkflowVersion`. Resolve inputs only after existing
scope, ready-status, and agent/provider permission checks. HTTP callers supply raw
values; only trusted server code constructs stored snapshots. Never accept a
client-supplied `workflowInputs` snapshot as authority.

Tasks and routines store `workflowInputs` with `version: 1`, `workflowVersion`,
the original `fields`, and resolved `values`. Task preparation also retains an
optional `originalBrief`, so editing a routine does not append its compiled inputs
again. Routine claims copy that snapshot to
their tasks. Execution revalidates against the current authorized workflow before
using it. Adding fields or changing the workflow invalidates old snapshots rather
than running with missing data. Editing a routine to remove or change its workflow
clears the old snapshot unless trusted server code supplies a replacement.

The browser helpers in `dist/workflow-fields.js` render and read the field editor,
per-use form, and original task values. Their English copy is in
`dist/locales/workflow-fields.en.js`; built-in labels translate, and custom labels
and saved values remain user text.

## Portability and verification

Workflow field definitions and defaults travel with current workflow records in
JSON/encrypted export, import, and synchronization. Markdown exports describe them
for reading. Import still creates draft workflows with no sharing grants. Field
definitions participate in duplicate detection and sync hashes. Task-specific values
are operations records and are not included in portable memory/workflow exports.

`test/workflow-inputs.test.mjs` covers invalid schemas, missing required values,
defaults, size limits, literal interpolation, stale versions, persistence, routine
claims, portable and sync round trips, and safe browser rendering. It also verifies
that task-local context exclusions survive pause and restart. Those exclusions do
not grant access to otherwise unauthorized context.
