import {
  existsSync,
  statSync,
  readFileSync,
  realpathSync,
  mkdirSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import type { SourceManifest } from "../core/types.js";
import { ScrapeError } from "../core/types.js";
const ProfileSchema = z
  .object({
    sourceIds: z.array(z.string()),
    allowedOrigins: z.array(z.string().url()),
    provider: z.enum(["environment", "local-file", "storage-state"]),
    usernameEnv: z.string().optional(),
    passwordEnv: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    apiKey: z.string().optional(),
    storageStatePath: z.string().optional(),
  })
  .strict();
const FileSchema = z
  .object({ profiles: z.record(z.string(), ProfileSchema) })
  .strict();
export interface Credentials {
  provider: string;
  username?: string;
  password?: string;
  apiKey?: string;
  storageState?: string;
}
export const configDir = () =>
  join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "well-scraper",
  );
function privateFile(path: string) {
  const s = statSync(path);
  if (
    !s.isFile() ||
    (s.mode & 0o077) !== 0 ||
    (process.getuid && s.uid !== process.getuid())
  )
    throw new ScrapeError(
      "UNSAFE_CREDENTIAL_FILE",
      "Credential/session files must be owned by the current user and chmod 600.",
    );
}
function expand(path: string) {
  return resolve(path.startsWith("~/") ? join(homedir(), path.slice(2)) : path);
}
export function sessionPath(source: SourceManifest) {
  return join(configDir(), "sessions", source.id + ".json");
}
export function checkStorageState(path: string, source: SourceManifest) {
  const p = expand(path);
  privateFile(p);
  const allowed = [resolve(configDir()), resolve(".well-scraper")]
    .filter(existsSync)
    .map((path) => realpathSync(path));
  const real = realpathSync(p);
  if (!allowed.some((root) => real.startsWith(root + sep)))
    throw new ScrapeError(
      "UNSAFE_CREDENTIAL_FILE",
      "Browser state must be inside an application-owned credential directory.",
    );
  const state = JSON.parse(readFileSync(p, "utf8")) as {
    cookies?: { domain: string; expires: number }[];
    origins?: { origin: string }[];
  };
  const hosts = [new URL(source.landingPage).hostname];
  if (
    state.origins?.some(
      (o) => o.origin !== new URL(source.landingPage).origin,
    ) ||
    state.cookies?.some((c) => !hosts.includes(c.domain.replace(/^\./, "")))
  )
    throw new ScrapeError(
      "CREDENTIAL_ORIGIN",
      "Saved session contains an unrelated origin.",
    );
  if (
    state.cookies?.length &&
    state.cookies.every((c) => c.expires > 0 && c.expires < Date.now() / 1000)
  )
    throw new ScrapeError(
      "NEEDS_AUTH",
      "Saved session has expired; log in again.",
    );
  return p;
}
export function resolveCredentials(
  source: SourceManifest,
  profileName?: string,
  roots = [
    join(process.cwd(), ".well-scraper", "credentials.local.json"),
    join(configDir(), "credentials.json"),
  ],
): Credentials | undefined {
  const envPrefix =
    "WELL_SCRAPER_" + source.id.toUpperCase().replaceAll("-", "_");
  if (!profileName) {
    const username = process.env[envPrefix + "_USERNAME"],
      password = process.env[envPrefix + "_PASSWORD"],
      apiKey = process.env[envPrefix + "_API_KEY"];
    if (username || password || apiKey) {
      if (!apiKey && (!username || !password))
        throw new ScrapeError(
          "INCOMPLETE_CREDENTIALS",
          "Source environment credentials are incomplete.",
        );
      return { provider: "environment", username, password, apiKey };
    }
  }
  for (const path of roots) {
    if (!existsSync(path)) continue;
    privateFile(path);
    const config = FileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    const entry = profileName
      ? Object.entries(config.profiles).find(([key]) => key === profileName)
      : Object.entries(config.profiles).find(([, p]) =>
          p.sourceIds.includes(source.id),
        );
    if (!entry) continue;
    const p = entry[1];
    if (
      !p.sourceIds.includes(source.id) ||
      !p.allowedOrigins.length ||
      p.allowedOrigins.some((o) => o !== new URL(source.landingPage).origin)
    )
      throw new ScrapeError(
        "CREDENTIAL_ORIGIN",
        "Profile does not belong to this source/origin.",
      );
    const result: Credentials = { provider: p.provider };
    if (p.provider === "environment") {
      result.username = p.usernameEnv ? process.env[p.usernameEnv] : undefined;
      result.password = p.passwordEnv ? process.env[p.passwordEnv] : undefined;
      result.apiKey = p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined;
    }
    if (p.provider === "local-file") {
      result.username = p.username;
      result.password = p.password;
      result.apiKey = p.apiKey;
    }
    if (p.storageStatePath && existsSync(expand(p.storageStatePath)))
      result.storageState = checkStorageState(p.storageStatePath, source);
    if (
      !result.storageState &&
      !result.apiKey &&
      (!result.username || !result.password)
    )
      throw new ScrapeError(
        "INCOMPLETE_CREDENTIALS",
        "Selected local profile is incomplete.",
      );
    return result;
  }
  if (profileName)
    throw new ScrapeError(
      "NEEDS_AUTH",
      "Selected credential profile was not found.",
    );
  const saved = sessionPath(source);
  if (existsSync(saved))
    return {
      provider: "storage-state",
      storageState: checkStorageState(saved, source),
    };
  return undefined;
}
export function prepareSessionDir() {
  const dir = join(configDir(), "sessions");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}
export function logout(source: SourceManifest) {
  const path = sessionPath(source);
  if (existsSync(path)) unlinkSync(path);
}
