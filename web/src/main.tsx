import React, { Fragment, useEffect, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  CalendarDays,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  ChevronRight,
  Clock3,
  Database,
  Download,
  Droplets,
  FileText,
  FolderOpen,
  Globe2,
  History,
  LayoutDashboard,
  Loader2,
  MapPin,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Square,
  X,
  AlertTriangle,
  Play,
} from "lucide-react";
import type { RunView } from "../../src/dashboard/runs.js";
import type { SourceManifest } from "../../src/core/types.js";
import "./styles.css";
import { api, setSessionToken } from "./api";
import { Explorer } from "./explorer/Explorer";
import { openExplorer } from "./explorer/state";

type Place = {
  code: string;
  name: string;
  fips: string;
  counties: { name: string; geoid: string }[];
};
type Detail = RunView & {
  events: Record<string, unknown>[];
  artifacts: { name: string; bytes: number; rows?: number }[];
};
type Screen = "overview" | "history" | "new" | "detail" | "explorer";
const number = (n: number) => new Intl.NumberFormat("en-US").format(n);
const approachLabel = {
  api: "Public API",
  browser: "Browser navigation",
  download: "File download",
} as const;
const dayLabel = (day: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? new Date(day + "T12:00:00").toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Undated";
const date = (value: string) =>
  value
    ? new Date(value).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })
    : "Starting…";
const time = (value: string) =>
  value
    ? new Date(value).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "—";
const bytes = (n: number) =>
  n >= 1024 ** 3
    ? `${(n / 1024 ** 3).toFixed(1)} GB`
    : n >= 1024 ** 2
      ? `${(n / 1024 ** 2).toFixed(1)} MB`
      : n >= 1024
        ? `${Math.round(n / 1024)} KB`
        : `${n} B`;
const label = (value: string) =>
  value.replaceAll("_", " ").replace(/^./, (c) => c.toUpperCase());
const sum = (r: RunView) => Object.values(r.counts).reduce((a, b) => a + b, 0);
function Status({ value }: { value: string }) {
  return (
    <span className={`status status-${value}`}>
      <span className="status-dot" />
      {label(value)}
    </span>
  );
}
function Contours() {
  return (
    <svg
      className="contours"
      viewBox="0 0 450 280"
      fill="none"
      aria-hidden="true"
    >
      {Array.from({ length: 12 }, (_, i) => (
        <ellipse
          key={i}
          cx="335"
          cy="138"
          rx={36 + i * 18}
          ry={24 + i * 15}
          transform="rotate(-31 335 138)"
        />
      ))}
    </svg>
  );
}
function App() {
  useEffect(() => {
    const changed = () =>
      setScreen((s) =>
        location.hash.startsWith("#/explorer")
          ? "explorer"
          : s === "explorer"
            ? "overview"
            : s,
      );
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, []);
  const [screen, setScreen] = useState<Screen>(
      location.hash.startsWith("#/explorer") ? "explorer" : "overview",
    ),
    [geography, setGeography] = useState<Place[]>([]),
    [runs, setRuns] = useState<RunView[]>([]),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<Detail | null>(null),
    [error, setError] = useState(""),
    [connected, setConnected] = useState(true),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [query, setQuery] = useState(""),
    [tab, setTab] = useState("overview"),
    [filter, setFilter] = useState("all");
  // No place is preselected in code: the first entry of the loaded list is used.
  const [state, setState] = useState(""),
    [county, setCounty] = useState(""),
    [sources, setSources] = useState<SourceManifest[]>([]),
    [sourceIds, setSourceIds] = useState<string[]>([]),
    [sourceLoading, setSourceLoading] = useState(false),
    [sourceError, setSourceError] = useState("");
  const [attachments, setAttachments] = useState("all"),
    [duration, setDuration] = useState("120"),
    [maxRecords, setMaxRecords] = useState("1000000"),
    [maxBytes, setMaxBytes] = useState("5"),
    [profile, setProfile] = useState(""),
    [seedPages, setSeedPages] = useState("");
  useEffect(() => {
    let active = true;
    void api<{ token: string; geography: Place[] }>("/api/bootstrap")
      .then((data) => {
        if (active) {
          setSessionToken(data.token);
          setGeography(data.geography);
          const first = data.geography[0];
          if (first) {
            setState(first.code);
            setCounty(first.counties[0]?.geoid ?? "");
          }
        }
      })
      .catch((e) => {
        if (active) {
          setError(e.message);
          setConnected(false);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const data = await api<{ runs: RunView[] }>("/api/runs");
        if (active) {
          setRuns(data.runs);
          setConnected(true);
          setLoaded(true);
        }
      } catch {
        if (active) {
          setConnected(false);
          setLoaded(true);
        }
      }
    };
    void update();
    const timer = setInterval(update, 2500);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  useEffect(() => {
    if (!selected) return;
    let active = true;
    const update = async () => {
      try {
        const data = await api<Detail>(`/api/runs/${selected}`);
        if (active) setDetail(data);
      } catch (e) {
        if (active) setError((e as Error).message);
      }
    };
    void update();
    const timer = setInterval(update, 2000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [selected]);
  useEffect(() => {
    if (!county) return;
    let active = true;
    setSources([]);
    setSourceIds([]);
    setSourceLoading(true);
    setSourceError("");
    void api<{ sources: SourceManifest[] }>(
      `/api/sources?state=${state}&county=${county}`,
    )
      .then((data) => {
        if (active) {
          setSources(data.sources);
          setSourceIds(data.sources.map((s) => s.id));
        }
      })
      .catch((e) => {
        if (active) setSourceError(e.message);
      })
      .finally(() => {
        if (active) setSourceLoading(false);
      });
    return () => {
      active = false;
    };
  }, [state, county]);
  const activeRuns = runs.filter((r) => r.active),
    wells = runs.reduce((n, r) => n + (r.counts.wells ?? 0), 0),
    reports = runs.reduce((n, r) => n + (r.counts.documents ?? 0), 0);
  const navigate = (next: Screen) => {
    if (location.hash.startsWith("#/explorer"))
      history.pushState(null, "", location.pathname);
    setScreen(next);
    setError("");
    if (next !== "detail") {
      setSelected(null);
      setDetail(null);
    }
    window.scrollTo(0, 0);
  };
  const open = (id: string) => {
    setDetail(null);
    setSelected(id);
    setTab("overview");
    setScreen("detail");
    setError("");
    window.scrollTo(0, 0);
  };
  const action = async (kind: "resume" | "stop") => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/runs/${selected}/${kind}`, {});
      setDetail(await api<Detail>(`/api/runs/${selected}`));
      setRuns((await api<{ runs: RunView[] }>("/api/runs")).runs);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const start = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api<{ id: string }>("/api/runs", {
        state,
        county,
        sources: sourceIds,
        attachments,
        jsonArray: true,
        maxDuration: Number(duration) * 60,
        maxRecords: Number(maxRecords),
        maxBytes: Math.round(Number(maxBytes) * 1024 ** 3),
        ...(profile.trim() ? { credentialProfile: profile.trim() } : {}),
        // Pages are supplied per collection; one address per line.
        seedUrls: seedPages
          .split(/\s+/)
          .map((url) => url.trim())
          .filter(Boolean),
      });
      setRuns((await api<{ runs: RunView[] }>("/api/runs")).runs);
      open(result.id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const displayed = runs.filter(
    (r) =>
      `${r.county} ${r.state} ${r.runId}`
        .toLowerCase()
        .includes(query.toLowerCase()) &&
      (filter === "all" ||
        (filter === "active"
          ? r.active
          : [
              "partial",
              "failed",
              "blocked",
              "needs_auth",
              "interrupted",
              "cancelled",
              "unsupported",
            ].includes(r.outcome))),
  );
  function RunTable({ items }: { items: RunView[] }) {
    return (
      <div className="table-wrap">
        <table className="runs-table">
          <thead>
            <tr>
              <th>Collection</th>
              <th>Started</th>
              <th>Saved rows</th>
              <th>Status</th>
              <th>
                <span className="sr-only">Open collection</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((run, index) => (
              <Fragment key={run.id}>
                {/* Collections are grouped under the day they were collected. */}
                {run.day !== items[index - 1]?.day && (
                  <tr className="day-row">
                    <th colSpan={5} scope="rowgroup">
                      <CalendarDays size={15} /> {dayLabel(run.day)}
                      <span>
                        {items.filter((r) => r.day === run.day).length}{" "}
                        collection
                        {items.filter((r) => r.day === run.day).length === 1
                          ? ""
                          : "s"}{" "}
                        ·{" "}
                        {number(
                          items
                            .filter((r) => r.day === run.day)
                            .reduce((n, r) => n + sum(r), 0),
                        )}{" "}
                        saved rows
                      </span>
                    </th>
                  </tr>
                )}
                <tr>
                  <td>
                    <button className="run-title" onClick={() => open(run.id)}>
                      <span className="county-icon">
                        <MapPin size={17} />
                      </span>
                      <span>
                        <strong>
                          {run.county}, {run.state}
                        </strong>
                        <small>
                          {run.attachments === "all"
                            ? "Records + reports"
                            : "Records only"}{" "}
                          <span>·</span> Attempt {run.attempt || 1}
                        </small>
                      </span>
                    </button>
                  </td>
                  <td>
                    <span className="cell-date">{time(run.startedAt)}</span>
                  </td>
                  <td className="numeric">{number(sum(run))}</td>
                  <td>
                    <Status value={run.outcome} />
                  </td>
                  <td>
                    <button
                      className="icon-button"
                      aria-label={`Open ${run.runId}`}
                      onClick={() => open(run.id)}
                    >
                      <ChevronRight size={18} />
                    </button>
                  </td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
        {!items.length && (
          <div className="empty">
            <FolderOpen size={30} />
            <h3>
              {runs.length
                ? "No matching collections"
                : "Your first collection starts here"}
            </h3>
            <p>
              {runs.length
                ? "Try another county name or status."
                : "Choose a county to collect its available public well records."}
            </p>
            {!runs.length && (
              <button
                className="button primary"
                onClick={() => navigate("new")}
              >
                <Plus size={16} />
                New collection
              </button>
            )}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button
          className="brand"
          onClick={() => navigate("overview")}
          aria-label="Waterwell home"
        >
          <span className="brand-mark">
            <Droplets size={25} />
          </span>
          <span>
            waterwell<span className="brand-caption">COLLECTION WORKSPACE</span>
          </span>
        </button>
        <div className="nav-caption">WORKSPACE</div>
        <nav aria-label="Main navigation">
          <button
            className={screen === "overview" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("overview")}
          >
            <LayoutDashboard size={19} />
            Overview
          </button>
          <button
            className={
              screen === "history" || screen === "detail"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() => navigate("history")}
          >
            <History size={19} />
            Collections<span className="nav-count">{runs.length}</span>
          </button>
          <button
            className={screen === "new" ? "nav-item active" : "nav-item"}
            onClick={() => navigate("new")}
          >
            <Plus size={19} />
            New collection
          </button>
          <button
            className={screen === "explorer" ? "nav-item active" : "nav-item"}
            onClick={() => openExplorer()}
          >
            <Database size={19} />
            Data explorer
          </button>
        </nav>
        <div className="sidebar-note">
          <Globe2 size={23} />
          <strong>Public data. Clear provenance.</strong>
          <p>
            Government well records, original reports, and a traceable source
            for every result.
          </p>
        </div>
        <div className="sidebar-footer">
          <span className={`connection-dot ${connected ? "" : "offline"}`} />
          <div>
            <strong>
              {connected ? "Local workspace" : "Server disconnected"}
            </strong>
            <small>Runs on this computer</small>
          </div>
          <span className="version">v0.1</span>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={13} />
            <strong>
              {screen === "overview"
                ? "Overview"
                : screen === "new"
                  ? "New collection"
                  : screen === "explorer"
                    ? "Data explorer"
                    : screen === "detail"
                      ? "Collection details"
                      : "Collections"}
            </strong>
          </div>
          <div className="local-pill">
            <ShieldCheck size={15} />
            Local only
          </div>
        </header>
        <main>
          {!connected && (
            <div className="notice warning" role="status">
              <AlertTriangle size={18} />
              <span>
                Cannot reach the local server. Start it with{" "}
                <code>npm run ui</code>. Running collectors continue in the
                background.
              </span>
            </div>
          )}
          {error && (
            <div className="notice error" role="alert">
              <AlertTriangle size={18} />
              <span>{error}</span>
              <button
                className="icon-button"
                aria-label="Dismiss error"
                onClick={() => setError("")}
              >
                <X size={16} />
              </button>
            </div>
          )}
          {(screen === "overview" || screen === "history") && (
            <>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    {screen === "overview"
                      ? "YOUR DATA, GROUNDED"
                      : "COLLECTION LIBRARY"}
                  </div>
                  <h1>
                    {screen === "overview"
                      ? "Your groundwater workspace."
                      : "Every collection, in one place."}
                  </h1>
                  <p>
                    {screen === "overview"
                      ? "Collect public well data. Follow its progress. Know what’s covered."
                      : "Review results, pick up interrupted runs, and download your data."}
                  </p>
                </div>
                <button
                  className="button primary"
                  onClick={() => navigate("new")}
                >
                  <Plus size={17} />
                  New collection
                </button>
              </div>
              {screen === "overview" && (
                <>
                  <div className="metric-grid">
                    <Metric
                      title="Collections"
                      value={number(runs.length)}
                      note="Saved in this workspace"
                      icon={<FolderOpen size={19} />}
                    />
                    <Metric
                      title="Active runs"
                      value={number(activeRuns.length)}
                      note={
                        activeRuns.length
                          ? "Collecting in the background"
                          : "Ready when you are"
                      }
                      icon={<Activity size={19} />}
                      accent
                    />
                    <Metric
                      title="Well records"
                      value={number(wells)}
                      note="Source records · may overlap"
                      icon={<Droplets size={19} />}
                    />
                    <Metric
                      title="Reports indexed"
                      value={number(reports)}
                      note="Metadata and available files"
                      icon={<FileText size={19} />}
                    />
                  </div>
                  <section className="feature-band">
                    <Contours />
                    <div className="feature-copy">
                      <span className="eyebrow">FROM SOURCE TO WORKSPACE</span>
                      <h2>A clearer view of what’s below.</h2>
                      <p>
                        Choose a state and county. We’ll show you the available
                        sources and keep a record of what was collected—and what
                        wasn’t.
                      </p>
                      <button
                        className="text-button light"
                        onClick={() => navigate("new")}
                      >
                        Explore available sources <ArrowRight size={16} />
                      </button>
                    </div>
                    <div className="feature-seal">
                      <Droplets size={33} />
                      <span>
                        TRACEABLE
                        <br />
                        BY DESIGN
                      </span>
                    </div>
                  </section>
                </>
              )}
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>
                      {screen === "overview"
                        ? "Recent collections"
                        : "Collection history"}{" "}
                      <span className="count-label">{runs.length}</span>
                    </h2>
                    <p>
                      {screen === "overview"
                        ? "Your latest field of work."
                        : "All saved runs, including earlier CLI collections."}
                    </p>
                  </div>
                  {screen === "overview" ? (
                    <button
                      className="text-button"
                      onClick={() => navigate("history")}
                    >
                      View all collections <ArrowRight size={15} />
                    </button>
                  ) : (
                    <div className="table-tools">
                      <label className="search-box">
                        <Search size={16} />
                        <input
                          aria-label="Search collections"
                          placeholder="Search county or run…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <select
                        aria-label="Filter collections"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">All statuses</option>
                        <option value="active">Active</option>
                        <option value="attention">Needs attention</option>
                      </select>
                    </div>
                  )}
                </div>
                {loaded ? (
                  <RunTable
                    items={screen === "overview" ? runs.slice(0, 5) : displayed}
                  />
                ) : (
                  <div className="empty">
                    <Loader2 className="spin" size={25} />
                    <p>Loading your workspace…</p>
                  </div>
                )}
              </section>
              {screen === "overview" && (
                <div className="bottom-grid">
                  <section className="mini-card">
                    <span className="mini-icon">
                      <MapPin size={19} />
                    </span>
                    <div>
                      <h3>Coverage starts with the source.</h3>
                      <p>
                        Any state and county can be collected. Sources are found
                        for the place you choose when the collection runs.
                      </p>
                      <button
                        className="text-button"
                        onClick={() => navigate("new")}
                      >
                        Check a county <ArrowUpRight size={14} />
                      </button>
                    </div>
                  </section>
                  <section className="mini-card">
                    <span className="mini-icon">
                      <ShieldCheck size={19} />
                    </span>
                    <div>
                      <h3>Progress stays with you.</h3>
                      <p>
                        Closing this page won’t stop a collection. Checkpoints
                        preserve completed work so interrupted runs can resume.
                      </p>
                      <span className="quiet-label">
                        Stored locally · Explicit coverage gaps
                      </span>
                    </div>
                  </section>
                </div>
              )}
            </>
          )}
          {screen === "new" && (
            <>
              <button
                className="text-button back"
                onClick={() => navigate("overview")}
              >
                <ArrowLeft size={15} />
                Back to overview
              </button>
              <div className="page-heading">
                <div>
                  <div className="eyebrow">START WITH A PLACE</div>
                  <h1>New collection</h1>
                  <p>
                    Select a county and choose the public records you want to
                    collect.
                  </p>
                </div>
              </div>
              <form onSubmit={start} className="collection-layout">
                <div className="form-stack">
                  <section className="panel form-panel">
                    <div className="section-title">
                      <span className="step">01</span>
                      <div>
                        <h2>Choose your location</h2>
                        <p>Coverage varies by county and publishing agency.</p>
                      </div>
                    </div>
                    <div className="field-grid">
                      <label>
                        State
                        <select
                          aria-label="State"
                          value={state}
                          onChange={(e) => {
                            setState(e.target.value);
                            setCounty(
                              geography.find((g) => g.code === e.target.value)
                                ?.counties[0]?.geoid ?? "",
                            );
                          }}
                        >
                          {geography.map((g) => (
                            <option key={g.code} value={g.code}>
                              {g.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        County
                        <select
                          aria-label="County"
                          value={county}
                          onChange={(e) => setCounty(e.target.value)}
                        >
                          {geography
                            .find((g) => g.code === state)
                            ?.counties.map((c) => (
                              <option key={c.geoid} value={c.geoid}>
                                {c.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </div>
                  </section>
                  <section className="panel form-panel">
                    <div className="section-title">
                      <span className="step">02</span>
                      <div>
                        <h2>Choose how to collect</h2>
                        <p>
                          Every approach runs by default: public APIs, browser
                          navigation and file downloads. Each one finds its
                          sources for the county when the collection runs;
                          overlapping records are kept.
                        </p>
                      </div>
                    </div>
                    {sourceLoading ? (
                      <div className="loading-row">
                        <Loader2 className="spin" size={17} />
                        Checking source coverage…
                      </div>
                    ) : sourceError ? (
                      <div className="notice error" role="alert">
                        {sourceError}
                      </div>
                    ) : (
                      <div className="sources-list">
                        {sources.map((s) => (
                          <label
                            key={s.id}
                            className={`source-option ${sourceIds.includes(s.id) ? "selected" : ""}`}
                          >
                            <input
                              type="checkbox"
                              checked={sourceIds.includes(s.id)}
                              onChange={(e) =>
                                setSourceIds(
                                  e.target.checked
                                    ? [...sourceIds, s.id]
                                    : sourceIds.filter((id) => id !== s.id),
                                )
                              }
                            />
                            <span>
                              <span className="source-option-title">
                                {s.title}
                                <span
                                  className={`source-tag ${s.status === "candidate" ? "gap" : ""}`}
                                >
                                  {approachLabel[s.approach]}
                                </span>
                              </span>
                              <span className="source-agency">{s.agency}</span>
                              <small>{s.limitation}</small>
                            </span>
                          </label>
                        ))}
                      </div>
                    )}
                  </section>
                  <section className="panel form-panel">
                    <div className="section-title">
                      <span className="step">03</span>
                      <div>
                        <h2>Collection options</h2>
                        <p>
                          Limits apply to each attempt. You can resume
                          unfinished work.
                        </p>
                      </div>
                    </div>
                    <fieldset className="download-options">
                      <legend>Report files</legend>
                      <label
                        className={
                          attachments === "all"
                            ? "radio-card selected"
                            : "radio-card"
                        }
                      >
                        <input
                          type="radio"
                          name="reports"
                          checked={attachments === "all"}
                          onChange={() => setAttachments("all")}
                        />
                        <span>
                          <strong>Include reports</strong>
                          <small>Save available PDFs and report images.</small>
                        </span>
                      </label>
                      <label
                        className={
                          attachments === "none"
                            ? "radio-card selected"
                            : "radio-card"
                        }
                      >
                        <input
                          type="radio"
                          name="reports"
                          checked={attachments === "none"}
                          onChange={() => setAttachments("none")}
                        />
                        <span>
                          <strong>Metadata only</strong>
                          <small>
                            Collect report details without file downloads.
                          </small>
                        </span>
                      </label>
                    </fieldset>
                    <div className="field-grid limits">
                      <label>
                        Time limit <span>(minutes)</span>
                        <input
                          type="number"
                          min="1"
                          max="1440"
                          required
                          value={duration}
                          onChange={(e) => setDuration(e.target.value)}
                        />
                      </label>
                      <label>
                        Download limit <span>(GB)</span>
                        <input
                          type="number"
                          min="0.01"
                          max="1000"
                          step="0.01"
                          required
                          value={maxBytes}
                          onChange={(e) => setMaxBytes(e.target.value)}
                        />
                      </label>
                      <label>
                        Source record limit
                        <input
                          type="number"
                          min="1"
                          max="10000000"
                          required
                          value={maxRecords}
                          onChange={(e) => setMaxRecords(e.target.value)}
                        />
                      </label>
                      <label>
                        Local credential profile <span>(optional)</span>
                        <input
                          placeholder="Profile name"
                          value={profile}
                          onChange={(e) => setProfile(e.target.value)}
                        />
                      </label>
                      <label>
                        Pages to open <span>(optional)</span>
                        <input
                          type="text"
                          inputMode="url"
                          placeholder="https://agency.example/wells"
                          value={seedPages}
                          onChange={(e) => setSeedPages(e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="field-hint">
                      Add public agency pages (separated by spaces) for the
                      browser and file collectors to open for this county.
                    </p>
                    <p className="field-hint">
                      Credentials stay in your local configuration. If a source
                      needs login, use the CLI’s auth login command, then resume
                      here.
                    </p>
                  </section>
                </div>
                <aside className="collection-summary">
                  <div className="summary-icon">
                    <MapPin size={23} />
                  </div>
                  <div className="eyebrow">COLLECTION SUMMARY</div>
                  <h2>
                    {geography
                      .find((g) => g.code === state)
                      ?.counties.find((c) => c.geoid === county)?.name ??
                      "Choose a county"}
                  </h2>
                  <p>{geography.find((g) => g.code === state)?.name}</p>
                  <dl>
                    <div>
                      <dt>Selected sources</dt>
                      <dd>{sourceIds.length}</dd>
                    </div>
                    <div>
                      <dt>Report files</dt>
                      <dd>
                        {attachments === "all" ? "Included" : "Metadata only"}
                      </dd>
                    </div>
                    <div>
                      <dt>Export formats</dt>
                      <dd>CSV + JSON</dd>
                    </div>
                    <div>
                      <dt>Runs on</dt>
                      <dd>This computer</dd>
                    </div>
                  </dl>
                  <div className="summary-note">
                    <ShieldCheck size={17} />
                    <p>
                      Every result retains its source. Missing or unavailable
                      data is reported explicitly.
                    </p>
                  </div>
                  {activeRuns.length > 0 && (
                    <p className="queue-note">
                      A collection is already running. Stop it or wait before
                      starting another.
                    </p>
                  )}
                  <button
                    className="button primary full"
                    disabled={
                      busy ||
                      !connected ||
                      sourceLoading ||
                      !!sourceError ||
                      !sourceIds.length ||
                      activeRuns.length > 0
                    }
                    type="submit"
                  >
                    {busy ? (
                      <Loader2 size={17} className="spin" />
                    ) : (
                      <Play size={16} />
                    )}
                    Start collection
                  </button>
                  <small className="summary-footnote">
                    You can close this page while it runs.
                  </small>
                </aside>
              </form>
            </>
          )}
          {screen === "explorer" && geography.length > 0 && (
            <Explorer runs={runs} />
          )}
          {screen === "detail" && (
            <>
              <button
                className="text-button back"
                onClick={() => navigate("history")}
              >
                <ArrowLeft size={15} />
                All collections
              </button>
              {!detail ? (
                <div className="empty">
                  <Loader2 className="spin" size={26} />
                  <p>Loading collection…</p>
                </div>
              ) : (
                <>
                  <div className="page-heading">
                    <div>
                      <div className="eyebrow">{detail.runId}</div>
                      <h1>
                        {detail.county}, {detail.state}
                      </h1>
                      <p>
                        Started {date(detail.startedAt)} at{" "}
                        {time(detail.startedAt)}{" "}
                        <span className="dot-divider">·</span> Attempt{" "}
                        {detail.attempt || 1}
                      </p>
                    </div>
                    <div className="detail-actions">
                      <button
                        className="button secondary"
                        onClick={() => openExplorer(detail.id)}
                      >
                        <Search size={15} />
                        Explore data
                      </button>
                      <Status value={detail.outcome} />
                      {detail.stoppable ? (
                        <button
                          className="button secondary"
                          disabled={busy || detail.outcome === "stopping"}
                          onClick={() => void action("stop")}
                        >
                          <Square size={15} />
                          {detail.outcome === "stopping"
                            ? "Stopping safely…"
                            : "Stop safely"}
                        </button>
                      ) : (
                        detail.resumable && (
                          <button
                            className="button primary"
                            disabled={busy || activeRuns.length > 0}
                            onClick={() => void action("resume")}
                          >
                            {busy ? (
                              <Loader2 className="spin" size={16} />
                            ) : (
                              <RefreshCw size={16} />
                            )}
                            Resume collection
                          </button>
                        )
                      )}
                    </div>
                  </div>
                  {detail.active && (
                    <div className="notice info">
                      <Activity size={18} />
                      <span>
                        {detail.outcome === "stopping"
                          ? "Finishing the current operation and writing exports."
                          : "Collecting in the background. This view refreshes every two seconds."}
                        {!detail.managed
                          ? " This run was started from the CLI; use its terminal to stop it."
                          : ""}
                      </span>
                    </div>
                  )}
                  {detail.outcome === "interrupted" && (
                    <div className="notice warning">
                      <AlertTriangle size={18} />
                      <span>
                        The worker stopped unexpectedly. Committed records are
                        preserved; resume will recover its checkpoint and
                        finalize the interrupted attempt.
                      </span>
                    </div>
                  )}
                  {detail.error && (
                    <div className="notice error">
                      <AlertTriangle size={18} />
                      <span>{detail.error}</span>
                    </div>
                  )}
                  <div className="metric-grid">
                    <Metric
                      title="Well records"
                      value={number(detail.counts.wells ?? 0)}
                      note="Inventory and monitoring"
                      icon={<Droplets size={19} />}
                    />
                    <Metric
                      title="Construction records"
                      value={number(detail.counts.construction ?? 0)}
                      note="Permits and report records"
                      icon={<Database size={19} />}
                    />
                    <Metric
                      title="Observations"
                      value={number(detail.counts.observations ?? 0)}
                      note="Published measurements"
                      icon={<Activity size={19} />}
                    />
                    <Metric
                      title="Reports indexed"
                      value={number(detail.counts.documents ?? 0)}
                      note={
                        detail.attachments === "none"
                          ? "File downloads not requested"
                          : "See download status in exports"
                      }
                      icon={<FileText size={19} />}
                    />
                  </div>
                  <div
                    className="transport-summary"
                    aria-label="Attempt progress"
                  >
                    <span>
                      <Download size={14} />
                      {detail.transport.bytes === undefined
                        ? "—"
                        : bytes(detail.transport.bytes)}{" "}
                      downloaded
                    </span>
                    <span>
                      {detail.transport.requests === undefined
                        ? "—"
                        : number(
                            detail.transport.requests +
                              (detail.transport.browser_requests ?? 0),
                          )}{" "}
                      requests
                    </span>
                    <span>
                      {detail.transport.retries === undefined
                        ? "—"
                        : number(detail.transport.retries)}{" "}
                      retries
                    </span>
                    <span>
                      Current / last attempt
                      {detail.active ? " · refreshed every 5 seconds" : ""}
                    </span>
                  </div>
                  <div
                    className="tabs"
                    role="tablist"
                    aria-label="Collection information"
                  >
                    {["overview", "activity", "downloads"].map((t) => (
                      <button
                        role="tab"
                        aria-selected={tab === t}
                        key={t}
                        onClick={() => setTab(t)}
                        className={tab === t ? "selected" : ""}
                      >
                        {t === "overview" ? (
                          <Database size={16} />
                        ) : t === "activity" ? (
                          <Activity size={16} />
                        ) : (
                          <Download size={16} />
                        )}{" "}
                        {label(t)}
                        {t === "downloads" && (
                          <span>{detail.artifacts.length}</span>
                        )}
                      </button>
                    ))}
                  </div>
                  {tab === "overview" && (
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Source coverage</h2>
                          <p>
                            Counts reflect source records, not unique physical
                            wells. Unknown totals are shown as —.
                          </p>
                        </div>
                        <span className="quiet-label">
                          {detail.sources.length} datasets
                        </span>
                      </div>
                      {detail.sources.length ? (
                        <div className="table-wrap">
                          <table className="sources-table">
                            <thead>
                              <tr>
                                <th>Source / dataset</th>
                                <th>Accepted</th>
                                <th>Expected</th>
                                <th>Remaining</th>
                                <th>Status</th>
                              </tr>
                            </thead>
                            <tbody>
                              {detail.sources.map((s) => (
                                <tr key={`${s.source_id}:${s.dataset_id}`}>
                                  <td>
                                    <strong>
                                      {detail.sourcePlan.find(
                                        (p) => p.id === s.source_id,
                                      )?.title ?? s.source_id}
                                    </strong>
                                    <small>
                                      {s.dataset_id} · Completeness:{" "}
                                      {label(s.completeness)}
                                    </small>
                                    {s.errors.map((e, i) => (
                                      <p className="source-error" key={i}>
                                        {e.message}
                                      </p>
                                    ))}
                                    {s.quarantined > 0 && (
                                      <p className="source-error">
                                        {number(s.quarantined)} records
                                        quarantined for review.
                                      </p>
                                    )}
                                    {s.caveats.map((c, i) => (
                                      <p className="source-caveat" key={i}>
                                        {c}
                                      </p>
                                    ))}
                                  </td>
                                  <td className="numeric">
                                    {number(s.accepted)}
                                  </td>
                                  <td className="numeric">
                                    {s.expected === null
                                      ? "—"
                                      : number(s.expected)}
                                  </td>
                                  <td className="numeric">
                                    {s.unresolved === null
                                      ? "—"
                                      : number(s.unresolved)}
                                  </td>
                                  <td>
                                    <Status
                                      value={
                                        s.status === "pending" && detail.active
                                          ? "pending"
                                          : s.status
                                      }
                                    />
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <div className="empty">
                          {detail.active ? (
                            <Loader2 className="spin" size={22} />
                          ) : (
                            <Database size={22} />
                          )}
                          <p>
                            {detail.active
                              ? "Preparing source checkpoints…"
                              : "No source results were saved for this attempt."}
                          </p>
                        </div>
                      )}
                    </section>
                  )}
                  {tab === "activity" && (
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Collection activity</h2>
                          <p>
                            The latest 60 events. Download the full event log
                            for the complete history.
                          </p>
                        </div>
                        <span className="quiet-label">
                          <Clock3 size={14} /> Local time
                        </span>
                      </div>
                      <div className="event-list">
                        {detail.events.length ? (
                          detail.events
                            .slice()
                            .reverse()
                            .map((e, i) => (
                              <div
                                className="event"
                                key={`${e.timestamp}-${i}`}
                              >
                                <span
                                  className={`event-point ${e.level === "error" ? "bad" : ""}`}
                                />
                                <time>{time(String(e.timestamp))}</time>
                                <div>
                                  <strong>
                                    {label(
                                      String(e.event).replaceAll(".", " "),
                                    )}
                                  </strong>
                                  <p>
                                    {[
                                      e.source_id,
                                      e.dataset_id,
                                      e.status,
                                      e.error_code,
                                      e.count !== undefined
                                        ? `${e.count} records`
                                        : null,
                                    ]
                                      .filter(Boolean)
                                      .join(" · ") ||
                                      "Collection lifecycle event"}
                                  </p>
                                </div>
                              </div>
                            ))
                        ) : (
                          <div className="empty">
                            <Activity size={24} />
                            <p>Events will appear when collection begins.</p>
                          </div>
                        )}
                      </div>
                    </section>
                  )}
                  {tab === "downloads" && (
                    <section className="panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Exports & reports</h2>
                          <p>
                            {detail.active
                              ? "Exports become available when this attempt finishes."
                              : "Original report files and structured exports from the last finalized attempt."}
                          </p>
                        </div>
                        <span className="quiet-label">
                          <ShieldCheck size={15} /> SHA-256 in manifest
                        </span>
                      </div>
                      {detail.artifacts.length ? (
                        <div className="download-list">
                          {detail.artifacts.map((f) => (
                            <div className="download-row" key={f.name}>
                              <span className="file-icon">
                                <FileText size={19} />
                              </span>
                              <div>
                                <strong>{f.name}</strong>
                                <small>
                                  {bytes(f.bytes)}
                                  {f.rows !== undefined
                                    ? ` · ${number(f.rows)} rows`
                                    : ""}
                                </small>
                              </div>
                              {detail.active ? (
                                <span className="quiet-label">
                                  Available after stop
                                </span>
                              ) : (
                                <a
                                  className="button secondary small"
                                  href={`/api/runs/${detail.id}/download?file=${encodeURIComponent(f.name)}`}
                                  download
                                >
                                  <Download size={15} />
                                  Download
                                </a>
                              )}
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="empty">
                          <FolderOpen size={27} />
                          <p>
                            Exports are written when an attempt finishes or
                            stops safely.
                          </p>
                        </div>
                      )}
                    </section>
                  )}
                  <p className="detail-footer">
                    <ShieldCheck size={14} /> Data stays on this computer.
                    Source fields and collection limits are preserved in the
                    exports.
                  </p>
                </>
              )}
            </>
          )}
          <footer className="page-footer">
            <span>
              <Droplets size={14} /> Waterwell
            </span>
            <span>Public sources. Preserved evidence.</span>
          </footer>
        </main>
      </div>
    </div>
  );
}
function Metric({
  title,
  value,
  note,
  icon,
  accent = false,
}: {
  title: string;
  value: string;
  note: string;
  icon: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <div className={`metric ${accent ? "accent" : ""}`}>
      <div className="metric-top">
        <span>{title}</span>
        <span className="metric-icon">{icon}</span>
      </div>
      <strong className="metric-value">{value}</strong>
      <span className="metric-note">
        {accent && <span className="tiny-dot" />}
        {note}
      </span>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
