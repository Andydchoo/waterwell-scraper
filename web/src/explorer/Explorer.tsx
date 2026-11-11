import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  Search,
  Database,
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Download,
  FileText,
  RefreshCw,
  X,
  Trash2,
  Loader2,
  ChevronDown,
  ChevronRight,
  Filter,
  AlertTriangle,
} from "lucide-react";
import type { RunView } from "../../../src/dashboard/runs.js";
import {
  QuerySchema,
  type Query,
  type Snapshot,
  type Kind,
  type Page,
  type Capabilities,
  type Detail,
  type Link,
  type Job,
} from "../../../src/explorer/types.js";
import { api } from "../api";
import { go, readRoute, type Route } from "./state";
import "./explorer.css";
const names: Record<Kind, string> = {
  wells: "Wells",
  construction: "Construction & permits",
  observations: "Observations",
  documents: "Reports",
};
const fmt = (n: number) => n.toLocaleString();
const size = (n: number) =>
  n >= 1024 ** 2
    ? `${(n / 1024 ** 2).toFixed(1)} MB`
    : n >= 1024
      ? `${Math.round(n / 1024)} KB`
      : `${n} B`;
const when = (s: string) => (s ? new Date(s).toLocaleString() : "Unknown");
const value = (v: unknown) =>
  v === null
    ? "null"
    : v === undefined
      ? "Not provided"
      : typeof v === "string"
        ? v === ""
          ? '"" (empty string)'
          : v
        : JSON.stringify(v);
const sourceLabel = (s: string) => s.replaceAll("-", " ");
const safeUrl = (v: unknown) => {
  try {
    const u = new URL(String(v));
    return ["http:", "https:"].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
};
type Status = {
  eligible: boolean;
  active: boolean;
  revision: string | null;
  snapshots: Snapshot[];
  job: Job | null;
};
export function Explorer({ runs }: { runs: RunView[] }) {
  const [route, setRoute] = useState<Route>(readRoute),
    [status, setStatus] = useState<Status | null>(null),
    [caps, setCaps] = useState<Capabilities | null>(null),
    [page, setPage] = useState<Page | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [notice, setNotice] = useState("");
  const [exports, setExports] = useState<Job[]>([]),
    [exportOffset, setExportOffset] = useState(0),
    [exportNext, setExportNext] = useState<number | null>(null),
    [dialog, setDialog] = useState(false),
    [format, setFormat] = useState("csv"),
    [confirmClear, setConfirmClear] = useState(false);
  const [pendingSnapshot, setPendingSnapshot] = useState<string | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null),
    tableRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const change = () => {
      setRoute(readRoute());
      setError("");
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    titleRef.current?.focus();
  }, [route.record?.id]);
  useEffect(() => {
    if (!route.record && route.snapshot)
      requestAnimationFrame(() => tableRef.current?.focus());
  }, [route.record?.id, route.snapshot]);
  useEffect(() => {
    if (!route.run) {
      setStatus(null);
      return;
    }
    let active = true;
    const controller = new AbortController();
    const update = () =>
      api<Status>(`/api/runs/${route.run}/explorer`, undefined, {
        signal: controller.signal,
      })
        .then((s) => {
          if (active) setStatus(s);
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    void update();
    const timer = setInterval(update, 2000);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [route.run]);
  useEffect(() => {
    setPendingSnapshot(null);
    setStatus(null);
  }, [route.run]);
  useEffect(() => {
    if (!pendingSnapshot || !status) return;
    const snapshot = status.snapshots.find((s) => s.id === pendingSnapshot);
    if (!snapshot) return;
    setPendingSnapshot(null);
    go({
      ...route,
      snapshot: snapshot.id,
      record: undefined,
      query: { ...route.query, cursor: undefined },
      previous: [],
    });
  }, [pendingSnapshot, status, route]);
  useEffect(() => {
    if (route.snapshot || !route.run || !status?.snapshots.length) return;
    const s = status.snapshots[0]!;
    if (s.runKey !== route.run) return;
    const kind =
      (["wells", "construction", "observations", "documents"] as Kind[]).find(
        (k) => s.counts[k],
      ) ?? "wells";
    go(
      {
        ...route,
        snapshot: s.id,
        query: QuerySchema.parse({ kind }),
        previous: [],
      },
      true,
    );
  }, [status, route]);
  useEffect(() => {
    setCaps(null);
    setPage(null);
    setDetail(null);
    setExportOffset(0);
  }, [route.snapshot]);
  useEffect(() => {
    if (!route.snapshot) return;
    const c = new AbortController();
    void api<Capabilities>(
      `/api/explorer/${route.snapshot}/capabilities?kind=${route.query.kind}`,
      undefined,
      { signal: c.signal },
    )
      .then((capa) => {
        if (!c.signal.aborted) setCaps(capa);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [route.snapshot, route.query.kind]);
  useEffect(() => {
    if (!route.snapshot || route.record) return;
    const c = new AbortController();
    setLoading(true);
    setPage(null);
    const timer = setTimeout(() => {
      void api<Page>(`/api/explorer/${route.snapshot}/query`, route.query, {
        signal: c.signal,
      })
        .then((p) => {
          if (!c.signal.aborted) {
            setPage(p);
            setError("");
          }
        })
        .catch((e) => {
          if (!c.signal.aborted) setError(e.message);
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    }, 250);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [route.snapshot, route.query, route.record]);
  useEffect(() => {
    if (!route.snapshot || !route.record) {
      setDetail(null);
      return;
    }
    const c = new AbortController();
    setDetail(null);
    void api<Detail>(
      `/api/explorer/${route.snapshot}/record?` +
        new URLSearchParams(route.record),
      undefined,
      { signal: c.signal },
    )
      .then((d) => {
        if (!c.signal.aborted) setDetail(d);
      })
      .catch((e) => {
        if (!c.signal.aborted) setError(e.message);
      });
    return () => c.abort();
  }, [route.snapshot, route.record]);
  useEffect(() => {
    if (!route.snapshot) {
      setExports([]);
      return;
    }
    let active = true;
    const c = new AbortController();
    const update = () =>
      api<{ items: Job[]; next: number | null }>(
        `/api/explorer/exports?snapshot=${route.snapshot}&offset=${exportOffset}`,
        undefined,
        { signal: c.signal },
      )
        .then((x) => {
          if (active) {
            setExports(x.items);
            setExportNext(x.next);
          }
        })
        .catch(() => {});
    void update();
    const timer = setInterval(update, 2000);
    return () => {
      active = false;
      c.abort();
      clearInterval(timer);
    };
  }, [route.snapshot, exportOffset]);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const prepare = () =>
    act(async () => {
      const result = await api<{ snapshot: Snapshot | null; job: Job | null }>(
        `/api/runs/${route.run}/explorer`,
        {},
      );
      if (result.snapshot)
        go({
          ...route,
          snapshot: result.snapshot.id,
          record: undefined,
          query: { ...route.query, cursor: undefined },
          previous: [],
        });
      if (result.job) setPendingSnapshot(result.job.id);
      setStatus(await api<Status>(`/api/runs/${route.run}/explorer`));
    });
  const update = (query: Query) => {
    go({
      ...route,
      query: { ...query, cursor: undefined },
      previous: [],
      record: undefined,
    });
  };
  const open = (key: { kind: Kind; id: string }) => {
    go({ ...route, record: key });
  };
  const current =
      caps?.snapshot ?? status?.snapshots.find((s) => s.id === route.snapshot),
    selected = runs.find((r) => r.id === route.run);
  const stale =
    !!current && (!status?.revision || current.revision !== status.revision);
  const clear = () =>
    act(async () => {
      await api(`/api/explorer/${route.snapshot}`, undefined, {
        method: "DELETE",
      });
      setConfirmClear(false);
      setStatus(null);
      go({
        ...route,
        run: undefined,
        snapshot: undefined,
        record: undefined,
        previous: [],
      });
      setNotice(
        "Search cache cleared. Select a collection to prepare or open its data.",
      );
    });
  const submitExport = () =>
    act(async () => {
      const { cursor: _cursor, ...query } = route.query;
      const job = await api<Job>(`/api/explorer/${route.snapshot}/exports`, {
        query,
        format,
      });
      setExportOffset(0);
      setExports((e) => [job, ...e]);
      setDialog(false);
      setNotice("Export started. Its progress and download will appear below.");
    });
  return (
    <section className="explorer" aria-label="Data explorer">
      <div className="page-heading">
        <div>
          <div className="eyebrow">COLLECTED DATA, IN FOCUS</div>
          <h1 ref={titleRef} tabIndex={-1}>
            {route.record ? "Record details" : "Data explorer"}
          </h1>
          <p>
            Find source records, follow their evidence, and export exactly what
            you need.
          </p>
        </div>
        <span className="local-pill">
          <Database size={15} />
          Read-only records
        </span>
      </div>
      {error && (
        <div className="notice error" role="alert">
          <AlertTriangle size={18} />
          <span>{error}</span>
          <button
            className="icon-button"
            aria-label="Dismiss explorer error"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="notice info" role="status">
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notice"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="explorer-context panel">
        <label>
          Collection
          <select
            aria-label="Explorer collection"
            value={route.run ?? ""}
            onChange={(e) => {
              setStatus(null);
              setConfirmClear(false);
              go({
                run: e.target.value || undefined,
                query: QuerySchema.parse({}),
                previous: [],
              });
            }}
          >
            <option value="">Choose a saved collection</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {r.county}, {r.state} · {when(r.startedAt)} ·{" "}
                {r.runId.slice(-8)}
              </option>
            ))}
          </select>
        </label>
        {current && (
          <div className="snapshot-label">
            <strong>
              Attempt {current.attempt} · {current.outcome}
            </strong>
            <small>
              Captured {when(current.createdAt)} · {size(current.bytes)} search
              cache
            </small>
          </div>
        )}
        {route.run && (
          <button
            className="button secondary"
            disabled={
              busy || !status?.eligible || status.job?.state === "running"
            }
            onClick={() => void prepare()}
          >
            <RefreshCw size={15} />
            {route.snapshot ? "Refresh data" : "Prepare data"}
          </button>
        )}
      </div>
      {status?.job?.state === "running" && (
        <div className="notice info" role="status">
          <Loader2 size={18} className="spin" />
          <span>
            Preparing searchable records · {fmt(status.job.progress)}
            {status.job.total !== undefined
              ? ` / ${fmt(status.job.total)}`
              : ""}
          </span>
          <button
            className="text-button"
            onClick={() =>
              void act(async () => {
                await api(`/api/runs/${route.run}/explorer/cancel`, {});
                setStatus(await api(`/api/runs/${route.run}/explorer`));
              })
            }
          >
            Cancel preparation
          </button>
        </div>
      )}
      {status?.job?.error &&
        status.job.state !== "running" &&
        status.job.state !== "complete" && (
          <div className="notice warning" role="status">
            {status.job.error}
          </div>
        )}
      {stale && (
        <div className="notice warning" role="status">
          You are viewing saved attempt {current?.attempt}.{" "}
          {status?.active
            ? "Collection is running; these results remain unchanged."
            : !status?.eligible
              ? "Finish or recover the collection before refreshing these saved results."
              : "A different collection revision is available. Use Refresh data when ready."}
        </div>
      )}
      {!route.snapshot && (
        <div className="panel empty">
          <Database size={34} />
          <h2>
            {route.run
              ? "Prepare this collection for browsing"
              : "Start with a collection"}
          </h2>
          <p>
            {route.run
              ? status && !status.eligible
                ? "This collection must finish or be recovered before its first search snapshot can be prepared."
                : "A separate search cache keeps your original records unchanged. Partial collections can be explored too."
              : "Choose a saved collection above to search wells, permits, measurements and reports."}
          </p>
          {selected && <p>Collection outcome: {selected.outcome}</p>}
        </div>
      )}
      {route.snapshot && !route.record && (
        <>
          <div className="explorer-types" role="group" aria-label="Record type">
            {(Object.keys(names) as Kind[]).map((kind) => (
              <button
                className={route.query.kind === kind ? "selected" : ""}
                key={kind}
                onClick={() => {
                  setNotice(
                    "Record type changed; type-specific filters were cleared.",
                  );
                  update(
                    QuerySchema.parse({
                      kind,
                      q: route.query.q,
                      sources: route.query.sources,
                      pageSize: route.query.pageSize,
                    }),
                  );
                }}
              >
                {names[kind]} <span>{fmt(current?.counts[kind] ?? 0)}</span>
              </button>
            ))}
          </div>
          {caps && (
            <Filters
              query={route.query}
              caps={caps}
              onChange={update}
              onError={setError}
            />
          )}
          <div
            className="panel explorer-results"
            ref={tableRef}
            tabIndex={-1}
            aria-label="Search results"
            aria-busy={loading}
          >
            <div className="panel-heading">
              <div>
                <h2>
                  {loading
                    ? "Searching…"
                    : `${fmt(page?.total ?? 0)} matching records`}
                </h2>
                <p>
                  Source records may overlap. Search covers identifiers,
                  locations, names and titles.
                </p>
              </div>
              <button
                className="button primary"
                disabled={!page || loading || !!error}
                onClick={() => setDialog(true)}
              >
                <Download size={16} />
                Export results
              </button>
            </div>
            {page?.unknownDepth !== undefined &&
              ["wells", "construction"].includes(route.query.kind) && (
                <p className="explorer-hint">
                  {fmt(page.unknownDepth)} records under the other filters have
                  no comparable depth. Unknown units and censored values are
                  excluded from numeric ranges.
                </p>
              )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>
                      {route.query.kind === "observations"
                        ? "Parameter / record"
                        : route.query.kind === "documents"
                          ? "Report"
                          : "Record / identifier"}
                    </th>
                    <th>
                      {route.query.kind === "observations"
                        ? "Result"
                        : "Address / parcel"}
                    </th>
                    <th>
                      {route.query.kind === "documents"
                        ? "Download state"
                        : route.query.kind === "observations"
                          ? "Observed date"
                          : "Depth / date"}
                    </th>
                    <th>Source</th>
                    <th>
                      <span className="sr-only">Open record</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {page?.items.map((r) => (
                    <tr key={r.id}>
                      <td>
                        <button
                          className="text-button record-open"
                          onClick={() => open({ kind: r.kind, id: r.id })}
                        >
                          <strong>{r.parameter ?? r.title}</strong>
                        </button>
                        <small>
                          {r.file ? `File ${r.file}` : (r.well ?? r.native)}
                        </small>
                      </td>
                      <td>
                        {r.kind === "observations"
                          ? `${r.result ?? "Unknown"} ${r.unit ?? "(unit unknown)"}`
                          : (r.address ?? "Address not published")}
                        <small>
                          {r.parcel
                            ? `Parcel ${r.parcel}`
                            : r.kind === "observations"
                              ? "Original value and unit"
                              : "Parcel not published"}
                        </small>
                      </td>
                      <td>
                        {r.kind === "documents" ? (
                          <span className={`status status-${r.download}`}>
                            {r.download?.replaceAll("_", " ") ?? "unknown"}
                          </span>
                        ) : r.kind === "observations" ? (
                          (r.dateLabel ?? "Date unknown")
                        ) : (
                          (r.depthLabel ?? "Depth unknown")
                        )}
                        {r.kind !== "observations" && (
                          <small>
                            {r.dateLabel ??
                              (r.reports
                                ? `${r.reports} linked reports`
                                : "No verified date")}
                          </small>
                        )}
                      </td>
                      <td className="source-cell">
                        {sourceLabel(r.source)}
                        <small>{r.dataset}</small>
                      </td>
                      <td>
                        <button
                          className="icon-button"
                          aria-label={`View record ${r.id}`}
                          onClick={() => open({ kind: r.kind, id: r.id })}
                        >
                          <ChevronRight size={17} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!loading && page?.items.length === 0 && (
              <div className="empty">
                <Search size={27} />
                <h3>No matching records</h3>
                <p>
                  Try clearing filters, another identifier, or another record
                  type.
                </p>
              </div>
            )}
            <div className="explorer-pagination">
              <label>
                Rows per page
                <select
                  aria-label="Rows per page"
                  value={route.query.pageSize}
                  onChange={(e) =>
                    update({
                      ...route.query,
                      pageSize: Number(e.target.value) as 25 | 50 | 100,
                    })
                  }
                >
                  {[25, 50, 100].map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <span>Page {route.previous.length + 1}</span>
              <div>
                <button
                  className="button secondary small"
                  disabled={loading || !route.previous.length}
                  onClick={() => {
                    const previous = [...route.previous];
                    const cursor = previous.pop();
                    go({
                      ...route,
                      query: { ...route.query, cursor: cursor || undefined },
                      previous,
                    });
                  }}
                >
                  <ArrowLeft size={14} />
                  Previous
                </button>
                <button
                  className="button secondary small"
                  disabled={loading || !page?.nextCursor}
                  onClick={() =>
                    go({
                      ...route,
                      query: { ...route.query, cursor: page!.nextCursor! },
                      previous: [...route.previous, route.query.cursor ?? ""],
                    })
                  }
                >
                  Next
                  <ArrowRight size={14} />
                </button>
              </div>
            </div>
          </div>
        </>
      )}
      {route.record && route.snapshot && (
        <>
          <button
            className="text-button back"
            onClick={() => go({ ...route, record: undefined })}
          >
            <ArrowLeft size={15} />
            Back to results
          </button>
          {detail ? (
            <RecordDetail
              detail={detail}
              kind={route.record.kind}
              id={route.record.id}
              open={open}
              onError={setError}
            />
          ) : (
            <div className="empty" role="status">
              <Loader2 className="spin" />
              Loading record…
            </div>
          )}
        </>
      )}
      {route.snapshot && (
        <>
          <section className="panel export-history">
            <div className="panel-heading">
              <div>
                <h2>Filtered exports</h2>
                <p>
                  All matches from this saved snapshot. Original collection
                  exports stay unchanged.
                </p>
              </div>
            </div>
            {exports.length ? (
              <div className="download-list">
                {exports.map((job) => (
                  <div className="download-row" key={job.id}>
                    <FileText size={19} />
                    <div>
                      <strong>
                        {job.input?.format.toUpperCase()} ·{" "}
                        {names[job.input?.query.kind ?? "wells"]}
                      </strong>
                      <small>
                        {when(job.createdAt)} · {job.state} ·{" "}
                        {fmt(job.progress)}
                        {job.total !== undefined
                          ? ` / ${fmt(job.total)} rows`
                          : ""}
                      </small>
                      {job.error && (
                        <small className="source-error">{job.error}</small>
                      )}
                    </div>
                    <div className="export-actions">
                      {job.state === "complete" ? (
                        <>
                          <a
                            className="button secondary small"
                            href={`/api/explorer/exports/${job.id}/download?artifact=data`}
                            download
                          >
                            <Download size={14} />
                            Data
                          </a>
                          <a
                            className="text-button"
                            href={`/api/explorer/exports/${job.id}/download?artifact=manifest`}
                            download
                          >
                            Manifest
                          </a>
                        </>
                      ) : job.state === "running" ? (
                        <button
                          className="text-button"
                          onClick={() =>
                            void act(async () => {
                              await api(
                                `/api/explorer/exports/${job.id}/cancel`,
                                {},
                              );
                            })
                          }
                        >
                          Cancel
                        </button>
                      ) : (
                        <button
                          className="text-button"
                          onClick={() =>
                            void act(async () => {
                              const j = await api<Job>(
                                `/api/explorer/${route.snapshot}/exports`,
                                job.input,
                              );
                              setExports((e) => [j, ...e]);
                            })
                          }
                        >
                          Retry
                        </button>
                      )}
                      {job.state !== "running" && (
                        <button
                          className="icon-button"
                          aria-label={`Delete derived export ${job.id}`}
                          onClick={() =>
                            void act(async () => {
                              await api(
                                `/api/explorer/exports/${job.id}`,
                                undefined,
                                { method: "DELETE" },
                              );
                              setExports((e) =>
                                e.filter((j) => j.id !== job.id),
                              );
                            })
                          }
                        >
                          <Trash2 size={15} />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="explorer-hint">
                Filtered exports will appear here, including after you reopen
                the dashboard.
              </p>
            )}
            <div className="explorer-pagination">
              <button
                className="text-button"
                disabled={!exportOffset}
                onClick={() => setExportOffset(Math.max(0, exportOffset - 25))}
              >
                Previous exports
              </button>
              <button
                className="text-button"
                disabled={exportNext === null}
                onClick={() => setExportOffset(exportNext!)}
              >
                More exports
              </button>
            </div>
          </section>
          <div className="explorer-cache">
            <small>
              Search cache: {route.snapshot}. Original collection data is
              preserved.
            </small>
            <button
              className="text-button"
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 size={13} />
              Clear this search cache
            </button>
          </div>
        </>
      )}
      {dialog && (
        <Modal title="Export matching records" close={() => setDialog(false)}>
          {error && (
            <p className="source-error" role="alert">
              {error}
            </p>
          )}
          <p>
            Export{" "}
            <strong>
              {fmt(page?.total ?? 0)} {names[route.query.kind].toLowerCase()}
            </strong>{" "}
            from attempt {current?.attempt}. This includes every matching page.
          </p>
          <QueryChips query={route.query} />
          <label>
            File format
            <select
              aria-label="Export format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
            >
              <option value="csv">CSV — spreadsheet compatible</option>
              <option value="json">JSON — full array</option>
              <option value="jsonl">JSONL — one record per line</option>
            </select>
          </label>
          <p className="field-hint">
            Original fields and provenance are preserved. Related entities and
            report files are excluded. A companion manifest records the filters
            and file hash.
          </p>
          <button
            className="button primary full"
            disabled={busy}
            onClick={() => void submitExport()}
          >
            <Download size={16} />
            Create export
          </button>
        </Modal>
      )}
      {confirmClear && (
        <Modal
          title="Clear derived search cache"
          close={() => setConfirmClear(false)}
        >
          {error && (
            <p className="source-error" role="alert">
              {error}
            </p>
          )}
          <p>
            This removes only this searchable snapshot. Original records and
            reports remain in the collection. Delete its derived exports first;
            active readers or jobs prevent removal.
          </p>
          <button
            className="button secondary"
            disabled={busy}
            onClick={() => void clear()}
          >
            Clear search cache
          </button>
        </Modal>
      )}
    </section>
  );
}
function QueryChips({ query }: { query: Query }) {
  const { pageSize: _p, cursor: _c, ...rest } = query;
  return (
    <div className="query-chips">
      {Object.entries(rest)
        .filter(
          ([k, v]) =>
            !["kind", "sort", "direction"].includes(k) &&
            v !== undefined &&
            v !== "" &&
            (!Array.isArray(v) || v.length),
        )
        .map(([k, v]) => (
          <span key={k}>
            {k}: {typeof v === "string" ? v : JSON.stringify(v)}
          </span>
        ))}
    </div>
  );
}
function Filters({
  query,
  caps,
  onChange,
  onError,
}: {
  query: Query;
  caps: Capabilities;
  onChange: (q: Query) => void;
  onError: (s: string) => void;
}) {
  const [draft, setDraft] = useState(query),
    [advanced, setAdvanced] = useState(false);
  useEffect(() => setDraft(query), [query]);
  const patch = (p: Partial<Query>) => setDraft((d) => ({ ...d, ...p }));
  const apply = (e: FormEvent) => {
    e.preventDefault();
    const result = QuerySchema.safeParse({ ...draft, cursor: undefined });
    if (!result.success) {
      onError(result.error.issues[0]?.message ?? "Check the filters.");
      return;
    }
    onError("");
    onChange(result.data);
  };
  const distinct = [
    ...new Set(
      caps.sources.filter((s) => s.kind === query.kind).map((s) => s.source),
    ),
  ];
  const datasets = [
    ...new Set(
      caps.sources
        .filter(
          (s) =>
            s.kind === query.kind &&
            (!draft.sources.length || draft.sources.includes(s.source)),
        )
        .map((s) => s.dataset),
    ),
  ];
  return (
    <form className="panel explorer-filters" onSubmit={apply}>
      <div className="explorer-search">
        <label className="search-box">
          <Search size={18} />
          <input
            aria-label="Search records"
            placeholder="Address, parcel, well ID, file number, or report title…"
            maxLength={256}
            value={draft.q}
            onChange={(e) => patch({ q: e.target.value })}
          />
        </label>
        <button className="button primary" type="submit">
          Search
        </button>
        <button
          className="button secondary"
          type="button"
          aria-expanded={advanced}
          onClick={() => setAdvanced(!advanced)}
        >
          <Filter size={15} />
          Filters
          <ChevronDown size={13} />
        </button>
      </div>
      <div className="quick-filters">
        <label>
          Source
          <select
            value={draft.sources[0] ?? ""}
            onChange={(e) =>
              patch({
                sources: e.target.value ? [e.target.value] : [],
                datasets: [],
              })
            }
          >
            <option value="">All sources</option>
            {distinct.map((s) => (
              <option key={s} value={s}>
                {sourceLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Dataset
          <select
            value={draft.datasets[0] ?? ""}
            onChange={(e) =>
              patch({ datasets: e.target.value ? [e.target.value] : [] })
            }
          >
            <option value="">All datasets</option>
            {datasets.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <label>
          Sort by
          <select
            value={draft.sort}
            onChange={(e) => patch({ sort: e.target.value as Query["sort"] })}
          >
            <option value="id">Record ID</option>
            <option value="title">Title / name</option>
            <option value="address">Address</option>
            <option value="source">Source</option>
            {["wells", "construction"].includes(query.kind) && (
              <option value="depth">Known depth</option>
            )}
            {draft.date && <option value="date">Selected date meaning</option>}
          </select>
        </label>
        <label>
          Order
          <select
            value={draft.direction}
            onChange={(e) =>
              patch({ direction: e.target.value as "asc" | "desc" })
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
        </label>
      </div>
      {advanced && (
        <div className="advanced-filters">
          <label>
            Exact identifier type
            <select
              value={draft.identifier?.type ?? ""}
              onChange={(e) =>
                patch({
                  identifier: e.target.value
                    ? {
                        type: e.target.value as NonNullable<
                          Query["identifier"]
                        >["type"],
                        value: draft.identifier?.value ?? "",
                      }
                    : undefined,
                })
              }
            >
              <option value="">Any / off</option>
              {[
                "native",
                "well",
                "parcel",
                "file",
                "application",
                "facility",
              ].map((s) => (
                <option key={s} value={s}>
                  {s === "native"
                    ? "Agency/native ID"
                    : s === "file"
                      ? "Permit / file number"
                      : s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Exact identifier
            <input
              aria-label="Exact identifier value"
              disabled={!draft.identifier}
              value={draft.identifier?.value ?? ""}
              onChange={(e) =>
                patch({
                  identifier: { ...draft.identifier!, value: e.target.value },
                })
              }
            />
          </label>
          {(["statuses", "uses", "flags"] as const).map((key) => (
            <label key={key}>
              {key === "statuses"
                ? "Published status"
                : key === "uses"
                  ? "Published use"
                  : "Quality flag"}
              <select
                value={draft[key][0] ?? ""}
                onChange={(e) =>
                  patch({ [key]: e.target.value ? [e.target.value] : [] })
                }
              >
                <option value="">All</option>
                {caps[key].map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            </label>
          ))}
          {query.kind === "documents" ? (
            <label>
              Report download state
              <select
                value={draft.downloadStates[0] ?? ""}
                onChange={(e) =>
                  patch({
                    downloadStates: e.target.value ? [e.target.value] : [],
                  })
                }
              >
                <option value="">All states</option>
                {caps.downloadStates.map((s) => (
                  <option key={s} value={s}>
                    {s.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <label>
              Direct report association
              <select
                value={draft.reports ?? ""}
                onChange={(e) =>
                  patch({
                    reports: (e.target.value || undefined) as Query["reports"],
                  })
                }
              >
                <option value="">All records</option>
                <option value="any">Any explicitly linked report</option>
                <option value="downloaded">Downloaded linked report</option>
                <option value="none">No direct report link</option>
              </select>
            </label>
          )}
          {["wells", "construction"].includes(query.kind) && (
            <>
              <label>
                Depth filter
                <select
                  value={draft.depth?.mode ?? ""}
                  onChange={(e) =>
                    patch({
                      depth: e.target.value
                        ? {
                            mode: e.target.value as "known" | "unknown",
                            unit: "m",
                          }
                        : undefined,
                    })
                  }
                >
                  <option value="">Off</option>
                  <option value="known">Comparable numeric depth</option>
                  <option value="unknown">Unknown / unverified</option>
                </select>
              </label>
              {draft.depth?.mode === "known" && (
                <>
                  <label>
                    Depth unit
                    <select
                      value={draft.depth.unit}
                      onChange={(e) =>
                        patch({
                          depth: {
                            ...draft.depth!,
                            unit: e.target.value as "m" | "ft",
                          },
                        })
                      }
                    >
                      <option value="m">Meters</option>
                      <option value="ft">Feet</option>
                    </select>
                  </label>
                  <label>
                    Minimum depth
                    <input
                      type="number"
                      step="any"
                      value={draft.depth.min ?? ""}
                      onChange={(e) =>
                        patch({
                          depth: {
                            ...draft.depth!,
                            min:
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    Maximum depth
                    <input
                      type="number"
                      step="any"
                      value={draft.depth.max ?? ""}
                      onChange={(e) =>
                        patch({
                          depth: {
                            ...draft.depth!,
                            max:
                              e.target.value === ""
                                ? undefined
                                : Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                </>
              )}
            </>
          )}
          <label>
            Date meaning
            <select
              value={draft.date?.meaning ?? ""}
              onChange={(e) =>
                patch({
                  date: e.target.value
                    ? {
                        ...draft.date,
                        meaning: e.target.value as NonNullable<
                          Query["date"]
                        >["meaning"],
                      }
                    : undefined,
                  sort: draft.sort === "date" ? "id" : draft.sort,
                })
              }
            >
              <option value="">Off</option>
              {caps.dateMeanings.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          {draft.date && (
            <>
              <label>
                From date
                <input
                  type="date"
                  value={draft.date.from ?? ""}
                  onChange={(e) =>
                    patch({
                      date: {
                        ...draft.date!,
                        from: e.target.value || undefined,
                      },
                    })
                  }
                />
              </label>
              <label>
                Through date
                <input
                  type="date"
                  value={draft.date.to ?? ""}
                  onChange={(e) =>
                    patch({
                      date: { ...draft.date!, to: e.target.value || undefined },
                    })
                  }
                />
              </label>
            </>
          )}
          <p className="field-hint filter-note">
            Date meanings stay separate. Partial dates match overlapping
            calendar ranges. Unverified units are never guessed.
          </p>
        </div>
      )}
      <div className="filter-footer">
        <QueryChips query={query} />
        <button
          className="text-button"
          type="button"
          onClick={() => onChange(QuerySchema.parse({ kind: query.kind }))}
        >
          Clear filters
        </button>
        <button className="text-button" type="submit">
          Apply filters
          <ArrowRight size={14} />
        </button>
      </div>
    </form>
  );
}
function RecordDetail({
  detail,
  kind,
  id,
  open,
  onError,
}: {
  detail: Detail;
  kind: Kind;
  id: string;
  open: (k: { kind: Kind; id: string }) => void;
  onError: (m: string) => void;
}) {
  const [related, setRelated] = useState<{
      items: Link[];
      total: number;
      next: number | null;
    } | null>(null),
    [offset, setOffset] = useState(0),
    [viewReport, setViewReport] = useState(false),
    [fieldSearch, setFieldSearch] = useState("");
  useEffect(() => {
    setOffset(0);
    setViewReport(false);
    setFieldSearch("");
  }, [id]);
  useEffect(() => {
    const c = new AbortController();
    void api<{ items: Link[]; total: number; next: number | null }>(
      `/api/explorer/${detail.snapshot.id}/links?` +
        new URLSearchParams({ kind, id, offset: String(offset) }),
      undefined,
      { signal: c.signal },
    )
      .then(setRelated)
      .catch((e) => {
        if (!c.signal.aborted) onError(e.message);
      });
    return () => c.abort();
  }, [detail.snapshot.id, kind, id, offset, onError]);
  const { entity: e, projection: p } = detail,
    s = p.summary,
    source = safeUrl(e.source_url),
    report =
      `/api/explorer/${detail.snapshot.id}/report?` +
      new URLSearchParams({ id, mode: "inline" }),
    ext = String(e.local_path ?? "")
      .split(".")
      .at(-1);
  const preview = async () => {
    try {
      const r = await fetch(report, { method: "HEAD" });
      if (!r.ok) {
        let error = "The local report is unavailable or changed.";
        try {
          error = (await (await fetch(report)).json()).message ?? error;
        } catch {}
        throw new Error(error);
      }
      setViewReport(true);
    } catch (error) {
      onError((error as Error).message);
    }
  };
  return (
    <div className="record-detail">
      <section className="panel">
        <div className="panel-heading">
          <div>
            <div className="eyebrow">
              {names[kind]} · {s.dataset}
            </div>
            <h2 className="record-heading">{s.title}</h2>
            <p>
              {s.source} · Agency/native ID {s.native}
            </p>
          </div>
          {source && (
            <a
              className="button secondary small"
              href={source}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open source
              <ExternalLink size={14} />
            </a>
          )}
        </div>
        <dl className="record-facts">
          {[
            ["Address", s.address],
            ["Parcel", s.parcel],
            ["Well ID", s.well],
            ["Permit / file", s.file],
            ["Depth", s.depthLabel],
            ["Date", s.dateLabel],
            ["Status", s.status],
            ["Use", s.use],
            ["Parameter", s.parameter],
            ["Original result", s.result],
            ["Unit", s.unit],
            ["Download state", s.download],
          ]
            .filter(([, v]) => v !== null)
            .map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
        </dl>
        {s.flags.length > 0 && (
          <div className="record-flags">
            <strong>Quality flags</strong>
            {s.flags.map((f) => (
              <span key={f}>{f.replaceAll("_", " ")}</span>
            ))}
          </div>
        )}
        <details className="record-section">
          <summary>Field mappings and preserved dates</summary>
          <dl className="mapping-list">
            {Object.entries(p.lineage).map(([key, path]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{path}</dd>
              </div>
            ))}
            {p.identifiers.map((i, n) => (
              <div key={n}>
                <dt>
                  {i.type} · {i.value}
                </dt>
                <dd>{i.path}</dd>
              </div>
            ))}
            {p.dates.map((d, n) => (
              <div key={"d" + n}>
                <dt>
                  {d.meaning} · {value(d.raw)}
                </dt>
                <dd>
                  {d.precision} · {d.start} through {d.end} · {d.path}
                </dd>
              </div>
            ))}
          </dl>
        </details>
      </section>
      {kind === "documents" && (
        <section className="panel report-panel">
          <div className="panel-heading">
            <div>
              <h2>Original report</h2>
              <p>
                {s.download?.replaceAll("_", " ") ?? "Unknown download state"}
                {typeof e.byte_count === "number"
                  ? ` · ${size(e.byte_count)}`
                  : ""}
              </p>
            </div>
            {s.download === "downloaded" && (
              <div className="detail-actions">
                <button
                  className="button primary"
                  onClick={() => void preview()}
                >
                  <FileText size={16} />
                  View report
                </button>
                <a
                  className="button secondary"
                  href={report.replace("mode=inline", "mode=download")}
                  download
                >
                  <Download size={16} />
                  Download original
                </a>
              </div>
            )}
          </div>
          {s.download !== "downloaded" ? (
            <p className="explorer-hint">
              No downloaded file is available in this snapshot. Metadata remains
              searchable. Opening this record does not request a new download.
            </p>
          ) : (
            <>
              <p className="explorer-hint hash-text">
                SHA-256: {String(e.sha256)}
              </p>
              {viewReport && (
                <>
                  {ext === "pdf" ? (
                    <iframe
                      className="report-frame"
                      title="Original PDF report"
                      src={report}
                    />
                  ) : ["png", "jpg"].includes(ext ?? "") ? (
                    <img
                      className="report-image"
                      src={report}
                      alt="Original report image"
                    />
                  ) : (
                    <p className="explorer-hint">
                      This image format requires downloading.
                    </p>
                  )}
                  <p className="explorer-hint">
                    If your browser cannot display the original,{" "}
                    <a href={report} target="_blank" rel="noopener noreferrer">
                      open the report in a new tab
                    </a>{" "}
                    or download it above.
                  </p>
                </>
              )}
            </>
          )}
        </section>
      )}
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>
              Explicitly linked records{" "}
              <span className="count-label">{related?.total ?? 0}</span>
            </h2>
            <p>
              Links use published references. Shared addresses and names do not
              create associations.
            </p>
          </div>
        </div>
        {related?.items.length ? (
          <div className="related-list">
            {related.items.map((l, i) => (
              <div key={i}>
                <div>
                  {l.resolved ? (
                    <button
                      className="text-button"
                      onClick={() => open({ kind: l.kind!, id: l.id })}
                    >
                      {l.title ?? l.id}
                      <ArrowRight size={14} />
                    </button>
                  ) : (
                    <strong>{l.id} · Unresolved in this snapshot</strong>
                  )}
                  <small>
                    {l.kind ? names[l.kind] : "Unknown record type"} ·{" "}
                    {l.relation} · Evidence: {l.evidence}
                  </small>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="explorer-hint">
            No explicit related records are saved for this entry.
          </p>
        )}
        <div className="explorer-pagination">
          <button
            className="text-button"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            Previous links
          </button>
          <button
            className="text-button"
            disabled={related?.next == null}
            onClick={() => setOffset(related!.next!)}
          >
            More links
          </button>
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Original source fields</h2>
            <p>
              Values are preserved exactly. Search field names, then expand
              nested values.
            </p>
          </div>
          <label className="search-box">
            <Search size={15} />
            <input
              aria-label="Search source field names"
              placeholder="Find a field…"
              value={fieldSearch}
              onChange={(e) => setFieldSearch(e.target.value)}
            />
          </label>
        </div>
        <div className="source-field-list">
          {Object.entries((e.source_fields ?? {}) as Record<string, unknown>)
            .filter(([k]) =>
              k.toLowerCase().includes(fieldSearch.toLowerCase()),
            )
            .map(([k, v]) => (
              <Field key={k} name={k} data={v} />
            ))}
        </div>
      </section>
      <section className="panel">
        <div className="panel-heading">
          <div>
            <h2>Provenance & coverage</h2>
            <p>Source evidence stays attached to every result.</p>
          </div>
        </div>
        <dl className="record-facts provenance">
          {[
            "id",
            "source_id",
            "dataset_id",
            "native_id",
            "county_geoid",
            "county_assignment_method",
            "retrieved_at",
            "raw_path",
            "raw_sha256",
            "schema_version",
            "adapter_version",
            "identity_method",
          ].map((k) => (
            <div key={k}>
              <dt>{k.replaceAll("_", " ")}</dt>
              <dd>{value(e[k])}</dd>
            </div>
          ))}
        </dl>
        <p className="explorer-hint">
          Collection outcome: {detail.snapshot.outcome} · Attempt{" "}
          {detail.snapshot.attempt} · Search mapping version{" "}
          {detail.snapshot.version}. Counts are source records, not unique
          physical wells.
        </p>
        <details className="record-section">
          <summary>Captured source coverage</summary>
          <pre>{JSON.stringify(detail.snapshot.coverage, null, 2)}</pre>
        </details>
        <details className="record-section">
          <summary>Full original entity JSON</summary>
          <pre>{JSON.stringify(e, null, 2)}</pre>
        </details>
      </section>
    </div>
  );
}
function Field({ name, data }: { name: string; data: unknown }) {
  const [expanded, setExpanded] = useState(false);
  if (
    (data !== null && typeof data === "object") ||
    (typeof data === "string" && data.length > 300)
  )
    return (
      <div className="source-field">
        <button
          className="text-button"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{" "}
          {name}{" "}
          <small>
            {Array.isArray(data)
              ? `${data.length} items`
              : typeof data === "string"
                ? `${data.length} characters`
                : "object"}
          </small>
        </button>
        {expanded && (
          <pre>
            {typeof data === "string" ? data : JSON.stringify(data, null, 2)}
          </pre>
        )}
      </div>
    );
  return (
    <div className="source-field">
      <strong>{name}</strong>
      <code>{value(data)}</code>
    </div>
  );
}
function Modal({
  title,
  close,
  children,
}: {
  title: string;
  close: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    ref.current?.showModal();
    return () => previous?.focus();
  }, []);
  return (
    <dialog
      className="explorer-dialog"
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      aria-label={title}
    >
      <div className="dialog-heading">
        <h2>{title}</h2>
        <button
          className="icon-button"
          aria-label="Close dialog"
          onClick={close}
        >
          <X size={18} />
        </button>
      </div>
      {children}
    </dialog>
  );
}
