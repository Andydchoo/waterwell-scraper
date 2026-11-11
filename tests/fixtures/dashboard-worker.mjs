// Controlled local worker for dashboard lifecycle tests; never contacts a public source.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[2];
const path = join(dir, "dashboard-job.json");
const job = JSON.parse(readFileSync(path, "utf8"));
const write = (name, value) => {
  const target = join(dir, name);
  writeFileSync(target + ".tmp", JSON.stringify(value));
  renameSync(target + ".tmp", target);
};
const db = new DatabaseSync(join(dir, "state.sqlite"));
db.exec(`PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);
  CREATE TABLE IF NOT EXISTS entities(kind TEXT,id TEXT,source TEXT,dataset TEXT,value TEXT,PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS tasks(source TEXT,dataset TEXT,id TEXT,status TEXT);
  CREATE TABLE IF NOT EXISTS results(source TEXT,dataset TEXT,value TEXT);
  PRAGMA user_version=1;`);
const set = (key, value) =>
  db
    .prepare("INSERT OR REPLACE INTO meta VALUES(?,?)")
    .run(key, JSON.stringify(value));
const get = (key) => {
  const r = db.prepare("SELECT value FROM meta WHERE key=?").get(key);
  return r ? JSON.parse(r.value) : undefined;
};
set("run_id", job.runId);
set("config", job.config);
set("geo", { state: "NC", county: "Mecklenburg County" });
set("started_at", get("started_at") ?? job.createdAt);
set("attempt", (get("attempt") ?? 0) + 1);
set("outcome", "running");
set("progress", { bytes: 2048, requests: 2, browser_requests: 3, retries: 0 });
db.prepare("INSERT OR IGNORE INTO entities VALUES(?,?,?,?,?)").run(
  "wells",
  "fixture:1",
  "fixture",
  "wells",
  JSON.stringify({ id: "fixture:1" }),
);
writeFileSync(
  join(dir, "events.jsonl"),
  JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "run.started",
    source_id: "fixture",
  }) + "\n",
);
job.state = "running";
const save = () =>
  write("dashboard-job.json", {
    ...job,
    pid: process.pid,
    updatedAt: new Date().toISOString(),
  });
save();
const deadline = Date.now() + 20000;
const timer = setInterval(() => {
  let stop;
  try {
    stop = JSON.parse(readFileSync(join(dir, "stop-request.json"), "utf8"));
  } catch {}
  if (stop?.nonce !== job.nonce && Date.now() < deadline) {
    save();
    return;
  }
  clearInterval(timer);
  set("outcome", "partial");
  set("attempt_ended_at", new Date().toISOString());
  db.close();
  const csv = "id\nfixture:1\n";
  writeFileSync(join(dir, "wells.csv"), csv);
  write("manifest.json", {
    publication_status: "complete",
    artifacts: { "wells.csv": { bytes: Buffer.byteLength(csv), rows: 1 } },
  });
  writeFileSync(
    join(dir, "summary.md"),
    "# Fixture collection\n\nStopped safely.\n",
  );
  job.state = "finished";
  save();
}, 100);
