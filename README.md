# Water well scraper

A local Node.js/TypeScript CLI, web dashboard and data API for collecting public water-well records, original source fields, and available report files for **any US state and county**.

Nothing about a particular county is built in. The only reference data shipped with the app is the list of states and counties. For the place you choose, every collection runs **three acquisition approaches** and keeps what each one finds, duplicates included:

| Approach           | What it does                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Public API         | Queries the USGS groundwater API by county FIPS, and discovers public GIS well layers for the county in the ArcGIS catalog and queries them.                                                                                                                                                                                                     |
| Browser navigation | Chromium starts from the public catalog site, from the county's and state agencies' official websites (looked up in the .gov registry and Wikidata), and from any pages you supply. It follows each site's sitemap and department links under its robots.txt, and collects the map layers, tables, files and document archives the pages expose. |
| File downloads     | Downloads Water Quality Portal files for the county, published catalog files, and bulk layer exports.                                                                                                                                                                                                                                            |

See [how the application acquires data](docs/how-it-works.md) for the step-by-step flow. Collection is resumable; every run is filed under its collection day and writes CSV, JSONL, a SQLite checkpoint, and a readable collection log.

Coverage depends on what publishers list publicly for a county. A collection log always states what was found, what was left out and what could not be reached.

## Install

Node **24.x** is required; Node 17/18 will not work. Run from the project root:

```sh
nvm use                    # or install Node 24 with your preferred manager
npm ci
npm run browsers:install
npm run build
```

The browser installer uses the project-local `.well-scraper/browsers` directory. macOS/Linux are the supported targets; Windows credential ACL validation is not implemented. SQLite uses Node's built-in `node:sqlite`, so no native SQLite package compilation is needed.

## Use the local dashboard

After building, run:

```sh
npm run ui
# Dashboard: http://127.0.0.1:4317      Data API: http://127.0.0.1:4317/api/v1
# Optional: npm run ui -- --port 4318 --output ./runs/verification
```

The dashboard provides state/county selection, the collectors for each approach, collection limits, live saved-row and transfer counts, recent activity, run history grouped by collection day, safe stop/resume, and CSV/JSON/report downloads. New dashboard collections include JSON arrays as well as CSV and JSONL. Existing CLI collections under the output directory appear automatically, including run directories up to three levels deep.

Collections run in detached Node processes. Closing the browser or dashboard server does **not** stop them; use **Stop safely** in collection details. The dashboard admits one active collection per output root. After restarting the server, refresh the page and reopen the collection from history. Interrupted workers preserve committed records; **Resume collection** recovers and continues the saved scope with fresh attempt limits. Existing CLI runs can be monitored here, but stop them in their original terminal.

The server binds only to `127.0.0.1`. Mutation requests require the current dashboard token and same-origin browser access. Downloads are restricted to approved exports, logs and report files; SQLite checkpoints, credentials and arbitrary paths are not served. Exports become available when the attempt finishes or stops safely. Source totals and completeness remain explicitly unknown where the publisher does not supply them.

For authentication, select an existing local credential profile or use the CLI's `auth login` command before resuming. Dashboard workers do not open interactive login prompts. Maps, scheduling and an in-browser credential manager remain future milestones. See [dashboard specification](specs/10-local-dashboard-spec.md).

## Explore collected data

Choose **Data explorer** in the dashboard, select a collection and click **Prepare data**, or use **Explore data** from collection details. Search Wells, Construction & permits, Observations or Reports by address, parcel, identifier, name or title. Filters include source/dataset, typed identifiers, date meaning/range, known or unknown depth, status/use, quality flags and report availability.

Open a result to inspect its original fields, provenance and explicit related records. Downloaded PDFs, PNGs and JPEGs can be viewed locally; TIFF and unsupported browser viewers have a download fallback. **Export results** creates CSV, JSON or JSONL containing all matches across all pages, plus a manifest with the query, snapshot and content hash.

The explorer uses immutable snapshots of finalized attempts, including partial and cancelled collections. Resuming collection leaves an existing snapshot unchanged; use **Refresh data** after the next attempt finishes. Browsing does not re-scrape or read credentials. Original records, reports and full collection exports are preserved.

Index/export work continues when you close the browser, but stopping the dashboard server interrupts unfinished explorer jobs. Completed snapshots/exports persist, and interrupted jobs can be retried. **Clear this search cache** and **Delete derived export** remove derived data only. See the [explorer guide, architecture and verification evidence](docs/data-explorer.md) for recovery, measured performance and the implementation of [specifications 11–13](specs/13-data-explorer-delivery-plan.md).

## Collect records

```sh
# Resolve the place and list the collectors without network access.
npm start -- collect --state NC --county Mecklenburg --dry-run

# Collect with every approach: public API, browser navigation and file downloads.
npm start -- collect --state 'North Carolina' --county Mecklenburg --json-array

# Any other county works the same way.
npm start -- collect --state MN --county Hennepin

# One approach only, as a bounded sample.
npm start -- collect --state TX --county Travis \
  --approach api --max-records 100 --max-duration 120

# Point the browser and download collectors at agency pages you know about.
npm start -- collect --state NC --county Wake \
  --seed-url https://agency.example.gov/wells

# Keep report metadata without downloading files.
npm start -- collect --state NC --county Mecklenburg --attachments none
```

`--approach` takes `api`, `browser` and/or `download` (default: all three). `--source` takes one or more collector IDs separated by spaces. `--seed-url` adds public pages for the browser and download collectors. `--max-targets` limits how many discovered services, pages or files each collector follows (default 40). `--attachments none` retains report metadata without downloading files. `--json-array` adds `.json` arrays alongside the default `.jsonl`. Raw source fields are retained in either mode. Config files use the fields in [config/example.json](config/example.json); CLI settings override config, and allowlisted `WELL_SCRAPER_OUTPUT` / `WELL_SCRAPER_MAX_DURATION` settings override config before CLI options.

The limits of an attempt are shared equally: each collector gets an equal part of the remaining record, time and download budget, and passes on what it does not use, so no approach can crowd out the others. Each attempt defaults to two hours, 5 GiB of API/report response bytes, 1,000,000 source records, a 100 MiB per-API/download-response limit, and a 100 MiB free-disk reserve. API requests run sequentially with at least one second between requests to an origin. Chromium page-response bytes count toward the same budget; browser contexts close on byte, duration or interruption limits. Accounting uses received body chunks, so the last chunk can cross the limit. Budget exhaustion produces a partial/failed outcome, never success.

## Read stored data through the API

The dashboard server also serves a read-only data API on `127.0.0.1`. Records are grouped by the day they were collected.

```sh
npm run ui                      # or: npm start -- serve --port 4317 --output ./runs
curl http://127.0.0.1:4317/api/v1/days
curl "http://127.0.0.1:4317/api/v1/days/2026-11-10/records?kind=wells&limit=100"
curl "http://127.0.0.1:4317/api/v1/records?kind=observations&state=NC&county=Mecklenburg&format=csv"
```

| Endpoint                                                       | Returns                                     |
| -------------------------------------------------------------- | ------------------------------------------- |
| `GET /api/v1`                                                  | Endpoint list and filters                   |
| `GET /api/v1/days`                                             | Collection days with run and record counts  |
| `GET /api/v1/days/{day}`                                       | Runs and totals for one day                 |
| `GET /api/v1/days/{day}/records`                               | All records collected that day, across runs |
| `GET /api/v1/records`                                          | Records across days (`day`, `from`, `to`)   |
| `GET /api/v1/runs`, `/runs/{run_id}`, `/runs/{run_id}/records` | Runs and their records                      |
| `GET /api/v1/record?kind=&id=`                                 | One record                                  |
| `GET /api/v1/files/{sha256}`                                   | A stored report or data file                |

Filters: `kind`, `state`, `county` (name or GEOID), `source`, `dataset`, `approach`, `q`, `limit` (≤ 1000), `offset`, `format=json|csv`. Responses include `total` and `next_offset` for paging.

## Resume or rebuild the log

The CLI prints the run ID and output directory. Use those values:

```sh
npm start -- resume --run-id RUN_ID --output ./runs
npm start -- report --run-id RUN_ID --output ./runs
```

Resume uses the saved configuration with a fresh attempt budget. Accepted records and completed archive partitions are skipped; an active archive search response is persisted so changing opaque document IDs do not restart that page. An incompatible schema or adapter version stops resume and requests a new run. `report` rebuilds exports and summaries from SQLite without accessing websites.

Ctrl+C/SIGTERM preserves completed work and finalizes available exports. After SIGKILL, the next resume recovers the stale process lock and records the interrupted attempt. A live lock prevents concurrent writers. Files are published with temporary-file replacement, and `manifest.json` indicates whether export publication finished.

## Files produced

Runs are grouped by collection day: `runs/<YYYY-MM-DD>/<YYYY-MM-DD>_<state>-<county>_<id>/`. The day is the local calendar day the collection started; a run resumed later stays in its starting day. Runs created before this layout are still found in place.

Each run directory contains:

| File                                           | Contents                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `wells.csv`, `wells.jsonl`                     | Inventory/monitoring location source records                                                  |
| `construction.csv`, `construction.jsonl`       | Permit, construction and abandonment records                                                  |
| `observations.csv`, `observations.jsonl`       | Water-level attributes, field measurements and sample results                                 |
| `documents.csv`, `documents.jsonl`             | Report and data-file metadata, download state, file path and SHA-256                          |
| `relationships.csv`, `relationships.jsonl`     | Explicit report-to-record links based on the same source entry ID                             |
| `source-fields.jsonl`, `field-dictionary.json` | Original public fields and source field metadata                                              |
| `raw/`, `attachments/`                         | Content-hashed public responses, and original downloaded files (PDF, images, CSV, GeoJSON, …) |
| `validation-errors.jsonl`                      | Quarantined records and validation/download errors                                            |
| `events.jsonl`                                 | Redacted operation events and heartbeat                                                       |
| `summary.md`, `summary.json`                   | Final collection log, per-dataset counts, coverage gaps and resume command                    |
| `manifest.json`, `attempts/`, `state.sqlite`   | Artifact hashes, attempt reports and durable checkpoints                                      |

CSV includes nested values as JSON text and retains additional canonical fields in `additional_fields`. Empty CSV cells represent missing/null values; JSON distinguishes null from empty strings. Text starting with spreadsheet formula characters is prefixed with an apostrophe in CSV; JSON retains the original value. Reports are saved in their original form; OCR and text extraction are not included.

Every record has `acquisition_method` (`api`, `browser` or `download`), `county_assignment_method`, and `field_map` (which source column filled each common field).

**Counts are source records, not unique physical wells.** The same well is usually found by more than one approach and kept each time; layers and agencies may also overlap. Unverified units remain unknown, source coordinates and precision are preserved, and records with uncertain county membership are quarantined with raw evidence. A `success` outcome can still have `unverified` completeness because these sources do not supply immutable snapshots.

Exit codes: `0` success, `1` failed, `2` partial, `3` needs authentication, `4` unsupported, `5` invalid input, `6` blocked, `130` cancelled. A bounded sample normally exits `2`.

## Local credentials

Anonymous public access is used first unless a profile is explicitly selected. When a browser portal requires authentication, the application can look in these bounded locations:

1. An explicit `--credential-profile NAME`.
2. Portal-specific environment variables.
3. `.well-scraper/credentials.local.json` in this project.
4. `${XDG_CONFIG_HOME:-~/.config}/well-scraper/credentials.json`.
5. Application-owned saved browser sessions in that configuration directory.

No recursive home-directory or existing browser-profile search occurs. Profiles must name the source and its exact portal origin. Files must be owned by the current user and have mode `0600`; saved browser states must reside in the application configuration directory or project `.well-scraper` directory. Unrelated-origin or expired sessions are rejected.

Portals are discovered while a collection runs, so a login is tied to the portal page the collection log reports:

```sh
npm start -- auth status --url https://records.example.gov/Portal/Welcome.aspx?repo=Public
npm start -- auth login --url https://records.example.gov/Portal/Welcome.aspx?repo=Public
npm start -- auth logout --url https://records.example.gov/Portal/Welcome.aspx?repo=Public
```

`auth login` requires an attached terminal and opens a dedicated browser for manual login/MFA. It rejects visible login/cookie-error pages before saving, but captured sessions are verified for collection only on the next source attempt. Password/API-key providers are resolved and validated; automatic form filling or token injection is not enabled without a verified source-specific authentication contract. Use a saved Playwright session for these browser sources. `collect --interactive-auth` can pause for a manual login in an attached terminal, save a validated session and retry the source. It times out after five minutes or the remaining attempt duration.

A storage-state profile example is included in [config/credentials.example.json](config/credentials.example.json). Never put secrets directly in CLI arguments. `.gitignore` excludes sessions, credentials and run data. Public owner information can appear in the downloaded data, so review artifacts before sharing them.

## Collectors and limitations

The same collectors run for every county. What each finds depends on what is published for that county.

| Collector          | Approach | Scope                                                                                                                                                                                                                                                           | Limitations                                                                                                                                                                     |
| ------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usgs-groundwater` | API      | Groundwater monitoring locations and field measurements by county FIPS                                                                                                                                                                                          | Excludes daily/continuous series and laboratory samples                                                                                                                         |
| `arcgis-services`  | API      | Public GIS point layers and tables about wells, found in the ArcGIS catalog for the county                                                                                                                                                                      | Finds only services listed and titled/tagged as wells or groundwater; units stay unknown unless the field states them                                                           |
| `browser-portals`  | Browser  | Catalog search results; official county and state-agency sites found in the .gov registry and Wikidata, crawled via sitemap and department links; supplied pages. Collects map layers, HTML tables, linked files, Hyland OnBase and Laserfiche WebLink archives | Obeys robots.txt and does not automate search engines; sites that block automation or need login are reported, not bypassed; opens at most `--max-targets` pages per collection |
| `wqp-downloads`    | Download | Water Quality Portal well sites and sample results for the county                                                                                                                                                                                               | Private domestic wells are generally absent; one file up to 100 MiB per request                                                                                                 |
| `catalog-files`    | Download | Published catalog files, bulk layer exports, files linked from supplied pages                                                                                                                                                                                   | Only CSV and GeoJSON rows are parsed; other formats are kept as original files                                                                                                  |

Removing the hand-written adapters for one county means agency-specific conventions are no longer interpreted (for example a sentinel value meaning "below detection limit" is stored as published). See [what this design cannot find](docs/how-it-works.md#what-this-design-cannot-find) and the dated [implementation notes](docs/implementation.md).

## Development and adding collectors

```sh
npm run build
npm run lint
npm test                  # Offline contract, discovery, data API, HTTP and crash-recovery tests
npm run test:browser      # Local Chromium SPA/PDF fixture
npm run test:ui           # Local dashboard workflow in Chromium; build first
npm run test:explorer     # Explorer query, snapshot, report and export contracts
npm run test:explorer-ui  # Local explorer journey with native PDF/image viewing
npm run test:explorer-scale # 100,000-record worker and responsiveness benchmark
npm run test:scale        # Local 100,000-record HTTP/export fixture
npm run test:live -- NC Wake   # Opt-in, five public records for the place you name
npm run schemas          # Regenerate JSON schemas from Zod definitions
npm run format:check
```

Collectors must stay place-agnostic: add a manifest in `src/sources/registry.ts` with its approach, implement it against `SourceContext` (which carries the resolved geography and the fetched county boundary), and add dispatch in `src/core/runner.ts`. A collector may name nationwide services only; a test fails if application code contains any other host. Preserve the complete raw response before committing records/checkpoints, checkpoint discovered targets so resume is stable, and record what could not be reached as a caveat or error on the result.

WebLink archive searches start with a small page and cap subsequent pages at 100 records; `--batch-size` can lower that cap. Archive API requests allow 120 seconds; other HTTP requests allow 30 seconds. Failed report downloads retain metadata and retry on resume while other records continue. Identical file contents share one attachment on disk while separate source records remain distinct.

The original implementation specifications remain in [specs/](specs/), starting with [the product specification](specs/01-product-spec.md). The implementation notes identify deliberate v0.1 differences so the original acceptance plan is not confused with already completed functionality.
