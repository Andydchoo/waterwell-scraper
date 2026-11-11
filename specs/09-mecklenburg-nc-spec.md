# 09 — Mecklenburg County, North Carolina pilot

## Confirmed target

State: North Carolina (`NC`, state FIPS `37`). County: Mecklenburg (`119`, combined GEOID `37119`, verified by [Census](https://www.census.gov/quickfacts/mecklenburgcountynorthcarolina)). Collect all publicly exposed well records and fields across the verified source plan, including available reports/PDFs, through a local Node.js CLI with CSV/JSON output.

Research established public landing pages and service metadata. It did not test complete live enumeration, authenticated access, archive search limits, document downloads, or county totals. The following tasks are the source-specific implementation plan, not claims of already working adapters.

## Planned adapters

| Source ID | Purpose | Initial transport / status |
| --- | --- | --- |
| `nc-mecklenburg-gws` | County well inventory and construction attributes across relevant layers | ArcGIS HTTP; metadata verified, queries and scope need live contract checks. |
| `nc-mecklenburg-hyland` | Well permit, construction and related public report files | Playwright/public download; landing instructions verified, search enumeration unverified. |
| `nc-deq-gw1` | State well-construction records and reports filtered to Mecklenburg | Playwright or verified public query/export; official entry point verified, schema and workflow unverified. |
| `nc-mecklenburg-sampling` | Public county sampling records and associated lab/report links | Inspect ArcGIS Experience application; underlying measurement endpoints unverified. |
| `nc-deq-ambient` | State monitoring measurements for county wells | Official explorer candidate; station membership, fields and export routes need verification. |
| `usgs-groundwater` | Federal monitoring locations and available groundwater observations | Official API family; verify current county/type filters and dataset availability. |

All are in the pilot investigation scope. Do not silently omit the measurement/report adapters to obtain a green inventory-only run. If a verified source has no Mecklenburg records, report a verified zero. If its availability cannot be determined, report an unresolved gap. Additional official sources discovered during onboarding enter the same coverage ledger.

## County ArcGIS inventory

Start from the county's [GWS service directory](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS), inspecting well-related services and their field/relationship metadata. Determine which FeatureServer and MapServer layers are alternate views of the same records. Select one canonical endpoint per logical dataset; preserve evidence for overlap decisions.

The [WIS MapServer](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/WIS/MapServer) lists ambient, private, public and monitoring well layers alongside non-well context layers. Ingest relevant well data; do not export parcels or contamination sites as wells just because they appear on the same map.

Initial verified endpoints:

- [Private well feature layer](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/Wells_Private/FeatureServer/0).
- [Permitted well map layer](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/Wells_Permitted/MapServer/0).
- [Ambient well layer](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/WIS/MapServer/1).
- [Alternate private well map layer](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/WIS/MapServer/2).

The private feature layer reports pagination support, a 2,000-record response cap, and no attachments; its CRS is listed as 102719/2264. It exposes construction, yield, contractor, location and multiple identity fields. Map them after verifying units and identity semantics; request all public attributes and preserve native values. Metadata flags do not establish a physically unique well key. [Private layer metadata](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/Wells_Private/FeatureServer/0).

The permitted layer also reports a 2,000-record cap and no attachments. Keep permit/application information as distinct events where appropriate. It cannot be assumed to supply PDFs. [Permitted layer metadata](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/Wells_Permitted/MapServer/0).

The ambient layer exposes well construction and static-water-level-related attributes. Its metadata associates the dataset with sampling work, but a well-location layer alone does not establish access to historical laboratory results. [Ambient metadata](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS/WIS/MapServer/1).

Implementation steps:

1. Fetch metadata as JSON; store field dictionaries, coded domains, object-ID field, geometry reference, relationships and service versions. Verify all proposed sibling layer IDs directly.
2. Establish county-only scope from agency documentation and a boundary check. If the service covers a larger area, use a verified county field/filter or exact boundary intersection with conflict handling. Do not infer geography from a service name or extent alone.
3. Obtain count/ID enumeration using supported read-only queries; freeze expected IDs per dataset where possible. Fetch conservative batches (initially 500, never exceeding the advertised cap), inspecting every response for errors/truncation.
4. Request all fields and geometry; preserve raw projected coordinates and verified WGS84 output. Verify depth/diameter/yield units through dictionaries or agency documentation before converting.
5. Retain agency identifiers separately from transport object IDs. Define source-native record identity only after uniqueness/null checks; use dataset-scoped object IDs as a documented fallback, not a cross-source well key.
6. Inspect explicit related tables and publicly linked files. Validate relationships before joining reports or measurements. Reconcile fetched IDs and refresh source counts/update markers at finalization.
7. Add fixtures for overlaps, missing geometry, abandoned wells, permits without completed wells, and records with null/duplicate agency IDs.

## County documents (Hyland)

Use [the public Well and Septic Permit Records portal](https://mecknc.hylandcloud.com/241publicaccessgws/), linked by the county's official page. Instructions describe a single search field at a time, partial matching, and opening a result in another window to save a copy. The shared portal includes septic records, so a verified well-document classification is required.

First inspect the actual browser UI: available fields, type filters, maximum results, pagination, stable document identifiers, frame/popup behavior and file-save routes. Prefer an exposed supported download; use Playwright for dynamic controls. Determine whether county-wide well records can be enumerated directly or via exhaustive supported partitions. A broad wildcard is not proof of completeness.

GIS file/application identifiers can seed searches if their meaning matches an exposed archive field. This approach cannot find archive-only wells and must be labeled incomplete unless an independent archive listing is reconciled. Preserve publicly returned report metadata even when association to a well is uncertain. Never construct guessed document IDs to probe hidden records. If a bulk export or human records request is needed, report the limitation and next action; do not send requests automatically.

## NC DEQ construction records

The [official groundwater page](https://www.deq.nc.gov/about/divisions/water-resources/groundwater-resources) links to [Laserfiche WebLink](https://edocs.deq.nc.gov/Groundwater/Welcome.aspx?cr=1&dbid=0&repo=WaterResources). The text fetch showed a loading shell, so navigation/filter controls still need browser verification.

Use the public retrieval application, not the submission form. Inspect county search/folder structure, record metadata, categories, pagination and original-document downloads. Confirm Mecklenburg filtering and historical coverage; retain report-only records and multi-well reports. Define a stable repository/document identity with observed values. If supported exports/public data calls exist, prefer them after verifying their scope and limits. Save construction and abandonment reports that are publicly linked and relevant; do not assume every GW-1 is a domestic water-supply well.

## Sampling and monitoring

The county links [this ArcGIS Experience application](https://experience.arcgis.com/experience/0cf7537a05f04a8e81a4376bce455670) for its well information and sampling results. Inspect public app configuration/network responses to identify the actual measurement layers/tables and permitted report links. Only register endpoints with observed public provenance. Confirm whether data represent raw, treated, or otherwise classified samples and preserve that field.

Inspect the [NC ambient data explorer entry point](https://www.deq.nc.gov/about/divisions/water-resources/groundwater-resources/ambient-groundwater-quality-monitoring) for Mecklenburg stations and measurement exports. Supplement with [USGS groundwater APIs](https://api.waterdata.usgs.gov/) using verified county and groundwater-type filters. Keep source histories separate; deduplicate across agencies only through explicit matching evidence. No drinking-water safety conclusion is generated by the collector.

## Pilot completion checklist

- A frozen source plan lists each adapter/dataset and its confirmed, unavailable, blocked or unresolved status.
- At least the private/permitted/ambient/public/monitoring well source candidates have been assessed for scope and overlap; missing sources have explicit reasons.
- Structured results reconcile against source IDs/counts where available and preserve all exposed public fields.
- Report enumeration and retrieval coverage are reported separately from inventory counts; archive-only records are retained where discoverable.
- Measurements retain result qualifiers, units, dates and source identifiers; unavailable histories are not fabricated from location layers.
- A full run and a resumed run produce matching source-identity sets for a frozen fixture snapshot, with no duplicated attachments or exports.
- Final logs identify gaps, source limitations and exact next actions. No total for all physical wells in Mecklenburg is claimed without supporting evidence.

Unknown source mechanics are implementation discovery tasks. The user has already supplied enough product direction to start implementation; no further confirmation is required for the local CLI plan.
