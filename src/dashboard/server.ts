import Fastify from "fastify";
import { explorerRoutes } from "../explorer/routes.js";
import { dataApiRoutes } from "../api/routes.js";
import { ExplorerError } from "../explorer/types.js";
import staticFiles from "@fastify/static";
import { randomBytes } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { ConfigSchema, ScrapeError } from "../core/types.js";
import { plan } from "../core/runner.js";
import { redact } from "../core/util.js";
import { geographyCatalog } from "../geography/index.js";
import { Jobs } from "./jobs.js";
import {
  findRun,
  readRun,
  runList,
  artifacts,
  artifactPath,
  recentEvents,
} from "./runs.js";

const Input = ConfigSchema.pick({
  state: true,
  county: true,
  sources: true,
  approaches: true,
  seedUrls: true,
  maxTargets: true,
  attachments: true,
  jsonArray: true,
  maxDuration: true,
  maxBytes: true,
  maxRecords: true,
  credentialProfile: true,
});
export async function createDashboard(
  options: { root?: string; worker?: string; staticRoot?: string } = {},
) {
  const app = Fastify({ logger: false, bodyLimit: 65536 });
  const jobs = new Jobs(options.root ?? "runs", options.worker),
    token = randomBytes(32).toString("hex");
  const catalog = geographyCatalog();
  app.addHook("onRequest", async (request, reply) => {
    const host = request.headers.host ?? "";
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return reply.code(403).send({ message: "Local access only." });
    if (request.headers.origin && request.headers.origin !== `http://${host}`)
      return reply.code(403).send({ message: "Unapproved browser origin." });
    if (request.headers["sec-fetch-site"] === "cross-site")
      return reply.code(403).send({ message: "Local access only." });
    reply
      .header("Cache-Control", "no-store")
      .header("X-Content-Type-Options", "nosniff")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
    if (
      !["GET", "HEAD"].includes(request.method) &&
      request.headers["x-well-token"] !== token
    )
      return reply
        .code(403)
        .send({ message: "Dashboard session expired. Refresh this page." });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ExplorerError) {
      reply
        .code(error.status)
        .send({ code: error.code, message: String(redact(error.message)) });
      return;
    }
    const code = error instanceof ScrapeError ? error.code : "INVALID_INPUT";
    const status =
      code === "NOT_FOUND"
        ? 404
        : code === "RUN_LOCKED"
          ? 409
          : error instanceof z.ZodError || error instanceof ScrapeError
            ? 400
            : 500;
    reply.code(status).send({
      code,
      message:
        error instanceof z.ZodError
          ? "Check the request options and limits."
          : status === 500
            ? "Could not complete the local operation."
            : String(redact((error as Error).message)),
    });
  });
  app.get("/api/bootstrap", async () => ({
    token,
    geography: catalog,
    version: "0.1.0",
    root: jobs.root,
  }));
  app.get("/api/sources", async (request) => {
    const q = z
      .object({ state: z.string(), county: z.string() })
      .parse(request.query);
    const selected = plan({ ...q, attachments: "none" });
    return { geography: selected.geography, sources: selected.sources };
  });
  app.get("/api/runs", async () => ({
    runs: runList(jobs.root).map(
      ({ config: _config, sources: _sources, sourcePlan: _plan, ...run }) =>
        run,
    ),
  }));
  app.get("/api/runs/:id", async (request) => {
    const { id } = z.object({ id: z.string() }).parse(request.params),
      dir = findRun(jobs.root, id);
    const { config: _config, ...run } = readRun(jobs.root, dir);
    return { ...run, events: recentEvents(dir), artifacts: artifacts(dir) };
  });
  app.post("/api/runs", async (request, reply) =>
    reply.code(202).send(jobs.launch(Input.parse(request.body))),
  );
  app.post("/api/runs/:id/resume", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return reply.code(202).send(jobs.launch({}, id));
  });
  app.post("/api/runs/:id/stop", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params);
    return reply.code(202).send(jobs.stop(id));
  });
  app.get("/api/runs/:id/download", async (request, reply) => {
    const { id } = z.object({ id: z.string() }).parse(request.params),
      { file } = z.object({ file: z.string() }).parse(request.query);
    const dir = findRun(jobs.root, id);
    if (readRun(jobs.root, dir).active)
      throw new ScrapeError(
        "RUN_LOCKED",
        "Wait for this attempt to finish before downloading exports.",
      );
    const path = artifactPath(dir, file);
    reply
      .type("application/octet-stream")
      .header(
        "Content-Disposition",
        `attachment; filename="${basename(path)}"`,
      );
    return reply.send(createReadStream(path));
  });
  await explorerRoutes(app, jobs.root);
  await dataApiRoutes(app, jobs.root);
  const staticRoot =
    options.staticRoot ??
    fileURLToPath(new URL("../../dist/ui", import.meta.url));
  if (existsSync(join(staticRoot, "index.html"))) {
    await app.register(staticFiles, {
      root: resolve(staticRoot),
      prefix: "/",
      index: "index.html",
    });
  } else
    app.get("/", async (_req, reply) =>
      reply.type("text/plain").send("Build the dashboard first: npm run build"),
    );
  return app;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const args = process.argv.slice(2);
  const option = (name: string, fallback: string) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : (args[i + 1] ?? fallback);
  };
  const port = Number(option("--port", "4317"));
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("Invalid port.");
  const app = await createDashboard({ root: option("--output", "runs") });
  await app.listen({ host: "127.0.0.1", port });
  console.log(`Waterwell dashboard: http://127.0.0.1:${port}`);
  console.log(`Data API: http://127.0.0.1:${port}/api/v1`);
  console.log(
    "Closing this server or browser does not stop background collections. Use Stop in the dashboard.",
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      void app.close();
    });
}
