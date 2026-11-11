import { createHash } from "node:crypto";
import {
  mkdirSync,
  openSync,
  writeSync,
  closeSync,
  renameSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { atomicWrite, now } from "../core/util.js";
import { csvCell, fields } from "../storage/export.js";
import { base, getSnapshot, openSnapshot, reserve } from "./snapshots.js";
import { ExportSchema, opaque, type ExportInput } from "./types.js";
import { matching, predicate, queryHash } from "./query.js";
export function exportDir(root: string, id: string) {
  opaque(id);
  return join(base(root), "exports", id);
}
export function exportRecords(
  root: string,
  snapshot: string,
  id: string,
  input: ExportInput,
  progress: (n: number, total: number) => void = () => {},
) {
  const parsed = ExportSchema.parse(input),
    q = { ...parsed.query, cursor: undefined },
    s = getSnapshot(root, snapshot),
    db = openSnapshot(root, snapshot);
  const dir = exportDir(root, id),
    temp = dir + ".tmp";
  const name = "records." + parsed.format,
    digest = createHash("sha256");
  let fd: number | undefined;
  let bytes = 0,
    closed = false,
    rows = 0;
  const write = (text: string) => {
    const b = Buffer.from(text);
    let p = 0;
    while (p < b.length) p += writeSync(fd!, b, p);
    bytes += b.length;
    digest.update(b);
  };
  try {
    mkdirSync(temp, { recursive: true, mode: 0o700 });
    reserve(temp);
    fd = openSync(join(temp, name), "wx", 0o600);
    const pred = predicate(q),
      total = Number(
        db
          .prepare(`SELECT count(*) n FROM records r WHERE ${pred.where}`)
          .get(...pred.args)!.n,
      );
    progress(0, total);
    if (parsed.format === "csv") write(fields.join(",") + "\n");
    if (parsed.format === "json") write("[\n");
    for (const e of matching(db, q)) {
      if (parsed.format === "csv") {
        const extra = Object.fromEntries(
          Object.entries(e).filter(([k]) => !fields.includes(k)),
        );
        write(
          fields
            .map((k) => csvCell(k === "additional_fields" ? extra : e[k]))
            .join(",") + "\n",
        );
      } else
        write(
          (parsed.format === "json" && rows ? ",\n" : "") +
            JSON.stringify(e) +
            (parsed.format === "jsonl" ? "\n" : ""),
        );
      rows++;
      if (rows % 500 === 0) {
        reserve(temp);
        progress(rows, total);
      }
    }
    if (parsed.format === "json") write("\n]\n");
    closeSync(fd);
    closed = true;
    const manifest = {
      publication_status: "complete",
      id,
      snapshot: s,
      query: q,
      query_hash: queryHash(q),
      format: parsed.format,
      scope:
        "All matching records of the selected type; related entities and report bytes are excluded.",
      rows,
      bytes,
      sha256: digest.digest("hex"),
      file: name,
      createdAt: now(),
      mapping_version: s.version,
      csv_null: "Empty cell; JSON preserves null vs empty string",
      csv_formula_escape:
        "Leading formula characters in text receive an apostrophe; original values remain in JSON.",
    };
    atomicWrite(join(temp, "manifest.json"), JSON.stringify(manifest, null, 2));
    renameSync(temp, dir);
    progress(rows, total);
    return manifest;
  } catch (e) {
    if (!closed && fd !== undefined) closeSync(fd);
    rmSync(temp, { recursive: true, force: true });
    throw e;
  } finally {
    db.close();
  }
}
