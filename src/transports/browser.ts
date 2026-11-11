import type { Browser, BrowserContext } from "playwright";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isPublicAddress, validateUrl } from "./http.js";
import { ScrapeError } from "../core/types.js";
import type { SourceContext } from "../sources/context.js";
import { checkStorageState, resolveCredentials } from "../credentials/index.js";
const localBrowsers = fileURLToPath(
  new URL("../../.well-scraper/browsers", import.meta.url),
);
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync(localBrowsers))
  process.env.PLAYWRIGHT_BROWSERS_PATH = localBrowsers;
export async function openBrowser(
  ctx: SourceContext,
  useCredentials = false,
): Promise<{
  browser: Browser;
  context: BrowserContext;
  close: () => Promise<void>;
}> {
  ctx.http.check();
  const credentials =
    ctx.savedSession?.sourceId === ctx.source.id
      ? {
          storageState: checkStorageState(ctx.savedSession.path, ctx.source),
          password: undefined,
          apiKey: undefined,
        }
      : useCredentials
        ? resolveCredentials(ctx.source, ctx.config.credentialProfile)
        : undefined;
  if (credentials)
    ctx.logger.secrets.push(
      ...[credentials.password, credentials.apiKey].filter(
        (s): s is string => !!s,
      ),
    );
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({
    headless: !ctx.config.headful,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    storageState: credentials?.storageState,
    serviceWorkers: "block",
  });
  context.setDefaultTimeout(30000);
  context.setDefaultNavigationTimeout(60000);
  // Chromium network events count page assets as well as API response bytes.
  // Account decoded data incrementally so a large response closes the context at its budget.
  const instrument = async (page: import("playwright").Page) => {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.requestWillBeSent", () => {
      ctx.http.browserRequests++;
    });
    cdp.on("Network.dataReceived", ({ dataLength }) => {
      ctx.http.bytes += dataLength;
      ctx.http.browserBytes += dataLength;
      try {
        ctx.http.check();
      } catch {
        void context.close().catch(() => {});
      }
    });
  };
  const instrumentation = new WeakMap<
    import("playwright").Page,
    Promise<void>
  >();
  context.on("page", (page) => {
    const ready = instrument(page);
    instrumentation.set(page, ready);
    void ready.catch(() => {});
  });
  // Wait while the new page is still blank: waiting in a navigation route deadlocks CDP initialization.
  const createPage = context.newPage.bind(context);
  context.newPage = async () => {
    const page = await createPage();
    await instrumentation.get(page);
    return page;
  };
  const knownHosts = new Set<string>();
  await context.route("**/*", async (route) => {
    try {
      ctx.http.check();
      const url = validateUrl(
        route.request().url(),
        ctx.http.opts.origins,
        ctx.http.opts.testMode,
      );
      if (!knownHosts.has(url.hostname)) {
        const addresses = await lookup(url.hostname, { all: true });
        if (
          !ctx.http.opts.testMode &&
          addresses.some((a) => !isPublicAddress(a.address))
        )
          throw new ScrapeError(
            "PRIVATE_ADDRESS",
            "Browser destination is not public.",
          );
        knownHosts.add(url.hostname);
      }
      await route.continue();
    } catch {
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
  const abort = () => {
    void context.close().catch(() => {});
  };
  ctx.signal.addEventListener("abort", abort, { once: true });
  const deadlineTimer = setTimeout(
    abort,
    Math.max(1, (ctx.http.opts.deadline ?? Date.now() + 7200000) - Date.now()),
  );
  deadlineTimer.unref();
  return {
    browser,
    context,
    close: async () => {
      clearTimeout(deadlineTimer);
      ctx.signal.removeEventListener("abort", abort);
      await context.close().catch(() => {});
      await browser.close();
    },
  };
}
/**
 * Requests made through the open browser session (its cookies and network
 * stack) rather than the direct HTTP client. Destinations get the same
 * public-HTTPS checks, pacing and byte accounting as every other request.
 */
export function browserFetcher(
  ctx: SourceContext,
  context: BrowserContext,
): import("../sources/context.js").Fetcher {
  const next = new Map<string, number>();
  const known = new Set<string>();
  const send = async (
    url: string,
    limit: number,
    init: {
      method: "GET" | "POST";
      form?: Record<string, string>;
      headers?: Record<string, string>;
    },
  ) => {
    ctx.http.check();
    const u = validateUrl(url, ctx.http.opts.origins, ctx.http.opts.testMode);
    if (!known.has(u.hostname)) {
      const addresses = await lookup(u.hostname, { all: true });
      if (
        !ctx.http.opts.testMode &&
        addresses.some((a) => !isPublicAddress(a.address))
      )
        throw new ScrapeError(
          "PRIVATE_ADDRESS",
          "Browser destination is not public.",
        );
      known.add(u.hostname);
    }
    await ctx.http.wait(Math.max(0, (next.get(u.origin) ?? 0) - Date.now()));
    next.set(u.origin, Date.now() + (ctx.http.opts.intervalMs ?? 1000));
    ctx.http.browserRequests++;
    const response = await context.request.fetch(u.toString(), {
      method: init.method,
      form: init.form,
      headers: init.headers,
      timeout: ctx.http.opts.requestTimeoutMs ?? 60000,
      maxRedirects: 5,
    });
    const status = response.status();
    if (status === 401)
      throw new ScrapeError("NEEDS_AUTH", "Source requires authentication.");
    if (status === 403)
      throw new ScrapeError("BLOCKED", "Source denied access.");
    if (status === 404)
      throw new ScrapeError("NOT_FOUND", "Public resource was not found.");
    if (status >= 400)
      throw new ScrapeError("HTTP_ERROR", `Source returned HTTP ${status}.`);
    const body = await response.body();
    ctx.http.bytes += body.length;
    ctx.http.browserBytes += body.length;
    if (body.length > limit)
      throw new ScrapeError(
        "FILE_TOO_LARGE",
        "Response exceeds configured byte limit.",
      );
    ctx.http.check();
    return { body, url: response.url(), headers: response.headers() };
  };
  const parse = <T>(body: Buffer): T => {
    let value: T;
    try {
      value = JSON.parse(body.toString()) as T;
    } catch {
      throw new ScrapeError(
        "INVALID_RESPONSE",
        "Expected JSON; source returned HTML or malformed data.",
      );
    }
    if (value && typeof value === "object" && "error" in value) {
      const code = (value as { error: { code?: number } }).error?.code ?? 0;
      throw new ScrapeError(
        [498, 499, 401].includes(code) ? "NEEDS_AUTH" : "SOURCE_ERROR",
        "Source returned an API error envelope.",
      );
    }
    return value;
  };
  return {
    json: async <T>(url: string, headers: Record<string, string> = {}) =>
      parse<T>(
        (await send(url, 100 * 1024 ** 2, { method: "GET", headers })).body,
      ),
    formJson: async <T>(
      url: string,
      value: Record<string, string | number | boolean>,
    ) =>
      parse<T>(
        (
          await send(url, 100 * 1024 ** 2, {
            method: "POST",
            form: Object.fromEntries(
              Object.entries(value).map(([k, v]) => [k, String(v)]),
            ),
          })
        ).body,
      ),
    get: (url, limit = 100 * 1024 ** 2, headers = {}) =>
      send(url, limit, { method: "GET", headers }),
  };
}
