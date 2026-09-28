# Sources and research

Sources provide inspectable evidence for an agent's answer. They do not become confirmed memories, workflow rules, or verified facts automatically. A document may be wrong, outdated, or contain instructions intended to manipulate an AI; its content remains untrusted data.

The source service is implemented in strict TypeScript in `lib/sources.ts`, using Node 24's native type stripping. The application type-checks it with `npm run typecheck`. PDF extraction uses the pinned Mozilla `pdfjs-dist` package in a disposable worker.

## Supported inputs

| Input | What is read | Refresh |
| --- | --- | --- |
| Pasted text | Text and Markdown with line references | Import a new document |
| Uploaded document | UTF-8 text, Markdown, HTML, JSON, or text-bearing PDF | Import a new document |
| Public HTTPS URL | One static document; up to three redirects | Explicit refresh |
| Public GitHub repository | Public repository metadata | Explicit refresh |
| Public GitHub issue | Issue title, body, state, and update date | Explicit refresh |
| Authorized GitHub file | One selected UTF-8 file, pinned to its resolved commit and verified blob | Explicit refresh with current connection permission |
| Authorized local folder | Supported text files under an explicitly allowed root | Explicit refresh of each imported file |
| AI web research | A requested search answer with provider-supplied citations | A new explicit search |

There is no automatic site crawler, authenticated browser, issue-comment import, OCR, or synchronization with a document provider. Importing a public GitHub repository URL does not import its code or README. For a private file, configure **Progetti → GitHub** and explicitly select the connection, repository, ref and path. Local folder import is a snapshot, not a file watcher.

PDF extraction preserves one-based page references. Other documents preserve one-based line ranges from the extracted text. HTML extraction removes scripts, styles, and markup; it does not render a browser or reproduce the page layout. Scanned PDFs without embedded text require OCR outside this feature.

Only extracted text and provenance are retained. Original PDF and upload bytes are not stored or offered as downloads.

## Isolation and retrieval

Every source belongs to exactly one workspace scope. Retrieval checks exact scope equality, including when the scope is named `shared`; source sharing is never inferred from the memory sharing policy. A source's ID, version, digest, title, URL, and page or line references accompany selected passages.

Retrieval uses bounded lexical matching over source titles and text. It selects up to eight passages and 12,000 characters by default. An empty query produces no passages. It does not send an entire archive or an unrelated scope to a provider, and it does not require a vector database or embedding API.

Public URLs, GitHub sources, and local files become stale seven days after reading. AI research becomes stale after one day. Stale documents remain viewable but are excluded from automatic context until refreshed. Uploaded and pasted documents are retained as explicit snapshots without an automatic expiry date.

Refresh creates a new source version. A request based on an older version fails with `VERSION_CONFLICT`. Deletion removes the live source and its passages; a refresh already in progress cannot restore a deleted source. Existing encrypted backups follow the application's backup retention policy and are not rewritten by source deletion.

## Network boundaries

URL reads are read-only HTTPS requests without cookies, authentication headers, provider credentials, proxy environment variables, or a browser session. The reader accepts port 443 only and refuses credentials embedded in URLs.

Before each request and redirect, all DNS answers must be globally routable. Loopback, private, link-local, multicast, documentation, reserved, IPv4-mapped IPv6, and transition ranges are rejected. The connection is pinned to a validated address while TLS validates the original hostname. A mixed public/private DNS answer is rejected. This prevents a second DNS lookup from redirecting a validated request into a private service.

The reader enforces a 15-second deadline over DNS, redirects, and response transfer; an 8 MiB response limit; supported content types; and at most three redirects. Compressed responses are rejected; the reader requests identity encoding. It never fetches embedded assets or follows links discovered inside a document.

Public GitHub imports use unauthenticated `api.github.com` requests. GitHub's public rate limits apply. They do not inherit the user's GitHub CLI login or OAuth credentials and cannot write to GitHub.

Authenticated GitHub file reads use a separate encrypted connection and fixed GitHub API endpoints. Every read checks the repository and scope allowlists, resolves an immutable commit, traverses ordinary tree entries and validates the blob's SHA-1 against its exact bytes. Files must be UTF-8, no larger than 1 MiB and within the source text limits; symlinks, submodules and sensitive paths are rejected. Metadata includes the repository, commit, blob SHA and path. The stored URL points to that commit, not the moving branch. Refresh requires the connection to remain authorized and creates a new version. Disconnecting blocks future reads; an intentionally imported snapshot is retained until removed or expired. Publication is a separate reviewed workflow, never an import side effect. See [GitHub](GITHUB.md).

## Local folder boundaries

Folder import is available only in local mode. The application supplies explicit allowed roots, such as a registered project repository. The source service defaults to no allowed roots. Remote online and hybrid endpoints cannot use folder import to browse a host filesystem.

The reader rejects symbolic links, files outside the selected authorized root, and sensitive or generated paths. Exclusions include `.env`, `.git`, `.local`, `.codex`, `.agents`, `.ssh`, `.aws`, `.npmrc`, credentials, private key files, databases, `node_modules`, build output, caches, and virtual environments. The import result lists skipped files and reasons without reading their contents.

One folder import is atomic and capped at 60 text files, 2 MiB total text, eight levels of nesting, and 2,000 inspected directory entries. Individual local files are capped at 512,000 bytes. Larger folders must be narrowed to a useful subdirectory. No file is installed, executed, modified, or removed by import or refresh.

## PDF limits

Uploads are limited to 8 MiB, extracted text to 600,000 characters, PDFs to 200 pages, and document segments to 1,000. PDF parsing runs in a worker with a 15-second deadline and a bounded JavaScript heap. Rendering, font loading, document actions, and JavaScript evaluation are disabled; the parser receives bytes rather than a network URL. Unsupported, encrypted, malformed, scanned, or oversized documents fail explicitly rather than producing a silently truncated source.

## AI research and cost

AI web research is separate from URL import. It requires an explicitly selected OpenAI API connection allowed for the active scope, an explicit query, and `consent: true` for each request. The provider's existing execution permissions and spending controls still apply. A local Codex login does not provide this paid API connection.

Only the submitted query and optional domain filters are sent through the research call. Research cannot silently ingest the rest of the studio archive. The result records provider citations and available usage information. A result without valid public HTTPS citations is rejected. Citations are attribution, not proof that every generated claim is correct.

There is no unofficial search-engine scraping or automatic free-search fallback. Sources referenced by research are not automatically fetched and imported as separate documents. Repeating a search requires another explicit request and may incur another charge.

## Persistence and service contract

`createSourceStore` requires the existing encrypted archive and a workspace service with `getSnapshot()`. Source records are stored under the archive key `sources`, with AES-256-GCM encryption supplied by the archive layer. The default capacity is 300 source records and 20 MiB of serialized source data. Source content is not stored in plaintext files or a second unencrypted index.

The service validates saved digests, versions, provenance, dates, citation URLs, and passage references when loading. A corrupted source archive fails closed.

| Method | Purpose |
| --- | --- |
| `snapshot({ scopeId })` | Scoped metadata, connector capabilities, and limits |
| `detail({ id, scopeId })` | Metadata, extracted segments, and citation sources |
| `importText(...)`, `importDocument(...)` | Store an explicit text or uploaded-document snapshot |
| `importUrl(...)`, `importFolder(...)` | Read an explicit supported URL or authorized folder |
| `importGitHub(...)` | Import an explicitly authorized file with immutable commit provenance |
| `refresh({ id, scopeId, version })` | Re-read a supported origin with optimistic concurrency |
| `remove({ id, scopeId, version })` | Remove live source content and retrieval eligibility |
| `retrieve({ scopeId, query, limit, maxChars })` | Return bounded current passages from exactly one scope |
| `searchWeb({ scopeId, connectionId, query, domains, consent })` | Run an explicitly authorized provider research request |
| `allMetadata()` | Internal metadata for context validation without workspace recursion |

Document details contain `{ source, segments, citationSources }`. Segments expose `text`, `page`, `lineStart`, and `lineEnd`. Local origin paths are private service metadata and are not exposed in ordinary source metadata responses.

The current device synchronization protocol does not replicate sources. Source text follows the studio archive's encrypted backup and restore lifecycle. Sharing sources across installations requires a future explicit source synchronization policy.

## Verification

`test/sources.test.mjs` covers exact-scope retrieval, empty queries, source versions, stale exclusion, deletion during refresh, malformed inputs, actual PDF page extraction, DNS pinning contracts, private and mapped addresses, redirect boundaries, deadlines, MIME and size limits, GitHub read-only URLs, local exclusions, research consent, encrypted persistence, and corruption rejection. Network tests use injected DNS and transport fixtures; they make no external HTTP or paid AI requests.
