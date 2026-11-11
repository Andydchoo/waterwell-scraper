import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, sep, resolve, basename } from "node:path";
import { realpath } from "node:fs/promises";
import { findRun, jsonFile } from "../dashboard/runs.js";
import { fileType } from "../sources/documents.js";
import { ExplorerService } from "./service.js";
import { getSnapshot } from "./snapshots.js";
import { exportDir } from "./exports.js";
import { ExplorerError, Kind, QuerySchema } from "./types.js";
export async function explorerRoutes(app: FastifyInstance, root: string) {
  const service = new ExplorerService(root);
  app.addHook("onClose", async () => service.close());
  const snapshotParam = (params: unknown) =>
    z.object({ snapshot: z.string().uuid() }).parse(params).snapshot;
  const runParam = (params: unknown) =>
    z.object({ run: z.string().regex(/^[a-f0-9]{24}$/) }).parse(params).run;
  const exportParam = (params: unknown) =>
    z.object({ export: z.string().uuid() }).parse(params).export;
  const keySchema = z
    .object({ kind: Kind, id: z.string().min(1).max(8192) })
    .strict();
  app.get("/api/runs/:run/explorer", async (req) =>
    service.status(runParam(req.params)),
  );
  app.post("/api/runs/:run/explorer", async (req, reply) => {
    const result = service.startIndex(runParam(req.params));
    return reply.code(result.snapshot ? 200 : 202).send(result);
  });
  app.post("/api/runs/:run/explorer/cancel", async (req) => {
    const key = runParam(req.params);
    const job = service
      .jobs()
      .find(
        (j) => j.type === "index" && j.runKey === key && j.state === "running",
      );
    return job ? service.cancel(job.id) : { requested: false };
  });
  app.get("/api/explorer/:snapshot/capabilities", async (req) =>
    service.request("capabilities", {
      snapshot: snapshotParam(req.params),
      kind: z.object({ kind: Kind.default("wells") }).parse(req.query).kind,
    }),
  );
  app.post("/api/explorer/:snapshot/query", async (req) =>
    service.request("query", {
      snapshot: snapshotParam(req.params),
      query: QuerySchema.parse(req.body),
    }),
  );
  app.get("/api/explorer/:snapshot/record", async (req) =>
    service.request("record", {
      snapshot: snapshotParam(req.params),
      ...keySchema.parse(req.query),
    }),
  );
  app.get("/api/explorer/:snapshot/links", async (req) =>
    service.request("links", {
      snapshot: snapshotParam(req.params),
      ...keySchema
        .extend({
          offset: z.coerce.number().int().min(0).max(10000000).default(0),
        })
        .parse(req.query),
    }),
  );
  app.post("/api/explorer/:snapshot/exports", async (req, reply) =>
    reply
      .code(202)
      .send(service.startExport(snapshotParam(req.params), req.body)),
  );
  app.get("/api/explorer/exports", async (req) => {
    const { snapshot, offset } = z
      .object({
        snapshot: z.string().uuid(),
        offset: z.coerce.number().int().min(0).default(0),
      })
      .parse(req.query);
    const jobs = service
      .jobs()
      .filter((j) => j.type === "export" && j.snapshot === snapshot);
    return {
      items: jobs.slice(offset, offset + 25),
      total: jobs.length,
      next: offset + 25 < jobs.length ? offset + 25 : null,
    };
  });
  app.get("/api/explorer/exports/:export", async (req) => {
    const j = service.job(exportParam(req.params));
    if (j.type !== "export")
      throw new ExplorerError("NOT_FOUND", "Export not found.", 404);
    return j;
  });
  app.post("/api/explorer/exports/:export/cancel", async (req) => {
    const id = exportParam(req.params);
    if (service.job(id).type !== "export")
      throw new ExplorerError("NOT_FOUND", "Export not found.", 404);
    return service.cancel(id);
  });
  app.delete("/api/explorer/exports/:export", async (req) =>
    service.removeExport(exportParam(req.params)),
  );
  app.delete("/api/explorer/:snapshot", async (req) =>
    service.removeSnapshot(snapshotParam(req.params)),
  );
  app.get("/api/explorer/exports/:export/download", async (req, reply) => {
    const id = exportParam(req.params),
      job = service.job(id),
      { artifact } = z
        .object({ artifact: z.enum(["data", "manifest"]) })
        .parse(req.query);
    if (job.type !== "export" || job.state !== "complete")
      throw new ExplorerError(
        "EXPORT_NOT_READY",
        "This export is not complete.",
        409,
      );
    const dir = exportDir(root, id),
      manifest = jsonFile<{ file: string; publication_status: string }>(
        join(dir, "manifest.json"),
      );
    if (
      !manifest ||
      manifest.publication_status !== "complete" ||
      !/^records\.(csv|json|jsonl)$/.test(manifest.file)
    )
      throw new ExplorerError(
        "NOT_FOUND",
        "Export files are missing. Retry this export.",
        404,
      );
    const path = join(
      dir,
      artifact === "manifest" ? "manifest.json" : manifest.file,
    );
    if (!(await realpath(path)).startsWith((await realpath(dir)) + sep))
      throw new ExplorerError("NOT_FOUND", "Export not found.", 404);
    return reply
      .type("application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${basename(path)}"`)
      .send(createReadStream(path));
  });
  const verified = new Map<string, string>();
  app.get("/api/explorer/:snapshot/report", async (req, reply) => {
    const id = snapshotParam(req.params),
      { id: document, mode } = z
        .object({
          id: z.string().min(1).max(8192),
          mode: z.enum(["inline", "download"]).default("inline"),
        })
        .parse(req.query);
    const s = getSnapshot(root, id),
      detail = (await service.request("record", {
        snapshot: id,
        kind: "documents",
        id: document,
      })) as { entity: Record<string, unknown> };
    const e = detail.entity;
    if (e.download_status !== "downloaded" || typeof e.local_path !== "string")
      throw new ExplorerError(
        "FILE_UNAVAILABLE",
        `This report has no downloaded file (status: ${String(e.download_status ?? "unknown")}).`,
        409,
      );
    if (
      !/^attachments\/[a-f0-9]{64}\.(pdf|png|jpg|tiff|csv|json|geojson|zip|xlsx|xls|kml|kmz|gpkg|gdb|txt|xml|bin)$/.test(
        e.local_path,
      ) ||
      typeof e.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(e.sha256)
    )
      throw new ExplorerError(
        "INVALID_FILE",
        "Invalid report path or hash.",
        422,
      );
    const runDir = findRun(root, s.runKey),
      path = resolve(runDir, e.local_path);
    let real: string;
    try {
      real = await realpath(path);
    } catch {
      throw new ExplorerError(
        "FILE_MISSING",
        "The local report file is missing. Its collected metadata is preserved.",
        404,
      );
    }
    if (!real.startsWith((await realpath(runDir)) + sep + "attachments" + sep))
      throw new ExplorerError(
        "INVALID_FILE",
        "Report path is outside the collection attachments directory.",
        422,
      );
    const handle = await open(real, "r");
    let streaming = false;
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size !== e.byte_count)
        throw new ExplorerError(
          "FILE_CHANGED",
          "The report size has changed. Verify or recollect the original file.",
          422,
        );
      const signature = Buffer.alloc(8);
      await handle.read(signature, 0, 8, 0);
      let type: string;
      const extension = e.local_path.split(".").pop()!;
      // Downloaded data files (CSV, GeoJSON, …) are offered as downloads only;
      // reports must still match their PDF/image signature.
      const dataFile = !["pdf", "png", "jpg", "tiff"].includes(extension);
      try {
        type = dataFile ? extension : fileType(signature);
        if (!e.local_path.endsWith("." + type))
          throw new Error("Signature mismatch");
      } catch {
        throw new ExplorerError(
          "INVALID_FILE",
          "The local file is not a supported report.",
          422,
        );
      }
      const identity = JSON.stringify([
        st.dev,
        st.ino,
        st.size,
        st.mtimeMs,
        st.ctimeMs,
        e.sha256,
      ]);
      if (verified.get(real) !== identity) {
        const hash = createHash("sha256");
        for await (const chunk of handle.createReadStream({
          start: 0,
          autoClose: false,
        }))
          hash.update(chunk);
        if (hash.digest("hex") !== e.sha256)
          throw new ExplorerError(
            "FILE_CHANGED",
            "The report hash no longer matches the collected original.",
            422,
          );
        if (verified.size > 128) verified.clear();
        verified.set(real, identity);
      }
      let start = 0,
        end = st.size - 1;
      const range = req.headers.range;
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range);
        if (!m || (!m[1] && !m[2]))
          return reply
            .code(416)
            .header("Content-Range", `bytes */${st.size}`)
            .send();
        if (!m[1]) {
          const length = Number(m[2]);
          start = Math.max(0, st.size - length);
          if (length < 1) start = st.size;
        } else {
          start = Number(m[1]);
          end = m[2] ? Math.min(end, Number(m[2])) : end;
        }
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          start > end ||
          start >= st.size
        )
          return reply
            .code(416)
            .header("Content-Range", `bytes */${st.size}`)
            .send();
        reply
          .code(206)
          .header("Content-Range", `bytes ${start}-${end}/${st.size}`);
      }
      const inline = mode === "inline" && type !== "tiff" && !dataFile;
      const mime: { [k: string]: string } = {
        pdf: "application/pdf",
        png: "image/png",
        jpg: "image/jpeg",
        tiff: "image/tiff",
      };
      reply
        .type(mime[type] ?? "application/octet-stream")
        .header(
          "Content-Disposition",
          `${inline ? "inline" : "attachment"}; filename="${basename(real)}"`,
        )
        .header("Accept-Ranges", "bytes")
        .header("Content-Length", end - start + 1)
        .header(
          "Content-Security-Policy",
          "default-src 'none'; frame-ancestors 'self'",
        );
      if (req.method === "HEAD") {
        reply.hijack();
        for (const [name, v] of Object.entries(reply.getHeaders()))
          if (v !== undefined) reply.raw.setHeader(name, v);
        reply.raw.writeHead(reply.statusCode);
        reply.raw.end();
        return reply;
      }
      const stream = handle.createReadStream({ start, end, autoClose: true });
      streaming = true;
      return reply.send(stream);
    } finally {
      if (!streaming) await handle.close();
    }
  });
  return service;
}
