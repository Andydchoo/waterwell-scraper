import { createHash } from "node:crypto";
import { openSync, writeSync, closeSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, hash, now, redact } from "../core/util.js";
import {
  VERSION,
  SCHEMA_VERSION,
  type Config,
  type EntityKind,
  type Geography,
  type SourceManifest,
} from "../core/types.js";
import type { Store } from "./store.js";
export const kinds: EntityKind[] = [
  "wells",
  "construction",
  "observations",
  "documents",
  "relationships",
];
export const fields = [
  "id",
  "record_id",
  "source_id",
  "dataset_id",
  "acquisition_method",
  "native_id",
  "entity_kind",
  "county_geoid",
  "county_assignment_method",
  "longitude",
  "latitude",
  "address",
  "well_name",
  "well_use",
  "well_type",
  "well_status",
  "source_well_id",
  "file_number",
  "application_id",
  "total_depth",
  "casing_depth",
  "yield",
  "observed_at",
  "parameter",
  "result",
  "unit",
  "qualifier",
  "vertical_reference",
  "title",
  "download_status",
  "local_path",
  "sha256",
  "source_url",
  "retrieved_at",
  "raw_path",
  "raw_sha256",
  "quality_flags",
  "source_fields",
  "additional_fields",
];
export function csvCell(value: unknown) {
  let s =
    value === null || value === undefined
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  if (typeof value === "string" && /^[\s]*[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? '"' + s.replaceAll('"', '""') + '"' : s;
}
function writer(path: string) {
  const tmp = path + ".tmp";
  const fd = openSync(tmp, "w", 0o600),
    digest = createHash("sha256");
  let size = 0;
  return {
    write(text: string) {
      const b = Buffer.from(text);
      let offset = 0;
      while (offset < b.length) offset += writeSync(fd, b, offset);
      digest.update(b);
      size += b.length;
    },
    finish() {
      closeSync(fd);
      renameSync(tmp, path);
      return { sha256: digest.digest("hex"), bytes: size };
    },
  };
}
export function exportData(store: Store, config: Config) {
  const artifacts: Record<string, unknown> = {};
  for (const kind of kinds) {
    const csv = writer(join(store.dir, kind + ".csv")),
      jsonl = writer(join(store.dir, kind + ".jsonl")),
      json = config.jsonArray ? writer(join(store.dir, kind + ".json")) : null;
    csv.write(fields.join(",") + "\n");
    json?.write("[\n");
    let count = 0;
    for (const e of store.entities(kind)) {
      jsonl.write(JSON.stringify(e) + "\n");
      json?.write((count ? ",\n" : "") + JSON.stringify(e));
      const extra = Object.fromEntries(
        Object.entries(e).filter(([k]) => !fields.includes(k)),
      );
      csv.write(
        fields
          .map((k) => csvCell(k === "additional_fields" ? extra : e[k]))
          .join(",") + "\n",
      );
      count++;
    }
    json?.write("\n]\n");
    artifacts[kind + ".csv"] = { ...csv.finish(), rows: count };
    artifacts[kind + ".jsonl"] = { ...jsonl.finish(), rows: count };
    if (json) artifacts[kind + ".json"] = { ...json.finish(), rows: count };
  }
  const sourceFields = writer(join(store.dir, "source-fields.jsonl"));
  let n = 0;
  for (const kind of kinds)
    for (const e of store.entities(kind)) {
      sourceFields.write(
        JSON.stringify({ kind, id: e.id, source_fields: e.source_fields }) +
          "\n",
      );
      n++;
    }
  artifacts["source-fields.jsonl"] = { ...sourceFields.finish(), rows: n };
  const issues = writer(join(store.dir, "validation-errors.jsonl"));
  let issueCount = 0;
  for (const issue of store.issues()) {
    issues.write(JSON.stringify(issue) + "\n");
    issueCount++;
  }
  artifacts["validation-errors.jsonl"] = {
    ...issues.finish(),
    rows: issueCount,
  };
  const dictionaries: Record<string, unknown> = {
    schema_version: SCHEMA_VERSION,
    csv_null: "empty cell; JSON preserves null vs empty text",
    csv_formula_escape:
      "Leading formula characters in text get a single apostrophe; JSON preserves original",
    fields,
  };
  for (const r of store.results()) {
    const value = store.get(r.source_id + ":" + r.dataset_id + ":metadata");
    if (value) dictionaries[r.source_id + ":" + r.dataset_id] = value;
  }
  const dictionary = JSON.stringify(dictionaries, null, 2) + "\n";
  atomicWrite(join(store.dir, "field-dictionary.json"), dictionary);
  artifacts["field-dictionary.json"] = {
    sha256: hash(dictionary),
    bytes: Buffer.byteLength(dictionary),
  };
  for (const doc of store.entities("documents"))
    if (typeof doc.local_path === "string")
      artifacts[doc.local_path] = { sha256: doc.sha256, bytes: doc.byte_count };
  return artifacts;
}
export function aggregate(store: Store, cancelled = false) {
  const results = store.results(),
    useful = store.count() > 0;
  let outcome = "success",
    exitCode = 0;
  if (cancelled) {
    outcome = "cancelled";
    exitCode = 130;
  } else if (results.some((r) => r.status !== "success")) {
    if (useful) {
      outcome = "partial";
      exitCode = 2;
    } else if (results.every((r) => r.status === "unsupported")) {
      outcome = "unsupported";
      exitCode = 4;
    } else if (results.some((r) => ["failed", "partial"].includes(r.status))) {
      outcome = "failed";
      exitCode = 1;
    } else if (results.some((r) => r.status === "blocked")) {
      outcome = "blocked";
      exitCode = 6;
    } else if (results.some((r) => r.status === "needs_auth")) {
      outcome = "needs_auth";
      exitCode = 3;
    } else {
      outcome = "partial";
      exitCode = 2;
    }
  }
  return {
    outcome,
    exit_code: exitCode,
    completeness:
      outcome === "success"
        ? results.every((r) => r.completeness === "verified")
          ? "verified"
          : "unverified"
        : "incomplete",
  };
}
export function reconcileInterruptedResults(store: Store) {
  for (const result of store.results()) {
    const rows = store.taskCounts(result.source_id, result.dataset_id);
    result.accepted = rows
      .filter((r) => r.status === "accepted")
      .reduce((n, r) => n + Number(r.n), 0);
    result.excluded = rows
      .filter((r) => r.status === "excluded")
      .reduce((n, r) => n + Number(r.n), 0);
    result.quarantined = rows
      .filter((r) => r.status === "quarantined")
      .reduce((n, r) => n + Number(r.n), 0);
    result.fetched = result.accepted + result.excluded + result.quarantined;
    const key = result.source_id + ":" + result.dataset_id;
    result.expected =
      store.get<unknown[]>(key + ":ids")?.length ??
      store.get<number>(key + ":expected") ??
      result.expected;
    const partitions =
      result.dataset_id === "reports"
        ? result.source_id + ":dates"
        : `${result.source_id}:${result.dataset_id}:dates`;
    const dates = store.get<unknown[]>(partitions);
    if (dates)
      result.expected =
        dates.length ||
        store.get<unknown[]>(partitions + ":unavailable")?.length
          ? null
          : rows.reduce((n, r) => n + Number(r.n), 0);
    result.unresolved =
      result.expected === null
        ? null
        : Math.max(0, result.expected - result.fetched);
    if (result.status !== "success") {
      result.status = result.fetched ? "partial" : "cancelled";
      result.completeness = "incomplete";
      if (
        !result.errors.some((e) =>
          ["CANCELLED", "INTERRUPTED"].includes(e.code),
        )
      )
        result.errors.push({
          code: "INTERRUPTED",
          message:
            "Attempt was interrupted; counts rebuilt from committed checkpoints. Resume to continue.",
        });
    }
    store.result(result);
  }
}
export function finalize(store: Store, cancelled = false) {
  if (cancelled && store.get("outcome") === "running")
    reconcileInterruptedResults(store);
  const config = store.get<Config>("config")!,
    geo = store.get<Geography>("geo")!,
    sources = store.get<SourceManifest[]>("sources")!,
    runId = store.get<string>("run_id")!;
  atomicWrite(
    join(store.dir, "manifest.json"),
    JSON.stringify({ run_id: runId, publication_status: "in_progress" }),
  );
  const artifacts = exportData(store, config);
  const outcome = aggregate(store, cancelled);
  const attempts = store.get<number>("attempt") ?? 1;
  const ended = store.get<string>("attempt_ended_at") ?? now();
  store.set("attempt_ended_at", ended);
  const summary = {
    run_id: runId,
    attempt_id: attempts,
    started_at: store.get("started_at"),
    ended_at: ended,
    attempt_started_at: store.get("attempt_started_at"),
    duration_ms:
      Date.parse(ended) -
      Date.parse(
        store.get<string>("attempt_started_at") ??
          store.get<string>("started_at")!,
      ),
    original_input: { state: config.state, county: config.county },
    adapter_versions: Object.fromEntries(sources.map((s) => [s.id, s.version])),
    application_version: VERSION,
    schema_version: SCHEMA_VERSION,
    geography: geo,
    ...outcome,
    scope: {
      sources: sources.map((s) => s.id),
      attachments: config.attachments,
      exclusions: store.get("exclusions") ?? [],
      note: "Coverage is relative to selected published sources; counts are source records, not unique physical wells.",
    },
    counts: Object.fromEntries(kinds.map((k) => [k, store.count(k)])),
    sources: store.results(),
    transport: store.get("transport") ?? {},
    cumulative_transport: store.get("cumulative_transport") ?? {},
    artifacts,
    resume_command: `node dist/cli.js resume --run-id ${runId} --output ${JSON.stringify(config.output)}`,
    credential_values_included: false,
  };
  const safe = redact(summary);
  atomicWrite(
    join(store.dir, "summary.json"),
    JSON.stringify(safe, null, 2) + "\n",
  );
  const md = [
    `# Collection log: ${geo.county}, ${geo.state_name}`,
    "",
    `Run: ${runId}`,
    `Outcome: **${outcome.outcome}**; completeness: **${outcome.completeness}**.`,
    "",
    "Counts represent source records, not a census of physical wells.",
    "",
    "| Source / dataset | Status | Accepted | Quarantined | Unresolved |",
    "| --- | --- | ---: | ---: | ---: |",
    ...store
      .results()
      .map(
        (r) =>
          `| ${r.source_id} / ${r.dataset_id} | ${r.status} | ${r.accepted} | ${r.quarantined} | ${r.unresolved ?? "unknown"} |`,
      ),
    "",
    "## Coverage and errors",
    "",
    ...store
      .results()
      .flatMap((r) => [
        ...r.errors.map(
          (e) => `- ${r.source_id}/${r.dataset_id}: ${e.code} — ${e.message}`,
        ),
        ...r.caveats.map((c) => `- ${r.source_id}/${r.dataset_id}: ${c}`),
      ]),
    "",
    "## Files",
    "",
    ...Object.keys(artifacts).map((f) => `- [${f}](${f})`),
    "",
    "## Resume",
    "",
    "```sh",
    summary.resume_command,
    "```",
    "",
  ];
  atomicWrite(join(store.dir, "summary.md"), String(redact(md.join("\n"))));
  atomicWrite(
    join(store.dir, "manifest.json"),
    JSON.stringify(
      {
        run_id: runId,
        schema_version: SCHEMA_VERSION,
        application_version: VERSION,
        config,
        config_sha256: hash(JSON.stringify(config)),
        geography: geo,
        source_plan: sources,
        artifacts,
        publication_status: "complete",
        outcome: outcome.outcome,
      },
      null,
      2,
    ) + "\n",
  );
  mkdirSync(join(store.dir, "attempts"), { recursive: true });
  atomicWrite(
    join(store.dir, "attempts", `${attempts}.json`),
    JSON.stringify(safe, null, 2) + "\n",
  );
  store.set("outcome", outcome.outcome);
  return summary;
}
