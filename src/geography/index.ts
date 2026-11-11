import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ScrapeError, type Geography } from "../core/types.js";
import { hash } from "../core/util.js";
const dataPath = new URL("../../data/counties.json", import.meta.url);
const stateNames: Record<string, string> = Object.fromEntries(
  "AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|DE:Delaware|DC:District of Columbia|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|WI:Wisconsin|WY:Wyoming"
    .split("|")
    .map((s) => s.split(":")) as [string, string][],
);
const fips =
  "AL:01 AK:02 AZ:04 AR:05 CA:06 CO:08 CT:09 DE:10 DC:11 FL:12 GA:13 HI:15 ID:16 IL:17 IN:18 IA:19 KS:20 KY:21 LA:22 ME:23 MD:24 MA:25 MI:26 MN:27 MS:28 MO:29 MT:30 NE:31 NV:32 NH:33 NJ:34 NM:35 NY:36 NC:37 ND:38 OH:39 OK:40 OR:41 PA:42 RI:44 SC:45 SD:46 TN:47 TX:48 UT:49 VT:50 VA:51 WA:53 WV:54 WI:55 WY:56"
    .split(" ")
    .map((s) => s.split(":") as [string, string]);
const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");
const alias = (s: string) =>
  normalize(s).replace(
    / (county|parish|borough|census area|municipality|planning region|city)$/,
    "",
  );
export function resolveGeography(state: string, county: string): Geography {
  const pair = fips.find(
    ([abbr, code]) =>
      normalize(state) === abbr.toLowerCase() ||
      normalize(state) === stateNames[abbr]!.toLowerCase() ||
      state === code,
  );
  if (!pair)
    throw new ScrapeError(
      "INVALID_INPUT",
      "Unknown US state. Use a full name, postal abbreviation, or two-digit FIPS.",
    );
  const text = readFileSync(fileURLToPath(dataPath), "utf8");
  const ref = JSON.parse(text) as {
    vintage: string;
    counties: { NAME: string; STATE: string; COUNTY: string; GEOID: string }[];
  };
  const candidates = ref.counties.filter((c) => c.STATE === pair[1]);
  const exact = candidates.filter(
    (c) =>
      normalize(c.NAME) === normalize(county) ||
      c.GEOID === county ||
      c.COUNTY === county,
  );
  const matches = exact.length
    ? exact
    : candidates.filter((c) => alias(c.NAME) === alias(county));
  if (matches.length !== 1)
    throw new ScrapeError(
      "INVALID_INPUT",
      matches.length
        ? "Ambiguous county: " + matches.map((c) => c.NAME).join(", ")
        : `Unknown county in ${stateNames[pair[0]]}. Use its official name or FIPS.`,
    );
  const c = matches[0]!;
  return {
    state: pair[0],
    state_name: stateNames[pair[0]]!,
    state_fips: c.STATE,
    county: c.NAME,
    county_fips: c.COUNTY,
    county_geoid: c.GEOID,
    vintage: ref.vintage,
    reference_sha256: hash(text),
  };
}

export function geographyCatalog() {
  const ref = JSON.parse(readFileSync(fileURLToPath(dataPath), "utf8")) as {
    counties: { NAME: string; STATE: string; GEOID: string }[];
  };
  return fips
    .map(([abbr, code]) => ({
      code: abbr,
      name: stateNames[abbr]!,
      fips: code,
      counties: ref.counties
        .filter((c) => c.STATE === code)
        .map((c) => ({ name: c.NAME, geoid: c.GEOID }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
