import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { fixture } from "../tests/fixtures/explorer.js";
import { ExplorerService } from "../src/explorer/service.js";
import { createDashboard } from "../src/dashboard/server.js";
import { getSnapshot } from "../src/explorer/snapshots.js";
const root = mkdtempSync(join(tmpdir(), "well-explorer-scale-"));
const f = fixture(root, 100000),
  service = new ExplorerService(root),
  app = await createDashboard({ root });
const latency: number[] = [];
async function finished(id: string) {
  const deadline = Date.now() + 60000;
  while (service.job(id).state === "running") {
    const t = performance.now();
    assert.equal((await app.inject("/api/runs")).statusCode, 200);
    latency.push(performance.now() - t);
    assert.ok(Date.now() < deadline, "Worker exceeded 60 seconds");
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(service.job(id).state, "complete", service.job(id).error);
}
try {
  const start = performance.now(),
    index = service.startIndex(f.runKey).job!;
  await finished(index.id);
  const indexMs = performance.now() - start,
    s = getSnapshot(root, index.id);
  const timings: number[] = [];
  for (let i = 0; i < 35; i++) {
    const t = performance.now();
    await service.request("query", {
      snapshot: s.id,
      query: [
        { q: "River" },
        { q: "no match anywhere" },
        { identifier: { type: "parcel", value: "00123" } },
        { depth: { min: 100, max: 1000 } },
        { sort: "title", direction: "desc" },
        { sources: ["fixture"] },
        {
          kind: "construction",
          date: { meaning: "completion", from: "2020-06-01", to: "2020-06-30" },
        },
      ][i % 7],
    });
    timings.push(performance.now() - t);
  }
  const detailTimes: number[] = [];
  for (let i = 0; i < 10; i++) {
    const t = performance.now();
    await service.request("record", {
      snapshot: s.id,
      kind: "wells",
      id: "well:000001",
    });
    await service.request("links", {
      snapshot: s.id,
      kind: "wells",
      id: "well:000001",
      offset: 0,
    });
    detailTimes.push(performance.now() - t);
  }
  const exportStart = performance.now(),
    job = service.startExport(s.id, {
      query: { kind: "wells" },
      format: "jsonl",
    });
  await finished(job.id);
  const exportMs = performance.now() - exportStart;
  const p95 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
  assert.equal(service.job(job.id).progress, 100000);
  assert.ok(indexMs < 60000);
  assert.ok(p95(timings) < 750);
  assert.ok(p95(detailTimes) < 500);
  assert.ok(exportMs < 60000);
  assert.ok(Math.max(...latency) < 1000);
  // Worker threads share this process, so maxRSS includes HTTP and all workers.
  const rss = process.resourceUsage().maxRSS * 1024;
  assert.ok(rss < 1024 ** 3);
  console.log(
    JSON.stringify(
      {
        records: 100000,
        indexMs,
        queryP95Ms: p95(timings),
        detailAndLinksP95Ms: p95(detailTimes),
        exportMs,
        statusMaxMs: Math.max(...latency),
        statusRequests: latency.length,
        peakRssMiB: Math.round(rss / 1024 ** 2),
        cacheMiB: Math.round(s.bytes / 1024 ** 2),
        node: process.version,
        cpu: cpus()[0]?.model,
        queries: timings.length,
        cache:
          "fresh snapshot, repeated warm query mix; worker startup included",
      },
      null,
      2,
    ),
  );
} finally {
  await service.close();
  await app.close();
  rmSync(root, { recursive: true, force: true });
}
