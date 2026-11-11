import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { now, redact } from "./util.js";
export class Logger {
  secrets: string[] = [];
  private started = Date.now();
  constructor(
    public dir: string,
    public runId: string,
    public attempt: number,
    public quiet = false,
    public logLevel = "info",
  ) {}
  log(event: string, data: Record<string, unknown> = {}) {
    const row = redact(
      {
        timestamp: now(),
        level: event.endsWith("failed") ? "error" : "info",
        event,
        run_id: this.runId,
        attempt_id: this.attempt,
        source_id: null,
        task_id: null,
        stage: event.split(".")[0],
        duration_ms: Date.now() - this.started,
        ...data,
      },
      this.secrets,
    );
    appendFileSync(join(this.dir, "events.jsonl"), JSON.stringify(row) + "\n", {
      mode: 0o600,
    });
    if (
      !this.quiet &&
      (this.logLevel === "debug" ||
        (this.logLevel === "error"
          ? /failed|required/.test(event)
          : /finished|failed|required|started/.test(event)))
    )
      process.stderr.write(JSON.stringify(row) + "\n");
  }
}
