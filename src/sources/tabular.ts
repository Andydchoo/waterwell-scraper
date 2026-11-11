import { join } from "node:path";
import { entityId, type Entity, type EntityKind } from "../core/types.js";
import { atomicWrite, hash, now } from "../core/util.js";
import {
  classify,
  mapFields,
  normalizeRecord,
  observations,
  type FieldInfo,
} from "../data/normalize.js";
import { inBoundary } from "../geography/boundary.js";
import {
  checkRecordBudget,
  countyShortName,
  type SourceContext,
} from "./context.js";

/** RFC 4180 reader: quoted fields, doubled quotes, embedded line breaks, optional BOM. */
export function* csvRows(text: string): Generator<string[]> {
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  let row: string[] = [];
  let field = "";
  while (i < n) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      for (;;) {
        const end = text.indexOf('"', i);
        if (end < 0) {
          field += text.slice(i);
          i = n;
          break;
        }
        field += text.slice(i, end);
        if (text[end + 1] === '"') {
          field += '"';
          i = end + 2;
        } else {
          i = end + 1;
          break;
        }
      }
    } else if (c === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") yield row;
      row = [];
    } else {
      let end = i;
      while (end < n && !',\n\r"'.includes(text[end]!)) end++;
      field += text.slice(i, end);
      i = end;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    yield row;
  }
}
const EXTENSIONS: [RegExp, string][] = [
  [/^%PDF-/, "pdf"],
  [/^PK\x03\x04/, "zip"],
  [/^\x89PNG/, "png"],
  [/^\xff\xd8/, "jpg"],
  [/^(II\*\0|MM\0\*)/, "tiff"],
];
const KNOWN = [
  "csv",
  "json",
  "geojson",
  "zip",
  "xlsx",
  "xls",
  "pdf",
  "kml",
  "kmz",
  "txt",
  "gdb",
  "gpkg",
  "png",
  "jpg",
  "tiff",
  "xml",
];
/** Decide a stored file's type from its bytes first, then its name and content type. */
export function detectFileType(body: Buffer, name = "", contentType = "") {
  const head = body.subarray(0, 8).toString("latin1");
  for (const [magic, ext] of EXTENSIONS)
    if (magic.test(head)) {
      if (ext === "zip") {
        const hinted = name.toLowerCase().match(/\.(xlsx|kmz|gpkg)(\?|$)/)?.[1];
        return hinted ?? "zip";
      }
      return ext;
    }
  const text = body.subarray(0, 2048).toString("utf8").trimStart();
  if (/^<!doctype html|^<html/i.test(text)) return "html";
  if (text.startsWith("{") || text.startsWith("["))
    return /"FeatureCollection"/.test(body.subarray(0, 4096).toString())
      ? "geojson"
      : "json";
  if (/^<\?xml|^<kml/i.test(text)) return /<kml/i.test(text) ? "kml" : "xml";
  const ext = name.toLowerCase().match(/\.([a-z0-9]{2,7})(\?|#|$)/)?.[1];
  if (ext && KNOWN.includes(ext)) return ext;
  if (/csv/i.test(contentType)) return "csv";
  // Delimited text: a header line with several commas and no control bytes.
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (firstLine.split(",").length >= 3 && !/[\x00-\x08]/.test(text))
    return "csv";
  return "bin";
}
/** Keep the original bytes of a downloaded file under attachments/, named by content hash. */
export function saveFile(ctx: SourceContext, body: Buffer, extension: string) {
  const digest = hash(body);
  const local = `attachments/${digest}.${extension}`;
  atomicWrite(join(ctx.store.dir, local), body);
  return { local_path: local, sha256: digest, byte_count: body.length };
}
/** Record a downloaded (or failed) file as a document row. */
export function fileDocument(
  ctx: SourceContext,
  file: {
    dataset: string;
    native: string;
    title: string;
    url: string;
    saved?: { local_path: string; sha256: string; byte_count: number };
    status: string;
    fileType?: string;
    details?: Record<string, unknown>;
    countyMethod: string;
    flags?: string[];
  },
): Entity {
  const id = entityId(ctx.source.id, file.dataset, file.native);
  const raw = ctx.store.raw(ctx.source.id, {
    title: file.title,
    url: file.url,
    ...file.details,
  });
  const entity: Entity = {
    id,
    document_id: id,
    record_id: null,
    native_id: file.native,
    source_id: ctx.source.id,
    dataset_id: file.dataset,
    acquisition_method: ctx.source.approach,
    entity_kind: "document",
    county_geoid: ctx.geo.county_geoid,
    county_assignment_method: file.countyMethod,
    identity_method: "source_url",
    title: file.title,
    file_type: file.fileType ?? null,
    download_status: file.status,
    local_path: file.saved?.local_path ?? null,
    sha256: file.saved?.sha256 ?? null,
    byte_count: file.saved?.byte_count ?? null,
    source_url: file.url,
    retrieved_at: now(),
    ...raw,
    source_fields: { title: file.title, url: file.url, ...file.details },
    quality_flags: ["report_text_not_extracted", ...(file.flags ?? [])],
    run_id: ctx.runId,
    schema_version: "1.0.0",
  };
  ctx.store.put("documents", entity);
  return entity;
}
export interface TableInput {
  dataset: string;
  title: string;
  url: string;
  header: string[];
  rows: Iterable<{ values: Record<string, unknown>; point?: number[] | null }>;
  raw: { raw_path: string; raw_sha256: string };
  kind?: EntityKind;
  // "source" when the publisher already limited the file to the county.
  scope: "source" | "rows";
  // How a source-scoped table is tied to the county, recorded on each row.
  scopeMethod?: string;
  idField?: string;
  sourceFile?: string | null;
  map?: (entity: Entity, values: Record<string, unknown>) => Entity | null;
}
export interface TableCounts {
  rows: number;
  accepted: number;
  excluded: number;
  kind: EntityKind;
}
/**
 * Turn rows of any table (CSV, GeoJSON properties, an HTML table) into records.
 * A row is kept only when it can be tied to the county: by a county column, by
 * coordinates inside the county boundary, or because the publisher's query was
 * already county-scoped.
 */
export function ingestTable(
  ctx: SourceContext,
  table: TableInput,
): TableCounts {
  const fields: FieldInfo[] = table.header.map((name) => ({ name }));
  const fieldMap = mapFields(fields);
  const kind = table.kind ?? classify(table.title, fields);
  const short = countyShortName(ctx.geo).toLowerCase(),
    long = ctx.geo.county.toLowerCase();
  const counts: TableCounts = { rows: 0, accepted: 0, excluded: 0, kind };
  let pending: (() => void)[] = [];
  const flush = () => {
    const work = pending;
    pending = [];
    if (work.length) ctx.store.transaction(() => work.forEach((w) => w()));
  };
  for (const row of table.rows) {
    counts.rows++;
    if (counts.rows % 500 === 0) {
      flush();
      checkRecordBudget(ctx);
    }
    const values = row.values;
    let point = row.point ?? null;
    if (!point && fieldMap.longitude && fieldMap.latitude) {
      const x = Number(values[fieldMap.longitude]),
        y = Number(values[fieldMap.latitude]);
      if (
        values[fieldMap.longitude] !== "" &&
        values[fieldMap.latitude] !== "" &&
        Number.isFinite(x) &&
        Number.isFinite(y) &&
        Math.abs(x) <= 180 &&
        Math.abs(y) <= 90
      )
        point = [x, y];
    }
    const named = fieldMap.county_name
      ? String(values[fieldMap.county_name] ?? "")
          .trim()
          .toLowerCase()
      : null;
    let method: string | null = null;
    if (named)
      method =
        named === short || named === long ? "explicit_source_county" : null;
    else if (point && ctx.boundary)
      method = inBoundary(ctx.boundary, point)
        ? "point_in_county_boundary"
        : null;
    // A county-scoped source is trusted over a coordinate that falls outside the line.
    if (table.scope === "source" && !method && !named)
      method = table.scopeMethod ?? "source_county_query";
    const native =
      (table.idField && String(values[table.idField] ?? "")) ||
      hash(JSON.stringify(values)).slice(0, 20);
    if (!method) {
      counts.excluded++;
      pending.push(() =>
        ctx.store.task(ctx.source.id, table.dataset, native, "excluded"),
      );
      continue;
    }
    let entity: Entity | null = normalizeRecord(values, {
      source: ctx.source.id,
      dataset: table.dataset,
      native,
      kind,
      approach: ctx.source.approach,
      geo: ctx.geo,
      url: table.url,
      ...table.raw,
      runId: ctx.runId,
      fields,
      fieldMap,
      point,
      crs: point ? 4326 : null,
      countyMethod: method,
      identityMethod: table.idField ? "source_identifier" : "row_content_hash",
      adapterVersion: ctx.source.version,
    });
    entity.dataset_title = table.title;
    entity.source_file = table.sourceFile ?? null;
    if (table.map) entity = table.map(entity, values);
    if (!entity) {
      counts.excluded++;
      continue;
    }
    const saved = entity;
    counts.accepted++;
    ctx.records++;
    pending.push(() => {
      ctx.store.put(kind, saved);
      if (kind !== "observations")
        for (const o of observations(saved)) ctx.store.put("observations", o);
      ctx.store.task(ctx.source.id, table.dataset, native, "accepted");
    });
  }
  flush();
  return counts;
}
export function* csvTable(text: string) {
  const rows = csvRows(text);
  const first = rows.next();
  if (first.done) return;
  const header = first.value.map((h) => h.trim());
  yield header;
  for (const row of rows)
    yield Object.fromEntries(header.map((h, i) => [h, row[i] ?? ""]));
}
/** Split CSV text into its header and a lazy row stream. */
export function readCsv(text: string) {
  const it = csvTable(text);
  const head = it.next();
  const header = head.done ? [] : (head.value as string[]);
  const rows = (function* () {
    for (const values of it)
      yield { values: values as Record<string, unknown> };
  })();
  return { header, rows };
}
export function readGeoJson(text: string) {
  const data = JSON.parse(text) as {
    features?: {
      properties?: Record<string, unknown> | null;
      geometry?: { type: string; coordinates: unknown } | null;
    }[];
  };
  const features = Array.isArray(data.features) ? data.features : [];
  const header = [
    ...new Set(
      features.slice(0, 200).flatMap((f) => Object.keys(f.properties ?? {})),
    ),
  ];
  const rows = (function* () {
    for (const f of features) {
      const c =
        f.geometry?.type === "Point"
          ? (f.geometry.coordinates as number[])
          : null;
      yield {
        values: f.properties ?? {},
        point:
          c && typeof c[0] === "number" && typeof c[1] === "number"
            ? [c[0], c[1]]
            : null,
      };
    }
  })();
  return { header, rows };
}
