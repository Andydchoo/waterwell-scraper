# 01 — Product scope and requirements

Status: implementation baseline with confirmed pilot and delivery format. Date: 2026-10-27.

## Objective

Given a state and county, collect available public water-well data from verified government or agency-designated sources. Preserve the original evidence, normalize useful fields, download available public reports when requested, and explain what succeeded, failed, or could not be determined.

## Confirmed requirements

| ID | Requirement |
| --- | --- |
| R-01 | Accept state and county names; resolve them to unambiguous geographic identifiers before collecting records. |
| R-02 | Support multiple counties and states through reusable source adapters; report unsupported geography explicitly. |
| R-03 | Use Node.js and support websites requiring JavaScript, including React/Angular applications. |
| R-04 | Collect public water-well data with provenance and preserve source-specific information. |
| R-05 | Locate and use appropriate credentials locally when a configured public-data source requires authentication. |
| R-06 | Produce a durable machine-readable event log and human-readable final report after each run, including unsuccessful runs. |
| R-07 | Deliver implementation specs covering behavior, interfaces, tests, and rollout. |
| R-08 | Pilot Mecklenburg County, North Carolina; collect all exposed public well records/fields and available reports; deliver a local CLI with CSV/JSON exports and downloads. |

## Confirmed choices and engineering defaults

| Decision | Default | Reason / change impact |
| --- | --- | --- |
| Entry point | Local CLI; macOS and Linux proposed | CLI confirmed by user; separate core supports a future web UI. |
| Data scope | All publicly exposed well records/fields, observations, report metadata and PDFs | Confirmed by user; capabilities declare what each source actually exposes. |
| Execution | On demand, one county per command | Batch commands can compose county jobs later. |
| Persistence | Local SQLite checkpoints and canonical records; per-run CSV/JSONL exports | Resume without an external database service. |
| Historical range | All available within selected sources and configured resource limits | Hitting limits yields an explicitly partial result. |
| Attachments | Download available public reports/PDFs; retain unsupported types as link metadata | Confirmed by user; make document failures visible without losing inventory records. |
| PDF interpretation | Retain files and metadata in v1; OCR and extraction deferred | Avoid inventing precision from scans. |
| Deduplication | Exact identity within a source; conservative links across sources | Similar locations can represent different wells. |
| Deployment | Local first; container packaging after pilot acceptance | No cloud accounts or server deployment needed for initial use. |

The user selected Mecklenburg County, North Carolina (FIPS `37119`), broad public data collection, and local CLI output. Other choices in this table are engineering defaults. No further product answer is required before implementing the pilot; unresolved source mechanics are investigation tasks in spec 09.

## Supported collection scope

Inventory includes identifiers, location, use/status, depth, construction and completion dates, aquifer/geology, permits, and driller information when available. Observations include water levels, yield/pump tests, and water-quality results when the selected adapter exposes them. Historical construction/abandonment reports remain distinct events associated with a source well when that relationship is explicit.

Each run freezes a source plan describing requested datasets, discovered capabilities, deliberate exclusions, and unavailable fields/datasets. A source lacking water-quality data is a recorded coverage limitation; a source declaring water-quality support but failing to collect it is a processing failure. Source selection must never silently omit a selected source because it requires authentication or is difficult to navigate.

## Geography rules

Resolve full state names, postal abbreviations, and optional state FIPS. Use a versioned Census-derived county/county-equivalent reference with release date and checksum. Keep two-digit state, three-digit county, and five-digit combined FIPS as strings. Match county names within the selected state, case-insensitively, accepting unambiguous suffix aliases such as County, Parish, Borough, and Census Area. Preserve official names and distinguish independent cities from counties. Include the District of Columbia; territory support is deferred unless requested.

Reject an invalid state/county combination before network collection. Ambiguous aliases return candidates; do not guess. Historical name/code changes require an explicit dated crosswalk. The reference dataset vintage and any source-specific county mapping appear in the run manifest.

County membership priority: explicit source county identifier, then verified source name mapping, then point-in-polygon using a versioned boundary dataset if necessary. Never use a bounding box alone as proof. Preserve contradictory evidence and flag conflicts. Approximate coordinates, boundary points, missing coordinates, and section centroids must not be silently assigned to the nearest county. A record without defensible membership is quarantined for review rather than included as confirmed county data.

## Success and limits

The first release must collect Mecklenburg County end to end across verified pilot sources and pass both HTTP and SPA fixture tests. A subsequent portability milestone demonstrates another county without core changes. Acceptance is relative to the selected source snapshot and declared datasets, not a nationwide physical well census. A county with only federal monitoring records is labeled as monitoring coverage, not a complete local well inventory.

No self-generating production scraper, CAPTCHA bypass, paid-record purchase, account creation, portal record modification, scheduled cloud service, web dashboard, or automated interpretation of scanned reports is required for v1. Automated discovery may identify candidate sources; executable adapters remain reviewed code. Additional source onboarding is expected ongoing maintenance.

## Decisions that can be deferred

1. Which county/state should follow Mecklenburg for the portability milestone?
2. Should a later release extract structured fields from report text/scans, beyond retaining the original PDFs?
3. Are scheduled runs or a web UI wanted after the local CLI is proven?

When authentication is first needed, the operator can configure named credential locations using spec 05; actual secret values should not be collected in chat or embedded in specs.
