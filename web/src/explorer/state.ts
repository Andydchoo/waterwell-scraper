import {
  QuerySchema,
  type Query,
  type RecordKey,
} from "../../../src/explorer/types.js";
export interface Route {
  run?: string;
  snapshot?: string;
  query: Query;
  record?: RecordKey;
  previous: string[];
}
export function readRoute(): Route {
  try {
    const params = new URLSearchParams(location.hash.split("?")[1] ?? "");
    const r = JSON.parse(params.get("state") ?? "{}");
    return {
      ...r,
      query: QuerySchema.parse(r.query ?? {}),
      previous: Array.isArray(r.previous) ? r.previous : [],
    };
  } catch {
    return { query: QuerySchema.parse({}), previous: [] };
  }
}
export function go(route: Route, replace = false) {
  const hash =
    "#/explorer?" + new URLSearchParams({ state: JSON.stringify(route) });
  if (replace) {
    history.replaceState(null, "", hash);
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else location.hash = hash;
}
export const openExplorer = (run?: string) =>
  go({ run, query: QuerySchema.parse({}), previous: [] });
