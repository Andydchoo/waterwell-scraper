import { emptyResult, errorInfo } from "../core/types.js";
import { collectArcgis } from "./arcgis.js";
import { discoverLayers } from "./discovery.js";
import { isBudget, type Fetcher, type SourceContext } from "./context.js";

export const DISCOVERY = "discovery";
/** Record what discovery found (or why it failed) as its own result row. */
export function discoveryResult(
  ctx: SourceContext,
  outcome: {
    found?: number;
    selected?: number;
    caveats?: string[];
    errors?: { code: string; message: string }[];
    failed?: boolean;
  },
) {
  const errors = outcome.errors ?? [];
  ctx.store.result({
    ...emptyResult(ctx.source.id, DISCOVERY),
    status: outcome.failed
      ? errors.some((e) => e.code === "BLOCKED")
        ? "blocked"
        : errors.some((e) => e.code === "NEEDS_AUTH")
          ? "needs_auth"
          : "failed"
      : "success",
    completeness: outcome.failed ? "incomplete" : "unverified",
    expected: outcome.found ?? null,
    fetched: outcome.selected ?? 0,
    unresolved: null,
    // Unreachable candidates are caveats: they do not make the discovery itself fail.
    errors: outcome.failed ? errors : [],
    caveats: [
      ...(outcome.caveats ?? []),
      ...(outcome.failed
        ? []
        : errors.slice(0, 20).map((e) => `Skipped candidate — ${e.message}`)),
    ],
  });
}
/**
 * API approach: find public ArcGIS REST services for the county in the public
 * catalog, then query every selected layer directly.
 */
export async function collectArcgisServices(
  ctx: SourceContext,
  fetcher: Fetcher = ctx.http,
) {
  let layers;
  try {
    const found = await discoverLayers(ctx, fetcher);
    layers = found.targets;
    discoveryResult(ctx, {
      found: found.items.length,
      selected: layers.length,
      errors: found.errors,
      caveats: [
        `Catalog search matched ${found.items.length} public service item(s) for ${ctx.geo.county}, ${ctx.geo.state}; ${layers.length} layer(s) selected.`,
        "Discovery depends on how publishers title and tag their items; unlisted or untagged services are not found.",
      ],
    });
  } catch (e) {
    const err = errorInfo(e);
    discoveryResult(ctx, { failed: true, errors: [err] });
    if (isBudget(err.code)) throw e;
    return;
  }
  ctx.logger.log("discovery.finished", {
    source_id: ctx.source.id,
    targets: layers.length,
  });
  await collectArcgis(ctx, layers, fetcher);
}
