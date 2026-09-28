# Fuori Studio

A private AI studio for building and growing your own products. Organize projects, keep scoped memory, run work through named agents, and review versioned deliverables before accepting them. The explorable Three.js diorama visualizes studio activity; its animals never start AI work.

**Current target:** one owner per installation. Use it completely locally, or configure an authenticated online studio with optional paired computers and selective knowledge synchronization. Owned products are the primary workflow; consulting and personal activities remain separate scopes with explicit sharing. This is not a multi-tenant SaaS service.

## Quick start

Use **Node.js 24 LTS** and npm. The supported runtime is recorded in `.nvmrc` and `package.json`.

```sh
nvm use                 # if you use nvm
npm ci
npm start
```

Open [the local studio](http://127.0.0.1:4386). Installation vendors the pinned Three.js modules; there is no frontend build step. New domain modules use strict TypeScript executed by Node 24; `npm run check` includes static type checking. Existing UI and established adapters remain modular JavaScript. Local mode binds only to `127.0.0.1`. Use `PORT=4387 npm start` for another port.

The default AI connection uses the Codex CLI already signed in on your computer. Check `codex login status` or set `FUORI_STUDIO_CODEX_BIN=/absolute/path/to/codex`. You can instead configure API services in **Servizi AI**; see [provider setup](docs/PROVIDERS.md). No API key belongs in Git or a chat message.

## First complete workflow

1. In **Progetti**, create an owned project. Keep the dedicated-memory option selected to give it its own conversation and notes.
2. Add the brief and constraints. Save durable decisions in **Memoria** and confirm only the notes you want agents to use.
3. Create an assignment using the built-in product-brief flow, one responsible agent, or a ready procedure. Its steps become real, persisted execution steps.
4. Start the assignment. Each completed step is saved. You may pause it and resume later; closing the browser does not stop a task.
5. Open **Da decidere** to inspect the delivered text, intermediate outputs, context references, and available token counts. Download a Markdown copy, approve it, or request changes with feedback.
6. After approval, select the memory action to draft an editable pattern or decision. It remains a proposal until explicitly confirmed in **Memoria**.

Ordinary chat remains a text workflow. Explicit tools extend it: **Repository** prepares isolated code patches and executes configured checks; **Fonti** imports documents and read-only sources, with optional live web research through an authorized OpenAI API connection. Neither an AI reply nor a plan approval publishes code or sends messages. Review the recorded evidence before accepting a result.

## What works

| Capability | Current behavior |
| --- | --- |
| Owned projects | Real project records with scoped tasks; optional client classification |
| Durable assignments | Ordered steps, single active task, saved outputs, pause/resume, restart after invalidated context |
| Deliverables | Versioned text, explicit approval or revision requests, Markdown export |
| Decision inbox | Deliverables waiting for review and interrupted/failed work |
| Memory | Source-linked suggestions, review inbox, per-scope learning policies, conflicts, undo and deletion suppression |
| Portability | Scoped Markdown/JSON export, passphrase-encrypted packages, previewed imports as proposals |
| Identity | Optional OIDC owner login, protected sessions, CSRF checks and immediate revocation |
| Hybrid execution | Short-lived pairing codes, scoped devices, local Codex login, leases and stale-result rejection |
| Remote repository work | Separate repository grants, worker-local aliases/check policies, durable receipt recovery without rerunning edits |
| Deployment and recovery | Guided readiness, secret-file configuration, hosted container recipe, verified encrypted backups and new-directory restore |
| Authenticated GitHub | Scoped private-file imports, exact approved patch previews, isolated branches and explicitly published draft PRs |
| Memory evaluation | Owner-labeled retrieval cases, scope exclusions, missing facts, stale labels and versioned usefulness feedback |
| Knowledge sync | Opt-in scope replication, three-way conflicts and durable deletion markers; no credential transfer |
| Storage | SQLite transactions with authenticated encrypted records and encrypted migration backups |
| Procedures | Versioned instructions; selectable in chat or executed as task steps |
| AI services | Local Codex; API adapters for OpenAI, Anthropic, DeepSeek, OpenRouter |
| Provider controls | Per-agent service assignment, scope allowlists, no silent provider fallback |
| Routines | Queued by default; optional explicit autonomous start with durable daily call/run limits |
| Repository work | Committed baseline, isolated checkout, real checks, independent review, immutable patch and human approval |
| Sources | Scoped documents/PDF text, URL snapshots, public GitHub and allowed local folders; source versions and expiry |
| Web research | Explicit OpenAI Responses web search, domain filters, clickable citations and recorded provenance |
| Plans | Coordinator proposal, reviewed dependency graph, approved predecessor deliveries before execution |
| Outcomes | Accepted/revised deliveries, actual execution cycles, reported tokens and separately labeled user feedback |
| Office | Four living dioramas, local-time day/night, fires, interactive workstations, collaboration area and immersive work panels |

The team is **Riccardo** (AI leader), **Raffaele** (research), **Big Fonz** (product/development), **D’albenzio** (content), and **Cicciolina** (business). Riccardo the AI character is distinct from the human user.

## Local data

All mutable data lives in `.local/`, or in `FUORI_STUDIO_DATA_DIR` when set. The directory is ignored by Git and is outside the served frontend. Cloning the repository does not copy your local AI credentials or conversations.

- `studio.sqlite`: encrypted records for workspace, conversations, tasks, providers, sessions and device state. SQLite journal files also contain encrypted record payloads.
- `archive.key`: a private local encryption key when no external master key is configured. Keep it separate from database backups. Remote modes require `FUORI_STUDIO_MASTER_KEY` from your deployment secret manager.
- `server.lock`: single-server ownership of the data directory.
- `device/`: optional paired worker credentials, encrypted separately by the worker.
- `repository-runs/`: private isolated source checkouts. These working files are plaintext on disk; captured patch artifacts are encrypted in SQLite. Protect the data directory with normal OS permissions and disk encryption.

Existing JSON archives are validated and migrated on startup. Their original bytes are retained as encrypted migration backups before plaintext source files are retired. Invalid or divergent originals stop migration. The old mixed chat remains confined to **Conversazione iniziale**; parent scopes do not automatically share context with children.

Selected context is sent to the assigned AI provider. Local storage does not mean offline inference. The local key is not an OS keychain, and server-side encryption is not end-to-end encryption. See [security and recovery](docs/SECURITY.md).

## Optional online and hybrid use

Local mode requires neither an account nor a cloud service. For remote access, register an OIDC application and configure the exact owner's subject, HTTPS origin and deployment master key as described in [identity setup](docs/IDENTITY.md). Passkeys and recovery are provided by your chosen identity provider. Do not expose the unauthenticated local mode through a tunnel.

Use [the deployment guide](docs/DEPLOYMENT.md) for the Docker/Caddy recipe, then inspect **Accesso → Preparazione**. Configuration and verified external operation are shown separately. Create a verified backup, keep its key separately and perform [a restore drill](docs/DEPLOYMENT_RECOVERY.md) before relying on a hosted installation.

In the authenticated studio, open **Account e dispositivi**, generate a scoped pairing code and select the paired execution computer. On that computer:

```sh
npm run device -- pair https://studio.example.com
# Paste the one-time code at the prompt, then:
npm run device -- run
```

Codex must already be signed in on that computer. Its credentials are never uploaded. Offline devices do not trigger provider fallback. API connections can instead execute on the authenticated server with separately configured API keys.

For code work, grant the separate **Repository** capability and register aliases, scopes and checks on the worker itself; see [remote execution](docs/REMOTE_EXECUTION.md). A text-execution token cannot access a repository. GitHub credentials are another separate connection under **Progetti → GitHub**; they are never supplied to AI prompts or workers. Approval of a patch is followed by a read-only publication preview and a distinct explicit draft-PR action.

Knowledge synchronization is optional and explicitly started from its panel. It covers selected scopes, current memory and procedures, including deletion markers. Conversations, task histories, provider keys and access grants are not replicated between independent installations. For access to the same full workspace from another computer, sign in to the same hosted studio. Read [hybrid operation](docs/HYBRID_IDENTITY_AND_MEMORY.md) and [portable memory](docs/PORTABILITY.md).

## Development and verification

```sh
npm run check
npm test
```

Tests use temporary archives, mocked HTTP responses, and a fake Codex binary. They make no paid API calls and do not establish live provider or hosted-account readiness. HTTP integration tests bind a loopback port. CI runs the checks on Node 24. Frontend changes need a browser reload; server changes need a restart.

Repository execution is currently blocked on the inspected macOS 13.6.3 host: its Codex sandbox preflight fails with `TIOCSTI`. The app keeps isolation enforced and requires a compatible host/runtime before real editing or checks. See [the recorded compatibility diagnostic](docs/REPOSITORY_WORK.md#host-compatibility-diagnostic).

Start with [development guidance](CONTRIBUTING.md), [architecture decisions](docs/ARCHITECTURE.md), and the [HTTP API](docs/API.md). The UI is Italian; engineering and product documentation is English.

## Documentation

- [Product direction and boundaries](PRODUCT.md)
- [Operating the studio](docs/USER_GUIDE.md)
- [Dioramas, activity and accessible controls](docs/VISUAL_EXPERIENCE.md)
- [Architecture and stack decisions](docs/ARCHITECTURE.md)
- [Memory and context design](docs/MEMORY_DESIGN.md)
- [Hybrid access and assisted memory](docs/HYBRID_IDENTITY_AND_MEMORY.md)
- [Account and deployment setup](docs/IDENTITY.md)
- [Hosted installation and readiness](docs/DEPLOYMENT.md)
- [Verified backups and restore](docs/DEPLOYMENT_RECOVERY.md)
- [Remote repository execution](docs/REMOTE_EXECUTION.md)
- [Private GitHub access and reviewed publication](docs/GITHUB.md)
- [Measuring memory retrieval and usefulness](docs/MEMORY_EVALUATION.md)
- [Memory export and import](docs/PORTABILITY.md)
- [Repository execution and review](docs/REPOSITORY_WORK.md)
- [Documents, research and source provenance](docs/SOURCES.md)
- [Call limits, autonomous routines and measured outcomes](docs/GOVERNANCE.md)
- [Provider setup and adapter limits](docs/PROVIDERS.md)
- [HTTP API and lifecycle](docs/API.md)
- [Security, backup and recovery](docs/SECURITY.md)
- [Validation and outstanding prerequisites](docs/VALIDATION.md)
- [Competitor research](docs/AGENT_SYSTEMS.md)

## Office controls

Drag to rotate, wheel or **+ / −** to zoom, Shift/right-drag to pan. On touch devices, pinch to zoom and drag with two fingers to pan. **Panorama** shows the whole landscape; **Torna al team**, R or Home resets the view. Arrow keys rotate. Quiet mode and the system reduced-motion preference pause decorative animation.

Open a computer or use the scene's bottom dock to reach projects, memory, procedures and context. **Tutto schermo** expands the studio with usable work panels. **Ora locale** follows the device clock (day 07:00–19:00); **Sempre giorno** and **Sempre notte** override it. Every landscape has a lit campfire at night. Small **?** controls explain features on hover, keyboard focus or tap. There is no audio.

Three.js is distributed under its MIT license, copied into `dist/vendor/THREE-LICENSE.txt` during installation. The world is built from geometry, not generated images.
