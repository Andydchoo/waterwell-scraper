import { z } from "zod";
export const EXPLORER_VERSION = 1;
export const Kind = z.enum([
  "wells",
  "construction",
  "observations",
  "documents",
]);
export type Kind = z.infer<typeof Kind>;
export const kinds: Kind[] = [
  "wells",
  "construction",
  "observations",
  "documents",
];
export const Identifier = z.enum([
  "native",
  "well",
  "parcel",
  "file",
  "application",
  "facility",
]);
export const Meaning = z.enum([
  "completion",
  "permit",
  "observation",
  "document",
]);
const list = z.array(z.string().min(1).max(512)).max(50).default([]);
const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "Invalid calendar date");
export const QuerySchema = z
  .object({
    kind: Kind.default("wells"),
    q: z.string().max(256).default(""),
    sources: list,
    datasets: list,
    statuses: list,
    uses: list,
    flags: list,
    identifier: z
      .object({ type: Identifier, value: z.string().min(1).max(1024) })
      .strict()
      .optional(),
    date: z
      .object({ meaning: Meaning, from: day.optional(), to: day.optional() })
      .strict()
      .optional(),
    depth: z
      .object({
        mode: z.enum(["known", "unknown"]).default("known"),
        unit: z.enum(["m", "ft"]).default("m"),
        min: z.number().finite().optional(),
        max: z.number().finite().optional(),
      })
      .strict()
      .optional(),
    reports: z.enum(["any", "downloaded", "none"]).optional(),
    downloadStates: list,
    sort: z
      .enum(["id", "title", "address", "depth", "date", "source"])
      .default("id"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    pageSize: z
      .union([z.literal(25), z.literal(50), z.literal(100)])
      .default(50),
    cursor: z.string().max(16384).optional(),
  })
  .strict()
  .superRefine((q, c) => {
    const fail = (message: string) => c.addIssue({ code: "custom", message });
    if (q.q.trim().split(/\s+/u).filter(Boolean).length > 8)
      fail("Use at most eight search terms.");
    if (
      q.date &&
      ((!q.date.from && !q.date.to) ||
        (q.date.from && q.date.to && q.date.from > q.date.to))
    )
      fail("Choose a valid date range.");
    if (
      q.depth &&
      ((q.depth.min !== undefined &&
        q.depth.max !== undefined &&
        q.depth.min > q.depth.max) ||
        (q.depth.mode === "unknown" &&
          (q.depth.min !== undefined || q.depth.max !== undefined)))
    )
      fail("Choose a valid depth range.");
    if (q.depth && !["wells", "construction"].includes(q.kind))
      fail("Depth filters apply to wells and construction.");
    if (q.kind === "documents" && q.reports)
      fail("Use report download state for report records.");
    if (q.kind !== "documents" && q.downloadStates.length)
      fail("Download state applies to reports.");
    if (
      q.date &&
      !{
        wells: ["completion"],
        construction: ["completion", "permit", "document"],
        observations: ["observation"],
        documents: ["document", "completion"],
      }[q.kind].includes(q.date.meaning)
    )
      fail("Date meaning does not apply to this record type.");
    if (q.sort === "date" && !q.date)
      fail("Choose a date meaning and range before sorting dates.");
    if (q.sort === "depth" && !["wells", "construction"].includes(q.kind))
      fail("Depth sorting applies to wells and construction.");
  });
export type Query = z.infer<typeof QuerySchema>;
export const ExportSchema = z
  .object({ query: QuerySchema, format: z.enum(["csv", "json", "jsonl"]) })
  .strict()
  .refine(
    (x) => !x.query.cursor,
    "Exports include every match; omit the page cursor.",
  );
export type ExportInput = z.infer<typeof ExportSchema>;
export type RecordKey = { kind: Kind; id: string };
export interface Summary extends RecordKey {
  source: string;
  dataset: string;
  native: string;
  title: string;
  address: string | null;
  parcel: string | null;
  well: string | null;
  file: string | null;
  status: string | null;
  use: string | null;
  depth: number | null;
  depthLabel: string | null;
  dateLabel: string | null;
  download: string | null;
  flags: string[];
  parameter: string | null;
  result: string | null;
  unit: string | null;
  reports: number;
  downloadedReports: number;
}
export interface DateValue {
  meaning: z.infer<typeof Meaning>;
  start: string;
  end: string;
  precision: string;
  raw: unknown;
  path: string;
}
export interface Projection {
  summary: Summary;
  search: string;
  identifiers: {
    type: string;
    value: string;
    normalized: string;
    path: string;
  }[];
  dates: DateValue[];
  lineage: Record<string, string>;
}
export interface Snapshot {
  id: string;
  runKey: string;
  runId: string;
  attempt: number;
  outcome: string;
  endedAt: string;
  createdAt: string;
  revision: string;
  version: number;
  counts: Record<string, number>;
  digest: string;
  bytes: number;
  county: string;
  state: string;
  sourcePlan: unknown[];
  coverage: unknown[];
}
export interface Job {
  id: string;
  type: "index" | "export";
  runKey?: string;
  snapshot?: string;
  state: "running" | "complete" | "failed" | "cancelled" | "interrupted";
  createdAt: string;
  updatedAt: string;
  pid: number;
  progress: number;
  total?: number;
  error?: string;
  code?: string;
  input?: ExportInput;
}
export interface Capabilities {
  snapshot: Snapshot;
  types: { kind: Kind; count: number }[];
  sources: { source: string; dataset: string; kind: Kind }[];
  statuses: string[];
  uses: string[];
  flags: string[];
  downloadStates: string[];
  dateMeanings: string[];
  unknownDepth: number;
}
export interface Page {
  items: Summary[];
  total: number;
  nextCursor: string | null;
  snapshot: string;
  query: Query;
  unknownDepth: number;
}
export interface Detail {
  snapshot: Snapshot;
  entity: Record<string, unknown>;
  projection: Projection;
}
export interface Link {
  kind: Kind | null;
  id: string;
  title: string | null;
  evidence: string;
  relation: string;
  resolved: boolean;
}
export class ExplorerError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export const fold = (s: string) => s.normalize("NFKC").toLowerCase();
export const opaque = (s: string) => z.string().uuid().parse(s);
