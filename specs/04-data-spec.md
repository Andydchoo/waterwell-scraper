# 04 — Data and export contract

## Design rules

Preserve every retrieved public business-data field, including fields without a canonical mapping. This does not include session tokens, authentication responses, or unrelated portal account information. Store original public payloads and source field/type dictionaries with hashes. Export typed common fields for comparison and `source_fields` JSON for lossless source-specific attributes. Missing, unknown, redacted, and invalid are distinct states, never fabricated zeros.

Schema version starts at `1.0.0`. Implement schemas and machine-readable field dictionaries before adapters. Required structural fields fail validation if absent; optional absent fields are null. Source identity and provenance are required even when a record is otherwise sparse.

## Entities

| Entity | Identity | Required content |
| --- | --- | --- |
| Source well/record | `record_id` | Source, native ID or documented fallback, entity kind, county evidence, provenance, source fields, quality flags. |
| Construction/permit event | `event_id` | Source event ID, event type/date, nullable well reference, attributes and provenance. |
| Observation | `observation_id` | Source observation ID or stable composite, nullable well reference, parameter, original result/unit/time, qualifiers and provenance. |
| Document | `document_id` | Source document identity, source URL, title/type, county evidence, download status and provenance; hash/path when downloaded. |
| Relationship | `relationship_id` | Typed endpoints, relationship type, source evidence, and confidence/method. |
| Validation issue | `issue_id` | Entity/task reference, rule code, severity, field, reason and evidence reference. |

`record_id = source_id + ':' + dataset_id + ':' + native_id` with unambiguous escaping. IDs remain strings. Report/permit IDs must not automatically become physical well IDs. If no stable native ID exists, use a documented deterministic composite hash, mark `identity_method`, and report collision risks. Never use array/page position as identity. Some reports describe multiple wells: represent those associations explicitly.

Source entity kinds include `well`, `permit`, `report_index`, and `site`; sites are not automatically wells. Count exported source records separately from confidently identified wells. Cross-source links may identify likely matches, but v1 never automatically collapses records by owner, address, coordinates, or shared parcel. Exact agency cross-references can establish an explicit `same_well` link while preserving both source records.

## Canonical well fields

| Group | Fields and type/meaning |
| --- | --- |
| Identity | `record_id`, `source_id`, `dataset_id`, `native_id`, `entity_kind`, `identity_method`; strings. |
| Geography | `state_fips` (2 characters), `county_fips` (3), `county_geoid` (5), official names, `county_assignment_method`, source county value, conflict flags. |
| Coordinates | Original x/y and CRS; nullable WGS84 longitude/latitude; location method, reported accuracy, spatial precision, transformation metadata. |
| Location | Address, city, ZIP as string, parcel ID, site name, public owner/operator fields when exposed. No enrichment from unrelated sources. |
| Well description | Native and mapped use/type/status, aquifer, geology, driller and license identifiers. Unknown classifications retain native labels. |
| Construction | Completion date and precision; total depth, bore/casing diameter, casing and screen intervals, grout, pump setting, yield/pump-test details. Repeating intervals stay child arrays/tables. |
| Source time | Native creation/update times with timezone/precision if available; never substitute retrieval time for source update time. |
| Provenance | Retrieval time in UTC, source URL without secrets, raw artifact/hash, adapter/schema versions, source snapshot, run ID, and mapping version. |
| Preservation | `source_fields` object, quality flags, field-level transformation lineage for converted/derived values. |

A quantity is `{value, unit, raw_value, raw_unit, qualifier}`; normalized measurements additionally retain conversion formula/version. Default canonical depth in meters and yield in liters/second. Convert only recognized units; preserve ambiguous units as unknown. Zero is a valid numeric value unless the source dictionary explicitly defines a sentinel. Never infer yield units from a field name alone.

Reject invalid coordinate ranges and flag suspicious county conflicts. Do not transform unknown CRS coordinates as if they were WGS84. Request WGS84 from a verified service when supported; retain original geometry and declared CRS. Coarse coordinates remain coarse in the data dictionary and quality flags.

## Observations and histories

Store measurements as separate rows, never overwrite them with the latest value. Keep source observation/sample ID, observation kind, parameter/analyte code and label, original time/timezone/precision, numeric and text result, unit, result qualifier, detection/reporting limit, method, sample medium, laboratory, and source quality codes where exposed. Distinguish below-land-surface water depth from water-surface elevation and retain vertical datum/reference. Negative depth can be meaningful; do not apply a blanket nonnegative rule.

Results such as `<0.01` or `not detected` must retain their censoring/text and limits; do not turn them into zero or an exact measurement. Incompatible units or chemical bases are not converted. If a public observation lacks a trustworthy well link, preserve it with null `record_id`, source station metadata, and a validation warning. Relationships must not fabricate a match.

## Files produced per run

```text
<output>/<run-id>/
  manifest.json                 request, versions, sources, scope, artifact hashes
  summary.json                  final structured outcome
  summary.md                    readable collection log
  events.jsonl                  redacted structured activity log
  wells.csv / wells.jsonl       canonical source records
  construction.csv / .jsonl    construction and permit events
  observations.csv / .jsonl    available measurements and histories
  documents.csv / .jsonl       reports, associations, availability, hashes
  relationships.csv / .jsonl   explicit and candidate record links
  validation-errors.jsonl      quarantine/validation ledger
  field-dictionary.json        types, units, meanings, source mappings
  source-fields.jsonl          complete source attributes by entity ID
  attachments/<sha256>.<ext>   public document files
  raw/<source-id>/...          retained public source payloads and dictionaries
  state.sqlite                 durable local run state; excluded from share export
```

`.jsonl` is the streaming JSON format; provide `--json-array` to also emit valid JSON arrays as `.json` for consumers expecting ordinary JSON files. CSV files use UTF-8, a fixed header, proper quoting, ISO dates, and documented null semantics; repeated/nested values are encoded as JSON cells or separate relation tables, not flattened ambiguously. Neutralize spreadsheet formula-leading text in CSV and document the transformation; JSON/raw retain original values. The exporter records row counts and SHA-256 per file.

Write exports to staging paths and atomically publish them when complete. Empty datasets still have CSV headers and a manifest entry explaining `zero_records`, `not_available`, `not_requested`, or `failed`; these states differ. Include all validated records gathered before a partial failure. Rejected records stay in quarantine with recoverable raw evidence.

## Download semantics

Document states: `pending`, `downloaded`, `unavailable`, `blocked`, `failed`, `over_budget`, `unsupported_type`. Record content hash, byte count, content type, retrieval time, local relative path, and original public document identity. A login page saved with a PDF filename is a failure. Deduplicate bytes by hash while retaining every source association.

Original PDFs are the authoritative evidence. Text extraction/OCR into canonical fields is a separate later feature and is not implied by retaining all publicly exposed structured fields. The first release must say explicitly when useful fields exist only inside a downloaded report. Source attachments that cannot be retrieved are included in the final coverage gaps.
