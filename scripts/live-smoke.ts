import { collect } from "../src/core/runner.js";

// Explicitly opt-in: npm run test:live -- <state> <county>
// No live calls are made by npm test, and no place is built in here.
const [state, county] = process.argv.slice(2);
if (!state || !county) {
  console.error("Usage: npm run test:live -- <state> <county>");
  process.exit(5);
}
const result = await collect({
  state,
  county,
  output: "./runs/live-smoke",
  sources: ["usgs-groundwater"],
  maxRecords: 5,
  maxDuration: 90,
  maxBytes: 20 * 1024 ** 2,
  attachments: "none",
});
const saved = Object.values(result.summary.counts).reduce((a, b) => a + b, 0);
if (saved > 5 || !["partial", "success"].includes(result.summary.outcome)) {
  throw new Error(
    `Unexpected bounded smoke result. Inspect ${result.dir}/summary.md`,
  );
}
console.log(
  `Live smoke passed: ${saved} public record(s) within a five-record budget. ${result.dir}`,
);
