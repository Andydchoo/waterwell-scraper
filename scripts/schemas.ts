import { mkdirSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { ConfigSchema, EntitySchema } from "../src/core/types.js";

const event = z
  .object({
    timestamp: z.string(),
    level: z.enum(["info", "error"]),
    event: z.string(),
    run_id: z.string(),
    attempt_id: z.number().int(),
    source_id: z.string().nullable(),
    task_id: z.string().nullable(),
    stage: z.string(),
    duration_ms: z.number().nonnegative(),
  })
  .passthrough();
mkdirSync("schemas", { recursive: true });
for (const [name, schema] of Object.entries({
  config: ConfigSchema,
  entity: EntitySchema,
  event,
})) {
  writeFileSync(
    `schemas/${name}.schema.json`,
    JSON.stringify(z.toJSONSchema(schema), null, 2) + "\n",
  );
}
