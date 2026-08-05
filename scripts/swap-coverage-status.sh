#!/usr/bin/env bash
#
# Swap covered <-> waitlist on already-probed coverage records.
#
# Why: Picnic's `waitlist_area` flag is the opposite of its name — true = served,
# false = waitlist. Older data was stored with the inverted label. This rewrites
# the stored `status` in place so you don't have to re-probe thousands of areas
# through Picnic's WAF. (Same underlying data, just the corrected label.)
#
# It is GUARDED by a marker key (`pcmap:semantics-flipped`) so it is safe to run
# more than once — a second run is a no-op, not a re-inversion.
#
# IMPORTANT: run this against a Redis that was populated by the OLD image. Do it
# as part of rolling out the fixed image, before the fixed prober re-probes many
# areas (newly-probed records already use the correct mapping and must not be
# flipped). Running it late is not catastrophic — re-probes self-heal — but
# ideally swap first.
#
# Usage:
#   # Local docker-compose (default):
#   ./scripts/swap-coverage-status.sh
#
#   # Kubernetes (Redis StatefulSet pod redis-0 in namespace picnic-map):
#   REDIS="kubectl -n picnic-map exec -i redis-0 -- redis-cli" ./scripts/swap-coverage-status.sh
#
#   # Any custom redis-cli invocation:
#   REDIS="redis-cli -h HOST -p 6379 -a PASS" ./scripts/swap-coverage-status.sh
#
#   # Just show the current distribution without changing anything:
#   ./scripts/swap-coverage-status.sh count
#
set -euo pipefail

REDIS="${REDIS:-docker compose exec -T redis redis-cli}"

COUNT_LUA='local cur="0" local c={} repeat local r=redis.call("SCAN",cur,"MATCH","pcmap:cov:*","COUNT",1000) cur=r[1] for _,k in ipairs(r[2]) do local v=redis.call("GET",k) if v then local ok,o=pcall(cjson.decode,v) if ok and o then c[o.status]=(c[o.status] or 0)+1 end end end until cur=="0" local out="" for s,n in pairs(c) do out=out..s..":"..n.." " end return out'

SWAP_LUA='if redis.call("GET","pcmap:semantics-flipped")=="1" then return "already flipped — no-op" end local cur="0" local n=0 repeat local r=redis.call("SCAN",cur,"MATCH","pcmap:cov:*","COUNT",500) cur=r[1] for _,k in ipairs(r[2]) do local v=redis.call("GET",k) if v then local ok,o=pcall(cjson.decode,v) if ok and o then if o.status=="covered" then o.status="waitlist" redis.call("SET",k,cjson.encode(o)) n=n+1 elseif o.status=="waitlist" then o.status="covered" redis.call("SET",k,cjson.encode(o)) n=n+1 end end end end until cur=="0" redis.call("SET","pcmap:semantics-flipped","1") return "flipped "..n.." records"'

if [[ "${1:-}" == "count" ]]; then
  echo "Coverage status distribution:"
  $REDIS EVAL "$COUNT_LUA" 0
  exit 0
fi

echo "Before: $($REDIS EVAL "$COUNT_LUA" 0)"
echo "Swapping covered <-> waitlist…"
$REDIS EVAL "$SWAP_LUA" 0
echo "After:  $($REDIS EVAL "$COUNT_LUA" 0)"
