# Present

A basic, working implementation of the git-native presentation platform described in
[`PLAN.md`](./PLAN.md).

Each deck is a real Git repository on disk. Slides are isolated folders containing a
canonical JSON element AST, Markdown speaker notes, and co-located assets. The editor writes
files on an idle debounce, and Git commits are created on session boundaries or manual
checkpoints. Branches merge with a 3-way semantic JSON merge instead of line markers.

## What is implemented

- **Rust + Axum + git2 backend**
  - Deck repositories initialized with a pastel starter deck
  - Atomic file writes and recursively sorted canonical JSON
  - Sessions with a 15-minute inactivity watchdog and commit-on-close
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
  - Virtualized-style thumbnail rail with live scaled slide previews and drag reordering
  - Inspector for position, typography, colors, opacity
  - Markdown speaker-notes drawer
  - Branch switching/creation, commit history, checkpoint button
  - Visual merge inspector with side-by-side branch previews and per-property keep-mine/take-theirs
  - Sandboxed user-script runner with mutation patch API and watchdog termination
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

Open <http://127.0.0.1:5173>. Vite proxies API requests to Rust on port 3000. A demo deck
named **Welcome to Present** is seeded on first run.

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
API seeds the demo deck (`PRESENT_SEED=1`) and has a health check against `/api/health`. To use a
host directory for deck data, replace `present-data:/data` in `compose.yaml` with `./data:/data`
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
| `PRESENT_DATA_DIR` | `./data` | Root for deck repositories (`data/decks/<id>`) |
| `PRESENT_ADDR` | `127.0.0.1:3000` | Listen address |
| `PRESENT_SEED` | `1` | Set to `0` to skip demo-deck seeding |
| `RUST_LOG` | `present_server=info,present_http_api=info,present_store=info` | Tracing filter |

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

Image uploads allow files up to 100 MiB.

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
- No multi-select, grouping, comments, presence, or server-side auth.
- A merge targets the currently checked-out branch.
