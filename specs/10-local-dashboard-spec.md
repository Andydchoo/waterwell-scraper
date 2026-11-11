# Local dashboard: implemented first milestone

## Purpose and scope

Provide a local browser interface over the existing collector. An operator can select a state and county, inspect real source coverage, start a bounded collection, follow progress, stop safely, resume saved work, and retrieve the resulting data and log. Initial location: Mecklenburg County, North Carolina. County selection is nationwide; source availability remains governed by the existing registry.

The CLI remains supported. The UI reuses the same source adapters, SQLite checkpoint, credential resolver, export contracts and finalization code. It does not claim a complete national private-well inventory.

## Architecture

- Node 24 and Fastify serve a React/TypeScript client built with Vite.
- `src/dashboard/server.ts` provides a loopback-only HTTP API and built static assets.
- `src/dashboard/runs.ts` discovers runs and reads SQLite in read-only mode. It never constructs a writable `Store` for dashboard queries.
- `src/dashboard/jobs.ts` validates launch/resume, takes a short admission lock, writes private job metadata and starts a detached worker.
- `src/dashboard/worker.ts` owns collection execution and heartbeat state independently of the HTTP server or browser.
- `src/core/runner.ts` supports a predetermined run ID, external cancellation signal and unattended execution. Source behavior remains in existing adapters.
- `web/src` contains the interface; `dist/ui` contains build output. No cloud service or remote deployment is required.

## Operator views

1. **Overview:** total saved collections, active runs, well source records, indexed reports and recent history. Totals can include overlapping records across runs and sources.
2. **New collection:** state and county selectors from the bundled geography catalog; registry source options, limitations and explicit unsupported candidates; reports or metadata only; duration, bytes and record limits; optional local credential profile name.
3. **History:** search county/state/run ID, filter active or attention-needed runs, open details. Discover current and previous CLI runs under the selected output root, with directory traversal bounded to depth three and without following directory symlinks.
4. **Details:** run outcome, attempt number, saved entity counts, current/last attempt transfer counters, per-source accepted/expected/remaining counts and completeness, recent events, export/report downloads, stop or resume when eligible.

The overview/history refresh approximately every 2.5 seconds; selected run details every 2 seconds. Transfer counters are checkpointed every 5 seconds. Source totals without a published count display as unknown, never as a fabricated percentage. The activity view shows up to 60 recent events from a bounded 64 KiB tail; the full log remains downloadable.

## Job lifecycle and durability

`starting → running → stopping → finished`, with `failed` for execution errors. The collector's outcome (success, partial, cancelled, unsupported, blocked, needs authentication or failure) is displayed after completion. An abandoned running checkpoint is displayed as interrupted.

- Dashboard launches are serialized per output root. A run already active in that root blocks another dashboard launch. Separate output roots and independently launched CLI runs are not a global queue.
- Admission and worker locks supplement the existing per-run writer lock.
- Job records contain a random nonce, run ID, configuration, timestamps, worker PID and state; writes use private atomic replacement.
- Stop writes a request bearing the current nonce. The worker reads it on its heartbeat and aborts its own runner. The server never sends a signal to a PID supplied by the browser.
- Restarting the dashboard or closing the page does not kill workers. A stale worker/lock is recoverable through the collector's existing resume path; the same run ID, configuration and committed task ledger are reused.
- Resume retains attachment/source/budget scope from the original configuration. It increments the attempt and skips completed work under existing adapter contracts. Compatibility checks remain authoritative; incompatible adapters/schema require a new run.
- Dashboard execution disables interactive authentication and headful browser operation even when resuming a CLI run saved with those options.
- Finalization continues to produce summaries, event logs, manifests, structured exports and attempt history. Active attempts cannot download exports while files are being republished.

## API contract

| Method and path | Behavior |
| --- | --- |
| `GET /api/bootstrap` | Dashboard session token, geography catalog, version and local output root |
| `GET /api/sources?state=…&county=…` | Resolve geography and return registered source manifests; no remote source requests |
| `GET /api/runs` | History metadata, counts and available actions; omit collector configuration |
| `GET /api/runs/:id` | Details, source results, bounded event tail and artifact listing |
| `POST /api/runs` | Validate selected scope/limits and return `202` with run identifier |
| `POST /api/runs/:id/stop` | Write nonce-bound stop request; `202` acknowledges request, not completion |
| `POST /api/runs/:id/resume` | Launch saved configuration in a new attempt; return `202` |
| `GET /api/runs/:id/download?file=…` | Serve an approved finalized export/log/report as an attachment |

API identifiers are hashes of paths relative to the output root; clients cannot submit filesystem paths as run IDs. Invalid inputs use 400, unknown runs/exports 404, active-run conflicts 409, local-origin/token failures 403, and unexpected errors a generic 500 response.

## Local access and credentials

- Bind `127.0.0.1`; accept only localhost/127.0.0.1 Host values. Reject cross-site fetches and mismatched Origin headers. Mutations require an unpredictable per-server session token supplied by bootstrap and retained in browser memory. A server restart requires a page refresh.
- Serve client assets with a self-only content security policy, no framing, no-store caching and no MIME sniffing. Render source fields/errors as text.
- Accept only explicitly supported collection inputs. Output root is chosen when starting the server, never from a browser request.
- Downloads must be allowed filenames listed by the finalized manifest or fixed public logs/summaries. Resolve real paths inside the run directory to reject traversal and escaping symlinks. Never expose state databases, job records, raw paths or credential files through the download endpoint.
- Reuse the bounded local credential resolver. Browser input accepts a profile name only; no password form, recursive home-directory search, existing personal browser profile access, or credential payload in the API.
- This is a local, single-user interface. Public hosting, multi-user authorization and TLS termination are not supported by this milestone.

## Acceptance evidence

Automated backend tests cover local-origin/token enforcement, strict launch input, read-only ledger counts, unknown totals, finalized downloads, traversal and symlink rejection, concurrent launch rejection, stale nonce rejection, API restart survival, stop/resume without duplicate fixture rows, interrupted-state recovery eligibility, production worker finalization and externally cancelled runner finalization.

The opt-in Chromium test covers nationwide/pilot county selection, displayed coverage gaps, starting with form limits, background survival after closing the page, activity, stop/resume, CSV download contents, history search, mobile width constraints and absence of JavaScript page errors. It uses a controlled local worker and no live agency requests. The production worker is separately tested against the explicitly unsupported registry candidate, which requires no network access.

Run `npm run build`, `npm run lint`, `npm run format:check`, `npm test`, `npm run test:browser`, and `npm run test:ui`. Browser screenshots are written to ignored `test-results/dashboard/` for visual review.

## Deferred milestones

Searchable record explorer, map, saved collection presets, scheduled runs, automatic retries across attempts, multi-job queue, credential connection screen, report bundles, OCR and public hosting are outside this milestone. This UI does not expand the underlying sources' declared data coverage.
