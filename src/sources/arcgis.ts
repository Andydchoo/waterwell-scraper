import {
  emptyResult,
  errorInfo,
  ScrapeError,
  type Entity,
  type EntityKind,
} from "../core/types.js";
import { hash } from "../core/util.js";
import { query } from "../transports/http.js";
import {
  normalizeRecord,
  observations,
  coordinates,
  classify,
  mapFields,
  type ArcFeature,
  type FieldInfo,
} from "../data/normalize.js";
import { inBoundary } from "../geography/boundary.js";
import {
  checkRecordBudget,
  countyShortName,
  type Fetcher,
  type SourceContext,
} from "./context.js";
/**
 * One queryable ArcGIS REST layer or table. Layers are never listed in source
 * code: they are discovered at run time (see discovery.ts) or sniffed from a
 * page the browser visited.
 */
export interface Layer {
  id: string;
  url: string;
  title?: string;
  where?: string;
  countyField?: string;
  kind?: EntityKind;
  map?: (entity: Entity, feature: ArcFeature) => Entity;
}
interface Metadata {
  name?: string;
  type?: string;
  geometryType?: string;
  capabilities?: string;
  fields: FieldInfo[];
  objectIdField?: string;
  maxRecordCount: number;
  spatialReference?: { wkid: number; latestWkid?: number };
  extent?: { spatialReference: { wkid: number; latestWkid?: number } };
  hasAttachments?: boolean;
  relationships?: unknown[];
}
const sqlText = (value: string) => value.toUpperCase().replaceAll("'", "''");
export async function collectArcgis(
  ctx: SourceContext,
  selectedLayers: Layer[],
  fetcher: Fetcher = ctx.http,
) {
  const county = countyShortName(ctx.geo);
  for (const layer of selectedLayers) {
    const result = emptyResult(ctx.source.id, layer.id);
    const key = ctx.source.id + ":" + layer.id;
    try {
      ctx.http.check();
      const meta = await fetcher.json<Metadata>(
        query(layer.url, { f: "json" }),
      );
      if (
        meta.type !== "Table" &&
        meta.geometryType &&
        meta.geometryType !== "esriGeometryPoint"
      ) {
        // Wells are published as points; area and line layers are not harvested.
        ctx.logger.log("layer.skipped", {
          source_id: ctx.source.id,
          dataset_id: layer.id,
          reason: meta.geometryType,
        });
        continue;
      }
      if (
        !ctx.store.get<string>(key + ":schema") &&
        (!meta.fields?.length ||
          (typeof meta.capabilities === "string" &&
            !/\bQuery\b/i.test(meta.capabilities)))
      ) {
        // Tile and image layers have no rows to read.
        ctx.logger.log("layer.skipped", {
          source_id: ctx.source.id,
          dataset_id: layer.id,
          reason: "not a queryable feature layer",
        });
        continue;
      }
      const oid =
        meta.objectIdField ??
        meta.fields?.find((f) => f.type === "esriFieldTypeOID")?.name;
      if (!oid || !meta.fields?.length || !meta.maxRecordCount)
        throw new ScrapeError(
          "SCHEMA_CHANGED",
          "Layer identity or field dictionary is missing.",
        );
      const reference = meta.spatialReference ??
        meta.extent?.spatialReference ?? { wkid: 0 };
      // Tables have no geometry; only map layers must state their coordinate system.
      if (!reference.wkid && meta.type !== "Table")
        throw new ScrapeError(
          "SCHEMA_CHANGED",
          "Layer coordinate reference missing.",
        );
      const fingerprint = hash(
        JSON.stringify({
          oid,
          crs: reference,
          fields: meta.fields.map((f) => [f.name, f.type]),
        }),
      );
      const old = ctx.store.get<string>(key + ":schema");
      if (old && old !== fingerprint)
        throw new ScrapeError(
          "SCHEMA_CHANGED",
          "Source schema changed since checkpoint. Start a new run.",
        );
      ctx.store.set(key + ":schema", fingerprint);
      ctx.store.set(key + ":metadata", meta);
      ctx.store.raw(ctx.source.id, meta);
      const fieldMap = mapFields(meta.fields);
      // County scope, decided from what the layer publishes: an explicit county
      // column when configured or when the layer has no geometry, otherwise the
      // county boundary fetched for this run.
      const countyField =
        layer.countyField ??
        (meta.type === "Table" ? fieldMap.county_name : undefined);
      if (!countyField && !ctx.boundary)
        throw new ScrapeError(
          "BOUNDARY_UNAVAILABLE",
          "County boundary was not available, so layer records cannot be assigned to the county.",
        );
      if (!countyField && meta.type === "Table")
        throw new ScrapeError(
          "COUNTY_SCOPE_UNKNOWN",
          "Table has no geometry or county column; it cannot be limited to the county.",
        );
      const scope: Record<string, string | number | boolean> = countyField
        ? {
            where:
              layer.where ??
              `UPPER(${countyField}) IN ('${sqlText(county)}','${sqlText(ctx.geo.county)}')`,
          }
        : {
            where: layer.where ?? "1=1",
            geometry: ctx.boundary!.bbox.join(","),
            geometryType: "esriGeometryEnvelope",
            inSR: 4326,
            spatialRel: "esriSpatialRelIntersects",
          };
      const kind =
        layer.kind ??
        classify(
          `${layer.title ?? ""} ${meta.name ?? ""} ${layer.id}`,
          meta.fields,
        );
      let ids = ctx.store.get<number[]>(key + ":ids");
      if (!ids) {
        const response = await fetcher.json<{
          objectIds: number[] | null;
          exceededTransferLimit?: boolean;
        }>(
          query(layer.url + "/query", {
            f: "json",
            ...scope,
            returnIdsOnly: true,
          }),
        );
        // ArcGIS reports "no matching rows" as null rather than an empty list.
        if (response.objectIds === null) response.objectIds = [];
        if (
          !Array.isArray(response.objectIds) ||
          response.exceededTransferLimit ||
          response.objectIds.some((n) => !Number.isSafeInteger(n))
        )
          throw new ScrapeError(
            "ENUMERATION_FAILED",
            "Source did not provide a complete valid object-ID list.",
          );
        ids = [...new Set(response.objectIds)].sort((a, b) => a - b);
        ctx.store.set(key + ":ids", ids);
        ctx.store.raw(ctx.source.id, response);
      }
      result.expected = ids.length;
      const missing = ids.filter(
        (id) => !ctx.store.done(ctx.source.id, layer.id, String(id)),
      );
      const batchSize = Math.min(ctx.config.batchSize, meta.maxRecordCount);
      for (let offset = 0; offset < missing.length; offset += batchSize) {
        checkRecordBudget(ctx);
        const batch = missing.slice(
          offset,
          offset + Math.min(batchSize, ctx.config.maxRecords - ctx.records),
        );
        const response = await fetcher.formJson<{
          features: ArcFeature[];
          exceededTransferLimit?: boolean;
        }>(layer.url + "/query", {
          f: "json",
          objectIds: batch.join(","),
          outFields: "*",
          returnGeometry: true,
          // The server reprojects, so no state-specific projections are needed here.
          outSR: 4326,
        });
        if (!Array.isArray(response.features) || response.exceededTransferLimit)
          throw new ScrapeError(
            "TRUNCATED",
            "Feature batch was invalid or truncated.",
          );
        const found = response.features.map((f) => Number(f.attributes?.[oid]));
        if (
          found.length !== batch.length ||
          new Set(found).size !== found.length ||
          found.some((id) => !batch.includes(id))
        )
          throw new ScrapeError(
            "MISSING_IDS",
            "Feature batch did not exactly match the requested object IDs.",
          );
        const raw = ctx.store.raw(ctx.source.id, response);
        const crs = reference.latestWkid ?? reference.wkid;
        ctx.store.transaction(() => {
          for (const feature of response.features) {
            const id = String(feature.attributes[oid]);
            const point = coordinates(feature);
            const sourceCounty = countyField
              ? String(feature.attributes[countyField] ?? "")
                  .trim()
                  .toLowerCase()
              : null;
            const confirmed = countyField
              ? sourceCounty === county.toLowerCase() ||
                sourceCounty === ctx.geo.county.toLowerCase()
              : !!point && inBoundary(ctx.boundary!, point);
            if (!confirmed && !countyField && point) {
              // The query asks for the county's bounding box, so points beyond
              // the county line are expected and simply left out.
              ctx.store.task(ctx.source.id, layer.id, id, "excluded");
              continue;
            }
            if (!confirmed) {
              ctx.store.task(ctx.source.id, layer.id, id, "quarantined");
              ctx.store.issue({
                source_id: ctx.source.id,
                dataset_id: layer.id,
                native_id: id,
                code:
                  countyField || point ? "COUNTY_CONFLICT" : "UNKNOWN_LOCATION",
                reason: countyField
                  ? "Source county column does not name the requested county."
                  : "County membership cannot be confirmed from source coordinates.",
                ...raw,
              });
              continue;
            }
            let record = normalizeRecord(feature.attributes, {
              source: ctx.source.id,
              dataset: layer.id,
              native: id,
              kind,
              approach: ctx.source.approach,
              geo: ctx.geo,
              url: layer.url,
              ...raw,
              runId: ctx.runId,
              fields: meta.fields,
              fieldMap,
              point,
              geometry: feature.geometry ?? null,
              crs: crs || null,
              countyMethod: countyField
                ? "explicit_source_county"
                : "point_in_county_boundary",
              identityMethod: "dataset_object_id",
              adapterVersion: ctx.source.version,
            });
            record.geometry_transform =
              crs === 4326 || !crs
                ? "none"
                : `reprojected by the source service from EPSG:${crs} to EPSG:4326`;
            if (layer.title) record.dataset_title = layer.title;
            if (layer.map) record = layer.map(record, feature);
            ctx.store.put(kind, record);
            if (kind !== "observations")
              for (const observation of observations(record))
                ctx.store.put("observations", observation);
            ctx.store.task(ctx.source.id, layer.id, id, "accepted");
          }
        });
        ctx.records += response.features.length;
        ctx.logger.log("batch.committed", {
          source_id: ctx.source.id,
          dataset_id: layer.id,
          count: response.features.length,
        });
        if (batch.length < Math.min(batchSize, missing.length - offset))
          throw new ScrapeError(
            "BUDGET_RECORDS",
            "Record budget reached; resume to continue.",
          );
      }
      const current = await fetcher.json<{ objectIds: number[] | null }>(
        query(layer.url + "/query", {
          f: "json",
          ...scope,
          returnIdsOnly: true,
        }),
      );
      if (current.objectIds === null) current.objectIds = [];
      if (
        !Array.isArray(current.objectIds) ||
        hash(
          JSON.stringify([...new Set(current.objectIds)].sort((a, b) => a - b)),
        ) !== hash(JSON.stringify(ids))
      )
        result.caveats.push("Source ID set changed during collection.");
      // ArcGIS exposes no historical snapshot here: equal ID sets cannot prove unchanged attributes.
      result.caveats.push(
        "ID enumeration reconciled; source provides no immutable attribute snapshot.",
      );
      if (meta.hasAttachments || meta.relationships?.length)
        result.caveats.push(
          "Layer also publishes attachments or related tables; those are not collected by this layer query.",
        );
      result.status = "success";
      result.completeness = "unverified";
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
    const counts = ctx.store.taskCounts(ctx.source.id, layer.id);
    for (const row of counts) {
      result.fetched += Number(row.n);
      if (row.status === "accepted") result.accepted += Number(row.n);
      if (row.status === "quarantined") result.quarantined += Number(row.n);
      if (row.status === "excluded") result.excluded += Number(row.n);
    }
    result.unresolved =
      result.expected === null
        ? null
        : Math.max(0, result.expected - result.fetched);
    if (
      result.quarantined ||
      result.errors.length ||
      result.unresolved ||
      result.caveats.some((c) => c.includes("changed"))
    ) {
      result.status = result.accepted
        ? "partial"
        : result.status === "success"
          ? "failed"
          : result.status;
      result.completeness = "incomplete";
    }
    ctx.store.result(result);
    ctx.logger.log("source.finished", {
      source_id: ctx.source.id,
      dataset_id: layer.id,
      status: result.status,
      accepted: result.accepted,
      quarantined: result.quarantined,
    });
    if (
      ctx.signal.aborted ||
      result.errors.some((e) => e.code.startsWith("BUDGET"))
    )
      break;
  }
}
