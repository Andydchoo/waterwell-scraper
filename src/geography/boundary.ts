import booleanPointInPolygon from "@turf/boolean-point-in-polygon";
import type { Feature, MultiPolygon, Polygon } from "geojson";
import { ScrapeError, type Geography } from "../core/types.js";
import { query } from "../transports/http.js";

// Nationwide Census service. The county is selected by GEOID at run time;
// no county geometry ships with the application.
export const BOUNDARY_SERVICE =
  "https://tigerweb.geo.census.gov/arcgis/rest/services/TIGERweb/State_County/MapServer";
export const BOUNDARY_ORIGIN = new URL(BOUNDARY_SERVICE).origin;

export interface Boundary {
  feature: Feature<Polygon | MultiPolygon>;
  // [west, south, east, north] in WGS84 degrees.
  bbox: [number, number, number, number];
  source_url: string;
}
interface JsonFetcher {
  json<T>(url: string): Promise<T>;
}
function positions(geometry: Polygon | MultiPolygon): number[][] {
  return geometry.type === "Polygon"
    ? geometry.coordinates.flat()
    : geometry.coordinates.flat(2);
}
export function boundaryFromFeature(
  feature: Feature<Polygon | MultiPolygon>,
  sourceUrl = "",
): Boundary {
  if (
    !feature?.geometry ||
    !["Polygon", "MultiPolygon"].includes(feature.geometry.type)
  )
    throw new ScrapeError(
      "BOUNDARY_UNAVAILABLE",
      "County boundary geometry is missing or not a polygon.",
    );
  const points = positions(feature.geometry);
  if (!points.length)
    throw new ScrapeError("BOUNDARY_UNAVAILABLE", "County boundary is empty.");
  const xs = points.map((p) => p[0]!),
    ys = points.map((p) => p[1]!);
  const reduce = (values: number[], pick: (a: number, b: number) => number) =>
    values.reduce((a, b) => pick(a, b));
  return {
    feature,
    bbox: [
      reduce(xs, Math.min),
      reduce(ys, Math.min),
      reduce(xs, Math.max),
      reduce(ys, Math.max),
    ],
    source_url: sourceUrl,
  };
}
/** Fetch the selected county's boundary from the Census TIGERweb service. */
export async function fetchBoundary(
  fetcher: JsonFetcher,
  geo: Geography,
): Promise<Boundary> {
  const service = await fetcher.json<{
    layers?: { id: number; name: string }[];
  }>(query(BOUNDARY_SERVICE, { f: "json" }));
  // The county layer is located by name so a renumbered service keeps working.
  const layer = service.layers?.find((l) => /^counties$/i.test(l.name.trim()));
  if (!layer)
    throw new ScrapeError(
      "BOUNDARY_UNAVAILABLE",
      "Census boundary service no longer lists a county layer.",
    );
  const url = query(`${BOUNDARY_SERVICE}/${layer.id}/query`, {
    where: `GEOID='${geo.county_geoid}'`,
    outFields: "GEOID,NAME",
    returnGeometry: true,
    outSR: 4326,
    geometryPrecision: 5,
    f: "geojson",
  });
  const collection = await fetcher.json<{
    features?: Feature<Polygon | MultiPolygon>[];
  }>(url);
  const feature = collection.features?.[0];
  if (
    collection.features?.length !== 1 ||
    !feature ||
    feature.properties?.GEOID !== geo.county_geoid
  )
    throw new ScrapeError(
      "BOUNDARY_UNAVAILABLE",
      "Census boundary service did not return exactly the requested county.",
    );
  return boundaryFromFeature(feature, url);
}
export function inBoundary(boundary: Boundary, point: number[]) {
  return booleanPointInPolygon([point[0]!, point[1]!], boundary.feature, {
    ignoreBoundary: true,
  });
}
export function bboxIntersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
) {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}
