import { z } from "zod";
export const VERSION = "0.1.0";
export const SCHEMA_VERSION = "1.0.0";
export class ScrapeError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ScrapeError";
  }
}
export const ConfigSchema = z
  .object({
    state: z.string().min(1),
    county: z.string().min(1),
    output: z.string().default("./runs"),
    sources: z.array(z.string()).default([]),
    // Empty means every acquisition approach: public API, browser navigation and file downloads.
    approaches: z.array(z.enum(["api", "browser", "download"])).default([]),
    // Optional public pages supplied at run time; never compiled into the application.
    seedUrls: z.array(z.string().url()).default([]),
    maxTargets: z.number().int().min(1).max(500).default(40),
    attachments: z.enum(["all", "none"]).default("all"),
    jsonArray: z.boolean().default(false),
    headful: z.boolean().default(false),
    interactiveAuth: z.boolean().default(false),
    credentialProfile: z.string().optional(),
    maxDuration: z.number().positive().default(7200),
    maxBytes: z
      .number()
      .int()
      .positive()
      .default(5 * 1024 ** 3),
    minFreeBytes: z
      .number()
      .int()
      .nonnegative()
      .default(100 * 1024 ** 2),
    maxRecords: z.number().int().positive().default(1_000_000),
    intervalMs: z.number().int().min(1000).default(1000),
    batchSize: z.number().int().min(1).max(500).default(500),
    logLevel: z.enum(["info", "error", "debug"]).default("info"),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;
export interface Geography {
  state: string;
  state_name: string;
  state_fips: string;
  county: string;
  county_fips: string;
  county_geoid: string;
  vintage: string;
  reference_sha256: string;
}
export type EntityKind =
  "wells" | "construction" | "observations" | "documents" | "relationships";
export const EntitySchema = z
  .object({
    id: z.string().min(1),
    source_id: z.string().min(1),
    dataset_id: z.string().min(1),
    native_id: z.string().min(1),
    county_geoid: z.string().regex(/^\d{5}$/),
    source_url: z.string(),
    retrieved_at: z.string(),
    raw_path: z.string(),
    raw_sha256: z.string(),
    source_fields: z.record(z.string(), z.unknown()),
    quality_flags: z.array(z.string()),
  })
  .passthrough();
export type Entity = z.infer<typeof EntitySchema>;
export type Approach = "api" | "browser" | "download";
export const APPROACHES: Approach[] = ["api", "browser", "download"];
export interface SourceManifest {
  id: string;
  title: string;
  agency: string;
  landingPage: string;
  // Catalog/service origins known before discovery. Origins found at run time are approved per attempt.
  origins: string[];
  approach: Approach;
  mode: "usgs" | "arcgis" | "browser" | "wqp" | "files" | "candidate";
  status: "implemented" | "candidate";
  datasets: string[];
  limitation?: string;
  version: string;
  verifiedAt: string;
}
export interface SourceResult {
  source_id: string;
  dataset_id: string;
  status: string;
  completeness: string;
  expected: number | null;
  fetched: number;
  accepted: number;
  excluded: number;
  quarantined: number;
  unresolved: number | null;
  errors: { code: string; message: string }[];
  caveats: string[];
}
export const emptyResult = (source: string, dataset: string): SourceResult => ({
  source_id: source,
  dataset_id: dataset,
  status: "pending",
  completeness: "unverified",
  expected: null,
  fetched: 0,
  accepted: 0,
  excluded: 0,
  quarantined: 0,
  unresolved: null,
  errors: [],
  caveats: [],
});
export const entityId = (...parts: string[]) =>
  parts.map(encodeURIComponent).join(":");
export const errorInfo = (error: unknown) => ({
  code: error instanceof ScrapeError ? error.code : "UNEXPECTED",
  message: error instanceof Error ? error.message : "Unknown error",
});
