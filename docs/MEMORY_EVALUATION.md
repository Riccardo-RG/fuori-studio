# Evaluating memory usefulness

Open **Memoria → Valuta memoria** in the intended project scope. Evaluation calls the same `workspace.getContext` retrieval used for work, without an AI request. It measures whether the owner-labeled memories are selected. It does not grade a model's answer, prove a fact is true, or infer that every selected memory is useful.

## Build cases from real work

1. Choose an actual recurring question, the responsible agent and the active project scope. For example, ask which runtime and verification commands apply to an owned product.
2. Select the confirmed memories that should appear. Positive labels must be authorized for that scope and agent. Only label information you actually expect the agent to need.
3. Optionally select memories that must not appear, including a private note from another scope. This tests separation without sharing that note with the agent.
4. Save and run the case. No AI service is invoked and no knowledge is automatically changed.
5. Inspect missing memories, forbidden selections, order and truncation. Correct the source note or explicitly adjust sharing when justified, review the case labels, and run it again. Changing a case preserves prior results as historical evidence.

An empty evaluation library has no score. The application does not create favorable labels or claim that fixture benchmarks represent your work. A useful first collection includes a normal project question, a cross-scope exclusion, an agent-restricted note, a global preference and a crowded context where relevant facts compete for space.

## Interpret the result

- **Expected coverage (`recall`)** is the number of expected memory IDs selected divided by the number labeled as expected. An exclusion-only case has unknown coverage, represented as `null`.
- **Expected share (`expectedShare`)** is the expected selections divided by all selections. This is not a general precision score: an unlabeled preference or constraint may legitimately belong in the context.
- **Passed** means every positive label was selected, no negative label or unauthorized/stale record was selected, and the eight-memory/unique-record bounds held. A truncated selection can still pass presence testing; inspect its visible truncation marker before assuming that all needed content was supplied.
- **Needs review** means an expected or forbidden record was edited, removed or had its grants/status changed. These labels must be explicitly reviewed. The application does not silently update expected versions or count this as a retrieval failure.
- **Historical results** retain IDs, versions, ordering and measurements. They are excluded from the current summary when the case or relevant context changes. New or changed memories eligible for that scope/agent invalidate the measurement; unrelated private scopes do not.

The current retriever is deterministic lexical retrieval (`lexical-v1`). It selects at most eight confirmed notes and reserves room for up to three preferences or decisions. Supplied note text is capped at 1,500 characters and source text at 300. Documents and model responses are outside this memory evaluation's measured labels. Evaluate these separately before adopting an embedding model or changing retrieval rules.

## Feedback and corrections

Record **useful / needs improvement** feedback against a specific memory version. Optional notes are owner feedback, not automatically inferred accuracy. Editing the memory makes the previous feedback historical. The correction action opens the actual versioned memory editor; it does not let an evaluation overwrite a note or broaden its grants.

Cases, feedback and results are encrypted in the installation archive. Results store memory references rather than copies of memory bodies. Case queries and feedback notes are user-authored records: do not put credentials in them. Removing a case also removes its evaluation history. Deleting a memory removes it from current feedback displays and makes related case labels stale; it does not erase separately authored case questions.

## Limits and verification

One installation supports 100 cases, 500 recorded runs, and up to 30 positive plus 30 negative labels per case. Limits fail explicitly rather than dropping old evidence. Remove obsolete cases and their history to reclaim space. The browser and HTTP API require the owner's authorization; device tokens cannot read or run evaluations. Mutations require an idle studio and the usual CSRF protection.

Automated tests exercise the real retrieval implementation with temporary workspaces: scope isolation, restricted agents, missing and forbidden results, context saturation and truncation, version/grant/deletion changes, concurrent drift, feedback versions and explicit deletion. These tests establish behavior, not the usefulness of an unmeasured personal memory library.
