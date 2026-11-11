import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ConfigSchema, APPROACHES } from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import {
  BOUNDARY_SERVICE,
  fetchBoundary,
  inBoundary,
} from "../src/geography/boundary.js";
import { registry, selectSources } from "../src/sources/registry.js";
import { HttpClient } from "../src/transports/http.js";
import { Logger } from "../src/core/logger.js";
import { collectArcgis } from "../src/sources/arcgis.js";
import { collectArcgisServices } from "../src/sources/api.js";
import { discoverLayers, layerDatasetId } from "../src/sources/discovery.js";
import { collectWqp, fileLinks } from "../src/sources/downloads.js";
import {
  csvRows,
  detectFileType,
  ingestTable,
  readCsv,
  readGeoJson,
} from "../src/sources/tabular.js";
import {
  classify,
  mapFields,
  unitOf,
  wellRelevance,
} from "../src/data/normalize.js";
import type { Fetcher, SourceContext } from "../src/sources/context.js";
import { fixtureBoundary } from "./fixtures/boundary.js";

// The fixture county is only test input. Any county resolves the same way.
function context(
  source: string,
  extra: Record<string, unknown> = {},
): SourceContext {
  const dir = mkdtempSync(join(tmpdir(), "well-discovery-"));
  return {
    config: ConfigSchema.parse({
      state: "NC",
      county: "Mecklenburg",
      ...extra,
    }),
    geo: resolveGeography("NC", "Mecklenburg"),
    source: registry.find((s) => s.id === source)!,
    store: new Store(dir),
    logger: new Logger(dir, "test", 1, true),
    http: new HttpClient({ origins: [], intervalMs: 0 }),
    signal: new AbortController().signal,
    runId: "test",
    records: 0,
    boundary: fixtureBoundary,
  };
}
const outside = () => {
  const [w, s, e, n] = fixtureBoundary.bbox;
  // A corner of the bounding box that lies beyond the county line.
  return [
    [w + 0.001, s + 0.001],
    [e - 0.001, n - 0.001],
    [w + 0.001, n - 0.001],
    [e - 0.001, s + 0.001],
  ].find((p) => !inBoundary(fixtureBoundary, p))!;
};
const id = (letter: string) => letter.repeat(32);
const item = (
  letter: string,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  id: id(letter),
  title,
  type: "Feature Service",
  url: null,
  snippet: "",
  tags: [],
  owner: "publisher",
  access: "public",
  extent: [
    [-81.1, 35.0],
    [-80.5, 35.5],
  ],
  ...extra,
});

test("every collector applies to every county and all three approaches run by default", () => {
  const anywhere = resolveGeography("TX", "Travis");
  const all = selectSources(anywhere);
  assert.deepEqual([...new Set(all.map((s) => s.approach))], APPROACHES);
  assert.deepEqual(
    selectSources(resolveGeography("NC", "Mecklenburg")).map((s) => s.id),
    all.map((s) => s.id),
  );
  assert.ok(
    selectSources(anywhere, [], ["download"]).every(
      (s) => s.approach === "download",
    ),
  );
  assert.throws(() => selectSources(anywhere, ["made-up"]), /unknown/);
  for (const source of registry) {
    assert.equal("counties" in source, false);
    assert.equal("states" in source, false);
  }
});

test("application code names no county: only nationwide services and the state/county list are built in", () => {
  const nationwide = new Set([
    "www.arcgis.com",
    "hub.arcgis.com",
    "api.waterdata.usgs.gov",
    "www.waterqualitydata.us",
    "tigerweb.geo.census.gov",
    // Directories of official government websites.
    "raw.githubusercontent.com",
    "query.wikidata.org",
    "127.0.0.1",
  ]);
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx)$/.test(name)) files.push(path);
    }
  };
  walk("src");
  walk("web/src");
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const [, host] of text.matchAll(
      /https?:\/\/([a-zA-Z0-9.-]+\.[a-z]{2,})/g,
    ))
      // ".example" is the reserved placeholder domain used in form hints.
      assert.ok(
        nationwide.has(host!) || host!.endsWith(".example"),
        `${file} hard-codes ${host}`,
      );
    assert.doesNotMatch(
      text,
      /\b\d{5}\b["']\s*\]?\s*,?\s*\/\/ ?county|county_geoid\s*===\s*["']\d{5}/,
    );
  }
  // The only reference data shipped with the app is the list of states and counties.
  assert.deepEqual(readdirSync("data").sort(), [
    "counties-2020.txt",
    "counties.json",
  ]);
});

test("county boundary is fetched by GEOID at run time", async () => {
  const urls: string[] = [];
  const geo = resolveGeography("NC", "Mecklenburg");
  const boundary = await fetchBoundary(
    {
      json: async <T>(url: string) => {
        urls.push(url);
        return (
          url.includes("/query")
            ? {
                features: [
                  {
                    ...fixtureBoundary.feature,
                    properties: { GEOID: geo.county_geoid },
                  },
                ],
              }
            : {
                layers: [
                  { id: 0, name: "States" },
                  { id: 7, name: "Counties" },
                ],
              }
        ) as T;
      },
    },
    geo,
  );
  assert.ok(urls[0]!.startsWith(BOUNDARY_SERVICE));
  assert.match(urls[1]!, /\/7\/query\?/);
  assert.match(decodeURIComponent(urls[1]!), /GEOID='37119'/);
  assert.equal(boundary.bbox.length, 4);
  assert.ok(boundary.bbox.every(Number.isFinite));
  assert.ok(
    boundary.bbox[0] < boundary.bbox[2] && boundary.bbox[1] < boundary.bbox[3],
  );
  await assert.rejects(
    fetchBoundary(
      {
        json: async <T>() =>
          ({ layers: [{ id: 1, name: "Counties" }], features: [] }) as T,
      },
      geo,
    ),
    /requested county/,
  );
});

test("well vocabulary ignores everyday uses of 'well' and unrelated wells", () => {
  for (const text of [
    "Private Wells",
    "Well Permits",
    "Groundwater Monitoring",
    "water well records",
    "Well",
  ])
    assert.ok(wellRelevance(text) > 0, text);
  for (const text of [
    "Parks as well as trails",
    "Wellness centers",
    "Oil and Gas Wells",
    "Wells Fargo branches",
    "Caldwell County parcels",
  ])
    assert.equal(wellRelevance(text), 0, text);
});

test("source fields are mapped by name and units come only from the field itself", () => {
  const fields = [
    "House",
    "Media",
    "Information",
    "WellDepth",
    "Casing_Depth_ft",
    "SiteAddress",
    "Status",
    "County",
    "Latitude",
    "Longitude",
    "Permit_No",
    "Owner_Name",
    "DateCompleted",
    "Yield_GPM",
  ].map((name) => ({ name }));
  const map = mapFields(fields);
  assert.deepEqual(
    {
      address: map.address,
      depth: map.total_depth,
      casing: map.casing_depth,
      permit: map.permit_number,
      county: map.county_name,
      done: map.completed_on,
      yielded: map.yield,
    },
    {
      address: "SiteAddress",
      depth: "WellDepth",
      casing: "Casing_Depth_ft",
      permit: "Permit_No",
      county: "County",
      done: "DateCompleted",
      yielded: "Yield_GPM",
    },
  );
  assert.ok(
    !Object.values(map).some((f) =>
      ["House", "Media", "Information"].includes(f),
    ),
  );
  assert.equal(unitOf({ name: "WellDepth" }), null);
  assert.equal(unitOf({ name: "Casing_Depth_ft" }), "ft");
  assert.equal(unitOf({ name: "Yield_GPM" }), "gal/min");
  assert.equal(classify("Well Permits", fields), "construction");
  assert.equal(classify("Private Wells", fields), "wells");
  assert.equal(
    classify("Chemistry", [
      { name: "Parameter" },
      { name: "Result" },
      { name: "Sample_Date" },
    ]),
    "observations",
  );
});

test("catalog discovery keeps public well layers that cover the county and remembers them for resume", async () => {
  const ctx = context("arcgis-services");
  const calls: string[] = [];
  const fetcher = {
    json: async (url: string) => {
      calls.push(url);
      const u = new URL(url);
      if (u.pathname.endsWith("/search")) {
        assert.equal(
          u.searchParams.get("bbox"),
          fixtureBoundary.bbox.join(","),
        );
        return {
          total: 5,
          nextStart: -1,
          results: [
            item("b", "Parks", {
              snippet: "Trails as well as picnic areas",
              url: "https://gis.example.gov/server/rest/services/Parks/FeatureServer/0",
            }),
            item("c", "State Monitoring Wells", {
              url: "http://services9.arcgis.com/ORG/arcgis/rest/services/StateWells/FeatureServer",
              extent: [
                [-84.3, 33.8],
                [-75.4, 36.6],
              ],
            }),
            item("a", "Private Wells", {
              snippet: "Well points in Mecklenburg County",
              url: "https://gis.example.gov/server/rest/services/Wells/FeatureServer/0",
            }),
            item("d", "Restricted Wells", {
              access: "org",
              url: "https://gis.example.gov/server/rest/services/Hidden/FeatureServer/0",
            }),
            item("e", "Faraway Wells", {
              url: "https://far.example.gov/arcgis/rest/services/Wells/FeatureServer/0",
              extent: [
                [-117, 42],
                [-111, 49],
              ],
            }),
          ],
        };
      }
      if (u.pathname.endsWith("/FeatureServer/0"))
        return {
          name: "Private Wells",
          geometryType: "esriGeometryPoint",
          fields: [],
        };
      return {
        layers: [
          {
            id: 0,
            name: "Monitoring Wells",
            geometryType: "esriGeometryPoint",
          },
          {
            id: 1,
            name: "Well Districts",
            geometryType: "esriGeometryPolygon",
          },
          { id: 3, name: "Roads", geometryType: "esriGeometryPoint" },
        ],
        tables: [{ id: 2, name: "Well Samples" }],
      };
    },
  } as unknown as Fetcher;
  try {
    const found = await discoverLayers(ctx, fetcher);
    assert.deepEqual(
      found.targets.map((t) => t.id),
      [
        "gis.example.gov/Wells/FeatureServer/0",
        "services9.arcgis.com/ORG/StateWells/FeatureServer/0",
        "services9.arcgis.com/ORG/StateWells/FeatureServer/2",
      ],
    );
    assert.deepEqual(
      found.items.map((i) => i.title),
      ["Private Wells", "State Monitoring Wells"],
    );
    // Discovered hosts are approved for this source only, and always over HTTPS.
    assert.ok(ctx.http.opts.origins.includes("https://gis.example.gov"));
    assert.ok(ctx.http.opts.origins.includes("https://services9.arcgis.com"));
    assert.ok(!ctx.http.opts.origins.includes("https://far.example.gov"));
    const before = calls.length;
    assert.deepEqual(
      (await discoverLayers(ctx, fetcher)).targets,
      found.targets,
    );
    assert.equal(calls.length, before);
    assert.equal(
      layerDatasetId(
        "https://host.example.gov/arcgis/rest/services/Folder/Wells/MapServer/4",
      ),
      "host.example.gov/Folder/Wells/MapServer/4",
    );
  } finally {
    ctx.store.close();
  }
});

test("layers are limited to the county by its boundary, or by a county column when there is no geometry", async () => {
  const ctx = context("arcgis-services");
  const far = outside();
  const requests: URL[] = [];
  const fetcher = {
    async formJson(url: string, p: Record<string, string>) {
      return this.json(url + "?" + new URLSearchParams(p));
    },
    async json(url: string) {
      const u = new URL(url);
      requests.push(u);
      const table = u.pathname.includes("/Table");
      if (!u.pathname.endsWith("/query"))
        return table
          ? {
              name: "Well Permits",
              type: "Table",
              maxRecordCount: 100,
              fields: [
                { name: "OBJECTID", type: "esriFieldTypeOID" },
                { name: "County" },
                { name: "Permit_No" },
              ],
            }
          : {
              name: "Wells",
              type: "Feature Layer",
              geometryType: "esriGeometryPoint",
              capabilities: "Query",
              maxRecordCount: 100,
              spatialReference: { wkid: 2264 },
              fields: [
                { name: "OBJECTID", type: "esriFieldTypeOID" },
                { name: "Total_Depth_ft" },
                { name: "SWL_ft" },
              ],
            };
      if (u.searchParams.has("returnIdsOnly"))
        return { objectIds: table ? [7] : [1, 2, 3] };
      return {
        features: table
          ? [
              {
                attributes: {
                  OBJECTID: 7,
                  County: "MECKLENBURG",
                  Permit_No: "P-7",
                },
              },
            ]
          : [
              {
                attributes: { OBJECTID: 1, Total_Depth_ft: 120, SWL_ft: 30 },
                geometry: { x: -80.84, y: 35.22 },
              },
              {
                attributes: { OBJECTID: 2, Total_Depth_ft: 90 },
                geometry: { x: far[0], y: far[1] },
              },
              { attributes: { OBJECTID: 3 } },
            ],
      };
    },
  } as unknown as Fetcher;
  try {
    await collectArcgis(
      ctx,
      [
        {
          id: "points",
          url: "https://fixture.gov/arcgis/rest/services/W/FeatureServer/0",
          title: "Wells",
        },
        {
          id: "table",
          url: "https://fixture.gov/arcgis/rest/services/W/FeatureServer/Table",
          title: "Well Permits",
        },
      ],
      fetcher,
    );
    const [points, table] = ctx.store.results();
    assert.deepEqual(
      [points!.accepted, points!.excluded, points!.quarantined],
      [1, 1, 1],
    );
    assert.equal(table!.status, "success");
    const spatial = requests.find(
      (u) =>
        u.pathname.endsWith("/0/query") && u.searchParams.has("returnIdsOnly"),
    )!;
    assert.equal(
      spatial.searchParams.get("geometry"),
      fixtureBoundary.bbox.join(","),
    );
    assert.equal(
      spatial.searchParams.get("geometryType"),
      "esriGeometryEnvelope",
    );
    const named = requests.find(
      (u) =>
        u.pathname.endsWith("/Table/query") &&
        u.searchParams.has("returnIdsOnly"),
    )!;
    assert.equal(
      named.searchParams.get("where"),
      "UPPER(County) IN ('MECKLENBURG','MECKLENBURG COUNTY')",
    );
    assert.equal(named.searchParams.has("geometry"), false);
    assert.ok(requests.some((u) => u.searchParams.get("outSR") === "4326"));
    const [well] = [...ctx.store.entities("wells")];
    assert.equal(well!.acquisition_method, "api");
    assert.equal(well!.county_assignment_method, "point_in_county_boundary");
    assert.deepEqual(
      [
        (well!.total_depth as { value: number; unit: string }).value,
        (well!.total_depth as { unit: string }).unit,
      ],
      [120, "ft"],
    );
    assert.equal(ctx.store.count("observations"), 1);
    const [permit] = [...ctx.store.entities("construction")];
    assert.equal(permit!.county_assignment_method, "explicit_source_county");
    assert.equal(permit!.permit_number, "P-7");
  } finally {
    ctx.store.close();
  }
});

test("API collector reports discovery and tile layers are skipped rather than failed", async () => {
  const ctx = context("arcgis-services");
  const fetcher = {
    async formJson() {
      return { features: [] };
    },
    async json(url: string) {
      const u = new URL(url);
      if (u.pathname.endsWith("/search"))
        return {
          total: 1,
          nextStart: -1,
          results: [
            item("a", "Depth to Groundwater", {
              url: "https://tiles.example.gov/arcgis/rest/services/Depth/MapServer/0",
            }),
          ],
        };
      return {
        name: "Depth to Groundwater",
        capabilities: "Map,TilesOnly",
        maxRecordCount: 0,
      };
    },
  } as unknown as Fetcher;
  try {
    await collectArcgisServices(ctx, fetcher);
    const results = ctx.store.results();
    assert.equal(results.length, 1);
    assert.equal(results[0]!.dataset_id, "discovery");
    assert.equal(results[0]!.status, "success");
    assert.match(
      results[0]!.caveats[0]!,
      /1 public service item\(s\).*1 layer\(s\) selected/,
    );
  } finally {
    ctx.store.close();
  }
});

test("CSV reader handles quotes, embedded line breaks and a byte-order mark", () => {
  const rows = [...csvRows('﻿a,b,c\r\n1,"x, ""y""","line\nbreak"\n\n2,,z')];
  assert.deepEqual(rows, [
    ["a", "b", "c"],
    ["1", 'x, "y"', "line\nbreak"],
    ["2", "", "z"],
  ]);
  assert.equal(detectFileType(Buffer.from("%PDF-1.7")), "pdf");
  assert.equal(detectFileType(Buffer.from("<!DOCTYPE html><html>")), "html");
  assert.equal(
    detectFileType(Buffer.from('{"type":"FeatureCollection","features":[]}')),
    "geojson",
  );
  assert.equal(
    detectFileType(Buffer.from("id,depth,owner\n1,2,3\n"), "wells.csv"),
    "csv",
  );
  assert.equal(
    detectFileType(Buffer.from("PK\u0003\u0004rest"), "wells.xlsx"),
    "xlsx",
  );
  assert.deepEqual(
    fileLinks(
      '<a href="/files/well-logs.csv">Well logs</a><a href="/files/budget.pdf">Budget</a><a href="http://x.example/wells.csv">insecure</a>',
      "https://agency.example.gov/water/",
    ),
    [
      {
        url: "https://agency.example.gov/files/well-logs.csv",
        title: "Well logs",
      },
    ],
  );
});

test("file rows are kept only when a county column or coordinates place them in the county", () => {
  const ctx = context("catalog-files");
  const far = outside();
  try {
    const csv = readCsv(
      [
        "Well_ID,County,Latitude,Longitude,Total_Depth",
        "A1,Mecklenburg,,,100",
        "A2,Wake,35.22,-80.84,50",
        "A3,,35.22,-80.84,75",
        `A4,,${far[1]},${far[0]},60`,
        "A5,,,,40",
      ].join("\n"),
    );
    const counts = ingestTable(ctx, {
      dataset: "file:test",
      title: "Well inventory",
      url: "https://files.example.gov/wells.csv",
      header: csv.header,
      rows: csv.rows,
      raw: { raw_path: "attachments/x.csv", raw_sha256: "a".repeat(64) },
      scope: "rows",
    });
    assert.deepEqual(
      [counts.rows, counts.accepted, counts.excluded],
      [5, 2, 3],
    );
    const wells = [...ctx.store.entities("wells")];
    assert.deepEqual(
      wells.map((w) => [w.source_well_id, w.county_assignment_method]).sort(),
      [
        ["A1", "explicit_source_county"],
        ["A3", "point_in_county_boundary"],
      ],
    );
    assert.equal(wells[0]!.acquisition_method, "download");
    const geo = readGeoJson(
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            properties: { well_id: "G1" },
            geometry: { type: "Point", coordinates: [-80.84, 35.22] },
          },
          {
            properties: { well_id: "G2" },
            geometry: { type: "Point", coordinates: far },
          },
        ],
      }),
    );
    const g = ingestTable(ctx, {
      dataset: "file:geo",
      title: "Wells",
      url: "https://files.example.gov/wells.geojson",
      header: geo.header,
      rows: geo.rows,
      raw: { raw_path: "attachments/y.geojson", raw_sha256: "b".repeat(64) },
      scope: "rows",
    });
    assert.deepEqual([g.accepted, g.excluded], [1, 1]);
  } finally {
    ctx.store.close();
  }
});

test("Water Quality Portal downloads are requested by FIPS, stored as files and rows, and not repeated", async () => {
  const ctx = context("wqp-downloads");
  const urls: string[] = [];
  ctx.http.get = async (url) => {
    urls.push(url);
    const stations = url.includes("/Station/");
    return {
      url,
      headers: stations
        ? { "total-site-count": "2" }
        : { "total-result-count": "3" },
      body: Buffer.from(
        stations
          ? [
              "MonitoringLocationIdentifier,MonitoringLocationName,StateCode,CountyCode,LatitudeMeasure,LongitudeMeasure,WellDepthMeasure/MeasureValue,WellDepthMeasure/MeasureUnitCode",
              "ORG-1,Well One,37,119,35.22,-80.84,250,ft",
              "ORG-2,Well Two,37,119,35.30,-80.80,,",
            ].join("\n")
          : [
              "MonitoringLocationIdentifier,ActivityIdentifier,ActivityStartDate,CharacteristicName,ResultMeasureValue,ResultMeasure/MeasureUnitCode",
              "ORG-1,ACT-1,2020-01-02,Nitrate,<0.5,mg/l",
              "ORG-1,ACT-2,2021-03-04,Arsenic,0,ug/l",
              "ORG-2,ACT-3,2022-05-06,pH,7.1,std units",
            ].join("\n"),
      ),
    };
  };
  try {
    await collectWqp(ctx);
    assert.equal(urls.length, 2);
    const query = new URL(urls[0]!).searchParams;
    assert.equal(query.get("statecode"), "US:37");
    assert.equal(query.get("countycode"), "US:37:119");
    assert.equal(query.get("siteType"), "Well");
    assert.deepEqual(
      [
        ctx.store.count("wells"),
        ctx.store.count("observations"),
        ctx.store.count("documents"),
      ],
      [2, 3, 2],
    );
    assert.ok(
      ctx.store
        .results()
        .every((r) => r.status === "success" && r.unresolved === 0),
    );
    const well = [...ctx.store.entities("wells")].find(
      (w) => w.native_id === "ORG-1",
    )!;
    assert.equal(well.acquisition_method, "download");
    assert.deepEqual(
      [
        (well.total_depth as { value: number }).value,
        (well.total_depth as { unit: string }).unit,
      ],
      [250, "ft"],
    );
    const observations = [...ctx.store.entities("observations")];
    const nitrate = observations.find((o) => o.parameter === "Nitrate")!;
    assert.equal(nitrate.record_id, well.id);
    assert.deepEqual(
      [
        (nitrate.result as { value: unknown }).value,
        (nitrate.result as { limit: number }).limit,
      ],
      [null, 0.5],
    );
    assert.equal(
      (
        observations.find((o) => o.parameter === "Arsenic")!.result as {
          value: number;
        }
      ).value,
      0,
    );
    const [file] = [...ctx.store.entities("documents")];
    assert.match(
      readFileSync(join(ctx.store.dir, String(file!.local_path)), "utf8"),
      /MonitoringLocationIdentifier/,
    );
    await collectWqp(ctx);
    assert.equal(urls.length, 2);
  } finally {
    ctx.store.close();
  }
});
