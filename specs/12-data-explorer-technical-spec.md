# 12 — Data explorer technical contract

Status: implemented 2026-10-29. This design contract is retained for context; [implementation notes](../docs/data-explorer.md#implementation-choices) document the actual file/API layout, worker-thread lifecycle and deliberate adaptations. Existing collection databases retain their current schema.

## Verified repository baseline

Inspection of source code and read-only samples of existing verification runs establishes:

- `src/storage/store.ts` stores full entity JSON in `entities(kind,id,source,dataset,value)`, keyed by `(kind,id)`. Required entity fields are deliberately sparse; optional canonical fields differ by adapter.
- The five entity kinds are wells, construction, observations, documents and relationships. A run ID alone is not enough to identify an entity; use collection + kind + entity ID.
- `normalizeWell` maps county addresses, parcels, well IDs and file/application identifiers. Many county depth quantities have `unit: null` and a `source_units_unverified` flag.
- Hyland reports expose `source_fields.display_fields` with `File Number`, `Address`, `Parcel Number` and `Document Type`. They usually have `record_id: null`.
- NC DEQ retains `source_fields.metadata`, an array of named fields with value arrays. Sampled names include `Well Location - Street`, `Well Location - City`, `ID #`, `Date Well Completed`, `Document Date` and `Total Depth`. Metadata names alone do not establish units or date formats.
- NC DEQ emits document `record_id` and `relationships` with `from_id`, `to_id`, `relationship_type: describes_record`, and `evidence: same_source_entry_id`.
- County and USGS observations can reference a source record via `record_id`. NC ambient observations deliberately retain null links and `station_link_unverified`.
- `src/storage/export.ts` provides CSV formula escaping and lossless entity JSON export, but its fixed field list/writer are currently private helpers. Its full-run finalizer must not be invoked for filtered exports.
- `src/dashboard/runs.ts` already provides bounded run discovery, read-only queries and approved artifact-path validation. Current file downloads force `application/octet-stream`; report preview needs a separate explicit content route and scoped headers.

These are implementation findings, not claims that every stored row contains the sampled fields. Empty, missing, multi-valued and unexpected types need fixtures.

## Architecture decision: immutable derived search snapshots

Keep collection `state.sqlite`, manifests and raw files unchanged. Build a separate, disposable SQLite search database for each selected finalized attempt. The dashboard opens the collection database read-only in a background worker, reads a consistent transaction snapshot, derives search fields and captures the exact entity payloads used by details and exports.

Proposed layout under the configured output root:

```text
.dashboard/
  explorer/<run-key>/
    current.json
    <snapshot-id>/
      index.sqlite
      snapshot.json
  exports/<export-id>/
    job.json
    records.csv | records.json | records.jsonl
    manifest.json
```

All identifiers are server-generated/validated, not client paths. Private directory/file modes follow existing application conventions. Build in a temporary generation, then atomically publish the directory and update `current.json`. Never expose a partially built database. Cache failure cannot modify or invalidate the original collection.

### Snapshot eligibility and identity

Build only when the run is inactive, collection metadata is compatible, and `manifest.json` says publication is complete. Include finalized partial/cancelled/unsupported runs. An interrupted/unfinalized run must first use the existing recovery/report workflow; do not silently finalize it while browsing.

Record run key/ID, attempt, outcome, attempt end timestamp, manifest digest, source adapter versions, collection schema version, explorer mapping/schema versions, creation time, entity counts and a digest of the captured entity stream. The published snapshot ID identifies this immutable generation; equal entity IDs in another snapshot remain distinct versions.

Before and after the read transaction, check the run lock/job state and revision metadata. If the attempt changes or collection starts, discard the unpublished build and report `RUN_CHANGED`; retry after finalization. Do not attempt to index live mutations. If a completed snapshot already exists, it can remain readable while the collection resumes, labelled with its captured attempt. A newer snapshot is opt-in via **Refresh data**, never substituted underneath an open query or export.

Indexing runs outside Fastify's main event loop. Limit to one index build at a time per output root; deduplicate repeated requests for the same revision. Persist progress, failure and cancellation. On process/server restart, incomplete builds become interrupted and are safely restartable; no requirement to resume midway through an index build. Completed snapshots and exports survive restarts.

### Derived schema

| Table | Purpose |
| --- | --- |
| `snapshot_meta` | Identity, versions, captured coverage and counts |
| `records` | One row per `(kind,id)`: compact display/search fields, source/dataset, native ID, address/title/name, status/use, comparable depth, search text |
| `payloads` | Original entity JSON keyed by `(kind,id)`; avoid reading large payloads for table pages |
| `identifiers` | Multiple typed identifier values with original and normalized forms and field provenance |
| `dates` | Record key, date meaning, normalized interval/precision, raw value and source path |
| `links` | Typed resolved endpoints or explicitly unresolved targets, relationship evidence and source entity reference |
| `report_files` | Document key, captured download state, content-addressed relative path, expected hash/size and media type when verifiable |

Preserve multi-valued fields rather than joining them into an ambiguous identifier. Derived values include mapping provenance (source field path, transformation and mapping version). Retain only one physical report-file reference per hash where useful, while keeping all document associations.

Indexes should cover kind/source/dataset, supported stable sort keys, typed exact identifiers, date meaning/ranges, verified depth, and link endpoints. The first implementation uses parameterized SQL over normalized search fields with literal substring matching. Do not add an external search service. Benchmark before committing the query layer: if substring scans miss the agreed 100,000-record target, add a compatible SQLite search index while preserving literal-search behavior, punctuation, short identifiers and the same API contract.

## Field mapping contract

Implement a versioned projection module independent of the scraper adapters. Prefer valid canonical fields, then explicit source-specific fallbacks. Never recursively search arbitrary keys for something that resembles an address or date. Unknown source fields remain in record detail and full exports.

| Source | Search/display projection | Constraints |
| --- | --- | --- |
| Common | `id`, `native_id`, `source_well_id`, `facility_id`, `file_number`, `application_id`, `parcel_id`, `address`, `well_name`, `title` when present | Keep identifier families distinct; do not label every `native_id` a permit |
| Mecklenburg inventory | Existing canonical fields; source `Permit_Issued`, `InstallDate` only via tested date mappings | Existing unknown-unit depths stay unverified |
| Hyland | Named display fields for address, parcel, file number and document type | No parsing of report title into invented identifiers; no inferred well link |
| NC DEQ | Named metadata values for location, `ID #`, completion/document dates and document type | `ID #` initially labelled agency identifier; raw depth has unknown units unless evidence establishes them |
| USGS | Existing well name/ID, normalized meter depth, observation parameter/time and `record_id`; verified `construction_date` mapping | Preserve partial source date precision; missing referenced locations stay unresolved |
| NC ambient | Existing normalized depth, observation values/units/time and station name | Do not connect station names to wells by string similarity |

Canonical `total_depth` is comparable only when `value` is finite, the unit is recognized, and qualifiers do not mark a censored/approximate result. Reuse a small explicit meters/feet conversion table; preserve raw values and flags. Do not treat a missing value, missing unit or zero as equivalent.

Date mappings are allowlisted by source/dataset/field. Verify numeric epoch units and accepted string patterns with fixtures; avoid locale-dependent generic date parsing. Normalize date-only/partial dates to calendar intervals, retain precision, and interpret instants in UTC for filtering. Use interval overlap with the requested inclusive date range. Retrieval time is a separately labelled provenance field, not a substitute for source dates.

### Relationships

Resolve within the same snapshot. For document `record_id` and known observation mappings, use the documented target entity kind. For generic `from_id`/`to_id`, resolve only when the endpoint kind is known or the ID has exactly one eligible target; ambiguous/missing endpoints remain unresolved. Exclude self-links. Collapse redundant evidence into one displayed link while retaining evidence references. Do not use the same identifier across runs or sources as evidence of a physical-well match.

Report-association filters use direct explicit document links only, not address matches or arbitrary graph traversal. Pagination applies to child observations and reports as well as the main result list.

## Query and navigation contract

Use one validated query schema for table results, counts and exports. Fields: `kind`, optional `q`, source/dataset arrays, typed exact identifier, published status/use arrays, date meaning/from/to, known-unit depth bounds or unknown-depth mode, report-association/download-state filters, quality flags, sort key and direction, page size and cursor.

Defaults/bounds: 50 rows, maximum 100 per page; query text at most 256 characters and eight terms; bounded filter arrays (maximum 50 values each); only declared sorts/filter combinations; invalid or contradictory bounds return 400. Reject unrecognized keys. Empty search means all records of the selected type. Normalize search strings with Unicode NFKC and case folding without removing punctuation or leading zeros; preserve originals for display/export. Escape wildcard characters if SQL LIKE is used. Raw SQL/JSON paths are never accepted from a client.

All supplied filters combine with AND; multiple selected values within one filter combine with OR. Text tokens match literal substrings and combine with AND. Use fixed sort expressions and bind all values. Stable keyset pagination ends with `(kind,id)` as the tie-breaker, with explicit nulls-last ordering in both directions. A cursor binds snapshot ID, normalized query hash, sort, last sort value and identity. Reject mismatched/malformed cursors; never reuse them for a changed query.

Responses contain compact items, exact filtered `total`, `nextCursor`, snapshot identity, selected type, query summary and capability/missing-value counts needed to explain filters. Counts and rows must use the identical predicate. Fetch full payload only for an opened record. Cancel obsolete UI requests; bounded workers keep heavy read queries off the HTTP event loop. An internal query deadline returns a clear error instead of freezing progress/stop routes.

Use hash-based client routes initially so the existing static server need not guess SPA fallback routes. Serialize collection/snapshot/query/record state; encode entity IDs as opaque strings, never split them on colons. Keep tokens and filesystem paths out of navigation URLs.

## Proposed API

All routes retain the current loopback Host/Origin checks and token protection for mutations. Names below are additive; existing collection/download routes remain unchanged.

| Method / route | Contract |
| --- | --- |
| `GET /api/runs/:run/explorer` | Eligibility, available snapshots, current build status and captured revision |
| `POST /api/runs/:run/explorer` | Ensure/build requested current revision; 200 ready or 202 building; repeated request reuses a compatible build |
| `POST /api/runs/:run/explorer/cancel` | Cancel the run's in-progress index build without affecting collection |
| `GET /api/explorer/:snapshot/capabilities` | Types, sources/datasets, applicable filters, published labels and field coverage |
| `POST /api/explorer/:snapshot/query` | Validated query returns one page, exact count and cursor; POST keeps structured queries bounded and explicit |
| `GET /api/explorer/:snapshot/record?kind=…&id=…` | Original entity, derived-field provenance, compact link summary and quality/coverage context |
| `GET /api/explorer/:snapshot/links?kind=…&id=…&relation=…&cursor=…` | Bounded explicit related-record page with evidence |
| `GET /api/explorer/:snapshot/report?id=…&mode=inline\|download` | Resolve document identity to approved local file; never accept a client filename |
| `POST /api/explorer/:snapshot/exports` | `{query,format}` starts a durable export job; return 202 + export ID |
| `GET /api/explorer/exports/:export` | Status, captured query/snapshot, progress, error and completed artifact metadata |
| `GET /api/explorer/exports?snapshot=…` | Paginated persisted export history so jobs can be found after page/server restart |
| `POST /api/explorer/exports/:export/cancel` | Cancel only that derived export |
| `GET /api/explorer/exports/:export/download?artifact=data\|manifest` | Download only published job artifacts |

Return 404 for unknown opaque identities, 409 for changed revision/not-ready/ineligible build, 410 for an explicitly removed generation, 422 for corrupt/invalid report content, and 503 for bounded worker saturation. Use structured error codes (`RUN_CHANGED`, `SNAPSHOT_NOT_READY`, `INVALID_CURSOR`, `FILE_MISSING`, `FILE_CHANGED`, `EXPORT_INTERRUPTED`, etc.) with actionable text. Do not expose stack traces or secrets.

## Report content delivery

Resolve by snapshot document key, confirm its captured status is downloaded, and enforce the existing content-addressed filename allowlist. Resolve the opened file inside that collection's attachments directory, reject escaping symlinks, check regular-file type, size, signature and expected hash, and stream bytes. Cache successful verification only while file identity/size/mtime remain unchanged; revalidate changed files. Never serve an arbitrary local or remote URL.

Serve PDFs as `application/pdf`, PNG/JPEG with their image MIME types, and TIFF/unsupported rendering cases as attachments. Inline mode is limited to verified supported types. Implement HEAD and a single byte Range with correct 206/416 behavior so large PDFs do not require repeated full buffering. This new route can serve an older immutable snapshot's valid content-addressed report during a resumed collection; it does not expose that attempt's in-progress exports.

The shell needs same-origin framing for the report panel. Keep all other CSP restrictions; set an explicit `frame-src 'self'` on the shell, and an endpoint-specific `frame-ancestors 'self'` for permitted inline report responses. Do not weaken framing restrictions for arbitrary source content. Use browser-native PDF rendering with open/download fallback; validate behavior in real Chromium. External source links accept only HTTP(S), use a new tab with `noopener`/`noreferrer`, and never embed an authenticated source website.

## Filtered exports

Use a distinct bounded export worker pool (one active export per output root initially), separate from collector admission locks. Publish no files until complete. Export all matching records of one type from the immutable snapshot using exactly the table predicate and sort; page size/cursor do not restrict exports and are rejected/removed before hashing the export query.

Extract reusable entity serializers from `src/storage/export.ts` without changing existing full-run output semantics. Stream payloads and write with backpressure/bounded memory. CSV keeps the existing fixed fields, JSON cells, extra fields and formula escaping; JSON array/JSONL preserve complete original entities. Do not inject derived values into the source payload. Include normalized query, explicit type/scope, selected units/date meanings, row count, snapshot/attempt/mapping identities, timestamps, data hash and CSV/null conventions in a companion manifest.

Write to temporary files, check available disk space, then atomically publish data and a complete manifest. Cancellation/disk failure leaves no downloadable partial file. Persist job status outside the collection. Interrupted jobs after server/worker failure are marked interrupted and may be retried from the same snapshot; partial output is never offered as successful. Browsing and export must not fetch source websites or modify original manifests/checkpoints.

## Cache lifecycle and operational limits

Snapshot databases duplicate entity payloads, so report estimated/actual cache size and disk errors. Reuse compatible generations. Provide explicit **Clear explorer cache** for inactive generations and **Delete derived export** actions with dependency checks; exact endpoints can be added with those controls. Never delete collection data, reports, or generations referenced by active jobs. Do not silently garbage-collect a generation referenced by a saved export; either retain it or require explicit removal with a clear stale-link state. Cache corruption/version mismatch triggers rebuild from the original finalized run.

Use structured explorer/index/export events with IDs, duration, counts and error codes. Avoid logging raw address/parcel search text; retain query text only in the operator-requested private export manifest/job state where needed for reproducibility. Preserve existing credential redaction and same-origin controls. Query/index/export timeouts and worker limits must not disable collector status/stop operations.
