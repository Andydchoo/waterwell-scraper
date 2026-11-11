#!/usr/bin/env bash
# Scripted terminal demo for screen recording. Runs real, bounded collections
# against the fast public API sources, then tours the files they produce.
#
#   scripts/demo.sh            # paced automatically
#   scripts/demo.sh --step     # wait for Enter between steps (for narration)
#   scripts/demo.sh --reports  # also run the browser collector in a visible window
#   DEMO_SPEED=0.5 scripts/demo.sh   # halve all pauses and typing delays
#
# The place is supplied when the demo runs; none is built in:
#   DEMO_STATE=NC DEMO_COUNTY=Mecklenburg scripts/demo.sh
#
# Output goes to ./runs/demo (ignored by git). Displayed tables omit street
# addresses, parcel IDs and coordinates; the files on disk still contain them.

set -u -o pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="./runs/demo"
SPEED="${DEMO_SPEED:-1}"
STEP=0
REPORTS=0
for arg in "$@"; do
  case "$arg" in
    --step) STEP=1 ;;
    --reports) REPORTS=1 ;;
  esac
done

cd "$ROOT"

STATE="${DEMO_STATE:-}"
COUNTY="${DEMO_COUNTY:-}"
if [ -z "$STATE" ] || [ -z "$COUNTY" ]; then
  echo "Set DEMO_STATE and DEMO_COUNTY, for example: DEMO_STATE=NC DEMO_COUNTY=Mecklenburg scripts/demo.sh" >&2
  exit 5
fi

if [ "$(node -v 2>/dev/null | cut -d. -f1)" != "v24" ]; then
  # shellcheck disable=SC1091
  source "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null && nvm use >/dev/null || {
    echo "Node 24 is required (see .nvmrc)." >&2
    exit 1
  }
fi
[ -f dist/cli.js ] || npm run build >/dev/null

well-scraper() { node "$ROOT/dist/cli.js" "$@"; }

B=$'\033[1m'; DIM=$'\033[2m'; G=$'\033[32m'; Y=$'\033[33m'; C=$'\033[36m'; R=$'\033[0m'

pause() { sleep "$(echo "${1:-1.5} * $SPEED" | bc -l)"; }

next() {
  if [ "$STEP" = 1 ]; then
    read -r -s
  else
    pause "${1:-2.5}"
  fi
}

heading() { printf '\n%s%s# %s%s\n' "$B" "$C" "$1" "$R"; pause 0.8; }

# Print a command as if typed, then return so the caller runs it.
type_cmd() {
  local s="$1" delay i
  delay="$(echo "0.025 * $SPEED" | bc -l)"
  printf '%s$%s ' "$G" "$R"
  for ((i = 0; i < ${#s}; i++)); do
    printf '%s' "${s:i:1}"
    sleep "$delay"
  done
  pause 0.5
  printf '\n'
}

# Render the CLI's JSON event stream (stderr) as readable progress lines.
fmt_events() {
  jq -R -r --unbuffered '
    fromjson? | (.timestamp[11:19]) as $t |
    if .event == "run.started" then "\($t)  ▶ run started"
    elif .event == "source.started" then "\($t)  → \(.source_id)"
    elif .event == "batch.committed" then "\($t)      · committed batch of \(.count)"
    elif .event == "source.finished" then
      "\($t)    \(if .status == "failed" then "✗" elif .status == "success" then "✓" else "◐" end) "
      + "\(.dataset_id // "-")  \(.status)  \(.accepted // 0) records"
      + (if (.quarantined // 0) > 0 then ", \(.quarantined) quarantined" else "" end)
    elif .event == "run.finished" then "\($t)  ■ run finished: \(.outcome)"
    else empty end'
}

LAST_DIR=""

# collect <display-args> ...: types the command, streams progress, prints counts.
collect() {
  local summary
  summary="$(mktemp)"
  type_cmd "well-scraper collect $*"
  { well-scraper collect "$@" 2>&1 1>"$summary"; } | fmt_events
  LAST_DIR="$(jq -r '.directory' "$summary")"
  jq -r '"  " + (.counts | to_entries | map(select(.value > 0) | "\(.key): \(.value)") | join("   "))' \
    "$summary" | sed "s/^/${B}/;s/$/${R}/"
  rm -f "$summary"
}

table() { column -t -s $'\t' | sed 's/^/  /'; }

clear
printf '%sWater well scraper%s — %s, %s\n' "$B" "$R" "$COUNTY" "$STATE"
printf '%sPublic well records, found and collected live by API, browser and file download.%s\n' "$DIM" "$R"
next 2.5

heading "Which collectors run for this county? (the same ones run for any county)"
type_cmd "well-scraper sources --state $STATE --county $COUNTY"
well-scraper sources --state "$STATE" --county "$COUNTY" |
  jq -r '(["COLLECTOR", "APPROACH", "PUBLISHER"] | @tsv), (.sources[] | [.id, .approach, .agency] | @tsv)' | table
next 3

heading "Public API: discover GIS well layers for the county and query them (bounded sample)"
collect --state "$STATE" --county "$COUNTY" --approach api \
  --max-records 300 --max-duration 180 --max-targets 6 --output "$OUT"
API_DIR="$LAST_DIR"
next 2.5

heading "File download: Water Quality Portal files and published layer exports"
collect --state "$STATE" --county "$COUNTY" --approach download \
  --max-records 300 --max-duration 180 --max-targets 3 --output "$OUT"
FILE_DIR="$LAST_DIR"
next 2.5

if [ "$REPORTS" = 1 ]; then
  heading "Browser navigation: open the public catalog in Chromium and collect what its pages load"
  collect --state "$STATE" --county "$COUNTY" --approach browser --headful \
    --max-records 300 --max-duration 300 --max-targets 6 --output "$OUT"
  next 3
fi

heading "Runs are filed by day; each writes CSV, JSONL, raw responses and a collection log"
type_cmd "ls $OUT/$(basename "$(dirname "$API_DIR")")"
ls "$(dirname "$API_DIR")" | sed 's/^/  /'
next 3

heading "Collection log: what discovery found, and what each layer returned"
sed -n '1,/^## Files/p' "$API_DIR/summary.md" | sed '$d' | cut -c1-160 | sed 's/^/  /'
next 4

heading "wells.csv — sample (addresses hidden)"
jq -r '[.source_well_id // "-", .acquisition_method, .well_use // "-", .well_status // "-",
        (.total_depth.value // "-"), (.total_depth.unit // "-")] | @tsv' \
  "$API_DIR/wells.jsonl" "$FILE_DIR/wells.jsonl" 2>/dev/null |
  awk -F'\t' '$1 != "-"' | head -10 |
  { printf 'WELL ID\tAPPROACH\tUSE\tSTATUS\tDEPTH\tUNIT\n'; cat; } | table
next 4

printf '\n%sDone.%s Stored data is also available over the local API:\n' "$B" "$R"
printf '  %swell-scraper serve --output %s   # then GET /api/v1/days%s\n\n' "$DIM" "$OUT" "$R"
