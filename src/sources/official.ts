import { gunzipSync } from "node:zlib";
import { errorInfo } from "../core/types.js";
import { query } from "../transports/http.js";
import { wellRelevance } from "../data/normalize.js";
import {
  countyShortName,
  isBudget,
  type Fetcher,
  type SourceContext,
} from "./context.js";
import { csvRows } from "./tabular.js";

// Official-site discovery without a search engine. Two nationwide public
// directories are asked, at run time, which websites belong to the requested
// county's government and to the state agencies that deal with water:
//   - the federal .gov domain registry (published by CISA as a CSV file), and
//   - Wikidata (official websites of counties and state agencies).
// The sites are then read the way their owners ask: robots.txt is obeyed and
// each site's own sitemap is used to find its pages about wells.
export const GOV_REGISTRY =
  "https://raw.githubusercontent.com/cisagov/dotgov-data/main/current-full.csv";
export const WIKIDATA = "https://query.wikidata.org/sparql";
// The name this application answers to in robots.txt.
export const AGENT = "WaterwellScraper";

export interface OfficialSite {
  url: string;
  name: string;
  level: "county" | "state";
  listedBy: "gov-registry" | "wikidata";
}
const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/\bsaint\b/g, "st")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** Registrable site of an address, so links stay on the same government's pages. */
export function siteOf(url: string) {
  const labels = new URL(url).hostname.toLowerCase().split(".");
  // Older government addresses: agency.state.mn.us, co.hennepin.mn.us.
  if (labels.at(-1) === "us" && labels.at(-2)?.length === 2)
    return labels.slice(labels.at(-3) === "state" ? -3 : -4).join(".");
  return labels.slice(-2).join(".");
}
/** How likely a state body is to publish well or groundwater records. 0 = not a candidate. */
export function agencyRelevance(name: string) {
  const text = fold(name);
  let score = 0;
  if (
    /ground ?water|water (resources|rights|science|supply|quality|well)|\bwells?\b|geolog/.test(
      text,
    )
  )
    score += 3;
  if (
    /environment|natural resources|ecology|pollution|conservation|\bwater\b/.test(
      text,
    )
  )
    score += 2;
  if (
    /department of health|health department|public health|environmental health/.test(
      text,
    )
  )
    score += 1;
  if (
    /mental|medicaid|occupational|hospital|counsel|board of|examiner|certification|licens|advisory|council|commission|authority|review|clearinghouse|\bplan\b|alliance|trustees|enforcement|infrastructure|\bplant\b|rural|statistics|contractors/.test(
      text,
    )
  )
    score -= 4;
  return Math.max(0, score);
}
const https = (raw: string) => {
  try {
    const u = new URL(raw.trim().replace(/^http:/i, "https:"));
    return u.protocol === "https:" && !u.username ? u.toString() : null;
  } catch {
    return null;
  }
};
/** County and state sites listed in the .gov registry file. */
export function registrySites(csv: string, ctx: SourceContext): OfficialSite[] {
  const rows = csvRows(csv);
  const head = rows.next();
  if (head.done) return [];
  const column = (name: string) =>
    head.value.findIndex((h) => fold(h) === name);
  const [domain, type, org, sub, state] = [
    "domain name",
    "domain type",
    "organization name",
    "suborganization name",
    "state",
  ].map(column) as [number, number, number, number, number];
  if ([domain, type, org, state].some((i) => i < 0)) return [];
  const short = fold(countyShortName(ctx.geo));
  // Independent cities are county-equivalents with a city government.
  const kinds = /city$/i.test(ctx.geo.county) ? ["city", "county"] : ["county"];
  const owned = new RegExp(
    `^(county of |parish of |city of |city and county of )?${short}( county| parish| borough| city)?( |$)`,
  );
  const county: { site: OfficialSite; score: number }[] = [];
  const agencies: { site: OfficialSite; score: number }[] = [];
  for (const row of rows) {
    if ((row[state] ?? "").trim().toUpperCase() !== ctx.geo.state) continue;
    const url = https("https://" + (row[domain] ?? "").trim().toLowerCase());
    if (!url || !/^[a-z0-9.-]+\.gov$/.test(new URL(url).hostname)) continue;
    const name = [row[org], sub >= 0 ? row[sub] : ""]
      .filter(Boolean)
      .join(" — ");
    const kind = fold(row[type] ?? "");
    if (kinds.includes(kind) && owned.test(fold(row[org] ?? ""))) {
      const text = fold(name + " " + row[domain]);
      county.push({
        site: { url, name, level: "county", listedBy: "gov-registry" },
        score:
          (fold(row[org] ?? "").replace(owned, "") === "" ? 2 : 0) -
          // A county's election, court or emergency site is not where well records are.
          (/vote|elect|emergenc|sheriff|court|clerk|librar|jail|\btax|911|\bfire|\bems\b|attorney|transit|airport|park/.test(
            text,
          )
            ? 3
            : 0),
      });
    } else if (kind.startsWith("state")) {
      const score = agencyRelevance(name);
      if (score)
        agencies.push({
          site: { url, name, level: "state", listedBy: "gov-registry" },
          score,
        });
    }
  }
  const best = <T extends { score: number; site: OfficialSite }>(list: T[]) =>
    list.sort(
      (a, b) => b.score - a.score || a.site.url.length - b.site.url.length,
    );
  const main = best(county).filter((c) => c.score >= 0);
  return [
    ...(main.length ? main : best(county).slice(0, 1))
      .slice(0, 3)
      .map((c) => c.site),
    ...best(agencies)
      .slice(0, 2)
      .map((a) => a.site),
  ];
}
async function sparql(fetcher: Fetcher, text: string) {
  const data = await fetcher.json<{
    results?: { bindings?: Record<string, { value: string }>[] };
  }>(query(WIKIDATA, { query: text, format: "json" }), {
    accept: "application/sparql-results+json",
  });
  return data.results?.bindings ?? [];
}
/** The county's official website and the state's water-related agencies, from Wikidata. */
export async function wikidataSites(
  ctx: SourceContext,
  fetcher: Fetcher,
): Promise<OfficialSite[]> {
  const sites: OfficialSite[] = [];
  const geoid = ctx.geo.county_geoid.replace(/\D/g, ""),
    stateFips = ctx.geo.state_fips.replace(/\D/g, "");
  for (const row of await sparql(
    fetcher,
    `SELECT ?site WHERE { ?county wdt:P882 "${geoid}" ; wdt:P856 ?site } LIMIT 5`,
  )) {
    const url = https(row.site?.value ?? "");
    if (url)
      sites.push({
        url,
        name: ctx.geo.county,
        level: "county",
        listedBy: "wikidata",
      });
  }
  const agencies = (
    await sparql(
      fetcher,
      `SELECT DISTINCT ?name ?site WHERE { ?state wdt:P5087 "${stateFips}" . ?agency wdt:P1001 ?state ; wdt:P856 ?site ; rdfs:label ?name . FILTER(LANG(?name) = "en") } LIMIT 3000`,
    )
  )
    .map((row) => ({
      url: https(row.site?.value ?? ""),
      name: row.name?.value ?? "",
      score: agencyRelevance(row.name?.value ?? ""),
    }))
    .filter((a): a is { url: string; name: string; score: number } =>
      Boolean(a.url && a.score),
    )
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  for (const agency of agencies.slice(0, 4))
    sites.push({
      url: agency.url,
      name: agency.name,
      level: "state",
      listedBy: "wikidata",
    });
  return sites;
}
/**
 * Ask both directories. Each is optional: when one is unreachable the other
 * still answers, and the gap is reported in the collection log.
 */
export async function officialSites(ctx: SourceContext, fetcher: Fetcher) {
  const notes: string[] = [];
  const found: OfficialSite[] = [];
  const attempt = async (label: string, run: () => Promise<OfficialSite[]>) => {
    try {
      ctx.http.check();
      const sites = await run();
      found.push(...sites);
      notes.push(`${label}: ${sites.length} official site(s) listed`);
    } catch (e) {
      const err = errorInfo(e);
      if (isBudget(err.code)) throw e;
      notes.push(`${label} could not be read: ${err.message}`);
    }
  };
  await attempt(".gov domain registry", async () => {
    const file = await fetcher.get(GOV_REGISTRY, 20 * 1024 ** 2);
    const sites = registrySites(file.body.toString("utf8"), ctx);
    // Only the matched rows are kept as evidence; the registry's contact column is not stored.
    ctx.store.raw(ctx.source.id, { directory: GOV_REGISTRY, sites });
    return sites;
  });
  await attempt("Wikidata", async () => {
    const sites = await wikidataSites(ctx, fetcher);
    ctx.store.raw(ctx.source.id, { directory: WIKIDATA, sites });
    return sites;
  });
  // One entry per page address; county sites first, registry before Wikidata.
  const seen = new Set<string>();
  const sites = found
    .sort(
      (a, b) =>
        Number(b.level === "county") - Number(a.level === "county") ||
        Number(b.listedBy === "gov-registry") -
          Number(a.listedBy === "gov-registry"),
    )
    .filter((site) => {
      const key = site.url.replace(/^https:\/\/www\./, "https://");
      return seen.has(key) ? false : (seen.add(key), true);
    });
  return { sites, notes };
}

export interface Robots {
  allowed(url: string): boolean;
  sitemaps: string[];
  delayMs: number;
  // The site did not answer at all, which is different from asking visitors to stay out.
  unreachable?: boolean;
}
const openRobots: Robots = { allowed: () => true, sitemaps: [], delayMs: 0 };
const closedRobots: Robots = {
  allowed: () => false,
  sitemaps: [],
  delayMs: 0,
  unreachable: true,
};
/**
 * Follow a listed address to where the site lives now (www host, new domain).
 * Directory entries can be years old, so a dead address is expected and reported.
 */
export async function resolveHome(
  ctx: SourceContext,
  fetcher: Fetcher,
  url: string,
): Promise<{ url: string; reachable: boolean }> {
  try {
    const page = await fetcher.get(url, 5 * 1024 ** 2);
    return { url: page.url, reachable: true };
  } catch (e) {
    const code = errorInfo(e).code;
    if (isBudget(code)) throw e;
    ctx.logger.log("site.unavailable", { url, error_code: code });
    // A site that refuses this plain request may still serve a browser.
    return {
      url,
      reachable: [
        "BLOCKED",
        "NEEDS_AUTH",
        "HTTP_ERROR",
        "FILE_TOO_LARGE",
      ].includes(code),
    };
  }
}
/** Parse robots.txt for this application's rules (its own group, else "*"). */
export function parseRobots(text: string, agent = AGENT): Robots {
  if (/^\s*<(!doctype|html)/i.test(text)) return openRobots;
  const groups: {
    agents: string[];
    rules: [boolean, string][];
    delay?: number;
  }[] = [];
  const sitemaps: string[] = [];
  let group: (typeof groups)[number] | undefined;
  let open = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const at = line.indexOf(":");
    if (at < 0) continue;
    const field = line.slice(0, at).trim().toLowerCase(),
      value = line.slice(at + 1).trim();
    if (field === "sitemap") {
      const url = https(value);
      if (url) sitemaps.push(url);
    } else if (field === "user-agent") {
      // Consecutive User-agent lines share the rules that follow them.
      if (!open) groups.push((group = { agents: [], rules: [] }));
      group!.agents.push(value.toLowerCase());
      open = true;
    } else if (group && (field === "allow" || field === "disallow")) {
      open = false;
      if (value) group.rules.push([field === "allow", value]);
    } else if (group && field === "crawl-delay") {
      open = false;
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) group.delay = seconds;
    } else open = false;
  }
  const mine =
    groups.filter((g) =>
      g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)),
    ) ?? [];
  const chosen = mine.length
    ? mine
    : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) =>
    g.rules.map(([allow, pattern]) => ({
      allow,
      length: pattern.length,
      test: new RegExp(
        "^" +
          pattern
            .replace(/\$$/, "")
            .split("*")
            .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*") +
          (pattern.endsWith("$") ? "$" : ""),
      ),
    })),
  );
  return {
    sitemaps,
    // Waits are honoured up to 20 seconds; a longer request is treated as 20.
    delayMs:
      Math.min(20, Math.max(0, ...chosen.map((g) => g.delay ?? 0))) * 1000,
    allowed(url: string) {
      let path: string;
      try {
        const u = new URL(url);
        path = u.pathname + u.search;
      } catch {
        return false;
      }
      // The most specific matching rule decides; Allow wins a tie.
      let verdict = true,
        best = -1;
      for (const rule of rules)
        if (
          rule.test.test(path) &&
          (rule.length > best || (rule.length === best && rule.allow))
        ) {
          verdict = rule.allow;
          best = rule.length;
        }
      return verdict;
    },
  };
}
/** Fetch a site's robots.txt. No file means no restrictions; an unreachable site is left alone. */
export async function fetchRobots(
  ctx: SourceContext,
  fetcher: Fetcher,
  origin: string,
): Promise<Robots> {
  try {
    const file = await fetcher.get(origin + "/robots.txt", 512 * 1024);
    return parseRobots(file.body.toString("utf8"));
  } catch (e) {
    const code = errorInfo(e).code;
    if (isBudget(code)) throw e;
    ctx.logger.log("robots.unavailable", { origin, error_code: code });
    return ["NOT_FOUND", "HTTP_ERROR", "BLOCKED", "NEEDS_AUTH"].includes(code)
      ? openRobots
      : closedRobots;
  }
}
const FILE = /\.(csv|xlsx?|zip|geojson|kml|kmz|pdf)$/i;
const SKIP = /\.(jpe?g|png|gif|svg|webp|ico|css|js|mp4|mp3|woff2?)$/i;
const readable = (path: string) => {
  let text = path;
  try {
    text = decodeURIComponent(path);
  } catch {
    // Keep the raw path when it is not valid percent-encoding.
  }
  return text.replace(/[-_/+.]+/g, " ").trim();
};
const titleOf = (url: string) =>
  readable(new URL(url).pathname.replace(/\/$/, "").split("/").pop() ?? "") ||
  new URL(url).hostname;
/**
 * Pages and data files about wells that the site lists in its own sitemap.
 * At most a handful of sitemap files are read per site.
 */
export async function sitemapPages(
  ctx: SourceContext,
  fetcher: Fetcher,
  home: string,
  robots: Robots,
  limit = 8,
) {
  const origin = new URL(home).origin;
  // A site that has moved answers from its new address; both count as the same site.
  const sites = new Set([siteOf(home)]);
  const declared = robots.sitemaps.filter((u) => sites.has(siteOf(u)));
  const pending = (
    declared.length ? declared : [origin + "/sitemap.xml"]
  ).slice(0, 3);
  const scored = new Map<string, number>();
  let fetched = 0;
  while (pending.length && fetched < 7) {
    const url = pending.shift()!;
    fetched++;
    let text: string;
    try {
      ctx.http.check();
      const file = await fetcher.get(url, 20 * 1024 ** 2);
      if (url === origin + "/sitemap.xml") sites.add(siteOf(file.url));
      text = (
        file.body[0] === 0x1f && file.body[1] === 0x8b
          ? gunzipSync(file.body, { maxOutputLength: 64 * 1024 ** 2 })
          : file.body
      ).toString("utf8");
    } catch (e) {
      if (isBudget(errorInfo(e).code)) throw e;
      continue;
    }
    const locs = [...text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
      m[1]!
        .replace(/&amp;/g, "&")
        .replace(/&#x2F;/gi, "/")
        .replace(/&lt;|&gt;|&quot;|&apos;/g, ""),
    );
    if (/<sitemapindex/i.test(text)) {
      // An index lists more sitemap files; image and video maps are not pages.
      pending.push(
        ...locs
          .filter(
            (u) =>
              https(u) && sites.has(siteOf(u)) && !/image|video|news/i.test(u),
          )
          .slice(0, 6),
      );
      continue;
    }
    for (const loc of locs) {
      const address = https(loc);
      if (!address || !sites.has(siteOf(address)) || !robots.allowed(address))
        continue;
      const path = new URL(address).pathname;
      if (SKIP.test(path)) continue;
      const relevance = wellRelevance(readable(path));
      if (!relevance) continue;
      // Announcements and meeting papers mention wells without holding records.
      if (
        /\/(news|blog|press[a-z-]*|events?|calendar|agendas?|minutes|jobs?|careers?)(\/|$)|\/(19|20)\d{2}\//i.test(
          path,
        )
      )
        continue;
      // Pages that sound like records, permits or data come first.
      const records =
        /record|permit|data|search|database|\blogs?\b|report|\bmaps?\b|viewer|inventory|construction|application|lookup|download|form/i.test(
          readable(path),
        );
      scored.set(address, relevance + (records ? 2 : 0));
    }
  }
  const ranked = [...scored]
    .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
    .map(([url]) => ({ url, title: titleOf(url) }));
  return {
    pages: ranked
      .filter((p) => !FILE.test(new URL(p.url).pathname))
      .slice(0, limit),
    // Files must name wells themselves; general groundwater reports are left out.
    files: ranked
      .filter(
        (p) =>
          FILE.test(new URL(p.url).pathname) &&
          wellRelevance(readable(new URL(p.url).pathname)) >= 3,
      )
      .slice(0, limit),
    read: fetched,
  };
}
// Link text that leads toward well records on a government site.
const TOPIC =
  /environmental (health|services|quality|protection)|public health|health (department|services|and human)|\bwater\b|natural resources|\benvironment\b|septic|on ?site (sewage|wastewater)|\bpermit(s|ting)?\b|land use|soil and water|open data|\bgis\b|public records|records (search|request)/i;
// Link text for the directory pages a home page uses to reach its departments.
const HUB =
  /^(all )?(departments?|services|agencies|divisions|government|programs?( and services)?|residents?|a ?(-|to) ?z( index)?)( directory| list)?$/i;
/** 3 = about wells, 2 = a department that handles them, 1 = a directory page, 0 = unrelated. */
export function linkValue(text: string, path: string) {
  if (wellRelevance(text, readable(path)) > 0) return 3;
  const label = text.replace(/[^a-z0-9 &-]+/gi, " ").trim();
  // Only the page's own name counts, not the section it sits under: every
  // page below /environment/ is not about water.
  const leaf = readable(path.replace(/\/+$/, "").split("/").pop() ?? "");
  if (TOPIC.test(label) || TOPIC.test(leaf)) return 2;
  return HUB.test(label) ? 1 : 0;
}
