#!/usr/bin/env bash
# Runs `manage.py <args>` in the demo's web container over ssh, e.g.
#   deploy/demo/manage.sh demo_sync
#   deploy/demo/manage.sh createsuperuser
# MANAGE_SERVICE=supervisor runs it where the Docker socket is, e.g. for sandbox_check.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
DEMO_HOST="${DEMO_HOST:-$( [[ -f .env.demo ]] && sed -n 's/^DEMO_HOST=//p' .env.demo | tail -1)}"
if [[ -z "$DEMO_HOST" ]]; then
  echo "Set DEMO_HOST in the environment or in .env.demo." >&2
  exit 1
fi
if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <manage.py command> [args...]" >&2
  exit 2
fi

SERVICE="${MANAGE_SERVICE:-web}"
TTY=-T
SSH_TTY_FLAG=
if [[ -t 0 && -t 1 ]]; then
  TTY=
  SSH_TTY_FLAG=-t
fi

printf -v ARGS ' %q' "$@"
ssh $SSH_TTY_FLAG "root@$DEMO_HOST" \
  "cd /opt/minerva && docker compose -f src/deploy/demo/compose.yaml --env-file /opt/minerva/.env exec $TTY $SERVICE python manage.py$ARGS"
