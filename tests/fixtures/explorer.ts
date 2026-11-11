import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Store } from "../../src/storage/store.js";
import { ConfigSchema, type Entity } from "../../src/core/types.js";
import { hash } from "../../src/core/util.js";
import { runKey } from "../../src/dashboard/runs.js";
export function fixture(root: string, total = 120) {
  const dir = join(root, "fixture"),
    store = new Store(dir);
  store.set("run_id", "fixture");
  store.set("attempt", 1);
  store.set("outcome", "partial");
  store.set("attempt_ended_at", "2026-10-29T12:00:00Z");
  store.set("started_at", "2026-10-29T11:00:00Z");
  store.set("sources", []);
  store.set("geo", { state: "NC", county: "Mecklenburg County" });
  store.set(
    "config",
    ConfigSchema.parse({ state: "NC", county: "Mecklenburg" }),
  );
  const common = {
    source_id: "fixture",
    dataset_id: "inventory",
    county_geoid: "37119",
    source_url: "https://example.gov/record",
    retrieved_at: "2026-10-29T11:00:00Z",
    raw_path: "raw/fixture.json",
    raw_sha256: "a".repeat(64),
    source_fields: { nullable: null, zero: 0, empty: "" },
    quality_flags: [],
  } satisfies Partial<Entity>;
  store.transaction(() => {
    for (let i = 0; i < total; i++)
      store.put("wells", {
        ...common,
        id: "well:" + String(i).padStart(6, "0"),
        native_id: String(i).padStart(6, "0"),
        source_well_id: "W-" + i,
        address:
          i % 3 === 0
            ? "100 River Road"
            : i % 3 === 1
              ? "200 Lake Street"
              : null,
        parcel_id: "00123",
        well_name: i % 7 === 0 ? '=Formula, "site"\nline' : "Well " + i,
        well_status: i % 2 ? "Active" : "Unknown",
        well_use: "Domestic",
        total_depth: {
          value: i % 5 === 0 ? null : i,
          unit: i % 3 === 0 ? null : "m",
          raw_value: i,
        },
        quality_flags: i % 3 === 0 ? ["source_units_unverified"] : [],
      });
  });
  const construction: Entity = {
    ...common,
    id: "deq:1",
    native_id: "1",
    source_id: "fixture-archive",
    dataset_id: "construction",
    source_fields: {
      metadata: [
        { name: "Well Location - Street", values: ["12 Archive Lane"] },
        { name: "ID #", values: ["0007", "0008"] },
        { name: "Date Well Completed", values: ["2020-06"] },
      ],
    },
    record_id: "deq:1",
  };
  store.put("construction", construction);
  // A valid one-page PDF with visible text, offsets and a cross-reference table.
  const content =
    "BT /F1 18 Tf 30 240 Td (Synthetic construction report) Tj ET";
  const objects = [
    "<</Type /Catalog /Pages 2 0 R>>",
    "<</Type /Pages /Kids [3 0 R] /Count 1>>",
    "<</Type /Page /Parent 2 0 R /MediaBox [0 0 400 300] /Resources <</Font <</F1 5 0 R>>>> /Contents 4 0 R>>",
    `<</Length ${Buffer.byteLength(content)}>>\nstream\n${content}\nendstream`,
    "<</Type /Font /Subtype /Type1 /BaseFont /Helvetica>>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [i, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${i + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((n) => String(n).padStart(10, "0") + " 00000 n \n")
    .join("")}trailer\n<</Size 6 /Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  const body = Buffer.from(pdf);
  const sha = hash(body),
    local = "attachments/" + sha + ".pdf";
  mkdirSync(join(dir, "attachments"));
  writeFileSync(join(dir, local), body);
  store.put("documents", {
    ...construction,
    id: "deq:1:document",
    document_id: "deq:1:document",
    title: "Construction report",
    download_status: "downloaded",
    local_path: local,
    sha256: sha,
    byte_count: body.length,
  });
  store.put("relationships", {
    ...construction,
    id: "link:1",
    from_id: "deq:1:document",
    to_id: "deq:1",
    relationship_type: "describes_record",
    evidence: "same_source_entry_id",
  });
  store.put("documents", {
    ...common,
    id: "hyland:1",
    native_id: "opaque%_1",
    source_id: "fixture-documents",
    dataset_id: "reports",
    title: "Unlinked report",
    record_id: null,
    download_status: "not_requested",
    source_fields: {
      display_fields: {
        Address: "99 Cedar Lane",
        "Parcel Number": "000045",
        "File Number": "P-001",
        "Document Type": "Well report",
      },
    },
  });
  store.put("observations", {
    ...common,
    id: "obs:1",
    native_id: "obs1",
    source_id: "usgs-groundwater",
    record_id: "well:000001",
    observed_at: "2021-01-01T01:00:00+02:00",
    parameter: "Water level",
    unit: "ft",
    result: { raw_value: "<0.01", value: null, qualifier: "<", limit: 0.01 },
  });
  store.close();
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      publication_status: "complete",
      artifacts: { [local]: { bytes: body.length, sha256: sha } },
    }),
  );
  return { dir, runKey: runKey(root, dir), body, local };
}
