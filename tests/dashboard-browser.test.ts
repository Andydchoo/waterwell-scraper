import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { createDashboard } from "../src/dashboard/server.js";
import { Jobs } from "../src/dashboard/jobs.js";
import { runList } from "../src/dashboard/runs.js";

test(
  "dashboard browser: county choices, detached lifecycle, history, exports and mobile layout",
  { skip: !process.env.RUN_UI_TESTS, timeout: 60000 },
  async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".well-scraper/browsers");
    const { chromium } = await import("playwright");
    const root = mkdtempSync(join(tmpdir(), "well-dashboard-browser-"));
    const worker = resolve("tests/fixtures/dashboard-worker.mjs");
    const app = await createDashboard({ root, worker });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ headless: true });
    const errors: string[] = [];
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    const screenshots = resolve("test-results/dashboard");
    mkdirSync(screenshots, { recursive: true });
    try {
      assert.equal((await page.goto(base))?.status(), 200);
      await page
        .getByRole("heading", { name: "Your groundwater workspace." })
        .waitFor();
      await page
        .getByRole("heading", { name: "Your first collection starts here" })
        .waitFor();
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "New collection" })
        .click();
      await page.getByLabel("State", { exact: true }).selectOption("VA");
      await page.getByLabel("County", { exact: true }).selectOption("51059");
      // The same collectors, covering all three approaches, are offered for any county.
      await page.waitForFunction(
        () => document.querySelectorAll(".source-option").length === 5,
      );
      const offered = await page.locator(".sources-list").innerText();
      for (const approach of [
        "Public API",
        "Browser navigation",
        "File download",
      ])
        assert.ok(offered.includes(approach), approach);
      await page.getByLabel("State", { exact: true }).selectOption("NC");
      await page.getByLabel("County", { exact: true }).selectOption("37119");
      await page.waitForFunction(
        () => document.querySelectorAll(".source-option").length === 5,
      );
      assert.equal(await page.locator(".sources-list").innerText(), offered);
      await page
        .getByRole("button", { name: "Start collection" })
        .waitFor({ state: "visible" });
      await page.screenshot({
        path: join(screenshots, "new-collection.png"),
        fullPage: true,
      });
      await page.getByLabel("Metadata only").check();
      await page.getByLabel("Time limit").fill("1");
      await page.getByRole("button", { name: "Start collection" }).click();
      await page.getByRole("button", { name: "Stop safely" }).waitFor();
      await page.getByText("5 requests", { exact: true }).waitFor();
      const run = runList(root)[0]!;
      assert.equal(run.active, true);
      assert.equal(run.config?.attachments, "none");
      assert.equal(run.config?.maxDuration, 60);
      await page.getByRole("tab", { name: "Activity", exact: true }).click();
      await page.getByText("Run started", { exact: true }).waitFor();
      await page.close();
      const reopened = await context.newPage();
      reopened.on("pageerror", (e) => errors.push(e.message));
      await reopened.goto(base);
      await reopened
        .getByRole("button", { name: `Open ${run.runId}`, exact: true })
        .click();
      await reopened.getByRole("button", { name: "Stop safely" }).waitFor();
      await reopened.getByRole("button", { name: "Stop safely" }).click();
      await reopened
        .getByRole("button", { name: "Resume collection" })
        .waitFor();
      await reopened.getByRole("tab", { name: /Downloads/ }).click();
      const row = reopened
        .locator(".download-row")
        .filter({ has: reopened.getByText("wells.csv", { exact: true }) });
      const downloaded = reopened.waitForEvent("download");
      await row.getByRole("link", { name: "Download", exact: true }).click();
      const file = await downloaded;
      assert.equal(file.suggestedFilename(), "wells.csv");
      assert.match(readFileSync((await file.path())!, "utf8"), /fixture:1/);
      await reopened.screenshot({
        path: join(screenshots, "downloads.png"),
        fullPage: true,
      });
      await reopened.getByRole("button", { name: "Resume collection" }).click();
      await reopened.getByRole("button", { name: "Stop safely" }).waitFor();
      await reopened.getByText(/Attempt 2/).waitFor();
      await reopened.getByRole("button", { name: "Stop safely" }).click();
      await reopened
        .getByRole("button", { name: "Resume collection" })
        .waitFor();
      assert.equal(runList(root)[0]?.counts.wells, 1);
      await reopened
        .getByRole("button", { name: "All collections", exact: true })
        .click();
      // History is grouped under the day the collection ran.
      assert.match(
        await reopened.locator(".runs-table .day-row").first().innerText(),
        /1 collection/,
      );
      await reopened.getByLabel("Search collections").fill("nonexistent");
      await reopened
        .getByRole("heading", { name: "No matching collections" })
        .waitFor();
      await reopened.getByLabel("Search collections").fill("Mecklenburg");
      await reopened
        .getByRole("button", { name: `Open ${run.runId}`, exact: true })
        .waitFor();
      await reopened.getByRole("button", { name: "Waterwell home" }).click();
      await reopened.screenshot({
        path: join(screenshots, "overview.png"),
        fullPage: true,
      });
      await reopened.setViewportSize({ width: 390, height: 844 });
      assert.equal(
        await reopened.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await reopened.screenshot({
        path: join(screenshots, "mobile.png"),
        fullPage: true,
      });
      await reopened
        .getByRole("navigation")
        .getByRole("button", { name: "New collection" })
        .click();
      assert.equal(
        await reopened.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await reopened.screenshot({
        path: join(screenshots, "mobile-new.png"),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
    } finally {
      const jobs = new Jobs(root, worker);
      for (const run of runList(root)) if (run.stoppable) jobs.stop(run.id);
      for (let i = 0; i < 100 && runList(root).some((r) => r.active); i++)
        await new Promise((r) => setTimeout(r, 100));
      await browser.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
