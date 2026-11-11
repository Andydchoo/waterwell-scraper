import { createInterface } from "node:readline/promises";
import { chmodSync } from "node:fs";
import type { BrowserContext, Page } from "playwright";
import { ScrapeError, type SourceManifest } from "../core/types.js";
import { atomicWrite } from "../core/util.js";
import { prepareSessionDir, sessionPath } from "./index.js";
import { openBrowser } from "../transports/browser.js";
import type { SourceContext } from "../sources/context.js";

export async function saveScopedSession(
  source: SourceManifest,
  context: BrowserContext,
  page: Page,
) {
  const origin = new URL(source.landingPage).origin;
  if (new URL(page.url()).origin !== origin)
    throw new ScrapeError(
      "CREDENTIAL_ORIGIN",
      "Login ended on an unrelated origin; session was not saved.",
    );
  const body = await page.locator("body").innerText();
  if (
    (await page.locator("input[type=password]").count()) ||
    /cookies are not enabled/i.test(body)
  )
    throw new ScrapeError(
      "NEEDS_AUTH",
      "Portal still requires login; session was not saved.",
    );
  const state = await context.storageState();
  state.cookies = state.cookies.filter(
    (c) => c.domain.replace(/^\./, "") === new URL(origin).hostname,
  );
  state.origins = state.origins.filter((o) => o.origin === origin);
  prepareSessionDir();
  atomicWrite(sessionPath(source), JSON.stringify(state));
  chmodSync(sessionPath(source), 0o600);
}

export async function interactiveLogin(ctx: SourceContext) {
  if (!process.stdin.isTTY)
    throw new ScrapeError(
      "NEEDS_AUTH",
      "Interactive authentication requires a terminal. Use auth login separately, then resume.",
    );
  ctx.http.check();
  const session = await openBrowser({
    ...ctx,
    config: { ...ctx.config, headful: true, credentialProfile: undefined },
  });
  const input = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  const signal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(
      Math.max(
        1,
        Math.min(300000, (ctx.http.opts.deadline ?? Infinity) - Date.now()),
      ),
    ),
  ]);
  try {
    const page = await session.context.newPage();
    await page.goto(ctx.source.landingPage, { waitUntil: "domcontentloaded" });
    await input.question(
      "Complete the source login in the browser, then press Enter: ",
      { signal },
    );
    await saveScopedSession(ctx.source, session.context, page);
    ctx.savedSession = {
      sourceId: ctx.source.id,
      path: sessionPath(ctx.source),
    };
    ctx.logger.log("source.auth_completed", {
      source_id: ctx.source.id,
      provider: "storage-state",
    });
  } catch (error) {
    if (signal.aborted)
      throw new ScrapeError(
        "NEEDS_AUTH",
        "Interactive login timed out or was cancelled.",
      );
    throw error;
  } finally {
    input.close();
    await session.close();
  }
}
