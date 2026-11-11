import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { Store } from "../src/storage/store.js";
import { ConfigSchema, ScrapeError } from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import { registry } from "../src/sources/registry.js";
import { HttpClient } from "../src/transports/http.js";
import { Logger } from "../src/core/logger.js";
import {
  GOV_REGISTRY,
  WIKIDATA,
  agencyRelevance,
  fetchRobots,
  linkValue,
  officialSites,
  parseRobots,
  registrySites,
  resolveHome,
  siteOf,
  sitemapPages,
  wikidataSites,
} from "../src/sources/official.js";
import type { Fetcher, SourceContext } from "../src/sources/context.js";

function context(state = "NC", county = "Mecklenburg"): SourceContext {
  const dir = mkdtempSync(join(tmpdir(), "well-official-"));
  return {
    config: ConfigSchema.parse({ state, county }),
    geo: resolveGeography(state, county),
    source: registry.find((s) => s.id === "browser-portals")!,
    store: new Store(dir),
    logger: new Logger(dir, "test", 1, true),
    http: new HttpClient({ origins: ["*"], intervalMs: 0 }),
    signal: new AbortController().signal,
    runId: "test",
    records: 0,
  };
}
const page = (body: string, url = "https://x.example/") => ({
  body: Buffer.from(body),
  url,
  headers: {},
});
const REGISTRY = [
  "Domain name,Domain type,Organization name,Suborganization name,City,State,Security contact email",
  "mecknc.gov,County,Mecklenburg County,,Charlotte,NC,security@county.example",
  "meckvotes.gov,County,Mecklenburg County Board of Elections,,Charlotte,NC,(blank)",
  "mecklenburgva.gov,County,Mecklenburg County,,Boydton,VA,(blank)",
  "newmecklenburgnc.gov,County,New Mecklenburg County,,Somewhere,NC,(blank)",
  "charlottenc.gov,City,City of Charlotte,,Charlotte,NC,(blank)",
  "ncwater.gov,State or territory,NC Department of Environmental Quality,Division of Water Resources,Raleigh,NC,(blank)",
  "ncmedicaid.gov,State or territory,NC Medicaid,,Raleigh,NC,(blank)",
  "alexandriava.gov,City,City of Alexandria,,Alexandria,VA,(blank)",
].join("\n");

test("the .gov registry yields the county's own sites and the state's water agencies, for that state only", () => {
  const ctx = context();
  try {
    assert.deepEqual(
      registrySites(REGISTRY, ctx).map((s) => [s.url, s.level]),
      [
        ["https://mecknc.gov/", "county"],
        ["https://ncwater.gov/", "state"],
      ],
    );
  } finally {
    ctx.store.close();
  }
  // Independent cities are county-equivalents governed by a city.
  const city = context("VA", "Alexandria city");
  try {
    assert.deepEqual(
      registrySites(REGISTRY, city).map((s) => s.url),
      ["https://alexandriava.gov/"],
    );
  } finally {
    city.store.close();
  }
  // A county whose only listed site is a specialised one still gets it.
  const only = context();
  try {
    assert.deepEqual(
      registrySites(
        REGISTRY.split("\n")
          .filter((line) => !line.startsWith("mecknc.gov"))
          .join("\n"),
        only,
      ).map((s) => s.url)[0],
      "https://meckvotes.gov/",
    );
  } finally {
    only.store.close();
  }
});

test("state bodies are ranked by how likely they are to hold well records", () => {
  for (const name of [
    "Division of Water Resources",
    "Department of Natural Resources",
    "Pollution Control Agency",
    "Department of Health",
    "Geological Survey",
  ])
    assert.ok(agencyRelevance(name) > 0, name);
  for (const name of [
    "Board of Geologists",
    "Division of Health Benefits (Medicaid)",
    "State Water Infrastructure Authority",
    "Department of Transportation",
    "Occupational Safety and Health Review Commission",
  ])
    assert.equal(agencyRelevance(name), 0, name);
  assert.ok(
    agencyRelevance("Division of Water Resources") >
      agencyRelevance("Department of Health"),
  );
});

test("Wikidata is asked by FIPS code and both directories are combined without duplicates", async () => {
  const ctx = context();
  const queries: string[] = [];
  const fetcher = {
    get: async (url: string) => {
      assert.equal(url, GOV_REGISTRY);
      return page(REGISTRY, url);
    },
    json: async (url: string) => {
      const u = new URL(url);
      assert.equal(u.origin + u.pathname, WIKIDATA);
      const q = u.searchParams.get("query")!;
      queries.push(q);
      return {
        results: {
          bindings: q.includes("P882")
            ? [
                { site: { value: "http://www.mecknc.gov" } },
                { site: { value: "http://old.county.example/" } },
              ]
            : [
                {
                  name: { value: "State Division of Water Resources" },
                  site: { value: "https://water.state.example/division" },
                },
                {
                  name: { value: "State Board of Cosmetology" },
                  site: { value: "https://hair.state.example/" },
                },
                {
                  name: { value: "Department of Health" },
                  site: { value: "http://health.state.example/" },
                },
              ],
        },
      };
    },
  } as unknown as Fetcher;
  try {
    assert.equal((await wikidataSites(ctx, fetcher)).length, 4);
    assert.match(queries[0]!, /P882 "37119"/);
    assert.match(queries[1]!, /P5087 "37"/);
    const { sites, notes } = await officialSites(ctx, fetcher);
    assert.deepEqual(
      sites.map((s) => [s.url, s.level, s.listedBy]),
      [
        // The registry entry wins over the same site listed again by Wikidata (http, www).
        ["https://mecknc.gov/", "county", "gov-registry"],
        ["https://old.county.example/", "county", "wikidata"],
        ["https://ncwater.gov/", "state", "gov-registry"],
        ["https://water.state.example/division", "state", "wikidata"],
        ["https://health.state.example/", "state", "wikidata"],
      ],
    );
    assert.equal(notes.length, 2);
    // Stored evidence keeps the matched sites, not the registry's contact column.
    const raw = join(ctx.store.dir, "raw", "browser-portals");
    const saved = readdirSync(raw)
      .map((name) => readFileSync(join(raw, name), "utf8"))
      .join("\n");
    assert.match(saved, /mecknc\.gov/);
    assert.doesNotMatch(saved, /security@county\.example/);
    // One directory failing leaves the other's answer and a note.
    const partial = await officialSites(ctx, {
      ...fetcher,
      get: async () => {
        throw new ScrapeError("NOT_FOUND", "Public resource was not found.");
      },
    } as unknown as Fetcher);
    assert.ok(partial.sites.every((s) => s.listedBy === "wikidata"));
    assert.match(partial.notes[0]!, /registry could not be read/);
  } finally {
    ctx.store.close();
  }
});

test("robots.txt is obeyed: own group first, most specific rule, wildcards, delay and sitemaps", () => {
  const rules = parseRobots(
    [
      "# comment",
      "User-agent: *",
      "Disallow: /private/",
      "Allow: /private/wells/",
      "Disallow: /*.pdf$",
      "Disallow: /search?",
      "Crawl-delay: 90",
      "",
      "User-agent: SomeOtherBot",
      "User-agent: AnotherBot",
      "Disallow: /",
      "",
      "Sitemap: https://county.example/sitemap.xml",
      "Sitemap: not a url",
    ].join("\n"),
  );
  assert.equal(rules.allowed("https://county.example/water/wells"), true);
  assert.equal(rules.allowed("https://county.example/private/budget"), false);
  assert.equal(
    rules.allowed("https://county.example/private/wells/logs"),
    true,
  );
  assert.equal(rules.allowed("https://county.example/files/report.pdf"), false);
  assert.equal(
    rules.allowed("https://county.example/files/report.pdf.html"),
    true,
  );
  assert.equal(rules.allowed("https://county.example/search?q=wells"), false);
  assert.deepEqual(rules.sitemaps, ["https://county.example/sitemap.xml"]);
  // A requested wait is honoured, up to twenty seconds.
  assert.equal(rules.delayMs, 20000);
  // Rules written for this application by name replace the general ones.
  const named = parseRobots(
    "User-agent: *\nAllow: /\n\nUser-agent: waterwellscraper\nDisallow: /",
  );
  assert.equal(named.allowed("https://county.example/"), false);
  assert.equal(
    parseRobots("User-agent: *\nDisallow:").allowed("https://a.example/x"),
    true,
  );
  // A web page served in place of robots.txt carries no rules.
  assert.equal(
    parseRobots("<!doctype html><html>").allowed("https://a.example/x"),
    true,
  );
});

test("a missing robots.txt allows reading; an unreachable site is left alone and reported as such", async () => {
  const ctx = context();
  const failing = (code: string, error: Error = new ScrapeError(code, code)) =>
    ({
      get: async () => {
        throw error;
      },
    }) as unknown as Fetcher;
  try {
    const missing = await fetchRobots(
      ctx,
      failing("NOT_FOUND"),
      "https://a.example",
    );
    assert.equal(missing.allowed("https://a.example/wells"), true);
    const down = await fetchRobots(
      ctx,
      failing("", new Error("getaddrinfo ENOTFOUND")),
      "https://dead.example",
    );
    assert.equal(down.allowed("https://dead.example/"), false);
    assert.equal(down.unreachable, true);
    await assert.rejects(
      fetchRobots(ctx, failing("BUDGET_DURATION"), "https://a.example"),
      /BUDGET_DURATION/,
    );
    // A listed address is followed to where the site lives now.
    assert.deepEqual(
      await resolveHome(
        ctx,
        {
          get: async () => page("<html>", "https://www.county.example/"),
        } as unknown as Fetcher,
        "https://county.example/",
      ),
      { url: "https://www.county.example/", reachable: true },
    );
    assert.equal(
      (
        await resolveHome(
          ctx,
          failing("", new Error("ENOTFOUND")),
          "https://dead.example/",
        )
      ).reachable,
      false,
    );
    // A site that refuses a plain request may still serve the browser.
    assert.equal(
      (await resolveHome(ctx, failing("BLOCKED"), "https://strict.example/"))
        .reachable,
      true,
    );
  } finally {
    ctx.store.close();
  }
});

test("a site's own sitemap is used to find its pages and files about wells", async () => {
  const ctx = context();
  const requested: string[] = [];
  const urlset = (locs: string[]) =>
    `<?xml version="1.0"?><urlset>${locs.map((l) => `<url><loc>${l}</loc></url>`).join("")}</urlset>`;
  const fetcher = {
    get: async (url: string) => {
      requested.push(url);
      if (url.endsWith("/sitemap.xml"))
        return page(
          `<sitemapindex><sitemap><loc>https://www.county.example/pages.xml.gz</loc></sitemap><sitemap><loc>https://www.county.example/image-sitemap.xml</loc></sitemap><sitemap><loc>https://elsewhere.example/other.xml</loc></sitemap></sitemapindex>`,
          // The bare domain answers from its www host.
          "https://www.county.example/sitemap.xml",
        );
      return {
        ...page("", url),
        body: gzipSync(
          urlset([
            "https://www.county.example/health/environmental/private-wells",
            "https://www.county.example/health/environmental/well-permit-records?year=2020&amp;type=new",
            "https://www.county.example/news/2024/05/well-testing-week",
            "https://www.county.example/wellness/classes",
            "https://www.county.example/hidden/well-logs",
            "https://www.county.example/files/well-construction-data.csv",
            "https://www.county.example/images/wells.png",
            "https://other.example/wells",
            "https://www.county.example/parks",
          ]),
        ),
      };
    },
  } as unknown as Fetcher;
  try {
    const found = await sitemapPages(
      ctx,
      fetcher,
      "https://county.example/",
      parseRobots("User-agent: *\nDisallow: /hidden/"),
    );
    assert.deepEqual(requested, [
      "https://county.example/sitemap.xml",
      "https://www.county.example/pages.xml.gz",
    ]);
    assert.deepEqual(
      found.pages.map((p) => p.url),
      [
        // Pages that sound like records come first.
        "https://www.county.example/health/environmental/well-permit-records?year=2020&type=new",
        "https://www.county.example/health/environmental/private-wells",
      ],
    );
    assert.equal(found.pages[1]!.title, "private wells");
    assert.deepEqual(
      found.files.map((f) => f.url),
      ["https://www.county.example/files/well-construction-data.csv"],
    );
    // A sitemap named in robots.txt is used instead of the default address.
    requested.length = 0;
    await sitemapPages(
      ctx,
      {
        get: async (url: string) => (
          requested.push(url),
          page(urlset([]), url)
        ),
      } as unknown as Fetcher,
      "https://county.example/",
      parseRobots("Sitemap: https://county.example/maps/site.xml"),
    );
    assert.deepEqual(requested, ["https://county.example/maps/site.xml"]);
  } finally {
    ctx.store.close();
  }
});

test("links are valued by where they lead and sites keep to their own domain", () => {
  assert.equal(linkValue("Private Wells", "/health/wells"), 3);
  assert.equal(
    linkValue("Read more", "/services/groundwater-and-wastewater"),
    3,
  );
  assert.equal(linkValue("Environmental Health", "/eh"), 2);
  assert.equal(linkValue("Permits", "/permits"), 2);
  // A page is judged by its own name, not by the section it sits in.
  assert.equal(linkValue("Recycling", "/services/environment/recycling"), 0);
  assert.equal(
    linkValue("Read more", "/services/environment/land-water-resources"),
    2,
  );
  assert.equal(linkValue("Departments", "/departments"), 1);
  assert.equal(linkValue("A-Z Index", "/az"), 1);
  assert.equal(linkValue("Parks and Recreation", "/parks"), 0);
  assert.equal(linkValue("Wellness programs", "/hr/wellness"), 0);
  assert.equal(siteOf("https://eh.county.example/water"), "county.example");
  assert.equal(siteOf("https://www.health.state.mn.us/wells"), "state.mn.us");
  assert.equal(siteOf("https://www.co.hennepin.mn.us/"), "co.hennepin.mn.us");
});
