import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ConfigSchema } from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import { collectArcgis } from "../src/sources/arcgis.js";
import { registry } from "../src/sources/registry.js";
import { HttpClient } from "../src/transports/http.js";
import { Logger } from "../src/core/logger.js";
import { checkRecordBudget } from "../src/sources/context.js";
import { fixtureBoundary } from "./fixtures/boundary.js";

for (const scenario of [
  "empty",
  "missing",
  "duplicate",
  "truncated",
  "drift",
  "schema",
  "disk",
]) {
  test(`ArcGIS contract handles ${scenario} without false completeness`, async () => {
    const dir = mkdtempSync(join(tmpdir(), "well-contract-")),
      store = new Store(dir);
    let enumerations = 0,
      changed = false;
    const mock = {
      opts: {},
      check() {},
      async formJson(url: string, params: Record<string, string>) {
        return this.json(url + "?" + new URLSearchParams(params));
      },
      async json(url: string) {
        const u = new URL(url);
        if (!u.pathname.endsWith("/query"))
          return {
            fields: [
              {
                name: changed ? "NEW_ID" : "OBJECTID",
                type: "esriFieldTypeOID",
              },
            ],
            maxRecordCount: 2,
            spatialReference: { wkid: 4326 },
          };
        if (u.searchParams.has("returnIdsOnly")) {
          enumerations++;
          return {
            objectIds:
              scenario === "empty"
                ? []
                : scenario === "drift" && enumerations > 1
                  ? [1, 2, 3]
                  : [1, 2],
          };
        }
        const ids =
          scenario === "missing"
            ? [1]
            : scenario === "duplicate"
              ? [1, 1]
              : [1, 2];
        return {
          features: ids.map((id) => ({
            attributes: { OBJECTID: id },
            geometry: { x: -80.84, y: 35.22 },
          })),
          exceededTransferLimit: scenario === "truncated",
        };
      },
    } as unknown as HttpClient;
    const ctx = {
      config: ConfigSchema.parse({
        state: "NC",
        county: "Mecklenburg",
        ...(scenario === "disk"
          ? { minFreeBytes: Number.MAX_SAFE_INTEGER }
          : {}),
      }),
      geo: resolveGeography("NC", "Mecklenburg"),
      source: registry.find((s) => s.id === "arcgis-services")!,
      store,
      logger: new Logger(dir, "test", 1, true),
      http: mock,
      signal: new AbortController().signal,
      runId: "test",
      records: 0,
      boundary: fixtureBoundary,
    };
    try {
      if (scenario === "disk")
        assert.throws(() => checkRecordBudget(ctx), /Free disk space/);
      await collectArcgis(ctx, [
        { id: "private", url: "https://fixture.gov/layer" },
      ]);
      if (scenario === "schema") {
        changed = true;
        await collectArcgis(ctx, [
          { id: "private", url: "https://fixture.gov/layer" },
        ]);
      }
      const result = store.results()[0]!;
      if (scenario === "empty") {
        assert.equal(result.status, "success");
        assert.equal(result.expected, 0);
      } else if (scenario === "drift") {
        assert.equal(result.status, "partial");
        assert.ok(result.caveats.some((c) => c.includes("changed")));
      } else if (scenario === "schema") {
        assert.equal(result.status, "partial");
        assert.equal(result.errors[0]?.code, "SCHEMA_CHANGED");
      } else {
        assert.notEqual(result.status, "success");
        assert.equal(store.count(), 0);
      }
    } finally {
      store.close();
    }
  });
}
