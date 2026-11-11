import {
  entityId,
  type Approach,
  type Entity,
  type EntityKind,
  type Geography,
} from "../core/types.js";
import { now } from "../core/util.js";

// Everything here is vocabulary about wells in general. Nothing identifies a
// particular state, county, agency or dataset: source fields are matched by
// what their names say at run time, and every match is recorded in field_map.

export interface ArcFeature {
  attributes: Record<string, unknown>;
  geometry?: {
    x?: number;
    y?: number;
    spatialReference?: { wkid?: number; latestWkid?: number };
  } | null;
}
export function first(a: Record<string, unknown>, ...keys: string[]) {
  for (const k of keys)
    if (a[k] !== undefined && a[k] !== null && a[k] !== "") return a[k];
  return null;
}
export function parseResult(raw: unknown) {
  const text = raw === null || raw === undefined ? null : String(raw);
  const m = text
    ?.trim()
    .match(/^([<>]=?)?\s*(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)$/i);
  return {
    value: m && !m[1] ? Number(m[2]) : null,
    raw_value: raw ?? null,
    qualifier: m?.[1] ?? null,
    limit: m?.[1] ? Number(m[2]) : null,
  };
}
const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "");
const present = (v: unknown) => v !== undefined && v !== null && v !== "";

/** Ordered name patterns for each canonical field; the first matching source field wins. */
export const FIELD_PATTERNS: Record<string, RegExp[]> = {
  source_well_id: [
    /^(well|site|station|location|monitoring ?location)[ _-]*(id|identifier|no|num|number|#)[a-z]*$/i,
    /^(id[ _-]?well|well|wellid.*|usgs.?id|site.?no|local.?(well.?)?(id|number))$/i,
    /^monitoringlocationidentifier$/i,
  ],
  well_name: [
    /^(well|site|station|facility|location)[ _-]*name$/i,
    /^monitoringlocationname$/i,
    /^name$/i,
  ],
  address: [
    /^(site|well|street|location|property|physical|full)?[ _-]*(address|addr)[ _-]*(1|line1|full)?$/i,
    /address/i,
  ],
  parcel_id: [/parcel|^pin$|^apn$|tax[ _-]?(id|map|lot|number)/i],
  owner: [/^owner([ _-]*name)?$|owner/i],
  well_use: [/(^|[ _-]|well|water)use(d)?([ _-]?for)?$/i, /purpose/i],
  well_type: [
    /^(well[ _-]*)?(type|class|category)([ _-]*(code|name|desc.*))?$/i,
    /welltype|sitetype/i,
  ],
  well_status: [/status/i],
  facility_id: [/^facility[ _-]*(id|number|no)$/i],
  file_number: [/^file[ _-]*(number|num|no|id)$/i],
  permit_number: [/permit[ _-]*(number|num|no|id|#)?$/i],
  application_id: [
    /application[ _-]*(number|num|no|id)?$|^id[ _-]?application$/i,
  ],
  total_depth: [
    /^(total|well|completed|finished|hole|drill(ed)?)[ _-]*depth/i,
    /^depth[ _-]*(of[ _-]*well|total|ft|feet|m)?[ _-]*(ft|feet|bgs|m)?_*$/i,
    /welldepth/i,
  ],
  casing_depth: [/cas(ing|e)[ _-]*(depth|length)/i],
  casing_diameter: [/(^|[ _-]|casing|well|bore|hole)dia(m|meter)?([ _-]|$)/i],
  yield: [/yield|pump(ing)?[ _-]*rate|capacity|gpm/i],
  static_water_level: [
    /static[ _-]*(water)?[ _-]*(level|lvl)|^swl([ _-]|$)|depth[ _-]*to[ _-]*(gw|water|groundwater)|water[ _-]*level/i,
  ],
  driller: [/driller|contractor|installer|drill(ing)?[ _-]*(co|company|firm)/i],
  aquifer: [/aquifer|(^|[ _-])formation|geolog/i],
  completed_on: [
    /(complet|install|construct|drill)[a-z]*[ _-]*(date|dt|on)|date[ _-]*(complet|install|drill|construct)/i,
  ],
  permitted_on: [
    /(permit|issue|approv)[a-z]*[ _-]*(date|dt|on)|date[ _-]*(permit|issue)/i,
  ],
  county_name: [/^(county|cnty|co)([ _-]*(name|nm))?$/i, /^countyname$/i],
  latitude: [
    /^(lat|latitude|y|dec[ _-]*lat.*|latitudemeasure|lat[ _-]*dd|y[ _-]*coord.*)$/i,
  ],
  longitude: [
    /^(lon|long|lng|longitude|x|dec[ _-]*long.*|longitudemeasure|lon(g)?[ _-]*dd|x[ _-]*coord.*)$/i,
  ],
};
export interface FieldInfo {
  name: string;
  alias?: string;
  type?: string;
}
/** Resolve canonical name → source field name using field names, then aliases. */
export function mapFields(fields: FieldInfo[]): Record<string, string> {
  const map: Record<string, string> = {};
  const used = new Set<string>();
  for (const [canonical, patterns] of Object.entries(FIELD_PATTERNS)) {
    search: for (const pattern of patterns)
      for (const label of ["name", "alias"] as const)
        for (const field of fields) {
          const text = field[label];
          if (!text || used.has(field.name)) continue;
          if (pattern.test(text.trim())) {
            map[canonical] = field.name;
            used.add(field.name);
            break search;
          }
        }
  }
  return map;
}
/** A unit is known only when the source field itself states it. */
export function unitOf(field?: FieldInfo): string | null {
  const text = `${field?.name ?? ""} ${field?.alias ?? ""}`.toLowerCase();
  if (/\b(gpm|gal(lons)?[ /_]*(per)?[ /_]*min)/.test(text.replace(/_/g, " ")))
    return "gal/min";
  if (/(^|[^a-z])(ft|feet|foot)([^a-z]|$)/.test(text.replace(/_/g, " ")))
    return "ft";
  if (/(^|[^a-z])(m|meters?|metres?)([^a-z]|$)/.test(text.replace(/_/g, " ")))
    return "m";
  if (/(^|[^a-z])(in|inch|inches)([^a-z]|$)/.test(text.replace(/_/g, " ")))
    return "in";
  return null;
}
function quantity(raw: unknown, field?: FieldInfo) {
  const unit = raw === null ? null : unitOf(field);
  return { ...parseResult(raw), unit, raw_unit: unit };
}
// "well" alone is also an everyday adverb ("as well as"), so the singular only
// counts next to a word that makes it a water well.
const WELL_WORDS =
  /\bwells\b|^\s*well\s*$|\b(water|private|public|monitoring|domestic|irrigation|supply|drinking|observation|test|drilled|abandoned)[ _-]+well\b|\bwell[ _-]?(logs?|records?|permits?|reports?|construction|completion|inventory|sites?|locations?|points?|data|ids?|depths?|drillers?|sampl\w*|information|owners?|fields?|abandon\w*|registration|program|water|contractors?|numbers?|types?|use|status|yield|seal\w*|drill\w*|test\w*|disclosure|management|inspection|code|ordinance)\b|ground[ _-]?water|\bbore[ _-]?holes?\b|\baquifers?\b|water[ _-]?level|\bpiezometer/i;
const NOT_WATER_WELLS =
  /\boil\b|\bgas\b|petroleum|hydrocarbon|\bwellness\b|wells fargo|stairwell|\bwellhead protection\b|\bseptic\b|\bsewer/i;
/** Relevance of free text (a title, layer name, link text) to water wells. 0 means unrelated. */
export function wellRelevance(...texts: (string | null | undefined)[]) {
  const text = texts.filter(Boolean).join(" \n ").replace(/_/g, " ");
  if (!WELL_WORDS.test(text)) return 0;
  let score = 1;
  if (/\bwells?\b/i.test(text)) score += 2;
  if (/ground[ -]?water/i.test(text)) score += 1;
  if (
    /permit|construction|completion|abandon|driller|log|record|inventory|monitor/i.test(
      text,
    )
  )
    score += 1;
  if (NOT_WATER_WELLS.test(text)) score -= 3;
  return Math.max(0, score);
}
/** Choose the output table from what the dataset and its fields describe. */
export function classify(name: string, fields: FieldInfo[]): EntityKind {
  const names = fields.map((f) => `${f.name} ${f.alias ?? ""}`).join(" ");
  if (
    /\b(parameter|analyte|characteristic|result|concentration)\b/i.test(
      names.replace(/_/g, " "),
    ) &&
    /sample|collect|result|analy/i.test(names)
  )
    return "observations";
  if (
    /permit|construction|completion|abandon|application|driller.?log|well.?log/i.test(
      name.replace(/_/g, " "),
    )
  )
    return "construction";
  return "wells";
}
export function normalizeRecord(
  attributes: Record<string, unknown>,
  options: {
    source: string;
    dataset: string;
    native: string;
    kind: EntityKind;
    approach: Approach;
    geo: Geography;
    url: string;
    raw_path: string;
    raw_sha256: string;
    runId: string;
    fields: FieldInfo[];
    fieldMap?: Record<string, string>;
    point?: number[] | null;
    geometry?: unknown;
    crs?: number | null;
    countyMethod: string;
    identityMethod: string;
    adapterVersion?: string;
    flags?: string[];
  },
): Entity {
  const map = options.fieldMap ?? mapFields(options.fields);
  const info = (canonical: string) =>
    options.fields.find((f) => f.name === map[canonical]);
  const value = (canonical: string) =>
    map[canonical] === undefined ? null : (attributes[map[canonical]!] ?? null);
  const id = entityId(options.source, options.dataset, options.native);
  const depth = quantity(value("total_depth"), info("total_depth")),
    casing = quantity(value("casing_depth"), info("casing_depth")),
    yielded = quantity(value("yield"), info("yield"));
  const unitsKnown = [depth, casing, yielded].every(
    (q) => q.raw_value === null || q.unit !== null,
  );
  return {
    id,
    record_id: id,
    native_id: options.native,
    source_id: options.source,
    dataset_id: options.dataset,
    acquisition_method: options.approach,
    entity_kind:
      options.kind === "construction"
        ? "permit"
        : options.kind === "observations"
          ? "observation"
          : "well",
    identity_method: options.identityMethod,
    county_geoid: options.geo.county_geoid,
    state_fips: options.geo.state_fips,
    county_fips: options.geo.county_fips,
    state: options.geo.state,
    county: options.geo.county,
    county_assignment_method: options.countyMethod,
    longitude: options.point?.[0] ?? null,
    latitude: options.point?.[1] ?? null,
    original_geometry: options.geometry ?? null,
    original_crs: options.crs ?? null,
    location_method: "source_reported",
    coordinate_accuracy: null,
    address: value("address"),
    parcel_id: value("parcel_id"),
    owner: value("owner"),
    well_name: value("well_name"),
    well_use: value("well_use"),
    well_type: value("well_type"),
    well_status: value("well_status"),
    source_well_id: value("source_well_id"),
    facility_id: value("facility_id"),
    file_number: value("file_number"),
    permit_number: value("permit_number"),
    application_id: value("application_id"),
    total_depth: depth,
    casing_depth: casing,
    yield: yielded,
    driller: value("driller"),
    aquifer: value("aquifer"),
    completed_on: value("completed_on"),
    permitted_on: value("permitted_on"),
    field_map: map,
    source_fields: attributes,
    quality_flags: [
      ...(unitsKnown ? [] : ["source_units_unverified"]),
      "source_location_accuracy_unknown",
      "fields_mapped_by_name",
      ...(options.flags ?? []),
    ],
    source_url: options.url,
    retrieved_at: now(),
    raw_path: options.raw_path,
    raw_sha256: options.raw_sha256,
    run_id: options.runId,
    schema_version: "1.0.0",
    adapter_version: options.adapterVersion ?? "1.0.0",
  };
}
/** Water-level attributes published on a well row become observation rows. */
export function observations(well: Entity): Entity[] {
  const map = (well.field_map ?? {}) as Record<string, string>;
  const key = map.static_water_level;
  const a = well.source_fields;
  if (!key || !present(a[key])) return [];
  return [
    {
      ...well,
      id: entityId(well.id, key),
      observation_id: entityId(well.id, key),
      record_id: well.id,
      native_id: well.native_id + ":" + key,
      entity_kind: "observation",
      parameter: key,
      observation_kind: "source_water_level_attribute",
      result: parseResult(a[key]),
      unit: unitOf({ name: key }),
      vertical_reference: null,
      observed_at:
        Object.entries(a).find(
          ([name, v]) =>
            present(v) && /(swl|level|measure)[a-z_ ]*(date|dt)/i.test(name),
        )?.[1] ?? null,
      quality_flags: [
        ...well.quality_flags,
        "measurement_unit_and_datum_unverified",
      ],
    },
  ];
}
/** Read a WGS84 point from an ArcGIS feature that was requested with outSR=4326. */
export function coordinates(feature: ArcFeature, crs = 4326) {
  const g = feature.geometry;
  if (!g || typeof g.x !== "number" || typeof g.y !== "number") return null;
  const wkid =
    g.spatialReference?.latestWkid ?? g.spatialReference?.wkid ?? crs;
  if (wkid !== 4326) return null;
  return Math.abs(g.x) <= 180 && Math.abs(g.y) <= 90 ? [g.x, g.y] : null;
}
export const fieldKey = squash;
