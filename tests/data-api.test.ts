import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDashboard } from "../src/dashboard/server.js";
import { Store } from "../src/storage/store.js";
import { ConfigSchema } from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import { localDay } from "../src/core/util.js";
import { newRunId, runPath } from "../src/core/runner.js";
import { runList } from "../src/dashboard/runs.js";

function saveRun(
  root: string,
  day: string,
  state: string,
  county: string,
  rows: {
    kind: "wells" | "observations";
    id: string;
    approach: string;
    extra?: Record<string, unknown>;
  }[],
) {
  const geo = resolveGeography(state, county);
  const runId = newRunId(geo, new Date(day + "T12:00:00"));
  const dir = runPath(root, runId);
  const store = new Store(dir);
  store.set("run_id", runId);
  store.set("day", day);
  store.set("geo", geo);
  store.set("config", ConfigSchema.parse({ state, county, output: root }));
  store.set("sources", []);
  store.set("started_at", new Date(day + "T12:00:00").toISOString());
  store.set("attempt", 1);
  store.set("outcome", "success");
  for (const row of rows)
    store.put(row.kind, {
      id: row.id,
      native_id: row.id,
      source_id: row.approach === "api" ? "arcgis-services" : "wqp-downloads",
      dataset_id: "fixture",
      acquisition_method: row.approach,
      county_geoid: geo.county_geoid,
      source_url: "https://example.gov/" + row.id,
      retrieved_at: new Date(day + "T12:00:00").toISOString(),
      raw_path: "raw/x.json",
      raw_sha256: "a".repeat(64),
      source_fields: { note: row.id },
      quality_flags: [],
      ...row.extra,
    });
  store.close();
  return { runId, dir };
}

test("runs are filed and listed by collection day, not by timestamp", () => {
  const root = mkdtempSync(join(tmpdir(), "well-day-"));
  try {
    const geo = resolveGeography("NC", "Mecklenburg");
    const morning = newRunId(geo, new Date(2026, 10, 10, 8, 5)),
      evening = newRunId(geo, new Date(2026, 10, 10, 23, 55));
    assert.match(morning, /^2026-11-10_nc-mecklenburg-county_[a-f0-9]{8}$/);
    // Two collections on the same day share one day folder.
    assert.equal(runPath(root, morning), join(root, "2026-11-10", morning));
    assert.equal(runPath(root, evening), join(root, "2026-11-10", evening));
    assert.equal(localDay(new Date(2026, 0, 5, 0, 1)), "2026-01-05");
    // Runs made before day folders existed are still found where they are.
    mkdirSync(join(root, "2026-11-04T17-51-56-279Z_1e25d343"));
    assert.equal(
      runPath(root, "2026-11-04T17-51-56-279Z_1e25d343"),
      join(root, "2026-11-04T17-51-56-279Z_1e25d343"),
    );
    assert.throws(() => runPath(root, "../escape"), /invalid path/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("data API returns stored records grouped by day with filters, paging and CSV", async () => {
  const root = mkdtempSync(join(tmpdir(), "well-api-"));
  const first = saveRun(root, "2026-11-09", "NC", "Mecklenburg", [
    { kind: "wells", id: "old:1", approach: "api" },
  ]);
  const second = saveRun(root, "2026-11-10", "NC", "Mecklenburg", [
    {
      kind: "wells",
      id: "a:1",
      approach: "api",
      extra: { address: "12 Spring Rd" },
    },
    { kind: "wells", id: "a:2", approach: "download" },
    {
      kind: "observations",
      id: "o:1",
      approach: "download",
      extra: { parameter: "Nitrate" },
    },
  ]);
  const third = saveRun(root, "2026-11-10", "TX", "Travis", [
    { kind: "wells", id: "t:1", approach: "api" },
  ]);
  mkdirSync(join(second.dir, "attachments"));
  writeFileSync(
    join(second.dir, "attachments", "f".repeat(64) + ".csv"),
    "id\n1\n",
  );
  const app = await createDashboard({ root });
  const get = async (url: string) => {
    const response = await app.inject(url);
    return {
      status: response.statusCode,
      body: response.body,
      json: () => response.json(),
    };
  };
  try {
    assert.ok(
      (await get("/api/v1")).json().endpoints["GET /api/v1/days/{day}/records"],
    );
    const { days } = (await get("/api/v1/days")).json();
    assert.deepEqual(
      days.map(
        (d: { day: string; runs: number; counts: { wells: number } }) => [
          d.day,
          d.runs,
          d.counts.wells,
        ],
      ),
      [
        ["2026-11-10", 2, 3],
        ["2026-11-09", 1, 1],
      ],
    );
    assert.deepEqual(days[0].counties.sort(), [
      "Mecklenburg County, NC",
      "Travis County, TX",
    ]);
    const day = (await get("/api/v1/days/2026-11-10")).json();
    assert.deepEqual(
      day.run_list.map((r: { run_id: string }) => r.run_id).sort(),
      [second.runId, third.runId].sort(),
    );
    assert.equal((await get("/api/v1/days/2026-11-01")).status, 404);
    assert.equal((await get("/api/v1/days/yesterday")).status, 400);

    // Everything collected on the day, across both counties and all approaches.
    const all = (await get("/api/v1/days/2026-11-10/records")).json();
    assert.equal(all.total, 3);
    assert.deepEqual(all.records.map((r: { id: string }) => r.id).sort(), [
      "a:1",
      "a:2",
      "t:1",
    ]);
    assert.ok(
      all.records.every(
        (r: { collected_day: string }) => r.collected_day === "2026-11-10",
      ),
    );
    // Filters.
    const nc = (
      await get(
        "/api/v1/days/2026-11-10/records?state=nc&county=Mecklenburg%20County",
      )
    ).json();
    assert.deepEqual(
      nc.records.map((r: { id: string }) => r.id),
      ["a:1", "a:2"],
    );
    assert.equal(
      (await get("/api/v1/days/2026-11-10/records?county=48453")).json()
        .records[0].id,
      "t:1",
    );
    assert.equal(
      (await get("/api/v1/days/2026-11-10/records?approach=download")).json()
        .records[0].id,
      "a:2",
    );
    assert.equal(
      (await get("/api/v1/days/2026-11-10/records?q=Spring%20Rd")).json().total,
      1,
    );
    assert.equal(
      (await get("/api/v1/days/2026-11-10/records?q=100%25")).json().total,
      0,
    );
    assert.equal(
      (await get("/api/v1/days/2026-11-10/records?kind=observations")).json()
        .records[0].parameter,
      "Nitrate",
    );
    assert.equal((await get("/api/v1/records?kind=wells")).json().total, 4);
    assert.equal(
      (await get("/api/v1/records?from=2026-11-10")).json().total,
      3,
    );
    assert.equal(
      (await get(`/api/v1/runs/${first.runId}/records`)).json().records[0].id,
      "old:1",
    );
    // Paging continues across runs without repeating or skipping rows.
    const seen: string[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page = (
        await get(`/api/v1/records?limit=1&offset=${offset}`)
      ).json();
      seen.push(...page.records.map((r: { id: string }) => r.id));
      offset = page.next_offset;
    }
    assert.deepEqual(seen.sort(), ["a:1", "a:2", "old:1", "t:1"]);
    // Runs, single records, files, CSV.
    const listed = (await get("/api/v1/runs?day=2026-11-10")).json().runs;
    assert.equal(listed.length, 2);
    assert.equal(
      (await get(`/api/v1/runs/${third.runId}`)).json().county,
      "Travis County",
    );
    assert.equal((await get("/api/v1/runs/missing")).status, 404);
    assert.equal(
      (await get("/api/v1/record?kind=wells&id=a%3A1")).json().records[0]
        .address,
      "12 Spring Rd",
    );
    assert.equal((await get("/api/v1/record?kind=wells&id=nope")).status, 404);
    assert.equal(
      (await get(`/api/v1/files/${"f".repeat(64)}`)).body,
      "id\n1\n",
    );
    assert.equal((await get(`/api/v1/files/${"e".repeat(64)}`)).status, 404);
    const csv = (
      await get("/api/v1/days/2026-11-10/records?format=csv&state=TX")
    ).body
      .trim()
      .split("\n");
    assert.match(csv[0]!, /^collected_day,run_id,id,/);
    assert.match(
      csv[1]!,
      /^2026-11-10,2026-11-10_tx-travis-county_[a-f0-9]{8},t:1,/,
    );
    // Invalid input is rejected; the API cannot change anything.
    assert.equal((await get("/api/v1/records?kind=secrets")).status, 400);
    assert.equal((await get("/api/v1/records?limit=5000")).status, 400);
    assert.equal(
      (await app.inject({ method: "POST", url: "/api/v1/records" })).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/v1/days",
          headers: { host: "example.com" },
        })
      ).statusCode,
      403,
    );
    // The dashboard's own history carries the day used for grouping.
    assert.deepEqual(
      runList(root)
        .map((r) => r.day)
        .sort(),
      ["2026-11-09", "2026-11-10", "2026-11-10"],
    );
  } finally {
    await app.close();
    rmSync(root, { recursive: true, force: true });
  }
});
