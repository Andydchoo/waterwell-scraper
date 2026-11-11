import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { hash } from "../core/util.js";
import {
  QuerySchema,
  ExplorerError,
  fold,
  kinds,
  type Query,
  type Summary,
  type Page,
  type Kind,
  type Capabilities,
  type Detail,
  type Link,
} from "./types.js";
import { openSnapshot, getSnapshot } from "./snapshots.js";
export function predicate(q: Query) {
  const conditions = ["r.kind=?"],
    args: SQLInputValue[] = [q.kind];
  const add = (sql: string, ...values: SQLInputValue[]) => {
    conditions.push(sql);
    args.push(...values);
  };
  for (const term of fold(q.q).trim().split(/\s+/u).filter(Boolean))
    add("instr(r.search,?)>0", term);
  for (const [field, values] of [
    ["source", q.sources],
    ["dataset", q.datasets],
    ["status", q.statuses],
    ["use", q.uses],
    ["download", q.downloadStates],
  ] as const)
    if (values.length)
      add(`r.${field} IN (${values.map(() => "?").join(",")})`, ...values);
  if (q.flags.length)
    add(
      `EXISTS(SELECT 1 FROM flags f WHERE f.kind=r.kind AND f.id=r.id AND f.flag IN (${q.flags.map(() => "?").join(",")}))`,
      ...q.flags,
    );
  if (q.identifier)
    add(
      "EXISTS(SELECT 1 FROM identifiers i WHERE i.kind=r.kind AND i.id=r.id AND i.type=? AND i.value=?)",
      q.identifier.type,
      fold(q.identifier.value),
    );
  if (q.date)
    add(
      "EXISTS(SELECT 1 FROM dates d WHERE d.kind=r.kind AND d.id=r.id AND d.meaning=? AND d.end>=? AND d.start<=?)",
      q.date.meaning,
      q.date.from ?? "0001-01-01",
      q.date.to ?? "9999-12-31",
    );
  if (q.depth?.mode === "unknown") add("r.depth IS NULL");
  else if (q.depth) {
    add("r.depth IS NOT NULL");
    const factor = q.depth.unit === "ft" ? 0.3048 : 1;
    if (q.depth.min !== undefined) add("r.depth>=?", q.depth.min * factor);
    if (q.depth.max !== undefined) add("r.depth<=?", q.depth.max * factor);
  }
  if (q.reports)
    add(
      q.reports === "none"
        ? "r.report_count=0"
        : q.reports === "downloaded"
          ? "r.downloaded_count>0"
          : "r.report_count>0",
    );
  return { where: conditions.join(" AND "), args };
}
export function sortExpression(q: Query) {
  return q.sort === "date"
    ? `(SELECT min(start) FROM dates d WHERE d.kind=r.kind AND d.id=r.id AND d.meaning='${q.date!.meaning}')`
    : `r.${{ id: "id", title: "title", address: "address", depth: "depth", source: "source", date: "id" }[q.sort]}`;
}
export function selection(q: Query) {
  const { where, args } = predicate(q),
    expr = sortExpression(q);
  return {
    sql: `SELECT r.kind,r.id,r.summary,r.report_count,r.downloaded_count,${expr} sort_value FROM records r WHERE ${where}`,
    args,
  };
}
export function queryHash(q: Query) {
  const { cursor: _c, pageSize: _p, ...filter } = q;
  return hash(JSON.stringify(filter));
}
export function queryPage(
  root: string,
  snapshot: string,
  input: unknown,
): Page {
  const q = QuerySchema.parse(input),
    db = openSnapshot(root, snapshot);
  try {
    const { where, args } = predicate(q),
      total = Number(
        db
          .prepare(`SELECT count(*) n FROM records r WHERE ${where}`)
          .get(...args)!.n,
      );
    const unknown = predicate({ ...q, depth: undefined });
    const unknownDepth = Number(
      db
        .prepare(
          `SELECT count(*) n FROM records r WHERE ${unknown.where} AND r.depth IS NULL`,
        )
        .get(...unknown.args)!.n,
    );
    const selected = selection(q),
      dir = q.direction === "asc" ? "ASC" : "DESC",
      op = q.direction === "asc" ? ">" : "<";
    let suffix = "";
    const values = [...selected.args];
    if (q.cursor) {
      let c: {
        snapshot: string;
        hash: string;
        v: string | number | null;
        id: string;
      };
      try {
        c = JSON.parse(Buffer.from(q.cursor, "base64url").toString());
      } catch {
        throw new ExplorerError(
          "INVALID_CURSOR",
          "Invalid page cursor. Start from the first page.",
        );
      }
      if (
        c.snapshot !== snapshot ||
        c.hash !== queryHash(q) ||
        typeof c.id !== "string" ||
        c.id.length > 8192 ||
        !(
          c.v === null ||
          typeof c.v === "string" ||
          (typeof c.v === "number" && Number.isFinite(c.v))
        )
      )
        throw new ExplorerError(
          "INVALID_CURSOR",
          "This page cursor belongs to another search.",
        );
      if (c.v === null) {
        suffix = `WHERE sort_value IS NULL AND id ${op} ?`;
        values.push(c.id);
      } else {
        suffix = `WHERE sort_value IS NULL OR sort_value ${op} ? OR (sort_value=? AND id ${op} ?)`;
        values.push(c.v, c.v, c.id);
      }
    }
    const rows = db
      .prepare(
        `SELECT * FROM (${selected.sql}) ${suffix} ORDER BY sort_value IS NULL ASC,sort_value ${dir},id ${dir} LIMIT ?`,
      )
      .all(...values, q.pageSize + 1);
    const more = rows.length > q.pageSize;
    if (more) rows.pop();
    const last = rows.at(-1);
    const items = rows.map((r) => ({
      ...JSON.parse(String(r.summary)),
      reports: Number(r.report_count),
      downloadedReports: Number(r.downloaded_count),
    })) as Summary[];
    return {
      items,
      total,
      nextCursor:
        more && last
          ? Buffer.from(
              JSON.stringify({
                snapshot,
                hash: queryHash(q),
                v: last.sort_value,
                id: last.id,
              }),
            ).toString("base64url")
          : null,
      snapshot,
      query: q,
      unknownDepth,
    };
  } finally {
    db.close();
  }
}
export function capabilities(
  root: string,
  id: string,
  kind: Kind,
): Capabilities {
  const snapshot = getSnapshot(root, id),
    db = openSnapshot(root, id);
  try {
    const values = (column: string) =>
      db
        .prepare(
          `SELECT DISTINCT ${column} v FROM records WHERE kind=? AND ${column} IS NOT NULL ORDER BY v`,
        )
        .all(kind)
        .map((r) => String(r.v));
    return {
      snapshot,
      types: kinds.map((kind) => ({ kind, count: snapshot.counts[kind] ?? 0 })),
      sources: db
        .prepare(
          "SELECT DISTINCT kind,source,dataset FROM records ORDER BY kind,source,dataset",
        )
        .all() as unknown as Capabilities["sources"],
      statuses: values("status"),
      uses: values("use"),
      flags: db
        .prepare("SELECT DISTINCT flag FROM flags WHERE kind=? ORDER BY flag")
        .all(kind)
        .map((r) => String(r.flag)),
      downloadStates: values("download"),
      dateMeanings: db
        .prepare(
          "SELECT DISTINCT meaning FROM dates WHERE kind=? ORDER BY meaning",
        )
        .all(kind)
        .map((r) => String(r.meaning)),
      unknownDepth: Number(
        db
          .prepare(
            "SELECT count(*) n FROM records WHERE kind=? AND depth IS NULL",
          )
          .get(kind)!.n,
      ),
    };
  } finally {
    db.close();
  }
}
export function record(
  root: string,
  snapshot: string,
  kind: Kind,
  id: string,
): Detail {
  const db = openSnapshot(root, snapshot);
  try {
    const r = db
      .prepare("SELECT value,projection FROM payloads WHERE kind=? AND id=?")
      .get(kind, id);
    if (!r)
      throw new ExplorerError(
        "NOT_FOUND",
        "Record not found in this snapshot.",
        404,
      );
    return {
      snapshot: getSnapshot(root, snapshot),
      entity: JSON.parse(String(r.value)),
      projection: JSON.parse(String(r.projection)),
    };
  } finally {
    db.close();
  }
}
export function links(
  root: string,
  snapshot: string,
  kind: Kind,
  id: string,
  offset = 0,
) {
  const db = openSnapshot(root, snapshot);
  try {
    const sql = `SELECT to_kind kind,to_id id,relation,evidence FROM links WHERE from_kind=? AND from_id=? UNION SELECT from_kind kind,from_id id,relation,evidence FROM links WHERE to_kind=? AND to_id=?`;
    const total = Number(
      db.prepare(`SELECT count(*) n FROM (${sql})`).get(kind, id, kind, id)!.n,
    );
    const rows = db
      .prepare(
        `SELECT l.*,r.summary FROM (${sql}) l LEFT JOIN records r ON r.kind=l.kind AND r.id=l.id ORDER BY l.kind,l.id,l.relation,l.evidence LIMIT 50 OFFSET ?`,
      )
      .all(kind, id, kind, id, offset);
    const items: Link[] = rows.map((r) => ({
      kind: r.kind ? (String(r.kind) as Kind) : null,
      id: String(r.id),
      relation: String(r.relation),
      evidence: String(r.evidence),
      title: r.summary ? JSON.parse(String(r.summary)).title : null,
      resolved: !!r.summary,
    }));
    return {
      items,
      total,
      next: offset + rows.length < total ? offset + rows.length : null,
    };
  } finally {
    db.close();
  }
}
export function* matching(db: DatabaseSync, q: Query) {
  const s = selection(q),
    dir = q.direction === "asc" ? "ASC" : "DESC";
  for (const r of db
    .prepare(
      `SELECT p.value FROM (${s.sql}) r JOIN payloads p ON p.kind=r.kind AND p.id=r.id ORDER BY r.sort_value IS NULL ASC,r.sort_value ${dir},r.id ${dir}`,
    )
    .iterate(...s.args))
    yield JSON.parse(String(r.value)) as Record<string, unknown>;
}
