# Memory review

`Memoria → Rivedi memoria` offers a deterministic, read-only check of the notes
owned by the selected scope. It uses no model, writes no review archive and does
not change retrieval, permissions, memory status or content.

Two findings are available:

- **Repeated content:** records of the same memory type with equal content after
  NFC normalization and whitespace normalization. Case, punctuation and symbols
  remain significant. This is not semantic similarity or a recommendation to
  merge: records can have different sources, statuses and access grants.
- **Worth revisiting:** confirmed records whose actual `updatedAt` is at least
  90 elapsed days before the review time. Age is a reading prompt, not expiry or
  a correctness judgment. These notes remain available to eligible agents.

Each record includes its current version, source, last update and access details.
Opening a record refreshes the workspace and uses the existing memory editor,
including its version conflict handling. The review adds no delete, merge,
confirmation or bulk operation.

`GET /api/memory/review?scopeId=…` requires the normal signed-in session and an
explicit active scope. Findings and counts include only `memory.scopeId ===
scopeId`: linked notes and the common profile are excluded from other scopes.
The common profile can be inspected by selecting its own scope. Archived and
unknown scopes are rejected. Pending requests are discarded on a scope change
or session expiry, and an unsuccessful refresh clears previous findings.

`lib/memory-review.ts` exposes `createMemoryReview({workspace, now?}).snapshot`
and `buildMemoryReview(snapshot, {scopeId, now?})`. The pure function also serves
the Today summary; its `reviewMemories` count deduplicates notes appearing in
both groups. Tests cover conservative matching, the exact age boundary, source
and grant preservation, input immutability, and scope isolation.
