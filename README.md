# Fuori Studio

Fuori Studio is a local 3D office for an AI team. Its block-style coworkers work at the center of a sprawling anthill, surrounded by busy ants. Forest, beach, and mountain landscapes are also available. A shared chat uses the Codex installation already signed in on your Mac.

## Current status

The office, animated landscapes, shared chat, and parallel specialist responses work locally. This is an early version: project cards describe Riccardo's projects, but they are not connected to their folders or GitHub repositories. Agents can discuss, plan, and draft; they cannot edit project code or perform web research from this app yet.

## Requirements

- Node.js and npm
- Codex CLI with an active sign-in (`codex login status`)

## Run locally

```sh
npm install
npm start
```

Open **http://127.0.0.1:4386**. The server listens only on the local loopback interface. To use another port, run `PORT=4387 npm start`.

`npm install` copies the required Three.js modules into `dist/vendor/`. The app needs no separate frontend build step.

## Use the office

- Write in the shared chat. Riccardo, the AI team leader, recognizes the context and responds or delegates relevant tasks.
- Address a coworker directly, for example `@Big Fonz`, without configuring roles or selecting a project for every message.
- Up to three specialists can work on independent responses in parallel. Their activity in the scene follows actual requests.
- Explore the anthill (the default landscape), forest, beach, and mountains. The team stays at the center of a larger surrounding world. Ant activity is scenic animation, independent of AI requests.
- Drag to rotate, use the wheel or **+ / −** buttons to zoom, and **Shift + drag** or right-drag to pan. On touchscreens, pinch to zoom and drag with two fingers to pan.
- Use **Panorama** to see the full landscape and **Torna al team**, **R**, or **Home** to return to the team. Arrow keys adjust the view.
- Select a coworker to see their role and start a direct message.
- Quiet mode pauses character movement. The interface also respects the system's reduced-motion preference.
- Use **Stop** to cancel a request. Responses already received remain in the conversation.

The five AI coworkers are **Riccardo** (leader), **Raffaele** (research), **Big Fonz** (product and development), **D'albenzio** (content), and **Cicciolina** (business). Their internal identifiers stay unchanged so existing conversations remain associated with the same roles.

## Local data and Codex

The active conversation is saved in `.local/chat.json`. Starting a new conversation archives the previous one in `.local/history/`. This directory is ignored by Git and is not served by the web server.

The local server sends your message and recent conversation context to Codex through `codex exec`. It uses your existing Codex sign-in and its associated plan limits; the project does not copy credentials, and the browser never receives them. The server rejects external hosts and origins, and its write endpoints accept only local JSON requests.

The app detects the Codex binary bundled with the desktop app. To provide another binary, run `FUORI_STUDIO_CODEX_BIN=/path/to/codex npm start`.

Codex runs are ephemeral and use a read-only sandbox. The current prompts explicitly instruct agents not to use tools. Connecting this application's own repository to GitHub does **not** connect the in-app project cards to GitHub.

## Project layout

- `server.mjs` — local HTTP server, request checks, and chat streaming.
- `lib/chat.mjs` — conversation storage, coordination, and parallel Codex processes.
- `lib/route.schema.json` — structured coordinator response.
- `dist/app.js` — chat and office interactions.
- `dist/data.js` — team roles and project descriptions.
- `dist/world.js` — geometric Three.js world, landscapes, and animation.
- `dist/vendor/` — Three.js files and MIT license copied during installation.
- `PRODUCT.md` — product decisions and current scope (in Italian).

Run `npm run check` to check JavaScript syntax. Reload the page after changing frontend files, or restart `npm start` after changing the server.

## References

- [Codex non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Three.js installation](https://threejs.org/manual/pages/installation.html)

The world is generated and animated in real time; it does not use the earlier experimental images. Three.js is distributed under the MIT license included at `dist/vendor/THREE-LICENSE.txt`.
