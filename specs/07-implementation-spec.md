# 07 — Implementation plan and acceptance criteria

## Delivery sequence

| Milestone | Work | Exit evidence |
| --- | --- | --- |
| M0: Pilot source verification | Follow spec 09: verify public endpoints, field dictionaries, pagination, county scope, document workflows and sampling data; record caps and restrictions. | Source manifests classify each candidate as verified or an explicit gap; small public fixtures and exact query/link evidence. |
| M1: Core CLI and contracts | Node/TypeScript scaffold; config/schema validation; geography registry; run directories/SQLite migrations; source registry; logging and final report; credential interfaces. | Dry run resolves NC/Mecklenburg to 37119; invalid and unsupported inputs produce distinct results. |
| M2: HTTP collection | Shared transport, retry/budget handling, raw storage, normalization/export, ArcGIS ID reconciliation; Mecklenburg well layers. | Reconciled bounded live sample, multi-page fixture, lossless source fields, CSV/JSON artifacts with hashes. |
| M3: Browser and documents | Playwright lifecycle, dynamic search and popup/download handling; county Hyland and NC DEQ adapters; local session auth. | Public report fixtures and permitted live samples work; failed/capped archive enumeration is reported accurately. |
| M4: Broad pilot coverage | Sampling/observation adapters, source relationships, all verified pilot datasets, full county run within chosen budgets. | County report enumerates coverage by source, retains all fields/reports retrieved, and exposes every unresolved gap. |
| M5: Reliability and delivery | Crash/resume, secret redaction, source-change detection, packaging and operator documentation. | Acceptance suite below passes; reproducible installation and a documented full pilot result. |
| M6: Portability | Add another county, preferably reusing an NC statewide adapter; later add another state/portal. | New manifest/adapter without changes to core contracts; independent run artifacts. |

Do not call M4 complete solely because an inventory CSV exists. Public documents and observations are in the user's requested scope. If a source cannot be fully enumerated online, record that as an evidence-backed limitation and a follow-up item; do not substitute a fictitious complete result. No need to force another state's implementation into the initial Mecklenburg release.

## Required implementation artifacts

Package scripts for build, typecheck, lint, unit/contract tests, browser fixture tests, and explicit live smoke tests; locked dependencies; Node version pin; placeholder config and credential examples; gitignore for secrets/sessions/runs; source manifests; canonical/config/log JSON schemas; SQLite migrations; operator README with installation/browser setup, collection, auth, output definitions, resume, and source onboarding.

Each adapter must ship source evidence, field mapping, capability list, pagination/end-condition logic, county-filter evidence, and at least representative success/empty/failure fixtures. Official live sources are not a dependency of normal CI. Keep live checks opt-in and bounded; never place real credentials or private session data in fixtures.

## Acceptance matrix

| Test | Requirements | Scenario and required result |
| --- | --- | --- |
| A01 | R-01, R-08 | `NC/Mecklenburg` and full official names resolve to `37119`; wrong-state county, ambiguous alias, and unknown county fail before collection with candidates/reasons. |
| A02 | R-02 | Valid county lacking an adapter yields unsupported with coverage guidance; federal-only availability never claims comprehensive local inventory. |
| A03 | R-02, R-04 | Fixture has 4,501 ArcGIS features with 2,000 maximum response size; collect all expected IDs once and prove no truncation. Missing/duplicate IDs and mutated totals are detected. |
| A04 | R-03 | SPA fixture hydrates late, changes result pages asynchronously, virtualizes rows, and opens a PDF popup; collector waits on data/DOM conditions, gathers all IDs, and saves the PDF. |
| A05 | R-03, R-06 | Selector/schema change and login HTML returned as HTTP 200 fail clearly; genuine zero results are recognized separately. |
| A06 | R-04 | IDs with leading zeros, null/zero, unknown units, coarse coordinates, censored lab values, dates without timezone, and multiple construction intervals survive normalization without invented precision. |
| A07 | R-04, R-08 | Every public fixture field is mapped or preserved in source_fields/raw; JSON arrays and JSONL parse; CSV quoting/formula escaping is documented and verified. |
| A08 | R-04 | Nearby distinct wells remain separate; duplicate responses do not duplicate output; report-to-many-wells and orphan document cases preserve associations. |
| A09 | R-05 | Resolver precedence, incomplete profiles, expired sessions, origin mismatch and unsafe permissions produce deterministic errors; unrelated credential files remain unread. |
| A10 | R-05, R-06 | Seed test credentials in nested errors, redirect URLs, cookies and browser-login flows; no secrets appear in console, exports, logs or default diagnostics. |
| A11 | R-04, R-06 | 429 Retry-After, intermittent 503, blocked 403, per-file 404, wrong MIME and failed downloads produce bounded retries and correct partial/blocked outcomes. |
| A12 | R-06 | Interrupt after durable raw write, before DB commit, after DB commit and during export; resume reconciles work without loss/duplicates and rebuilds summaries. SIGKILL recovery is tested separately from graceful shutdown. |
| A13 | R-06 | Exhaust duration, record, byte and disk budgets; stop cleanly where possible, preserve durable progress, never report known incomplete results as success. |
| A14 | R-04, R-06 | Source item totals reconcile independently of entity/observation/document totals. Export hashes and summary counts match actual files. |
| A15 | R-06 | One source succeeds and another needs auth; overall partial, source-specific remediation and resume command are present. Verified all-empty run may succeed. |
| A16 | R-02, R-06 | Changed source fingerprint/adapter version on resume is detected; incompatible checkpoint is rejected or safely re-enumerated with explicit evidence. |
| A17 | R-04, R-05 | Unapproved download redirect, path traversal filename/archive, and local/private-network URL from a source are rejected; no credential forwarding occurs. |
| A18 | R-08 | Mecklenburg live pilot uses verified source scope, preserves all exposed fields and discovered report links, documents missing-source gaps, and reports honest completeness. |
| A19 | R-03, R-06 | Generated 100,000-record HTTP fixture exports without retaining the whole dataset in memory; target peak process RSS below 1 GiB excluding browser processes on a documented environment. |
| A20 | R-07 | Every confirmed requirement has an implementation owner/module, acceptance scenario, and documented output behavior. |

M5 acceptance requires core/fixture tests passing and a live pilot report with no unexplained count differences. A live source outage is recorded as unavailable evidence rather than hidden by disabling a required test. Full data coverage and a successfully functioning collector are distinct acceptance dimensions.

## Risk treatment

| Risk | Required response |
| --- | --- |
| Archive has no enumerable county listing | Investigate supported bulk/query partitions; seed known IDs only with an explicit incompleteness caveat; retain unresolved source gap. |
| Map layers overlap or IDs are report IDs | Keep per-source/dataset identity; link through verified agency crosswalks; avoid automatic physical-well totals. |
| Old/scanned documents contain additional fields | Preserve original files and mark extraction status; evaluate text/OCR as a separate enhancement. |
| Portal or API changes | Contract fingerprints, bounded probes, fixture maintenance and versioned adapters. |
| Huge histories/files | Streaming, budgets, checkpoints; accurate partial outcomes rather than silent clipping. |
| Sensitive local authentication | Named profile lookup, origin constraints, private storage, centralized redaction. |

## Implementation handoff prompt

Implement specs 01–09 in milestone order, starting with the Mecklenburg source-verification tasks and core CLI. Use Node.js/TypeScript and Playwright with direct API/download adapters where available. Preserve all publicly exposed fields and reports, keep credentials in named local profiles, and produce auditable final logs. Do not mark source coverage complete without enumeration evidence. Start with M0/M1, then validate each milestone against its listed acceptance scenarios.
