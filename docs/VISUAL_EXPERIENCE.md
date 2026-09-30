# Visual experience

The studio is an interactive Three.js diorama surrounding the existing project, memory and agent workflows. It is a presentation layer: clicking scenery never schedules work, changes sharing rules, or consumes model tokens.

## Places and interaction

All four themes share the same recognizable office, workstations and collaboration table. The original 60 × 50 campus sits in a 180 × 150 landscape. Landscapes change their terrain, landmarks and wildlife:

| Theme | Landscape | Ambient animals | Error encounter |
| --- | --- | --- | --- |
| Anthill | Earthen nests, a hollow log, colony granaries, dew gardens, amber quarry and root plaza | Workers carrying leaves and grains | A beetle approaches; defending ants attack, feed, then carry remains into the nest |
| Forest | Woodland, willow waterfall, ruins, suspension bridge, firefly clearing and great oak | Squirrels and birds | A fox approaches and animals react |
| Beach | Lagoon, tide lighthouse, fishing harbour, sea arch, golden dunes and coral island | Crabs and turtles | A gull disturbs the shoreline |
| Mountains | Alpine lake, observatory, stone viaduct, switchback trail, starlight lodge, pines and peaks | Marmots and ibex | A wolf approaches the mountain habitat |

Encounters are stylized geometric animation without gore. They do not represent an actual operation on a task. Workload increases locomotion and gathering activity. Each observed failure key starts one encounter; refreshing the same server snapshot does not repeatedly spawn predators. A newly opened browser has a new visual session and may show an unresolved failure again.

The free camera supports orbit, pan, zoom, overview and reset. There is no playable avatar. Workstations and projected labels are clickable; the bottom navigation exposes the same functions for keyboard and touch users. Memory, project, procedure and context hubs have different colors and silhouettes. Scope badges combine an icon and name with a stable color so color alone never communicates identity. These identities do not change context access.

**Explore** opens a compact landscape atlas with five named destinations, a return to the studio, and a marker for the camera's current centre. Map pins and the numbered destination list are keyboard-accessible buttons using the same world coordinates as camera navigation. The local SVG terrain is a schematic map, not an additional rendered camera or a precise camera frustum. Its bounded panel scrolls on smaller screens, closes with Escape or an outside interaction, and follows live Italian/English changes. Selecting a place changes only the camera. The current scene remains available at every graphics level.

Fullscreen uses the document element so native dialogs remain visible. If the browser denies or lacks the Fullscreen API, the same layout expands within the page. Existing panels are temporarily moved into the work dock, then restored to their original positions. This preserves their event handlers, form state and selections without duplicating IDs. Chat has its own overlay and toggle. The meeting panel shows real current participants and provides a link to their task or conversation.

## Lighting and preferences

The default `auto` mode uses the device's **local** clock: day at 07:00 inclusive, night at 19:00 inclusive. It is intentionally a simple schedule, not a sunrise calculation; no location permission or weather service is required. The interface and world use the same resolved mode. Every theme contains an illuminated campfire at night. Quiet mode keeps the illumination while freezing flicker and motion.

The daylight override is stored in `localStorage` under `fuori-studio-daylight` (`auto`, `day`, `night`). The atlas separately saves graphics mode under `fuori-studio-quality` (`auto`, `lite`, `balanced`, `detailed`). Invalid or inaccessible storage falls back to automatic. The clock updates every 30 seconds and when the page becomes visible. Theme selection does not depend on `prefers-color-scheme`. An external initialization script applies the page theme before the main module loads, without weakening the server's Content Security Policy.

## Activity semantics

`deriveActivity` is a pure presentation function. Load is a bounded proxy based on live agents, pending/running stages and elapsed execution time. It is **not** a semantic estimate of complexity, reasoning effort, provider utilization, token cost or progress percentage.

- A running multi-agent task brings its assigned agents to the table. Only agents with a running stage are shown as actively working; the others belong to the task team. Ordered execution is unchanged.
- A current chat turn accumulates participants as actual status events arrive. It becomes a collaboration when at least two distinct agents participate. Finished turns never keep the table occupied.
- Separate single-agent tasks do not become a fictitious shared meeting.
- `review`, `paused`, `queued` and `completed` alone do not increase activity or trigger an intruder.
- A failed task or chat/provider connection error produces a stable visual problem key. Retrying a task removes the failed status; clearing an alert does not imply the result has been approved.

No new backend endpoints or paid calls are needed. Existing task polling and chat events provide the state. Rendering pauses while the document is hidden or the scene is outside the viewport; server-side task execution can continue.

## Accessibility and performance

Help controls support hover, focus and tap, with an accessible label and a dismissible tooltip. Text panels remain the authoritative source for task state. Agent and workstation controls have accessible names. Reduced-motion preferences initialize quiet mode; users can also toggle it explicitly. Night controls use charcoal surfaces with separate sage, blue and amber accents. No audio assets or audio API are used.

The world uses shared geometry/materials, merged static geometry and instanced ant bodies, legs and carried items. The surrounding districts are built once per visited theme and keep their geographic structure across graphics levels; detail visibility depends on camera distance and effective quality. Animals and light effects are bounded; no new entity is spawned on every poll. Native geometric assets and the SVG atlas keep the project self-contained and avoid remote texture/font requests. Rendering still requires WebGL; if it is unavailable, the normal work panels and bottom navigation remain usable with a readable scene error.

Graphics default to **Automatic**, starting conservatively before adapting to measured performance. Sustained frame timing can lower or raise the effective tier, with a cooldown to avoid repeated switching; quiet mode does not benchmark its intentionally sparse rendering. Adaptation uses observed performance rather than a device model or user-agent lookup. The atlas reports the current tier and provides fixed Light, Balanced and Detailed choices with a hover/focus/tap explanation. Resolution is constrained both by device-pixel-ratio and total pixel count:

| Tier | Maximum pixel ratio | Maximum render pixels | Shadows |
| --- | --- | --- | --- |
| Light | 1 | 1.1 million | Off |
| Balanced | 1.5 | 2.4 million | 1024 |
| Detailed | 2 | 4 million | 2048 |

These limits reduce graphics load without changing task execution, context, available places or work tools. They do not promise a particular frame rate on every device.

## Code map and verification

- `dist/world.js`: environment, office, lighting, camera, click targets, collaboration paths and resource lifecycle.
- `dist/world-expanse.js`: outer terrain, themed destinations, surrounding districts and distance-based detail.
- `dist/world-quality.js`: graphics tiers, pixel budget and adaptation from sustained frame samples.
- `dist/exploration.js` and `dist/exploration.css`: local vector atlas, landmark navigation, graphics preference and help.
- `dist/wildlife.js`: themed animals and error encounter state machine.
- `dist/experience-state.js`: local-time resolution, activity semantics and scope identities.
- `dist/experience.js`: panels, fullscreen, help, scope badges and browser preferences.
- `dist/studio.css`: day/night interface, overlays and responsive styles.
- `test/experience-state.test.mjs`: time boundaries, calm review states, genuine collaborations, stable failure keys and bounded activity.

The exported `getStudioDiagnostics()` in `dist/app.js` reports visual state and render counters for browser verification. It exposes no credentials or conversation text. Browser verification should cover all four themes in both modes, keyboard/touch help, work-panel restoration after fullscreen, quiet mode, two-agent collaboration, one complete anthill encounter, and narrow-screen overflow. Regression checks should still exercise project creation, task review and scoped memory because those same panels are now usable inside the scene.
