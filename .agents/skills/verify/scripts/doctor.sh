#!/usr/bin/env bash
# Read-only: is the local engine worth driving? Checks the Worker (:8787) and the frontend (:5173) are up,
# started from this checkout, and answering. Prints one line per check; exits 1 if any fails.
set -u
root="$(cd "$(dirname "$0")/../../../.." && pwd -P)"
fail=0
check() { if eval "$2" >/dev/null 2>&1; then echo "ok    $1"; else echo "FAIL  $1"; fail=1; fi; }

for port in 8787 5173; do
	pid="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1)"
	if [ -z "$pid" ]; then echo "FAIL  nothing listens on :$port"; fail=1; continue; fi
	cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
	case "$cwd" in
		"$root"*) echo "ok    :$port is pid $pid in $cwd" ;;
		*) echo "FAIL  :$port is pid $pid in ${cwd:-?}, not this checkout ($root)"; fail=1 ;;
	esac
done
check "the Worker answers /api/health" "curl -sf http://127.0.0.1:8787/api/health"
check "the frontend proxies /api/health" "curl -sf http://localhost:5173/api/health"
check "/api/me answers 401 signed out" "[ \"\$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173/api/me)\" = 401 ]"
check "cloudflare/.dev.vars exists" "[ -f '$root/cloudflare/.dev.vars' ]"
if docker info >/dev/null 2>&1; then echo "ok    Docker runs (the sandbox has a container)"; else echo "warn  Docker is not running: tools that need the sandbox fail"; fi
exit "$fail"
