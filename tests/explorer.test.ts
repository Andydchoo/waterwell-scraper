import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  mkdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fixture } from "./fixtures/explorer.js";
import { project, parseDate } from "../src/explorer/project.js";
import {
  buildSnapshot,
  getSnapshot,
  snapshotDir,
} from "../src/explorer/snapshots.js";
import {
  queryPage,
  record,
  links,
  capabilities,
} from "../src/explorer/query.js";
import { exportRecords, exportDir } from "../src/explorer/exports.js";
import { ExplorerService } from "../src/explorer/service.js";
import { QuerySchema, type Kind } from "../src/explorer/types.js";
import { Store } from "../src/storage/store.js";
import { hash } from "../src/core/util.js";
import { createDashboard } from "../src/dashboard/server.js";
async function until<T>(fn: () => T | undefined, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error("Explorer operation timed out");
}

test("source projections preserve IDs, metadata, units, nulls and date precision", () => {
  const root = mkdtempSync(join(tmpdir(), "well-project-"));
  try {
    const f = fixture(root),
      s = buildSnapshot(root, f.runKey);
    const hy = record(root, s.id, "documents", "hyland:1");
    assert.equal(hy.projection.summary.address, "99 Cedar Lane");
    assert.equal(hy.projection.summary.parcel, "000045");
    assert.equal(hy.entity.record_id, null);
    const deq = record(root, s.id, "construction", "deq:1");
    assert.ok(deq.projection.identifiers.some((i) => i.value === "0008"));
    assert.equal(deq.projection.dates[0]?.precision, "month");
    assert.equal(deq.projection.dates[0]?.end, "2020-06-30");
    assert.equal(
      queryPage(root, s.id, {
        kind: "construction",
        identifier: { type: "native", value: "0007" },
      }).total,
      1,
    );
    assert.equal(
      queryPage(root, s.id, {
        kind: "construction",
        identifier: { type: "file", value: "0007" },
      }).total,
      0,
    );
    assert.equal(
      record(root, s.id, "wells", "well:000000").projection.summary.depth,
      null,
    );
    assert.equal(
      record(root, s.id, "wells", "well:000001").projection.summary.depth,
      1,
    );
    const original = record(root, s.id, "wells", "well:000001").entity;
    assert.deepEqual(original.source_fields, {
      nullable: null,
      zero: 0,
      empty: "",
    });
    const p = project("wells", {
      ...original,
      total_depth: { value: 0, unit: "ft", raw_value: 0 },
      quality_flags: [],
    } as never);
    assert.equal(p.summary.depth, 0);
    assert.equal(parseDate("2023-02-29", "completion", "test"), null);
    assert.equal(parseDate("nonsense", "document", "test"), null);
    assert.equal(parseDate("2020", "completion", "test")?.precision, "year");
    assert.equal(
      parseDate("20200200", "completion", "test")?.end,
      "2020-02-29",
    );
    assert.equal(
      parseDate(0, "observation", "test", true)?.start,
      "1970-01-01",
    );
    assert.equal(
      queryPage(root, s.id, {
        kind: "observations",
        date: { meaning: "observation", from: "2020-12-31", to: "2020-12-31" },
      }).total,
      1,
    );
    assert.equal(
      queryPage(root, s.id, {
        kind: "construction",
        date: { meaning: "completion", from: "2020-06-12", to: "2020-06-12" },
      }).total,
      1,
    );
    assert.equal(links(root, s.id, "documents", "hyland:1").total, 0);
    assert.ok(
      links(root, s.id, "construction", "deq:1").items.some(
        (l) => l.id === "deq:1:document",
      ),
    );
    assert.equal(
      links(root, s.id, "observations", "obs:1").items[0]?.id,
      "well:000001",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("literal queries, combined filters, known-unit depths and stable cursors match exact counts", () => {
  const root = mkdtempSync(join(tmpdir(), "well-query-"));
  try {
    const f = fixture(root, 120),
      s = buildSnapshot(root, f.runKey);
    assert.equal(queryPage(root, s.id, { q: "RIVER 00123" }).total, 40);
    assert.equal(queryPage(root, s.id, { q: "%" }).total, 0);
    assert.equal(
      queryPage(root, s.id, { kind: "documents", q: "%_" }).total,
      1,
    );
    assert.equal(
      queryPage(root, s.id, { identifier: { type: "parcel", value: "123" } })
        .total,
      0,
    );
    assert.equal(queryPage(root, s.id, { q: "' OR 1=1 --" }).total, 0);
    assert.equal(
      queryPage(root, s.id, {
        q: "River",
        statuses: ["Active"],
        uses: ["Domestic"],
        sources: ["fixture"],
      }).total,
      20,
    );
    assert.equal(
      queryPage(root, s.id, { depth: { min: 1, max: 1, unit: "m" } }).total,
      1,
    );
    assert.equal(
      queryPage(root, s.id, { depth: { min: 3.2, max: 3.3, unit: "ft" } })
        .total,
      1,
    );
    assert.equal(
      queryPage(root, s.id, { kind: "construction", reports: "downloaded" })
        .total,
      1,
    );
    assert.equal(
      queryPage(root, s.id, {
        kind: "documents",
        downloadStates: ["not_requested"],
      }).total,
      1,
    );
    for (const sort of ["id", "title", "address", "depth", "source"] as const)
      for (const direction of ["asc", "desc"] as const) {
        let cursor: string | undefined;
        const ids: string[] = [];
        do {
          const p = queryPage(root, s.id, {
            sort,
            direction,
            pageSize: 25,
            cursor,
          });
          assert.equal(p.total, 120);
          ids.push(...p.items.map((r) => r.id));
          cursor = p.nextCursor ?? undefined;
        } while (cursor);
        assert.equal(ids.length, 120);
        assert.equal(new Set(ids).size, 120);
      }
    const first = queryPage(root, s.id, { pageSize: 25 });
    assert.throws(
      () => queryPage(root, s.id, { cursor: first.nextCursor, q: "River" }),
      /another search/,
    );
    assert.throws(
      () => queryPage(root, s.id, { cursor: "not-json" }),
      /Invalid page cursor/,
    );
    assert.throws(() => QuerySchema.parse({ pageSize: 1000 }));
    assert.throws(() =>
      QuerySchema.parse({
        date: { meaning: "observation", from: "2023-02-29" },
      }),
    );
    assert.throws(() =>
      QuerySchema.parse({ kind: "documents", reports: "any" }),
    );
    assert.throws(() => QuerySchema.parse({ depth: { min: 10, max: 1 } }));
    assert.throws(() =>
      QuerySchema.parse({ q: "one two three four five six seven eight nine" }),
    );
    const cap = capabilities(root, s.id, "documents");
    assert.ok(cap.downloadStates.includes("not_requested"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("immutable snapshots and all-row exports preserve originals and serializer semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "well-export-"));
  try {
    const f = fixture(root, 120);
    const originalHash = hash(readFileSync(join(f.dir, "state.sqlite"))),
      manifestHash = hash(readFileSync(join(f.dir, "manifest.json")));
    const s = buildSnapshot(root, f.runKey);
    assert.equal(hash(readFileSync(join(f.dir, "state.sqlite"))), originalHash);
    assert.equal(
      hash(readFileSync(join(f.dir, "manifest.json"))),
      manifestHash,
    );
    const query = QuerySchema.parse({ sort: "title", direction: "desc" });
    for (const format of ["json", "jsonl", "csv"] as const) {
      const id = randomUUID(),
        result = exportRecords(root, s.id, id, { query, format }),
        text = readFileSync(join(exportDir(root, id), result.file), "utf8");
      assert.equal(result.rows, 120);
      assert.equal(hash(text), result.sha256);
      if (format === "csv") {
        assert.ok(text.includes("'=Formula"));
        assert.ok(text.includes("additional_fields"));
      } else {
        const rows =
          format === "json"
            ? JSON.parse(text)
            : text
                .trim()
                .split("\n")
                .map((x) => JSON.parse(x));
        assert.equal(rows.length, 120);
        assert.equal(rows[0].id, queryPage(root, s.id, query).items[0]!.id);
        assert.equal(rows[0].source_fields.zero, 0);
      }
    }
    for (const kind of [
      "construction",
      "documents",
      "observations",
    ] as Kind[]) {
      const result = exportRecords(root, s.id, randomUUID(), {
        query: QuerySchema.parse({ kind }),
        format: "jsonl",
      });
      assert.equal(result.rows, s.counts[kind]);
    }
    const empty = exportRecords(root, s.id, randomUUID(), {
      query: QuerySchema.parse({ q: "no matching entry" }),
      format: "json",
    });
    assert.equal(empty.rows, 0);
    const db = new Store(f.dir);
    db.set("attempt", 2);
    db.set("outcome", "running");
    db.db.exec("DELETE FROM entities WHERE kind='wells'");
    db.close();
    assert.equal(queryPage(root, s.id, {}).total, 120);
    assert.throws(() => buildSnapshot(root, f.runKey), /Finish or recover/);
    const db2 = new Store(f.dir);
    db2.set("outcome", "partial");
    db2.set("attempt_ended_at", "2026-10-30T12:00:00Z");
    db2.close();
    const s2 = buildSnapshot(root, f.runKey);
    assert.equal(queryPage(root, s2.id, {}).total, 0);
    assert.equal(queryPage(root, s.id, {}).total, 120);
    writeFileSync(
      join(snapshotDir(root, s2.id), "snapshot.json"),
      JSON.stringify({ ...s2, version: 999 }),
    );
    assert.throws(() => getSnapshot(root, s2.id), /Rebuild/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("index lifecycle cancels, retries and survives server restart as completed immutable data", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-explorer-jobs-"));
  const f = fixture(root, 10000);
  let service = new ExplorerService(root);
  try {
    const j = service.startIndex(f.runKey).job!;
    assert.equal(service.startIndex(f.runKey).job?.id, j.id);
    await service.cancel(j.id);
    assert.equal(service.job(j.id).state, "cancelled");
    const next = service.startIndex(f.runKey).job!;
    await until(() => service.job(next.id).state !== "running");
    assert.equal(
      service.job(next.id).state,
      "complete",
      service.job(next.id).error,
    );
    const s = getSnapshot(root, next.id);
    const response = (await service.request("query", {
      snapshot: s.id,
      query: { q: "River" },
    })) as { total: number };
    assert.ok(response.total > 0);
    const exportJob = service.startExport(s.id, { query: {}, format: "csv" });
    assert.throws(
      () => service.startExport(s.id, { query: {}, format: "csv" }),
      /already running/,
    );
    await until(() => service.job(exportJob.id).state !== "running");
    assert.equal(
      service.job(exportJob.id).state,
      "complete",
      service.job(exportJob.id).error,
    );
    assert.throws(() => service.removeSnapshot(s.id), /Delete completed/);
    service.removeExport(exportJob.id);
    await service.close();
    service = new ExplorerService(root);
    assert.equal(service.startIndex(f.runKey).snapshot?.id, s.id);
    service.removeSnapshot(s.id);
    assert.throws(() => getSnapshot(root, s.id), /missing/);
    const interrupted = service.startIndex(f.runKey).job!;
    await service.close();
    assert.equal(service.job(interrupted.id).state, "interrupted");
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("report API verifies bytes and ranges, guards origin, paths and export publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-report-api-")),
    f = fixture(root),
    s = buildSnapshot(root, f.runKey),
    app = await createDashboard({ root });
  const route = `/api/explorer/${s.id}/report?id=deq%3A1%3Adocument`;
  try {
    const token = (await app.inject("/api/bootstrap")).json().token;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: `/api/explorer/${s.id}/query`,
          payload: {},
        })
      ).statusCode,
      403,
    );
    const q = await app.inject({
      method: "POST",
      url: `/api/explorer/${s.id}/query`,
      payload: { q: "River" },
      headers: { "x-well-token": token },
    });
    assert.equal(q.statusCode, 200, q.body);
    assert.equal(q.json().total, 40);
    const report = await app.inject(route);
    assert.equal(report.statusCode, 200, report.body);
    assert.equal(report.headers["content-type"], "application/pdf");
    assert.deepEqual(report.rawPayload, f.body);
    const head = await app.inject({ method: "HEAD", url: route });
    assert.equal(head.statusCode, 200);
    assert.equal(head.body, "");
    assert.equal(Number(head.headers["content-length"]), f.body.length);
    const range = await app.inject({
      url: route,
      headers: { range: "bytes=0-4" },
    });
    assert.equal(range.statusCode, 206);
    assert.equal(range.body, "%PDF-");
    assert.equal(
      (await app.inject({ url: route, headers: { range: "bytes=999999-" } }))
        .statusCode,
      416,
    );
    assert.equal(
      (await app.inject({ url: route, headers: { range: "bytes=0-1,4-8" } }))
        .statusCode,
      416,
    );
    assert.equal(
      (await app.inject(`/api/explorer/${s.id}/report?id=hyland%3A1`))
        .statusCode,
      409,
    );
    assert.equal(
      (
        await app.inject({
          url: route,
          headers: { origin: "https://other.example" },
        })
      ).statusCode,
      403,
    );
    const changed = Buffer.from(f.body);
    changed[10] = 65;
    writeFileSync(join(f.dir, f.local), changed);
    assert.equal((await app.inject(route)).statusCode, 422);
    rmSync(join(f.dir, f.local));
    assert.equal((await app.inject(route)).statusCode, 404);
    const outside = join(root, "outside.pdf");
    writeFileSync(outside, f.body);
    symlinkSync(outside, join(f.dir, f.local));
    assert.equal((await app.inject(route)).statusCode, 422);
    // A job that fails before publication is never downloadable.
    const id = randomUUID();
    mkdirSync(join(root, ".dashboard", "exports"), { recursive: true });
    writeFileSync(
      join(root, ".dashboard", "exports", id + ".tmp"),
      "blocked path",
    );
    assert.throws(() =>
      exportRecords(root, s.id, id, {
        query: QuerySchema.parse({}),
        format: "csv",
      }),
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed builds and interrupted writes never publish, and corrupt caches are removable", () => {
  const root = mkdtempSync(join(tmpdir(), "well-explorer-races-"));
  try {
    const f = fixture(root, 1100),
      id = randomUUID();
    let changed = false;
    assert.throws(
      () =>
        buildSnapshot(root, f.runKey, id, (n) => {
          if (n < 500 || changed) return;
          changed = true;
          const db = new Store(f.dir);
          db.set("attempt", 2);
          db.set("outcome", "running");
          db.close();
        }),
      /changed during indexing/,
    );
    assert.throws(() => getSnapshot(root, id), /missing/);
    const db = new Store(f.dir);
    db.set("outcome", "partial");
    db.close();
    const s = buildSnapshot(root, f.runKey),
      exportId = randomUUID();
    // Inject the same failure raised by an exhausted filesystem after writes start.
    assert.throws(
      () =>
        exportRecords(
          root,
          s.id,
          exportId,
          { query: QuerySchema.parse({}), format: "jsonl" },
          (n) => {
            if (n >= 500)
              throw Object.assign(new Error("No space left on device"), {
                code: "ENOSPC",
              });
          },
        ),
      /No space/,
    );
    assert.throws(() =>
      readFileSync(join(exportDir(root, exportId), "manifest.json")),
    );
    assert.throws(() =>
      readFileSync(join(exportDir(root, exportId) + ".tmp", "records.jsonl")),
    );
    const original = hash(readFileSync(join(f.dir, "state.sqlite")));
    writeFileSync(
      join(snapshotDir(root, s.id), "index.sqlite"),
      "broken cache",
    );
    assert.throws(() => queryPage(root, s.id, {}), /Clear this search cache/);
    const service = new ExplorerService(root);
    service.removeSnapshot(s.id);
    assert.equal(buildSnapshot(root, f.runKey).counts.wells, 1100);
    assert.equal(hash(readFileSync(join(f.dir, "state.sqlite"))), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reader leases and worker bounds protect cleanup; cancelled exports can retry", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-explorer-bounds-")),
    f = fixture(root, 10000),
    s = buildSnapshot(root, f.runKey),
    service = new ExplorerService(root);
  try {
    const first = service.request("query", {
      snapshot: s.id,
      query: { q: "River" },
    });
    const second = service.request("query", {
      snapshot: s.id,
      query: { q: "Lake" },
    });
    assert.throws(() => service.removeSnapshot(s.id), /being read/);
    await assert.rejects(
      service.request("query", { snapshot: s.id, query: {} }),
      /busy/,
    );
    await Promise.all([first, second]);
    const job = service.startExport(s.id, { query: {}, format: "jsonl" });
    await service.cancel(job.id);
    assert.equal(service.job(job.id).state, "cancelled");
    assert.throws(() =>
      readFileSync(join(exportDir(root, job.id), "manifest.json")),
    );
    const abandoned = exportDir(root, job.id) + ".tmp";
    mkdirSync(abandoned, { recursive: true });
    writeFileSync(join(abandoned, "records.jsonl"), "unfinished");
    writeFileSync(
      join(root, ".dashboard", "explorer-jobs", job.id + ".json"),
      JSON.stringify({ ...job, state: "running", pid: 0 }),
    );
    assert.equal(service.job(job.id).state, "interrupted");
    assert.throws(() => readFileSync(join(abandoned, "records.jsonl")));
    const retry = service.startExport(s.id, { query: {}, format: "jsonl" });
    await until(() => service.job(retry.id).state !== "running");
    assert.equal(
      service.job(retry.id).state,
      "complete",
      service.job(retry.id).error,
    );
    service.removeExport(retry.id);
    service.removeSnapshot(s.id);
    await assert.rejects(
      service.request("query", { snapshot: s.id, query: {} }),
      /missing/,
    );
  } finally {
    await service.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit relationships retain missing and ambiguous targets without inferring nearby matches", () => {
  const root = mkdtempSync(join(tmpdir(), "well-explorer-links-"));
  try {
    const f = fixture(root),
      db = new Store(f.dir);
    const original = JSON.parse(
      String(
        db.db
          .prepare("SELECT value FROM entities WHERE kind='wells' LIMIT 1")
          .get()!.value,
      ),
    );
    db.put("construction", { ...original, id: "shared" });
    db.put("wells", { ...original, id: "shared" });
    for (const [id, to] of [
      ["ambiguous", "shared"],
      ["missing", "absent"],
    ])
      db.put("relationships", {
        ...original,
        id,
        from_id: "deq:1",
        to_id: to,
        relationship_type: "published",
        evidence: "source_reference",
      });
    for (let i = 0; i < 55; i++)
      db.put("relationships", {
        ...original,
        id: "many:" + i,
        from_id: "deq:1",
        to_id: "unavailable:" + i,
        relationship_type: "published",
        evidence: "source_reference",
      });
    db.put("observations", {
      ...original,
      id: "ambient",
      source_id: "fixture-monitoring",
      record_id: "shared",
    });
    db.close();
    const s = buildSnapshot(root, f.runKey),
      first = links(root, s.id, "construction", "deq:1"),
      second = links(root, s.id, "construction", "deq:1", first.next!);
    assert.equal(first.items.length, 50);
    assert.equal(first.total, 58);
    assert.equal(second.items.length, 8);
    const all = [...first.items, ...second.items];
    assert.equal(all.find((l) => l.id === "shared")?.resolved, false);
    assert.equal(all.find((l) => l.id === "absent")?.resolved, false);
    // An observation that names its well (record_id) is linked to that well,
    // whichever collector stored it; nothing is inferred when record_id is absent.
    assert.equal(links(root, s.id, "observations", "ambient").total, 1);
    assert.equal(links(root, s.id, "documents", "hyland:1").total, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("finalized empty, cancelled and unsupported collections retain their actual outcome", () => {
  for (const outcome of ["partial", "cancelled", "unsupported"]) {
    const root = mkdtempSync(join(tmpdir(), "well-explorer-empty-"));
    try {
      const f = fixture(root, 0),
        db = new Store(f.dir);
      db.set("outcome", outcome);
      db.db.exec("DELETE FROM entities");
      db.close();
      const s = buildSnapshot(root, f.runKey);
      assert.equal(s.outcome, outcome);
      assert.equal(queryPage(root, s.id, {}).total, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("report MIME, TIFF fallback and invalid document paths are handled locally", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-explorer-media-")),
    f = fixture(root),
    db = new Store(f.dir);
  const doc = JSON.parse(
    String(
      db.db
        .prepare(
          "SELECT value FROM entities WHERE kind='documents' AND id='deq:1:document'",
        )
        .get()!.value,
    ),
  );
  const media: [string, Buffer, string][] = [
    [
      "png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jH1sAAAAASUVORK5CYII=",
        "base64",
      ),
      "image/png",
    ],
    ["jpg", Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]), "image/jpeg"],
    [
      "tiff",
      Buffer.from([73, 73, 42, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      "image/tiff",
    ],
    ["pdf", Buffer.from("<html>Not a public report</html>"), "invalid"],
  ];
  for (const [ext, body] of media) {
    const sha = hash(body),
      local = `attachments/${sha}.${ext}`;
    writeFileSync(join(f.dir, local), body);
    db.put("documents", {
      ...doc,
      id: ext,
      sha256: sha,
      local_path: local,
      byte_count: body.length,
    });
  }
  for (const [id, path] of [
    ["traversal", "attachments/../manifest.json"],
    ["encoded", "attachments/%2e%2e%2fmanifest.json"],
  ])
    db.put("documents", { ...doc, id, local_path: path });
  db.close();
  const s = buildSnapshot(root, f.runKey),
    app = await createDashboard({ root });
  try {
    for (const [ext, body, mime] of media) {
      const response = await app.inject(
        `/api/explorer/${s.id}/report?id=${ext}`,
      );
      assert.equal(
        response.statusCode,
        mime === "invalid" ? 422 : 200,
        response.body,
      );
      if (mime !== "invalid") {
        assert.equal(response.headers["content-type"], mime);
        assert.deepEqual(response.rawPayload, body);
        assert.match(
          String(response.headers["content-disposition"]),
          ext === "tiff" ? /^attachment/ : /^inline/,
        );
      }
    }
    for (const id of ["traversal", "encoded"])
      assert.equal(
        (await app.inject(`/api/explorer/${s.id}/report?id=${id}`)).statusCode,
        422,
      );
    assert.equal(
      (await app.inject(`/api/explorer/${s.id}/report?id=absent`)).statusCode,
      404,
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
