import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ConfigSchema, ScrapeError, type Config } from "../core/types.js";
import { newRunId, plan, runPath } from "../core/runner.js";
import { atomicWrite, now } from "../core/util.js";
import { lockRun } from "../storage/store.js";
import {
  findRun,
  jsonFile,
  readRun,
  runKey,
  runList,
  type Job,
} from "./runs.js";

export class Jobs {
  root: string;
  constructor(
    root: string,
    private worker = fileURLToPath(new URL("./worker.js", import.meta.url)),
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }
  launch(input: unknown, id?: string) {
    if (!existsSync(this.worker))
      throw new ScrapeError(
        "INVALID_INPUT",
        "Build the background worker first: npm run build",
      );
    const release = lockRun(join(this.root, ".dashboard", "admission"));
    try {
      if (runList(this.root).some((r) => r.active))
        throw new ScrapeError(
          "RUN_LOCKED",
          "A collection is already running. Stop it or wait before starting another.",
        );
      let config: Config, dir: string, runId: string;
      if (id) {
        dir = findRun(this.root, id);
        const run = readRun(this.root, dir);
        if (!run.resumable || !run.config)
          throw new ScrapeError("INVALID_INPUT", "This run cannot be resumed.");
        config = ConfigSchema.parse({
          ...run.config,
          output: dirname(dir),
          interactiveAuth: false,
          headful: false,
        });
        runId = run.runId;
      } else {
        config = ConfigSchema.parse(input);
        config = {
          ...config,
          output: this.root,
          headful: false,
          interactiveAuth: false,
        };
        // Runs are filed under the day they were collected.
        runId = newRunId(plan(config).geography);
        dir = runPath(this.root, runId);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      }
      const job: Job = {
        runId,
        nonce: randomUUID(),
        config,
        resume: !!id,
        state: "starting",
        createdAt: now(),
        updatedAt: now(),
      };
      if (existsSync(join(dir, "stop-request.json")))
        unlinkSync(join(dir, "stop-request.json"));
      atomicWrite(join(dir, "dashboard-job.json"), JSON.stringify(job));
      const child = spawn(process.execPath, [this.worker, dir, this.root], {
        cwd: fileURLToPath(new URL("../../..", import.meta.url)),
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.on("error", () => {
        const current = jsonFile<Job>(join(dir, "dashboard-job.json"));
        if (current?.nonce === job.nonce)
          atomicWrite(
            join(dir, "dashboard-job.json"),
            JSON.stringify({
              ...job,
              state: "failed",
              updatedAt: now(),
              error: "Could not start the collector process.",
            }),
          );
      });
      child.unref();
      return { id: runKey(this.root, dir), runId };
    } finally {
      release();
    }
  }
  stop(id: string) {
    const dir = findRun(this.root, id),
      run = readRun(this.root, dir),
      job = jsonFile<Job>(join(dir, "dashboard-job.json"));
    if (!run.stoppable || !job)
      throw new ScrapeError(
        "INVALID_INPUT",
        "This run has no active dashboard worker. CLI runs must be stopped in their terminal.",
      );
    atomicWrite(
      join(dir, "stop-request.json"),
      JSON.stringify({ nonce: job.nonce }),
    );
    // The worker is the sole writer of job state; its next heartbeat acknowledges stop.
    return { requested: true };
  }
}
