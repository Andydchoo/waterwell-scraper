import type { FastifyInstance } from "fastify";
import { DatabaseSync } from "node:sqlite";
import { createReadStream, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ScrapeError } from "../core/types.js";
import { discoverRuns, readRun, type RunView } from "../dashboard/runs.js";
import { csvCell, fields as csvFields, kinds } from "../storage/export.js";

// Read-only data API over everything collected under the run root.
// Records are grouped by collection day: /api/v1/days/<YYYY-MM-DD>/records
// returns what every run of that day stored, across counties and collectors.
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Kind = z.enum([
  "wells",
  "construction",
  "observations",
  "documents",
  "relationships",
]);
const Filter = z
  .object({
    kind: Kind.default("wells"),
    day: Day.optional(),
    from: Day.optional(),
    to: Day.optional(),
    state: z.string().max(64).optional(),
    county: z.string().max(128).optional(),
    run: z.string().max(128).optional(),
    source: z.string().max(128).optional(),
    dataset: z.string().max(512).optional(),
    approach: z.enum(["api", "browser", "download"]).optional(),
    q: z.string().max(200).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    offset: z.coerce.number().int().min(0).default(0),
    format: z.enum(["json", "csv"]).default("json"),
  })
  .strict();
type Filter = z.infer<typeof Filter>;
interface StoredRun extends RunView {
  dir: string;
}
const fold = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/ (county|parish|borough|census area|municipality|city)$/, "");
function runs(root: string): StoredRun[] {
  return discoverRuns(root)
    .flatMap(({ dir }) => {
      try {
        return existsSync(join(dir, "state.sqlite"))
          ? [{ ...readRun(root, dir), dir }]
          : [];
      } catch {
        return [];
      }
    })
    .sort(
      (a, b) =>
        a.day.localeCompare(b.day) || a.startedAt.localeCompare(b.startedAt),
    );
}
function matching(all: StoredRun[], f: Partial<Filter>) {
  return all.filter(
    (r) =>
      (!f.day || r.day === f.day) &&
      (!f.from || r.day >= f.from) &&
      (!f.to || r.day <= f.to) &&
      (!f.run || r.runId === f.run || r.id === f.run) &&
      (!f.state ||
        [r.state, r.stateName].some(
          (s) => s.toLowerCase() === f.state!.trim().toLowerCase(),
        )) &&
      (!f.county || fold(r.county) === fold(f.county) || r.geoid === f.county),
  );
}
const summary = (r: StoredRun) => ({
  run_id: r.runId,
  day: r.day,
  state: r.state,
  county: r.county,
  county_geoid: r.geoid,
  started_at: r.startedAt,
  updated_at: r.updatedAt,
  outcome: r.outcome,
  active: r.active,
  attempt: r.attempt,
  counts: r.counts,
  records: `/api/v1/runs/${encodeURIComponent(r.runId)}/records`,
});
function open(run: StoredRun) {
  return new DatabaseSync(join(run.dir, "state.sqlite"), {
    readOnly: true,
    timeout: 2000,
  });
}
function where(f: Filter) {
  const clauses = ["kind = ?"];
  const args: (string | number)[] = [f.kind];
  if (f.source) {
    clauses.push("source = ?");
    args.push(f.source);
  }
  if (f.dataset) {
    clauses.push("dataset = ?");
    args.push(f.dataset);
  }
  if (f.approach) {
    clauses.push("json_extract(value, '$.acquisition_method') = ?");
    args.push(f.approach);
  }
  if (f.q) {
    clauses.push("value LIKE ? ESCAPE '\\'");
    args.push("%" + f.q.replace(/[\\%_]/g, "\\$&") + "%");
  }
  return { sql: clauses.join(" AND "), args };
}
/** One page of records merged across the matching runs, in day then run order. */
export function queryRecords(root: string, f: Filter) {
  const selected = matching(runs(root), f);
  const { sql, args } = where(f);
  const records: Record<string, unknown>[] = [];
  let total = 0;
  let skip = f.offset;
  for (const run of selected) {
    let db: DatabaseSync | undefined;
    try {
      db = open(run);
      const count = Number(
        db.prepare(`SELECT count(*) n FROM entities WHERE ${sql}`).get(...args)!
          .n,
      );
      total += count;
      if (records.length < f.limit && skip < count) {
        for (const row of db
          .prepare(
            `SELECT value FROM entities WHERE ${sql} ORDER BY id LIMIT ? OFFSET ?`,
          )
          .all(...args, f.limit - records.length, skip))
          records.push({
            ...(JSON.parse(String(row.value)) as Record<string, unknown>),
            collected_day: run.day,
            run_id: run.runId,
          });
        skip = 0;
      } else skip = Math.max(0, skip - count);
    } catch {
      // A run that is still creating its database simply has nothing to return yet.
    } finally {
      db?.close();
    }
  }
  return {
    filters: Object.fromEntries(
      Object.entries(f).filter(
        ([k, v]) =>
          v !== undefined && !["limit", "offset", "format"].includes(k),
      ),
    ),
    total,
    offset: f.offset,
    limit: f.limit,
    next_offset:
      f.offset + records.length < total ? f.offset + records.length : null,
    runs: selected.map((r) => r.runId),
    records,
  };
}
function days(all: StoredRun[]) {
  const grouped = new Map<string, StoredRun[]>();
  for (const run of all)
    grouped.set(run.day, [...(grouped.get(run.day) ?? []), run]);
  return [...grouped]
    .map(([day, list]) => ({
      day,
      runs: list.length,
      counties: [...new Set(list.map((r) => `${r.county}, ${r.state}`))],
      counts: Object.fromEntries(
        kinds.map((k) => [k, list.reduce((n, r) => n + (r.counts[k] ?? 0), 0)]),
      ),
      records: `/api/v1/days/${day}/records`,
    }))
    .sort((a, b) => b.day.localeCompare(a.day));
}
export async function dataApiRoutes(app: FastifyInstance, root: string) {
  const send = (
    reply: { type(t: string): unknown; header(k: string, v: string): unknown },
    f: Filter,
  ) => {
    const page = queryRecords(root, f);
    if (f.format !== "csv") return page;
    const columns = ["collected_day", "run_id", ...csvFields];
    reply.type("text/csv; charset=utf-8");
    reply.header("X-Total-Count", String(page.total));
    return (
      columns.join(",") +
      "\n" +
      page.records
        .map((e) =>
          columns
            .map((k) =>
              csvCell(
                k === "additional_fields"
                  ? Object.fromEntries(
                      Object.entries(e).filter(
                        ([key]) => !columns.includes(key),
                      ),
                    )
                  : e[k],
              ),
            )
            .join(","),
        )
        .join("\n") +
      "\n"
    );
  };
  app.get("/api/v1", async () => ({
    name: "Water well scraper data API",
    description:
      "Read-only access to stored collection data. Records are grouped by the local calendar day they were collected.",
    endpoints: {
      "GET /api/v1/days":
        "Collection days, newest first, with run and record counts.",
      "GET /api/v1/days/{day}": "Runs and totals for one day (YYYY-MM-DD).",
      "GET /api/v1/days/{day}/records":
        "All records collected that day, across runs.",
      "GET /api/v1/records": "Records across days; filter with day, from, to.",
      "GET /api/v1/runs": "Every stored run with its day, county and counts.",
      "GET /api/v1/runs/{run_id}":
        "One run: outcome, per-collector results, counts.",
      "GET /api/v1/runs/{run_id}/records": "Records stored by one run.",
      "GET /api/v1/record?kind=&id=":
        "One record by ID (add run= to pick a run).",
      "GET /api/v1/files/{sha256}":
        "A stored report or data file by content hash.",
    },
    record_filters: {
      kind: Kind.options,
      state: "State abbreviation or name",
      county: "County name or 5-digit GEOID",
      source: "Collector ID",
      dataset: "Dataset ID within a collector",
      approach: ["api", "browser", "download"],
      q: "Text contained anywhere in the stored record",
      limit: "1-1000 (default 100)",
      offset: "Rows to skip; use next_offset from the previous page",
      format: ["json", "csv"],
    },
  }));
  app.get("/api/v1/days", async () => ({ days: days(runs(root)) }));
  app.get("/api/v1/days/:day", async (request) => {
    const { day } = z.object({ day: Day }).parse(request.params);
    const list = matching(runs(root), { day });
    if (!list.length)
      throw new ScrapeError("NOT_FOUND", "Nothing was collected on that day.");
    return { ...days(list)[0], run_list: list.map(summary) };
  });
  app.get("/api/v1/days/:day/records", async (request, reply) => {
    const { day } = z.object({ day: Day }).parse(request.params);
    return send(reply, Filter.parse({ ...(request.query as object), day }));
  });
  app.get("/api/v1/records", async (request, reply) =>
    send(reply, Filter.parse(request.query)),
  );
  app.get("/api/v1/runs", async (request) => {
    const f = Filter.pick({
      day: true,
      from: true,
      to: true,
      state: true,
      county: true,
    })
      .strict()
      .parse(request.query);
    return { runs: matching(runs(root), f).map(summary).reverse() };
  });
  const one = (id: string) => {
    const run = matching(runs(root), { run: id })[0];
    if (!run) throw new ScrapeError("NOT_FOUND", "Run not found.");
    return run;
  };
  app.get("/api/v1/runs/:run", async (request) => {
    const { run } = z
      .object({ run: z.string().max(128) })
      .parse(request.params);
    const found = one(run);
    return {
      ...summary(found),
      attachments: found.attachments,
      collectors: found.sourcePlan.map((s) => ({
        id: s.id,
        approach: s.approach,
        title: s.title,
      })),
      results: found.sources,
      transport: found.transport,
    };
  });
  app.get("/api/v1/runs/:run/records", async (request, reply) => {
    const { run } = z
      .object({ run: z.string().max(128) })
      .parse(request.params);
    return send(
      reply,
      Filter.parse({ ...(request.query as object), run: one(run).runId }),
    );
  });
  app.get("/api/v1/record", async (request) => {
    const q = z
      .object({
        kind: Kind,
        id: z.string().min(1).max(8192),
        run: z.string().max(128).optional(),
      })
      .strict()
      .parse(request.query);
    const found: Record<string, unknown>[] = [];
    for (const run of matching(runs(root), { run: q.run })) {
      let db: DatabaseSync | undefined;
      try {
        db = open(run);
        const row = db
          .prepare("SELECT value FROM entities WHERE kind = ? AND id = ?")
          .get(q.kind, q.id);
        if (row)
          found.push({
            ...(JSON.parse(String(row.value)) as Record<string, unknown>),
            collected_day: run.day,
            run_id: run.runId,
          });
      } catch {
        // Skip a run whose database is not readable yet.
      } finally {
        db?.close();
      }
    }
    if (!found.length) throw new ScrapeError("NOT_FOUND", "Record not found.");
    // The same source record can be collected on several days; newest first.
    return { records: found.reverse() };
  });
  app.get("/api/v1/files/:sha", async (request, reply) => {
    const { sha } = z
      .object({ sha: z.string().regex(/^[a-f0-9]{64}$/) })
      .parse(request.params);
    for (const run of runs(root)) {
      const dir = join(run.dir, "attachments");
      if (!existsSync(dir)) continue;
      const name = readdirSync(dir).find((n) => n.startsWith(sha + "."));
      if (!name) continue;
      reply
        .type("application/octet-stream")
        .header("Content-Disposition", `attachment; filename="${name}"`);
      return reply.send(createReadStream(join(dir, name)));
    }
    throw new ScrapeError("NOT_FOUND", "File not found.");
  });
}
