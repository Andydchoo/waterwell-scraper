import * as cheerio from "cheerio";
import {
  emptyResult,
  entityId,
  errorInfo,
  ScrapeError,
  type SourceResult,
} from "../core/types.js";
import { hash } from "../core/util.js";
import { query } from "../transports/http.js";
import { parseResult, wellRelevance } from "../data/normalize.js";
import { discoveryResult } from "./api.js";
import {
  CATALOG,
  FILE_TYPES,
  SERVICE_TYPES,
  expandService,
  searchCatalog,
} from "./discovery.js";
import {
  checkRecordBudget,
  isBudget,
  type Fetcher,
  type SourceContext,
} from "./context.js";
import {
  detectFileType,
  fileDocument,
  ingestTable,
  readCsv,
  readGeoJson,
  saveFile,
  type TableCounts,
} from "./tabular.js";

const FILE_LIMIT = 100 * 1024 ** 2;
const statusOf = (code: string) =>
  code === "NEEDS_AUTH"
    ? "needs_auth"
    : code === "BLOCKED"
      ? "blocked"
      : "failed";
function finish(
  ctx: SourceContext,
  result: SourceResult,
  counts: TableCounts | null,
  error?: { code: string; message: string },
) {
  if (counts) {
    result.fetched = counts.rows;
    result.accepted = counts.accepted;
    result.excluded = counts.excluded;
    result.expected ??= counts.rows;
    result.unresolved = Math.max(0, result.expected - result.fetched);
    result.status = "success";
    result.completeness = "unverified";
  }
  if (error) {
    // Rows committed before the stop still count; the file is finished on resume.
    for (const row of ctx.store.taskCounts(ctx.source.id, result.dataset_id)) {
      if (row.status === "accepted") result.accepted += Number(row.n);
      if (row.status === "excluded") result.excluded += Number(row.n);
    }
    result.fetched = result.accepted + result.excluded;
    result.errors.push(error);
    result.status = result.accepted ? "partial" : statusOf(error.code);
    result.completeness = "incomplete";
  }
  ctx.store.result(result);
  ctx.logger.log("source.finished", {
    source_id: ctx.source.id,
    dataset_id: result.dataset_id,
    status: result.status,
    accepted: result.accepted,
  });
}

// ---------------------------------------------------------------------------
// Water Quality Portal: nationwide download service keyed by state/county FIPS.
// ---------------------------------------------------------------------------
const WQP = "https://www.waterqualitydata.us/data";
export async function collectWqp(ctx: SourceContext) {
  const scope = {
    statecode: `US:${ctx.geo.state_fips}`,
    countycode: `US:${ctx.geo.state_fips}:${ctx.geo.county_fips}`,
    siteType: "Well",
    mimeType: "csv",
    zip: "no",
  };
  const previous = ctx.http.opts.requestTimeoutMs;
  ctx.http.opts.requestTimeoutMs = 180000;
  try {
    for (const dataset of ["stations", "results"] as const) {
      const result = emptyResult(ctx.source.id, dataset);
      const key = ctx.source.id + ":" + dataset;
      if (ctx.store.get<boolean>(key + ":done")) {
        // A finished download is not repeated on resume.
        const prior = ctx.store
          .results()
          .find(
            (r) => r.source_id === ctx.source.id && r.dataset_id === dataset,
          );
        if (prior && prior.status === "success") continue;
      }
      try {
        checkRecordBudget(ctx);
        const url = query(
          `${WQP}/${dataset === "stations" ? "Station" : "Result"}/search`,
          scope,
        );
        const response = await ctx.http.get(url, FILE_LIMIT);
        const type = detectFileType(
          response.body,
          dataset + ".csv",
          String(response.headers["content-type"] ?? ""),
        );
        if (type !== "csv")
          throw new ScrapeError(
            "INVALID_RESPONSE",
            "Portal did not return the requested CSV file.",
          );
        const saved = saveFile(ctx, response.body, "csv");
        const raw = { raw_path: saved.local_path, raw_sha256: saved.sha256 };
        const total = Number(
          response.headers[
            dataset === "stations" ? "total-site-count" : "total-result-count"
          ],
        );
        if (Number.isSafeInteger(total)) result.expected = total;
        const { header, rows } = readCsv(response.body.toString("utf8"));
        if (!header.includes("MonitoringLocationIdentifier"))
          throw new ScrapeError(
            "SCHEMA_CHANGED",
            "Portal file no longer has a monitoring location identifier column.",
          );
        ctx.store.set(key + ":metadata", { fields: header });
        ctx.store.transaction(() =>
          fileDocument(ctx, {
            dataset: "files",
            native: dataset,
            title: `Water Quality Portal ${dataset} for ${ctx.geo.county}, ${ctx.geo.state}`,
            url: response.url,
            saved,
            status: "downloaded",
            fileType: "csv",
            countyMethod: "source_county_query",
            details: { rows_expected: result.expected },
          }),
        );
        const station = (id: unknown) =>
          entityId(ctx.source.id, "stations", String(id));
        const counts = ingestTable(ctx, {
          dataset,
          title: `Water Quality Portal ${dataset}`,
          url: response.url,
          header,
          rows,
          raw,
          kind: dataset === "stations" ? "wells" : "observations",
          scope: "source",
          idField:
            dataset === "stations" ? "MonitoringLocationIdentifier" : undefined,
          sourceFile: saved.local_path,
          map: (entity, v) => {
            // The portal's county filter is checked against its own columns when present.
            if (
              dataset === "stations" &&
              ((v.StateCode && v.StateCode !== ctx.geo.state_fips) ||
                (v.CountyCode && v.CountyCode !== ctx.geo.county_fips))
            )
              return null;
            if (dataset === "stations")
              return {
                ...entity,
                well_name: v.MonitoringLocationName || null,
                source_well_id: v.MonitoringLocationIdentifier,
                well_type: v.MonitoringLocationTypeName || null,
                aquifer: v.AquiferName || null,
                total_depth: {
                  ...parseResult(v["WellDepthMeasure/MeasureValue"] || null),
                  unit: v["WellDepthMeasure/MeasureUnitCode"] || null,
                  raw_unit: v["WellDepthMeasure/MeasureUnitCode"] || null,
                },
                completed_on: v.ConstructionDateText || null,
                quality_flags: ["monitoring_coverage_only"],
              };
            return {
              ...entity,
              entity_kind: "observation",
              observation_id: entity.id,
              record_id: station(v.MonitoringLocationIdentifier),
              source_well_id: v.MonitoringLocationIdentifier,
              parameter: v.CharacteristicName || null,
              result: parseResult(v.ResultMeasureValue || null),
              unit: v["ResultMeasure/MeasureUnitCode"] || null,
              qualifier: v.ResultDetectionConditionText || null,
              observed_at: v.ActivityStartDate || null,
              observed_at_precision: "source_date",
              sample_id: v.ActivityIdentifier || null,
              quality_flags: ["monitoring_coverage_only"],
            };
          },
        });
        ctx.store.set(key + ":done", true);
        result.caveats.push(
          "File is the portal's county-filtered export at download time; the portal provides no immutable snapshot.",
        );
        finish(ctx, result, counts);
      } catch (e) {
        const err = errorInfo(e);
        finish(ctx, result, null, err);
        if (isBudget(err.code)) return;
      }
      if (ctx.signal.aborted) return;
    }
  } finally {
    ctx.http.opts.requestTimeoutMs = previous;
  }
}

// ---------------------------------------------------------------------------
// Catalog files: published data files and bulk layer exports found at run time.
// ---------------------------------------------------------------------------
export interface FileTarget {
  id: string;
  title: string;
  url: string;
  origin: "catalog-file" | "layer-export" | "page-link";
  // Publisher-declared scope helps explain county assignment for unparsed files.
  named: boolean;
  poll?: boolean;
}
const DATA_LINK =
  /\.(csv|xlsx?|zip|geojson|json|kml|kmz|pdf|gdb|gpkg)(\?|#|$)/i;
/** Data-file links on a public page whose link text or address is about wells. */
export function fileLinks(html: string, base: string) {
  const $ = cheerio.load(html);
  const links = new Map<string, string>();
  $("a[href]").each((_, a) => {
    const href = $(a).attr("href") ?? "";
    let url: URL;
    try {
      url = new URL(href, base);
    } catch {
      return;
    }
    if (url.protocol !== "https:" || !DATA_LINK.test(url.pathname)) return;
    const text = $(a).text().replace(/\s+/g, " ").trim();
    if (wellRelevance(text, decodeURIComponent(url.pathname)) > 0)
      links.set(url.toString(), text || url.pathname.split("/").pop()!);
  });
  return [...links].map(([url, title]) => ({ url, title }));
}
async function discoverFiles(ctx: SourceContext) {
  const key = ctx.source.id + ":targets";
  const saved = ctx.store.get<{ targets: FileTarget[]; notes: string[] }>(key);
  if (saved) return saved;
  const targets = new Map<string, FileTarget>();
  const notes: string[] = [];
  const limit = ctx.config.maxTargets;
  // 1. Files published as catalog items.
  const files = (await searchCatalog(ctx, ctx.http, FILE_TYPES)).slice(
    0,
    limit,
  );
  for (const item of files)
    targets.set(item.id, {
      id: item.id,
      title: `${item.title} (${item.type})`,
      url: `${CATALOG}/content/items/${item.id}/data`,
      origin: "catalog-file",
      named: item.named,
    });
  notes.push(`${files.length} catalog file item(s)`);
  // 2. The "Download" export of every well layer the catalog lists.
  const services = (await searchCatalog(ctx, ctx.http, SERVICE_TYPES)).slice(
    0,
    limit,
  );
  let exports = 0;
  for (const item of services) {
    if (!item.url) continue;
    try {
      const layers = await expandService(ctx, ctx.http, item.url, {
        itemId: item.id,
        title: item.title,
        score: item.score,
      });
      for (const layer of layers) {
        const index = layer.url.match(/\/(\d+)$/)?.[1];
        if (index === undefined) continue;
        exports++;
        targets.set(`${item.id}:${index}`, {
          id: `${item.id}:${index}`,
          title: layer.title ?? item.title,
          url: `https://hub.arcgis.com/api/download/v1/items/${item.id}/geojson?layers=${index}`,
          origin: "layer-export",
          named: item.named,
          poll: true,
        });
      }
    } catch (e) {
      const err = errorInfo(e);
      if (isBudget(err.code)) throw e;
      notes.push(`Skipped ${item.title}: ${err.message}`);
    }
  }
  notes.push(
    `${exports} layer export(s) from ${services.length} service item(s)`,
  );
  // 3. Files linked from pages supplied for this run.
  for (const seed of ctx.config.seedUrls) {
    try {
      const page = await ctx.http.get(seed, 5 * 1024 ** 2);
      for (const link of fileLinks(page.body.toString("utf8"), seed))
        targets.set(link.url, {
          id: hash(link.url).slice(0, 16),
          title: link.title,
          url: link.url,
          origin: "page-link",
          named: false,
        });
    } catch (e) {
      const err = errorInfo(e);
      if (isBudget(err.code)) throw e;
      notes.push(`Seed page ${seed}: ${err.message}`);
    }
  }
  const result = { targets: [...targets.values()], notes };
  ctx.store.set(key, result);
  return result;
}
/** Hub prepares exports asynchronously: wait while it answers "not ready yet". */
async function download(
  ctx: SourceContext,
  target: FileTarget,
  fetcher: Fetcher,
) {
  for (let attempt = 0; ; attempt++) {
    const response = await fetcher.get(target.url, FILE_LIMIT);
    const type = detectFileType(
      response.body,
      new URL(response.url).pathname,
      String(response.headers["content-type"] ?? ""),
    );
    // A short JSON status note instead of the file means the export is still being built.
    const note =
      target.poll && type === "json" && response.body.length < 4096
        ? response.body.toString().match(/"status"\s*:\s*"([^"]+)"/)?.[1]
        : undefined;
    if (note && /fail|error/i.test(note))
      throw new ScrapeError(
        "EXPORT_FAILED",
        "Publisher could not prepare the export for this layer.",
      );
    const pending = !!note;
    if (!pending) return { response, type };
    if (attempt >= 20)
      throw new ScrapeError(
        "EXPORT_TIMEOUT",
        "Publisher did not finish preparing the export; resume to retry.",
      );
    await ctx.http.wait(6000);
  }
}
/**
 * Download one discovered file, keep its original bytes, and turn CSV or
 * GeoJSON rows into records. Returns false when a budget stopped the attempt.
 */
export async function collectFileTarget(
  ctx: SourceContext,
  target: FileTarget,
  fetcher: Fetcher = ctx.http,
) {
  const dataset = "file:" + target.id;
  const key = ctx.source.id + ":" + dataset;
  if (ctx.store.get<boolean>(key + ":done")) return true;
  const result = emptyResult(ctx.source.id, dataset);
  result.caveats.push(`${target.title} — ${target.origin}`);
  try {
    checkRecordBudget(ctx);
    const { response, type } = await download(ctx, target, fetcher);
    if (type === "html")
      throw new ScrapeError(
        "INVALID_DOCUMENT",
        "Expected a data file; received a web page or login form.",
      );
    const saved = saveFile(ctx, response.body, type);
    const parsed =
      type === "csv"
        ? readCsv(response.body.toString("utf8"))
        : type === "geojson"
          ? readGeoJson(response.body.toString("utf8"))
          : null;
    ctx.store.transaction(() =>
      fileDocument(ctx, {
        dataset: "files",
        native: target.id,
        title: target.title,
        url: target.url,
        saved,
        status: "downloaded",
        fileType: type,
        countyMethod: target.named
          ? "publisher_names_county"
          : "discovered_for_county_search",
        details: { discovered_as: target.origin },
        flags: parsed ? [] : ["tabular_content_not_parsed"],
      }),
    );
    ctx.records++;
    let counts: TableCounts = {
      rows: 0,
      accepted: 0,
      excluded: 0,
      kind: "wells",
    };
    if (parsed) {
      ctx.store.set(key + ":metadata", { fields: parsed.header });
      counts = ingestTable(ctx, {
        dataset,
        title: target.title,
        url: target.url,
        header: parsed.header,
        rows: parsed.rows,
        raw: { raw_path: saved.local_path, raw_sha256: saved.sha256 },
        scope: "rows",
        sourceFile: saved.local_path,
      });
      if (counts.excluded)
        result.caveats.push(
          `${counts.excluded} row(s) could not be placed in the county (no matching county column or coordinates inside the boundary) and remain in the original file only.`,
        );
    } else
      result.caveats.push(
        `Kept as an original .${type} file; its rows are not parsed into records.`,
      );
    ctx.store.set(key + ":done", true);
    finish(ctx, result, counts);
  } catch (e) {
    const err = errorInfo(e);
    finish(ctx, result, null, err);
    if (isBudget(err.code)) return false;
  }
  return !ctx.signal.aborted;
}
export async function collectCatalogFiles(ctx: SourceContext) {
  let found;
  try {
    found = await discoverFiles(ctx);
    discoveryResult(ctx, {
      found: found.targets.length,
      selected: found.targets.length,
      caveats: [
        `Found for ${ctx.geo.county}, ${ctx.geo.state}: ${found.notes.join("; ")}.`,
        "Only files the publisher lists in a public catalog, or links from pages supplied for the run, can be found.",
      ],
    });
  } catch (e) {
    const err = errorInfo(e);
    discoveryResult(ctx, { failed: true, errors: [err] });
    if (isBudget(err.code)) throw e;
    return;
  }
  for (const target of found.targets)
    if (!(await collectFileTarget(ctx, target))) return;
}
