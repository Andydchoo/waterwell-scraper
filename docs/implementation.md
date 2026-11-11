# Implementation evidence — v0.1 with archive adapters v2

> **2026-11-10 — place-agnostic rewrite.** The Mecklenburg/NC-specific adapters, layer lists, boundary file and source IDs described below were removed. Collectors are now generic and discover their targets at run time for any state and county, using three approaches (public API, browser navigation, file downloads); runs are grouped by collection day and stored data is served by a read-only API. See [how the application acquires data](how-it-works.md). The sections below are kept as the record of the earlier pilot and no longer describe the code. [Spec 09](../specs/09-mecklenburg-nc-spec.md) is likewise historical.
>
> Live check on 2026-11-10 with the rewritten collectors is recorded at the end of this file.

Implementation and live verification began 2026-10-27. This is a functioning local CLI with a Mecklenburg pilot; it is not a claim that all public wells or documents have been found. The original nine specifications remain the target contract.

The 2026-10-29 data explorer adds immutable local search, record details, report previews and filtered exports. See [its implementation and verification evidence](data-explorer.md) for the delivered scope, performance, recovery and preserved source data checks.

## Live results

Separate bounded verification runs were used so source failures were visible independently. The run directories are ignored by version control and remain available locally under `runs/verification/`.

| Source / dataset             | Accepted source records | Quarantined | Run                                               |
| ---------------------------- | ----------------------: | ----------: | ------------------------------------------------- |
| Mecklenburg ambient wells    |                      38 |           0 | `2026-10-27T23-32-57-374Z_011c7a16`               |
| Mecklenburg private wells    |                  11,766 |          21 | Same                                              |
| Mecklenburg public wells     |                     150 |           0 | Same                                              |
| Mecklenburg monitoring wells |                  13,982 |          54 | Same                                              |
| Mecklenburg permits          |                   5,477 |          13 | Same                                              |
| USGS groundwater locations   |                     322 |           0 | `2026-10-27T23-31-41-571Z_a753d54d`               |
| USGS field measurements      |                  13,677 |           0 | Same                                              |
| NC monitoring network        |                       3 |           0 | `2026-10-27T23-37-09-218Z_b53bfe38`               |
| NC chemistry                 |                      85 |           0 | Same                                              |
| NC PFAS                      |                      80 |           0 | Same                                              |
| Hyland well-report files     |                       4 |           0 | `2026-10-27T23-42-01-689Z_43037829`, two attempts |

The county inventory run exported 25,936 well rows, 5,477 permit rows and 14,004 observations derived from published static water-level attributes. The 88 quarantined source items retain their raw responses and location-validation issues. Each ArcGIS dataset reconciled its saved object-ID set; no immutable attribute snapshot is available.

The first combined USGS/county verification run exposed an ArcGIS coordinate-reference parsing error. That error was corrected and the entire county inventory was collected in the next run. The failed attempt remains in its original log; it was not relabeled as successful.

The Hyland run intentionally stopped after two documents, resumed, and reached four unique document records. All four attachment SHA-256 hashes matched their files; total saved bytes were 16,178,296. This verifies downloading and resume, not complete archive enumeration.

## Archive completion work (2026-10-28)

The NC DEQ adapter enumerated **9,730** Mecklenburg construction-template entry IDs and downloaded two real scanned PDFs in `runs/verification/2026-10-28T14-12-35-101Z_8899e1f7`. They are 148,328 and 153,422 bytes; both SHA-256 hashes match. The run deliberately stops at two source records and records a partial outcome. It exports two construction records, two document records and two explicit relationships. Its first failed browser-startup attempt remains in the attempt history. A separate live GW-30 template query returned zero Mecklenburg hits; this is a template-specific result, not proof that no abandonment reports exist elsewhere.

The date-based Hyland metadata run is `runs/verification/2026-10-28T14-15-42-351Z_26326e43`. Its first attempt accepted 578 well-report records and excluded 31,483 septic records, then exposed a source defect: an older date search returned HTTP 404 with “The revision id 0 was not found for document id 37066083.” This is not an empty result. The adapter now bisects only this recognized source error, isolates unavailable single-day partitions, preserves the gap and continues other dates. Ordinary 404/schema errors still fail explicitly. Failed partitions retry on resume. The final bounded sample retained **3,006 well-report metadata records** and excluded **39,936 septic records**. The broken revision was isolated to **2019-05-06**; older pending date partitions remain in the checkpoint. This sample was deliberately stopped, and its final outcome is **cancelled**, not a completed archive. Offline recovery rebuilt the summary from 42,942 committed source tasks. Live and fixture evidence do not establish coverage of undated/unindexed records.

The DEQ metadata run `runs/verification/2026-10-28T14-17-27-297Z_48023c11` uses reconciled pages of at most 100 entries. An initial 500-row request timed out; the interrupted attempt is retained. The resumed attempt collected **3,699** report records, quarantined **1** ambiguous county record and left **6,030** IDs unresolved when its 15-minute validation budget ended. The ledger reconciles: 9,730 expected = 3,700 handled + 6,030 remaining. It exported 3,699 documents and 3,699 same-entry relationships, with downloads disabled for this metadata run. Its partial summary and resume command are preserved.

Portability check `runs/verification/2026-10-28T14-33-23-461Z_b54ffdf0` collected five USGS groundwater locations for **Wake County, NC (37183)** and stopped at the configured five-record limit. It is a deliberate partial sample, not a full county inventory.

## Source evidence and mappings

- County well layers: [GWS WIS MapServer](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/WIS/MapServer), layer IDs 1–4; permits: [Wells_Permitted](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/Wells_Permitted/MapServer/0). Metadata provides object-ID fields, maximum page sizes and coordinate reference. ID enumeration uses `returnIdsOnly=true`; bounded POST queries request `outFields=*`. Source fields and geometry are retained. Coordinates are transformed with proj4 and checked against the official Census county polygon. Depth/yield units are not guessed from undocumented labels. `SWL` and `DepthToGW` produce separate observations.
- County reports: [Hyland public portal](https://mecknc.hylandcloud.com/241publicaccessgws/). Its public `api/CustomQuery` response identifies “GWS - Public Permit Search”; the UI has Angular object-valued select options, so query IDs are read from that API, not parsed from the HTML option value. The public search uses keyword IDs 103 (address), 104 (parcel), and 107 (file number). `DisplayColumns` and `DisplayColumnValues` retain all exposed metadata. Only the “Document Type” value classifies a record as a well document. Public `api/Document/{encoded-ID}/` returns original file bytes. File signatures reject HTML/login responses. Broad queries can truncate. Adapter v2 splits inclusive date ranges with `FromDate`, `ToDate` and `QueryLimit=1000`; a single day uses the official application default `QueryLimit=0`. It requires `Truncated=false` before accepting a partition. Active response hashes and failed-download queues persist across attempts. This includes blank and punctuation-leading file numbers, although undated/unindexed documents cannot be audited.
- NC monitoring sources: [official ambient groundwater program](https://www.deq.nc.gov/about/divisions/water-resources/groundwater-resources/ambient-groundwater-quality-monitoring). The program's public Experience app exposes `dwractivewells_wl/FeatureServer/0`, `all_gw_parameters/FeatureServer/0`, and `gw_pfas_data_2024_01_05/FeatureServer/0` under `https://services2.arcgis.com/kCu40SDxsCGcuUWO/arcgis/rest/services`. Each query filters the explicit County field and validates it in the returned rows. Original analyte, result, qualifier, units, MDL/PQL, laboratory identifier and date values remain available. No inferred station crosswalk is created.
- USGS: [public Water Data API](https://api.waterdata.usgs.gov/). Monitoring locations use `/ogcapi/v1/collections/monitoring-locations`; field measurements use `/ogcapi/v0/collections/field-measurements`. Explicit state/county codes and `site_type_code=GW` constrain queries; next links must retain those filters. Queryable schemas and raw pages are retained. Agency location IDs are preserved; measurement UUIDs identify source versions. Constructed depth is converted from documented feet to meters with the raw value retained. Terminal cursors establish the end of the published result set, not an immutable historical snapshot.
- County names/boundary: [Census TIGERweb State/County service](https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer/1), BAS 2026. `data/counties.json` includes the source/vintage. The resolver supports 50 states and DC. Ambiguous bare aliases such as Virginia “Richmond” fail with candidates; explicit “Richmond city” or FIPS succeeds.

## Evidenced coverage gaps

The [NC DEQ public archive](https://edocs.deq.nc.gov/Groundwater/Welcome.aspx?dbid=0&repo=WaterResources) works when the stale `cr=1` parameter is omitted on the first visit. Fresh-browser cookie initialization then succeeds. The earlier cookie-error evidence is retained in prior logs; it is no longer a blocked adapter.

`SearchService.aspx/GetSearchListing` applies the actual `GW-I` and `GW-30` template County fields. The adapter reconciles all pages against `GetSearchListingIds` at the beginning and end, detects changed snapshots on resume, validates each returned County value, and preserves original metadata arrays and display columns. Search session IDs are recreated each attempt; cached result pages are hash-verified. Report records are separate from physical wells. An explicit relationship links each document to its same-entry construction/abandonment record.

Electronic files use the public `ElectronicFile.aspx` endpoint. Scanned reports use the portal's `GeneratePDF10.aspx`, `DocumentService.aspx/PDFTransition`, and `PDF10/{generation-key}/{entry-id}` workflow. Generated URLs are transient; exported provenance uses the stable `DocView.aspx` permalink. Downloaded bytes must have a supported PDF/image signature. PDFs are not OCRed. Failed downloads retain their metadata and are retried on resume without blocking later entries.

The county sampling Experience app's public configuration exposed well-location layers, but no historical laboratory-results table was found. That candidate remains visible as unsupported. NC chemistry/PFAS and USGS field observations provide real observation datasets without claiming to replace the missing county dataset.

Hyland date partitions improve coverage beyond the original alphanumeric search. Unknown document classifications, undated/unindexed records and archive query failures still limit completeness. Reports are preserved without OCR. There is no reliable automatic cross-agency physical-well merge or report-to-many-wells crosswalk.

## Verification

Final implementation checks: build, lint and formatting passed; **46 offline tests** passed, and **2 separately enabled Chromium tests** passed, including shared byte-budget interruption and SIGINT finalization. The earlier baseline had 26 offline tests. All **146 artifact hashes across 10 completed verification-run directories** matched their files. “Completed” here means the attempt/report ended; partial and cancelled data outcomes remain labelled as such. The finished live-smoke command passed with five records in `runs/live-smoke/2026-10-28T05-19-19-792Z_3da33d96`.

- Offline tests cover geographic ambiguity, source-field preservation, censored/zero values, CSV injection escaping, schema/ID drift, empty and truncated responses, county quarantine, private-network/redirect restrictions, credential permissions, HTTP failures, report signatures, bounded collection and idempotent resume.
- SIGKILL fixtures cover crashes after raw writing, inside an uncommitted SQLite transaction, after a committed transaction and during export. Restart recovers stale locks, preserves only committed work, and rebuilds exports.
- Chromium fixtures check delayed SPA hydration, asynchronous result-page changes, a popup, a real local PDF download, streaming byte-budget interruption, and an actual child process receiving SIGINT. Playwright signal handlers are disabled so the application retains control of checkpointing and finalization.
- A live stop exposed Playwright exiting before the final summary was written. This was fixed and covered by the SIGINT test. Offline recovery now reconciles source counts from committed tasks; the stopped county sample was recovered with all 3,006 metadata records intact and no live lock.
- The 100,000-record local HTTP fixture collected and exported all rows in CSV, JSONL and JSON arrays with peak process RSS **353 MiB** on macOS arm64 / Node v24.21.0. This excludes browser processes. Fixture output was written to a temporary directory.
- Live verification is opt-in. `npm run test:live` uses five county records and checks that a record-budget stop is reported as partial.

## Implementation choices and remaining specification scope

Node's built-in SQLite replaces the proposed native SQLite package. Source requests are sequential instead of a multi-source concurrency pool. HTTP timeout is 30 seconds, archive API/download timeout 120 seconds and navigation timeout 60 seconds. DEQ initializes searches with up to 20 records and caps subsequent pages at 100. Browser body chunks count against the shared byte budget; CDP initialization completes before navigating new pages. Contexts close on duration/byte limits or cancellation. Disk reserve checks run before source work items; exhaustion during final export can still prevent a final log and returns an error.

Environment/local-file credential providers are implemented as scoped resolvers. None of the verified public API adapters requires username/password/API-key authentication; automatic credential injection is deliberately absent until a source's authentication contract is verified. Browser storage states can be used for the scoped portals. Manual `auth login` and in-run `--interactive-auth` share source-specific session validation. In-run authentication requires a TTY and has a five-minute/remaining-budget deadline. OS keychain integration, Windows ACL checks and authenticated diagnostic capture are not implemented.

Recovery uses schema/application/adapter versions and source schema fingerprints. SQLite schema version 1 is created in `src/storage/store.ts`; newer database versions are rejected. There are no historical database versions to migrate yet. Large IDs are currently loaded as an enumeration array, while entity processing and export are streamed; the tested 100,000-record workload remains well below the memory target.

Milestones M0–M3 have implemented core paths with explicit source exceptions. M4 includes inventory, observations, county reports and NC DEQ construction/abandonment adapters; coverage remains explicitly relative to published, enumerable sources. M5 has reproducible installation, recovery/contract/scale tests and live evidence, but the original acceptance matrix is broader than the implemented scope above. M6 is supported through the nationwide USGS adapter and statewide NC monitoring adapters; a bounded Wake County USGS run verifies reuse without core changes; its local agencies have not been separately onboarded.

## Local dashboard verification — 2026-10-29

Spec 10 is implemented with a React/Vite interface, loopback Fastify API and detached Node collector workers. Collection setup, source coverage, saved-row/transfer progress, searchable history, safe stop/resume, activity and finalized downloads are available through `npm run ui`. Read-only visual verification discovered all 29 existing collection directories; no new public-source collection was launched for dashboard testing.

Build, lint and formatting checks passed. The offline suite passed 51 tests; the two collector Chromium tests and one end-to-end dashboard Chromium test also passed. Dashboard tests verify local origin/token and export-path restrictions, API restart survival, nonce-bound stop, retained scope and rows on resume, production worker finalization without source network access, form options, CSV downloads, browser-close survival and mobile layout. A final targeted run verified combined browser/direct request counters. Screenshots were inspected at 1440-pixel and 390-pixel widths. The temporary preview server was stopped after verification.

This milestone does not add source coverage. Record exploration, mapping, schedules, a multi-job queue and browser-based credential management remain deferred; existing local credential profiles and CLI login are reused.

## Place-agnostic collectors: live check (2026-11-10)

Bounded runs with the rewritten collectors, all three approaches enabled, 5,000-record and about nine-minute limits per attempt, six discovered targets per collector. No county-specific code or configuration was used; the only input was the state and county. Run folders are under the collection day.

**Mecklenburg County, NC** — outcome `partial` (limits reached; resumable). Each collector received an equal share of the record limit.

| Collector (approach)        | What it found at run time                                                                               |           Records in the sample |
| --------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------: |
| `usgs-groundwater` (API)    | County FIPS query                                                                                       |     322 wells, 678 measurements |
| `arcgis-services` (API)     | 6 catalog items → 5 layers; county private-wells layer has 11,780 features in the county's bounding box |                     1,000 wells |
| `browser-portals` (browser) | 9 pages opened from the catalog search site → 5 map layers                                              |                     1,000 wells |
| `wqp-downloads` (download)  | Two county CSV files                                                                                    |     322 well sites, 999 results |
| `catalog-files` (download)  | 5 bulk layer exports                                                                                    | 984 wells from the first export |

Separate samples the same day: the full private-wells export (GeoJSON download) yielded 11,236 wells inside the county boundary and 20 rows outside it; the browser collector, given the county's and the state's public archive pages with `--seed-url`, recognised both archives from the pages themselves and saved 75 county permit documents (Hyland OnBase) and 200 state construction reports with their records and links (Laserfiche WebLink, 9,767 indexed for the county) before the sample limit.

**Hennepin County, MN** — same command with only the state and county changed; outcome `partial` (limits reached; resumable).

| Collector (approach)        | What it found at run time                                                                                                                                                                      |                                             Records in the sample |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------: |
| `usgs-groundwater` (API)    | County FIPS query                                                                                                                                                                              |             1,000 wells (limit share reached before measurements) |
| `arcgis-services` (API)     | 6 catalog items → 9 layers, including state DNR groundwater monitoring and state pollution-control layers; out-of-state layers returned nothing for the county                                 |                                        104 wells, 35 observations |
| `browser-portals` (browser) | 9 pages → 5 map layers, among them the state health department's well-information layer (14,739 features in the county's bounding box) that the API search had not selected, and 1 linked file |                                       341 wells, 216 observations |
| `wqp-downloads` (download)  | County well-site CSV                                                                                                                                                                           | 1,499 well sites (results file not reached within the time share) |
| `catalog-files` (download)  | 8 catalog files and 5 layer exports; 10 files saved                                                                                                                                            |           104 wells parsed; Excel and other formats kept as files |

Two of the layer exports failed on the publisher's side and are listed as such in the run's log. Offline suite on the same date: 75 tests passing, 4 opt-in browser tests skipped by default; the opt-in browser, dashboard UI, explorer UI and scale tests also passed.

## Official-site discovery without a search engine (2026-11-11)

The browser collector now also starts from the official websites that two public directories list for the place: the federal .gov domain registry and Wikidata. It obeys each site's `robots.txt`, uses the site's sitemap, and follows directory → department → wells links. Live check with the browser collector alone, default 40-page limit, 900-record sample, no pages supplied:

| County          | Sites looked up                                                                                                                                                                                        | What the crawl reached                                                                                                                                                                                                                                       | Collected in the sample                                                                                                                                                     |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mecklenburg, NC | County: `mecknc.gov` (registry). State: NC DHHS, NC DEQ Division of Water Resources, NC Soil and Water Conservation (registry and Wikidata). Two listed addresses no longer respond and were reported. | County home → Health and Human Services → Public Health → Groundwater and Wastewater Services, and from there the county's public document archive; the state's well-construction permit pages via the DEQ sitemap.                                          | 450 wells from the county layer and **122 permit documents from the archive**, which previously needed `--seed-url`.                                                        |
| Hennepin, MN    | County: `hennepincounty.gov` (registry). State: Department of Natural Resources, Pollution Control Agency, Department of Health (Wikidata).                                                            | County environment and land-and-water pages; DNR groundwater pages; the Department of Health's data pages. The Pollution Control Agency site answered with a CAPTCHA and one health-department page with "403 Forbidden"; both were reported and left alone. | 529 wells and 385 observations, all from map layers the catalog search had already found. The crawl did not reach the health department's well index within the page limit. |

So the approach removes the need to hand over the county's own portal where the county site links to it within a few clicks, and it does not help where the records sit deeper than the page limit allows or behind a site that refuses automated visitors. Offline suite on this date: 82 tests passing, 4 opt-in browser tests skipped by default.
