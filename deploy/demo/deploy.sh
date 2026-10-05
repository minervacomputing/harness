#!/usr/bin/env bash
# Ships the current commit to the demo VPS and (re)starts the stack. Run from the repository root:
#   deploy/demo/deploy.sh
# Refuses to run with uncommitted or untracked changes, so what runs is always a commit; its id is
# written to /opt/minerva/REVISION.
# Reads DEMO_HOST from the environment or from .env.demo, which is also installed as /opt/minerva/.env.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [[ ! -f .env.demo ]]; then
  echo ".env.demo is missing (see deploy/demo/README.md)." >&2
  exit 1
fi
DEMO_HOST="${DEMO_HOST:-$(sed -n 's/^DEMO_HOST=//p' .env.demo | tail -1)}"
if [[ -z "$DEMO_HOST" ]]; then
  echo "Set DEMO_HOST in the environment or in .env.demo." >&2
  exit 1
fi
REMOTE="root@$DEMO_HOST"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit or stash these changes first; only commits are deployed:" >&2
  git status --short >&2
  exit 1
fi
REVISION="$(git log -1 --format='%H %cs %s')"

# Exported from the commit rather than copied from the checkout, so ignored local files stay behind.
EXPORT="$(mktemp -d)"
trap 'rm -rf "$EXPORT"' EXIT
git archive HEAD | tar -x -C "$EXPORT"

echo "== Syncing ${REVISION%% *} to $REMOTE:/opt/minerva/src"
rsync -az --delete \
  --exclude /design/ \
  --exclude /docs/images/ \
  --exclude /deepseek-harness/ \
  --exclude /.agents/ \
  --exclude /.claude/ \
  "$EXPORT/" "$REMOTE:/opt/minerva/src/"

echo "== Installing .env.demo as /opt/minerva/.env"
# Compose needs DOCKER_GID (the docker socket's group, for the supervisor); it is appended on the host.
grep -v '^DOCKER_GID=' .env.demo | ssh "$REMOTE" 'umask 077 && cat > /opt/minerva/.env.new \
  && echo "DOCKER_GID=$(stat -c %g /var/run/docker.sock)" >> /opt/minerva/.env.new \
  && mv /opt/minerva/.env.new /opt/minerva/.env && chmod 600 /opt/minerva/.env'

echo "== Installing .env.demo.d/ as /opt/minerva/secrets"
# Secret files, such as the Sign in with Apple key, mounted read-only at /run/secrets/minerva. The
# backend runs as uid 10001.
ssh "$REMOTE" 'install -d -m 750 -o root -g 10001 /opt/minerva/secrets'
if [[ -d .env.demo.d ]]; then
  # macOS ships openrsync, which has no --chmod or --chown, so the modes are set afterwards.
  rsync -rt --delete .env.demo.d/ "$REMOTE:/opt/minerva/secrets/"
  ssh "$REMOTE" 'chown -R root:10001 /opt/minerva/secrets \
    && find /opt/minerva/secrets -type d -exec chmod 750 {} + \
    && find /opt/minerva/secrets -type f -exec chmod 440 {} +'
fi

echo "== Building and starting"
ssh "$REMOTE" 'set -e
cd /opt/minerva
docker build -t minerva-worker:demo src/worker
docker compose -f src/deploy/demo/compose.yaml --env-file /opt/minerva/.env up -d --build --remove-orphans
docker image prune -f >/dev/null
docker compose -f src/deploy/demo/compose.yaml --env-file /opt/minerva/.env ps'

# Written last, so it names what is actually running.
printf '%s\n' "$REVISION" | ssh "$REMOTE" 'cat > /opt/minerva/REVISION'
echo "== Deployed $REVISION"
