import { statfsSync } from "node:fs";
import type http from "node:http";
import type { Config, Geography, SourceManifest } from "../core/types.js";
import { ScrapeError } from "../core/types.js";
import type { Store } from "../storage/store.js";
import type { Logger } from "../core/logger.js";
import type { HttpClient } from "../transports/http.js";
import type { Boundary } from "../geography/boundary.js";
/** The request surface shared by the direct HTTP client and the browser session. */
export interface Fetcher {
  json<T = Record<string, unknown>>(
    url: string,
    headers?: Record<string, string>,
  ): Promise<T>;
  formJson<T>(
    url: string,
    value: Record<string, string | number | boolean>,
  ): Promise<T>;
  get(
    url: string,
    limit?: number,
    headers?: Record<string, string>,
  ): Promise<{ body: Buffer; url: string; headers: http.IncomingHttpHeaders }>;
}
export interface SourceContext {
  config: Config;
  geo: Geography;
  source: SourceManifest;
  store: Store;
  logger: Logger;
  http: HttpClient;
  signal: AbortSignal;
  runId: string;
  records: number;
  // County boundary fetched for this run; absent only when the boundary service failed.
  boundary?: Boundary;
  savedSession?: { sourceId: string; path: string };
}
export function checkRecordBudget(ctx: SourceContext) {
  ctx.http.check();
  const disk = statfsSync(ctx.store.dir);
  if (disk.bavail * disk.bsize < ctx.config.minFreeBytes)
    throw new ScrapeError(
      "BUDGET_DISK",
      "Free disk space is below minFreeBytes; free space before resuming.",
    );
  if (ctx.records >= ctx.config.maxRecords)
    throw new ScrapeError(
      "BUDGET_RECORDS",
      "Record budget reached; resume to continue.",
    );
}
/** County name as agencies usually store it: without the "County"/"Parish" suffix. */
export function countyShortName(geo: Geography) {
  return geo.county
    .replace(
      / (County|Parish|Borough|Census Area|Municipality|Municipio|Planning Region|city)$/i,
      "",
    )
    .trim();
}
export const isBudget = (code: string) =>
  code.startsWith("BUDGET") || code === "CANCELLED";
