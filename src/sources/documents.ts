import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyResult,
  entityId,
  errorInfo,
  ScrapeError,
  type Entity,
} from "../core/types.js";
import { hash, now, atomicWrite } from "../core/util.js";
import type { BrowserContext, Page } from "playwright";
import { wellRelevance } from "../data/normalize.js";
import { checkRecordBudget, type SourceContext } from "./context.js";
/** Checkpoint key for an archive's remaining date partitions. */
export const datesKey = (source: string, dataset: string) =>
  dataset === "reports" ? source + ":dates" : `${source}:${dataset}:dates`;
export interface ArchiveDocument {
  ID: string;
  Name: string;
  DisplayType?: string;
  DisplayColumnValues?: { Value: string; RawValue: unknown }[];
}
export interface ArchiveResponse {
  Message?: string;
  Data: ArchiveDocument[];
  Truncated?: boolean;
  DisplayColumns?: { Heading: string; DataType: string }[];
}
export function documentFields(
  doc: ArchiveDocument,
  response: ArchiveResponse,
) {
  return Object.fromEntries(
    (response.DisplayColumns ?? []).map((c, i) => [
      c.Heading,
      doc.DisplayColumnValues?.[i]?.Value ?? null,
    ]),
  );
}
export function isWellDocument(
  doc: ArchiveDocument,
  response: ArchiveResponse,
) {
  const type = documentFields(doc, response)["Document Type"];
  return typeof type === "string" && /\bwell\b/i.test(type);
}
export function fileType(body: Buffer) {
  if (body.subarray(0, 5).toString() === "%PDF-") return "pdf";
  if (
    body.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "png";
  if (body[0] === 255 && body[1] === 216) return "jpg";
  if (["II*\0", "MM\0*"].includes(body.subarray(0, 4).toString()))
    return "tiff";
  throw new ScrapeError(
    "INVALID_DOCUMENT",
    "Expected a public PDF or report image; received an unsupported file or login page.",
  );
}
export async function saveDocument(
  ctx: SourceContext,
  doc: ArchiveDocument,
  response: ArchiveResponse,
  raw: { raw_path: string; raw_sha256: string },
  base: string,
  cookies = "",
  dataset = "reports",
) {
  checkRecordBudget(ctx);
  const url = base + "/api/Document/" + encodeURIComponent(doc.ID) + "/";
  let content: Buffer | undefined;
  let status = "not_requested";
  let ext: string | undefined;
  let failure: { code: string; message: string } | undefined;
  if (ctx.config.attachments === "all") {
    try {
      const r = await ctx.http.get(
        url,
        100 * 1024 ** 2,
        cookies ? { cookie: cookies } : {},
      );
      ext = fileType(r.body);
      content = r.body;
      status = "downloaded";
    } catch (e) {
      failure = errorInfo(e);
      status =
        failure.code === "NOT_FOUND"
          ? "unavailable"
          : failure.code === "BLOCKED"
            ? "blocked"
            : failure.code.startsWith("BUDGET")
              ? "over_budget"
              : "failed";
    }
  }
  const digest = content ? hash(content) : null;
  const identity = hash(
    JSON.stringify([doc.Name, doc.DisplayColumnValues, doc.ID]),
  );
  const id = entityId(ctx.source.id, dataset, identity);
  const local = content ? `attachments/${digest}.${ext}` : null;
  if (content && local) atomicWrite(join(ctx.store.dir, local), content);
  const e: Entity = {
    id,
    document_id: id,
    native_id: doc.ID,
    source_id: ctx.source.id,
    dataset_id: dataset,
    acquisition_method: ctx.source.approach,
    county_geoid: ctx.geo.county_geoid,
    county_assignment_method: "county_archive",
    source_url: url,
    retrieved_at: now(),
    ...raw,
    source_fields: { ...doc, display_fields: documentFields(doc, response) },
    quality_flags: ["archive_identity_may_change", "report_text_not_extracted"],
    identity_method: "opaque_source_reference",
    title: doc.Name,
    download_status: status,
    local_path: local,
    sha256: digest,
    byte_count: content?.length ?? null,
    record_id: null,
  };
  const prior = ctx.store.get<string>(
    "document:" + ctx.source.id + ":" + hash(doc.ID),
  );
  ctx.store.transaction(() => {
    if (prior && prior !== id) ctx.store.remove("documents", prior);
    ctx.store.put("documents", e);
    ctx.store.set("document:" + ctx.source.id + ":" + hash(doc.ID), id);
  });
  ctx.records++;
  if (failure) {
    ctx.store.issue({ entity_id: id, ...failure });
    ctx.logger.log("document.failed", {
      source_id: ctx.source.id,
      error_code: failure.code,
    });
    if (failure.code.startsWith("BUDGET"))
      throw new ScrapeError(failure.code, failure.message);
  }
  return failure;
}
export type DatePartition = { from: string; to: string };
export function splitDates(part: DatePartition): DatePartition[] {
  const from = Date.parse(part.from + "T00:00:00Z"),
    to = Date.parse(part.to + "T00:00:00Z");
  if (from === to) return [];
  const middle = from + Math.floor((to - from) / 86400000 / 2) * 86400000;
  return [
    {
      from: new Date(middle + 86400000).toISOString().slice(0, 10),
      to: part.to,
    },
    { from: part.from, to: new Date(middle).toISOString().slice(0, 10) },
  ];
}
export async function enumerateHyland(
  ctx: SourceContext,
  base: string,
  queryId: number,
  cookies = "",
  dataset = "reports",
) {
  const key = datesKey(ctx.source.id, dataset);
  let pending = ctx.store.get<DatePartition[]>(key) ?? [
    { from: "1753-01-01", to: "9999-12-31" },
  ];
  const unavailable =
    ctx.store.get<DatePartition[]>(key + ":unavailable") ?? [];
  if (unavailable.length) {
    pending = [...pending, ...unavailable];
    ctx.store.transaction(() => {
      ctx.store.set(key, pending);
      ctx.store.set(key + ":unavailable", []);
    });
  }
  const failedPartitions: DatePartition[] = [];
  const headers: Record<string, string> = cookies ? { cookie: cookies } : {};
  type FailedReport = {
    doc: ArchiveDocument;
    raw_path: string;
    raw_sha256: string;
  };
  const failures =
    ctx.store.get<Record<string, FailedReport>>(key + ":failed") ?? {};
  const attempted = new Set<string>();
  const save = async (
    doc: ArchiveDocument,
    response: ArchiveResponse,
    raw: { raw_path: string; raw_sha256: string },
  ) => {
    const task = hash(doc.ID);
    const failure = await saveDocument(
      ctx,
      doc,
      response,
      raw,
      base,
      cookies,
      dataset,
    );
    attempted.add(task);
    if (failure) failures[task] = { doc, ...raw };
    else delete failures[task];
    ctx.store.transaction(() => {
      ctx.store.set(key + ":failed", failures);
      ctx.store.task(
        ctx.source.id,
        dataset,
        task,
        failure ? "failed" : "accepted",
      );
    });
    if (
      failure &&
      ["NEEDS_AUTH", "BLOCKED", "CANCELLED"].includes(failure.code)
    )
      throw new ScrapeError(failure.code, failure.message);
  };
  // Retry each failed report once per attempt, then continue other partitions.
  for (const failed of Object.values(failures)) {
    const bytes = readFileSync(join(ctx.store.dir, failed.raw_path));
    if (hash(bytes) !== failed.raw_sha256)
      throw new ScrapeError(
        "CHECKPOINT_CORRUPT",
        "Saved archive response hash does not match.",
      );
    await save(
      failed.doc,
      JSON.parse(bytes.toString()) as ArchiveResponse,
      failed,
    );
  }
  while (pending.length) {
    checkRecordBudget(ctx);
    const part = pending[0]!;
    const cache = ctx.store.get<{
      part: DatePartition;
      raw_path: string;
      raw_sha256: string;
    }>(key + ":active");
    let response: ArchiveResponse;
    let raw: { raw_path: string; raw_sha256: string };
    if (cache && JSON.stringify(cache.part) === JSON.stringify(part)) {
      raw = cache;
      const bytes = readFileSync(join(ctx.store.dir, cache.raw_path));
      if (hash(bytes) !== cache.raw_sha256)
        throw new ScrapeError(
          "CHECKPOINT_CORRUPT",
          "Saved archive response hash does not match.",
        );
      response = JSON.parse(bytes.toString()) as ArchiveResponse;
    } else {
      const children = splitDates(part);
      response = await ctx.http.postJson<ArchiveResponse>(
        base + "/api/CustomQuery/KeywordSearch",
        {
          QueryID: queryId,
          Keywords: [],
          FromDate: part.from + "T00:00:00",
          ToDate: part.to + "T23:59:59",
          QueryLimit: children.length ? 1000 : 0,
        },
        headers,
        [404],
      );
      // This portal returns 404 for an indexed document with a missing revision.
      // Split only that observed error; an arbitrary 404 must never mean an empty search.
      if (
        typeof response.Message === "string" &&
        /^The revision id \d+ was not found for document id \d+\./.test(
          response.Message,
        )
      ) {
        if (children.length) pending = [...children, ...pending.slice(1)];
        else {
          failedPartitions.push(part);
          pending = pending.slice(1);
          ctx.store.issue({
            source_id: ctx.source.id,
            code: "ARCHIVE_REVISION_MISSING",
            partition: part,
            message: response.Message,
            ...ctx.store.raw(ctx.source.id, response),
          });
        }
        ctx.store.transaction(() => {
          ctx.store.set(key, pending);
          ctx.store.set(key + ":unavailable", failedPartitions);
        });
        continue;
      }
      if (
        !Array.isArray(response.Data) ||
        typeof response.Truncated !== "boolean"
      )
        throw new ScrapeError(
          "SCHEMA_CHANGED",
          "Archive did not supply a result list and truncation flag.",
        );
      raw = ctx.store.raw(ctx.source.id, response);
      if (response.Truncated) {
        if (!children.length)
          throw new ScrapeError(
            "TRUNCATED",
            "Single-day archive query remains truncated despite the portal default unlimited query setting.",
          );
        pending = [...children, ...pending.slice(1)];
        ctx.store.set(key, pending);
        continue;
      }
      ctx.store.set(key + ":active", { part, ...raw });
    }
    for (const doc of response.Data) {
      if (!doc.ID || !doc.Name)
        throw new ScrapeError(
          "SCHEMA_CHANGED",
          "Archive document identity missing.",
        );
      const task = hash(doc.ID);
      if (ctx.store.done(ctx.source.id, dataset, task) || attempted.has(task))
        continue;
      checkRecordBudget(ctx);
      const fields = documentFields(doc, response);
      // Prefer the archive's own document type; without one, judge by the
      // document's name and indexed values.
      const relevant = fields["Document Type"]
        ? isWellDocument(doc, response)
        : wellRelevance(doc.Name, ...Object.values(fields).map(String)) > 0;
      if (!relevant) {
        ctx.store.task(ctx.source.id, dataset, task, "excluded");
        ctx.records++;
        continue;
      }
      await save(doc, response, raw);
    }
    pending = pending.slice(1);
    ctx.store.transaction(() => {
      ctx.store.set(key, pending);
      ctx.store.set(key + ":active", null);
      ctx.store.set(
        key + ":completed",
        (ctx.store.get<number>(key + ":completed") ?? 0) + 1,
      );
    });
    ctx.logger.log("batch.committed", {
      source_id: ctx.source.id,
      partition: part,
      count: response.Data.length,
    });
  }
  if (failedPartitions.length)
    throw new ScrapeError(
      "ARCHIVE_PARTITION_UNAVAILABLE",
      "Some dates contain broken source document revisions. Other dates were collected; resume retries unavailable dates. See validation-errors.jsonl.",
    );
  if (Object.keys(failures).length)
    throw new ScrapeError(
      "DOWNLOAD_FAILED",
      "Some public reports failed to download. Resume retries these files without repeating completed partitions.",
    );
}
/** True when the open page is a Hyland OnBase public-access search application. */
export async function isHylandPortal(page: Page) {
  return (await page.locator("#obpa_query").count()) > 0;
}
/**
 * Collect an OnBase public-access archive the browser has already opened.
 * The archive's own query list decides what is searched; nothing about a
 * particular county's archive is assumed.
 */
export async function collectHylandPortal(
  ctx: SourceContext,
  context: BrowserContext,
  page: Page,
  base: string,
  dataset: string,
) {
  const result = emptyResult(ctx.source.id, dataset);
  const key = datesKey(ctx.source.id, dataset);
  const previousTimeout = ctx.http.opts.requestTimeoutMs;
  try {
    // Complete single-day result sets can take longer than a normal API request.
    ctx.http.opts.requestTimeoutMs = 120000;
    if (await page.locator("input[type=password]").count())
      throw new ScrapeError(
        "NEEDS_AUTH",
        "Archive requires login. Save a session with auth login --url, then resume.",
      );
    const cookies = (await context.cookies(base))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    if (cookies) ctx.logger.secrets.push(cookies);
    const selected = (
      await page.locator("#obpa_query option:checked").allInnerTexts()
    )[0];
    const queries = await ctx.http.json<{
      Data: { ID: string | number; Name: string; DateSearchOption: string }[];
    }>(base + "/api/CustomQuery", cookies ? { cookie: cookies } : {});
    // The query the portal preselects, else the single query about wells.
    const named = queries.Data?.filter((q) => q.Name === selected) ?? [];
    const matches = named.length
      ? named
      : (queries.Data?.filter((q) => wellRelevance(q.Name) > 0) ?? []);
    if (
      matches.length !== 1 ||
      !/^\d+$/.test(String(matches[0]!.ID)) ||
      matches[0]!.DateSearchOption !== "ToFromDate"
    )
      throw new ScrapeError(
        "SCHEMA_CHANGED",
        "Archive does not offer exactly one date-searchable public query.",
      );
    ctx.store.set(`${ctx.source.id}:${dataset}:metadata`, queries);
    ctx.store.raw(ctx.source.id, queries);
    await enumerateHyland(ctx, base, Number(matches[0]!.ID), cookies, dataset);
    result.status = "success";
    result.completeness = "unverified";
    result.caveats.push(
      "All public date partitions 1753-01-01 through 9999-12-31 reconciled with Truncated=false. Source exposes no immutable snapshot; undated or unindexed documents cannot be independently audited. Report text is not extracted.",
    );
  } catch (e) {
    try {
      ctx.http.check();
    } catch (budget) {
      e = budget;
    }
    const err = errorInfo(e);
    result.errors.push(err);
    result.status =
      err.code === "NEEDS_AUTH"
        ? "needs_auth"
        : err.code === "BLOCKED"
          ? "blocked"
          : "failed";
    result.completeness = "incomplete";
  } finally {
    ctx.http.opts.requestTimeoutMs = previousTimeout;
  }
  for (const row of ctx.store.taskCounts(ctx.source.id, dataset)) {
    if (row.status !== "failed") result.fetched += Number(row.n);
    if (row.status === "accepted") result.accepted += Number(row.n);
    else if (row.status === "excluded") result.excluded += Number(row.n);
  }
  result.expected =
    ctx.store.get<DatePartition[]>(key)?.length === 0 &&
    !ctx.store.get<DatePartition[]>(key + ":unavailable")?.length
      ? ctx.store
          .taskCounts(ctx.source.id, dataset)
          .reduce((n, row) => n + Number(row.n), 0)
      : null;
  result.unresolved =
    result.expected === null ? null : result.expected - result.fetched;
  if (result.accepted && result.status !== "success") result.status = "partial";
  ctx.store.result(result);
  ctx.logger.log("source.finished", {
    source_id: ctx.source.id,
    dataset_id: dataset,
    status: result.status,
    accepted: result.accepted,
    excluded: result.excluded,
  });
}
