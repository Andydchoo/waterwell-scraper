import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  openSync,
  readSync,
  closeSync,
  lstatSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { hash, localDay, redact } from "../core/util.js";
import type {
  Config,
  Geography,
  SourceManifest,
  SourceResult,
} from "../core/types.js";
import { ScrapeError } from "../core/types.js";

export interface Job {
  runId: string;
  nonce: string;
  config: Config;
  resume: boolean;
  state: "starting" | "running" | "stopping" | "finished" | "failed";
  createdAt: string;
  updatedAt: string;
  pid?: number;
  error?: string;
}
export interface RunView {
  id: string;
  runId: string;
  // Local calendar day the collection started; runs and records are grouped by it.
  day: string;
  county: string;
  state: string;
  stateName: string;
  geoid: string;
  startedAt: string;
  updatedAt: string;
  outcome: string;
  active: boolean;
  managed: boolean;
  stoppable: boolean;
  resumable: boolean;
  recoverable: boolean;
  counts: Record<string, number>;
  attempt: number;
  attachments: string;
  sources: SourceResult[];
  sourcePlan: SourceManifest[];
  transport: {
    bytes?: number;
    requests?: number;
    browser_requests?: number;
    retries?: number;
  };
  error?: string;
  config?: Config;
}
export function jsonFile<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}
export function alive(pid?: number) {
  if (!pid || !Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}
export function jobActive(job?: Job) {
  if (!job || !["starting", "running", "stopping"].includes(job.state))
    return false;
  const age = Date.now() - Date.parse(job.updatedAt);
  return job.pid ? alive(job.pid) && age < 60000 : age < 20000;
}
export function runKey(root: string, dir: string) {
  return hash(relative(root, dir)).slice(0, 24);
}
export function discoverRuns(root: string) {
  const found: { id: string; dir: string }[] = [];
  function visit(dir: string, depth: number) {
    if (
      existsSync(join(dir, "state.sqlite")) ||
      existsSync(join(dir, "dashboard-job.json"))
    ) {
      if (
        existsSync(join(dir, "state.sqlite")) &&
        lstatSync(join(dir, "state.sqlite")).isSymbolicLink()
      )
        return;
      found.push({ id: runKey(root, dir), dir });
      return;
    }
    if (depth >= 3) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !entry.name.startsWith("."))
        visit(join(dir, entry.name), depth + 1);
    }
  }
  if (existsSync(root)) visit(root, 0);
  return found;
}
export function findRun(root: string, id: string) {
  if (!/^[a-f0-9]{24}$/.test(id))
    throw new ScrapeError("NOT_FOUND", "Run not found.");
  const found = discoverRuns(root).find((r) => r.id === id);
  if (!found) throw new ScrapeError("NOT_FOUND", "Run not found.");
  return found.dir;
}
export function readRun(root: string, dir: string): RunView {
  const job = jsonFile<Job>(join(dir, "dashboard-job.json"));
  let db: DatabaseSync | undefined;
  const meta: Record<string, unknown> = {};
  let counts: Record<string, number> = {};
  let sources: SourceResult[] = [];
  try {
    if (existsSync(join(dir, "state.sqlite"))) {
      db = new DatabaseSync(join(dir, "state.sqlite"), {
        readOnly: true,
        timeout: 500,
      });
      // The worker creates the file before publishing its complete schema.
      // Version zero is a starting collection; use job metadata until ready.
      const version = Number(
        db.prepare("PRAGMA user_version").get()!.user_version,
      );
      if (version > 1)
        throw new ScrapeError(
          "INCOMPATIBLE_RESUME",
          "Collection database was created by a newer application.",
        );
      if (version === 1) {
        for (const row of db
          .prepare(
            "SELECT key,value FROM meta WHERE key IN ('run_id','geo','config','sources','started_at','attempt','outcome','attempt_ended_at','progress','transport','day')",
          )
          .all())
          meta[String(row.key)] = JSON.parse(String(row.value));
        counts = Object.fromEntries(
          db
            .prepare("SELECT kind,count(*) n FROM entities GROUP BY kind")
            .all()
            .map((r) => [String(r.kind), Number(r.n)]),
        );
        sources = db
          .prepare("SELECT value FROM results ORDER BY source,dataset")
          .all()
          .map((r) => JSON.parse(String(r.value)) as SourceResult);
        const tasks = db
          .prepare(
            "SELECT source,dataset,status,count(*) n FROM tasks GROUP BY source,dataset,status",
          )
          .all();
        // Live ledgers are more recent than per-source summaries, which commit at source completion.
        for (const source of sources) {
          const rows = tasks.filter(
            (r) =>
              r.source === source.source_id && r.dataset === source.dataset_id,
          );
          source.accepted = 0;
          source.excluded = 0;
          source.quarantined = 0;
          for (const r of rows) {
            if (r.status === "accepted") source.accepted += Number(r.n);
            if (r.status === "excluded") source.excluded += Number(r.n);
            if (r.status === "quarantined") source.quarantined += Number(r.n);
          }
          source.fetched =
            source.accepted + source.excluded + source.quarantined;
          const saved = db
            .prepare("SELECT value FROM meta WHERE key=?")
            .get(source.source_id + ":" + source.dataset_id + ":ids");
          if (saved)
            source.expected = (
              JSON.parse(String(saved.value)) as unknown[]
            ).length;
          source.unresolved =
            source.expected === null
              ? null
              : Math.max(0, source.expected - source.fetched);
        }
      }
    }
  } finally {
    db?.close();
  }
  const config = (meta.config as Config | undefined) ?? job?.config;
  const geo = meta.geo as Geography | undefined;
  const workerActive = jobActive(job);
  const locked = alive(
    Number(
      existsSync(join(dir, ".lock"))
        ? readFileSync(join(dir, ".lock"), "utf8")
        : 0,
    ),
  );
  const active = workerActive || locked;
  const interrupted =
    !active &&
    (meta.outcome === "running" ||
      (job && ["running", "starting", "stopping"].includes(job.state)));
  const outcome = active
    ? job?.state === "stopping"
      ? "stopping"
      : job?.state === "starting"
        ? "starting"
        : "running"
    : interrupted
      ? "interrupted"
      : job?.error
        ? "failed"
        : String(
            meta.outcome ?? (job?.state === "failed" ? "failed" : "pending"),
          );
  const runId = String(meta.run_id ?? job?.runId ?? dir.split(sep).at(-1));
  const startedAt = String(meta.started_at ?? job?.createdAt ?? "");
  return {
    id: runKey(root, dir),
    runId,
    day: String(
      meta.day ??
        runId.match(/^(\d{4}-\d{2}-\d{2})_/)?.[1] ??
        (startedAt ? localDay(new Date(startedAt)) : "unknown"),
    ),
    county: geo?.county ?? config?.county ?? "Unknown county",
    state: geo?.state ?? config?.state ?? "",
    stateName: geo?.state_name ?? config?.state ?? "",
    geoid: geo?.county_geoid ?? "",
    startedAt,
    updatedAt: String(
      active
        ? (job?.updatedAt ?? meta.started_at)
        : (meta.attempt_ended_at ?? job?.updatedAt ?? ""),
    ),
    outcome,
    active,
    managed: !!job,
    stoppable: workerActive,
    resumable: !active && !!meta.config && outcome !== "success",
    recoverable: !!interrupted && !!meta.config,
    counts,
    attempt: Number(meta.attempt ?? 0),
    attachments: config?.attachments ?? "all",
    sources,
    sourcePlan: (meta.sources as SourceManifest[]) ?? [],
    error: job?.error,
    config,
    transport: (active
      ? (meta.progress ?? {})
      : (meta.transport ?? meta.progress ?? {})) as RunView["transport"],
  };
}
export function runList(root: string) {
  return discoverRuns(root)
    .flatMap(({ dir }) => {
      try {
        const view = readRun(root, dir);
        return [view];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
export function recentEvents(dir: string) {
  const path = join(dir, "events.jsonl");
  if (!existsSync(path)) return [];
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    const start = Math.max(0, size - 64 * 1024);
    const b = Buffer.alloc(size - start);
    readSync(fd, b, 0, b.length, start);
    const lines = b.toString().split("\n");
    if (start) lines.shift();
    return lines
      .filter(Boolean)
      .slice(-60)
      .flatMap((l) => {
        try {
          return [redact(JSON.parse(l))];
        } catch {
          return [];
        }
      });
  } finally {
    closeSync(fd);
  }
}
export function artifacts(dir: string) {
  const manifest = jsonFile<{
    publication_status: string;
    artifacts: Record<string, { bytes: number; rows?: number }>;
  }>(join(dir, "manifest.json"));
  const entries =
    manifest?.publication_status === "complete"
      ? Object.entries(manifest.artifacts ?? {})
      : [];
  const special = [
    "summary.md",
    "summary.json",
    "events.jsonl",
    "validation-errors.jsonl",
    "manifest.json",
  ];
  const names = new Map(entries.map(([name, detail]) => [name, detail]));
  for (const name of special)
    if (existsSync(join(dir, name)))
      names.set(name, { bytes: statSync(join(dir, name)).size });
  return [...names]
    .filter(([name]) => allowedArtifact(name))
    .map(([name, detail]) => ({ name, ...detail }));
}
function allowedArtifact(name: string) {
  return (
    /^(wells|construction|observations|documents|relationships)\.(csv|jsonl|json)$/.test(
      name,
    ) ||
    /^(summary\.(md|json)|events\.jsonl|validation-errors\.jsonl|manifest\.json|field-dictionary\.json|source-fields\.jsonl)$/.test(
      name,
    ) ||
    /^attachments\/[a-f0-9]{64}\.(pdf|png|jpg|tiff|csv|json|geojson|zip|xlsx|xls|kml|kmz|gpkg|gdb|txt|xml|bin)$/.test(
      name,
    )
  );
}
export function artifactPath(dir: string, name: string) {
  if (!allowedArtifact(name) || !artifacts(dir).some((a) => a.name === name))
    throw new ScrapeError("NOT_FOUND", "Export not found.");
  const path = resolve(dir, name);
  if (
    !existsSync(path) ||
    !realpathSync(path).startsWith(realpathSync(dir) + sep) ||
    !statSync(path).isFile()
  )
    throw new ScrapeError("NOT_FOUND", "Export not found.");
  return path;
}
