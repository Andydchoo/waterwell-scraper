import { parentPort, workerData } from "node:worker_threads";
import { buildSnapshot } from "./snapshots.js";
import { queryPage, capabilities, record, links } from "./query.js";
import { exportRecords } from "./exports.js";
import { ExplorerError } from "./types.js";
const { root, operation, args } = workerData;
const progress = (progress: number, total: number) =>
  parentPort?.postMessage({ progress, total });
try {
  let value: unknown;
  switch (operation) {
    case "index":
      value = buildSnapshot(root, args.runKey, args.id, progress);
      break;
    case "export":
      value = exportRecords(root, args.snapshot, args.id, args.input, progress);
      break;
    case "query":
      value = queryPage(root, args.snapshot, args.query);
      break;
    case "capabilities":
      value = capabilities(root, args.snapshot, args.kind);
      break;
    case "record":
      value = record(root, args.snapshot, args.kind, args.id);
      break;
    case "links":
      value = links(root, args.snapshot, args.kind, args.id, args.offset);
      break;
    default:
      throw new Error("Unknown explorer operation");
  }
  parentPort?.postMessage({ done: true, value });
} catch (e) {
  parentPort?.postMessage({
    done: true,
    error: {
      code: e instanceof ExplorerError ? e.code : "EXPLORER_FAILED",
      status: e instanceof ExplorerError ? e.status : 500,
      message: e instanceof Error ? e.message : "Explorer operation failed",
    },
  });
}
