# Operating the studio

The interface is Italian. This guide names its visible controls so they are easy to find.

## Your living studio

Choose **Formicaio**, **Bosco**, **Spiaggia** or **Montagna**. Rotate, pan and zoom freely; click a colleague to inspect their role. Computer stations open **Progetti**, **Memoria**, **Procedure** and **Contesto**. The bottom dock provides the same actions without needing to locate a 3D object.

**Tutto schermo** expands the scene. Work panels stay available in an overlay; native fullscreen is used where supported, with an in-page fallback. Close a work panel with its close button, toggle the chat with **Chat**, or press **Esc** to return to the page. Opening a station preserves existing forms and does not make an AI request.

Lighting follows the device's local time by default: day from 07:00 until 19:00, night otherwise. Choose **Sempre giorno** or **Sempre notte** to override it. This preference stays in this browser and does not follow the operating-system color theme. Fire and lamps illuminate the scene at night; the interface uses charcoal surfaces and contrasting controls.

Animals become busier when actual work is running. Failed tasks or chat/provider errors cause a themed intruder encounter; ordinary reviews, queued tasks and approvals do not. The activity meter is based on active agents, remaining stages and elapsed work, not a measurement of reasoning difficulty. Resolving or retrying a failure clears its alert; watching the encounter does not fix the underlying task.

The **Riunioni** table brings together agents involved in one running assignment or current collaborative chat response. Its panel identifies the current stage and actual active agents. Task stages still execute in order; a meeting is a visual representation and does not start another AI conversation.

Hover, focus or tap a small **?** for help. Tap again, click outside or press Esc to dismiss it. **Quiet mode** pauses decorative movement, including fire and wildlife; static night lighting remains. The device's reduced-motion preference is respected. No sounds play. See [visual behavior and implementation](VISUAL_EXPERIENCE.md) for details.

## Account, devices and synchronization

Open the account button at the top right, next to the separate AI connection badge. In local mode it reads **Su questo dispositivo**: no account is required to use that installation. Hybrid and online installations require the configured account login before loading protected studio data. An expired session returns to the login screen.

**Account** shows the actual access mode, archive status and browser sessions. The account opens the studio; it does not sign you into Codex or another AI service. **Servizi AI** opens those separate connection settings. You can terminate another browser session or use **Esci da questo studio** for the current one.

In an authenticated online or hybrid studio, open **Dispositivi → Collega un nuovo dispositivo**. Give it a name, explicitly select its capabilities and scopes, then create a one-time code. Scope access is not selected globally by default. Keep the code only until the intended device uses it; it expires and cannot be reused. Local-only installations do not generate remote pairing codes.

**Dove lavora l’AI** selects the installation that runs new assignments. A remote device needs execution permission, access to the task scope and a running executor process. A paired device marked offline is not ready just because it has been registered. Follow [hybrid setup](HYBRID_IDENTITY_AND_MEMORY.md) to configure the executor. **Revoca questo dispositivo** stops future access; it cannot erase copies already transferred to that device.

On the local installation, open **Sincronizzazione → Collega uno studio** and enter the online studio address, one-time code and device name. Select only the scopes granted by that link and press **Salva selezione**. No scopes are enabled automatically after connecting.

Use **Sincronizza ora** to transfer updates. Synchronization is manual in this version and covers scopes, memories and procedures. It does not copy the complete conversation archive, assignments or AI credentials. Each installation remains responsible for its own history and tasks. Deselecting a scope stops future updates; disconnecting the studio does not delete existing copies.

When both copies changed, the **Versioni da confrontare** section displays the local and linked content. Choose the version to retain; the application does not use timestamps or an AI guess to overwrite it. If a copy was deleted, an older surviving record cannot silently recreate it. Copy any text still worth keeping into a new note before confirming that deletion. A changed conflict must be refreshed and reviewed again.

## Projects and scopes

Open **Progetti** and create your product. `Owned` is the default classification; use a client project only for actual consulting. A dedicated project scope separates its chat and memory. To reuse a company-wide decision, explicitly share that one note with the project.

A project is a work container; connect a committed local source checkout separately in **Repository**. Use **Pianifica con Riccardo** to review a dependency plan before creating its queued assignments. Do not enter an API key into a project brief, memory, task, or chat. Use the password field in **Servizi AI**.

## Assignments and review

Create an assignment with a concrete brief: intended audience, available facts, constraints, and acceptance criteria. Choose one responsible agent, or a ready procedure whose steps assign the relevant roles. A procedure must be available in the project's scope.

Starting sends authorized context to the configured services. Work continues if you reload or close the browser, provided the server stays running. Inspect step status and returned usage in the task detail. **Pause** cancels the unfinished call; **Resume** keeps completed steps. If source context changed, restart from the beginning. When a procedure itself changed, create a new task from its current version.

In **Da decidere**, read the entire delivery and check claims that require outside evidence. Approve acceptable output or request changes with specific feedback. Previous versions remain visible. Markdown export produces a local download; it does not publish or send the document.

## Reusable knowledge

Use **Memoria** for stable information, preferences, decisions and patterns. Proposed notes are excluded from AI context. Review the wording, source, scope and allowed agents before confirming.

After accepting a delivery, prepare a memory proposal from the task. Prefer a reusable lesson rather than copying the entire delivery. The proposal is scoped, attributed to the task version and remains unconfirmed. Explicitly generalize sensitive details before sharing a method elsewhere.

## Assisted memory

The memory settings belong to the selected scope, independently of other projects. Open **Memoria → Impostazioni** to choose:

- **Manuale**: you decide what to save with **Ricorda questo** or a manual note.
- **Assistita**: the studio proposes durable information from your own messages. Pending proposals are excluded from agent context until you confirm them.
- **Automatica**: only the preference and recurring-method categories you explicitly enable may be saved automatically. Sensitive information, uncertain statements and conflicts still need review.

Turning off **Apprendimento dai messaggi** stops new automatic proposals and saves for that scope. It does not erase the conversation, remove existing memories or prevent an explicit manual save. Shared profile and archive scopes are managed manually.

The quiet **Da rivedere** inbox shows the proposed wording, its type and the original user message. **Rivedi e conferma** lets you edit the title and content. **Scarta** leaves the original chat message intact. A conflicting proposal requires an explicit choice: keep it as a separate memory or replace a particular existing version. Existing restrictions remain attached when replacing a memory.

Under a user message, **Ricorda questo** prepares a confirmed memory linked to that stored message and conversation. Under an AI reply, **Crea una nota** opens a manual proposal for your own review; an AI statement is not treated as a verified user fact. **Ricordi salvati di recente → Annulla salvataggio** removes a newly saved memory or restores the preceding version, provided it has not been edited since. The original conversation remains available.

## Taking your knowledge elsewhere

The small **Esporta / Importa** toolbar is in **Memoria**. Export includes the selected scopes' memories and reusable procedures, not conversations, service credentials or cross-scope sharing grants.

**Esporta** defaults to an encrypted archive. Select the scopes and enter the same passphrase twice, with at least 12 characters. Keep that passphrase: the studio does not save it and it is required to import the archive. The file downloads to the browser's normal download location. JSON is an unencrypted, reimportable alternative. Markdown is a readable document for inspection or sharing and cannot be imported as an archive.

For **Importa**, choose an encrypted `.fs-memory` archive or exported `.json`, select the destination scope and provide the passphrase when needed. **Prepara anteprima** shows the titles, counts, duplicates and conflicts before making changes. The preview expires after 15 minutes. Imported memories are proposals and imported procedures are drafts with new identifiers; existing records are never overwritten. Duplicate or conflicting items identified by the preview are skipped.

Only **Importa come proposte e bozze** applies the preview. Review the resulting memories and procedures before confirming them for agent use. Password fields are cleared after the export or preview request, and the application does not place passphrases in browser storage or URLs. See [portable archives](PORTABILITY.md) for supported formats and limits.

## Services and permissions

Configure an API service using its exact model ID and your API key, then assign it to an agent. Enable that connection for the scopes whose data it may receive. A shared note's source scope must also allow the connection. There is no implicit fallback to another provider.

A connection is configured when credentials and model are present, not necessarily reachable or funded. **Test connection** makes a tiny request that can be billed. Model catalog access, quotas and features depend on the account. The default Codex connection uses the existing machine login.

## Routines

Create a routine, choose an interval and next due time, and explicitly enable it. The running server checks for due work every 30 seconds. Each occurrence becomes a queued task. By default, you review and start it manually. In **Routine**, explicit autonomy opt-in can start new eligible occurrences while the routine remains enabled, within the daily call and automatic-run limits. Existing queued work from before the opt-in stays manual. Automatic execution still ends at human delivery review; it does not approve or publish results.

The server must be running; your laptop being asleep or offline can delay queue creation. When it resumes, missed occurrences coalesce into one. Disabling a routine leaves already-created tasks intact.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Service not allowed | Add the connection to the current scope and all source scopes used by the task |
| Codex unavailable | Verify `codex login status` and `FUORI_STUDIO_CODEX_BIN` |
| Repository sandbox reports `TIOCSTI` | The inspected macOS 13.6.3 runtime fails its sandbox preflight. Use a compatible host/runtime; keep sandbox enforcement enabled. See [compatibility details](REPOSITORY_WORK.md#host-compatibility-diagnostic). |
| Daily call limit reached | Wait for the displayed UTC reset or deliberately update the limit; provider billing and quotas remain separate. |
| Context changed on resume | Restart the task; create a new task if the procedure changed |
| Task paused after restart | Inspect completed steps, then resume explicitly |
| Model request rejected | Check exact model ID, API compatibility, balance and key permissions |
| Archive cannot be read | Stop the server, keep the original file, restore a verified backup |
| Another server owns the archive | Stop the other instance or use a separate data directory |
| Provider connection changed but chat badge is old | Reload the page |

See [security and recovery](SECURITY.md) before deleting or replacing a local data file.


## Sources, code and outcomes

Use **Fonti** to import text, Markdown or text-based PDFs, capture a public page or GitHub source, or import supported files from an explicitly allowed local folder. Sources remain documents with provenance, not confirmed memories. The studio selects relevant current extracts within the same scope; stale or deleted sources cannot silently support old context. Web research is an explicit paid action through a configured, authorized OpenAI API connection with clickable references.

Use **Repository** for isolated changes and real command evidence. The original working directory is preserved. Review the patch and checks before approval; approval never merges or publishes it. See [the full repository workflow](REPOSITORY_WORK.md).

In an online studio, select a repository worker that has been paired with the separate repository permission. Register its aliases and checks on that computer first. Its status and locally approved commands appear in the repository form. A disconnected worker can redeliver a saved result without rerunning the edit.

Use **Progetti → GitHub** to configure an encrypted, scoped account connection. Read access can import selected private text files. Enable publication only when needed. After approving a repository run, **Prepara PR GitHub** shows the destination, immutable base and patch hash. A separate confirmation creates a new branch and draft pull request. If the outcome is uncertain, use **Verifica esito**; do not assume it failed and create another proposal. Inspect GitHub before merging, especially if the base changed.

Use **Memoria → Valuta memoria** to save real questions with expected and excluded memories, then run retrieval checks without AI calls. Results show missing notes, scope exclusions, order and truncation. A changed note requires reviewed labels; a passing ID-presence test does not prove that the answer or full memory content is correct. Record usefulness feedback and open the actual note to correct it. See [memory evaluation](MEMORY_EVALUATION.md).

Use **Accesso → Preparazione** to distinguish configured services from verified evidence, check archive integrity, create a verified backup and download its encrypted file. Keep the key separately and follow [the recovery guide](DEPLOYMENT_RECOVERY.md) for a restore drill. This panel does not publish the installation automatically.

**Risultati** shows accepted and revised deliveries, recorded cycle durations and available token counts. Feedback and minutes saved are your own estimates and are labeled separately. **Routine** contains daily AI-call limits and optional autonomous execution. Autonomy is off initially and requires an explicit save; it does not wake a stopped server. See [limits and outcomes](GOVERNANCE.md).
