# 03 — Source discovery and adapter contract

## Registry and source selection

Maintain a version-controlled registry of verified sources. Each manifest MUST include source ID, adapter/version, agency, official landing page, allowed data/download/auth origins, geographic coverage, datasets, access mode, credential profile reference, field mapping, pagination method, source restrictions, rate/budget overrides, evidence URLs, last verification date, and support status (`candidate`, `verified`, `implemented`, `degraded`, `retired`). Verification of a landing page alone does not make an adapter implemented.

Selection order is county-specific inventory/documents, state inventory/documents, and federal observations. Multiple sources complement one another. For each source, prefer documented APIs or bulk files, then public application data endpoints whose use has been verified, then static HTML, then Playwright UI interaction. API/bulk access is still part of collection; browser navigation is not required when structured access is available.

`sources --state ... --county ...` lists matching implemented sources and relevant unresolved candidates. `collect` includes enabled applicable sources by default. Known relevant candidates lacking adapters produce explicit coverage gaps; they must not disappear from the plan. A `--source` restriction is recorded as an intentional exclusion.

Unknown counties resolve geographically but return `unsupported` if no suitable adapter exists. Optional discovery can search official agency landing pages and follow bounded links to public data catalogs; it writes candidate metadata, never executable scraper code. A search provider is optional configuration, not a prerequisite for normal collection. New hosts require a manifest update, and unknown source behavior cannot borrow credentials from an existing adapter.

## Logical adapter interface

The following is a design contract, not compiled code. Implement shared types in the core and runtime-validate adapter outputs.

```ts
interface SourceAdapter {
  manifest: SourceManifest;
  probe(ctx: SourceContext): Promise<ProbeResult>;
  plan(ctx: SourceContext, request: RunRequest): Promise<SourcePlan>;
  enumerate(ctx: SourceContext, checkpoint?: Checkpoint): AsyncIterable<WorkBatch>;
  fetch(ctx: SourceContext, item: WorkItem): Promise<RawEnvelope>;
  normalize(raw: RawEnvelope, mapping: MappingContext): NormalizedBundle;
  reconcile(ctx: SourceContext, ledger: SourceLedger): Promise<CompletenessEvidence>;
}
```

- `SourceContext`: bounded transports, origin-scoped credential access, cancellation signal, logger, geographic target, and immutable plan.
- `ProbeResult`: availability, authentication requirement, source schema fingerprint, capability changes, restrictions, snapshot metadata. Probe sends only bounded read requests.
- `SourcePlan`: datasets, partitions, county filter, expected counts/IDs if known, request estimates, and exclusions.
- `WorkBatch`: durable work items plus the candidate next cursor; core commits the cursor only after the batch is durable.
- `WorkItem`: stable key, kind (`record`, `observation`, `document`), source ID, dataset, parent references, query/cursor, and attempt count. No embedded secrets.
- `RawEnvelope`: payload/artifact reference, sanitized retrieval URL, UTC retrieval time, status/content type, checksum, source identity, and snapshot reference.
- `NormalizedBundle`: zero or more wells, report/event records, observations, documents, relationships, unmapped fields, and validation issues.
- `CompletenessEvidence`: count/ID reconciliation, terminal cursor evidence, missing IDs, rejected records, caps, and uncertainty.

Keep enumeration and record fetch separate even if a bulk file supplies both. Bulk adapters may emit envelopes without additional HTTP calls. Detail failure must retain available listing metadata and a failure record rather than silently dropping the well.

## Pagination and completeness

API adapters inspect metadata and respect page/transfer limits. Prefer a source-provided snapshot or stable ID enumeration. ArcGIS adapters should capture matching object IDs, fetch bounded ID batches, compare returned IDs, and inspect transfer-limit signals. Where ID enumeration is unavailable or capped, use supported ordered pagination or documented query partitions and reconcile each partition. Never conclude completeness from one default-size response. See [ArcGIS query documentation](https://developers.arcgis.com/rest/services-reference/enterprise/query-feature-service-layer/).

For mutable sources, record start/end counts and source update markers. Changes or unstable offsets produce uncertainty rather than false completeness. Detect repeated cursors, repeated page IDs, and non-progress loops. Stop with a structured pagination error after two consecutive no-progress iterations.

For HTML/SPAs, paginate until a verified end indicator and cross-check any displayed total. Infinite-scroll/virtualized lists require tracking unique source IDs, not counting mounted DOM rows. If the source caps searches, partition by a documented field or return `partial`; never presume a wildcard search returned the whole county. Preserve a verified zero-result state separately from a broken selector or login screen.

## SPA navigation

Use role/label locators where available and documented stable CSS attributes otherwise. Wait for source-specific results, response completion, or loading indicators to settle after hydration. Do not use a fixed delay or `networkidle` alone as a success condition. Register download/popup listeners before clicking; validate the destination origin, actual file content, and durable completion. Handle frames, popups, and async tables explicitly. [Playwright page API](https://playwright.dev/docs/api/class-page), [actionability](https://playwright.dev/docs/actionability).

Read-only network responses may supply data if the adapter verifies their relationship to the public UI and documents the endpoint. Do not infer endpoint parameters or document IDs and enumerate arbitrary objects. Only collect IDs and links actually exposed by the source's documented or observed public query results.

## Throttling and failure handling

Default one active collection request per origin with at least 1,000 ms between starts, maximum four global HTTP work items and two browser contexts. Browser subresource traffic is not a separate record task; serialize navigations per origin and honor throttling signals from any response. Rate limits may be stricter per source. Avoid blocking resources until fixtures prove that doing so preserves functionality.

Use at most four total attempts for transient transport failures, timeouts, HTTP 408/429, and selected 5xx responses. Exponential backoff starts at 2 seconds, capped at 60 seconds, with jitter. `Retry-After` is a minimum; if it exceeds the remaining run budget, checkpoint and report a paused/partial attempt instead of retrying early. A short response or HTTP 200 does not prove success: inspect API error envelopes, login pages, and expected content schemas.

401 permits one configured session refresh; continuing failure yields `needs_auth`. 403/access challenges yield `blocked` unless a documented login requirement is identified. A missing document (404) is recorded per document. Schema/selector failures do not trigger blind repeated retries. Five consecutive transient failures open an origin circuit breaker and stop that source for the attempt. Other independent sources continue.

## Documents and nested data

Enumerate all public related tables/observations/document links exposed by the selected source, not just the initial well list. Preserve nested tables and unrecognized fields in raw evidence and `source_fields`. Non-PDF public attachments are downloaded if their type is supported by the configured safe-download policy; unsupported types retain metadata and a reported gap. Validate filenames, paths, content type/signature, sizes, and hashes. Never execute downloaded content.

Initial attachment types: PDF, JPEG, PNG, TIFF, plain text, CSV, and agency-provided ZIP archives containing supported files. Source-specific extensions require a manifest update and content validation. Preserve downloaded spreadsheet/document formats only after explicitly adding their media types; do not execute embedded macros or active content. Treat unsupported required attachments as a coverage gap, not successful downloads.

Transport validation applies to initial requests and every redirect: allow only manifest-approved HTTP(S) origins (HTTPS by default), reject embedded URL credentials and local/private/link-local network destinations, and validate resolved addresses at connection time. Browser subresource/auth origins must be enumerated separately from record/download origins. Do not let a source-provided link turn into local file access. Public fixtures may use loopback only in explicit test mode. Restrict collection to read operations, including verified read-only POST query endpoints where needed.

Document search results may be valid county records even when no well ID is available; retain them as unlinked documents with county evidence. A source that only allows address searches cannot guarantee a complete archive from GIS addresses alone. Log that limitation and investigate supported bulk/listing alternatives during onboarding.

## Source maintenance

Capture field names/types, query behavior, and selected public fixture responses during onboarding. Unknown additional fields are preserved; disappearance/type change of identity, county, pagination, or essential linkage fields fails the source contract. Adapter maintenance requires fixture updates, live bounded verification, and an incremented adapter version. All live writes to source portals remain outside the collector's responsibilities.
