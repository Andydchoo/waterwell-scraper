import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, lockRun } from "../src/storage/store.js";
import { ConfigSchema, type Entity } from "../src/core/types.js";
import { exportData } from "../src/storage/export.js";

const entity: Entity = {
  id: "fixture:1",
  native_id: "1",
  source_id: "fixture",
  dataset_id: "fixture",
  county_geoid: "37119",
  source_url: "https://example.gov",
  retrieved_at: "2026-10-27",
  raw_path: "raw/fixture.json",
  raw_sha256: "a".repeat(64),
  source_fields: { value: 0 },
  quality_flags: [],
};

for (const phase of ["raw", "transaction", "committed", "export"]) {
  test(`SIGKILL recovery after ${phase} preserves committed data only`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "well-recovery-"));
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
      import { Store, lockRun } from './src/storage/store.ts';
      import { writeFileSync } from 'node:fs';
      const dir=process.env.TEST_RUN_DIR, phase=process.env.TEST_PHASE;
      lockRun(dir); const store=new Store(dir);
      const raw=store.raw('fixture',{id:1,value:0});
      if(phase!=='raw'){
        store.db.exec('BEGIN IMMEDIATE');
        store.put('wells',{...JSON.parse(process.env.TEST_ENTITY),...raw});
        store.task('fixture','fixture','1','accepted');
        if(phase!=='transaction')store.db.exec('COMMIT');
      }
      if(phase==='export')writeFileSync(dir+'/wells.jsonl.tmp','incomplete');
      process.stdout.write('READY\\n');setInterval(()=>{},1000);
    `,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          TEST_RUN_DIR: dir,
          TEST_PHASE: phase,
          TEST_ENTITY: JSON.stringify(entity),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Fixture did not become ready: " + stderr));
      }, 15000);
      child.stdout.on("data", (data) => {
        if (String(data).includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("error", reject);
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("Fixture exited early: " + stderr));
      });
    });
    const exit = once(child, "exit");
    child.kill("SIGKILL");
    await exit;
    const unlock = lockRun(dir),
      store = new Store(dir);
    try {
      const committed = ["committed", "export"].includes(phase);
      assert.equal(store.count("wells"), committed ? 1 : 0);
      assert.equal(store.done("fixture", "fixture", "1"), committed);
      exportData(
        store,
        ConfigSchema.parse({ state: "NC", county: "Mecklenburg" }),
      );
      assert.equal(existsSync(join(dir, "wells.jsonl.tmp")), false);
      const rows = readFileSync(join(dir, "wells.jsonl"), "utf8").trim();
      assert.equal(
        rows ? JSON.parse(rows).id : null,
        committed ? entity.id : null,
      );
    } finally {
      store.close();
      unlock();
    }
  });
}

test("interrupted report recovery refreshes source counts from committed tasks", async () => {
  const { reconcileInterruptedResults } =
    await import("../src/storage/export.js");
  const { emptyResult } = await import("../src/core/types.js");
  const store = new Store(
    mkdtempSync(join(tmpdir(), "well-summary-recovery-")),
  );
  try {
    store.result({
      ...emptyResult("fixture", "reports"),
      status: "partial",
      accepted: 1,
      fetched: 1,
    });
    store.set("fixture:reports:ids", ["1", "2", "3", "4"]);
    store.task("fixture", "reports", "1", "accepted");
    store.task("fixture", "reports", "2", "accepted");
    store.task("fixture", "reports", "3", "failed");
    reconcileInterruptedResults(store);
    const r = store.results()[0]!;
    assert.equal(r.accepted, 2);
    assert.equal(r.fetched, 2);
    assert.equal(r.expected, 4);
    assert.equal(r.unresolved, 2);
    assert.ok(r.errors.some((e) => e.code === "INTERRUPTED"));
  } finally {
    store.close();
  }
});
