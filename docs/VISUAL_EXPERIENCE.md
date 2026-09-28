# Visual experience

The studio is an interactive Three.js diorama surrounding the existing project, memory and agent workflows. It is a presentation layer: clicking scenery never schedules work, changes sharing rules, or consumes model tokens.

## Places and interaction

All four themes share the same recognizable office, workstations and collaboration table. Landscapes change their terrain, landmarks and wildlife:

| Theme | Landscape | Ambient animals | Error encounter |
| --- | --- | --- | --- |
| Anthill | Earthen nests, trails and a collection area | Workers carrying leaves and grains | A beetle approaches; defending ants attack, feed, then carry remains into the nest |
| Forest | Woodland, stream, bridge and pond | Squirrels and birds | A fox approaches and animals react |
| Beach | Lagoon, palms, jetty and boat | Crabs and turtles | A gull disturbs the shoreline |
| Mountains | Alpine lake, trails, pines and peaks | Marmots and ibex | A wolf approaches the mountain habitat |

Encounters are stylized geometric animation without gore. They do not represent an actual operation on a task. Workload increases locomotion and gathering activity. Each observed failure key starts one encounter; refreshing the same server snapshot does not repeatedly spawn predators. A newly opened browser has a new visual session and may show an unresolved failure again.

The free camera supports orbit, pan, zoom, overview and reset. There is no playable avatar. Workstations and projected labels are clickable; the bottom navigation exposes the same functions for keyboard and touch users. Memory, project, procedure and context hubs have different colors and silhouettes. Scope badges combine an icon and name with a stable color so color alone never communicates identity. These identities do not change context access.

Fullscreen uses the document element so native dialogs remain visible. If the browser denies or lacks the Fullscreen API, the same layout expands within the page. Existing panels are temporarily moved into the work dock, then restored to their original positions. This preserves their event handlers, form state and selections without duplicating IDs. Chat has its own overlay and toggle. The meeting panel shows real current participants and provides a link to their task or conversation.

## Lighting and preferences

The default `auto` mode uses the device's **local** clock: day at 07:00 inclusive, night at 19:00 inclusive. It is intentionally a simple schedule, not a sunrise calculation; no location permission or weather service is required. The interface and world use the same resolved mode. Every theme contains an illuminated campfire at night. Quiet mode keeps the illumination while freezing flicker and motion.

The browser stores only the daylight override in `localStorage` under `fuori-studio-daylight` (`auto`, `day`, `night`). Invalid or inaccessible storage falls back to automatic. The clock updates every 30 seconds and when the page becomes visible. Theme selection does not depend on `prefers-color-scheme`. An external initialization script applies the page theme before the main module loads, without weakening the server's Content Security Policy.

## Activity semantics

`deriveActivity` is a pure presentation function. Load is a bounded proxy based on live agents, pending/running stages and elapsed execution time. It is **not** a semantic estimate of complexity, reasoning effort, provider utilization, token cost or progress percentage.

- A running multi-agent task brings its assigned agents to the table. Only agents with a running stage are shown as actively working; the others belong to the task team. Ordered execution is unchanged.
- A current chat turn accumulates participants as actual status events arrive. It becomes a collaboration when at least two distinct agents participate. Finished turns never keep the table occupied.
- Separate single-agent tasks do not become a fictitious shared meeting.
- `review`, `paused`, `queued` and `completed` alone do not increase activity or trigger an intruder.
- A failed task or chat/provider connection error produces a stable visual problem key. Retrying a task removes the failed status; clearing an alert does not imply the result has been approved.

No new backend endpoints or paid calls are needed. Existing task polling and chat events provide the state. Rendering pauses while the document is hidden; server-side task execution can continue.

## Accessibility and performance

Help controls support hover, focus and tap, with an accessible label and a dismissible tooltip. Text panels remain the authoritative source for task state. Agent and workstation controls have accessible names. Reduced-motion preferences initialize quiet mode; users can also toggle it explicitly. Night controls use charcoal surfaces with separate sage, blue and amber accents. No audio assets or audio API are used.

The world uses shared geometry/materials, merged static geometry and instanced ant bodies, legs and carried items. Mobile rendering limits pixel density and shadow resolution. Animals and light effects are bounded; no new entity is spawned on every poll. Native geometric assets keep the project self-contained and avoid remote texture/font requests. Rendering still requires WebGL; if it is unavailable, the normal work panels and bottom navigation remain usable with a readable scene error.

## Code map and verification

- `dist/world.js`: environment, office, lighting, camera, click targets, collaboration paths and resource lifecycle.
- `dist/wildlife.js`: themed animals and error encounter state machine.
- `dist/experience-state.js`: local-time resolution, activity semantics and scope identities.
- `dist/experience.js`: panels, fullscreen, help, scope badges and browser preferences.
- `dist/studio.css`: day/night interface, overlays and responsive styles.
- `test/experience-state.test.mjs`: time boundaries, calm review states, genuine collaborations, stable failure keys and bounded activity.

The exported `getStudioDiagnostics()` in `dist/app.js` reports visual state and render counters for browser verification. It exposes no credentials or conversation text. Browser verification should cover all four themes in both modes, keyboard/touch help, work-panel restoration after fullscreen, quiet mode, two-agent collaboration, one complete anthill encounter, and narrow-screen overflow. Regression checks should still exercise project creation, task review and scoped memory because those same panels are now usable inside the scene.
