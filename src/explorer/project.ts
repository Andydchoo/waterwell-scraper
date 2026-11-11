import type { Entity } from "../core/types.js";
import { fold, type Kind, type Projection, type DateValue } from "./types.js";
const text = (v: unknown): string | null =>
  typeof v === "string"
    ? v
    : typeof v === "number" && Number.isFinite(v)
      ? String(v)
      : null;
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
export function parseDate(
  raw: unknown,
  meaning: DateValue["meaning"],
  path: string,
  epoch = false,
  usDate = false,
): DateValue | null {
  let s = text(raw)?.trim();
  if (!s) return null;
  if (epoch && typeof raw === "number") {
    const d = new Date(raw);
    if (!Number.isFinite(d.getTime())) return null;
    s = d.toISOString().slice(0, 10);
  }
  if (usDate && /^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [m, d, y] = s.split("/");
    s = `${y}-${m!.padStart(2, "0")}-${d!.padStart(2, "0")}`;
  }
  if (/^\d{8}$/.test(s))
    s = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}`
      .replace(/-00-00$/, "")
      .replace(/-00$/, "");
  let start: string, end: string, precision: string;
  if (/^\d{4}$/.test(s) && +s > 0) {
    start = s + "-01-01";
    end = s + "-12-31";
    precision = "year";
  } else if (/^\d{4}-(0[1-9]|1[0-2])$/.test(s) && +s.slice(0, 4) > 0) {
    start = s + "-01";
    const d = new Date(start + "T00:00:00Z");
    d.setUTCMonth(d.getUTCMonth() + 1);
    d.setUTCDate(0);
    end = d.toISOString().slice(0, 10);
    precision = "month";
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s + "T00:00:00Z");
    if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== s)
      return null;
    start = end = s;
    precision = "day";
  } else if (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(s)
  ) {
    const datePart = s.slice(0, 10);
    if (!parseDate(datePart, meaning, path)) return null;
    const d = new Date(s);
    if (!Number.isFinite(d.getTime())) return null;
    start = end = d.toISOString().slice(0, 10);
    precision = "instant (UTC)";
  } else return null;
  return { meaning, start, end, precision, raw, path };
}
export function project(kind: Kind, e: Entity): Projection {
  const source = e.source_id,
    sf = e.source_fields,
    // Indexed values an archive shows beside a document, whichever archive it is.
    hy = obj(sf.display_fields);
  const meta = new Map<string, unknown[]>();
  if (Array.isArray(sf.metadata))
    for (const field of sf.metadata) {
      const f = obj(field);
      if (typeof f.name === "string" && Array.isArray(f.values))
        meta.set(f.name, f.values);
    }
  const lineage: Record<string, string> = {};
  const choose = (name: string, values: [unknown, string][]) => {
    for (const [v, p] of values) {
      const s = text(v);
      if (s !== null && s !== "") {
        lineage[name] = p;
        return s;
      }
    }
    return null;
  };
  const address = choose("address", [
    [e.address, "address"],
    [hy.Address, "source_fields.display_fields.Address"],
    [
      meta.get("Well Location - Street")?.[0],
      "source_fields.metadata[Well Location - Street]",
    ],
  ]);
  const parcel = choose("parcel", [
    [e.parcel_id, "parcel_id"],
    [hy["Parcel Number"], "source_fields.display_fields.Parcel Number"],
  ]);
  const title =
    choose("title", [
      [e.title, "title"],
      [e.well_name, "well_name"],
      [e.source_well_id, "source_well_id"],
      [e.source_station_name, "source_station_name"],
      [e.address, "address"],
      [e.native_id, "native_id"],
    ]) ?? e.id;
  const identifiers: Projection["identifiers"] = [];
  const add = (type: string, v: unknown, path: string) => {
    const s = text(v);
    if (s !== null && s !== "")
      identifiers.push({ type, value: s, normalized: fold(s), path });
  };
  for (const [type, key] of [
    ["native", "native_id"],
    ["well", "source_well_id"],
    ["parcel", "parcel_id"],
    ["file", "file_number"],
    ["application", "application_id"],
    ["facility", "facility_id"],
  ] as const)
    add(type, e[key], key);
  add(
    "parcel",
    hy["Parcel Number"],
    "source_fields.display_fields.Parcel Number",
  );
  add("file", hy["File Number"], "source_fields.display_fields.File Number");
  for (const value of meta.get("ID #") ?? [])
    add("native", value, "source_fields.metadata[ID #]");
  const depth = obj(e.total_depth);
  let meters: number | null = null;
  if (
    typeof depth.value === "number" &&
    Number.isFinite(depth.value) &&
    !depth.qualifier &&
    !e.quality_flags.includes("source_units_unverified")
  ) {
    if (depth.unit === "m") meters = depth.value;
    else if (depth.unit === "ft") meters = depth.value * 0.3048;
  }
  const rawDepth =
    depth.raw_value ?? depth.value ?? meta.get("Total Depth")?.[0];
  const depthLabel =
    rawDepth === null || rawDepth === undefined
      ? null
      : meters !== null
        ? `${meters} m`
        : `${String(rawDepth)} (unit/value unverified)`;
  const dates: DateValue[] = [];
  const date = (
    v: unknown,
    m: DateValue["meaning"],
    p: string,
    epoch = false,
    us = false,
  ) => {
    const d = parseDate(v, m, p, epoch, us);
    if (d) dates.push(d);
  };
  if (kind === "observations")
    // Map services publish dates as epoch milliseconds; text dates are parsed as written.
    date(
      e.observed_at,
      "observation",
      "observed_at",
      typeof e.observed_at === "number",
    );
  const mapped = obj(e.field_map);
  for (const [field, meaning] of [
    ["completed_on", "completion"],
    ["permitted_on", "permit"],
  ] as const)
    date(
      e[field],
      meaning,
      typeof mapped[field] === "string"
        ? `source_fields.${mapped[field]}`
        : field,
      typeof e[field] === "number",
    );
  if (source === "usgs-groundwater" && kind === "wells")
    date(sf.construction_date, "completion", "source_fields.construction_date");
  for (const [name, meaning] of [
    ["Date Well Completed", "completion"],
    ["Document Date", "document"],
  ] as const)
    for (const v of meta.get(name) ?? [])
      date(v, meaning, `source_fields.metadata[${name}]`, false, true);
  const result = obj(e.result);
  const summary: Projection["summary"] = {
    kind,
    id: e.id,
    source,
    dataset: e.dataset_id,
    native: e.native_id,
    title,
    address,
    parcel,
    well: text(e.source_well_id),
    file: identifiers.find((i) => i.type === "file")?.value ?? null,
    status: text(e.well_status),
    use: text(e.well_use),
    depth: meters,
    depthLabel,
    dateLabel: dates[0]
      ? `${text(dates[0].raw)} · ${dates[0].meaning} (${dates[0].precision})`
      : null,
    download: text(e.download_status),
    flags: e.quality_flags,
    parameter: text(e.parameter),
    result: text(result.raw_value ?? result.value),
    unit: text(e.unit),
    reports: 0,
    downloadedReports: 0,
  };
  const search = fold(
    [
      e.id,
      title,
      address,
      parcel,
      e.well_name,
      e.source_station_name,
      hy["Document Type"],
      ...(meta.get("Well Location - City") ?? []),
      ...identifiers.map((i) => i.value),
    ]
      .filter((x) => x !== null && x !== undefined)
      .join("\n"),
  );
  return { summary, search, identifiers, dates, lineage };
}
