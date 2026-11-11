import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { HttpClient } from "../src/transports/http.js";

test("HTTP handles response errors, read-only POST, redirects, size and retry budgets", async () => {
  const server = createServer((req, res) => {
    const path = req.url?.split("?")[0];
    if (path === "/retry") {
      res.writeHead(429, { "retry-after": "60" });
      res.end("slow down");
    } else if (path === "/redirect") {
      res.writeHead(302, { location: "https://unapproved.test/" });
      res.end();
    } else if (path === "/large") {
      res.end("x".repeat(1000));
    } else if (path === "/bad") {
      res.end("<html>login</html>");
    } else if (path === "/missing") {
      res.writeHead(404);
      res.end();
    } else {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ method: req.method }));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    const client = new HttpClient({
      origins: [base],
      testMode: true,
      intervalMs: 0,
      deadline: Date.now() + 5000,
    });
    assert.deepEqual(await client.postJson(base + "/query", { x: 1 }), {
      method: "POST",
    });
    await assert.rejects(() => client.get(base + "/redirect"), /approved/);
    await assert.rejects(() => client.get(base + "/large", 100), /byte limit/);
    await assert.rejects(() => client.json(base + "/bad"), /Expected JSON/);
    await assert.rejects(() => client.get(base + "/missing"), /not found/);
    await assert.rejects(
      () => client.get(base + "/retry"),
      /remaining duration/,
    );
  } finally {
    await new Promise<void>((r, e) =>
      server.close((err) => (err ? e(err) : r())),
    );
  }
});
