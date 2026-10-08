#!/usr/bin/env bash
# Operates a Minerva server from your checkout. <env> selects .env.<env> at the repository root, which
# holds DEPLOY_HOST and the server's configuration (see deploy/README.md).
#
#   deploy/ops.sh <env> bootstrap         set up the server (Docker, gVisor, firewall, SSH by key only)
#   deploy/ops.sh <env> env               install .env.<env> and .env.<env>.d/, and restart what changed
#   deploy/ops.sh <env> ci-key            make a new CI deploy key: server and GitHub environment <env>
#   deploy/ops.sh <env> deploy [<ref>]    deploy a commit of main (default: origin/main)
#   deploy/ops.sh <env> releases          the last deploys: time, commit, result, image digests
#   deploy/ops.sh <env> manage <args>     manage.py in the web container (MANAGE_SERVICE=supervisor: there)
#   deploy/ops.sh <env> compose <args>    docker compose on the server, e.g. ps, logs -f web
#   deploy/ops.sh <env> ssh               a shell on the server
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
GITHUB_REPO=minervacomputing/harness

if [[ $# -lt 2 ]]; then
  sed -n '2,13s/^# \{0,1\}//p' "$0" >&2
  exit 2
fi
ENV_NAME="$1"
COMMAND="$2"
shift 2
ENV_FILE=".env.$ENV_NAME"
if [[ ! "$ENV_NAME" =~ ^[a-z]+$ || ! -f "$ENV_FILE" ]]; then
  echo "$ENV_FILE is missing (see deploy/README.md)." >&2
  exit 1
fi
DEPLOY_HOST="$(sed -n 's/^DEPLOY_HOST=//p' "$ENV_FILE" | tail -1)"
if [[ -z "$DEPLOY_HOST" ]]; then
  echo "Set DEPLOY_HOST in $ENV_FILE." >&2
  exit 1
fi
REMOTE="root@$DEPLOY_HOST"

# A terminal for ssh when this one is interactive; otherwise none, and -T for docker compose exec.
SSH_TTY_FLAG=
EXEC_TTY_FLAG=-T
if [[ -t 0 && -t 1 ]]; then
  SSH_TTY_FLAG=-t
  EXEC_TTY_FLAG=
fi

case "$COMMAND" in
  bootstrap)
    ssh "$REMOTE" 'rm -rf /root/minerva-bootstrap && mkdir -p /root/minerva-bootstrap/server'
    scp -q deploy/bootstrap.sh "$REMOTE:/root/minerva-bootstrap/"
    scp -q deploy/server/minerva-deploy "$REMOTE:/root/minerva-bootstrap/server/"
    ssh "$REMOTE" 'bash /root/minerva-bootstrap/bootstrap.sh'
    ;;

  env)
    # Uploaded to a directory of this invocation's own, installed under the deploy lock, so a release
    # never starts on half-written configuration. The backend runs as uid 10001.
    UPLOAD="$(ssh "$REMOTE" 'mktemp -d /opt/minerva/upload.XXXXXX')"
    echo "== Installing $ENV_FILE as /opt/minerva/.env"
    ssh "$REMOTE" "umask 077 && cat > $UPLOAD/env" < "$ENV_FILE"
    # Secret files, such as the Sign in with Apple key, mounted read-only at /run/secrets/minerva.
    if [[ -d "$ENV_FILE.d" ]]; then
      echo "== Installing $ENV_FILE.d/ as /opt/minerva/secrets"
      ssh "$REMOTE" "mkdir $UPLOAD/secrets"
      rsync -rt "$ENV_FILE.d/" "$REMOTE:$UPLOAD/secrets/"
    fi
    ssh "$REMOTE" "UPLOAD=$UPLOAD bash -s" <<'REMOTE'
set -euo pipefail
trap 'rm -rf "$UPLOAD"' EXIT
exec 9>/opt/minerva/deploy.lock
flock 9
cd /opt/minerva
mv "$UPLOAD/env" .env
changed=
if [[ -d "$UPLOAD/secrets" ]]; then
  # Into the same directory: running containers keep the one they mounted, even if it is replaced.
  changed="$(rsync -r --checksum --delete --itemize-changes "$UPLOAD/secrets/" secrets/)"
  chown -R root:10001 secrets
  find secrets -type d -exec chmod 750 {} +
  find secrets -type f -exec chmod 440 {} +
fi
if [[ -f release.env ]]; then
  echo "== Restarting the services whose configuration changed"
  minerva-compose up --detach --wait --wait-timeout 300
  if [[ -n "$changed" ]]; then
    echo "== Restarting the backend for the new secret files"
    minerva-compose restart web gateway supervisor
  fi
fi
REMOTE
    ;;

  ci-key)
    # The key can only run minerva-deploy (a forced command). Running this again replaces it.
    command -v gh >/dev/null || { echo "Needs the GitHub CLI (gh), signed in with admin rights on $GITHUB_REPO." >&2; exit 1; }
    TMP="$(mktemp -d)"
    trap 'rm -rf "$TMP"' EXIT
    ssh-keygen -q -t ed25519 -N '' -C minerva-ci -f "$TMP/key"
    echo "== Authorizing the key on $DEPLOY_HOST for minerva-deploy only"
    ssh "$REMOTE" 'set -e
read -r key
f=/root/.ssh/authorized_keys
{ grep -v " minerva-ci$" "$f" || true; printf "restrict,command=\"/usr/local/bin/minerva-deploy\" %s\n" "$key"; } > "$f.new"
chmod 600 "$f.new"
mv "$f.new" "$f"' < "$TMP/key.pub"
    # Pinned from the server itself, over the connection already trusted, not from ssh-keyscan.
    KNOWN_HOSTS="$DEPLOY_HOST $(ssh "$REMOTE" 'cut -d" " -f1,2 /etc/ssh/ssh_host_ed25519_key.pub')"
    echo "== GitHub environment $ENV_NAME: main only, with the key, host and host key as secrets"
    gh api --silent -X PUT "repos/$GITHUB_REPO/environments/$ENV_NAME" --input - \
      <<<'{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}'
    POLICIES="repos/$GITHUB_REPO/environments/$ENV_NAME/deployment-branch-policies"
    # Assigned first, so that a failed request stops here.
    OTHERS="$(gh api --paginate "$POLICIES" --jq '.branch_policies[] | select(.name != "main" or .type != "branch") | .id')"
    for id in $OTHERS; do
      gh api --silent -X DELETE "$POLICIES/$id"
    done
    MAIN="$(gh api --paginate "$POLICIES" --jq '.branch_policies[] | select(.name == "main" and .type == "branch") | .id')"
    if [[ -z "$MAIN" ]]; then
      gh api --silent -X POST "$POLICIES" -f name=main -f type=branch
    fi
    gh secret set DEPLOY_SSH_KEY --repo "$GITHUB_REPO" --env "$ENV_NAME" < "$TMP/key"
    gh secret set DEPLOY_KNOWN_HOSTS --repo "$GITHUB_REPO" --env "$ENV_NAME" --body "$KNOWN_HOSTS"
    gh secret set DEPLOY_HOST --repo "$GITHUB_REPO" --env "$ENV_NAME" --body "$DEPLOY_HOST"
    echo "== Done. CI deploys to $ENV_NAME from the next push to main."
    ;;

  deploy)
    REF="${1:-origin/main}"
    git fetch --quiet origin main
    COMMIT="$(git rev-parse --verify --quiet "$REF^{commit}")" || { echo "Unknown commit: $REF" >&2; exit 1; }
    if ! git merge-base --is-ancestor "$COMMIT" origin/main; then
      echo "$REF is not on origin/main; only pushed commits of main are deployed." >&2
      exit 1
    fi
    echo "== Deploying $(git log -1 --format='%h %cs %s' "$COMMIT") to $ENV_NAME"
    ssh "$REMOTE" minerva-deploy "$COMMIT"
    ;;

  releases)
    ssh "$REMOTE" 'tail -n 20 /opt/minerva/releases'
    ;;

  manage)
    [[ $# -gt 0 ]] || { echo "Usage: deploy/ops.sh $ENV_NAME manage <manage.py command> [args...]" >&2; exit 2; }
    [[ "${MANAGE_SERVICE:-web}" =~ ^[a-z-]+$ ]] || { echo "MANAGE_SERVICE must be a service name." >&2; exit 2; }
    printf -v ARGS ' %q' "$@"
    ssh $SSH_TTY_FLAG "$REMOTE" "minerva-compose exec $EXEC_TTY_FLAG ${MANAGE_SERVICE:-web} python manage.py$ARGS"
    ;;

  compose)
    printf -v ARGS ' %q' "$@"
    ssh $SSH_TTY_FLAG "$REMOTE" "minerva-compose$ARGS"
    ;;

  ssh)
    ssh "$REMOTE"
    ;;

  *)
    echo "Unknown command: $COMMAND" >&2
    exit 2
    ;;
esac
