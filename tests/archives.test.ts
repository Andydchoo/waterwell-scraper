import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/storage/store.js";
import { ConfigSchema, emptyResult } from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import { registry } from "../src/sources/registry.js";
import { HttpClient } from "../src/transports/http.js";
import { Logger } from "../src/core/logger.js";
import {
  enumerateHyland,
  splitDates,
  type ArchiveResponse,
} from "../src/sources/documents.js";
import {
  enumerateLaserfiche,
  laserfichePortal,
  downloadLaserfiche,
  type ArchiveApi,
  type LaserficheEntry,
} from "../src/sources/laserfiche.js";
import type { SourceContext } from "../src/sources/context.js";

// Archives are found by the browser collector at run time; the fixture portal
// below stands in for whichever one a run discovers.
const portal = {
  base: "https://fixture.gov/Archive/",
  repo: "Public",
  dbid: "0",
};
function context(source = "browser-portals"): SourceContext {
  const dir = mkdtempSync(join(tmpdir(), "well-archive-"));
  return {
    config: ConfigSchema.parse({
      state: "NC",
      county: "Mecklenburg",
      attachments: "none",
      batchSize: 2,
    }),
    geo: resolveGeography("NC", "Mecklenburg"),
    source: registry.find((s) => s.id === source)!,
    store: new Store(dir),
    logger: new Logger(dir, "test", 1, true),
    http: new HttpClient({ origins: [], intervalMs: 0 }),
    signal: new AbortController().signal,
    runId: "test",
    records: 0,
  };
}
function entry(id: number, county = "Mecklenburg"): LaserficheEntry {
  return {
    entryId: id,
    name: "Public well report",
    metadata: [
      { name: "County", values: [county] },
      { name: "Original field", values: ["zero", "<0.5"] },
    ],
    type: -2,
    isEdoc: false,
    thumbnailPageCount: 2,
  };
}
function mockApi(scenario: string): ArchiveApi {
  let enumerations = 0;
  return (async (path: string, body: unknown) => {
    const args = body as Record<string, number>;
    if (path.endsWith("GetSearchListingIds")) {
      enumerations++;
      return scenario === "empty"
        ? []
        : scenario === "drift" && enumerations > 1
          ? [1, 2, 3]
          : [1, 2];
    }
    const docs =
      scenario === "empty"
        ? []
        : scenario === "missing"
          ? [entry(1)]
          : scenario === "duplicate"
            ? [entry(1), entry(1)]
            : [
                entry(1, scenario === "county" ? "Wake" : "Mecklenburg"),
                entry(2),
              ];
    return {
      results: docs.slice(args.startIdx, args.endIdx),
      columns: [{ name: "County" }],
      hitCount: scenario === "empty" ? 0 : 2,
      searchUUID: "fixture",
      failed: false,
      errMsg: null,
    };
  }) as ArchiveApi;
}
for (const scenario of [
  "success",
  "empty",
  "missing",
  "duplicate",
  "drift",
  "county",
])
  test(`WebLink archive ${scenario} reconciles IDs and reports coverage`, async () => {
    const ctx = context();
    try {
      await enumerateLaserfiche(
        ctx,
        mockApi(scenario),
        "construction-reports",
        "GW-I",
        portal,
      );
      const r = ctx.store.results()[0]!;
      if (["success", "empty"].includes(scenario))
        assert.equal(r.status, "success");
      else assert.notEqual(r.status, "success");
      if (scenario === "success") {
        assert.equal(ctx.store.count("construction"), 2);
        assert.equal(ctx.store.count("documents"), 2);
        assert.equal(ctx.store.count("relationships"), 2);
        assert.equal(r.unresolved, 0);
        assert.deepEqual(
          [...ctx.store.entities("documents")][0]!.source_fields.metadata,
          entry(1).metadata,
        );
      }
      if (["missing", "duplicate"].includes(scenario))
        assert.equal(ctx.store.count(), 0);
      if (scenario === "county") {
        assert.equal(r.quarantined, 1);
        assert.equal(r.accepted, 1);
      }
    } finally {
      ctx.store.close();
    }
  });
test("WebLink archive budget stop resumes cached page without duplicating records", async () => {
  const ctx = context();
  ctx.config.maxRecords = 1;
  try {
    await enumerateLaserfiche(
      ctx,
      mockApi("success"),
      "construction-reports",
      "GW-I",
      portal,
    );
    assert.equal(ctx.store.results()[0]!.accepted, 1);
    assert.equal(ctx.store.results()[0]!.unresolved, 1);
    ctx.records = 0;
    await enumerateLaserfiche(
      ctx,
      mockApi("success"),
      "construction-reports",
      "GW-I",
      portal,
    );
    assert.equal(ctx.store.results()[0]!.accepted, 2);
    assert.equal(ctx.store.count("documents"), 2);
  } finally {
    ctx.store.close();
  }
});
test("WebLink archive PDF generator polls and validates original report bytes", async () => {
  const ctx = context();
  const paths: string[] = [];
  let polls = 0;
  ctx.http.get = async (url) => {
    paths.push(url);
    return {
      body: Buffer.from(
        url.includes("GeneratePDF")
          ? "12345678-1234-1234-1234-123456789abc\n<span>"
          : "%PDF-1.7 fixture",
      ),
      url,
      headers: {},
    };
  };
  ctx.http.wait = async () => {};
  const api = (async (path: string) =>
    path.includes("GetBasic")
      ? { pageCount: 2, hasImagedPages: true }
      : { success: true, finished: ++polls === 2, errMsg: null }) as ArchiveApi;
  try {
    const d = await downloadLaserfiche(ctx, api, entry(1), {}, portal);
    assert.equal(polls, 2);
    assert.match(paths[1]!, /PDF10\/12345678-1234-1234-1234-123456789abc\/1$/);
    assert.match(
      readFileSync(join(ctx.store.dir, d.local_path), "utf8"),
      /^%PDF/,
    );
  } finally {
    ctx.store.close();
  }
});
test("WebLink archive failed report downloads remain retryable while later records finish", async () => {
  const ctx = context();
  ctx.config.attachments = "all";
  let fail = true;
  ctx.http.get = async (url) => {
    if (url.includes("docid=1") && fail) throw new Error("temporary failure");
    return { body: Buffer.from("%PDF-1.7 fixture"), url, headers: {} };
  };
  const original = mockApi("success");
  const api = (async (path: string, body: unknown) => {
    const value = await original(path, body);
    if (path.endsWith("GetSearchListing"))
      for (const e of (value as { results: LaserficheEntry[] }).results)
        e.isEdoc = true;
    return value;
  }) as ArchiveApi;
  try {
    await enumerateLaserfiche(ctx, api, "construction-reports", "GW-I", portal);
    assert.equal(ctx.store.results()[0]!.accepted, 1);
    assert.equal(ctx.store.results()[0]!.unresolved, 1);
    fail = false;
    ctx.records = 0;
    await enumerateLaserfiche(ctx, api, "construction-reports", "GW-I", portal);
    assert.equal(ctx.store.results()[0]!.status, "success");
    assert.equal(ctx.store.count("documents"), 2);
  } finally {
    ctx.store.close();
  }
});
test("Hyland date splitting is inclusive, disjoint and terminates", () => {
  assert.deepEqual(splitDates({ from: "2024-02-28", to: "2024-03-01" }), [
    { from: "2024-03-01", to: "2024-03-01" },
    { from: "2024-02-28", to: "2024-02-29" },
  ]);
  assert.deepEqual(splitDates({ from: "1753-01-01", to: "1753-01-01" }), []);
});
function report(id: string, type = "Well Permit"): ArchiveResponse {
  return {
    Data: [
      {
        ID: id,
        Name: "Report without file number",
        DisplayColumnValues: [{ Value: type, RawValue: type }],
      },
    ],
    Truncated: false,
    DisplayColumns: [{ Heading: "Document Type", DataType: "text" }],
  };
}
test("Hyland truncated date ranges include blank file numbers and exclude septic records", async () => {
  const ctx = context();
  const key = ctx.source.id + ":dates";
  ctx.store.set(key, [{ from: "2024-01-01", to: "2024-01-02" }]);
  const queries: Record<string, unknown>[] = [];
  ctx.http.postJson = (async (_url: string, body: unknown) => {
    const q = body as Record<string, unknown>;
    queries.push(q);
    if (q.QueryLimit === 1000) return { Data: [], Truncated: true };
    return q.FromDate === "2024-01-02T00:00:00"
      ? report("blank-file-id")
      : report("septic-id", "Septic Permit");
  }) as HttpClient["postJson"];
  try {
    await enumerateHyland(ctx, "https://fixture.gov", 215);
    assert.equal(queries.length, 3);
    assert.equal(ctx.store.count("documents"), 1);
    assert.equal(
      ctx.store
        .taskCounts(ctx.source.id, "reports")
        .reduce((n, r) => n + Number(r.n), 0),
      2,
    );
    assert.deepEqual(ctx.store.get(key), []);
  } finally {
    ctx.store.close();
  }
});
test("Hyland resumes persisted search page rather than changing opaque IDs", async () => {
  const ctx = context();
  ctx.config.maxRecords = 1;
  const key = ctx.source.id + ":dates";
  ctx.store.set(key, [{ from: "2024-01-01", to: "2024-01-01" }]);
  let calls = 0;
  ctx.http.postJson = (async () => {
    calls++;
    const r = report("id-1");
    r.Data.push({ ...r.Data[0]!, ID: "id-2" });
    return r;
  }) as HttpClient["postJson"];
  try {
    await assert.rejects(
      enumerateHyland(ctx, "https://fixture.gov", 215),
      /Record budget/,
    );
    ctx.records = 0;
    await enumerateHyland(ctx, "https://fixture.gov", 215);
    assert.equal(calls, 1);
    assert.equal(ctx.store.count("documents"), 2);
  } finally {
    ctx.store.close();
  }
});
test("Hyland refuses terminal truncation", async () => {
  const ctx = context();
  ctx.store.set(ctx.source.id + ":dates", [
    { from: "2024-01-01", to: "2024-01-01" },
  ]);
  ctx.http.postJson = (async () => ({
    Data: [],
    Truncated: true,
  })) as HttpClient["postJson"];
  try {
    await assert.rejects(
      enumerateHyland(ctx, "https://fixture.gov", 215),
      /remains truncated/,
    );
    assert.equal(ctx.store.count(), 0);
  } finally {
    ctx.store.close();
  }
});
test("Stored errors redact cookie headers and resolved credentials", () => {
  const ctx = context();
  ctx.store.secrets.push("fixture-password");
  try {
    ctx.store.result({
      ...emptyResult(ctx.source.id, "reports"),
      errors: [
        { code: "TEST", message: "Cookie: session=private\nfixture-password" },
      ],
    });
    ctx.store.issue({
      message: "Authorization: Bearer private\nfixture-password",
    });
    const output = JSON.stringify([
      ctx.store.results(),
      [...ctx.store.issues()],
    ]);
    assert.ok(!output.includes("private"));
    assert.ok(!output.includes("fixture-password"));
  } finally {
    ctx.store.close();
  }
});

test("Hyland retries a failed download without blocking later reports", async () => {
  const ctx = context();
  ctx.config.attachments = "all";
  const key = ctx.source.id + ":dates";
  ctx.store.set(key, [{ from: "2024-01-01", to: "2024-01-01" }]);
  let fail = true,
    calls = 0;
  ctx.http.postJson = (async () => {
    calls++;
    const r = report("id-1");
    r.Data.push({ ...r.Data[0]!, ID: "id-2" });
    return r;
  }) as HttpClient["postJson"];
  ctx.http.get = async (url) => {
    if (url.includes("id-1") && fail) throw new Error("temporary failure");
    return { body: Buffer.from("%PDF-1.7 fixture"), url, headers: {} };
  };
  try {
    await assert.rejects(
      enumerateHyland(ctx, "https://fixture.gov", 215),
      /failed to download/,
    );
    assert.equal(ctx.store.count("documents"), 2);
    assert.equal(
      [...ctx.store.entities("documents")].filter(
        (d) => d.download_status === "downloaded",
      ).length,
      1,
    );
    fail = false;
    ctx.records = 0;
    await enumerateHyland(ctx, "https://fixture.gov", 215);
    assert.equal(calls, 1);
    assert.equal(ctx.store.count("documents"), 2);
    assert.equal(
      [...ctx.store.entities("documents")].filter(
        (d) => d.download_status === "downloaded",
      ).length,
      2,
    );
  } finally {
    ctx.store.close();
  }
});

test("WebLink archive initializes with a small search and reconciles multiple large pages", async () => {
  const ctx = context();
  ctx.config.batchSize = 500;
  const ids = Array.from({ length: 237 }, (_, i) => String(i + 1));
  const sizes: number[] = [];
  const api = (async (path: string, body: unknown) => {
    if (path.endsWith("GetSearchListingIds")) return ids;
    const q = body as { startIdx: number; endIdx: number };
    sizes.push(q.endIdx - q.startIdx);
    return {
      results: ids.slice(q.startIdx, q.endIdx).map((id) => entry(Number(id))),
      columns: [],
      hitCount: ids.length,
      searchUUID: "fixture",
      failed: false,
      errMsg: null,
    };
  }) as ArchiveApi;
  try {
    await enumerateLaserfiche(ctx, api, "construction-reports", "GW-I", portal);
    assert.deepEqual(sizes, [20, 100, 100, 100]);
    assert.equal(ctx.store.results()[0]!.accepted, 237);
    assert.equal(ctx.store.results()[0]!.unresolved, 0);
    assert.equal(ctx.store.count("documents"), 237);
  } finally {
    ctx.store.close();
  }
});

test("Hyland isolates broken source revisions without calling them empty results", async () => {
  const ctx = context(),
    key = ctx.source.id + ":dates";
  ctx.store.set(key, [{ from: "2024-01-01", to: "2024-01-02" }]);
  let repaired = false;
  ctx.http.postJson = (async (_url: string, body: unknown) => {
    const q = body as { FromDate: string; ToDate: string };
    if (!repaired && q.FromDate.startsWith("2024-01-01"))
      return {
        Message:
          "The revision id 0 was not found for document id 42.\r\nParameter name: id",
      };
    return report(q.FromDate);
  }) as HttpClient["postJson"];
  try {
    await assert.rejects(
      enumerateHyland(ctx, "https://fixture.gov", 215),
      /broken source document revisions/,
    );
    assert.equal(ctx.store.count("documents"), 1);
    assert.deepEqual(ctx.store.get(key + ":unavailable"), [
      { from: "2024-01-01", to: "2024-01-01" },
    ]);
    repaired = true;
    ctx.records = 0;
    await enumerateHyland(ctx, "https://fixture.gov", 215);
    assert.equal(ctx.store.count("documents"), 2);
    assert.deepEqual(ctx.store.get(key + ":unavailable"), []);
  } finally {
    ctx.store.close();
  }
});

test("WebLink archive is recognised from its address, and a search across all templates keeps only well reports", async () => {
  assert.deepEqual(
    laserfichePortal(
      "https://records.example.gov/Docs/Welcome.aspx?dbid=3&repo=Water",
    ),
    { base: "https://records.example.gov/Docs/", repo: "Water", dbid: "3" },
  );
  assert.equal(
    laserfichePortal("https://records.example.gov/about.html"),
    null,
  );
  const ctx = context();
  let syntax = "";
  const api = (async (path: string, body: unknown) => {
    const args = body as {
      searchSyn: string;
      startIdx: number;
      endIdx: number;
    };
    syntax = args.searchSyn;
    if (path.endsWith("GetSearchListingIds")) return [1, 2];
    const docs = [
      entry(1),
      {
        ...entry(2),
        name: "Septic system permit",
        metadata: [{ name: "County", values: ["Mecklenburg"] }],
      },
    ];
    return {
      results: docs.slice(args.startIdx, args.endIdx),
      columns: [],
      hitCount: 2,
      searchUUID: "fixture",
      failed: false,
      errMsg: null,
    };
  }) as ArchiveApi;
  try {
    await enumerateLaserfiche(ctx, api, "reports:fixture", "", portal);
    assert.equal(syntax, '({[]:[County]="Mecklenburg"})');
    const r = ctx.store.results()[0]!;
    assert.equal(r.accepted, 1);
    assert.equal(r.excluded, 1);
    assert.equal(r.status, "success");
    const [doc] = [...ctx.store.entities("documents")];
    assert.equal(doc!.acquisition_method, "browser");
    assert.match(
      String(doc!.source_url),
      /^https:\/\/fixture\.gov\/Archive\/DocView\.aspx\?id=1&dbid=0&repo=Public$/,
    );
  } finally {
    ctx.store.close();
  }
});
