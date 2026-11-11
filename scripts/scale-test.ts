import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Store } from "../src/storage/store.js";
import { ConfigSchema } from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import { collectArcgis } from "../src/sources/arcgis.js";
import { registry } from "../src/sources/registry.js";
import { fixtureBoundary } from "../tests/fixtures/boundary.js";
import { HttpClient } from "../src/transports/http.js";
import { Logger } from "../src/core/logger.js";
import { exportData } from "../src/storage/export.js";
import { createServer } from "node:http";

const total = 100000;
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  const url = new URL(req.url!, "http://fixture");
  const params =
    req.method === "POST"
      ? new URLSearchParams(Buffer.concat(chunks).toString())
      : url.searchParams;
  res.setHeader("content-type", "application/json");
  if (!url.pathname.endsWith("/query"))
    res.end(
      JSON.stringify({
        fields: [{ name: "OBJECTID", type: "esriFieldTypeOID" }],
        maxRecordCount: 500,
        spatialReference: { wkid: 4326 },
      }),
    );
  else if (params.has("returnIdsOnly"))
    res.end(
      JSON.stringify({
        objectIds: Array.from({ length: total }, (_, i) => i + 1),
      }),
    );
  else
    res.end(
      JSON.stringify({
        features: params
          .get("objectIds")!
          .split(",")
          .map((id) => ({
            attributes: {
              OBJECTID: Number(id),
              nullable: null,
              zero: 0,
              note: "public fixture",
            },
            geometry: { x: -80.84, y: 35.22 },
          })),
      }),
    );
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const dir = mkdtempSync(join(tmpdir(), "well-scale-")),
  store = new Store(dir);
try {
  const config = ConfigSchema.parse({
    state: "NC",
    county: "Mecklenburg",
    jsonArray: true,
  });
  const ctx = {
    config,
    geo: resolveGeography("NC", "Mecklenburg"),
    source: {
      ...registry.find((s) => s.id === "arcgis-services")!,
      origins: [base],
    },
    boundary: fixtureBoundary,
    store,
    logger: new Logger(dir, "scale", 1, true),
    http: new HttpClient({ origins: [base], intervalMs: 0, testMode: true }),
    signal: new AbortController().signal,
    runId: "scale",
    records: 0,
  };
  await collectArcgis(ctx, [{ id: "private", url: base + "/layer" }]);
  assert.equal(store.count("wells"), total);
  assert.equal(store.results()[0]!.accepted, total);
  exportData(store, config);
  const maxRssBytes = process.resourceUsage().maxRSS * 1024;
  assert.ok(maxRssBytes < 1024 ** 3, `Peak RSS ${maxRssBytes} exceeds 1 GiB`);
  console.log(
    JSON.stringify(
      {
        records: total,
        peakRssMiB: Math.round(maxRssBytes / 1024 ** 2),
        node: process.version,
        platform: process.platform,
        architecture: process.arch,
        directory: dir,
      },
      null,
      2,
    ),
  );
} finally {
  store.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
