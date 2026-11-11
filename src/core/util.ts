import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export const now = () => new Date().toISOString();
/** Calendar day in local time: the unit runs and their records are grouped by. */
export function localDay(date = new Date()) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
export function atomicWrite(path: string, value: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, value, { mode: 0o600 });
  renameSync(tmp, path);
}
const secretKey =
  /password|passwd|secret|authorization|cookie|token|api.?key|signature|credential_value/i;
export function safeUrl(value: string): string {
  try {
    const u = new URL(value);
    u.username = "";
    u.password = "";
    for (const k of [...u.searchParams.keys()])
      if (secretKey.test(k)) u.searchParams.set(k, "[REDACTED]");
    return u.toString();
  } catch {
    return value;
  }
}
export function redact(value: unknown, secrets: string[] = []): unknown {
  if (typeof value === "string") {
    let s = value
      .replace(/https?:\/\/[^\s<>"']+/g, safeUrl)
      .replace(/(Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, "$1 [REDACTED]");
    s = s.replace(
      /((?:set-cookie|cookie|authorization)\s*:)\s*[^\r\n]+/gi,
      "$1 [REDACTED]",
    );
    s = s.replace(
      /((?:password|token|secret|api_key)\s*[=:]\s*)[^\s&,;]+/gi,
      "$1[REDACTED]",
    );
    for (const secret of secrets)
      if (secret) s = s.split(secret).join("[REDACTED]");
    return s;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        secretKey.test(k) ? "[REDACTED]" : redact(v, secrets),
      ]),
    );
  return value;
}
