import { readFileSync } from "node:fs";
import { boundaryFromFeature } from "../../src/geography/boundary.js";
// A real county outline kept only as test data; the application fetches
// boundaries from the Census service at run time.
export const fixtureBoundary = boundaryFromFeature(
  JSON.parse(
    readFileSync(new URL("./county-boundary.geojson", import.meta.url), "utf8"),
  ).features[0],
  "fixture",
);
