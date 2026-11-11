import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import {
  EntitySchema,
  ScrapeError,
  type Entity,
  type EntityKind,
  type SourceResult,
} from "../core/types.js";
import { atomicWrite, hash, redact } from "../core/util.js";
export class Store {
  db: DatabaseSync;
  secrets: string[] = [];
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(join(dir, "state.sqlite"));
    const version = Number(
      this.db.prepare("PRAGMA user_version").get()!.user_version,
    );
    if (version > 1) {
      this.db.close();
      throw new ScrapeError(
        "INCOMPATIBLE_RESUME",
        "Database was created by a newer application.",
      );
    }
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entities(kind TEXT NOT NULL,id TEXT NOT NULL,source TEXT NOT NULL,dataset TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS tasks(source TEXT NOT NULL,dataset TEXT NOT NULL,id TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(source,dataset,id));
      CREATE TABLE IF NOT EXISTS results(source TEXT NOT NULL,dataset TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(source,dataset));
      CREATE TABLE IF NOT EXISTS issues(id TEXT PRIMARY KEY,value TEXT NOT NULL);
      PRAGMA user_version=1;`);
  }
  close() {
    this.db.close();
  }
  get<T>(key: string): T | undefined {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key);
    return r ? (JSON.parse(String(r.value)) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
      .run(key, JSON.stringify(value));
  }
  transaction(fn: () => void) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  put(kind: EntityKind, entity: Entity) {
    EntitySchema.parse(entity);
    this.db
      .prepare("INSERT OR REPLACE INTO entities VALUES(?,?,?,?,?)")
      .run(
        kind,
        entity.id,
        entity.source_id,
        entity.dataset_id,
        JSON.stringify(entity),
      );
  }
  remove(kind: EntityKind, id: string) {
    this.db.prepare("DELETE FROM entities WHERE kind=? AND id=?").run(kind, id);
  }
  *entities(kind: EntityKind): Generator<Entity> {
    for (const row of this.db
      .prepare("SELECT value FROM entities WHERE kind=? ORDER BY id")
      .iterate(kind))
      yield JSON.parse(String(row.value)) as Entity;
  }
  count(kind?: EntityKind) {
    return Number(
      (kind
        ? this.db
            .prepare("SELECT count(*) n FROM entities WHERE kind=?")
            .get(kind)
        : this.db.prepare("SELECT count(*) n FROM entities").get())!.n,
    );
  }
  done(source: string, dataset: string, id: string) {
    return !!this.db
      .prepare(
        "SELECT 1 FROM tasks WHERE source=? AND dataset=? AND id=? AND status!='failed'",
      )
      .get(source, dataset, id);
  }
  task(source: string, dataset: string, id: string, status: string) {
    this.db
      .prepare("INSERT OR REPLACE INTO tasks VALUES(?,?,?,?)")
      .run(source, dataset, id, status);
  }
  taskCounts(source: string, dataset: string) {
    return this.db
      .prepare(
        "SELECT status,count(*) n FROM tasks WHERE source=? AND dataset=? GROUP BY status",
      )
      .all(source, dataset) as { status: string; n: number }[];
  }
  result(value: SourceResult) {
    this.db
      .prepare("INSERT OR REPLACE INTO results VALUES(?,?,?)")
      .run(
        value.source_id,
        value.dataset_id,
        JSON.stringify(redact(value, this.secrets)),
      );
  }
  results(): SourceResult[] {
    return this.db
      .prepare("SELECT value FROM results ORDER BY source,dataset")
      .all()
      .map((r) => JSON.parse(String(r.value)) as SourceResult);
  }
  issue(value: Record<string, unknown>) {
    const id = hash(JSON.stringify(value));
    this.db
      .prepare("INSERT OR REPLACE INTO issues VALUES(?,?)")
      .run(
        id,
        JSON.stringify(redact({ issue_id: id, ...value }, this.secrets)),
      );
  }
  *issues() {
    for (const r of this.db
      .prepare("SELECT value FROM issues ORDER BY id")
      .iterate())
      yield JSON.parse(String(r.value));
  }
  raw(source: string, value: unknown, extension = "json") {
    const content = Buffer.isBuffer(value)
      ? value
      : Buffer.from(JSON.stringify(value));
    const digest = hash(content);
    const relative = `raw/${source}/${digest}.${extension}`;
    if (!existsSync(join(this.dir, relative)))
      atomicWrite(join(this.dir, relative), content);
    return { raw_path: relative, raw_sha256: digest };
  }
}
export function lockRun(dir: string): () => void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, ".lock");
  try {
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const pid = Number(readFileSync(path, "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new ScrapeError(
        "RUN_LOCKED",
        "Run lock is invalid; inspect it before recovery.",
      );
    try {
      process.kill(pid, 0);
      throw new ScrapeError("RUN_LOCKED", `Run is in use by process ${pid}.`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
    unlinkSync(path);
    writeFileSync(path, String(process.pid), { flag: "wx", mode: 0o600 });
  }
  return () => {
    if (existsSync(path) && readFileSync(path, "utf8") === String(process.pid))
      unlinkSync(path);
  };
}
