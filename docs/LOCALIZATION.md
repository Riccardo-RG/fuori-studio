# Interface languages

Fuori Studio supports Italian and English. Use the language selector in the top bar, or on the sign-in screen before opening the studio.

The preference is saved in this browser's local storage under `fuori-studio-language`. A new browser initially follows an English browser locale; other locales fall back to Italian. An explicit choice takes priority. Browsers with unavailable storage retain the choice for the current page. Open tabs on the same origin receive preference changes through the storage event. This preference is independent of authentication, AI credentials, memory synchronization and the archive.

Switching does not reload the page, start an AI call or replace saved records. Existing conversations, uploaded documents, project/scope names, memory notes, generated deliverables and code remain in their original language. Dates use the chosen interface locale. Protocol enums and record identifiers remain unchanged. AI instructions for chat, tasks and research follow the user's message or brief language, unless the user explicitly asks for another language; selecting a UI language does not translate historical responses or guarantee a model's output language.

## Implementation

`dist/i18n.js` owns locale selection, format locale, catalog lookup and UI update callbacks. English catalogs live in `dist/locales/`; Italian application copy is the source key. No translation service, runtime network request or extra package is required.

- `t(source, params)` is for **application-owned copy**. Parameters use named braces (`{count}`, `{name}`); the function returns plain text. Escape this result before inserting it into HTML if its parameters contain user data.
- `ui\`<p>Text ${escapedValue}</p>\`` translates literal text and accessible attributes before substituting opaque expressions. Placeholders in a catalog key are numbered within each text/attribute segment. Existing escaping remains mandatory. The helper does not inspect or translate the values supplied by records or API responses.
- `bindText(element, source, params)` updates a text binding when the language changes.
- `bindTranslations(root)` is restricted to immutable application shell markup **before user content is added**. It records explicit text/attribute bindings, rather than watching arbitrary DOM content for words to translate.
- `onLanguageChange(callback)` refreshes application-owned views. Callbacks are synchronous and must not start mutations or model calls. The locale runtime preserves draft controls, open disclosure state and focus; file controls retain their original DOM node and file selection.
- Keep internal status maps as stable source keys and translate only at the rendering boundary. Never translate form values, machine enums, selectors, API paths or state comparisons.

When adding a language, add a complete catalog and the supported locale/selector entry, then run catalog placeholder tests and browser checks for both initial load and a live switch. Missing keys deliberately fall back to the source string. Catalogs must preserve all interpolation parameters.

## Diagnostic boundary

UI instructions, controls, help, empty states and client validation are localized. Raw provider errors, operating-system messages, imported material, historical activity records and some server diagnostic details retain their original language. Do not translate these by fuzzy matching or send them to an external translation service. New server diagnostics should expose stable codes and parameters before adding localized client renderers.

## Validation

`test/i18n.test.mjs` covers locale resolution, unsupported values, parameter integrity, safe substitution and the boundary between UI copy and archive content. The browser smoke test checks Italian/English switching, preference persistence, drafts, unchanged user content, representative panels, mobile layout and pre-login access. See `VALIDATION.md` for the recorded execution results.

## Team display names

Click a teammate in the scene or team cards to edit their display name. Names are shared by all browsers accessing the same studio and are stored in the encrypted `team-profiles` archive record. The change applies to the five existing identities, including the coordinator; their IDs, roles, provider assignments, memory permissions and task history do not change. Each name must be unique and use 1–60 characters without control characters. Changes wait until active AI work finishes or is paused.

The owner-only `/api/team` endpoint uses the existing authentication and CSRF protections. Updates require the version shown when the editor opened, so concurrent changes cannot silently overwrite each other. Browser tabs receive a refresh signal containing no name data; they reload authorized names from the studio. Historical message/deliverable text remains verbatim, while interface author labels use the current display name. Backups include these preferences; selective memory synchronization and memory exports do not copy them to a different installation.
