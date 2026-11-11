#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { ConfigSchema, VERSION, ScrapeError, errorInfo } from "./core/types.js";
import { collect, plan, runPath } from "./core/runner.js";
import { registry, portalManifest } from "./sources/registry.js";
import { Store, lockRun } from "./storage/store.js";
import { finalize } from "./storage/export.js";
import { redact } from "./core/util.js";
import {
  resolveCredentials,
  logout,
  prepareSessionDir,
} from "./credentials/index.js";
import { saveScopedSession } from "./credentials/interactive.js";
import { HttpClient } from "./transports/http.js";
const program = new Command()
  .name("well-scraper")
  .version(VERSION)
  .description(
    "Collect public water-well records with resumable local exports.",
  );
const output = (value: unknown) =>
  console.log(JSON.stringify(redact(value), null, 2));
function common(command: Command) {
  return command
    .option("--state <state>", "State name, abbreviation or FIPS")
    .option("--county <county>", "County name or FIPS")
    .option("--config <file>", "JSON configuration file")
    .option("--output <dir>", "Run directory")
    .option("--source <id...>", "Restrict collection to named collectors")
    .option(
      "--approach <name...>",
      "Restrict to api, browser and/or download (default: all three)",
    )
    .option(
      "--seed-url <url...>",
      "Public pages for the browser and download collectors to open",
    )
    .option(
      "--max-targets <count>",
      "Discovered targets per collector",
      Number,
    );
}
function config(options: Record<string, unknown>) {
  const file =
    typeof options.config === "string"
      ? JSON.parse(readFileSync(options.config, "utf8"))
      : {};
  const {
    config: _path,
    dryRun: _dry,
    probe: _probe,
    source,
    approach,
    seedUrl,
    ...cli
  } = options;
  void _path;
  void _dry;
  void _probe;
  const env = {
    ...(process.env.WELL_SCRAPER_OUTPUT
      ? { output: process.env.WELL_SCRAPER_OUTPUT }
      : {}),
    ...(process.env.WELL_SCRAPER_MAX_DURATION
      ? { maxDuration: Number(process.env.WELL_SCRAPER_MAX_DURATION) }
      : {}),
  };
  return ConfigSchema.parse({
    ...file,
    ...env,
    ...cli,
    ...(source ? { sources: source } : {}),
    ...(approach ? { approaches: approach } : {}),
    ...(seedUrl ? { seedUrls: seedUrl } : {}),
  });
}
common(program.command("sources"))
  .option("--probe", "Read source landing pages")
  .action(async (opts) => {
    const p = plan(config(opts));
    output(p);
    if (opts.probe) {
      for (const s of p.sources) {
        try {
          const client = new HttpClient({
            origins: [new URL(s.landingPage).origin],
            deadline: Date.now() + 30000,
            maxBytes: 2 * 1024 ** 2,
          });
          await client.get(s.landingPage, 2 * 1024 ** 2);
          output({
            source_id: s.id,
            reachable: true,
            adapter_implemented: s.status === "implemented",
            collection_verified: false,
          });
        } catch (e) {
          output({ source_id: s.id, ...errorInfo(e) });
        }
      }
    }
  });
common(program.command("collect"))
  .option("--dry-run", "Show plan without accessing sources")
  .option("--attachments <mode>", "all or none")
  .option("--json-array", "Also export JSON arrays")
  .option("--headful", "Show collection browser")
  .option(
    "--interactive-auth",
    "Allow up to five minutes for manual login when required",
  )
  .option("--credential-profile <name>", "Named local credential profile")
  .option("--max-duration <seconds>", "Attempt duration budget", Number)
  .option("--max-bytes <bytes>", "Attempt download budget", Number)
  .option("--max-records <count>", "Attempt source-record budget", Number)
  .option("--batch-size <count>", "Source page size (1-500)", Number)
  .option("--log-level <level>", "info, error or debug")
  .action(async (opts) => {
    const c = config(opts);
    if (opts.dryRun) {
      output(plan(c));
      return;
    }
    const r = await collect(c);
    output({
      run_id: r.summary.run_id,
      outcome: r.summary.outcome,
      counts: r.summary.counts,
      directory: r.dir,
    });
    process.exitCode = r.summary.exit_code;
  });
for (const command of ["resume", "report"])
  program
    .command(command)
    .requiredOption("--run-id <id>", "Existing run ID")
    .option("--output <dir>", "Run root", "./runs")
    .action(async (opts) => {
      const dir = runPath(opts.output, opts.runId);
      if (!existsSync(join(dir, "state.sqlite")))
        throw new ScrapeError("INVALID_INPUT", "Run does not exist.");
      if (command === "resume") {
        const s = new Store(dir);
        const c = s.get("config");
        s.close();
        // The run continues in the folder it was found in, even if that folder was moved.
        const r = await collect(
          { ...(c as object), output: opts.output },
          opts.runId,
        );
        output({
          run_id: opts.runId,
          outcome: r.summary.outcome,
          directory: r.dir,
        });
        process.exitCode = r.summary.exit_code;
      } else {
        const unlock = lockRun(dir);
        const s = new Store(dir);
        try {
          const r = finalize(
            s,
            s.get("outcome") === "running" || s.get("outcome") === "cancelled",
          );
          output(r);
          process.exitCode = r.exit_code;
        } finally {
          s.close();
          unlock();
        }
      }
    });
const auth = program
  .command("auth")
  .description("Use only source-scoped local credentials and sessions.");
for (const action of ["status", "login", "logout"])
  auth
    .command(action)
    .option("--source <id>", "Collector ID")
    .option("--url <url>", "Portal page found during a run that needs a login")
    .option("--credential-profile <name>", "Named profile")
    .action(async (opts) => {
      // Portals are discovered at run time, so a login is tied to the portal's address.
      const source = opts.url
        ? portalManifest(opts.url)
        : registry.find((s) => s.id === opts.source);
      if (!source)
        throw new ScrapeError(
          "INVALID_INPUT",
          "Give --url for a portal page, or --source for a collector.",
        );
      if (action === "status") {
        const c = resolveCredentials(source, opts.credentialProfile);
        output({
          source_id: source.id,
          status: c ? "configured" : "missing",
          provider: c?.provider,
          usability: "Requires a live source-specific collection probe.",
        });
        return;
      }
      if (action === "logout") {
        logout(source);
        output({ source_id: source.id, status: "application_session_removed" });
        return;
      }
      if (!process.stdin.isTTY)
        throw new ScrapeError(
          "NEEDS_AUTH",
          "Interactive login requires an attached terminal.",
        );
      prepareSessionDir();
      const { chromium } = await import("playwright");
      const browser = await chromium.launch({ headless: false });
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(source.landingPage);
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        try {
          await rl.question(
            "Complete login in the browser, then press Enter to save this source session: ",
            { signal: AbortSignal.timeout(300000) },
          );
        } finally {
          rl.close();
        }
        await saveScopedSession(source, context, page);
        output({
          source_id: source.id,
          status: "session_saved",
          usability:
            "Verified during the next collection; session capture alone does not prove authenticated access.",
        });
      } finally {
        await context.close();
        await browser.close();
      }
    });
program
  .command("discover")
  .requiredOption("--state <state>")
  .requiredOption("--county <county>")
  .action((opts) =>
    output({
      ...plan(config(opts)),
      note: "Collectors are the same for every county. Each one finds its services, pages and files for the county when a collection runs; see the discovery rows in summary.md.",
    }),
  );
program
  .command("serve")
  .description("Start the local dashboard and data API.")
  .option("--port <port>", "Port on 127.0.0.1", Number, 4317)
  .option("--output <dir>", "Run root", "./runs")
  .action(async (opts) => {
    const { createDashboard } = await import("./dashboard/server.js");
    const app = await createDashboard({ root: opts.output });
    await app.listen({ host: "127.0.0.1", port: opts.port });
    console.log(`Dashboard: http://127.0.0.1:${opts.port}`);
    console.log(`Data API:  http://127.0.0.1:${opts.port}/api/v1`);
  });
program.parseAsync().catch((e) => {
  const error = errorInfo(e);
  output({
    error_code: error.code,
    message:
      e.name === "ZodError"
        ? "Invalid configuration. Check fields and types in config/example.json."
        : error.message,
  });
  process.exitCode =
    error.code === "INVALID_INPUT" || e.name === "ZodError" ? 5 : 1;
});
