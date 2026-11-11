# How the application acquires data

This answers the question "what steps does the app follow to get its data?" for any state and county. Nothing in the source code names a county, an agency portal or a dataset. The only reference data shipped with the app is the list of states and counties (`data/counties.json`). Everything else is looked up while a collection runs.

## The steps of one collection

1. **Resolve the place.** The state and county you give (name, abbreviation or FIPS code) are matched against the built-in state/county list to get the county's FIPS codes.
2. **Create the day's run folder.** The run is filed under the local calendar day: `runs/<YYYY-MM-DD>/<YYYY-MM-DD>_<state>-<county>_<id>/`. Several collections on one day sit side by side in that day's folder.
3. **Fetch the county boundary.** The outline is requested from the Census Bureau's nationwide TIGERweb service by county GEOID and saved with the run. It is used to ask map services for "what is inside this county" and to check every coordinate.
4. **Run every acquisition approach.** All three approaches below run on every collection, one after another. None is skipped because another one already found the same data.
5. **Save as it goes.** Each raw response is written to `raw/` before its records are committed to the run's SQLite checkpoint, so an interrupted run resumes without repeating finished work.
6. **Publish the outputs.** At the end (or on stop) the run writes CSV, JSONL and optional JSON files, the original downloaded files, a field dictionary and a collection log (`summary.md`) that lists what each approach found, kept, left out and could not reach.

## The three approaches

Every stored record carries `acquisition_method` (`api`, `browser` or `download`) and its collector's ID, so the same well found three ways appears three times. Duplicates are kept on purpose; they can be cleaned later.

### 1. Public API (`--approach api`)

| Collector          | Steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `usgs-groundwater` | Calls the USGS Water Data API with the county's state and county FIPS codes, pages through groundwater monitoring locations and their field measurements, and checks that every page stays inside that county.                                                                                                                                                                                                                                                                                                    |
| `arcgis-services`  | (a) Searches the public ArcGIS Online catalog for map services about wells or groundwater that name the county, name the state, or whose extent overlaps the county. (b) Ranks the results and opens each service to list its point layers and tables about wells. (c) Asks each layer for the IDs of features inside the county's bounding box, downloads them in batches, and keeps the ones whose coordinates fall inside the county boundary. Tables without coordinates are filtered by their county column. |

### 2. Browser navigation (`--approach browser`)

Collector `browser-portals` drives a real Chromium browser. It has three starting points, none of which is a search engine:

- **The public catalog.** It opens the ArcGIS Online search page and searches for the county's wells and groundwater, the way a person would, and reads the result list the page loads.
- **Official sites.** Two nationwide public directories are asked which websites belong to the place: the federal .gov domain registry (the county government's own domains and the state's water-related agencies) and Wikidata (the county's official website and state agencies such as water resources, natural resources, environmental quality and health). Addresses that no longer respond are reported and skipped.
- **Pages you supply** with `--seed-url`.

From there it:

1. Reads each official site's `robots.txt` and obeys it, including any requested wait between visits. Pages the site asks automated visitors not to open are listed in the log as not opened.
2. Reads the site's own sitemap and picks the pages and files about wells, records and permits first.
3. Opens pages in turn — catalog results, county-site pages and state-site pages alternate so none crowds out the others. On a home page it follows directory links (Departments, Services), then department links (Environmental Health, Water Resources, Permits), then links about wells; once on a page about wells it keeps following well links on that site.
4. On every page it records: the map-service addresses the page requests, HTML tables that look like well records, links to data files, and whether the page is a public document archive (Hyland OnBase or Laserfiche WebLink, recognised from the page itself).
5. Collects what it found through the browser session: queries the map layers, downloads the linked files, and for document archives searches by county and saves each well report.

Sites that refuse automated visits or ask for a login are listed in the log and left alone; nothing is done to disguise the browser or get past a block. Search engines are not automated because they block or forbid it. The number of pages opened per collection is limited by `--max-targets` (default 40); the log says how many candidate pages were left unopened.

### 3. File downloads (`--approach download`)

| Collector       | Steps                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wqp-downloads` | Downloads two CSV files from the national Water Quality Portal for the county's FIPS codes: well sites and their sample results. The files are kept and each row becomes a record.                                                                                                                                                                                                                                                                                      |
| `catalog-files` | (a) Searches the public catalog for published files (CSV, Excel, GeoJSON, shapefile, KML, PDF) about wells that cover the county. (b) For every well layer the catalog lists, requests the publisher's bulk "Download" export. (c) Reads data-file links from any `--seed-url` pages. Every file is saved in its original form; CSV and GeoJSON rows become records when a county column or coordinates place them in the county. Other formats are kept as files only. |

## How records are made county-specific and comparable

- **County membership.** A row is kept when its coordinates fall inside the fetched boundary, when its own county column names the county, or when the publisher's query was already limited to the county. The method used is stored in `county_assignment_method`. Rows that cannot be placed are counted as excluded or quarantined, never silently dropped.
- **Field mapping.** Source columns are matched to common fields (well ID, address, depth, casing, yield, driller, permit number, dates) by what their names say. The mapping used for each record is stored in `field_map`, and every original column is kept in `source_fields`.
- **Units.** A depth or yield gets a unit only when the source column states one (for example `Depth_ft`). Otherwise the unit is left empty and the record is flagged `source_units_unverified`.

## Grouping by day

Runs and their records are grouped by the local calendar day the collection started. The dashboard's history shows one heading per day with that day's collections under it, and the data API returns everything collected on a day in one call. A run resumed on a later day stays in the day it started.

## Reading stored data through the API

Start the server with `npm run ui` (or `node dist/cli.js serve`). It listens on `127.0.0.1` only and the data API is read-only.

| Call                                                                         | Returns                                                    |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `GET /api/v1`                                                                | The endpoint list and available filters.                   |
| `GET /api/v1/days`                                                           | Collection days, newest first, with run and record counts. |
| `GET /api/v1/days/2026-11-10`                                                | The runs and totals of one day.                            |
| `GET /api/v1/days/2026-11-10/records?kind=wells`                             | Every record collected that day, across runs and counties. |
| `GET /api/v1/records?state=NC&county=Mecklenburg&from=2026-11-01`            | Records across days.                                       |
| `GET /api/v1/runs`, `/api/v1/runs/{run_id}`, `/api/v1/runs/{run_id}/records` | Runs and one run's records.                                |
| `GET /api/v1/record?kind=wells&id=…`                                         | One record by ID.                                          |
| `GET /api/v1/files/{sha256}`                                                 | A stored report or data file.                              |

Record filters: `kind` (`wells`, `construction`, `observations`, `documents`, `relationships`), `state`, `county` (name or GEOID), `source`, `dataset`, `approach`, `q` (text search), `limit` (up to 1000), `offset`, and `format=csv`. Each page includes `total` and `next_offset`.

```sh
curl "http://127.0.0.1:4317/api/v1/days"
curl "http://127.0.0.1:4317/api/v1/days/2026-11-10/records?kind=wells&approach=download&limit=50"
curl "http://127.0.0.1:4317/api/v1/records?kind=observations&county=27053&format=csv" -o observations.csv
```

## What this design cannot find

- Data that is neither listed in a public catalog nor reachable within a few links of the county's or state agencies' official sites, and that no supplied page links to. A records portal hosted by a vendor is found only when an official page links to it.
- Official sites that are missing from both directories, or whose listed address is out of date.
- Portals that require a login (a session can be saved with `auth login --url <portal page>`) or that block automation.
- The contents of Excel, shapefile, geodatabase and PDF files: they are downloaded and kept, but their rows are not parsed.
- Agency-specific conventions that only a hand-written adapter would know, such as a sentinel number meaning "below detection limit". Such values are stored exactly as published.
