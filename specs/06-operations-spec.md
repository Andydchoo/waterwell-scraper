# 06 — CLI, configuration, lifecycle, and logs

## Commands

These commands are target interfaces; no executable has been built during planning.

```sh
well-scraper sources --state NC --county Mecklenburg
well-scraper collect --state 'North Carolina' --county Mecklenburg --output ./runs --json-array
well-scraper collect --state NC --county Mecklenburg --dry-run
well-scraper resume --run-id <run-id> --output ./runs
well-scraper report --run-id <run-id> --output ./runs
well-scraper auth status --source nc-deq-gw1
well-scraper auth login --source nc-deq-gw1
```

`sources` uses the local registry by default; `--probe` performs bounded read checks. `--dry-run` resolves geography, validates configuration, selects sources, and reports intended budgets without collecting records or logging in. Optional discovery is a separate `discover` command producing candidate metadata only.

`collect` options: `--state`, `--county` (required), `--source` (repeatable restriction), `--output`, `--config`, `--attachments all|none` (default all supported report types), `--json-array`, `--headful`, `--interactive-auth`, `--credential-profile`, `--max-duration`, `--max-bytes`, `--max-records`, `--log-level`. Defaults select all available historical datasets; partial date filters are future work unless a source requires date partitioning internally. No arbitrary executable selectors or secrets are accepted through CLI flags.

Configuration precedence: built-in defaults < source defaults < config file < allowlisted non-secret environment settings < CLI. Source-imposed ceilings always win over higher concurrency settings. Unknown config keys, invalid ranges, and unsupported requested formats fail validation. Persist the effective configuration with secrets and sensitive paths removed; hash only its public representation.

## Proposed defaults

| Setting | Value |
| --- | --- |
| HTTP collection concurrency | Global 4, per origin 1 |
| Browser contexts | Global 2, one active source navigation per origin |
| Minimum request/navigation interval | 1 second per origin; source rules may increase |
| Request / navigation / download timeout | 30 / 60 / 120 seconds |
| Retry budget | 4 total attempts per work item |
| Run duration | 2 hours per attempt |
| Download budget | 5 GiB total per attempt, 100 MiB per attachment |
| Record budget | 1,000,000 source records per attempt; streamed processing |
| Stop grace period | 15 seconds before browser teardown and final checkpoint |
| Retention | Local artifacts retained until explicit cleanup; diagnostics off by default |

These bounds prevent an unbounded job; they are adjustable. Budget exhaustion never means complete. Resume gets a new explicit attempt budget and retains cumulative counts/bytes. Bulk archive ingestion additionally needs uncompressed size/member limits and path traversal checks. No automatic deletion of previously collected data occurs.

## Run and attempt states

Allocate a run ID and writable output directory before collection preflight where possible. A run has one or more attempts, each with timestamps and terminal outcome. Lifecycle: `created -> planning -> running -> finalizing -> terminal`. Source tasks independently track pending, running, successful, retryable, quarantined, blocked, or failed states.

| Outcome | Meaning | Exit code |
| --- | --- | --- |
| `success` | Every selected task and requested supported dataset completed, exports/logs finalized, no known missing records | 0 |
| `partial` | Useful output exists but a source/task/download failed, coverage gap remains, or budget was hit | 2 |
| `failed` | No useful collection output and a collection or persistence failure occurred | 1 |
| `needs_auth` | No useful output and progress requires missing/expired credentials | 3 |
| `unsupported` | Geography resolves but no implemented suitable source is available | 4 |
| `invalid_input` | Invalid/ambiguous geography or configuration | 5 |
| `blocked` | No useful output and source access/policy challenge prevents collection | 6 |
| `cancelled` | User interrupted; checkpoint and available exports retained | 130 |

Outcome aggregation priority: interruption is cancelled; invalid input is invalid_input before network work; storage/export/log corruption is failed; otherwise unresolved failures/gaps with usable output are partial. With no usable output, unsupported applies only if no adapter can run; then classify remaining terminal source failures as failed, blocked, or needs_auth in that order. Verified zero results from every selected source can be success. Source states always remain visible, regardless of aggregate status.

Keep completeness separate: `verified`, `unverified`, `incomplete`, or `not_applicable`. Success with unverified completeness is permitted only when every known task ended correctly but the source exposes no authoritative total/snapshot; the report must say so prominently. Known truncation, unresolved source candidates, missing IDs, download failures, or quarantined required records force partial/incomplete. Explicit user exclusions do not cause failure but narrow the declared scope.

## Finalization and recovery

On normal exit, failure, or SIGINT/SIGTERM, stop scheduling, settle in-flight tasks within the grace period, commit durable work, close browsers, materialize available exports, and write final summaries. Avoid partial files being mistaken for complete ones. `manifest.json` records artifact publication status and hashes.

SIGKILL/power loss cannot run finalizers. `resume` or `report` detects a stale running attempt using process-lock/heartbeat evidence, marks that attempt interrupted, reconstructs counts from SQLite, and generates/rebuilds the log before continuing. Preserve prior attempt summaries under an attempts directory. A live lock prevents a second process from modifying the run.

If disk full/permissions prevent persistent logs, exit nonzero and print a minimal redacted error to stderr with the last known run ID/path. Do not promise a final log could be written in that case. Invalid arguments should generate a small failed-run report if a valid writable output location can be established; otherwise stderr explains the problem.

## Structured event contract

Append one JSON object per line with `timestamp` (UTC), `level`, `event`, `run_id`, `attempt_id`, nullable `source_id`, nullable `task_id`, `stage`, `duration_ms`, safe counters, `error_code`, and sanitized message. Use event names such as `run.started`, `source.selected`, `source.auth_required`, `request.retry`, `batch.committed`, `record.quarantined`, `document.failed`, `source.finished`, `run.finished`. Emit an aggregate heartbeat every 30 seconds during long jobs.

Log identifiers and counts rather than entire records, addresses, owner names, request bodies, headers, or HTML. Apply central structured and string redaction before serialization. Traces and screenshots are separate controlled artifacts per spec 05. No sample event data in this document represents an actual run.

## Final summary contract

`summary.json` MUST contain:

- Run/attempt IDs, start/end UTC times, duration, software/schema/adapter versions.
- Original state/county input, normalized geography, reference vintage.
- Outcome, completeness status, exit code, scope, deliberate exclusions, coverage gaps.
- Every planned source/dataset, selected transport, auth result without secrets, status, query filters and snapshot evidence.
- Per source/dataset: expected unique IDs when known; fetched, accepted, quarantined, excluded, duplicate, unresolved and exported counts; document counts and bytes by state.
- Request/retry counts; exhausted budgets; sanitized error codes and next actions.
- Export paths/hashes, checkpoint/resume information, raw evidence references, and source data caveats.

Counting rules: compare expected source items with unique handled source item IDs, not normalized row counts. One report can yield multiple entities. For known membership, `expected_unique = fetched_unique + unresolved_unique`; `fetched_unique = accepted_unique + quarantined_unique + excluded_unique`. Duplicated fetches are an additional activity counter, never added to unique totals. Nested observations and documents have separate ledgers. Unknown expected totals are null, never zero. Store source-record-to-entity lineage to explain differences.

`summary.md` renders the same facts with a source/dataset outcome table, output links, limits, errors, and a ready-to-copy resume command when appropriate. Distinguish unavailable upstream data from failed collection. `report` regenerates the report offline from durable state without refetching source data.
