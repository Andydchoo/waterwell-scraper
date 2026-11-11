# Implementation acceptance and operation

> **Note (2026-11-10).** This traceability table was written for the county-specific pilot. The adapters it cites were replaced by place-agnostic collectors; see [how the application acquires data](how-it-works.md). Requirements about storage, resume, exports, the dashboard and the explorer still apply; rows naming Mecklenburg or NC DEQ adapters are historical.

Data explorer specifications 11–13 are implemented. Their [separate acceptance evidence and operator guide](data-explorer.md) covers immutable search, details, report viewing, filtered exports, performance and verification limits. The original collector requirements remain below.

The local CLI implements the confirmed product requirements in specs 01–09. Data coverage is bounded by the selected published sources and the run's limits. A working adapter does not imply that an agency's entire historical collection is online.

| Requirement                         | Implementation                                                | Evidence / output                                                                                                                             |
| ----------------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| R-01: state/county input            | `src/geography`, `src/cli.ts`                                 | FIPS-preserving aliases, ambiguity and wrong-state tests; geography snapshot in each manifest                                                 |
| R-02: reusable county/state sources | `src/sources/registry.ts`, USGS and NC statewide adapters     | Registry scope shown by `sources`; unavailable local sources are disclosed                                                                    |
| R-03: Node and SPAs                 | Node 24, TypeScript, `src/transports/browser.ts`              | Real Angular portal initialization; Chromium fixture covers delayed rendering, result changes, popup, PDF and byte-budget interruption        |
| R-04: fields and provenance         | Source adapters, normalization, SQLite/export                 | Raw response hashes, all original fields, separate report records, explicit same-entry relationships, CSV/JSONL/JSON and attachment hashes    |
| R-05: local credentials             | `src/credentials`                                             | Bounded resolver, origin/expiry/permissions checks, dedicated sessions, manual login and optional in-run login; secret redaction tests        |
| R-06: durable logs                  | Runner, logger, store and export                              | `events.jsonl`, `summary.md/json`, manifest and attempt history; record/byte/duration/disk budgets and crash/recovery tests                   |
| R-07: implementation specifications | `specs/01` through `specs/09`                                 | Original contracts retained; this file and implementation notes record implemented behavior and differences                                   |
| R-08: broad Mecklenburg CLI         | County inventory/permits, Hyland, NC archive/monitoring, USGS | Live results and limitations in `docs/implementation.md`; full source fields, reports and observation exports                                 |
| R-09: local collection dashboard    | React/Vite client, Fastify API and detached Node workers      | Spec 10; state/county selection, coverage, progress, history, safe stop/resume, exports; backend lifecycle/access tests and Chromium workflow |

## Reproducible verification

Use Node 24 and install the locked dependencies and project-local Chromium as described in the README. Run:

```sh
npm run build
npm run lint
npm run format:check
npm test
npm run test:browser
npm run test:ui
```

`npm run test:scale` verifies a 100,000-record local HTTP/export workload. `npm run test:live` is an optional bounded public-source check. Normal tests do not depend on live agency websites or real credentials.

Archive contract fixtures cover empty results, duplicate/missing IDs, changed snapshots, multiple pages, county conflicts, partial budgets, cached-page resume, PDF generation polling, failed-download retry, blank file numbers, septic exclusion, date partition truncation, broken revisions and redacted errors. The local browser fixtures include a streaming response that exceeds the shared byte budget and a subprocess receiving SIGINT that must finish application cleanup. Dashboard tests add local access boundaries, export path checks, lifecycle durability and browser interaction coverage. See spec 10 for the precise tested scope.

## Operator workflow

1. Use `sources` or `collect --dry-run` to inspect the county's actual coverage.
2. For a large archive, collect metadata with `--attachments none` to assess volume. This is a separate run scope; start a new run with attachments enabled when the reports are wanted.
3. Run the selected sources with appropriate duration/byte limits. A budget stop is partial, with checkpoints and a resume command.
4. Resume the same run to continue its saved scope. Report failures and broken source date partitions are retried; committed source records and successful reports are skipped.
5. Inspect `summary.md`, `validation-errors.jsonl` and the declared exclusions. A successful source can still have unverified completeness if its public service lacks an immutable snapshot.
6. Use `report` to rebuild outputs offline. Keep raw data, checkpoints and attachments together; resume verifies cached archive response hashes.

## Deliberate limits

- The county historical laboratory-results candidate remains unsupported because its published app exposes no such table. It remains in the default source plan, causing an honest partial result.
- Unindexed/undated archive records cannot be audited. A confirmed Hyland broken revision is isolated to its date; that date remains unresolved rather than being treated as zero records.
- Report bytes and public metadata are retained; OCR, inferred cross-agency physical-well matching, continuous USGS time series and discrete laboratory samples are outside this release.
- Credentials are read from named application locations. Password/API-key values are not injected into an unverified login form. Browser sessions and manual authentication are supported; OS keychain providers, Windows ACL validation and authenticated diagnostic captures are deferred.
- Source requests are sequential. The CLI and dashboard run locally on macOS/Linux; containers and scheduled collection are deferred. The dashboard allows one active collection per output root; maps, record exploration and in-browser credential management are deferred.
- The original acceptance matrix includes future scenarios beyond these fixtures, such as report-to-many-well crosswalks and explicit virtualized-row extraction. The implemented archive adapters enumerate the portal's public data API after browser initialization and do not depend on visible rows.

See `docs/implementation.md` for dated live evidence and preserved unsuccessful attempts. These limits are disclosed scope, not evidence that every public record has been collected.
