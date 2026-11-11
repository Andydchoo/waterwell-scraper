import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  statfsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { findRun, readRun, jsonFile } from "../dashboard/runs.js";
import { atomicWrite, hash, now } from "../core/util.js";
import type { Entity } from "../core/types.js";
import {
  EXPLORER_VERSION,
  ExplorerError,
  kinds,
  opaque,
  type Kind,
  type Snapshot,
} from "./types.js";
import { project } from "./project.js";
export const base = (root: string) => join(root, ".dashboard");
export function reserve(dir: string) {
  const f = statfsSync(dir);
  if (f.bavail * f.bsize < 100 * 1024 ** 2)
    throw new ExplorerError(
      "DISK_FULL",
      "Less than 100 MiB free. Free disk space and retry.",
      409,
    );
}
export function revision(root: string, key: string) {
  const dir = findRun(root, key),
    run = readRun(root, dir);
  const file = join(dir, "manifest.json"),
    manifest = jsonFile<{ publication_status: string }>(file);
  const eligible =
    !run.active &&
    !run.recoverable &&
    manifest?.publication_status === "complete" &&
    run.attempt > 0;
  return {
    dir,
    run,
    eligible,
    revision: eligible
      ? hash(
          JSON.stringify([
            run.runId,
            run.attempt,
            run.updatedAt,
            hash(readFileSync(file)),
            EXPLORER_VERSION,
          ]),
        )
      : null,
  };
}
export function snapshotDir(root: string, id: string) {
  opaque(id);
  return join(base(root), "snapshots", id);
}
export function getSnapshot(root: string, id: string): Snapshot {
  const dir = snapshotDir(root, id),
    s = jsonFile<Snapshot>(join(dir, "snapshot.json"));
  if (!s || !existsSync(join(dir, "index.sqlite")))
    throw new ExplorerError(
      "SNAPSHOT_MISSING",
      "This snapshot is missing. Select the collection and prepare it again.",
      410,
    );
  if (s.id !== id || s.version !== EXPLORER_VERSION)
    throw new ExplorerError(
      "SNAPSHOT_VERSION",
      "Rebuild this collection’s explorer cache for the current mapping version.",
      409,
    );
  return s;
}
export function snapshots(root: string, runKey?: string) {
  const dir = join(base(root), "snapshots");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => /^[a-f0-9-]{36}$/.test(n))
    .flatMap((n) => {
      try {
        const s = getSnapshot(root, n);
        return !runKey || s.runKey === runKey ? [s] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function openSnapshot(root: string, id: string) {
  getSnapshot(root, id);
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(join(snapshotDir(root, id), "index.sqlite"), {
      readOnly: true,
      timeout: 500,
    });
    db.prepare("SELECT id FROM records LIMIT 1").get();
    return db;
  } catch {
    db?.close();
    throw new ExplorerError(
      "SNAPSHOT_CORRUPT",
      "Search cache is unreadable. Clear this search cache and prepare the collection again; original data is preserved.",
      409,
    );
  }
}
export function buildSnapshot(
  root: string,
  runKey: string,
  id = randomUUID(),
  progress: (n: number, total: number) => void = () => {},
): Snapshot {
  const before = revision(root, runKey);
  if (!before.eligible)
    throw new ExplorerError(
      "RUN_NOT_FINALIZED",
      "Finish or recover this collection before preparing its data.",
      409,
    );
  const parent = join(base(root), "snapshots");
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  reserve(parent);
  const temp = join(parent, id + ".tmp");
  mkdirSync(temp, { mode: 0o700 });
  const input = new DatabaseSync(join(before.dir, "state.sqlite"), {
    readOnly: true,
    timeout: 500,
  });
  const db = new DatabaseSync(join(temp, "index.sqlite"));
  const digest = createHash("sha256");
  const counts: Record<string, number> = {};
  try {
    input.exec("BEGIN");
    const meta = (key: string) =>
      JSON.parse(
        String(
          input.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value ??
            "null",
        ),
      );
    if (
      meta("outcome") === "running" ||
      meta("attempt") !== before.run.attempt ||
      Number(input.prepare("PRAGMA user_version").get()?.user_version) !== 1
    )
      throw new ExplorerError(
        "RUN_CHANGED",
        "Collection changed or is incompatible. Retry after it finishes.",
        409,
      );
    db.exec(`PRAGMA journal_mode=DELETE;
   CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,source TEXT,dataset TEXT,title TEXT,address TEXT,depth REAL,status TEXT,use TEXT,download TEXT,search TEXT,summary TEXT,report_count INTEGER DEFAULT 0,downloaded_count INTEGER DEFAULT 0,PRIMARY KEY(kind,id));
   CREATE TABLE payloads(kind TEXT,id TEXT,value TEXT,projection TEXT,PRIMARY KEY(kind,id));
   CREATE TABLE identifiers(kind TEXT,id TEXT,type TEXT,value TEXT,PRIMARY KEY(kind,id,type,value));
   CREATE TABLE dates(kind TEXT,id TEXT,meaning TEXT,start TEXT,end TEXT);
   CREATE TABLE flags(kind TEXT,id TEXT,flag TEXT,PRIMARY KEY(kind,id,flag));
   CREATE TABLE links(from_kind TEXT,from_id TEXT,to_kind TEXT,to_id TEXT,relation TEXT,evidence TEXT,PRIMARY KEY(from_kind,from_id,to_kind,to_id,relation));
   CREATE TABLE refs(from_kind TEXT,from_id TEXT,target_kind TEXT,target_id TEXT,relation TEXT,evidence TEXT);
   CREATE INDEX record_source ON records(kind,source,dataset);
   CREATE INDEX record_title ON records(kind,title,id);
   CREATE INDEX record_depth ON records(kind,depth,id);
   CREATE INDEX identifiers_lookup ON identifiers(type,value,kind,id);
   CREATE INDEX date_lookup ON dates(kind,id,meaning,start,end);
   CREATE INDEX flag_lookup ON flags(flag,kind,id);
   CREATE INDEX refs_id ON refs(target_id);
   BEGIN;`);
    const insert = db.prepare(
      "INSERT INTO records(kind,id,source,dataset,title,address,depth,status,use,download,search,summary) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const payload = db.prepare("INSERT INTO payloads VALUES(?,?,?,?)"),
      ident = db.prepare("INSERT OR IGNORE INTO identifiers VALUES(?,?,?,?)"),
      date = db.prepare("INSERT INTO dates VALUES(?,?,?,?,?)"),
      flag = db.prepare("INSERT OR IGNORE INTO flags VALUES(?,?,?)"),
      ref = db.prepare("INSERT INTO refs VALUES(?,?,?,?,?,?)");
    const total = Number(
      input.prepare("SELECT count(*) n FROM entities").get()!.n,
    );
    let n = 0;
    progress(0, total);
    for (const row of input
      .prepare("SELECT kind,id,value FROM entities ORDER BY kind,id")
      .iterate()) {
      const kind = String(row.kind),
        value = String(row.value),
        e = JSON.parse(value) as Entity;
      digest.update(JSON.stringify([kind, String(row.id), value]));
      n++;
      if (kind === "relationships") {
        if (typeof e.from_id === "string" && typeof e.to_id === "string")
          ref.run(
            "",
            e.from_id,
            "",
            e.to_id,
            String(e.relationship_type ?? "related"),
            String(e.evidence ?? "published_relationship"),
          );
      } else if (kinds.includes(kind as Kind)) {
        const p = project(kind as Kind, e),
          s = p.summary;
        counts[kind] = (counts[kind] ?? 0) + 1;
        insert.run(
          kind,
          e.id,
          s.source,
          s.dataset,
          s.title.normalize("NFKC").toLowerCase(),
          s.address?.normalize("NFKC").toLowerCase() ?? null,
          s.depth,
          s.status,
          s.use,
          s.download,
          p.search,
          JSON.stringify(s),
        );
        payload.run(kind, e.id, value, JSON.stringify(p));
        for (const i of p.identifiers)
          ident.run(kind, e.id, i.type, i.normalized);
        for (const d of p.dates)
          date.run(kind, e.id, d.meaning, d.start, d.end);
        for (const f of e.quality_flags) flag.run(kind, e.id, f);
        if (typeof e.record_id === "string" && e.record_id !== e.id) {
          // A report describes a construction record; an observation belongs to a well.
          const target =
            kind === "documents"
              ? "construction"
              : kind === "observations"
                ? "wells"
                : null;
          if (target)
            ref.run(
              kind,
              e.id,
              target,
              e.record_id,
              kind === "documents" ? "describes_record" : "observes_record",
              "explicit_record_id",
            );
        }
      }
      if (n % 500 === 0) {
        reserve(temp);
        progress(n, total);
      }
    }
    // Resolve IDs only within documented kinds, or when a generic reference is unambiguous.
    const resolveKey = db.prepare("SELECT kind FROM records WHERE id=?"),
      link = db.prepare(
        "INSERT INTO links VALUES(?,?,?,?,?,?) ON CONFLICT(from_kind,from_id,to_kind,to_id,relation) DO UPDATE SET evidence=CASE WHEN instr(links.evidence,excluded.evidence)>0 THEN links.evidence ELSE links.evidence || ' · ' || excluded.evidence END",
      );
    for (const r of db.prepare("SELECT * FROM refs").iterate()) {
      const froms = r.from_kind
        ? [{ kind: r.from_kind }]
        : resolveKey.all(r.from_id!);
      const tos = r.target_kind
        ? db
            .prepare("SELECT kind FROM records WHERE kind=? AND id=?")
            .all(r.target_kind!, r.target_id!)
        : resolveKey.all(r.target_id!);
      if (froms.length !== 1) continue;
      const fk = String(froms[0]!.kind),
        tk = tos.length === 1 ? String(tos[0]!.kind) : "";
      if (fk === tk && r.from_id === r.target_id) continue;
      link.run(fk, r.from_id!, tk, r.target_id!, r.relation!, r.evidence!);
    }
    db.exec(`DROP TABLE refs;
   CREATE INDEX links_from ON links(from_kind,from_id);
   CREATE INDEX links_to ON links(to_kind,to_id);
   UPDATE records SET report_count=(SELECT count(DISTINCT l.from_id) FROM links l WHERE l.to_kind=records.kind AND l.to_id=records.id AND l.from_kind='documents'),downloaded_count=(SELECT count(DISTINCT l.from_id) FROM links l JOIN records d ON d.kind='documents' AND d.id=l.from_id WHERE l.to_kind=records.kind AND l.to_id=records.id AND l.from_kind='documents' AND d.download='downloaded');
   COMMIT; PRAGMA optimize;`);
    const after = revision(root, runKey);
    if (!after.eligible || after.revision !== before.revision)
      throw new ExplorerError(
        "RUN_CHANGED",
        "Collection changed during indexing. Retry after it finishes.",
        409,
      );
    const s: Snapshot = {
      id,
      runKey,
      runId: before.run.runId,
      attempt: before.run.attempt,
      outcome: before.run.outcome,
      endedAt: before.run.updatedAt,
      createdAt: now(),
      revision: before.revision!,
      version: EXPLORER_VERSION,
      counts,
      digest: digest.digest("hex"),
      bytes: statSync(join(temp, "index.sqlite")).size,
      county: before.run.county,
      state: before.run.state,
      sourcePlan: before.run.sourcePlan,
      coverage: before.run.sources,
    };
    input.exec("COMMIT");
    db.close();
    input.close();
    atomicWrite(join(temp, "snapshot.json"), JSON.stringify(s));
    renameSync(temp, snapshotDir(root, id));
    progress(n, total);
    return s;
  } catch (e) {
    try {
      db.close();
    } catch {}
    try {
      input.close();
    } catch {}
    rmSync(temp, { recursive: true, force: true });
    throw e;
  }
}
