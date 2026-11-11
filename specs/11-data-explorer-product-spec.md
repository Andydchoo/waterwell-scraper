# 11 — Data explorer product specification

Status: implemented 2026-10-29 with the working defaults below. See [implementation, operator guidance and verification limits](../docs/data-explorer.md). Read with [technical contract](12-data-explorer-technical-spec.md) and [delivery and acceptance plan](13-data-explorer-delivery-plan.md).

## Objective

Let an operator find a collected source record, understand its fields and limitations, inspect explicitly linked records and original reports, and export the complete filtered result set without leaving the local dashboard.

This milestone adds four capabilities: a searchable explorer, record details, linked report viewing, and filtered exports. It reuses Node 24, TypeScript, React, Vite, Fastify and SQLite. It does not change the collector's source coverage or turn source records into a deduplicated census of physical wells.

## Decisions and working assumptions

| Topic | Decision for this plan | Basis |
| --- | --- | --- |
| Milestone | Explorer, details, report viewing, filtered exports | User accepted the proposed next milestone |
| Search scope | One saved collection at a time | Recommended working default; preference question sent, not yet answered |
| Primary workflow | Address, parcel, well ID and permit/file-number lookup | Working default; preference question sent, not yet answered |
| Collection state | Explore a published snapshot of an inactive, finalized attempt | Avoid changing results underneath pagination and exports |
| Incomplete collections | Include finalized partial, cancelled and unsupported runs, including empty datasets | A collection need not be successful to contain useful data |
| Live collections | Keep the progress screen; an existing explorer snapshot may remain viewable with an explicit older-attempt label | Live row-by-row indexing is outside this milestone |
| Data authority | Original entities, raw provenance and files remain authoritative; search mappings are derived | Preserve reproducibility and existing CLI behavior |
| Editing | Read-only records; no corrections or deletions from the explorer | Focus on finding and understanding collected evidence |

The implementation uses these working defaults following authorization to execute the plan. If multi-collection search is selected later, revise scope and identity/query contracts first: every result needs its collection identity, and repeated runs must remain distinguishable. Do not silently select the latest run per source or deduplicate results.

## User journeys

### Find a record

1. Open **Explore data** from collection details, or **Data explorer** from the main navigation and choose a collection.
2. See the county, collection timestamp, attempt, source coverage warning and snapshot status. On first use, see preparation progress instead of a blank table.
3. Choose Wells, Construction & permits, Observations, or Reports. Default to Wells when present, otherwise the first nonempty type in that order. Keep zero-count types visible.
4. Search an address, parcel, source well ID, permit/file number, report title or site name. Apply relevant filters. Show the exact matching source-record count and active filter chips.
5. Open a result, inspect its details, then return to the same query and page. Refresh and browser Back/Forward must preserve navigation state.

Relationships are shown within record details, not counted as another group of wells. Raw quarantined payloads are not ordinary explorer results; collection-level quarantine counts and the existing validation log remain available.

### Understand a record

The detail view contains:

- A descriptive title, entity type, source/dataset, native ID, collection and snapshot identity.
- Location and identifiers where published, including identifiers with leading zeros.
- Available construction information, dates with their meaning/precision, quantities with units and qualifiers, and observations where applicable.
- Explicitly linked parent records, observations and reports, paginated when necessary. Each link states its evidence. A missing referenced entity is shown as unavailable in this snapshot.
- Original source fields in a searchable, expandable key/value view, preserving arrays, nested objects, empty strings, nulls and numeric zero. Large fields load on demand; never silently truncate an exported value.
- Provenance: source URL, retrieval timestamp, raw relative path/hash, adapter/schema versions when present, and any derived-field mapping/version. The raw path is evidence text, not a general filesystem download link.
- Quality flags and relevant source coverage caveats. Missing data displays as unknown/unavailable rather than zero.

Only agency-established links are navigable as relationships. Shared addresses, parcel numbers, coordinates, names or document titles do not create links in this release. Hyland reports with no recorded association remain independently searchable reports. NC DEQ's same-entry document/construction link describes a source report record, not proof of one physical well.

### Inspect a report

From a report result or a linked-report list, open the local original PDF in a report panel/page. Show title, source, download state, file size and content hash. Provide **Download original** and, when valid, **Open source page**.

Use native PDF viewing for the initial release, with a visible open/download fallback when the browser cannot render it. PNG/JPEG files may display as images; TIFF files use download fallback. No OCR, extracted text search, remote document proxying, or automatic new source requests are included.

Metadata-only, failed, blocked, over-budget and unavailable reports show their actual stored status. A missing or changed local file shows a separate file-availability error; do not claim the agency never published it. Opening a report must not silently initiate a new scrape or authentication flow.

### Export matching records

**Export results** produces all matches for the selected record type and snapshot, not just the visible page. The dialog states the filters, exact row count, format and collection. Offer CSV, JSON array and JSONL.

Create the export in the background, with progress, completion, failure and cancellation states. A successful export has a downloadable data file and a companion metadata/manifest file containing the query, source collection, attempt, snapshot, mapping version, row count and SHA-256. Export zero matches as a valid empty result.

Preserve full original entity values and source fields, using the existing CSV escaping and nested-field conventions. Derived search/display fields are documented separately and do not overwrite source values. Related records, PDFs and other entity types are not automatically added; describe this scope in the dialog. Report bundles and manual row-selection exports are deferred.

## Search and filter behavior

Search is case-insensitive literal matching over the documented identifier, location, title and site-name fields. Multiple whitespace-separated terms use AND semantics; each may match a different searchable field. Punctuation is literal. No SQL, regular-expression, fuzzy, stemming or query-operator syntax is accepted. Show the search scope near the input; this is not a full-text search of every source field or PDF.

| Filter | Behavior |
| --- | --- |
| Record type | Exactly one of the four result types at a time |
| Source / dataset | Values from the selected snapshot; dataset options follow source selection |
| Exact identifier | Match a specified identifier family, preserving leading zeros and punctuation; disambiguate well, parcel, permit/file and agency-entry IDs |
| Well status / use | Preserve published labels; no invented cross-agency classifications |
| Depth | Inclusive bounds, explicitly chosen known unit; only exact numeric values with verified units are comparable |
| Date | User chooses a supported meaning: completion, permit issued, observation, or document date; never substitute retrieval time |
| Report association | On non-report types: any direct explicit report, downloaded direct report, or no direct report. It does not imply a cross-source match |
| Report download state | On Reports: exact stored statuses, including `not_requested`; local file availability shown separately |
| Quality flags | Exact flags present in this snapshot; distinguish no flags from evidence of verified completeness |

Depth inputs support meters and feet with an explicit conversion of known quantities. Unknown-unit or censored depths remain visible and can be selected with a separate **Unknown/unverified depth** filter; they are excluded from numeric depth ranges. Display how many records lack a comparable depth. Do not apply numeric observation comparisons across incompatible units or parameters; richer measurement analysis is deferred.

Date inputs are inclusive calendar dates. Source-specific mappings retain precision and timezone information. Coarse year/month dates use documented interval overlap, and are labelled approximate; unparseable dates are excluded from date ranges and remain inspectable as raw values. A filter is enabled only when its source-specific mapping has tests. Selecting a different record type clears incompatible filters with an explanation.

The default table has 50 rows per page (choices 25, 50, 100), stable ordering and server-side filtering. Supported sort choices are explicit; missing values sort last. Search changes reset pagination. The interface cancels obsolete requests and ignores late responses. Distinguish loading, indexing, no matches, empty source data, stale snapshot, unavailable collection and server failure.

Suggested lookup-first columns:

| Type | Initial columns |
| --- | --- |
| Wells | Well/site identifier or name, address, parcel, status, depth with unit, source |
| Construction & permits | Permit/file or source entry ID, record type, address, relevant date, source, linked report availability |
| Observations | Parameter, original result/qualifier, unit, observed date, linked record or unverified station, source |
| Reports | Title/type, file or entry number, address/parcel when available, document date, download state, source |

## Accessibility and presentation

Reuse the existing dashboard's colors, typography and components. Use semantic tables, labelled controls, keyboard-operable filters and detail/report navigation, visible focus, announced loading/error states, and sensible focus restoration. On small screens keep controls usable and table overflow contained. Do not require a map, hover interaction or color alone to understand a result.

Use URL query/hash state for collection, immutable snapshot, record type, filters, sort and record identity. Deep links stay local; they are not public share links. Keep credentials and session tokens out of URLs.

## Out of scope

Cross-collection search/comparison, inferred deduplication, maps, OCR, general PDF text search, scheduled refreshes, new county adapters, editing source records, charts/statistical analysis, remote hosting, saved-query libraries and report ZIP bundles. Existing collection, authentication and full-export workflows must remain operational.
