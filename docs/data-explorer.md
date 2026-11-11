# Data explorer — implementation and operator guide

Implemented 2026-10-29 against specifications 11–13. The explorer searches one saved collection at a time, displays original records and reports, and exports all matching records. It does not contact agency websites or resolve credentials.

## Use it

With Node 24, run `npm run build` and `npm run ui`. Open `http://127.0.0.1:4317`, then choose **Data explorer**, select a collection and click **Prepare data**. The **Explore data** button in collection details opens the same workflow. Use `npm run ui -- --output ./runs/verification` to browse only the existing verification collections.

1. Choose Wells, Construction & permits, Observations, or Reports. Search an address, parcel, well/file ID, name or title. Words use literal, case-insensitive AND matching; PDF contents and arbitrary source fields are not searched.
2. Use **Filters** for typed identifiers, source/dataset, published status/use, quality flags, date meaning/range, known or unknown depth, and report availability. Apply the form with Search, Apply filters, or Enter. Changing type clears incompatible filters. Counts describe source records, which may overlap across agencies.
3. Open a record for original source fields, preserved values, field mappings, provenance, coverage and explicit relationships. Missing or ambiguous relationship targets remain unavailable. Shared addresses do not create inferred links.
4. Open downloaded PDF, PNG or JPEG reports locally. The browser's PDF viewer supplies page navigation and zoom. Use Open in a new tab or Download original if inline viewing is unavailable. TIFF uses download fallback. Metadata-only reports stay searchable.
5. **Export results** writes every matching row of the chosen type across all pages. Choose CSV, JSON or JSONL. Download the data and its companion manifest from Filtered exports. Original collection exports and report files remain unchanged.

URL hash state preserves the collection, snapshot, filters, record, sorting and pagination. These are local navigation links, not published share links. Export manifests contain the query and public source data; review them before sharing.

## Snapshots, jobs and recovery

Only inactive attempts with a finalized manifest can prepare a snapshot. Partial, cancelled, failed, unsupported and empty finalized collections remain browsable with their actual outcomes. A running or interrupted collection must finish or be recovered before its next snapshot is prepared.

Search results are immutable. Resuming collection does not alter an open snapshot or a filtered export. A stale-attempt notice explains this; **Refresh data** prepares the new finalized revision and opens it when ready. A build is discarded if the attempt changes while it is being captured.

Closing the browser does not stop an index or export. **Stopping the dashboard server interrupts explorer jobs**, which can be retried after restarting it. Completed snapshots and exports survive restart. Collection workers retain their existing detached behavior and continue until Stop safely or their budget ends.

Use **Cancel** for an active derived operation. A cancelled/failed export has Retry. **Clear this search cache** removes only a derived snapshot and returns to collection selection. Delete its completed derived exports first; active readers and exports prevent deletion. A link to a removed snapshot shows an explicit missing-snapshot error. For a corrupt cache, clear it and prepare the collection again. A mapping-version change requires a new compatible snapshot.

Derived files live under the selected output root:

| Path | Purpose |
| --- | --- |
| `.dashboard/snapshots/<uuid>/index.sqlite` | Separate search schema and preserved entity payloads |
| `.dashboard/snapshots/<uuid>/snapshot.json` | Captured attempt, outcome, coverage, mapping version, counts and digest |
| `.dashboard/explorer-jobs/<uuid>.json` | Persisted index/export status, progress, timestamps, inputs and errors |
| `.dashboard/exports/<uuid>/records.<format>` | Complete filtered export |
| `.dashboard/exports/<uuid>/manifest.json` | Scope, normalized query, snapshot, row count, bytes and SHA-256 |
| `.dashboard/explorer-leases/` | Temporary reader pins protecting cache cleanup |

Temporary directories end in `.tmp` and are not downloadable. Cancellation and write errors remove them; dead-worker recovery discards abandoned temporary output. Jobs are bounded to one index and one export per output root. Queries have two worker slots per server and a 15-second deadline; saturation returns an actionable retry error. Index/export writes check for at least 100 MiB of free space. Keep a single dashboard server per output root for normal use.

## Implementation choices

The source collection schema is unchanged. Version 1 of the disposable search database contains records, original payloads, typed identifiers, date intervals, flags and resolved/unresolved links. `project.ts` documents derived values and their source paths. `query.ts` supplies the same parameterized predicate and deterministic ordering to list/count/export operations. Missing sort values appear last. Cursors are bound to the query and snapshot.

Compared with the proposed file layout, `thread.ts` handles all worker operations, `service.ts` handles admission/lifecycle, and `routes.ts` contains the report and HTTP contracts. Jobs use Node worker threads attached to the dashboard process, not detached explorer processes. SQLite work and serialization run outside the HTTP event loop. The collector's existing CSV field list and escaping functions are reused without changing their output contract.

Snapshot directories use UUIDs under a shared cache root, with collection identity in metadata. Related records use bounded 50-row offset pages because the generation is immutable. Result pages use keyset cursors. Original nested fields are fetched with the selected record and expanded on demand in the UI. Filter controls select one value per category; the API also accepts bounded arrays. Durable job records provide operation status and timestamps; this release does not create a separate append-only explorer event stream.

The report endpoint accepts a snapshot/document identity, never a client file path or remote URL. It verifies an approved content-addressed path, real path containment, regular-file type, size, signature/extension and SHA-256 before streaming. Verification is cached against file identity, size and modification/change times. HEAD and single byte ranges are supported; invalid ranges return 416. TIFF is attachment-only. Existing loopback, origin, token and CSP controls remain in force.

Additional implemented routes are `DELETE /api/explorer/:snapshot` and `DELETE /api/explorer/exports/:export`. Related pages use `GET /api/explorer/:snapshot/links?kind=…&id=…&offset=…`; export history uses `?snapshot=…&offset=…`. The query schema is in `src/explorer/types.ts`.

## Verification evidence

The focused contract suite contains ten tests covering mappings, date precision, literal/typed searches, unit handling, stable pagination, immutable payloads, export parity/serialization, worker lifecycle and bounds, cleanup pins, changed-attempt races, failed publication, corrupt cache rebuilding, explicit/unresolved relationships, empty outcomes and report HTTP/security behavior.

The Chromium journey covers preparation, search via keyboard, 25-row pagination, reload/deep links, detail/back navigation, all-page JSON download, linked native PDF viewing, actual PNG/JPEG decoding, metadata-only reports, empty results, browser Back, snapshot refresh, dialog focus restoration and the 390-pixel layout. PDF rendering uses full Chromium; its headless shell does not include the native PDF viewer. Browser tests assert no agency HTTP requests. Original collection lifecycle and browser fixtures also pass.

Final checks: build, lint and formatting pass; the full offline suite passes 62 tests, with four browser tests skipped there and passed separately (two collector tests, one dashboard journey and one explorer journey). The focused ten-test explorer suite also passes after the final dead-worker cleanup change. The dashboard's startup read path now waits for SQLite schema publication, fixing the race found during regression testing. No collector schema migration was introduced. Vite emits the existing third-party Lucide `use client` directive warnings; the production bundle builds successfully.

| Spec scenarios | Evidence |
| --- | --- |
| EX-01–02 | Original database/manifest hash checks; finalized partial/cancelled/unsupported/empty fixtures; ten existing collection snapshots |
| EX-03–08 | Projection and query fixtures; leading-zero and typed multi-value identifiers; literal punctuation; units, zero/null, date intervals/timezones; source audit below |
| EX-09–10 | Both sort directions with missing/duplicate values and cursor rejection; browser pagination, reload, navigation, cleared loading rows and refresh |
| EX-11–12 | Preserved payload/detail tests; 58 related references across two pages; unresolved/ambiguous targets; no inferred Hyland/ambient links |
| EX-13–15 | Report-state, missing/changed file, signature, traversal, encoded path, symlink, HEAD/range, origin and token fixtures; native PDF and PNG/JPEG previews |
| EX-16–18 | All-row exports and count/order checks, all formats, all entity types, empty output, CLI CSV escaping, original JSON, manifest hash/scope |
| EX-19–21 | Cancel/retry/server-close interruption, injected ENOSPC after writing starts, attempt-change rejection, preserved old generations, incompatible/corrupt cache handling |
| EX-22–25 | Schema limits and cursor validation, worker saturation, reader/export cleanup pins, keyboard/mobile browser journey, local-only requests, collector regression suite |

The ENOSPC check injects the filesystem failure during a streaming export; it does not fill the development machine's disk. Automated keyboard checks cover key actions and focus restoration, not a complete screen-reader audit. Query deadline handling exists but the suite does not intentionally wait 15 seconds to trigger it. Browser coverage is Chromium on macOS; other browsers retain open/download fallbacks.

### Performance

Measured on an Apple M1 Pro with Node v24.21.0 using 100,000 synthetic wells plus linked fixture records. Fresh snapshot, repeated warm query mix, worker startup included. The 35 queries include broad/empty text, identifiers, source, depth, title sorting and a construction-date query. The small construction-date fixture is not a 100,000-date-record benchmark.

| Measurement | Result | Target |
| --- | ---: | ---: |
| Snapshot build | 5.94 s | ≤60 s |
| Page + exact count p95 | 323 ms | ≤750 ms |
| Detail + linked page p95 | 263 ms | ≤500 ms |
| 100,000-row JSONL export | 1.86 s | ≤60 s |
| Dashboard status maximum, 214 requests during jobs | 159 ms | ≤1,000 ms |
| Aggregate process/worker peak RSS | 189 MiB | <1 GiB |
| Derived snapshot size | 309 MiB | Reported, no fixed target |

The status benchmark uses the real Fastify routes through in-process HTTP injection; it excludes TCP/browser latency. Collector stop/resume is verified separately by the lifecycle suite. This fixture does not establish unlimited scale or performance for huge single-record payloads or giant PDFs.

### Existing collection audit

All ten collections under `runs/verification` were captured or reopened without changing their original `state.sqlite` or `manifest.json` hashes. No new scrape ran. Representative counts:

| Saved collection | Records | Mapping/link observations |
| --- | --- | --- |
| Mecklenburg inventory | 25,936 wells; 5,477 construction; 14,004 observations | 11,756 well addresses and 5,176 permit addresses; 14,004 verified observation links; undocumented depths remain unfilterable |
| USGS Mecklenburg | 322 wells; 13,677 observations | 308 comparable well depths; 13,677 explicit links and observation dates |
| NC DEQ metadata sample | 3,699 construction; 3,699 reports | 3,202 addresses in each type; 3,699 explicit report links |
| Hyland cancelled metadata sample | 3,006 reports | 2,905 addresses; no invented well links or document-date mapping |
| NC ambient | 3 wells; 165 observations | 165 observation dates; no unverified station-to-well links |
| NC DEQ downloaded sample | 2 construction; 2 reports | Both linked; a real saved PDF opened in Chromium |

Additional audited runs include a failed empty collection, two small Hyland report samples and five Wake County USGS wells. These are source-record counts, not deduplicated physical wells or proof of source completeness.

## Commands and scope

```sh
npm run build
npm run lint
npm run format:check
npm test
npm run test:browser
npm run test:ui
npm run test:explorer
npm run test:explorer-ui
npm run test:explorer-scale
```

Screenshots are generated under ignored `test-results/explorer/`: `search.png`, `detail.png`, `report.png`, `mobile.png` and `mobile-filters.png`. Local verification also produced `real-inventory.png` and `real-report.png`; those may contain public record information and are not committed fixtures.

Maps, OCR/PDF text search, cross-collection comparison/deduplication, schedules, new county adapters, report ZIP bundles, remote hosting and record editing remain outside this milestone. Existing source coverage limitations still apply.
