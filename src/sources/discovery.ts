import { ScrapeError, errorInfo } from "../core/types.js";
import { query } from "../transports/http.js";
import { wellRelevance } from "../data/normalize.js";
import { bboxIntersects } from "../geography/boundary.js";
import {
  countyShortName,
  isBudget,
  type Fetcher,
  type SourceContext,
} from "./context.js";
import type { Layer } from "./arcgis.js";

// Run-time discovery. The only fixed addresses are nationwide public catalogs;
// which services, layers and files belong to a county is decided per run from
// the catalog's own answers for that county's name and boundary.
export const CATALOG = "https://www.arcgis.com/sharing/rest";
export const CATALOG_ORIGIN = new URL(CATALOG).origin;
const TOPIC = "(well OR wells OR groundwater OR borehole OR aquifer)";
export const SERVICE_TYPES = ["Feature Service", "Map Service"];
export const FILE_TYPES = [
  "CSV",
  "CSV Collection",
  "Microsoft Excel",
  "GeoJson",
  "Shapefile",
  "KML",
  "File Geodatabase",
  "GeoPackage",
  "PDF",
];
export interface CatalogItem {
  id: string;
  title: string;
  type: string;
  url: string | null;
  snippet: string | null;
  tags: string[];
  owner: string;
  access: string;
  extent: number[][];
  name?: string | null;
  size?: number;
  score: number;
  named: boolean;
}
export interface LayerTarget extends Layer {
  itemId: string | null;
  itemTitle: string;
  score: number;
}
interface SearchResponse {
  total: number;
  nextStart: number;
  results: Omit<CatalogItem, "score" | "named">[];
}
const typeClause = (types: string[]) =>
  "(" + types.map((t) => `type:"${t}"`).join(" OR ") + ")";
function area(extent: number[][]) {
  if (extent?.length !== 2) return Infinity;
  return (
    Math.abs(extent[1]![0]! - extent[0]![0]!) *
    Math.abs(extent[1]![1]! - extent[0]![1]!)
  );
}
/** Search the public ArcGIS catalog for items about wells that cover the county. */
export async function searchCatalog(
  ctx: SourceContext,
  fetcher: Fetcher,
  types: string[],
): Promise<CatalogItem[]> {
  const county = countyShortName(ctx.geo);
  const bbox = ctx.boundary?.bbox;
  const countyArea = bbox ? (bbox[2] - bbox[0]) * (bbox[3] - bbox[1]) : null;
  const queries = [
    // Items that name the county.
    `${TOPIC} AND "${county}" AND ${typeClause(types)}`,
    // Items that name the state; statewide datasets are filtered to the county later.
    `${TOPIC} AND "${ctx.geo.state_name}" AND ${typeClause(types)}`,
    // Items found only by where they are.
    `${TOPIC} AND ${typeClause(types)}`,
  ];
  const found = new Map<string, CatalogItem>();
  for (const q of queries) {
    let start = 1;
    for (let page = 0; page < 2 && start > 0; page++) {
      ctx.http.check();
      const response = await fetcher.json<SearchResponse>(
        query(CATALOG + "/search", {
          q,
          // The catalog keeps items whose extent intersects the county's bounding box.
          ...(bbox ? { bbox: bbox.join(",") } : {}),
          num: 100,
          start,
          sortField: "",
          f: "json",
        }),
      );
      if (!Array.isArray(response.results))
        throw new ScrapeError(
          "SCHEMA_CHANGED",
          "Catalog search response changed.",
        );
      ctx.store.raw(ctx.source.id, { query: q, bbox, start, response });
      for (const item of response.results) {
        if (item.access !== "public" || found.has(item.id)) continue;
        const extent = Array.isArray(item.extent) ? item.extent : [];
        if (
          bbox &&
          extent.length === 2 &&
          !bboxIntersects(bbox, [
            extent[0]![0]!,
            extent[0]![1]!,
            extent[1]![0]!,
            extent[1]![1]!,
          ])
        )
          continue;
        const text = [item.title, item.snippet, (item.tags ?? []).join(" ")];
        const relevance = wellRelevance(...text);
        const titleRelevance = wellRelevance(item.title, item.name);
        const named = new RegExp(
          `\\b${county.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i",
        ).test(text.join(" ") + " " + item.owner);
        // A bare tag match on an unrelated layer is not enough: the title, or
        // the summary of an item that names the county, must be about wells.
        if (
          !relevance ||
          (!titleRelevance && !(named && wellRelevance(item.snippet)))
        )
          continue;
        const size = area(extent);
        const local =
          countyArea && Number.isFinite(size)
            ? size <= countyArea * 6
              ? 3
              : size <= countyArea * 400
                ? 1
                : 0
            : 0;
        found.set(item.id, {
          ...item,
          tags: item.tags ?? [],
          extent,
          score: relevance + titleRelevance + (named ? 3 : 0) + local,
          named,
        });
      }
      start = response.nextStart;
    }
  }
  return [...found.values()].sort(
    (a, b) => b.score - a.score || a.id.localeCompare(b.id),
  );
}
export function arcgisRestUrl(input: string): string | null {
  try {
    const u = new URL(input.replace(/^http:/i, "https:"));
    const m = u.pathname.match(
      /^(.*\/rest\/services\/.+?\/(?:FeatureServer|MapServer))(?:\/(\d+))?/i,
    );
    if (!m) return null;
    return u.origin + m[1] + (m[2] !== undefined ? "/" + m[2] : "");
  } catch {
    return null;
  }
}
export function layerDatasetId(url: string) {
  const u = new URL(url);
  const [before, after] = u.pathname.split(/\/rest\/services\//i);
  // Hosted services keep the publisher's organisation ID ahead of /arcgis/rest/services.
  const org = (before ?? "")
    .split("/")
    .filter((part) => part && !/^(arcgis|server|gis)$/i.test(part))
    .join("/");
  return [u.hostname, org, after].filter(Boolean).join("/");
}
interface ServiceRoot {
  layers?: {
    id: number;
    name: string;
    geometryType?: string;
    subLayerIds?: number[] | null;
  }[];
  tables?: { id: number; name: string }[];
  // Present when the URL is itself a layer.
  fields?: unknown[];
  name?: string;
  type?: string;
  geometryType?: string;
  capabilities?: string;
}
/** Turn a service URL into its queryable point layers and tables that are about wells. */
export async function expandService(
  ctx: SourceContext,
  fetcher: Fetcher,
  serviceUrl: string,
  context: { itemId: string | null; title: string; score: number },
): Promise<LayerTarget[]> {
  const url = arcgisRestUrl(serviceUrl);
  if (!url || !ctx.http.allow(url)) return [];
  const target = (layerUrl: string, name: string): LayerTarget => ({
    id: layerDatasetId(layerUrl),
    url: layerUrl,
    title: name === context.title ? name : `${context.title} — ${name}`,
    itemId: context.itemId,
    itemTitle: context.title,
    score: context.score,
  });
  const root = await fetcher.json<ServiceRoot>(query(url, { f: "json" }));
  ctx.store.raw(ctx.source.id, { url, root });
  if (/\/\d+$/.test(url)) {
    if (root.geometryType && root.geometryType !== "esriGeometryPoint")
      return [];
    return [target(url, root.name ?? context.title)];
  }
  const candidates = [
    ...(root.layers ?? [])
      .filter(
        (l) =>
          !l.subLayerIds?.length &&
          (!l.geometryType || l.geometryType === "esriGeometryPoint"),
      )
      .map((l) => ({ ...l, table: false })),
    ...(root.tables ?? []).map((t) => ({ ...t, table: true })),
  ];
  const relevant = candidates.filter((l) => wellRelevance(l.name) > 0);
  // When no layer name mentions wells, the catalog item's own title vouches for a small service.
  const chosen = relevant.length
    ? relevant
    : context.itemId && wellRelevance(context.title) > 0
      ? candidates.filter((l) => !l.table).slice(0, 6)
      : [];
  return chosen.slice(0, 12).map((l) => target(`${url}/${l.id}`, l.name));
}
/**
 * Discover the ArcGIS layers to harvest for this county. The result is
 * checkpointed so a resumed run keeps the same target list.
 */
export async function discoverLayers(
  ctx: SourceContext,
  fetcher: Fetcher,
): Promise<{
  targets: LayerTarget[];
  items: CatalogItem[];
  errors: { code: string; message: string }[];
}> {
  const key = ctx.source.id + ":targets";
  const saved = ctx.store.get<{
    targets: LayerTarget[];
    items: CatalogItem[];
    errors: { code: string; message: string }[];
  }>(key);
  if (saved) {
    for (const t of saved.targets) ctx.http.allow(t.url);
    return saved;
  }
  const items = (await searchCatalog(ctx, fetcher, SERVICE_TYPES)).slice(
    0,
    ctx.config.maxTargets,
  );
  const targets = new Map<string, LayerTarget>();
  const errors: { code: string; message: string }[] = [];
  for (const item of items) {
    if (!item.url) continue;
    try {
      for (const t of await expandService(ctx, fetcher, item.url, {
        itemId: item.id,
        title: item.title,
        score: item.score,
      }))
        if (!targets.has(t.url)) targets.set(t.url, t);
    } catch (e) {
      const err = errorInfo(e);
      if (isBudget(err.code)) throw e;
      // An unreachable or private service does not stop discovery of the others.
      errors.push({
        code: err.code,
        message: `${item.title}: ${err.message}`,
      });
    }
  }
  const result = {
    targets: [...targets.values()].sort((a, b) => b.score - a.score),
    items,
    errors,
  };
  ctx.store.set(key, result);
  return result;
}
