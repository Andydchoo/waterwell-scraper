import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import assert from "node:assert/strict";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  writeFileSync,
  symlinkSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDashboard } from "../src/dashboard/server.js";
import { Jobs } from "../src/dashboard/jobs.js";
import {
  readRun,
  runList,
  findRun,
  runKey,
  jsonFile,
  type Job,
} from "../src/dashboard/runs.js";
import { Store } from "../src/storage/store.js";
import { ConfigSchema, emptyResult } from "../src/core/types.js";
import { collect } from "../src/core/runner.js";

const input = {
  state: "NC",
  county: "Mecklenburg",
  sources: ["usgs-groundwater"],
  attachments: "none",
};
const worker = resolve("tests/fixtures/dashboard-worker.mjs");
test("dashboard can read a starting worker before SQLite schema publication", () => {
  const root = mkdtempSync(join(tmpdir(), "well-dashboard-starting-"));
  try {
    const db = new DatabaseSync(join(root, "state.sqlite"));
    db.exec(
      "CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE entities(kind TEXT,id TEXT)",
    );
    db.close();
    writeFileSync(
      join(root, "dashboard-job.json"),
      JSON.stringify({
        runId: "starting",
        state: "starting",
        pid: process.pid,
        updatedAt: new Date().toISOString(),
        config: ConfigSchema.parse(input),
      }),
    );
    const view = readRun(root, root);
    assert.equal(view.active, true);
    assert.equal(view.outcome, "starting");
    assert.deepEqual(view.counts, {});
    const initialized = new Store(root);
    initialized.set("attempt", 1);
    initialized.close();
    assert.equal(readRun(root, root).attempt, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail("Timed out waiting for worker");
}

test("dashboard API reads ledger counts and enforces local origins, tokens, and export boundaries", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-dashboard-api-")),
    dir = join(root, "fixture"),
    store = new Store(dir);
  store.set("run_id", "fixture");
  store.set("config", ConfigSchema.parse(input));
  store.set("outcome", "partial");
  store.set("geo", { state: "NC", county: "Mecklenburg County" });
  store.set("started_at", "2026-10-29T12:00:00Z");
  store.result({
    ...emptyResult("fixture", "wells"),
    accepted: 0,
    expected: null,
  });
  store.task("fixture", "wells", "1", "accepted");
  store.task("fixture", "wells", "2", "quarantined");
  store.result(emptyResult("fixture", "unknown"));
  store.set("fixture:wells:ids", [1, 2, 3]);
  store.close();
  writeFileSync(join(dir, "wells.csv"), "id\nfixture:1\n");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      publication_status: "complete",
      artifacts: { "wells.csv": { bytes: 13, rows: 1 } },
    }),
  );
  writeFileSync(join(root, "outside.txt"), "private");
  const app = await createDashboard({ root, worker });
  const id = runKey(root, dir);
  try {
    const bootstrap = await app.inject("/api/bootstrap");
    assert.equal(bootstrap.statusCode, 200);
    const token = bootstrap.json().token;
    assert.equal(token.length, 64);
    assert.ok(
      bootstrap.json().geography.find((g: { code: string }) => g.code === "NC"),
    );
    for (const headers of [
      { host: "attacker.example" },
      { origin: "https://attacker.example" },
      { "sec-fetch-site": "cross-site" },
    ])
      assert.equal(
        (await app.inject({ url: "/api/bootstrap", headers })).statusCode,
        403,
      );
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/runs", payload: input }))
        .statusCode,
      403,
    );
    const bad = await app.inject({
      method: "POST",
      url: "/api/runs",
      headers: { "x-well-token": token },
      payload: { ...input, output: "/outside" },
    });
    assert.equal(bad.statusCode, 400);
    const detail = (await app.inject(`/api/runs/${id}`)).json();
    assert.equal(detail.config, undefined);
    const s = detail.sources.find(
      (s: { dataset_id: string }) => s.dataset_id === "wells",
    );
    assert.equal(s.accepted, 1);
    assert.equal(s.quarantined, 1);
    assert.equal(s.expected, 3);
    assert.equal(s.unresolved, 1);
    assert.equal(
      detail.sources.find(
        (s: { dataset_id: string }) => s.dataset_id === "unknown",
      ).expected,
      null,
    );
    const csv = await app.inject(`/api/runs/${id}/download?file=wells.csv`);
    assert.equal(csv.statusCode, 200);
    assert.match(csv.body, /fixture:1/);
    for (const file of [
      "../outside.txt",
      "state.sqlite",
      "dashboard-job.json",
      "raw/fixture.json",
    ])
      assert.equal(
        (
          await app.inject(
            `/api/runs/${id}/download?file=${encodeURIComponent(file)}`,
          )
        ).statusCode,
        404,
      );
    rmSync(join(dir, "wells.csv"));
    symlinkSync(join(root, "outside.txt"), join(dir, "wells.csv"));
    assert.equal(
      (await app.inject(`/api/runs/${id}/download?file=wells.csv`)).statusCode,
      404,
    );
    assert.equal((await app.inject("/api/runs/not-a-run")).statusCode, 404);
    const other = (
      await app.inject("/api/sources?state=VA&county=51059")
    ).json();
    assert.ok(other.sources.length > 0);
    assert.ok(
      other.sources.every((s: { id: string }) => !s.id.startsWith("nc-")),
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("detached jobs survive API restart, reject overlap, stop by nonce, and resume saved scope", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-dashboard-jobs-"));
  let app = await createDashboard({ root, worker });
  const jobs = new Jobs(root, worker),
    started = jobs.launch(input),
    dir = findRun(root, started.id);
  try {
    await until(() => readRun(root, dir).counts.wells === 1);
    assert.throws(() => jobs.launch(input), /already running/);
    assert.equal(
      (await app.inject(`/api/runs/${started.id}/download?file=events.jsonl`))
        .statusCode,
      409,
    );
    const oldJob = jsonFile<Job>(join(dir, "dashboard-job.json"))!;
    writeFileSync(
      join(dir, "stop-request.json"),
      JSON.stringify({ nonce: "old-unrelated-request" }),
    );
    await app.close();
    app = await createDashboard({ root, worker });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      (await app.inject(`/api/runs/${started.id}`)).json().active,
      true,
    );
    jobs.stop(started.id);
    await until(() => !readRun(root, dir).active);
    assert.equal(readRun(root, dir).outcome, "partial");
    assert.match(readFileSync(join(dir, "wells.csv"), "utf8"), /fixture:1/);
    jobs.launch({}, started.id);
    await until(() => readRun(root, dir).attempt === 2);
    const newJob = jsonFile<Job>(join(dir, "dashboard-job.json"))!;
    assert.notEqual(oldJob.nonce, newJob.nonce);
    assert.deepEqual(newJob.config.sources, input.sources);
    jobs.stop(started.id);
    await until(() => !readRun(root, dir).active);
    assert.equal(readRun(root, dir).counts.wells, 1);
    const db = new Store(dir);
    db.set("outcome", "running");
    db.close();
    assert.equal(readRun(root, dir).outcome, "interrupted");
    assert.equal(readRun(root, dir).recoverable, true);
  } finally {
    if (readRun(root, dir).stoppable) {
      jobs.stop(started.id);
      await until(() => !readRun(root, dir).active);
    }
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("production worker finalizes a budget-stopped attempt without network access", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-dashboard-real-"));
  const jobs = new Jobs(
    root,
    resolve("tests/fixtures/dashboard-real-worker.mjs"),
  );
  // The attempt budget is already spent when the first request would be made.
  const { id } = jobs.launch({ ...input, maxDuration: 0.001 }),
    dir = findRun(root, id);
  try {
    await until(
      () =>
        jsonFile<Job>(join(dir, "dashboard-job.json"))?.state === "finished",
      15000,
    );
    const run = readRun(root, dir);
    assert.equal(run.active, false);
    assert.ok(run.sources.every((s) => s.status !== "success"));
    assert.ok(run.sources.some((s) => s.errors[0]?.code === "BUDGET_DURATION"));
    // New runs are filed under their collection day.
    assert.match(run.day, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(dir.endsWith(join(run.day, run.runId)));
    assert.ok(run.runId.startsWith(run.day + "_nc-mecklenburg-county_"));
    assert.equal(run.transport.requests, 0);
    assert.ok(readFileSync(join(dir, "summary.md"), "utf8").length > 0);
    assert.equal(runList(root).length, 1);
  } finally {
    if (readRun(root, dir).stoppable) {
      jobs.stop(id);
      await until(() => !readRun(root, dir).active);
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("runner accepts an already cancelled external signal and publishes resumable outputs", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-dashboard-abort-"));
  const signal = AbortSignal.abort();
  try {
    const result = await collect({ ...input, output: root }, undefined, true, {
      runId: "cancelled",
      signal,
      unattended: true,
    });
    assert.equal(result.summary.outcome, "cancelled");
    assert.equal(readRun(root, result.dir).resumable, true);
    assert.equal(readRun(root, result.dir).transport.requests, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a run folder that was moved resumes where it now is", async () => {
  const first = mkdtempSync(join(tmpdir(), "well-moved-a-")),
    second = mkdtempSync(join(tmpdir(), "well-moved-b-"));
  const signal = AbortSignal.abort();
  try {
    const original = await collect(
      { ...input, output: first },
      undefined,
      true,
      { signal, unattended: true },
    );
    const runId = original.summary.run_id;
    const day = runId.slice(0, 10);
    cpSync(original.dir, join(second, day, runId), { recursive: true });
    rmSync(first, { recursive: true, force: true });
    const resumed = await collect({ ...input, output: second }, runId, true, {
      signal,
      unattended: true,
    });
    assert.equal(resumed.dir, join(second, day, runId));
    assert.equal(resumed.summary.attempt_id, 2);
    assert.ok(resumed.summary.resume_command.includes(second));
    assert.equal(existsSync(first), false);
  } finally {
    rmSync(first, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});
