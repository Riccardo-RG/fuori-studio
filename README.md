# Fuori Studio

A local AI studio for building and growing your own products. Organize projects, keep scoped memory, run work through named agents, and review versioned deliverables before accepting them. The explorable Three.js office is a visual theme; its ants do not represent background AI work.

**Current target:** one person, one local server, on a trusted computer. Owned products are the primary workflow. Client consulting and personal activities remain available as separate scopes with explicit sharing.

## Quick start

Use **Node.js 24 LTS** and npm. The supported runtime is recorded in `.nvmrc` and `package.json`.

```sh
nvm use                 # if you use nvm
npm ci
npm start
```

Open [the local studio](http://127.0.0.1:4386). Installation vendors the pinned Three.js modules; there is no frontend build step. The server binds only to `127.0.0.1`. Use `PORT=4387 npm start` for another port.

The default AI connection uses the Codex CLI already signed in on your computer. Check `codex login status` or set `FUORI_STUDIO_CODEX_BIN=/absolute/path/to/codex`. You can instead configure API services in **Servizi AI**; see [provider setup](docs/PROVIDERS.md). No API key belongs in Git or a chat message.

## First complete workflow

1. In **Progetti**, create an owned project. Keep the dedicated-memory option selected to give it its own conversation and notes.
2. Add the brief and constraints. Save durable decisions in **Memoria** and confirm only the notes you want agents to use.
3. Create an assignment using the built-in product-brief flow, one responsible agent, or a ready procedure. Its steps become real, persisted execution steps.
4. Start the assignment. Each completed step is saved. You may pause it and resume later; closing the browser does not stop a task.
5. Open **Da decidere** to inspect the delivered text, intermediate outputs, context references, and available token counts. Download a Markdown copy, approve it, or request changes with feedback.
6. After approval, select the memory action to draft an editable pattern or decision. It remains a proposal until explicitly confirmed in **Memoria**.

The agents currently analyze supplied information and produce text. They do **not** browse the web, modify repositories, publish content, send messages, or verify external facts. A research step means analysis of your supplied materials. Do not treat a generated plan as an executed change.

## What works

| Capability | Current behavior |
| --- | --- |
| Owned projects | Real project records with scoped tasks; optional client classification |
| Durable assignments | Ordered steps, single active task, saved outputs, pause/resume, restart after invalidated context |
| Deliverables | Versioned text, explicit approval or revision requests, Markdown export |
| Decision inbox | Deliverables waiting for review and interrupted/failed work |
| Memory | Confirmed/proposed notes, revisions, per-agent access, explicit cross-scope sharing |
| Procedures | Versioned instructions; selectable in chat or executed as task steps |
| AI services | Local Codex; API adapters for OpenAI, Anthropic, DeepSeek, OpenRouter |
| Provider controls | Per-agent service assignment, scope allowlists, no silent provider fallback |
| Routines | Scheduled creation of queued assignments while the local server runs; manual AI start |
| Office | Large anthill, forest, beach, mountain; camera navigation and reduced-motion support |

The team is **Riccardo** (AI leader), **Raffaele** (research), **Big Fonz** (product/development), **D’albenzio** (content), and **Cicciolina** (business). Riccardo the AI character is distinct from the human user.

## Local data

All mutable data lives in `.local/`, or in `FUORI_STUDIO_DATA_DIR` when set. The directory is ignored by Git and is outside the served frontend. Cloning the repository does not copy your local AI credentials or conversations.

- `workspace.json`: scopes, versioned memories and procedures.
- `operations.json`: projects, assignments, deliverables, events and routines.
- `providers.json`: service configuration and **unencrypted API keys** with private filesystem permissions.
- `conversations/`, `chat-selection.json`, `history/`: scoped conversations and archives.
- `server.lock`: single-server ownership of the data directory.

Existing mixed history in `chat.json` is preserved and opened only in **Conversazione iniziale**. It is not copied into new scopes. There is no automatic data sharing between a parent scope and its children.

Selected context is sent to the assigned AI provider. Local storage does not mean offline inference. Scope boundaries are application-level controls for a single user, not tenant isolation. Read [security and backup guidance](docs/SECURITY.md) before moving or sharing the data directory.

## Development and verification

```sh
npm run check
npm test
```

Tests use temporary archives, mocked HTTP responses, and a fake Codex binary. They make no paid API calls. HTTP integration tests bind a loopback port. CI runs the checks on Node 24. Frontend changes need a browser reload; server changes need a restart.

Start with [development guidance](CONTRIBUTING.md), [architecture decisions](docs/ARCHITECTURE.md), and the [HTTP API](docs/API.md). The UI is Italian; engineering and product documentation is English.

## Documentation

- [Product direction and boundaries](PRODUCT.md)
- [Operating the studio](docs/USER_GUIDE.md)
- [Architecture and stack decisions](docs/ARCHITECTURE.md)
- [Memory and context design](docs/MEMORY_DESIGN.md)
- [Provider setup and adapter limits](docs/PROVIDERS.md)
- [HTTP API and lifecycle](docs/API.md)
- [Security, backup and recovery](docs/SECURITY.md)
- [Competitor research](docs/AGENT_SYSTEMS.md)

## Office controls

Drag to rotate, wheel or **+ / −** to zoom, Shift/right-drag to pan. On touch devices, pinch to zoom and drag with two fingers to pan. **Panorama** shows the whole landscape; **Torna al team**, R or Home resets the view. Arrow keys rotate. Quiet mode and the system reduced-motion preference pause decorative animation.

Three.js is distributed under its MIT license, copied into `dist/vendor/THREE-LICENSE.txt` during installation. The world is built from geometry, not generated images.
