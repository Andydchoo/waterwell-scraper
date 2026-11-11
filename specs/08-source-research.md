# 08 — Research evidence and source onboarding

Research date: 2026-10-27. Official pages and service metadata were consulted. Search results and metadata are evidence for design, not proof of a completed live scrape. Exact endpoints, access policies, field schemas and pagination behavior must be rechecked when implementing an adapter.

## Pilot evidence

| Official source | Observation and design consequence |
| --- | --- |
| [Mecklenburg Environmental Health](https://eh.mecknc.gov/water) | Links public well permit records, well sampling results and the well information application. Follow these agency-designated routes rather than relying on a general search result alone. |
| [Census Mecklenburg QuickFacts](https://www.census.gov/quickfacts/mecklenburgcountynorthcarolina) | Confirms county FIPS `37119`. |
| [County ArcGIS GWS directory](https://edmsgis.mecklenburgcountync.gov/server/rest/services/GWS) | Lists multiple well services; inspect their scope and overlap rather than treating one layer as the entire inventory. |
| [County Hyland public records](https://mecknc.hylandcloud.com/241publicaccessgws/) | Publishes search and local-save instructions. Enumeration, caps, pagination and download behavior remain to be verified. |
| [NC DEQ groundwater resources](https://www.deq.nc.gov/about/divisions/water-resources/groundwater-resources) | Links a well-construction record search; the linked application requires browser inspection to establish its collection workflow. |
| [NC ambient groundwater monitoring](https://www.deq.nc.gov/about/divisions/water-resources/groundwater-resources/ambient-groundwater-quality-monitoring) | Offers a public data explorer; assess county-specific station/measurement coverage during the pilot. |
| [USGS Water Data APIs](https://api.waterdata.usgs.gov/) | Supplies monitoring-location and measurement services, including geographic metadata. Use as complementary monitoring data, not an inventory completeness claim. |

The detailed pilot adapter plan and verified metadata are in [spec 09](09-mecklenburg-nc-spec.md).

## Expansion evidence

| Source | Why it matters after the pilot |
| --- | --- |
| [Texas TWDB datasets and reports](https://www.twdb.texas.gov/groundwater/data/data-well-reports.asp) | Provides structured/bulk groundwater and drillers-report resources. Its caveats show why dataset coverage and coordinate quality belong in the output. |
| [California DWR well completion reports](https://water.ca.gov/Programs/Groundwater-Management/Wells/Well-Completion-Reports) | Publishes record-search and bulk data routes, illustrating a state adapter serving many counties. |
| [California report dataset](https://data.ca.gov/%40california-department-of-water-resources/well-completion-reports) | Lists tabular resources, report links and GIS access. An adapter can combine records and documents without navigating every map feature. |

These are expansion candidates only; no Texas/California adapter or nationwide coverage is claimed by this planning deliverable. Tool comparisons and technical references are cited alongside their decisions in specs 02, 03 and 05.

## Required onboarding record for every source

Create a source dossier containing:

1. Source ID/version, agency, official landing page, designated third-party hosts, and verification date.
2. Geographic and dataset scope, historical range, well categories, public-field availability, known missing populations.
3. Public query/download URLs, metadata endpoints, methods and exact filter mapping; do not store secrets or signed URLs.
4. Authentication requirement and exact allowed origins; credential profile name only.
5. Public access conditions, rate/download restrictions, robots guidance when applicable, attribution/license information, and any unresolved access limitation. Treat this as operational configuration, not a blanket legal conclusion.
6. Field dictionary, units, geometry CRS, identity stability, county assignment evidence, relationships and document joins.
7. Pagination/search caps, partition strategy, expected-count method, source snapshot/update markers, and proof of termination.
8. Representative redacted public fixtures: nonempty, empty, missing field, source error, capped result, download, and login challenge where relevant.
9. Bounded live verification results, acceptance-test IDs, coverage caveats, and maintenance owner.

An unresolved dossier item becomes a tracked implementation task or visible source limitation. An official-looking URL alone does not establish all-record access, stable identifiers, or attachment coverage.
