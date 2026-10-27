# Present

A git-native presentation editor. Each deck is a real Git repository, with semantic history,
branching, and collaboration built into the editing workflow.

Each deck is a real Git repository on disk. Slides are isolated folders containing a
canonical JSON element AST, Markdown speaker notes, and co-located assets. The editor writes
files on an idle debounce, and Git commits are created on session boundaries or manual
checkpoints. Branches merge with a 3-way semantic JSON merge instead of line markers.

## What is implemented

- **Rust + Axum + git2 backend**
  - Deck repositories initialized with a pastel starter deck
  - Atomic file writes and recursively sorted canonical JSON
  - Sessions with a 15-minute inactivity watchdog and commit-on-close
  - Browser-persisted username demo identities, deck ownership, and branch-level roles
  - Object comments, live presence, remote cursors, and exclusive server-enforced edit locks
  - Branches, checkouts, commit history, manual checkpoints
  - Slide CRUD, ordering, notes, asset upload/serving
  - 3-way AST merge with property-level conflicts and resolution application
- **Rust workspace crates**
  - `present-domain` owns shared deck and slide models
  - `present-merge` owns three-way semantic merge behavior
  - `present-store` owns filesystem, Git, and session operations
  - `present-http-api` owns JSON and asset HTTP routes
  - `present-server` wires up the API process and lifecycle
- **SolidJS + Vite + Tailwind CSS editor**
  - Warm tan/cream surfaces with pastel accent theming
  - Fixed 1920×1080 letterboxed stage with `ResizeObserver` auto-fit
  - Drag, resize, rotate, text editing, layer ordering, duplicate/delete
  - Undo/redo, keyboard nudging, full-screen present mode
  - Scrollable version timeline with slide, image, and notes previews; restore any saved version while preserving current work in history
  - Virtualized-style thumbnail rail with live scaled slide previews and drag reordering
  - Inspector for position, typography, colors, opacity, and visible left/center/right text alignment
  - Markdown speaker-notes drawer
  - One Timeline workspace for branch switching, creation/deletion, version history, checkpoints, and merging
  - Visual merge inspector with side-by-side branch previews and per-property keep-mine/take-theirs
  - Sandboxed user-script runner with mutation patch API and watchdog termination
  - One Build workspace for agent drafts, scripting, and API reference, with drafts preserved between tabs
  - Signup/sign-in landing page without an in-app account switcher
  - First-slide deck previews, collaborator avatars, role labels, username invites, and revocable sharing links
- **Sandboxing**
  - User scripts run only in a dedicated Web Worker
  - Worker asset served with `default-src 'none'; connect-src 'none'`
  - Network primitives are additionally replaced at runtime
  - Main thread validates a request nonce and terminates runaway scripts
- **Deployment**
  - Vite builds static assets; Nginx serves them and proxies `/api` to Rust
  - Separate web and API Docker services; Rust does not serve frontend files
  - API runs with a non-root user and persistent `/data` volume
  - Health check and `SIGTERM` graceful session commit

The web theme styles the application chrome. Slide backgrounds and element colors are stored
in each deck’s JSON, so changing the web theme does not recolor existing slides.

Demo accounts are stored in `data/users.json` and deck ownership, collaborators, and comment
threads are stored under `data/collaboration/`. Sign-in uses a username without a password and the
browser remembers the selected account. The server enforces deck roles for the supplied account,
but a caller can impersonate usernames because this demo has no secure authentication. Use only on
a local or trusted network. Only the presentation creator can delete it; collaborators receive
view, comment, or edit access on explicitly assigned branches.

Use **Share** to create a link for a chosen branch with view, comment, or edit access. Recipients
sign in or create an account, then open the presentation on the invited branch; owners do not
need to add their usernames first. Owners can revoke links from the same dialog. Revocation
removes access granted by that link while preserving direct invitations and other active links.
The public invitation preview exposes the deck title, owner, branch, and role, without slide
contents. Link tokens and grants live outside Git history, so restoring a version cannot undo
revocation. Text alignment is available in the inspector and through Ctrl/Cmd+Shift+L, E, or R.

Collaboration uses Rust WebSockets without an external realtime service. Each editor keeps one
connection per editing session and branch. Object leases belong to sessions, so two tabs under the
same account cannot silently edit the same object. Remote pointers and username badges keep their
screen size as the canvas zooms, and participant markers follow collaborators between slides.

Drag and text previews are transient messages, coalesced to at most 20 updates per second. The
server accepts object previews only from the session holding the object's lease. Durable edits
still use the autosave HTTP endpoints: each write carries its previous slide so the server can
merge changes to different objects and reject overlapping stale edits without discarding the
local draft. Speaker notes use the same stale-write protection.

Successful writes notify other editors to refresh slides, notes, slide order, deck metadata,
comments, access settings, and history. A separate authenticated WebSocket refreshes deck libraries.
Reconnects and missed-event notifications trigger a fresh read and rebase pending local edits;
these reads do not become new edits or undo entries. Presence and previews live in server memory,
while saved files and Git history remain on disk. This provides object-level collaboration;
simultaneous character edits within one text object are governed by its exclusive lease.

Older demo decks do not have ownership metadata and are not migrated; recreate those decks under
the new account flow (or clear the Compose volume with the command below).

## Quick start

Prerequisites: Rust (with `libgit2` available), Bun or Node, and a C toolchain.

```bash
# terminal 1: run the API
cargo run -p present-server

# terminal 2: run the Vite client
cd web
bun install
bun run dev
```

Open <http://127.0.0.1:5173>. Vite proxies API requests to Rust on port 3000. Sign up with a
username, then create your first presentation from the home page.

### Hackathon demo runbook

For a local demo, start the API and web client in separate terminals using the development
commands above. Open <http://127.0.0.1:5173>, create a username, and choose **Create a
presentation**. The starter deck is a good guided path through editing, speaker notes, version
history, sharing, and PowerPoint export. Agent features need the optional `OPENAI_URL`,
`OPENAI_MODEL`, and `OPENAI_KEY` settings described below; the editor, templates, and exports do
not.

For a Docker demo, run `./present.sh` and open <http://localhost:3000>. Decks and demo profiles
persist in the `present-data` volume between runs. Use `./present.sh status` to check the services
and `./present.sh logs` to inspect startup errors. Avoid `docker compose down -v` unless you intend
to erase the demo data.

Before presenting from a new machine, run `cargo test --workspace`, `bun run build` from `web/`,
and `bun test` from `web/`, then verify signup, deck creation, editing, sharing, and export in the
browser.

### Docker

The multi-target `Dockerfile` builds the web client with Bun/Vite and serves it from Nginx. A
separate Rust API image handles deck operations. Deck repositories live in the `/data` volume.

```bash
# Build and start both containers in the background
./present.sh

# Follow logs / stop
./present.sh logs
./present.sh down
```

For a short Compose workflow, run the helper from the repository root (or use its full path):

```bash
./present.sh          # build if needed, then start
./present.sh rebuild  # force a fresh image build and recreate the container
./present.sh logs     # follow logs
./present.sh status   # show status
./present.sh down     # stop; deck data is preserved
```

The web container listens on port 80 and publishes it at `PRESENT_PORT` (default `3000`). The
API has a health check against `/api/health`. To use a host directory for deck data, replace
`present-data:/data` in `compose.yaml` with `./data:/data`
and make the host directory writable by UID/GID `10001`.

Compose uses `PRESENT_PORT` (default `3000`) for the published host port.

### Development mode

Run the API and Vite separately:

```bash
# terminal 1
PRESENT_DATA_DIR=./data cargo run -p present-server

# terminal 2
cd web
bun run dev
```

Vite runs on <http://127.0.0.1:5173> and proxies `/api` to port 3000.

### Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PRESENT_DATA_DIR` | `./data` | Root for deck repositories and `users.json` |
| `PRESENT_ADDR` | `127.0.0.1:3000` | Listen address |
| `RUST_LOG` | `present_server=info,present_http_api=info,present_store=info` | Tracing filter |
| `OPENAI_URL` | Required for the agent | OpenAI-compatible provider base URL (including `/v1` when required), or full `/chat/completions` endpoint |
| `OPENAI_MODEL` | Required for the agent | Model name sent to the configured provider |
| `OPENAI_KEY` | Required for the agent | Provider API key; `OPENAI_API_KEY` is also accepted |

The API loads `.local.env` from the repository root during local development. Existing process
environment variables take precedence. Compose passes `.local.env` to the API container.
For example:

```dotenv
OPENAI_URL=https://your-provider.example/v1
OPENAI_MODEL=your-provider-model
OPENAI_KEY=your-api-key
```

The agent uses the provider's OpenAI-compatible Chat Completions interface. It appends
`/chat/completions` to a base URL, or uses a full Chat Completions URL directly, preserving
query parameters. The API key stays on the backend. Restart the API after changing these settings.

## Repository format

```text
data/decks/<deck-id>/
├── .git/
├── deck.json
└── slides/
    ├── s_01_title/
    │   ├── slide.json
    │   ├── notes.md
    │   └── assets/
    └── s_02_repository/
        ├── slide.json
        ├── notes.md
        └── assets/
```

`slide.json` uses a flat `elements: { [id]: node }` map. Every write is passed through a
recursive key sorter and written via a temporary file + atomic rename.

Coordinates are always authored in the fixed **1920 × 1080** space. The stage computes:

```text
scale = min((containerW - 2*pad) / 1920, (containerH - 2*pad) / 1080)
```

## API overview

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/users` | List demo usernames |
| `POST` | `/api/users` | Create a username account |
| `POST` | `/api/users/sign-in` | Sign into an existing username account |
| `GET` | `/api/decks` | List decks |
| `POST` | `/api/decks` | Create a deck repository |
| `GET` | `/api/decks/{deck}` | Deck manifest, slide summaries, branches |
| `PATCH` | `/api/decks/{deck}` | Rename deck / update tokens |
| `DELETE` | `/api/decks/{deck}` | Delete the repository |
| `GET` | `/api/decks/{deck}/slides/{slide}` | Slide + notes + assets |
| `PUT` | `/api/decks/{deck}/slides/{slide}` | Atomic slide write |
| `PUT` | `/api/decks/{deck}/slides/{slide}/notes` | Write notes |
| `POST` | `/api/decks/{deck}/slides` | Create slide |
| `DELETE` | `/api/decks/{deck}/slides/{slide}` | Delete slide |
| `PUT` | `/api/decks/{deck}/order` | Reorder slides |
| `POST` | `/api/decks/{deck}/sessions` | Open editing session |
| `POST` | `/api/sessions/{id}/commit` | Commit session |
| `POST` | `/api/sessions/{id}/close` | Commit + close session |
| `POST` | `/api/decks/{deck}/checkpoint` | Manual commit |
| `GET` | `/api/decks/{deck}/commits` | History |
| `GET/POST` | `/api/decks/{deck}/branches` | List/create branches |
| `POST` | `/api/decks/{deck}/checkout` | Commit then switch branch |
| `GET` | `/api/decks/{deck}/merge/preview?source=...` | 3-way merge preview |
| `POST` | `/api/decks/{deck}/merge/apply` | Apply merge with resolutions |
| `POST` | `/api/decks/{deck}/slides/{slide}/assets` | Multipart asset upload |
| `GET` | `/api/decks/{deck}/slides/{slide}/assets/{name}` | Asset bytes |
| `GET/POST` | `/api/decks/{deck}/collaboration` and `/members` | Read access and invite a user by username |
| `GET/POST` | `/api/decks/{deck}/collaboration/links` | Owner-only sharing link list/creation |
| `DELETE` | `/api/decks/{deck}/collaboration/links/{link}` | Revoke a sharing link and its access grants |
| `GET` | `/api/share/{deck}/{token}` | Public invitation metadata preview |
| `POST` | `/api/share/{deck}/{token}/join` | Join the invited branch using the signed-in account |
| `GET/POST` | `/api/decks/{deck}/comments` | Read or add object-anchored comments and replies |
| `PUT/DELETE` | `/api/decks/{deck}/comments/{comment}` | Edit/delete a comment you authored |
| `POST` | `/api/decks/{deck}/locks` | Acquire or release object edit locks |
| `WS` | `/api/decks/{deck}/presence` | Rust-managed active-slide and cursor state, with lock snapshots |

Image uploads allow files up to 100 MiB.

Deck API routes require the selected profile ID in `X-Present-User`; image URLs carry their branch
and demo profile because `<img>` requests cannot set custom headers. Role checks run in the server.
The username-only demo identity is still spoofable and must not be treated as production security.
Object locks expire after 15 seconds without a refresh and are also released when the editor
connection closes.

To clear all Docker data, run `docker compose down -v` from the repository root. This removes the
`present-data` volume, including presentations and profiles. `./present.sh down` stops the
containers but keeps that volume.

## Semantic merge

The merge driver loads the merge-base, ours, and theirs snapshots and recursively merges
JSON values:

1. If `ours == theirs`, take it.
2. If `base == ours`, take theirs (only theirs changed).
3. If `base == theirs`, take ours (only ours changed).
4. If all values are objects, merge keys recursively. This makes orthogonal edits such as
   `fontSize` on one branch and `x`/`y` on another merge cleanly.
5. Otherwise record a conflict at that JSON path and fall back to ours. The UI can choose
   `theirs` per conflict; the backend replays the merge with those choices before writing a
   merge commit with both branch heads as parents.

Conflict paths look like `elements/el_title/text` or `elements/el_card/x`; the UI also renders
the full ours/theirs slide side by side. Opening the merge dialog flushes and commits any
pending edits first, so the preview always reflects the latest working-tree state.

## User scripting API

Scripts run in `src/worker/scriptWorker.ts` with this surface:

```js
api.selection            // string[] of selected element ids
api.getSlide()           // cloned current slide
api.getElement(id)
api.updateElement(id, patch)
api.setText(id, text)
api.addElement(element)
api.removeElement(id)
api.patchSlide(patch)
api.styleSelection({ ...style })
api.log(...args)
```

The worker returns the complete modified slide plus a patch log. A main-thread watchdog
terminates the worker after the selected timeout (default 2000 ms). The worker response is
served with `connect-src 'none'`, and `fetch`/XHR/WebSocket/EventSource/importScripts are
replaced with throwing stubs inside the worker.

## Notes and current scope

This is intentionally a basic implementation. Notable simplifications:

- Thumbnails are scaled live DOM rather than cached WebP canvas snapshots.
- Merge conflicts are resolved per property with keep-mine/take-theirs; there is no freeform
  merged-value editor.
- Resize math is exact for unrotated elements and approximate for rotated elements.
- Sign-in is a username-only demo flow, not production authentication.
- A merge targets the currently checked-out branch.
