import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigSchema } from "../src/core/types.js";
import { resolveGeography } from "../src/geography/index.js";
import { Store } from "../src/storage/store.js";
import { Logger } from "../src/core/logger.js";
import { HttpClient } from "../src/transports/http.js";
import { openBrowser } from "../src/transports/browser.js";
import { saveDocument } from "../src/sources/documents.js";
import { registry } from "../src/sources/registry.js";

test(
  "SPA hydration, async result changes, popup and PDF download",
  { skip: !process.env.RUN_BROWSER_TESTS },
  async () => {
    const server = createServer((req, res) => {
      if (req.url === "/large") {
        let count = 0;
        const timer = setInterval(() => {
          res.write(Buffer.alloc(65536, 65));
          if (++count === 100) {
            clearInterval(timer);
            res.end();
          }
        }, 10);
        res.on("close", () => clearInterval(timer));
        return;
      }
      if (req.url?.startsWith("/api/Document/")) {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.end("%PDF-1.7\nfixture report\n%%EOF");
        return;
      }
      res.setHeader("content-type", "text/html");
      res.end(
        `<html><body><div id="root">Loading</div><script>setTimeout(()=>{document.querySelector('#root').innerHTML='<label>File Number<input id="file"></label><button id="search">Search</button><div id="results"></div>';document.querySelector('#search').onclick=()=>setTimeout(()=>{document.querySelector('#results').innerHTML='<div data-record="1">Record 1</div><button id="next">Next</button><a target="_blank" href="/api/Document/doc-1/">Report</a>';document.querySelector('#next').onclick=()=>setTimeout(()=>{document.querySelector('[data-record]').dataset.record='2';document.querySelector('[data-record]').textContent='Record 2'},100)},100)},100)</script></body></html>`,
      );
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const dir = mkdtempSync(join(tmpdir(), "well-browser-"));
    const store = new Store(dir);
    const source = {
      ...registry.find((s) => s.id === "browser-portals")!,
      origins: [base],
      landingPage: base,
    };
    const ctx = {
      config: ConfigSchema.parse({ state: "NC", county: "Mecklenburg" }),
      geo: resolveGeography("NC", "Mecklenburg"),
      source,
      store,
      logger: new Logger(dir, "test", 1, true),
      http: new HttpClient({
        origins: [base],
        testMode: true,
        intervalMs: 0,
        deadline: Date.now() + 30000,
      }),
      signal: new AbortController().signal,
      runId: "test",
      records: 0,
    };
    let session: Awaited<ReturnType<typeof openBrowser>> | undefined;
    try {
      session = await openBrowser(ctx);
      const page = await session.context.newPage();
      await page.goto(base);
      await page.getByLabel("File Number").fill("123");
      await page.getByRole("button", { name: "Search", exact: true }).click();
      await page.locator('[data-record="1"]').waitFor();
      await page.getByRole("button", { name: "Next" }).click();
      await page.locator('[data-record="2"]').waitFor();
      const popup = page.waitForEvent("popup");
      await page.getByRole("link", { name: "Report" }).click();
      await (await popup).close();
      const raw = store.raw(source.id, { ID: "doc-1" });
      const failure = await saveDocument(
        ctx,
        { ID: "doc-1", Name: "Well Report" },
        { Data: [] },
        raw,
        base,
      );
      assert.equal(failure, undefined);
      const doc = [...store.entities("documents")][0]!;
      assert.equal(doc.download_status, "downloaded");
      assert.ok(ctx.http.browserBytes > 0);
      assert.ok(ctx.http.browserRequests > 0);
      assert.ok(
        readFileSync(join(dir, String(doc.local_path)))
          .subarray(0, 5)
          .toString() === "%PDF-",
      );
      ctx.http.opts.maxBytes = ctx.http.bytes + 1000;
      await assert.rejects(
        page.evaluate(async () => {
          await fetch("/large").then((r) => r.text());
        }),
      );
      assert.throws(() => ctx.http.check(), /Download budget/);
    } finally {
      await session?.close();
      store.close();
      await new Promise<void>((r, e) =>
        server.close((err) => (err ? e(err) : r())),
      );
    }
  },
);

test(
  "browser SIGINT leaves application finalization in control",
  { skip: !process.env.RUN_BROWSER_TESTS },
  async () => {
    const { spawn } = await import("node:child_process");
    const { once } = await import("node:events");
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
 import {openBrowser} from './src/transports/browser.ts';
 import {HttpClient} from './src/transports/http.ts';
 import {ConfigSchema} from './src/core/types.ts';
 const abort=new AbortController();process.once('SIGINT',()=>abort.abort());
 const session=await openBrowser({config:ConfigSchema.parse({state:'NC',county:'Mecklenburg'}),source:{id:'fixture',origins:[],landingPage:'https://fixture.gov'},http:new HttpClient({origins:[],signal:abort.signal}),signal:abort.signal,logger:{secrets:[]}});
 await session.context.newPage();process.stdout.write('READY\\n');
 await new Promise(r=>abort.signal.addEventListener('abort',r,{once:true}));
 await session.close();process.stdout.write('FINALIZED\\n');
 `,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "",
      errors = "";
    child.stdout.on("data", (d) => (output += d));
    child.stderr.on("data", (d) => (errors += d));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(new Error("Browser child did not become ready: " + errors)),
          15000,
        );
        child.stdout.on("data", () => {
          if (output.includes("READY")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.once("exit", () => {
          clearTimeout(timer);
          reject(new Error("Browser child exited early: " + errors));
        });
      });
      const exited = once(child, "exit");
      child.kill("SIGINT");
      const [code] = await exited;
      assert.equal(code, 0);
      assert.match(output, /FINALIZED/);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  },
);
