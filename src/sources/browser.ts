import type { BrowserContext, Page } from "playwright";
import { readFileSync } from "node:fs";
import { resolveCredentials } from "../credentials/index.js";
import { interactiveLogin } from "../credentials/interactive.js";
import { portalManifest } from "./registry.js";
import { emptyResult, errorInfo } from "../core/types.js";
import { hash } from "../core/util.js";
import { mapFields, wellRelevance } from "../data/normalize.js";
import { browserFetcher, openBrowser } from "../transports/browser.js";
import { collectArcgis } from "./arcgis.js";
import { discoveryResult } from "./api.js";
import {
  countyShortName,
  isBudget,
  type Fetcher,
  type SourceContext,
} from "./context.js";
import { arcgisRestUrl, expandService, type LayerTarget } from "./discovery.js";
import { collectHylandPortal, isHylandPortal } from "./documents.js";
import { collectFileTarget, type FileTarget } from "./downloads.js";
import {
  collectLaserfichePortal,
  laserfichePortal,
  type LaserfichePortal,
} from "./laserfiche.js";
import { ingestTable } from "./tabular.js";
import {
  fetchRobots,
  linkValue,
  officialSites,
  resolveHome,
  siteOf,
  sitemapPages,
  type OfficialSite,
  type Robots,
} from "./official.js";

// Browser approach. Chromium starts from a public catalog's search page, the
// official county and state sites that public directories list for the place,
// and any pages supplied for the run. It opens what those lead to and records
// what the pages load or link: map services, tables, data files and public
// document archives. No page address for any county is built in.
const SEARCH_PAGE = "https://www.arcgis.com/home/search.html";
const ITEM_PAGE = "https://www.arcgis.com/home/item.html";
const MAP_VIEWER = "https://www.arcgis.com/apps/mapviewer/index.html";
const APP_TYPES =
  /Web Mapping Application|Dashboard|Web Experience|StoryMap|Hub Site|Site Application|Hub Page|Application|Instant App/i;
const DATA_LINK = /\.(csv|xlsx?|zip|geojson|kml|kmz|pdf)(\?|#|$)/i;
const RECORDS =
  /\bwells?\b|record|permit|\blogs?\b|\bdata\b|index|search|database|inventory|construction|viewer/i;
const WELL_FIELDS = [
  "source_well_id",
  "total_depth",
  "casing_depth",
  "permit_number",
  "driller",
  "yield",
  "static_water_level",
  "well_use",
  "well_type",
  "well_status",
  "completed_on",
];
interface Candidate {
  url: string;
  title: string;
  depth: number;
  why: string;
  // Pages of an official site (or reached from one) are crawled under robots.txt.
  official?: boolean;
  level?: "county" | "state";
  priority?: number;
  // The official site this page was reached from.
  root?: string;
}
interface Portal {
  type: "hyland" | "laserfiche";
  url: string;
  base: string;
  laserfiche?: LaserfichePortal;
}
interface BrowseState {
  done: boolean;
  pages: { url: string; title: string; note: string }[];
  services: Record<
    string,
    { title: string; itemId: string | null; relevance: number }
  >;
  portals: Portal[];
  files: FileTarget[];
  tables: number;
  notes: string[];
  sites?: OfficialSite[];
}
interface CatalogHit {
  id: string;
  title: string;
  type: string;
  url?: string | null;
  snippet?: string | null;
  tags?: string[];
  access?: string;
}
const settle = async (page: Page) => {
  await page
    .waitForLoadState("networkidle", { timeout: 12000 })
    .catch(() => {});
  // Single-page applications go quiet briefly before they start loading data.
  await page.waitForTimeout(2500).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
};
const pageKey = (url: string) =>
  url
    .split("#")[0]!
    .replace(/^https:\/\/www\./, "https://")
    .replace(/\/$/, "");

async function browse(
  ctx: SourceContext,
  context: BrowserContext,
  state: BrowseState,
) {
  const county = countyShortName(ctx.geo);
  const mentionsCounty = (text: string) =>
    new RegExp(
      `\\b${county.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    ).test(text);
  const queue: Candidate[] = ctx.config.seedUrls.map((url) => ({
    url,
    title: "",
    depth: 0,
    why: "supplied for this run",
  }));
  const visited = new Set<string>();
  const budget = ctx.config.maxTargets;
  // Every map-service address any page requests is noted, with the page that asked.
  let current = "";
  let currentRelevance = 0;
  const note = (
    raw: string,
    title = current,
    itemId: string | null = null,
    boost = 0,
  ) => {
    const url = arcgisRestUrl(raw);
    if (!url) return;
    const root = url.replace(/\/\d+$/, "");
    const relevance =
      Math.max(
        wellRelevance(title, decodeURIComponent(new URL(url).pathname)),
        itemId ? 1 : 0,
        currentRelevance ? 1 : 0,
      ) + boost;
    const known = state.services[root];
    if (!known || relevance > known.relevance)
      state.services[root] = {
        title: title || known?.title || root,
        // A later anonymous request must not forget which catalog item listed the service.
        itemId: itemId ?? known?.itemId ?? null,
        relevance,
      };
  };
  context.on("request", (request) => note(request.url()));

  // Step 1: public catalog search pages. Each page is opened like a visitor
  // would, and the result list the page itself loads is read as it renders.
  const terms = [
    `${county} wells`,
    `${county} groundwater`,
    `${ctx.geo.state_name} groundwater wells`,
  ];
  const searches = [
    ...terms.map((term) => ({
      label: `ArcGIS Online search "${term}"`,
      url: `${SEARCH_PAGE}?restrict=false&sortField=relevance&sortOrder=desc&searchTerm=${encodeURIComponent(term)}#content`,
      listing: /\/sharing\/rest\/search\?/,
    })),
  ];
  const queuedItems = new Set<string>();
  // Pages supplied for the run and items naming the county stay ahead of statewide results.
  let local = queue.length;
  for (const search of searches) {
    ctx.http.check();
    const page = await context.newPage();
    const hits: CatalogHit[] = [];
    const reads: Promise<void>[] = [];
    page.on("response", (response) => {
      if (!search.listing.test(response.url())) return;
      reads.push(
        response
          .json()
          .then(
            (body: {
              results?: CatalogHit[];
              features?: { id: string; properties?: Omit<CatalogHit, "id"> }[];
            }) => {
              if (Array.isArray(body?.results)) hits.push(...body.results);
              if (Array.isArray(body?.features))
                for (const f of body.features)
                  if (f?.properties?.title)
                    hits.push({ ...f.properties, id: f.id });
            },
          )
          .catch(() => {}),
      );
    });
    try {
      // Background maps the search page itself draws are not about the county.
      current = "";
      currentRelevance = 0;
      const first = page
        .waitForResponse((r) => search.listing.test(r.url()), {
          timeout: 30000,
        })
        .catch(() => null);
      await page.goto(search.url, { waitUntil: "domcontentloaded" });
      // The result list is requested a moment after the page loads.
      await first;
      await settle(page);
      await Promise.allSettled(reads);
      let queued = 0;
      for (const hit of hits) {
        if (!/^[a-f0-9]{32}/.test(hit.id ?? "") || queuedItems.has(hit.id))
          continue;
        if (hit.access && hit.access !== "public") continue;
        const text = [
          hit.title,
          hit.snippet ?? "",
          (hit.tags ?? []).join(" "),
        ].join(" ");
        if (!wellRelevance(hit.title, hit.snippet)) continue;
        if (!wellRelevance(hit.title) && !mentionsCounty(text)) continue;
        queuedItems.add(hit.id);
        const id = hit.id.slice(0, 32);
        if (
          /Feature Service|Map Service|Feature Layer/i.test(hit.type) &&
          hit.url
        )
          // Items that name the county are read before statewide ones.
          note(hit.url, hit.title, id, mentionsCounty(text) ? 3 : 0);
        const url =
          APP_TYPES.test(hit.type) && hit.url?.startsWith("https://")
            ? hit.url
            : /^Web Map$/i.test(hit.type)
              ? `${MAP_VIEWER}?webmap=${id}`
              : `${ITEM_PAGE}?id=${id}`;
        const entry = {
          url,
          title: hit.title,
          depth: 0,
          why: `${search.label} (${hit.type})`,
        };
        if (mentionsCounty(text)) queue.splice(local++, 0, entry);
        else queue.push(entry);
        queued++;
      }
      state.pages.push({
        url: page.url(),
        title: await page.title().catch(() => ""),
        note: `${search.label}: ${hits.length} listed item(s), ${queued} new about wells`,
      });
      state.notes.push(
        `${search.label}: ${hits.length} listed, ${queued} new about wells`,
      );
    } catch (e) {
      const err = errorInfo(e);
      if (isBudget(err.code)) throw e;
      state.notes.push(`${search.label} could not be read: ${err.message}`);
    } finally {
      await page.close().catch(() => {});
    }
  }

  // Step 1b: official sites. Public directories say which websites belong to
  // the county government and to the state's water agencies; each site's
  // robots.txt and sitemap then say which of its pages may be read and which
  // are about wells. No search engine is involved.
  const officialQueues: Record<"county" | "state", Candidate[]> = {
    county: [],
    state: [],
  };
  const enqueueOfficial = (candidate: Candidate) => {
    const list = officialQueues[candidate.level ?? "state"];
    // Most promising first; equal ranks keep the order they were found in.
    const at = list.findIndex(
      (q) => (q.priority ?? 0) < (candidate.priority ?? 0),
    );
    if (at < 0) list.push(candidate);
    else list.splice(at, 0, candidate);
  };
  const robots = new Map<string, Robots>();
  const robotsFor = async (url: string) => {
    const origin = new URL(url).origin;
    let rules = robots.get(origin);
    if (!rules) {
      rules = await fetchRobots(ctx, ctx.http, origin);
      robots.set(origin, rules);
    }
    return rules;
  };
  // Listed addresses can be long dead, so these lookups give up quickly.
  const patience = {
    timeout: ctx.http.opts.requestTimeoutMs,
    attempts: ctx.http.opts.maxAttempts,
  };
  ctx.http.opts.requestTimeoutMs = 15000;
  ctx.http.opts.maxAttempts = 2;
  try {
    const official = await officialSites(ctx, ctx.http);
    state.notes.push(...official.notes);
    state.sites = official.sites;
    const homes = new Set<string>();
    for (const site of official.sites) {
      ctx.http.check();
      const listedHost = new URL(site.url).hostname;
      try {
        const home = await resolveHome(ctx, ctx.http, site.url);
        if (!home.reachable) {
          state.notes.push(
            `${listedHost} is listed for the ${site.level} but did not respond; not opened`,
          );
          continue;
        }
        // Two listed addresses often lead to the same site.
        if (homes.has(pageKey(home.url))) continue;
        homes.add(pageKey(home.url));
        const host = new URL(home.url).hostname;
        const rules = await robotsFor(home.url);
        if (!rules.allowed(home.url)) {
          state.notes.push(
            rules.unreachable
              ? `${host} did not answer a request for its robots.txt; not opened`
              : `${host} asks automated visitors to stay out (robots.txt); not opened`,
          );
          continue;
        }
        enqueueOfficial({
          url: home.url,
          title: site.name,
          depth: 0,
          why: `official ${site.level} site listed by ${site.listedBy === "wikidata" ? "Wikidata" : "the .gov registry"}`,
          official: true,
          level: site.level,
          root: host,
          priority: 3,
        });
        const listed = await sitemapPages(ctx, ctx.http, home.url, rules, 6);
        for (const listedPage of listed.pages)
          enqueueOfficial({
            url: listedPage.url,
            title: listedPage.title,
            depth: 1,
            why: `listed in the site map of ${host}`,
            official: true,
            level: site.level,
            root: host,
            priority: 4,
          });
        for (const file of listed.files)
          if (!state.files.some((f) => f.url === file.url))
            state.files.push({
              id: hash(file.url).slice(0, 16),
              title: file.title,
              url: file.url,
              origin: "page-link",
              named: site.level === "county",
            });
        if (listed.pages.length || listed.files.length)
          state.notes.push(
            `${host}: site map lists ${listed.pages.length} page(s) and ${listed.files.length} file(s) about wells`,
          );
      } catch (e) {
        const err = errorInfo(e);
        if (isBudget(err.code)) throw e;
        state.notes.push(`${listedHost} could not be read: ${err.message}`);
      }
    }
  } finally {
    // The client is shared with the collectors that run after this one.
    ctx.http.opts.requestTimeoutMs = patience.timeout;
    ctx.http.opts.maxAttempts = patience.attempts;
  }

  // Step 2: open each page, note what it loads and links, and follow relevant
  // links. Catalog pages, county-site pages and state-site pages take turns so
  // none of them crowds out the others.
  let opens = 0;
  let turn = 0;
  const lastVisit = new Map<string, number>();
  const siteVisits = new Map<string, number>();
  const lines = [queue, officialQueues.county, officialQueues.state];
  const waiting = () => lines.reduce((n, line) => n + line.length, 0);
  while (waiting() && opens < budget) {
    let line = lines[turn++ % lines.length]!;
    while (!line.length) line = lines[turn++ % lines.length]!;
    // Within the county or state line, the site opened least so far goes next,
    // so one large site cannot use up the visits of the others.
    let pick = 0;
    if (line !== queue)
      for (let i = 1; i < line.length; i++)
        if (
          (siteVisits.get(line[i]!.root ?? "") ?? 0) <
          (siteVisits.get(line[pick]!.root ?? "") ?? 0)
        )
          pick = i;
    const candidate = line.splice(pick, 1)[0]!;
    const address = candidate.url.split("#")[0]!;
    if (visited.has(pageKey(address)) || !address.startsWith("https://"))
      continue;
    visited.add(pageKey(address));
    ctx.http.check();
    if (candidate.official || candidate.depth > 0) {
      // Pages reached by crawling are opened only where the site's robots.txt allows.
      const rules = await robotsFor(address);
      if (!rules.allowed(address)) {
        state.pages.push({
          url: address,
          title: candidate.title,
          note: candidate.why + "; not opened (robots.txt)",
        });
        continue;
      }
      const origin = new URL(address).origin;
      const wait = (lastVisit.get(origin) ?? 0) + rules.delayMs - Date.now();
      if (wait > 0) await ctx.http.wait(wait);
      lastVisit.set(origin, Date.now());
    }
    opens++;
    if (candidate.root)
      siteVisits.set(candidate.root, (siteVisits.get(candidate.root) ?? 0) + 1);
    const page = await context.newPage();
    try {
      current = candidate.title;
      // Pages supplied for the run, and official sites, are trusted to be about the place.
      currentRelevance =
        wellRelevance(candidate.title) ||
        (candidate.why === "supplied for this run" || candidate.official
          ? 1
          : 0);
      const response = await page.goto(candidate.url, {
        waitUntil: "domcontentloaded",
        timeout: 45000,
      });
      await settle(page);
      // A redirect may land on a page that was already read under another address.
      if (pageKey(page.url()) !== pageKey(address)) {
        if (visited.has(pageKey(page.url()))) continue;
        visited.add(pageKey(page.url()));
      }
      const title = (await page.title().catch(() => "")) || candidate.title;
      current = candidate.title || title;
      currentRelevance = Math.max(currentRelevance, wellRelevance(title));
      const body = await page
        .locator("body")
        .innerText({ timeout: 5000 })
        .catch(() => "");
      const status = response?.status() ?? 0;
      let remark = candidate.why;
      if (
        status === 401 ||
        status === 403 ||
        /captcha|verify (that )?you('| a)re (a )?human|access denied|unusual traffic/i.test(
          title + " " + body.slice(0, 600),
        )
      ) {
        // Sites that refuse automated visits are reported and left alone.
        state.pages.push({
          url: page.url(),
          title,
          note: remark + "; site refused automated access",
        });
        continue;
      }
      if (await page.locator("input[type=password]").count())
        remark += "; page asks for a login";
      const html = await page.content();
      ctx.store.raw(ctx.source.id, Buffer.from(html), "html");
      for (const match of html.matchAll(
        /https:\/\/[^"'\s<>\\]+\/rest\/services\/[^"'\s<>\\?]+?(?:FeatureServer|MapServer)(?:\/\d+)?/gi,
      ))
        note(match[0], title);
      // Public document archives are recognised by what the page is, not by its address.
      if (await isHylandPortal(page)) {
        const base = page.url().split(/[?#]/)[0]!.replace(/\/$/, "");
        if (!state.portals.some((p) => p.base === base))
          state.portals.push({ type: "hyland", url: page.url(), base });
        remark += "; public document archive (OnBase)";
      }
      const weblink = laserfichePortal(page.url());
      if (
        weblink &&
        !state.portals.some((p) => p.base === weblink.base + weblink.repo)
      ) {
        state.portals.push({
          type: "laserfiche",
          url: page.url(),
          base: weblink.base + weblink.repo,
          laserfiche: weblink,
        });
        remark += "; public document archive (WebLink)";
      }
      // Tables rendered on the page.
      const tables = await page
        .locator("table")
        .evaluateAll((nodes) =>
          nodes.slice(0, 20).map((t) => ({
            caption: (t as HTMLTableElement).caption?.innerText ?? "",
            rows: [...t.querySelectorAll("tr")]
              .slice(0, 5001)
              .map((tr) =>
                [...tr.querySelectorAll("th,td")].map((c) =>
                  (c as HTMLElement).innerText.trim(),
                ),
              ),
          })),
        )
        .catch(() => []);
      tables.forEach((table, index) => {
        const [header, ...rows] = table.rows.filter((r) => r.length);
        if (!header || header.length < 3 || !rows.length) return;
        const mapped = mapFields(header.map((name) => ({ name })));
        const wellFields = WELL_FIELDS.filter((f) => mapped[f]).length;
        if (
          wellFields < 2 &&
          !(wellFields && wellRelevance(table.caption, title))
        )
          return;
        const raw = ctx.store.raw(ctx.source.id, { url: page.url(), table });
        const counts = ingestTable(ctx, {
          dataset: `table:${new URL(page.url()).hostname}:${hash(page.url() + index).slice(0, 10)}`,
          title: table.caption || title,
          url: page.url(),
          header,
          rows: rows.map((r) => ({
            values: Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])),
          })),
          raw,
          scope: mentionsCounty(title + " " + body.slice(0, 4000))
            ? "source"
            : "rows",
          scopeMethod: "page_names_county",
        });
        const result = emptyResult(
          ctx.source.id,
          `table:${new URL(page.url()).hostname}:${hash(page.url() + index).slice(0, 10)}`,
        );
        ctx.store.result({
          ...result,
          status: "success",
          expected: counts.rows,
          fetched: counts.rows,
          accepted: counts.accepted,
          excluded: counts.excluded,
          unresolved: 0,
          caveats: [`Table on ${page.url()} (${table.caption || title}).`],
        });
        state.tables++;
      });
      // Links: data files to download, and relevant pages to open next.
      const links = await page
        .locator("a[href]")
        .evaluateAll((as) =>
          as.slice(0, 2000).map((a) => ({
            href: (a as HTMLAnchorElement).href,
            text: (a.textContent ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 160),
          })),
        )
        .catch(() => []);
      const follow: { href: string; text: string; value: number }[] = [];
      let pageFiles = 0;
      // Reaching a page about wells takes a few department pages; from such a
      // page, further links about wells are followed more deeply.
      const onTopic = wellRelevance(title, candidate.title) > 0;
      for (const link of links) {
        if (!link.href.startsWith("https://")) continue;
        let path = "";
        try {
          path = decodeURIComponent(new URL(link.href).pathname);
        } catch {
          continue;
        }
        const relevant = wellRelevance(link.text, path) > 0;
        if (DATA_LINK.test(path)) {
          // Files must be about wells themselves, not groundwater in general,
          // and a page of dozens of similar files contributes its first few.
          if (
            wellRelevance(link.text, path) >= 3 &&
            pageFiles++ < 10 &&
            !state.files.some((f) => f.url === link.href)
          )
            state.files.push({
              id: hash(link.href).slice(0, 16),
              title: link.text || path.split("/").pop() || link.href,
              url: link.href,
              origin: "page-link",
              named: mentionsCounty(link.text + " " + title),
            });
          continue;
        }
        const archive =
          /publicaccess|weblink|\/(Welcome|Browse|Search)\.aspx/i.test(
            link.href,
          );
        const sameSite = siteOf(link.href) === siteOf(page.url());
        if (candidate.official) {
          // On an official site: pages about wells are followed three levels
          // down, department pages two, directory pages one.
          const value = archive
            ? 3
            : sameSite
              ? linkValue(link.text, path)
              : relevant
                ? 3
                : 0;
          if (candidate.depth < (value === 3 && onTopic ? 6 : value))
            follow.push({ ...link, value });
        } else if (
          candidate.depth < 1 &&
          (relevant || archive) &&
          (sameSite || archive || /arcgis\.com$/.test(siteOf(link.href)))
        )
          follow.push({ ...link, value: 3 });
      }
      const chosen = new Set<string>();
      for (const link of follow.sort((a, b) => b.value - a.value)) {
        if (chosen.size >= (candidate.official ? 10 : 8)) break;
        if (chosen.has(pageKey(link.href))) continue;
        chosen.add(pageKey(link.href));
        const next: Candidate = {
          url: link.href,
          title: link.text,
          why: `linked from ${title || page.url()}`,
          // A page on another site is read but its own links are not followed.
          depth:
            candidate.official && siteOf(link.href) !== siteOf(page.url())
              ? 9
              : candidate.depth + 1,
        };
        if (candidate.official) {
          enqueueOfficial({
            ...next,
            official: true,
            level: candidate.level,
            root: candidate.root,
            // Pages that sound like well records first, then other pages about
            // wells and groundwater, then departments, then directory pages.
            priority:
              link.value === 3
                ? RECORDS.test(link.text + " " + link.href)
                  ? 6
                  : 5
                : link.value === 2
                  ? 2
                  : 1,
          });
        } else queue.push(next);
      }
      state.pages.push({ url: page.url(), title, note: remark });
    } catch (e) {
      const err = errorInfo(e);
      if (isBudget(err.code)) throw e;
      state.pages.push({
        url: candidate.url,
        title: candidate.title,
        note: `${candidate.why}; could not be opened (${err.code})`,
      });
    } finally {
      await page.close().catch(() => {});
    }
  }
  if (waiting())
    state.notes.push(
      `${waiting()} further page(s) were not opened (page limit ${budget}).`,
    );
}

export async function collectBrowserPortals(ctx: SourceContext) {
  const key = ctx.source.id + ":browse";
  let session: Awaited<ReturnType<typeof openBrowser>> | undefined;
  try {
    session = await openBrowser(ctx);
    const fetcher: Fetcher = browserFetcher(ctx, session.context);
    let state = ctx.store.get<BrowseState>(key);
    if (!state?.done) {
      state = {
        done: false,
        pages: [],
        services: {},
        portals: [],
        files: [],
        tables: 0,
        notes: [],
      };
      try {
        await browse(ctx, session.context, state);
        state.done = true;
        ctx.store.set(key, state);
      } catch (e) {
        const err = errorInfo(e);
        ctx.store.set(key, state);
        discoveryResult(ctx, {
          failed: true,
          errors: [err],
          caveats: state.notes,
        });
        if (isBudget(err.code)) throw e;
        return;
      }
    }
    // Step 3: read the layer list of each service a page loaded, through the browser session.
    const layers = new Map<string, LayerTarget>();
    const skipped: { code: string; message: string }[] = [];
    const saved = ctx.store.get<LayerTarget[]>(key + ":layers");
    if (saved) for (const layer of saved) layers.set(layer.url, layer);
    else {
      const services = Object.entries(state.services)
        .filter(([, s]) => s.relevance > 0)
        .sort((a, b) => b[1].relevance - a[1].relevance)
        .slice(0, ctx.config.maxTargets);
      for (const [url, service] of services) {
        try {
          for (const layer of await expandService(ctx, fetcher, url, {
            itemId: service.itemId,
            title: service.title,
            score: service.relevance,
          }))
            layers.set(layer.url, layer);
        } catch (e) {
          const err = errorInfo(e);
          if (isBudget(err.code)) throw e;
          skipped.push({
            code: err.code,
            message: `${service.title}: ${err.message}`,
          });
        }
      }
      ctx.store.set(key + ":layers", [...layers.values()]);
    }
    discoveryResult(ctx, {
      found: state.pages.length,
      selected:
        layers.size + state.files.length + state.portals.length + state.tables,
      errors: skipped,
      caveats: [
        `Browser opened ${state.pages.length} page(s) for ${ctx.geo.county}, ${ctx.geo.state}: ${layers.size} map layer(s), ${state.tables} table(s), ${state.files.length} linked file(s), ${state.portals.length} document archive(s).`,
        ...state.notes,
        ...state.pages
          .filter((p) => /refused|login|could not/.test(p.note))
          .slice(0, 15)
          .map((p) => `${p.url} — ${p.note}`),
        ...(state.sites?.length
          ? [
              `Official sites looked up for this place: ${state.sites.map((s) => `${new URL(s.url).hostname} (${s.level})`).join(", ")}.`,
            ]
          : []),
        "Official sites come from the .gov domain registry and Wikidata, and are read under each site's robots.txt. Search engines are not automated; use --seed-url for pages those directories do not lead to.",
      ],
    });
    ctx.store.set(ctx.source.id + ":discovery:metadata", {
      pages: state.pages,
    });
    ctx.logger.log("discovery.finished", {
      source_id: ctx.source.id,
      pages: state.pages.length,
      targets: layers.size,
    });
    // Step 4: collect everything found, still inside the browser session.
    // Map layers, linked files and each document archive take equal turns at
    // this collector's record budget, so a large layer cannot shut out an archive.
    const files =
      ctx.config.attachments === "all"
        ? state.files.slice(0, ctx.config.maxTargets)
        : [];
    const limit = ctx.config.maxRecords;
    let turns =
      (layers.size ? 1 : 0) + (files.length ? 1 : 0) + state.portals.length;
    const nextTurn = () => {
      ctx.config = {
        ...ctx.config,
        maxRecords:
          ctx.records +
          Math.floor(Math.max(0, limit - ctx.records) / Math.max(1, turns--)),
      };
    };
    // Time, download or cancellation limits end the collector; a used-up turn does not.
    const stopped = () => {
      try {
        ctx.http.check();
        return ctx.signal.aborted;
      } catch {
        return true;
      }
    };
    if (layers.size) {
      nextTurn();
      await collectArcgis(ctx, [...layers.values()], fetcher);
      if (stopped()) return;
    }
    if (files.length) {
      nextTurn();
      for (const file of files)
        if (!(await collectFileTarget(ctx, file, fetcher))) break;
      if (stopped()) return;
    }
    for (const portal of state.portals) {
      if (stopped()) return;
      nextTurn();
      const dataset = `reports:${new URL(portal.url).hostname}:${hash(portal.base).slice(0, 8)}`;
      // A login is offered once per archive, and only when the run allows it.
      for (let attempt = 0; attempt < 2; attempt++) {
        const page = await session.context.newPage();
        try {
          // A session saved with "auth login --url" applies only to that portal's own origin.
          const saved = resolveCredentials(
            portalManifest(portal.url),
            ctx.config.credentialProfile,
          );
          if (saved?.storageState) {
            const cookies = JSON.parse(
              readFileSync(saved.storageState, "utf8"),
            ) as { cookies?: Parameters<BrowserContext["addCookies"]>[0] };
            await session.context.addCookies(cookies.cookies ?? []);
          }
          await page.goto(portal.url, { waitUntil: "domcontentloaded" });
          await settle(page);
          if (portal.type === "hyland")
            await collectHylandPortal(
              ctx,
              session.context,
              page,
              portal.base,
              dataset,
            );
          else
            await collectLaserfichePortal(
              ctx,
              session.context,
              page,
              portal.laserfiche!,
              dataset,
            );
        } catch (e) {
          const err = errorInfo(e);
          ctx.store.result({
            ...emptyResult(ctx.source.id, dataset),
            status:
              err.code === "NEEDS_AUTH"
                ? "needs_auth"
                : err.code === "BLOCKED"
                  ? "blocked"
                  : "failed",
            completeness: "incomplete",
            errors: [err],
          });
        } finally {
          await page.close().catch(() => {});
        }
        const needsLogin = ctx.store
          .results()
          .some(
            (r) =>
              r.source_id === ctx.source.id &&
              r.dataset_id === dataset &&
              (r.status === "needs_auth" ||
                r.errors.some((e) => e.code === "NEEDS_AUTH")),
          );
        if (!needsLogin || attempt || !ctx.config.interactiveAuth) break;
        try {
          await interactiveLogin({
            ...ctx,
            source: portalManifest(portal.url),
          });
        } catch {
          break;
        }
      }
    }
  } finally {
    await session?.close();
  }
}
