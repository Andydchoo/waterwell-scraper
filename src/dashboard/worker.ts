import { join, resolve } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { collect } from "../core/runner.js";
import { atomicWrite, now, redact } from "../core/util.js";
import { errorInfo } from "../core/types.js";
import { lockRun } from "../storage/store.js";
import { type Job, jsonFile } from "./runs.js";

const dir = resolve(process.argv[2]!),
  root = resolve(process.argv[3]!);
const path = join(dir, "dashboard-job.json");
const job = JSON.parse(readFileSync(path, "utf8")) as Job;
const abort = new AbortController();
let release: (() => void) | undefined;
const save = () =>
  atomicWrite(
    path,
    JSON.stringify({ ...job, updatedAt: now(), pid: process.pid }),
  );
let timer: NodeJS.Timeout | undefined;
try {
  release = lockRun(join(root, ".dashboard", "worker"));
  job.state = "running";
  save();
  const tick = () => {
    const stop = jsonFile<{ nonce: string }>(join(dir, "stop-request.json"));
    if (stop?.nonce === job.nonce) {
      job.state = "stopping";
      abort.abort();
    }
    save();
  };
  timer = setInterval(tick, 1000);
  tick();
  const result = await collect(
    job.config,
    job.resume ? job.runId : undefined,
    true,
    { runId: job.runId, signal: abort.signal, unattended: true },
  );
  job.state = "finished";
  process.exitCode = result.summary.exit_code;
} catch (e) {
  job.state = "failed";
  job.error = String(redact(errorInfo(e).message));
  process.exitCode = 1;
} finally {
  if (timer) clearInterval(timer);
  save();
  release?.();
  // Nothing is tied to the dashboard HTTP connection or browser tab.
  if (!existsSync(path)) process.exitCode = 1;
}
