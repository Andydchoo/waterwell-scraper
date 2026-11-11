import http from "node:http";
import https from "node:https";
import { lookup } from "node:dns";
import ipaddr from "ipaddr.js";
import { setTimeout as sleep } from "node:timers/promises";
import { ScrapeError } from "../core/types.js";
import { safeUrl } from "../core/util.js";
export interface TransportOptions {
  origins: string[];
  intervalMs?: number;
  maxBytes?: number;
  deadline?: number;
  requestTimeoutMs?: number;
  // Tries per request (default 4). Lowered while probing addresses that may be dead.
  maxAttempts?: number;
  signal?: AbortSignal;
  testMode?: boolean;
  onEvent?: (event: string, data: Record<string, unknown>) => void;
}
export function isPublicAddress(address: string) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export function validateUrl(
  input: string,
  origins: string[],
  testMode = false,
) {
  const u = new URL(input);
  if (
    u.username ||
    u.password ||
    // "*" approves any public HTTPS host. It is used only for destinations
    // discovered at run time; the private-address checks below still apply.
    (!origins.includes(u.origin) && !origins.includes("*")) ||
    !["https:", "http:"].includes(u.protocol) ||
    (!testMode && u.protocol !== "https:")
  )
    throw new ScrapeError(
      "UNAPPROVED_ORIGIN",
      "Request destination is not approved.",
    );
  if (
    ipaddr.isValid(u.hostname.replace(/^\[|\]$/g, "")) &&
    !isPublicAddress(u.hostname.replace(/^\[|\]$/g, "")) &&
    !testMode
  )
    throw new ScrapeError(
      "PRIVATE_ADDRESS",
      "Private network destinations are not allowed.",
    );
  return u;
}
export class HttpClient {
  bytes = 0;
  requests = 0;
  retries = 0;
  browserBytes = 0;
  browserRequests = 0;
  private next = new Map<string, number>();
  constructor(public opts: TransportOptions) {}
  /** Approve a destination discovered at run time for the current source only. */
  allow(input: string) {
    let u: URL;
    try {
      u = new URL(input);
    } catch {
      return false;
    }
    if (
      u.username ||
      u.password ||
      (u.protocol !== "https:" &&
        !(this.opts.testMode && u.protocol === "http:"))
    )
      return false;
    if (!this.opts.origins.includes(u.origin)) this.opts.origins.push(u.origin);
    return true;
  }
  check() {
    if (this.opts.signal?.aborted)
      throw new ScrapeError("CANCELLED", "Collection interrupted.");
    if (Date.now() >= (this.opts.deadline ?? Infinity))
      throw new ScrapeError("BUDGET_DURATION", "Run duration limit reached.");
    if (this.bytes >= (this.opts.maxBytes ?? Infinity))
      throw new ScrapeError("BUDGET_BYTES", "Download budget reached.");
  }
  async wait(ms: number) {
    this.check();
    if (Date.now() + ms >= (this.opts.deadline ?? Infinity))
      throw new ScrapeError(
        "BUDGET_DURATION",
        "Required wait exceeds remaining duration.",
      );
    await sleep(ms, undefined, { signal: this.opts.signal });
    this.check();
  }
  async get(
    input: string,
    limit = 100 * 1024 ** 2,
    headers: Record<string, string> = {},
    payload?: string,
    acceptedStatuses: number[] = [],
  ): Promise<{ body: Buffer; url: string; headers: http.IncomingHttpHeaders }> {
    let url = input;
    for (let redirects = 0; redirects <= 5; redirects++) {
      const u = validateUrl(url, this.opts.origins, this.opts.testMode);
      const last = Math.max(1, this.opts.maxAttempts ?? 4) - 1;
      for (let attempt = 0; attempt <= last; attempt++) {
        this.check();
        await this.wait(
          Math.max(0, (this.next.get(u.origin) ?? 0) - Date.now()),
        );
        this.next.set(u.origin, Date.now() + (this.opts.intervalMs ?? 1000));
        this.requests++;
        let response: {
          status: number;
          headers: http.IncomingHttpHeaders;
          body: Buffer;
        };
        try {
          response = await this.request(u, limit, headers, payload);
        } catch (e) {
          if (e instanceof ScrapeError || attempt === last) throw e;
          this.retries++;
          this.opts.onEvent?.("request.retry", {
            attempt: attempt + 1,
            reason: "transport",
          });
          await this.wait(Math.min(60000, 2000 * 2 ** attempt));
          continue;
        }
        if ([408, 429, 500, 502, 503, 504].includes(response.status)) {
          if (attempt === last)
            throw new ScrapeError(
              "HTTP_TRANSIENT",
              `Source returned HTTP ${response.status} after ${last + 1} attempt(s).`,
            );
          const ra = response.headers["retry-after"];
          const delay = ra
            ? Number.isFinite(Number(ra))
              ? Number(ra) * 1000
              : Math.max(0, Date.parse(ra) - Date.now())
            : 0;
          this.retries++;
          this.opts.onEvent?.("request.retry", {
            status: response.status,
            attempt: attempt + 1,
          });
          await this.wait(
            Math.max(
              delay || 0,
              Math.min(60000, 2000 * 2 ** attempt) +
                Math.floor(Math.random() * 250),
            ),
          );
          continue;
        }
        if (
          response.status >= 300 &&
          response.status < 400 &&
          response.headers.location
        ) {
          const next = new URL(response.headers.location, u).toString();
          validateUrl(next, this.opts.origins, this.opts.testMode);
          if (new URL(next).origin !== u.origin) headers = {};
          url = next;
          break;
        }
        if (response.status === 401)
          throw new ScrapeError(
            "NEEDS_AUTH",
            "Source requires authentication.",
          );
        if (response.status === 403)
          throw new ScrapeError("BLOCKED", "Source denied access.");
        if (response.status === 404 && !acceptedStatuses.includes(404))
          throw new ScrapeError("NOT_FOUND", "Public resource was not found.");
        if (
          response.status >= 400 &&
          !acceptedStatuses.includes(response.status)
        )
          throw new ScrapeError(
            "HTTP_ERROR",
            `Source returned HTTP ${response.status}.`,
          );
        return {
          body: response.body,
          url: safeUrl(u.toString()),
          headers: response.headers,
        };
      }
    }
    throw new ScrapeError("REDIRECT_LIMIT", "Too many source redirects.");
  }
  async json<T = Record<string, unknown>>(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const r = await this.get(url, 100 * 1024 ** 2, headers);
    let x: T;
    try {
      x = JSON.parse(r.body.toString()) as T;
    } catch {
      throw new ScrapeError(
        "INVALID_RESPONSE",
        "Expected JSON; source returned HTML or malformed data.",
      );
    }
    if (x && typeof x === "object" && "error" in x) {
      const e = (x as { error: { code?: number } }).error;
      throw new ScrapeError(
        [498, 499, 401].includes(e?.code ?? 0) ? "NEEDS_AUTH" : "SOURCE_ERROR",
        "Source returned an API error envelope.",
      );
    }
    return x;
  }
  async formJson<T>(
    url: string,
    value: Record<string, string | number | boolean>,
  ): Promise<T> {
    const body = new URLSearchParams(
      Object.entries(value).map(([k, v]) => [k, String(v)]),
    ).toString();
    const r = await this.get(
      url,
      100 * 1024 ** 2,
      { "content-type": "application/x-www-form-urlencoded" },
      body,
    );
    const data = JSON.parse(r.body.toString()) as T;
    if (data && typeof data === "object" && "error" in data)
      throw new ScrapeError(
        "SOURCE_ERROR",
        "Source returned an API error envelope.",
      );
    return data;
  }
  async postJson<T>(
    url: string,
    value: unknown,
    headers: Record<string, string> = {},
    acceptedStatuses: number[] = [],
  ): Promise<T> {
    const r = await this.get(
      url,
      100 * 1024 ** 2,
      { "content-type": "application/json", ...headers },
      JSON.stringify(value),
      acceptedStatuses,
    );
    try {
      return JSON.parse(r.body.toString()) as T;
    } catch {
      throw new ScrapeError(
        "INVALID_RESPONSE",
        "Expected JSON from the public query endpoint.",
      );
    }
  }
  private request(
    url: URL,
    limit: number,
    headers: Record<string, string>,
    payload?: string,
  ): Promise<{
    status: number;
    headers: http.IncomingHttpHeaders;
    body: Buffer;
  }> {
    return new Promise((resolve, reject) => {
      const requester = url.protocol === "https:" ? https : http;
      const req = requester.request(
        url,
        {
          method: payload === undefined ? "GET" : "POST",
          headers: {
            "user-agent": "WaterwellScraper/0.1 (public groundwater research)",
            "accept-encoding": "identity",
            ...headers,
          },
          signal: this.opts.signal,
          lookup: (hostname, options, callback) => {
            lookup(hostname, { all: true }, (err, addresses) => {
              if (err) return callback(err, "", 4);
              if (
                !addresses.length ||
                (!this.opts.testMode &&
                  addresses.some((a) => !isPublicAddress(a.address)))
              )
                return callback(
                  new Error("Private or invalid DNS destination"),
                  "",
                  4,
                );
              if (typeof options === "object" && options.all)
                callback(null, addresses);
              else callback(null, addresses[0]!.address, addresses[0]!.family);
            });
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let size = 0;
          res.on("data", (chunk: Buffer) => {
            size += chunk.length;
            this.bytes += chunk.length;
            if (size > limit || this.bytes > (this.opts.maxBytes ?? Infinity)) {
              reject(
                new ScrapeError(
                  size > limit ? "FILE_TOO_LARGE" : "BUDGET_BYTES",
                  "Response exceeds configured byte limit.",
                ),
              );
              res.destroy();
              req.destroy();
              return;
            }
            chunks.push(chunk);
          });
          res.on("error", reject);
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            }),
          );
        },
      );
      const timer = setTimeout(
        () => req.destroy(new Error("Request timeout")),
        Math.min(
          this.opts.requestTimeoutMs ?? 30000,
          Math.max(1, (this.opts.deadline ?? Infinity) - Date.now()),
        ),
      );
      req.on("close", () => clearTimeout(timer));
      req.on("error", reject);
      req.end(payload);
    });
  }
}
export function query(
  base: string,
  params: Record<string, string | number | boolean>,
) {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params))
    url.searchParams.set(k, String(v));
  return url.toString();
}
