# 13 — Data explorer delivery and acceptance plan

Status: E0–E5 delivered 2026-10-29. [Implementation and acceptance evidence](../docs/data-explorer.md) records actual behavior, measured performance, architectural adaptations and verification limits. The original delivery gates below remain the reference contract. Depends on [product decisions](11-data-explorer-product-spec.md) and [technical contracts](12-data-explorer-technical-spec.md).

## Implementation order

| Phase | Deliverable | Exit gate |
| --- | --- | --- |
| E0 — projection and performance proof | Source-specific field mappings, explicit link resolution, synthetic fixtures and a 100,000-record query prototype | Field semantics tested; query approach meets targets or is revised before UI integration |
| E1 — snapshot and query service | Rebuildable immutable search database, index lifecycle/status, query schema, counts, stable pagination, record/link APIs | Existing finalized runs are browsable without changing collection files; resume/build races and worker bounds tested |
| E2 — explorer and details | Collection entry point, navigation, filters, type-specific tables, deep links, detail/raw fields and explicit related records | Main lookup journey works with keyboard and mobile layout; empty/error/stale states are explicit |
| E3 — original reports | Verified document content endpoint, range handling, PDF/image panel and fallbacks | Valid local reports render/download; unavailable/corrupt/path-escape cases fail correctly |
| E4 — filtered exports | Shared serialization, separate export jobs/history, progress/cancel, exact-scope CSV/JSON/JSONL and manifests | Exported identities/count/order equal the query across all pages; interrupted or partial files never publish |
| E5 — integration and handoff | Regression tests, scale/browser evidence, documentation and operator workflow | Acceptance matrix below passes; original collection workflows continue to pass |

Deliver in this order, with a working lookup/detail path before adding report previews and export controls. Use E0's measured performance and field-mapping results to refine the implementation estimate and query design.

## Proposed file boundaries

Keep names adaptable to established repository conventions, but preserve these responsibilities:

- `src/explorer/types.ts`: versioned query/result/snapshot/export schemas.
- `src/explorer/project.ts`: canonical/source field projections, typed identifiers, dates, units and evidence.
- `src/explorer/snapshots.ts` and `index-worker.ts`: read-only capture, separate cache schema, generation publication and rebuild lifecycle.
- `src/explorer/query.ts`: one predicate/sort implementation shared by pages, counts and exports; prepared SQL only.
- `src/explorer/records.ts` and `reports.ts`: record payloads, explicit link resolution and validated file serving.
- `src/explorer/exports.ts` and `export-worker.ts`: bounded durable export jobs and publication.
- `src/dashboard/server.ts`: register explorer routes/hooks without expanding the existing collector job manager into an unrelated catch-all.
- `src/storage/serialize.ts` (proposed extraction): reusable serialization currently embedded in the full-run exporter; protect CLI output compatibility with fixtures.
- `web/src/explorer/`: explorer page, filters, result table, record details, report viewer, export dialog/history and URL-state helpers. Extract shared dashboard components as needed instead of adding all logic to the existing large `main.tsx` component.
- `tests/explorer-*.test.ts`, `tests/fixtures/explorer-*`, `scripts/explorer-scale-test.ts`: contracts, lifecycle, content serving, export parity, browser and bounded scale checks.

## Functional acceptance matrix

| ID | Required scenario and expected result |
| --- | --- |
| EX-01 | Open a finalized existing CLI collection; prepare an explorer snapshot without re-scraping or modifying its state, manifests, exports or reports |
| EX-02 | Open finalized partial, cancelled, unsupported and empty collections; show their actual coverage/outcome and useful records or explicit empty state |
| EX-03 | Search address, parcel, well ID, permit/file ID, site name and report title using canonical fields plus tested county/Hyland/DEQ fallbacks |
| EX-04 | Preserve leading-zero IDs, punctuation, Unicode, numeric zero, null and empty-string distinctions. `%`, `_`, quotes, colons and SQL-like text remain literals |
| EX-05 | Typed exact identifier filter cannot conflate parcel, well, permit/file and agency-entry IDs; multiple metadata values remain independently searchable |
| EX-06 | Combine type/source/dataset/status/use/flag filters; list and count match the same predicate; changing type clears incompatible filters visibly |
| EX-07 | Known meters/feet depths filter and sort correctly. Unknown units, censored results and absent values do not silently enter numeric ranges |
| EX-08 | Date filtering respects date meaning, epoch unit, timezone and partial precision; unparseable data remains visible as raw evidence and is not guessed |
| EX-09 | Navigate 25/50/100-row pages with duplicate sort values and missing fields in both directions; no skipped/duplicated identities. Reject a cursor from another query/snapshot |
| EX-10 | Refresh, deep link, browser Back/Forward and returning from details preserve collection, snapshot, filters, type and sort. Late fetch responses never replace a newer query |
| EX-11 | Detail view preserves original fields and provenance, pages large related lists, and shows explicit relationship evidence. No links are inferred from address/name/parcel proximity |
| EX-12 | Resolve NC DEQ report/construction links and verified observation parents; show unresolved/ambiguous references. Hyland and unverified ambient station links remain independent |
| EX-13 | Correctly display all report download states, including `not_requested`. Missing local bytes and content mismatch are distinct from source unavailability |
| EX-14 | View/download valid PDF, PNG and JPEG; TIFF and browser PDF limitations have a usable download fallback. HEAD, valid Range and invalid Range behave correctly |
| EX-15 | Reject report path traversal, encoded separators, escaping symlinks, unknown snapshot/document IDs, HTML disguised as PDF and changed hashes. No arbitrary file or remote URL serving |
| EX-16 | Export all filtered matches beyond the first page, for each supported type and CSV/JSON/JSONL. Match query identities, count and sort exactly; zero matches produces valid empty output |
| EX-17 | CSV formula escaping, quoting/newlines, nested JSON and additional fields remain compatible with CLI exports. JSON preserves the full original entity payload |
| EX-18 | Export manifest records scope, snapshot, mapping version, normalized query, count and content hash. Related entities/report bytes are excluded unless explicitly part of the chosen result type |
| EX-19 | Cancel or interrupt an index/export and simulate disk exhaustion. No partially built generation or export is presented as complete; originals stay intact; retry works |
| EX-20 | Resume a collection during an index build: reject the changed build. Resume after publication: existing query/export stays bound to the captured snapshot, with an older-attempt notice |
| EX-21 | Missing/corrupt cache or mapping-version change permits a rebuild. Old/new snapshots never mix rows, links, counts or export payloads |
| EX-22 | Invalid query combinations, oversized inputs, unsupported sorts, local-origin/token failures and worker saturation return bounded actionable errors |
| EX-23 | Keyboard-only navigation, focus restoration, labelled controls and status announcements work. At 390-pixel width the page does not overflow; table scrolling stays inside the table |
| EX-24 | Opening records, viewing files and exporting data issues no agency network requests and does not read credentials. Existing collection start/stop/resume and full downloads still pass |
| EX-25 | Cache/export cleanup affects derived artifacts only, refuses active dependencies, and produces an explicit stale-link state instead of silently switching snapshots |

## Data fixtures and evidence

Use synthetic/redacted fixtures rather than copying public owner addresses into committed tests. Fixtures should reflect structures observed in saved runs:

- Mecklenburg well/permit entities, including observations inherited from a well and unknown-unit depths.
- Hyland report-only records with named display fields, empty fields and changing opaque identifiers.
- NC DEQ construction/document/relationship triplets with multi-valued metadata and reports that may describe multiple wells.
- USGS monitoring locations and observations with explicit links, partial dates and nullable location/depth data.
- NC ambient observations with censored results and intentionally unverified station links.
- Same entity ID in different kinds/collections, ambiguous endpoints, missing parent records and duplicate hashes with multiple document identities.
- Invalid/missing report bytes, hostile text rendered as text, query injection strings, symlinks and truncated job artifacts.

Read-only integration against existing local verification runs supplements fixtures. Record counts by type, available mapped fields and link coverage; do not infer that a populated field mapping is valid merely because a few samples match. New date/unit mappings require source evidence or remain raw/unfilterable.

## Performance acceptance targets

These are the engineering targets used for this milestone. Measured results and workload limits are recorded in the [implementation evidence](../docs/data-explorer.md#performance); the targets alone are not a benchmark claim.

| Workload | Target |
| --- | --- |
| Initial 100,000-entity snapshot | At most 60 seconds on the documented development machine; progress visible within one second |
| Warm representative page + exact count | p95 at most 750 ms across at least 30 queries covering empty/broad/selective text, identifier, source, date and depth filters |
| Record detail + first linked page | p95 at most 500 ms, excluding report-file verification/rendering |
| Filtered export of 100,000 typical fixture rows | At most 60 seconds for CSV or JSONL; publish exact count/hash and report throughput |
| Aggregate Node memory during fixture index/export | Peak RSS below 1 GiB across the HTTP process and active worker processes; no full dataset loaded into browser memory |
| Dashboard responsiveness | Collector status/stop requests acknowledged within one second while one index or export runs; safe-stop completion still depends on the collector |
| UI payload | At most 100 compact result summaries per page; full original fields loaded only for opened records or streamed exports |

If targets fail, diagnose query plans, worker scheduling, indexes and serialization before adding a heavier search system. Large real-world payloads and giant PDFs require separate reported measurements; the fixture is not proof of unlimited scale.

## Verification commands and handoff

Verification commands are `npm run build`, `npm run lint`, `npm run format:check`, `npm test`, `npm run test:browser`, and `npm run test:ui`, plus the implemented `npm run test:explorer`, `npm run test:explorer-ui` and opt-in `npm run test:explorer-scale` scripts.

The browser journey must cover collection selection → preparation → search/filter → detail → linked report/fallback → return to preserved search → export all matches → verified download. Also cover an empty result, a partial collection, a stale snapshot after resume, worker failure and mobile layout. Offline/fixture tests must not contact agency websites or real credential providers.

The README and [explorer handoff](../docs/data-explorer.md) now describe actual results, commands and limits. Screenshots are generated under `test-results/explorer/`; synthetic fixtures remain separate from local public records.
