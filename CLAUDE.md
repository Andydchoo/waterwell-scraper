# Water well scraper — notes for Claude sessions

This file carries the project context between sessions. Read it instead of re-exploring the codebase. Last updated 2026-11-11.

## What this is

A local Node 24 / TypeScript CLI, web dashboard and read-only data API that collects public water-well records for **any US state and county**. For the full flow read [docs/how-it-works.md](docs/how-it-works.md); for dated live results read the last two sections of [docs/implementation.md](docs/implementation.md).

## Requirements from the project manager — do not regress

1. **Explain how data is acquired.** `docs/how-it-works.md` is that explanation. Update it whenever the acquisition steps change.
2. **All approaches, equally.** Every collection runs Public API, Browser navigation and File downloads. No approach is skipped because another found the data. Duplicates are kept on purpose (cleaned later); records carry `acquisition_method`.
3. **No county data in source code.** Only the state/county list (`data/counties.json`) is built in. Everything else is discovered at run time. A test fails if `src/` or `web/src/` contains any host other than the nationwide services allow-listed in `tests/discovery.test.ts`.
4. **Runs grouped by day**, not date/time: `runs/<YYYY-MM-DD>/<YYYY-MM-DD>_<state>-<county>_<id>/` (local calendar day). Dashboard history and the API group by that day.
5. **Stored data is available through an API**: `GET /api/v1/...` on the dashboard server (127.0.0.1 only, read-only).

## How a collection works (short version)

Resolve place → fetch county boundary from Census TIGERweb → run five collectors, each with an equal share of the record/time/byte budget → write CSV/JSONL + `summary.md`.

| Collector          | Approach | Finds its targets by                                                                                                                                                                                    |
| ------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usgs-groundwater` | api      | County FIPS query                                                                                                                                                                                       |
| `arcgis-services`  | api      | ArcGIS Online catalog search → point layers/tables about wells                                                                                                                                          |
| `browser-portals`  | browser  | Catalog search page, official sites from the .gov registry + Wikidata (robots.txt, sitemaps, department links), `--seed-url` pages; detects Hyland OnBase and Laserfiche WebLink archives from the page |
| `wqp-downloads`    | download | Water Quality Portal CSVs by FIPS                                                                                                                                                                       |
| `catalog-files`    | download | Catalog file items, bulk layer exports, files linked from seed pages                                                                                                                                    |

## Where things are

- `src/sources/registry.ts` — the five generic collectors. `src/core/runner.ts` — run lifecycle, day folders, budget sharing, dispatch.
- `src/sources/discovery.ts` (catalog search), `arcgis.ts` (layer harvest, county scoping), `api.ts`, `usgs.ts`.
- `src/sources/browser.ts` (page queue and collection), `official.ts` (directories, robots, sitemaps, link scoring), `documents.ts` (Hyland), `laserfiche.ts` (WebLink).
- `src/sources/downloads.ts` (WQP, catalog files), `tabular.ts` (CSV/GeoJSON/HTML-table rows → records).
- `src/data/normalize.ts` — field mapping by column name, well vocabulary (`wellRelevance`), units.
- `src/geography/` — state/county resolution, run-time boundary. `src/storage/` — SQLite checkpoint, exports.
- `src/api/routes.ts` — data API. `src/dashboard/` — server, jobs, run listing. `src/explorer/` — search snapshots. `web/src/` — React UI.
- `specs/` and most of `docs/acceptance.md` describe the earlier Mecklenburg-only pilot and are historical.

## Commands

```sh
nvm use && npm ci && npm run browsers:install   # first time only
npm run build            # needed before `npm run ui`, `npm start`, test:ui
npm test                 # offline suite, ~10 s; the opt-in browser tests show as skipped
npm run lint && npm run format:check
npm run test:browser; npm run test:ui; npm run test:explorer-ui   # opt-in, local Chromium, no network
npm run ui               # dashboard + API at http://127.0.0.1:4317
npx tsx src/cli.ts collect --state NC --county Mecklenburg --approach api --max-records 300 --max-duration 180 --max-targets 6 --output <scratch dir>
```

Live collections hit real public sites and take minutes. Run them in the background with small `--max-records`, `--max-duration` and `--max-targets`, write to a scratch `--output`, and read `summary.md` rather than the event log. A bounded run exits with code 2 (`partial`); that is expected.

## Rules when changing code

- Keep collectors place-agnostic; pass the place through `SourceContext` (`ctx.geo`, `ctx.boundary`).
- Do not add anything that disguises the browser, solves CAPTCHAs, rotates proxies or scrapes search-engine result pages. Sites that refuse automation are reported in the log and left alone. Obey `robots.txt` for crawled pages.
- Save the raw response before committing records; checkpoint discovered targets so resume is stable.
- Bump a collector's `version` in `registry.ts` when its checkpoint or discovery behaviour changes (old runs then refuse to resume, by design).
- Field names and "is this about wells" decisions belong in `normalize.ts`, with a test.
- Run `npx prettier --write` on touched files; `npm run format:check` must pass.

## State and open items

- Everything above is implemented and verified live on Mecklenburg County NC and Hennepin County MN (2026-11-10 and 2026-11-11). Sample runs from those checks are in `runs/2026-11-10/` and `runs/2026-11-11/`; older folders in `runs/` predate the rewrite and can be viewed but not resumed.
- The folder is **not a git repository** and nothing has been committed.
- Known gaps, none started:
  - Official-site crawl did not reach Minnesota's well index within the default 40-page limit; untested whether a higher `--max-targets` reaches it.
  - A paid search API (for example Brave Search) as an extra discovery source was discussed and not built.
  - Excel, shapefile and PDF contents are saved but not parsed into records.
  - Agency-specific conventions are not interpreted (for example a sentinel number meaning "below detection limit" is stored as published).

## Keeping sessions small

- Start from this file and `docs/how-it-works.md`; open a source file only when changing it.
- Prefer targeted tests (`npx tsx --test tests/official.test.ts`) while iterating, the full suite once at the end.
- Avoid re-running the two-county live verification unless discovery or collection logic changed.
