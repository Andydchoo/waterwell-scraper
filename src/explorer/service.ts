import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWrite, now, redact } from "../core/util.js";
import { lockRun } from "../storage/store.js";
import { alive, jsonFile } from "../dashboard/runs.js";
import {
  base,
  revision,
  snapshots,
  snapshotDir,
  getSnapshot,
} from "./snapshots.js";
import { exportDir } from "./exports.js";
import { ExplorerError, opaque, ExportSchema, type Job } from "./types.js";
export class ExplorerService {
  private running = new Map<string, Worker>();
  private queries = new Set<Worker>();
  private closing = false;
  constructor(public root: string) {
    mkdirSync(join(base(root), "explorer-jobs"), {
      recursive: true,
      mode: 0o700,
    });
    mkdirSync(join(base(root), "explorer-leases"), {
      recursive: true,
      mode: 0o700,
    });
  }
  private jobPath(id: string) {
    opaque(id);
    return join(base(this.root), "explorer-jobs", id + ".json");
  }
  job(id: string) {
    const job = jsonFile<Job>(this.jobPath(id));
    if (!job)
      throw new ExplorerError("NOT_FOUND", "Explorer job not found.", 404);
    if (job.state === "running" && !alive(job.pid)) {
      job.state = "interrupted";
      job.error = "The explorer worker stopped. Retry this operation.";
      job.updatedAt = now();
      atomicWrite(this.jobPath(id), JSON.stringify(job));
      const temp =
        job.type === "index"
          ? snapshotDir(this.root, id) + ".tmp"
          : exportDir(this.root, id) + ".tmp";
      rmSync(temp, { recursive: true, force: true });
    }
    return job;
  }
  jobs() {
    return readdirSync(join(base(this.root), "explorer-jobs"))
      .filter((n) => /^[a-f0-9-]{36}\.json$/.test(n))
      .flatMap((n) => {
        try {
          return [this.job(n.slice(0, -5))];
        } catch {
          return [];
        }
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  status(key: string) {
    const r = revision(this.root, key),
      available = snapshots(this.root, key);
    return {
      eligible: r.eligible,
      active: r.run.active,
      revision: r.revision,
      snapshots: available,
      job:
        this.jobs().find((j) => j.type === "index" && j.runKey === key) ?? null,
    };
  }
  private worker(operation: string, args: unknown) {
    const data = { root: this.root, operation, args };
    const url = new URL("./thread.js", import.meta.url);
    if (import.meta.url.endsWith(".ts")) {
      url.pathname = url.pathname.replace(/\.js$/, ".ts");
      return new Worker(
        `import('tsx/esm/api').then(({register})=>{register();return import(${JSON.stringify(url.href)})})`,
        { eval: true, workerData: data },
      );
    }
    return new Worker(url, { workerData: data });
  }
  async request(
    operation: string,
    args: { snapshot: string; [key: string]: unknown },
  ) {
    if (this.closing || this.queries.size >= 2)
      throw new ExplorerError(
        "BUSY",
        "Explorer is busy. Retry in a moment.",
        503,
      );
    const lease = join(
      base(this.root),
      "explorer-leases",
      randomUUID() + ".json",
    );
    const release = lockRun(join(base(this.root), "explorer-admission"));
    let worker: Worker;
    try {
      getSnapshot(this.root, args.snapshot);
      writeFileSync(
        lease,
        JSON.stringify({ pid: process.pid, snapshot: args.snapshot }),
        { mode: 0o600 },
      );
      worker = this.worker(operation, args);
    } catch (e) {
      rmSync(lease, { force: true });
      throw e;
    } finally {
      release();
    }
    this.queries.add(worker);
    try {
      return await new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          void worker.terminate();
          reject(
            new ExplorerError(
              "QUERY_TIMEOUT",
              "This query exceeded 15 seconds. Narrow your filters.",
              503,
            ),
          );
        }, 15000);
        const done = () => clearTimeout(timer);
        worker.on("message", (m) => {
          if (m.done) {
            done();
            if (m.error)
              reject(
                new ExplorerError(
                  m.error.code,
                  m.error.message,
                  m.error.status,
                ),
              );
            else resolve(m.value);
          }
        });
        worker.once("error", (e) => {
          done();
          reject(e);
        });
        worker.once("exit", () => {
          done();
          reject(
            new ExplorerError(
              "INTERRUPTED",
              "Explorer request interrupted.",
              503,
            ),
          );
        });
      });
    } finally {
      this.queries.delete(worker);
      await worker.terminate();
      rmSync(lease, { force: true });
    }
  }
  startIndex(runKey: string) {
    const release = lockRun(join(base(this.root), "explorer-admission"));
    try {
      const status = this.status(runKey);
      if (!status.eligible)
        throw new ExplorerError(
          "RUN_NOT_FINALIZED",
          "Finish or recover this collection before preparing its data.",
          409,
        );
      const current = status.snapshots.find(
        (s) => s.revision === status.revision,
      );
      if (current) return { snapshot: current, job: null };
      const existing = this.jobs().find(
        (j) => j.type === "index" && j.state === "running",
      );
      if (existing) {
        if (existing.runKey === runKey)
          return { snapshot: null, job: existing };
        throw new ExplorerError(
          "BUSY",
          "Another collection is being indexed. Wait or cancel it first.",
          503,
        );
      }
      const job = this.start("index", { runKey });
      return { snapshot: null, job };
    } finally {
      release();
    }
  }
  startExport(snapshot: string, input: unknown) {
    const parsed = ExportSchema.parse(input);
    const release = lockRun(join(base(this.root), "explorer-admission"));
    try {
      getSnapshot(this.root, snapshot);
      if (this.jobs().some((j) => j.type === "export" && j.state === "running"))
        throw new ExplorerError(
          "BUSY",
          "An export is already running. Wait or cancel it first.",
          503,
        );
      return this.start("export", { snapshot, input: parsed });
    } finally {
      release();
    }
  }
  private start(type: Job["type"], details: Partial<Job>) {
    if (this.closing)
      throw new ExplorerError("BUSY", "Dashboard is closing.", 503);
    const job: Job = {
      ...details,
      id: randomUUID(),
      type,
      state: "running",
      pid: process.pid,
      createdAt: now(),
      updatedAt: now(),
      progress: 0,
    };
    atomicWrite(this.jobPath(job.id), JSON.stringify(job));
    const worker = this.worker(type, { ...details, id: job.id });
    this.running.set(job.id, worker);
    let finished = false;
    const finish = (state: Job["state"], error?: string, code?: string) => {
      if (finished) return;
      finished = true;
      job.state = state;
      job.error = error;
      job.code = code;
      job.updatedAt = now();
      atomicWrite(this.jobPath(job.id), JSON.stringify(job));
      this.running.delete(job.id);
      if (state !== "complete") {
        const temp =
          type === "index"
            ? snapshotDir(this.root, job.id) + ".tmp"
            : exportDir(this.root, job.id) + ".tmp";
        rmSync(temp, { recursive: true, force: true });
      }
    };
    worker.on("message", (m) => {
      if (finished) return;
      if (m.done) {
        if (m.error)
          finish("failed", String(redact(m.error.message)), m.error.code);
        else finish("complete");
      } else {
        job.progress = m.progress;
        job.total = m.total;
        job.updatedAt = now();
        atomicWrite(this.jobPath(job.id), JSON.stringify(job));
      }
    });
    worker.once("error", (e) =>
      finish(
        "failed",
        String(redact(e instanceof Error ? e.message : String(e))),
      ),
    );
    worker.once("exit", () => {
      const requested = jsonFile<Job>(this.jobPath(job.id));
      finish(
        requested?.state === "cancelled" ? "cancelled" : "interrupted",
        "Operation stopped before publication. Retry when ready.",
      );
    });
    return job;
  }
  async cancel(id: string) {
    const job = this.job(id);
    if (job.state !== "running") return job;
    const w = this.running.get(id);
    if (!w)
      throw new ExplorerError(
        "BUSY",
        "This operation belongs to another dashboard server. Cancel it there.",
        409,
      );
    job.state = "cancelled";
    atomicWrite(this.jobPath(id), JSON.stringify(job));
    await w.terminate();
    return this.job(id);
  }
  async close() {
    this.closing = true;
    await Promise.all(
      [...this.running.values(), ...this.queries].map((w) => w.terminate()),
    );
  }
  removeSnapshot(id: string) {
    opaque(id);
    const release = lockRun(join(base(this.root), "explorer-admission"));
    try {
      if (
        this.jobs().some(
          (j) => j.snapshot === id && ["running", "complete"].includes(j.state),
        )
      )
        throw new ExplorerError(
          "IN_USE",
          "Delete completed derived exports and finish active exports before clearing this snapshot.",
          409,
        );
      const leases = join(base(this.root), "explorer-leases");
      for (const n of readdirSync(leases)) {
        const p = join(leases, n),
          l = jsonFile<{ pid: number; snapshot: string }>(p);
        if (l && alive(l.pid) && l.snapshot === id)
          throw new ExplorerError(
            "IN_USE",
            "This snapshot is being read. Try again in a moment.",
            409,
          );
        if (l && !alive(l.pid)) rmSync(p, { force: true });
      }
      rmSync(snapshotDir(this.root, id), { recursive: true, force: true });
      return { removed: true };
    } finally {
      release();
    }
  }
  removeExport(id: string) {
    const job = this.job(id);
    if (job.type !== "export")
      throw new ExplorerError("NOT_FOUND", "Export not found.", 404);
    if (job.state === "running")
      throw new ExplorerError(
        "IN_USE",
        "Cancel this export before deleting it.",
        409,
      );
    rmSync(exportDir(this.root, id), { recursive: true, force: true });
    rmSync(exportDir(this.root, id) + ".tmp", { recursive: true, force: true });
    rmSync(this.jobPath(id), { force: true });
    return { removed: true };
  }
}
