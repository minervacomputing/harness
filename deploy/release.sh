#!/usr/bin/env bash
# One release on the server: pulls the commit's images, starts them, checks them, and records the result
# in /opt/minerva/releases. Run as root by minerva-deploy, from the commit it checked out, under the
# deploy lock. Never run it by hand; use `deploy/ops.sh <env> deploy <commit>`.
set -euo pipefail
# Also inside $(...), so that one failed command in a loop there fails the release.
shopt -s inherit_errexit

commit="$1"
REGISTRY=ghcr.io/minervacomputing
IMAGES=(minerva-backend minerva-proxy minerva-worker)
# Successful releases whose images stay on the server, for a quick rollback. Older ones are pulled again.
KEEP=5

cd /opt/minerva
dc() { bash /opt/minerva/src/deploy/server/minerva-compose "$@"; }

result=failed
digests=-
trap 'printf "%s %s %s %s\n" "$(date -u +%FT%TZ)" "$commit" "$result" "$digests" >> releases' EXIT

echo "== Pulling the images of $commit"
for image in "${IMAGES[@]}"; do
  if ! docker pull --quiet "$REGISTRY/$image:$commit" >/dev/null; then
    echo "Cannot pull $REGISTRY/$image:$commit. Has CI built this commit, and is the package public?" >&2
    exit 1
  fi
done
digests="$(for image in "${IMAGES[@]}"; do
  docker image inspect --format '{{index .RepoDigests 0}}' "$REGISTRY/$image:$commit"
done | paste -sd, -)"

echo "== Starting"
printf 'MINERVA_RELEASE=%s\nDOCKER_GID=%s\n' "$commit" "$(stat -c %g /var/run/docker.sock)" > release.env.new
# A configuration error stops the release here, while the previous one still runs and stays recorded.
docker compose -f src/deploy/compose.yaml --env-file .env --env-file release.env.new config --quiet
mv release.env.new release.env
dc up --detach --wait --wait-timeout 300 --remove-orphans

echo "== Checking"
dc exec -T proxy wget -q -O /dev/null http://localhost/api/health
# Starts workers under gVisor and checks that they reach the gateway and nothing else.
dc exec -T supervisor python manage.py sandbox_check
result=ok

echo "== Removing the images of older releases"
# Never `docker image prune -a`: between runs no container uses the worker image, so it would go too.
keep="$({ awk '$3 == "ok" { print $2 }' releases 2>/dev/null || true; echo "$commit"; } | tail -n "$KEEP")"
for ref in $(docker image ls --format '{{.Repository}}:{{.Tag}}' | grep "^$REGISTRY/minerva-" || true); do
  grep -qxF "${ref##*:}" <<<"$keep" || docker image rm "$ref" >/dev/null || true
done
docker image prune --force >/dev/null || true

dc ps
echo "== Released $commit"
