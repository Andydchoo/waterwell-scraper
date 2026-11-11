import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixture } from "./fixtures/explorer.js";
import { createDashboard } from "../src/dashboard/server.js";
import { Store } from "../src/storage/store.js";
import { hash } from "../src/core/util.js";

test(
  "explorer browser journey: snapshots, filters, deep links, reports, all-page exports and mobile",
  { skip: !process.env.RUN_EXPLORER_TESTS, timeout: 90000 },
  async () => {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve(".well-scraper/browsers");
    const { chromium } = await import("playwright");
    const root = mkdtempSync(join(tmpdir(), "well-explorer-ui-")),
      f = fixture(root),
      app = await createDashboard({ root });
    const base = await app.listen({ host: "127.0.0.1", port: 0 });
    const browser = await chromium.launch({ channel: "chromium" }),
      context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
      }),
      page = await context.newPage(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const shots = resolve("test-results/explorer");
    mkdirSync(shots, { recursive: true });
    const requests: string[] = [];
    page.on("request", (r) => {
      if (r.url().startsWith("http") && !r.url().startsWith(base))
        requests.push(r.url());
    });
    try {
      assert.equal((await page.goto(base))?.status(), 200);
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Data explorer" })
        .click();
      await page.getByLabel("Explorer collection").selectOption(f.runKey);
      await page
        .getByRole("button", { name: "Prepare data", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "120 matching records", exact: true })
        .waitFor();
      await page.getByLabel("Search records").fill("River 00123");
      await page.getByLabel("Search records").press("Enter");
      await page
        .getByRole("heading", { name: "40 matching records", exact: true })
        .waitFor();
      await page.getByLabel("Rows per page").selectOption("25");
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByText("Page 2", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "View record well:000075", exact: true })
        .waitFor();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: join(shots, "search.png") });
      const location = page.url();
      await page.reload();
      await page.getByText("Page 2", { exact: true }).waitFor();
      await page
        .getByRole("heading", { name: "40 matching records", exact: true })
        .waitFor();
      assert.equal(page.url(), location);
      await page
        .getByRole("button", { name: "View record well:000075", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Original source fields", exact: true })
        .waitFor();
      assert.match(
        await page.locator(".source-field-list").innerText(),
        /zero/,
      );
      await page.screenshot({
        path: join(shots, "detail.png"),
        fullPage: true,
      });
      await page
        .getByRole("button", { name: "Back to results", exact: true })
        .click();
      await page.getByText("Page 2", { exact: true }).waitFor();
      await page
        .getByRole("button", { name: "Export results", exact: true })
        .click();
      await page.keyboard.press("Escape");
      assert.equal(
        await page
          .getByRole("button", { name: "Export results", exact: true })
          .evaluate((el) => el === document.activeElement),
        true,
      );
      await page.keyboard.press("Enter");
      await page.getByLabel("Export format").selectOption("json");
      await page
        .getByRole("button", { name: "Create export", exact: true })
        .click();
      const data = page
        .locator(".export-history")
        .getByRole("link", { name: "Data", exact: true });
      await data.waitFor();
      const download = page.waitForEvent("download");
      await data.click();
      const d = await download;
      const rows = JSON.parse(readFileSync((await d.path())!, "utf8"));
      assert.equal(rows.length, 40);
      assert.equal(new Set(rows.map((r: { id: string }) => r.id)).size, 40);
      assert.ok(
        rows.every((r: { address: string }) => r.address === "100 River Road"),
      );
      await page
        .getByRole("button", { name: "Construction & permits", exact: false })
        .click();
      await page
        .getByRole("button", { name: "Clear filters", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "1 matching records", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "View record deq:1", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "Original source fields", exact: true })
        .waitFor();
      await page
        .locator(".related-list")
        .getByRole("button", { name: "Construction report", exact: false })
        .click();
      await page
        .getByRole("button", { name: "View report", exact: true })
        .click();
      await page.getByTitle("Original PDF report").waitFor();
      const src = await page
        .getByTitle("Original PDF report")
        .getAttribute("src");
      const response = await page.request.get(base + src);
      assert.equal(response.status(), 200);
      assert.equal(response.headers()["content-type"], "application/pdf");
      const pdfDeadline = Date.now() + 10000;
      while (
        !page.frames().some((f) => f.url().startsWith("chrome-extension://")) &&
        Date.now() < pdfDeadline
      )
        await page.waitForTimeout(100);
      assert.ok(
        page.frames().some((f) => f.url().startsWith("chrome-extension://")),
        "Native PDF viewer opened",
      );
      await page.getByTitle("Original PDF report").scrollIntoViewIfNeeded();
      await page.waitForTimeout(1000);
      await page.screenshot({
        path: join(shots, "report.png"),
      });
      const db = new Store(f.dir);
      db.set("attempt", 2);
      db.set("outcome", "running");
      db.close();
      await page.getByText(/You are viewing saved attempt 1/).waitFor();
      await page
        .getByRole("button", { name: "Back to results", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Reports", exact: false })
        .filter({ hasNot: page.locator(".export-actions") })
        .first()
        .click();
      await page
        .getByRole("button", { name: "Clear filters", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "2 matching records", exact: true })
        .waitFor();
      await page
        .getByRole("button", { name: "View record hyland:1", exact: true })
        .click();
      await page.getByText(/No downloaded file is available/).waitFor();
      await page
        .getByRole("button", { name: "Back to results", exact: true })
        .click();
      await page.getByLabel("Search records").fill("nonexistent");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page
        .getByRole("heading", { name: "No matching records", exact: true })
        .waitFor();
      await page.goBack();
      await page
        .getByRole("heading", { name: "2 matching records", exact: true })
        .waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: join(shots, "mobile.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.screenshot({
        path: join(shots, "mobile-filters.png"),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        true,
      );
      const oldUrl = page.url(),
        finalized = new Store(f.dir);
      finalized.set("outcome", "partial");
      finalized.db.exec(
        "DELETE FROM entities WHERE kind='documents' AND id='hyland:1'",
      );
      finalized.close();
      await page
        .getByRole("button", { name: "Refresh data", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "1 matching records", exact: true })
        .waitFor();
      assert.notEqual(page.url(), oldUrl);
      await page.getByText("Attempt 2 · partial", { exact: true }).waitFor();
      const images = await page.evaluate(() => {
        const canvas = document.createElement("canvas");
        canvas.width = canvas.height = 2;
        const context = canvas.getContext("2d")!;
        context.fillStyle = "#137c76";
        context.fillRect(0, 0, 2, 2);
        return [canvas.toDataURL("image/png"), canvas.toDataURL("image/jpeg")];
      });
      const imageStore = new Store(f.dir),
        template = [...imageStore.entities("documents")][0]!;
      for (const [index, ext] of ["png", "jpg"].entries()) {
        const body = Buffer.from(images[index]!.split(",")[1]!, "base64"),
          sha = hash(body),
          local = `attachments/${sha}.${ext}`;
        writeFileSync(join(f.dir, local), body);
        imageStore.put("documents", {
          ...template,
          id: ext,
          title: `Image ${ext}`,
          local_path: local,
          sha256: sha,
          byte_count: body.length,
        });
      }
      imageStore.set("attempt", 3);
      imageStore.close();
      await page
        .getByRole("button", { name: "Refresh data", exact: true })
        .click();
      await page
        .getByRole("heading", { name: "3 matching records", exact: true })
        .waitFor();
      for (const ext of ["png", "jpg"]) {
        await page
          .getByRole("button", { name: `View record ${ext}`, exact: true })
          .click();
        await page
          .getByRole("button", { name: "View report", exact: true })
          .click();
        await page.getByAltText("Original report image").waitFor();
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLImageElement>(".report-image")
              ?.naturalWidth === 2,
        );
        await page
          .getByRole("button", { name: "Back to results", exact: true })
          .click();
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
    } catch (e) {
      await page.screenshot({
        path: join(shots, "failure.png"),
        fullPage: true,
      });
      throw e;
    } finally {
      await browser.close();
      await app.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
