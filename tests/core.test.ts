import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ConfigSchema,
  type Entity,
  type SourceManifest,
} from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import { redact, hash } from "../src/core/util.js";
import { Store, lockRun } from "../src/storage/store.js";
import { csvCell, exportData, aggregate } from "../src/storage/export.js";
import { parseResult } from "../src/data/normalize.js";
import {
  isPublicAddress,
  validateUrl,
  HttpClient,
} from "../src/transports/http.js";
import { resolveCredentials } from "../src/credentials/index.js";
import { registry, portalManifest } from "../src/sources/registry.js";
import { collectArcgis } from "../src/sources/arcgis.js";
import { Logger } from "../src/core/logger.js";
import { fileType, isWellDocument } from "../src/sources/documents.js";
import { fixtureBoundary } from "./fixtures/boundary.js";
const temp = () => mkdtempSync(join(tmpdir(), "waterwell-test-"));
const geo = resolveGeography("NC", "Mecklenburg");
const config = ConfigSchema.parse({
  state: "NC",
  county: "Mecklenburg",
  jsonArray: true,
});
const entity: Entity = {
  id: "test:01",
  native_id: "01",
  source_id: "test",
  dataset_id: "test",
  county_geoid: "37119",
  source_url: "https://example.gov/1",
  retrieved_at: "2026-10-27T00:00:00Z",
  raw_path: "raw/test.json",
  raw_sha256: "a".repeat(64),
  source_fields: { zero: 0, empty: "", text: "=1+1", nested: { a: "b" } },
  quality_flags: [],
};
test("county aliases, current equivalents, and wrong-state errors", () => {
  assert.equal(geo.county_geoid, "37119");
  assert.equal(
    resolveGeography("North Carolina", "Mecklenburg County").county_geoid,
    "37119",
  );
  assert.equal(resolveGeography("VA", "Richmond city").county_geoid, "51760");
  assert.throws(() => resolveGeography("VA", "Richmond"), /Ambiguous/);
  assert.throws(() => resolveGeography("CA", "Mecklenburg"));
  assert.throws(() => resolveGeography("XX", "Mecklenburg"));
});
test("config rejects unknown options and unbounded values", () => {
  assert.throws(() =>
    ConfigSchema.parse({ state: "NC", county: "Mecklenburg", surprise: 1 }),
  );
  assert.throws(() =>
    ConfigSchema.parse({ state: "NC", county: "Mecklenburg", maxBytes: -1 }),
  );
});
test("quantities retain zero and censoring", () => {
  assert.equal(parseResult(0).value, 0);
  assert.equal(parseResult("<0.01").value, null);
  assert.equal(parseResult("<0.01").limit, 0.01);
  assert.equal(parseResult("not detected").raw_value, "not detected");
  assert.equal(parseResult("-2").value, -2);
});
test("redaction covers nested secrets and URL parameters", () => {
  const text = JSON.stringify(
    redact(
      {
        password: "a",
        nested: {
          url: "https://example.gov/?token=abc&well=01",
          err: "Bearer secrettoken",
        },
        message: "password=abc specific",
      },
      ["specific"],
    ),
  );
  assert.ok(!text.includes("abc"));
  assert.ok(!text.includes("secrettoken"));
  assert.ok(!text.includes("specific"));
  assert.ok(text.includes("well=01"));
});
test("destination restrictions reject private networks and unrelated redirects", () => {
  for (const s of [
    "127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
    "::ffff:127.0.0.1",
  ])
    assert.equal(isPublicAddress(s), false);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  assert.throws(() =>
    validateUrl("https://evil.test/x", ["https://agency.gov"]),
  );
  assert.throws(() =>
    validateUrl("https://user:password@agency.gov", ["https://agency.gov"]),
  );
});
test("byte signatures reject login pages posing as reports", () => {
  assert.equal(fileType(Buffer.from("%PDF-1.7 test")), "pdf");
  assert.throws(() => fileType(Buffer.from("<html>Sign in</html>")));
});
test("shared archive classifies by document type, not address matches", () => {
  const r = {
    Data: [],
    DisplayColumns: [{ Heading: "Document Type", DataType: "text" }],
  };
  assert.equal(
    isWellDocument(
      {
        ID: "x",
        Name: "record",
        DisplayColumnValues: [
          { Value: "GWS - Well Permit File", RawValue: null },
        ],
      },
      r,
    ),
    true,
  );
  assert.equal(
    isWellDocument(
      {
        ID: "x",
        Name: "Well street",
        DisplayColumnValues: [{ Value: "Septic Permit File", RawValue: null }],
      },
      r,
    ),
    false,
  );
});
test("transaction rollback does not advance checkpoints or leave exported rows", () => {
  const s = new Store(temp());
  try {
    assert.throws(() =>
      s.transaction(() => {
        s.put("wells", entity);
        s.task("test", "test", "01", "accepted");
        throw Error("crash");
      }),
    );
    assert.equal(s.count(), 0);
    assert.equal(s.done("test", "test", "01"), false);
  } finally {
    s.close();
  }
});
test("upserts and streamed exports preserve source fields and valid JSON", () => {
  const s = new Store(temp());
  try {
    s.put("wells", entity);
    s.put("wells", entity);
    const a = exportData(s, config);
    assert.equal(s.count("wells"), 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(s.dir, "wells.json"), "utf8"))[0]
        .source_fields,
      entity.source_fields,
    );
    assert.equal(
      (a["wells.json"] as { sha256: string }).sha256,
      hash(readFileSync(join(s.dir, "wells.json"))),
    );
    assert.equal(csvCell("=cmd"), "'=cmd");
    assert.equal(csvCell('a,"b'), '"a,""b"');
  } finally {
    s.close();
  }
});
test("a live run lock prevents concurrent writers", () => {
  const d = temp();
  const unlock = lockRun(d);
  assert.throws(() => lockRun(d));
  unlock();
  const again = lockRun(d);
  again();
});
test("local credential profile checks permissions and never mixes providers", () => {
  const dir = temp(),
    path = join(dir, "credentials.json");
  const source = portalManifest("https://portal.example.gov/Archive/");
  writeFileSync(
    path,
    JSON.stringify({
      profiles: {
        test: {
          sourceIds: [source.id],
          allowedOrigins: source.origins,
          provider: "local-file",
          username: "test",
          password: "sample-secret",
        },
      },
    }),
    { mode: 0o600 },
  );
  assert.equal(
    resolveCredentials(source, "test", [path])?.password,
    "sample-secret",
  );
  chmodSync(path, 0o644);
  assert.throws(() => resolveCredentials(source, "test", [path]));
});
test("partial outcomes preserve source-specific auth failures", () => {
  const s = new Store(temp());
  try {
    s.put("wells", entity);
    s.result({
      source_id: "test",
      dataset_id: "test",
      status: "needs_auth",
      completeness: "incomplete",
      expected: null,
      fetched: 0,
      accepted: 0,
      excluded: 0,
      quarantined: 0,
      unresolved: null,
      errors: [],
      caveats: [],
    });
    assert.equal(aggregate(s).outcome, "partial");
    assert.equal(aggregate(s, true).exit_code, 130);
  } finally {
    s.close();
  }
});
test("ArcGIS collects 4501 records across pages and resumes without duplication", async () => {
  const s = new Store(temp());
  try {
    const source: SourceManifest = {
      ...registry.find((s) => s.id === "arcgis-services")!,
      origins: ["https://fixture.gov"],
    };
    const ids = Array.from({ length: 4501 }, (_, i) => i + 1);
    let requests = 0;
    const mock = {
      opts: { testMode: true },
      check() {},
      async formJson(url: string, p: Record<string, string>) {
        return this.json(url + "?" + new URLSearchParams(p));
      },
      async json(url: string) {
        requests++;
        const u = new URL(url);
        if (!u.pathname.endsWith("/query"))
          return {
            fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
            maxRecordCount: 2000,
            spatialReference: { wkid: 4326 },
          };
        if (u.searchParams.has("returnIdsOnly")) return { objectIds: ids };
        const selected = u.searchParams
          .get("objectIds")!
          .split(",")
          .map(Number);
        return {
          features: selected.map((id) => ({
            attributes: { OBJECTID: id, Total_Depth: 0, unknown: "retained" },
            geometry: { x: -80.84, y: 35.22 },
          })),
        };
      },
    } as unknown as HttpClient;
    const ctx = {
      config,
      geo,
      source,
      store: s,
      logger: new Logger(s.dir, "test", 1, true),
      http: mock,
      signal: new AbortController().signal,
      runId: "test",
      records: 0,
      boundary: fixtureBoundary,
    };
    await collectArcgis(ctx, [
      { id: "private", url: "https://fixture.gov/layer" },
    ]);
    assert.equal(s.count("wells"), 4501);
    assert.equal(s.results()[0]!.accepted, 4501);
    const before = requests;
    ctx.records = 0;
    await collectArcgis(ctx, [
      { id: "private", url: "https://fixture.gov/layer" },
    ]);
    assert.equal(s.count("wells"), 4501);
    assert.equal(requests - before, 2);
  } finally {
    s.close();
  }
});
test("ArcGIS record budget can resume the same durable ID snapshot", async () => {
  const s = new Store(temp());
  try {
    const source = registry.find((s) => s.id === "arcgis-services")!;
    const ids = [1, 2, 3];
    const mock = {
      opts: {},
      check() {},
      async formJson(url: string, p: Record<string, string>) {
        return this.json(url + "?" + new URLSearchParams(p));
      },
      async json(url: string) {
        const u = new URL(url);
        if (!u.pathname.endsWith("/query"))
          return {
            fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
            maxRecordCount: 2,
            spatialReference: { wkid: 4326 },
          };
        if (u.searchParams.has("returnIdsOnly")) return { objectIds: ids };
        return {
          features: u.searchParams
            .get("objectIds")!
            .split(",")
            .map((id) => ({
              attributes: { OBJECTID: Number(id) },
              geometry: { x: -80.84, y: 35.22 },
            })),
        };
      },
    } as unknown as HttpClient;
    const ctx = {
      config: { ...config, maxRecords: 1 },
      geo,
      source,
      store: s,
      logger: new Logger(s.dir, "test", 1, true),
      http: mock,
      signal: new AbortController().signal,
      runId: "test",
      records: 0,
      boundary: fixtureBoundary,
    };
    await collectArcgis(ctx, [
      { id: "private", url: "https://fixture.gov/layer" },
    ]);
    assert.equal(s.count("wells"), 1);
    assert.equal(s.results()[0]!.status, "partial");
    ctx.config.maxRecords = 10;
    ctx.records = 0;
    await collectArcgis(ctx, [
      { id: "private", url: "https://fixture.gov/layer" },
    ]);
    assert.equal(s.count("wells"), 3);
  } finally {
    s.close();
  }
});
