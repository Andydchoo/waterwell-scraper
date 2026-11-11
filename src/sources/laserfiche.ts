import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  emptyResult,
  entityId,
  errorInfo,
  ScrapeError,
  type Entity,
} from "../core/types.js";
import { atomicWrite, hash, now } from "../core/util.js";
import type { BrowserContext, Page } from "playwright";
import { wellRelevance } from "../data/normalize.js";
import {
  checkRecordBudget,
  countyShortName,
  type SourceContext,
} from "./context.js";
import { fileType } from "./documents.js";

/**
 * A Laserfiche WebLink public archive. The address and repository are read
 * from the page the browser reached at run time; none is built in.
 */
export interface LaserfichePortal {
  base: string;
  repo: string;
  dbid: string;
}
/** Recognise a WebLink address and split it into the portal's parts. */
export function laserfichePortal(input: string): LaserfichePortal | null {
  try {
    const u = new URL(input);
    const repo = u.searchParams.get("repo");
    if (
      !repo ||
      !/\/(Welcome|Browse|Search|CustomSearch|DocView)\.aspx$/i.test(u.pathname)
    )
      return null;
    return {
      base: u.origin + u.pathname.replace(/[^/]+$/, ""),
      repo,
      dbid: u.searchParams.get("dbid") ?? "0",
    };
  } catch {
    return null;
  }
}
interface Metadata {
  name: string;
  values: string[];
}
export interface LaserficheEntry {
  entryId: number;
  name: string;
  metadata: Metadata[];
  type: number;
  isEdoc: boolean;
  thumbnailPageCount: number;
  [key: string]: unknown;
}
interface Listing {
  results: LaserficheEntry[];
  columns: unknown[];
  hitCount: number;
  searchUUID: string;
  failed: boolean;
  errMsg: string | null;
}
export type ArchiveApi = <T>(path: string, body: unknown) => Promise<T>;
const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);
function validIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => !/^\d+$/.test(String(id))))
    throw new ScrapeError(
      "SCHEMA_CHANGED",
      "Archive ID enumeration is malformed.",
    );
  const ids = value.map(String);
  if (new Set(ids).size !== ids.length)
    throw new ScrapeError("DUPLICATE_IDS", "Archive returned duplicate IDs.");
  return ids;
}
export async function downloadLaserfiche(
  ctx: SourceContext,
  api: ArchiveApi,
  doc: LaserficheEntry,
  headers: Record<string, string>,
  portal: LaserfichePortal,
) {
  const base = portal.base,
    repoName = portal.repo;
  let url: string;
  if (doc.isEdoc) {
    url =
      base +
      `ElectronicFile.aspx?docid=${doc.entryId}&dbid=${portal.dbid}&repo=${repoName}`;
  } else {
    const info = await api<{ pageCount: number; hasImagedPages: boolean }>(
      "DocumentService.aspx/GetBasicDocumentInfo",
      { repoName, entryId: doc.entryId },
    );
    if (
      !info.hasImagedPages ||
      !Number.isSafeInteger(info.pageCount) ||
      info.pageCount < 1
    )
      throw new ScrapeError(
        "DOCUMENT_UNAVAILABLE",
        "Archive entry has no downloadable electronic file or scanned pages.",
      );
    const params = new URLSearchParams({
      key: String(doc.entryId),
      PageRange: `1 - ${info.pageCount}`,
      Watermark: "0",
      repo: repoName,
    });
    const generated = await ctx.http.get(
      base + "GeneratePDF10.aspx?" + params,
      1024 ** 2,
      { "content-type": "application/json", ...headers },
      "{}",
    );
    const key = generated.body.toString().split(/\r?\n/)[0]!.trim();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key))
      throw new ScrapeError(
        "PDF_GENERATION_FAILED",
        "Archive did not return a PDF generation key.",
      );
    let finished = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      const state = await api<{
        success: boolean;
        finished: boolean;
        errMsg: string | null;
      }>("DocumentService.aspx/PDFTransition", { Key: key });
      if (state.errMsg || !state.success)
        throw new ScrapeError(
          "PDF_GENERATION_FAILED",
          "Archive failed to generate the requested report.",
        );
      if (state.finished) {
        finished = true;
        break;
      }
      await ctx.http.wait(1000);
    }
    if (!finished)
      throw new ScrapeError(
        "PDF_GENERATION_TIMEOUT",
        "Archive PDF did not finish within 60 polls; resume to retry.",
      );
    url = base + `PDF10/${key}/${doc.entryId}`;
  }
  const response = await ctx.http.get(url, 100 * 1024 ** 2, headers);
  const extension = fileType(response.body);
  const digest = hash(response.body),
    local = `attachments/${digest}.${extension}`;
  atomicWrite(join(ctx.store.dir, local), response.body);
  return {
    download_status: "downloaded",
    local_path: local,
    sha256: digest,
    byte_count: response.body.length,
  };
}

/**
 * Enumerate every indexed entry whose County field names the requested county.
 * An empty template searches all templates; entries are then kept only when
 * their own name and metadata are about wells.
 */
export async function enumerateLaserfiche(
  ctx: SourceContext,
  api: ArchiveApi,
  dataset: string,
  template: string,
  portal: LaserfichePortal,
  headers: Record<string, string> = {},
) {
  const base = portal.base,
    repoName = portal.repo;
  const result = emptyResult(ctx.source.id, dataset),
    key = ctx.source.id + ":" + dataset;
  const county = countyShortName(ctx.geo);
  if (/["\[\]{}]/.test(county))
    throw new ScrapeError(
      "INVALID_INPUT",
      "County cannot be encoded in the archive query.",
    );
  const searchSyn = `({[${template}]:[County]="${county}"})`;
  if (/["\[\]{}]/.test(template))
    throw new ScrapeError("INVALID_INPUT", "Template name cannot be encoded.");
  const search = { repoName, searchSyn, sortColumn: "Id", sortOrder: 0 };
  try {
    checkRecordBudget(ctx);
    const size =
      ctx.store.get<number>(key + ":page-size") ??
      Math.min(ctx.config.batchSize, 100);
    const first = await api<Listing>("SearchService.aspx/GetSearchListing", {
      ...search,
      searchUuid: null,
      startIdx: 0,
      endIdx: Math.min(size, 20),
      getNewListing: true,
      displayInGridView: true,
    });
    if (
      first.failed ||
      first.errMsg ||
      !Array.isArray(first.results) ||
      !Number.isSafeInteger(first.hitCount) ||
      first.hitCount < 0 ||
      !first.searchUUID
    )
      throw new ScrapeError(
        "SCHEMA_CHANGED",
        "Archive search failed or omitted its count/session contract.",
      );
    const ids = validIds(
      await api<unknown>("SearchService.aspx/GetSearchListingIds", {
        ...search,
        searchUuid: first.searchUUID,
      }),
    );
    if (ids.length !== first.hitCount)
      throw new ScrapeError(
        "COUNT_MISMATCH",
        "Archive IDs do not reconcile with the reported search count.",
      );
    const previous = ctx.store.get<string[]>(key + ":ids");
    if (previous && !sameIds(previous, ids))
      throw new ScrapeError(
        "SOURCE_CHANGED",
        "Archive ID snapshot changed since the previous attempt; start a new run to avoid mixing enumerations.",
      );
    ctx.store.transaction(() => {
      ctx.store.set(key + ":ids", ids);
      ctx.store.set(key + ":page-size", size);
      ctx.store.set(key + ":metadata", first.columns);
    });
    ctx.store.raw(ctx.source.id, { dataset, searchSyn, ids });
    result.expected = ids.length;
    for (let offset = 0; offset < ids.length; offset += size) {
      const expected = ids.slice(offset, offset + size);
      if (expected.every((id) => ctx.store.done(ctx.source.id, dataset, id)))
        continue;
      checkRecordBudget(ctx);
      let raw = ctx.store.get<{ raw_path: string; raw_sha256: string }>(
        key + ":page:" + offset,
      );
      let listing: Listing;
      if (raw) {
        const bytes = readFileSync(join(ctx.store.dir, raw.raw_path));
        if (hash(bytes) !== raw.raw_sha256)
          throw new ScrapeError(
            "CHECKPOINT_CORRUPT",
            "Saved archive response hash does not match.",
          );
        listing = JSON.parse(bytes.toString()) as Listing;
      } else {
        listing =
          offset === 0 && first.results.length === expected.length
            ? first
            : await api<Listing>("SearchService.aspx/GetSearchListing", {
                ...search,
                searchUuid: first.searchUUID,
                startIdx: offset,
                endIdx: offset + size,
                getNewListing: false,
                displayInGridView: true,
              });
        if (
          listing.failed ||
          listing.errMsg ||
          !Array.isArray(listing.results) ||
          listing.hitCount !== ids.length
        )
          throw new ScrapeError(
            "SOURCE_CHANGED",
            "Archive page contract or count changed during enumeration.",
          );
        raw = ctx.store.raw(ctx.source.id, listing);
        ctx.store.set(key + ":page:" + offset, raw);
      }
      const actual = validIds(listing.results.map((d) => d.entryId));
      if (!sameIds(actual, expected))
        throw new ScrapeError(
          "PAGE_MISMATCH",
          "Archive page IDs differ from the saved enumeration.",
        );
      for (const doc of listing.results) {
        const native = String(doc.entryId);
        if (ctx.store.done(ctx.source.id, dataset, native)) continue;
        checkRecordBudget(ctx);
        if (!doc.name || !Array.isArray(doc.metadata))
          throw new ScrapeError(
            "SCHEMA_CHANGED",
            "Archive report metadata missing.",
          );
        const counties = doc.metadata.find((f) => f.name === "County")?.values;
        if (
          !Array.isArray(counties) ||
          counties.length !== 1 ||
          counties[0]!.trim().toLowerCase() !== county.toLowerCase()
        ) {
          ctx.store.transaction(() => {
            ctx.store.issue({
              source_id: ctx.source.id,
              dataset_id: dataset,
              native_id: native,
              code: "COUNTY_UNCERTAIN",
              ...raw,
            });
            ctx.store.task(ctx.source.id, dataset, native, "quarantined");
          });
          ctx.records++;
          continue;
        }
        const described = [
          doc.name,
          String(doc.entryProperties ?? ""),
          ...doc.metadata.flatMap((f) => f.values ?? []),
        ].join(" ");
        if (!template && !wellRelevance(described)) {
          // Other record types share the archive; they are counted, not stored.
          ctx.store.task(ctx.source.id, dataset, native, "excluded");
          ctx.records++;
          continue;
        }
        const recordId = entityId(ctx.source.id, dataset, native),
          docId = recordId + ":document";
        const shared: Entity = {
          id: recordId,
          source_id: ctx.source.id,
          dataset_id: dataset,
          native_id: native,
          acquisition_method: ctx.source.approach,
          county_geoid: ctx.geo.county_geoid,
          county_assignment_method: "source_county_field",
          source_url:
            base +
            `DocView.aspx?id=${native}&dbid=${portal.dbid}&repo=${repoName}`,
          retrieved_at: now(),
          ...raw,
          source_fields: doc,
          quality_flags: [
            "report_may_describe_multiple_wells",
            "report_text_not_extracted",
          ],
        };
        let downloaded: Record<string, unknown> = {
          download_status: "not_requested",
          local_path: null,
          sha256: null,
          byte_count: null,
        };
        let failure: ReturnType<typeof errorInfo> | undefined;
        if (ctx.config.attachments === "all") {
          try {
            downloaded = await downloadLaserfiche(
              ctx,
              api,
              doc,
              headers,
              portal,
            );
          } catch (error) {
            failure = errorInfo(error);
            downloaded.download_status = failure.code.startsWith("BUDGET")
              ? "over_budget"
              : "failed";
          }
        }
        ctx.store.transaction(() => {
          ctx.store.put("construction", {
            ...shared,
            record_id: recordId,
            record_type: /abandon/i.test(described)
              ? "abandonment_report"
              : /construct|complet|install|drill/i.test(described)
                ? "construction_report"
                : "well_report",
            title: doc.name,
          });
          ctx.store.put("documents", {
            ...shared,
            id: docId,
            document_id: docId,
            record_id: recordId,
            title: doc.name,
            ...downloaded,
          });
          ctx.store.put("relationships", {
            ...shared,
            id: recordId + ":report-link",
            from_id: docId,
            to_id: recordId,
            relationship_type: "describes_record",
            evidence: "same_source_entry_id",
          });
          ctx.store.task(
            ctx.source.id,
            dataset,
            native,
            failure ? "failed" : "accepted",
          );
          if (failure) ctx.store.issue({ entity_id: docId, ...failure });
        });
        ctx.records++;
        if (failure) {
          ctx.logger.log("document.failed", {
            source_id: ctx.source.id,
            native_id: native,
            error_code: failure.code,
          });
          if (
            failure.code.startsWith("BUDGET") ||
            ["CANCELLED", "NEEDS_AUTH", "BLOCKED"].includes(failure.code)
          )
            throw new ScrapeError(failure.code, failure.message);
        }
      }
      ctx.logger.log("batch.committed", {
        source_id: ctx.source.id,
        dataset_id: dataset,
        offset,
        count: listing.results.length,
      });
    }
    const finalIds = validIds(
      await api<unknown>("SearchService.aspx/GetSearchListingIds", {
        ...search,
        searchUuid: null,
      }),
    );
    if (!sameIds(ids, finalIds))
      throw new ScrapeError(
        "SOURCE_CHANGED",
        "Archive ID set changed during collection; stored records remain available.",
      );
    result.status = "success";
    result.completeness = "unverified";
    result.caveats.push(
      "All indexed report IDs reconciled at start and end. Source exposes no immutable attribute snapshot; unindexed documents are outside this search. Reports can describe multiple physical wells; text is not extracted.",
    );
  } catch (error) {
    try {
      ctx.http.check();
    } catch (budget) {
      error = budget;
    }
    const err = errorInfo(error);
    result.errors.push(err);
    result.status =
      err.code === "NEEDS_AUTH"
        ? "needs_auth"
        : err.code === "BLOCKED"
          ? "blocked"
          : "failed";
    result.completeness = "incomplete";
  }
  result.expected ??= ctx.store.get<string[]>(key + ":ids")?.length ?? null;
  for (const row of ctx.store.taskCounts(ctx.source.id, dataset)) {
    if (row.status !== "failed") result.fetched += Number(row.n);
    if (row.status === "accepted") result.accepted += Number(row.n);
    if (row.status === "quarantined") result.quarantined += Number(row.n);
    if (row.status === "excluded") result.excluded += Number(row.n);
  }
  result.unresolved =
    result.expected === null
      ? null
      : result.expected -
        result.accepted -
        result.quarantined -
        result.excluded;
  if (result.unresolved || result.quarantined) {
    if (result.status === "success")
      result.errors.push({
        code: "UNRESOLVED_RECORDS",
        message:
          "Some reports could not be downloaded or assigned to the county; see validation-errors.jsonl.",
      });
    if (result.status === "success") result.status = "partial";
    result.completeness = "incomplete";
  }
  if (result.fetched && result.status === "failed") result.status = "partial";
  ctx.store.result(result);
  ctx.logger.log("source.finished", {
    source_id: ctx.source.id,
    dataset_id: dataset,
    status: result.status,
    accepted: result.accepted,
  });
}

/**
 * Collect a WebLink archive the browser has already opened. The browser
 * session supplies the cookies; listing and downloads then use the portal's
 * own JSON services.
 */
export async function collectLaserfichePortal(
  ctx: SourceContext,
  context: BrowserContext,
  page: Page,
  portal: LaserfichePortal,
  dataset: string,
) {
  const timeout = ctx.http.opts.requestTimeoutMs;
  ctx.http.opts.requestTimeoutMs = 120000;
  try {
    if (await page.locator("input[type=password]").count())
      throw new ScrapeError(
        "NEEDS_AUTH",
        "Archive requires login. Save a session with auth login --url, then resume.",
      );
    const cookies = (await context.cookies(portal.base))
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
    if (cookies) ctx.logger.secrets.push(cookies);
    const headers: Record<string, string> = cookies ? { cookie: cookies } : {};
    const api: ArchiveApi = async <T>(path: string, body: unknown) => {
      const response = await ctx.http.postJson<{ data: T; error?: unknown }>(
        portal.base + path,
        body,
        headers,
      );
      if (!response || response.error || response.data === undefined)
        throw new ScrapeError(
          "SOURCE_ERROR",
          "Archive API returned an invalid envelope.",
        );
      return response.data;
    };
    await enumerateLaserfiche(ctx, api, dataset, "", portal, headers);
  } finally {
    ctx.http.opts.requestTimeoutMs = timeout;
  }
}
