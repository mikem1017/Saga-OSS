#!/usr/bin/env bash
# Read-mostly check of the Insights endpoints against a running Saga (default: a test instance on :18090).
# Run on the Saga host. Prints summaries only, never keys. The NL call costs ~1¢.
set -euo pipefail
set -a; . "${SAGA_ENV:-/opt/saga/.env}"; set +a
B=${1:-http://127.0.0.1:18090}; J=$(mktemp)
CSRF=$(curl -s -c "$J" -H 'content-type: application/json' -d "{\"username\":\"$SAGA_ADMIN_USER\",\"password\":\"$SAGA_ADMIN_PASSWORD\"}" "$B/api/auth/login" | python3 -c 'import json,sys;print(json.load(sys.stdin)["csrf"])')
g(){ curl -s -b "$J" "$B$1"; }
echo "== upgrades"; g /api/extras/upgrades | python3 -c 'import json,sys,collections;d=json.load(sys.stdin);print(d.get("error") or d["totals"]);it=d.get("items",[]);print(collections.Counter(i["reason"] for i in it));[print(i["key"],i["title"][:40],i["quality"],i["score"],i["cutoffQuality"],i["cutoffScore"],round(i["estBytes"]/1e9)) for i in it[:4]]'
echo "== hygiene"; g '/api/extras/hygiene?days=30' | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("error") or d["counts"]);[print(i["kind"],i["title"][:50],"|",i["detail"][:90]) for i in d.get("items",[])[:5]]'
echo "== forecast"; g /api/extras/forecast | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("error") or {k:d[k] for k in ("growthBytesPerDay","growthBasis","queueFits","poolSamples")});print("media",d.get("media"));print("imports last 3 days",d.get("importsDaily",[])[-3:])'
echo "== foryou"; g /api/extras/foryou | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("error") or d.get("note"));[print(u["user"],[s["title"] for s in u["seeds"]][:4],len(u["items"]),[i["title"] for i in u["items"][:4]]) for u in d.get("users",[])]'
echo "== autobump"; g /api/extras/autobump | python3 -c 'import json,sys;print(json.load(sys.stdin))'
echo "== nl status"; g /api/extras/nl | python3 -c 'import json,sys;d=json.load(sys.stdin);print({k:d.get(k) for k in ("enabled","model","capUsd","costUsd","queries")})'
echo "== nl run"; curl -s -b "$J" -H "x-csrf-token: $CSRF" -H 'content-type: application/json' -d '{"prompt":"90s heist films I do not have"}' "$B/api/extras/nl" | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("error") or (d["filters"]["summary"], d["dropped"], len(d["results"]), [(r["title"],r["year"],r["state"]["kind"]) for r in d["results"][:6]], d["monthToDate"]))'
rm -f "$J"
