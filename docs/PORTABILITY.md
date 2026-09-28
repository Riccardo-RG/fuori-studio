# Portable memory

Fuori Studio owns the durable application memory independently of the selected AI service. Switching a provider does not require moving that provider's login or reconstructing notes from chat history. Portable exports make the selected knowledge usable outside the application as well.

## Formats and contents

The default export is a passphrase-encrypted `.fs-memory` file. JSON is a readable interchange format that can be imported again. Markdown is a human-readable document for review or deliberate use with another tool; Markdown is not an import format. JSON and Markdown are plaintext, and the interface requires choosing them explicitly.

An export contains only the selected scopes' current **confirmed memories** and **ready procedures**, their original IDs, source references, scope names and agent restrictions. It omits revisions, proposed memories, procedure drafts, conversation history, provider connections, API keys, Codex authentication, device credentials, sessions, automatic-memory policies, sharing grants, deletion tombstones and undo history. A secret-pattern detector additionally excludes suspicious note content and reports a warning; it cannot identify every possible secret written as ordinary prose. Review readable exports before sharing them.

The schema is strict and versioned:

```json
{
  "format": "fuori-studio-memory",
  "version": 1,
  "exportedAt": "2026-09-27T12:00:00.000Z",
  "scopes": [{ "id": "business", "name": "Imprenditoria" }],
  "memories": [],
  "workflows": []
}
```

Memory fields are `id`, `scopeId`, `type`, `title`, `content`, `status`, `source`, `sharedWith` (always empty) and `agentIds`. Workflow fields are `id`, `scopeId`, `title`, `description`, `input`, `steps`, `output`, `status`, `source` and empty `sharedWith`. The normal field lengths, permitted agent IDs and maximum twelve workflow steps apply. Unknown fields and executable command/tool structures are rejected.

## File encryption

Encrypted exports use AES-256-GCM, a fresh 96-bit IV and 128-bit authentication tag. A fresh 128-bit salt and scrypt derive the 256-bit key from a passphrase of 12–1,024 characters. Scrypt parameters are fixed at `N=32768`, `r=8`, `p=1`; imports reject changed or unsupported parameters rather than accepting attacker-controlled CPU/memory costs. The version and algorithm contract are authenticated as additional data. Wrong passphrases and modified ciphertext fail without importing anything.

The passphrase and derived key are not persisted or logged by the portability service. Key buffers are cleared after use. The user must keep the passphrase separately: there is no recovery backdoor. This encryption protects the downloaded file; it is not a claim of end-to-end encrypted AI inference or server operation. The application server necessarily handles plaintext during export/import, and an authorized AI connection receives whichever context is later selected.

Limits are 8 MiB for decoded JSON and 12 MiB for an encrypted envelope, at most 2,000 notes, 300 procedures and 200 source scopes. These limits are checked before expensive key derivation or import work.

## Preview and explicit import

Import has two steps. First choose the file, its passphrase when encrypted, and a current target scope. The server validates the entire file and returns a preview with proposed/draft, duplicate and conflict counts. Previewing does not add any memory or send information to an AI service.

The validated preview is kept in the application's encrypted archive for fifteen minutes, not browser local storage. At most twenty previews can be active. Expired previews cannot commit; their payload is cleared when accessed or on the next preview cleanup. Completed previews also discard the imported payload. This is logical application retention, not a promise to erase historical database snapshots or backups.

Confirming the preview creates new IDs in the chosen target scope. Every imported memory is **proposed** and every workflow is **draft**, regardless of the source's status. No imported content participates in retrieval or procedure execution until the user reviews it. Original agent restrictions and source references are retained; scope-sharing grants are never imported. Importing directly into Shared profile or Legacy is rejected, so broad sharing must be a deliberate later edit.

Identical content in the destination is skipped. A matching title with different content is reported as a conflict and skipped, never overwritten. The server repeats these checks at commit time, so edits made after preview remain protected. The batch and its import receipt commit together; retries, duplicate clicks and a crash after workspace commit cannot duplicate notes. A later explicit import of previously deleted content is a new proposed record, not resurrection of an old synchronized ID.

This is knowledge portability, not a full account/device backup or arbitrary file-ingestion engine. A full encrypted archive backup also needs its deployment encryption key and follows the archive recovery process. A portable memory file does not grant another device access to Codex, other AI subscriptions, or the online account.

## API contract

All three endpoints require the same authenticated owner or protected local context as other mutations.

| Endpoint | Request | Result |
| --- | --- | --- |
| `POST /api/memory/export` | `{scopeIds, format: "encrypted"\|"json"\|"markdown", passphrase?}` | `{filename, mime, content, counts, warnings}` |
| `POST /api/memory/preview-import` | `{content, passphrase?, targetScopeId}` | `{importId, expiresAt, counts, items, warnings}` |
| `POST /api/memory/import` | `{importId}` | `{snapshot, imported, skipped}` |

`counts` in a preview contains `memories`, `workflows`, `duplicates` and `conflicts`. Each preview item has `kind` (`memory` or `workflow`), `title` and `status` (`proposed`, `draft`, `duplicate` or `conflict`). Commit counts distinguish imported memories/workflows from skipped duplicates/conflicts. No file path or executable instruction is accepted by these endpoints.
