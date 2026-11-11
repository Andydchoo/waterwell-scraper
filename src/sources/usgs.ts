import {
  emptyResult,
  entityId,
  errorInfo,
  ScrapeError,
  type Entity,
} from "../core/types.js";
import { now, hash } from "../core/util.js";
import { query } from "../transports/http.js";
import { parseResult } from "../data/normalize.js";
import { checkRecordBudget, type SourceContext } from "./context.js";
interface Page {
  features: {
    id: string;
    properties: Record<string, unknown>;
    geometry: { type: string; coordinates: number[] } | null;
  }[];
  links: { rel: string; href: string }[];
  numberMatched?: number;
  numberReturned?: number;
}
export async function collectUsgs(ctx: SourceContext) {
  for (const dataset of ["monitoring-locations", "field-measurements"]) {
    const result = emptyResult(ctx.source.id, dataset),
      key = ctx.source.id + ":" + dataset;
    try {
      const base = `https://api.waterdata.usgs.gov/ogcapi/${dataset === "monitoring-locations" ? "v1" : "v0"}/collections/${dataset}`;
      const schema = await ctx.http.json(base + "/queryables?f=json");
      const fingerprint = hash(JSON.stringify(schema));
      const prior = ctx.store.get<string>(key + ":schema");
      if (prior && prior !== fingerprint)
        throw new ScrapeError(
          "SCHEMA_CHANGED",
          "USGS query schema changed since checkpoint. Start a new run.",
        );
      ctx.store.set(key + ":schema", fingerprint);
      ctx.store.set(key + ":metadata", schema);
      ctx.store.raw(ctx.source.id, schema);
      let next = ctx.store.get<string | null>(key + ":next");
      if (next === undefined)
        next = query(base + "/items", {
          f: "json",
          state_code: ctx.geo.state_fips,
          county_code: ctx.geo.county_fips,
          site_type_code: "GW",
          limit: Math.min(1000, ctx.config.batchSize),
        });
      const cursors = new Set<string>();
      while (next) {
        checkRecordBudget(ctx);
        if (cursors.has(next))
          throw new ScrapeError(
            "PAGINATION_LOOP",
            "USGS repeated a page cursor.",
          );
        cursors.add(next);
        const page: Page = await ctx.http.json<Page>(next);
        if (!Array.isArray(page.features) || !Array.isArray(page.links))
          throw new ScrapeError(
            "SCHEMA_CHANGED",
            "USGS feature response changed.",
          );
        if (page.numberMatched !== undefined)
          ctx.store.set(key + ":expected", page.numberMatched);
        const raw = ctx.store.raw(ctx.source.id, page);
        const url = next;
        for (const f of page.features) {
          if (!f.id || !f.properties)
            throw new ScrapeError(
              "SCHEMA_CHANGED",
              "USGS record identity is missing.",
            );
          if (ctx.store.done(ctx.source.id, dataset, f.id)) continue;
          checkRecordBudget(ctx);
          const p = f.properties;
          if (
            dataset === "monitoring-locations" &&
            (p.state_code !== ctx.geo.state_fips ||
              p.county_code !== ctx.geo.county_fips ||
              p.site_type_code !== "GW")
          )
            throw new ScrapeError(
              "COUNTY_CONFLICT",
              "USGS did not honor the county/type filter.",
            );
          const id = entityId(ctx.source.id, dataset, f.id);
          const recordId =
            dataset === "monitoring-locations"
              ? id
              : typeof p.monitoring_location_id === "string"
                ? entityId(
                    ctx.source.id,
                    "monitoring-locations",
                    p.monitoring_location_id,
                  )
                : null;
          const e: Entity = {
            id,
            native_id: f.id,
            source_id: ctx.source.id,
            dataset_id: dataset,
            county_geoid: ctx.geo.county_geoid,
            state_fips: ctx.geo.state_fips,
            county_fips: ctx.geo.county_fips,
            acquisition_method: ctx.source.approach,
            county_assignment_method: "source_county_query",
            source_url: url,
            retrieved_at: now(),
            ...raw,
            source_fields: p,
            quality_flags: ["monitoring_coverage_only"],
            record_id: recordId,
            run_id: ctx.runId,
            schema_version: "1.0.0",
            longitude: f.geometry?.coordinates[0] ?? null,
            latitude: f.geometry?.coordinates[1] ?? null,
            original_geometry: f.geometry,
            original_crs: 4326,
          };
          if (dataset === "monitoring-locations")
            Object.assign(e, {
              entity_kind: "well",
              identity_method: "agency_location_id",
              well_name: p.monitoring_location_name,
              total_depth: {
                ...parseResult(p.well_constructed_depth),
                unit: "m",
                value:
                  typeof p.well_constructed_depth === "number"
                    ? p.well_constructed_depth * 0.3048
                    : null,
                raw_unit: "ft",
                conversion: "ft * 0.3048",
              },
              aquifer: p.aquifer_code,
              location_method: p.horizontal_position_method_name,
              coordinate_accuracy: p.horizontal_positional_accuracy,
            });
          else
            Object.assign(e, {
              observation_id: id,
              identity_method: "source_version_uuid",
              observed_at: p.time,
              parameter: p.parameter_code,
              result: parseResult(p.value),
              qualifier: p.qualifier,
              unit: p.unit_of_measure,
              vertical_reference: p.vertical_datum,
              field_visit_id: p.field_visit_id,
            });
          ctx.store.transaction(() => {
            ctx.store.put(
              dataset === "monitoring-locations" ? "wells" : "observations",
              e,
            );
            ctx.store.task(ctx.source.id, dataset, f.id, "accepted");
          });
          ctx.records++;
        }
        next = page.links.find((l) => l.rel === "next")?.href ?? null;
        if (next) {
          const u = new URL(next);
          if (
            u.origin !== "https://api.waterdata.usgs.gov" ||
            !u.pathname.includes("/" + dataset + "/items") ||
            u.searchParams.get("state_code") !== ctx.geo.state_fips ||
            u.searchParams.get("county_code") !== ctx.geo.county_fips ||
            u.searchParams.get("site_type_code") !== "GW"
          )
            throw new ScrapeError(
              "PAGINATION_SCOPE",
              "USGS next link changed the query scope.",
            );
          if (!page.features.length)
            throw new ScrapeError(
              "PAGINATION_LOOP",
              "Empty USGS page has a next cursor.",
            );
        }
        ctx.store.set(key + ":next", next);
        ctx.logger.log("batch.committed", {
          source_id: ctx.source.id,
          dataset_id: dataset,
          count: page.features.length,
        });
      }
      result.status = "success";
      result.completeness = "unverified";
      result.caveats.push(
        "Public monitoring data only; terminal cursor reached but no immutable snapshot is supplied.",
      );
      if (dataset === "field-measurements")
        result.caveats.push(
          "Observation UUIDs identify source versions, not stable readings across separate runs. Daily/continuous series and discrete laboratory samples are not included in this adapter.",
        );
    } catch (e) {
      const err = errorInfo(e);
      result.errors.push(err);
      result.status =
        err.code === "NEEDS_AUTH"
          ? "needs_auth"
          : err.code === "BLOCKED"
            ? "blocked"
            : "failed";
      result.completeness = "incomplete";
    }
    result.expected = ctx.store.get<number>(key + ":expected") ?? null;
    result.fetched = ctx.store
      .taskCounts(ctx.source.id, dataset)
      .reduce((n, r) => n + Number(r.n), 0);
    result.accepted = result.fetched;
    result.unresolved =
      result.expected === null
        ? null
        : Math.max(0, result.expected - result.fetched);
    if (result.unresolved) {
      result.errors.push({
        code: "COUNT_MISMATCH",
        message: "USGS total does not match collected records.",
      });
      result.status = "partial";
      result.completeness = "incomplete";
    }
    if (result.errors.length && result.accepted) result.status = "partial";
    ctx.store.result(result);
    ctx.logger.log("source.finished", {
      source_id: ctx.source.id,
      dataset_id: dataset,
      status: result.status,
      accepted: result.accepted,
    });
    if (
      ctx.signal.aborted ||
      result.errors.some((e) => e.code.startsWith("BUDGET"))
    )
      break;
  }
}
