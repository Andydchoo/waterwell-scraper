import type { Geography, SourceManifest } from "../core/types.js";
import { APPROACHES, ScrapeError, type Approach } from "../core/types.js";

// Generic collectors, one or more per acquisition approach. Nothing here names
// a state, county, agency portal or dataset: every collector receives the
// requested geography and finds its targets at run time.
const common = { status: "implemented" as const, verifiedAt: "2026-11-10" };
export const registry: SourceManifest[] = [
  {
    ...common,
    id: "usgs-groundwater",
    version: "1.1.0",
    approach: "api",
    mode: "usgs",
    title: "USGS groundwater monitoring API",
    agency: "U.S. Geological Survey",
    landingPage: "https://api.waterdata.usgs.gov/",
    origins: ["https://api.waterdata.usgs.gov"],
    datasets: ["monitoring-locations", "field-measurements"],
    limitation:
      "Monitoring wells and field measurements only; continuous series and laboratory samples are not covered by this API collector.",
  },
  {
    ...common,
    id: "arcgis-services",
    version: "1.0.0",
    approach: "api",
    mode: "arcgis",
    title: "Public GIS well layers (discovered)",
    agency:
      "County, state and federal publishers found in the public ArcGIS catalog",
    landingPage: "https://www.arcgis.com/home/search.html",
    origins: ["https://www.arcgis.com"],
    datasets: ["discovery"],
    limitation:
      "Layers are found by catalog search for the county at run time. Overlapping layers are kept as separate source records; units stay unknown unless the source field states them.",
  },
  {
    ...common,
    id: "browser-portals",
    version: "1.1.0",
    approach: "browser",
    mode: "browser",
    title: "Public web portals (browser navigation)",
    agency: "Agency sites and map applications found by browsing",
    landingPage: "https://hub.arcgis.com/search",
    // Pages are discovered while browsing, so any public HTTPS host may be visited.
    origins: ["*"],
    datasets: ["discovery"],
    limitation:
      "Chromium starts from the public ArcGIS catalog site, the official county and state-agency websites listed for the place in the .gov registry and Wikidata, and any pages supplied for the run. It follows sitemaps and department links under each site's robots.txt and collects the map layers, tables, linked files and public document archives the pages expose. Sites that block automation or require login are reported, not bypassed; search engines are not automated.",
  },
  {
    ...common,
    id: "wqp-downloads",
    version: "1.0.0",
    approach: "download",
    mode: "wqp",
    title: "Water Quality Portal file downloads",
    agency: "USGS / EPA / National Water Quality Monitoring Council",
    landingPage: "https://www.waterqualitydata.us/",
    origins: ["https://www.waterqualitydata.us"],
    datasets: ["stations", "results"],
    limitation:
      "Well sites and sample results reported to the national portal; private domestic wells are generally absent.",
  },
  {
    ...common,
    id: "catalog-files",
    version: "1.0.0",
    approach: "download",
    mode: "files",
    title: "Published data files (discovered)",
    agency: "County, state and federal publishers found in public catalogs",
    landingPage: "https://hub.arcgis.com/search",
    // Files and export redirects live on hosts that are only known at run time.
    origins: ["*"],
    datasets: ["discovery"],
    limitation:
      "Downloads catalog files and bulk layer exports found for the county. CSV and GeoJSON rows become records; other formats are kept as original files.",
  },
];
export function selectSources(
  _geo: Geography,
  ids: string[] = [],
  approaches: Approach[] = [],
) {
  // Every collector applies to every county; none is tied to a geography.
  for (const id of ids)
    if (!registry.some((s) => s.id === id))
      throw new ScrapeError("INVALID_INPUT", `Source ${id} is unknown.`);
  const wanted = approaches.length ? approaches : APPROACHES;
  const selected = registry.filter(
    (s) => wanted.includes(s.approach) && (!ids.length || ids.includes(s.id)),
  );
  if (!selected.length)
    throw new ScrapeError(
      "INVALID_INPUT",
      "No collector matches the selected sources and approaches.",
    );
  // All approaches run on every collection; order only affects which finishes first.
  return selected.sort(
    (a, b) => APPROACHES.indexOf(a.approach) - APPROACHES.indexOf(b.approach),
  );
}
/** A browser portal found at run time, for origin-scoped saved sessions. */
export function portalManifest(url: string): SourceManifest {
  const u = new URL(url);
  return {
    ...common,
    id: "portal-" + u.hostname.replace(/[^a-z0-9]+/gi, "-").toLowerCase(),
    version: "1.0.0",
    approach: "browser",
    mode: "browser",
    title: "Portal " + u.hostname,
    agency: u.hostname,
    landingPage: url,
    origins: [u.origin],
    datasets: [],
  };
}
