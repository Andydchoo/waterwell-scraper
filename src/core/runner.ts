import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  ConfigSchema,
  VERSION,
  SCHEMA_VERSION,
  emptyResult,
  errorInfo,
  ScrapeError,
  type Config,
  type Geography,
  type SourceManifest,
} from "./types.js";
import { now, hash, redact, atomicWrite, localDay } from "./util.js";
export { localDay };
import { Logger } from "./logger.js";
import { resolveGeography } from "../geography/index.js";
import { selectSources, registry } from "../sources/registry.js";
import { Store, lockRun } from "../storage/store.js";
import { finalize } from "../storage/export.js";
import { HttpClient } from "../transports/http.js";
import { collectArcgisServices } from "../sources/api.js";
import { collectUsgs } from "../sources/usgs.js";
import { collectWqp, collectCatalogFiles } from "../sources/downloads.js";
import { collectBrowserPortals } from "../sources/browser.js";
import {
  BOUNDARY_ORIGIN,
  fetchBoundary,
  type Boundary,
} from "../geography/boundary.js";
import type { SourceContext } from "../sources/context.js";
export function plan(input: unknown) {
  const config = ConfigSchema.parse(input);
  const geo = resolveGeography(config.state, config.county);
  return {
    config,
    geography: geo,
    sources: selectSources(geo, config.sources, config.approaches),
    day: localDay(),
  };
}
export function newRunId(geo: Geography, date = new Date()) {
  const place = `${geo.state}-${geo.county}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${localDay(date)}_${place}_${randomUUID().slice(0, 8)}`;
}
export function runPath(output: string, id: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(id))
    throw new ScrapeError(
      "INVALID_INPUT",
      "Run ID contains invalid path characters.",
    );
  const root = resolve(output);
  // Runs are filed under their collection day: <output>/<YYYY-MM-DD>/<run id>.
  // Older runs and explicitly named ones may sit directly in the output folder.
  const day = id.match(/^(\d{4}-\d{2}-\d{2})_/)?.[1];
  if (existsSync(join(root, id)) || !day) return join(root, id);
  return join(root, day, id);
}
export async function collect(
  input: unknown,
  resumeId?: string,
  quiet = false,
  control: { runId?: string; signal?: AbortSignal; unattended?: boolean } = {},
) {
  let config: Config, geo: Geography, sources: SourceManifest[], store: Store;
  const supplied = ConfigSchema.parse(input);
  let runId = resumeId ?? control.runId;
  if (!runId) {
    // Invalid geography is reported inside the run folder below, so fall back to a plain ID.
    try {
      runId = newRunId(resolveGeography(supplied.state, supplied.county));
    } catch {
      runId = `${localDay()}_invalid_${randomUUID().slice(0, 8)}`;
    }
  }
  const dir = runPath(supplied.output, runId);
  if (resumeId && !existsSync(join(dir, "state.sqlite")))
    throw new ScrapeError("INVALID_INPUT", "Run was not found.");
  if (!resumeId && existsSync(join(dir, "state.sqlite")))
    throw new ScrapeError(
      "RUN_EXISTS",
      "A run already exists at this location.",
    );
  const unlock = lockRun(dir);
  store = new Store(dir);
  try {
    if (resumeId) {
      config = ConfigSchema.parse(store.get<Config>("config"));
      // A run folder can be moved or copied; it continues where it is found.
      if (config.output !== supplied.output) {
        config = { ...config, output: supplied.output };
        store.set("config", config);
      }
      geo = store.get<Geography>("geo")!;
      sources = store.get<SourceManifest[]>("sources")!;
      if (
        !config ||
        store.get("schema_version") !== SCHEMA_VERSION ||
        store.get("application_version") !== VERSION
      )
        throw new ScrapeError(
          "INCOMPATIBLE_RESUME",
          "Run version/configuration is incompatible. Start a new run.",
        );
      if (
        hash(JSON.stringify(sources)) !== store.get("source_plan_hash") ||
        sources.some(
          (s) => registry.find((r) => r.id === s.id)?.version !== s.version,
        )
      )
        throw new ScrapeError(
          "INCOMPATIBLE_RESUME",
          "Source adapter version changed. Start a new run.",
        );
    } else {
      config = supplied;
      store.set("config", config);
      store.set("run_id", runId);
      store.set("started_at", now());
      store.set("day", runId.match(/^(\d{4}-\d{2}-\d{2})_/)?.[1] ?? localDay());
      try {
        geo = resolveGeography(config.state, config.county);
        sources = selectSources(geo, config.sources, config.approaches);
      } catch (e) {
        const error = errorInfo(e);
        store.set("input_error", error);
        const logger = new Logger(dir, runId, 1, quiet);
        logger.log("run.failed", { error_code: error.code });
        atomicWrite(
          join(dir, "summary.json"),
          JSON.stringify(
            { run_id: runId, outcome: "invalid", exit_code: 5, error },
            null,
            2,
          ),
        );
        atomicWrite(
          join(dir, "summary.md"),
          `# Collection failed\n\n${error.code}: ${error.message}\n`,
        );
        throw e;
      }
      store.set("geo", geo);
      store.set("sources", sources);
      store.set("source_plan_hash", hash(JSON.stringify(sources)));
      store.set("schema_version", SCHEMA_VERSION);
      store.set("application_version", VERSION);
      store.set(
        "exclusions",
        registry
          .filter((s) => !sources.some((x) => x.id === s.id))
          .map((s) => s.id),
      );
    }
    // Dashboard workers cannot service terminal prompts or interactive login windows.
    if (control.unattended)
      config = { ...config, headful: false, interactiveAuth: false };
    if (resumeId && store.get("outcome") === "running") finalize(store, true);
    const attempt = (store.get<number>("attempt") ?? 0) + 1;
    store.set("attempt", attempt);
    store.set("outcome", "running");
    store.set("attempt_started_at", now());
    store.set("attempt_ended_at", null);
    const logger = new Logger(dir, runId, attempt, quiet, config.logLevel);
    store.secrets = logger.secrets;
    logger.log("run.started", {
      county_geoid: geo.county_geoid,
      resume: !!resumeId,
    });
    const abort = new AbortController();
    const onSignal = () => abort.abort();
    control.signal?.addEventListener("abort", onSignal, { once: true });
    if (control.signal?.aborted) abort.abort();
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    const heartbeat = setInterval(
      () => logger.log("run.heartbeat", { records: store.count() }),
      30000,
    );
    heartbeat.unref();
    const http = new HttpClient({
      origins: [BOUNDARY_ORIGIN],
      intervalMs: config.intervalMs,
      maxBytes: config.maxBytes,
      deadline: Date.now() + config.maxDuration * 1000,
      signal: abort.signal,
      onEvent: (event, data) => logger.log(event, data),
    });
    const ctx: SourceContext = {
      config,
      geo,
      source: sources[0]!,
      store,
      logger,
      http,
      signal: abort.signal,
      runId,
      records: 0,
    };
    // Records saved by collectors that already finished in this attempt.
    let collected = 0;
    const progress = () =>
      store.set("progress", {
        requests: http.requests,
        browser_requests: http.browserRequests,
        bytes: http.bytes,
        retries: http.retries,
        records_this_attempt: collected + ctx.records,
        updated_at: now(),
      });
    progress();
    const progressTimer = setInterval(progress, 5000);
    progressTimer.unref();
    try {
      // The county boundary is looked up once per run and reused on resume.
      let boundary = store.get<Boundary>("boundary");
      if (
        !boundary &&
        sources.some((s) => s.mode !== "usgs" && s.mode !== "wqp")
      )
        try {
          boundary = await fetchBoundary(http, geo);
          store.set("boundary", boundary);
          store.raw("boundary", boundary.feature, "geojson");
        } catch (e) {
          logger.log("boundary.failed", { error_code: errorInfo(e).code });
        }
      ctx.boundary = boundary;
      // Preserve explicit entries for sources not reached after a budget or interruption.
      for (const s of sources)
        for (const d of s.datasets)
          if (
            !store
              .results()
              .some((r) => r.source_id === s.id && r.dataset_id === d)
          )
            store.result({
              ...emptyResult(s.id, d),
              status: "pending",
              errors: [
                {
                  code: "NOT_ATTEMPTED",
                  message: "Dataset has not completed yet.",
                },
              ],
            });
      // Every collector gets an equal share of what is left of the attempt's
      // record, time and download budgets, so one approach cannot use them all.
      // Whatever a collector leaves unused passes to the ones after it.
      const attemptDeadline = http.opts.deadline ?? Infinity;
      for (const [index, source] of sources.entries()) {
        if (abort.signal.aborted) break;
        const remaining = sources.length - index;
        collected += ctx.records;
        ctx.records = 0;
        ctx.config = {
          ...config,
          maxRecords: Math.max(
            0,
            Math.floor((config.maxRecords - collected) / remaining),
          ),
        };
        http.opts.deadline =
          Date.now() + Math.max(0, attemptDeadline - Date.now()) / remaining;
        http.opts.maxBytes =
          http.bytes + Math.max(0, config.maxBytes - http.bytes) / remaining;
        // A fresh list per source: origins approved during discovery do not carry over.
        http.opts.origins = [...source.origins];
        ctx.source = source;
        logger.log("source.started", { source_id: source.id });
        try {
          const execute = async () => {
            if (source.mode === "arcgis") await collectArcgisServices(ctx);
            else if (source.mode === "usgs") await collectUsgs(ctx);
            else if (source.mode === "wqp") await collectWqp(ctx);
            else if (source.mode === "files") await collectCatalogFiles(ctx);
            else if (source.mode === "browser")
              await collectBrowserPortals(ctx);
            else
              for (const dataset of source.datasets)
                store.result({
                  ...emptyResult(source.id, dataset),
                  status: "unsupported",
                  completeness: "incomplete",
                  errors: [
                    {
                      code: "SOURCE_NOT_IMPLEMENTED",
                      message: source.limitation ?? "No verified adapter.",
                    },
                  ],
                });
          };
          await execute();
        } catch (e) {
          const err = redact(errorInfo(e), logger.secrets) as {
            code: string;
            message: string;
          };
          for (const dataset of source.datasets)
            store.result({
              ...(store
                .results()
                .find(
                  (r) => r.source_id === source.id && r.dataset_id === dataset,
                ) ?? emptyResult(source.id, dataset)),
              status:
                (store
                  .results()
                  .find(
                    (r) =>
                      r.source_id === source.id && r.dataset_id === dataset,
                  )?.accepted ?? 0) > 0
                  ? "partial"
                  : err.code === "NEEDS_AUTH"
                    ? "needs_auth"
                    : err.code === "BLOCKED"
                      ? "blocked"
                      : "failed",
              completeness: "incomplete",
              errors: [err],
            });
          logger.log("source.failed", {
            source_id: source.id,
            error_code: err.code,
          });
        }
      }
    } finally {
      clearInterval(heartbeat);
      clearInterval(progressTimer);
      progress();
      control.signal?.removeEventListener("abort", onSignal);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      const transport = {
        requests: http.requests,
        browser_requests: http.browserRequests,
        browser_bytes: http.browserBytes,
        retries: http.retries,
        bytes: http.bytes,
        records_this_attempt: collected + ctx.records,
      };
      store.set("transport", transport);
      const cumulative =
        store.get<Record<string, number>>("cumulative_transport") ?? {};
      for (const [key, value] of Object.entries(transport))
        cumulative[key] = (cumulative[key] ?? 0) + value;
      store.set("cumulative_transport", cumulative);
    }
    const summary = finalize(store, abort.signal.aborted);
    logger.log("run.finished", {
      outcome: summary.outcome,
      summary_path: join(dir, "summary.md"),
    });
    return { dir, summary };
  } finally {
    store.close();
    unlock();
  }
}
