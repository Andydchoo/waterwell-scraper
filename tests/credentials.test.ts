import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkStorageState,
  resolveCredentials,
} from "../src/credentials/index.js";
import { portalManifest } from "../src/sources/registry.js";
// Portals are discovered at run time; a saved login is scoped to the portal's origin.
const portal = portalManifest(
  "https://portal.example.gov/Archive/Welcome.aspx?repo=Public",
);

test("saved credentials reject expired sessions, unrelated origins and unsafe permissions", () => {
  const old = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), "well-auth-"));
  const directory = join(process.env.XDG_CONFIG_HOME, "well-scraper");
  mkdirSync(directory);
  const path = join(directory, "session.json");
  const source = portal;
  const save = (
    domain: string,
    expires: number,
    origin = "https://portal.example.gov",
  ) =>
    writeFileSync(
      path,
      JSON.stringify({ cookies: [{ domain, expires }], origins: [{ origin }] }),
      { mode: 0o600 },
    );
  try {
    save("portal.example.gov", Date.now() / 1000 + 3600);
    assert.equal(checkStorageState(path, source), path);
    save("portal.example.gov", 1);
    assert.throws(() => checkStorageState(path, source), /expired/);
    save("unrelated.gov", -1);
    assert.throws(() => checkStorageState(path, source), /unrelated origin/);
    save("portal.example.gov", -1, "https://unrelated.gov");
    assert.throws(() => checkStorageState(path, source), /unrelated origin/);
    save("portal.example.gov", -1);
    chmodSync(path, 0o644);
    assert.throws(() => checkStorageState(path, source), /chmod 600/);
  } finally {
    if (old === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = old;
  }
});
test("incomplete source credentials fail before reading unrelated local files", () => {
  const source = portal;
  const keys = [
    "WELL_SCRAPER_PORTAL_PORTAL_EXAMPLE_GOV_USERNAME",
    "WELL_SCRAPER_PORTAL_PORTAL_EXAMPLE_GOV_PASSWORD",
    "WELL_SCRAPER_PORTAL_PORTAL_EXAMPLE_GOV_API_KEY",
  ];
  const old = keys.map((k) => process.env[k]);
  try {
    keys.forEach((k) => delete process.env[k]);
    process.env[keys[0]!] = "fixture-user";
    assert.throws(
      () => resolveCredentials(source, undefined, ["/not-a-credential-file"]),
      /incomplete/,
    );
  } finally {
    keys.forEach((k, i) => {
      if (old[i] === undefined) delete process.env[k];
      else process.env[k] = old[i];
    });
  }
});
