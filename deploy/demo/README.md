# Demo deployment

The public demo at <https://demo.minervacomputing.com> runs on one Debian 13 VPS (Ubuntu 24.04 works too). A Cloudflare Tunnel brings traffic in, so the server opens no inbound ports except SSH.

```text
Cloudflare ─ tunnel ─ cloudflared ─ proxy (Caddy: SPA, /api → web:8000)
                                     web, gateway, supervisor, cleanup ─ postgres
supervisor ─ /var/run/docker.sock ─ worker containers (gVisor, no network)
worker ─ gateway.sock (read-only volume) ─ gateway-socket ─ gateway:8001
```

| File | Purpose |
|---|---|
| `compose.yaml` | The whole stack (project `minerva-demo`) |
| `Dockerfile.backend` | One image for web, gateway, supervisor, migrate and cleanup |
| `Dockerfile.frontend`, `Caddyfile` | The Vite build served by Caddy, which also proxies `/api` |
| `bootstrap.sh` | One-time server setup: Docker, gVisor, firewall, SSH by key only, unattended upgrades, swap |
| `deploy.sh` | Deploys the `demo` branch's current commit and restarts the stack |
| `manage.sh` | Runs `manage.py` in the web container |

## Configuration: `.env.demo`

Keep `.env.demo` at the repository root. It is gitignored. `deploy.sh` installs it on the server as `/opt/minerva/.env` (mode 600). It must contain:

| Variable | Notes |
|---|---|
| `DEMO_HOST` | The server's address, for `deploy.sh` and `manage.sh` |
| `POSTGRES_PASSWORD` | Must be URL-safe, because it goes into the database URL. Use `openssl rand -hex 32`. |
| `CLOUDFLARE_TUNNEL_TOKEN` | From the tunnel's page in Cloudflare Zero Trust |
| `MINERVA_SECRET_KEY`, `MINERVA_ENCRYPTION_KEYS` | Run `cd backend && uv run python manage.py generate_secrets`. Use new values for the demo, not your local ones. |
| `MINERVA_MODEL_*` | The model provider (see AGENTS.md) |
| `MINERVA_EMAIL_BACKEND`, `MINERVA_EMAIL_OPTIONS`, `MINERVA_EMAIL_FROM` | Without them, verification codes only appear in the `web` logs. Many VPS hosts block outgoing ports 25, 465 and 587 on new servers; if sign-in codes fail with an SMTP timeout, use the provider's alternative port (often 2525, with `"use_tls": true`). |
| Connector clients | Optional. Their redirect URLs use `https://demo.minervacomputing.com/api/oauth/<provider>/callback`. |
| `MINERVA_TURNSTILE_SITE_KEY`, `MINERVA_TURNSTILE_SECRET_KEY` | The Turnstile widget for `demo.minervacomputing.com`. Without them the demo refuses every sign-in. |
| `MINERVA_GOOGLE_LOGIN_CLIENT_ID`, `MINERVA_GOOGLE_LOGIN_CLIENT_SECRET` | Optional: "Continue with Google". A separate OAuth client from the Google connector's. Redirect URI `https://demo.minervacomputing.com/api/accounts/google/login/callback/` |
| `MINERVA_APPLE_CLIENT_ID`, `MINERVA_APPLE_TEAM_ID`, `MINERVA_APPLE_KEY_ID`, `MINERVA_APPLE_PRIVATE_KEY_FILE` | Optional: "Continue with Apple". The client ID is the Services ID. Put the `.p8` key in `.env.demo.d/apple.p8` and set the file to `/run/secrets/minerva/apple.p8`. Return URL `https://demo.minervacomputing.com/api/accounts/apple/login/callback/` |
| `MINERVA_BUTTONDOWN_API_KEY` | Optional: adds visitors who left the newsletter box ticked to the Buttondown newsletter every 15 minutes, marked with the metadata `demo: true`, and unsubscribes those who untick it at a later sign-in. They are added without a confirmation email, because signing in verified their address. Keep double opt-in on in Buttondown anyway: the landing page's waitlist relies on it. Addresses Buttondown already has are left as they are. |
| `MINERVA_BENTO_SITE_UUID`, `MINERVA_BENTO_PUBLISHABLE_KEY`, `MINERVA_BENTO_SECRET_KEY` | Optional: the same with a Bento list instead, used only while `MINERVA_BUTTONDOWN_API_KEY` is unset. Switching provider moves every opted-in visitor to the new one, unsubscribing them from the old list first. Import the old list's unsubscribes into the new provider before you switch, keep the old provider's keys set until every visitor has moved, then delete the old list. |
| `MINERVA_DEMO_TURNS_PER_DAY`, `MINERVA_DEMO_TURNS_GLOBAL_PER_DAY`, `MINERVA_DEMO_CHAT_RETENTION_HOURS` | Optional limits; defaults 20, 2000 and 24 |

`compose.yaml` sets the host names, URLs, sandbox settings, database URL, demo mode and run limits itself. Those values override the env file. `deploy.sh` appends `DOCKER_GID`, the group of the Docker socket, on the server.

Files in `.env.demo.d/` (gitignored) are installed as `/opt/minerva/secrets`, readable by the backend user only, and mounted read-only at `/run/secrets/minerva` in the backend containers.

In Cloudflare Zero Trust, give the tunnel one public hostname: `demo.minervacomputing.com` → `http://proxy:80`. Set SSL/TLS to Full, and turn off Rocket Loader and any caching rule for `/api/*`.

## First setup

Put an SSH key on the server first (`ssh-copy-id root@$DEMO_HOST`): `bootstrap.sh` turns off password logins and stops if `/root/.ssh/authorized_keys` is empty.

```sh
scp deploy/demo/bootstrap.sh root@$DEMO_HOST:
ssh root@$DEMO_HOST bash bootstrap.sh
deploy/demo/deploy.sh
```

`bootstrap.sh` can be run again safely. It registers gVisor twice: `runsc`, and `runsc-minerva`, which workers use and which adds `--host-uds=open` so that they can connect to the gateway socket. It checks the latter by running `hello-world` under it.

Then create the demo workspace and its owner, sign in as the owner at `/demo` with an email code, connect the apps, set what the agent may do under Connections, and publish that to visitors:

```sh
deploy/demo/manage.sh demo_setup --owner you@example.com
deploy/demo/manage.sh demo_sync      # again after every change to the owner's connections or access
```

## Deploy

```sh
deploy/demo/deploy.sh
```

The demo runs from the `demo` branch, which takes bug fixes and small changes only; `main` is the product (see the Git section of [AGENTS.md](../../AGENTS.md)). `deploy.sh` deploys the current commit, and refuses to run on any other branch or while there are uncommitted or untracked changes. The deployed commit is written to `/opt/minerva/REVISION` (`ssh root@$DEMO_HOST cat /opt/minerva/REVISION`). It then rebuilds the worker image (`minerva-worker:demo`) and runs `docker compose up -d --build`. The one-shot `migrate` service runs before web, gateway, supervisor and cleanup start.

## On the server

```sh
alias dc='docker compose -f /opt/minerva/src/deploy/demo/compose.yaml --env-file /opt/minerva/.env'
dc ps
dc logs -f web gateway supervisor
dc logs --since 1h cleanup
dc restart web
docker ps --filter label=minerva.run        # running workers
```

## Management commands

```sh
deploy/demo/manage.sh demo_sync
deploy/demo/manage.sh createsuperuser
MANAGE_SERVICE=supervisor deploy/demo/manage.sh sandbox_check   # needs the Docker socket
```

The Django admin is not reachable from outside, because Caddy proxies only `/api`.

## Backups

```sh
ssh root@$DEMO_HOST 'cd /opt/minerva && docker compose -f src/deploy/demo/compose.yaml --env-file .env \
  exec -T postgres pg_dump -U minerva -Fc minerva > backups/minerva-$(date +%F).dump'
scp root@$DEMO_HOST:/opt/minerva/backups/minerva-YYYY-MM-DD.dump .
```

To restore, stop the app services first (`dc stop web gateway supervisor cleanup`), then run:

```sh
dc exec -T postgres pg_restore -U minerva -d minerva --clean --if-exists < backups/minerva-YYYY-MM-DD.dump
```

Connection credentials in a dump are encrypted with `MINERVA_ENCRYPTION_KEYS`, so keep the env file together with the dump.

## Wiping

To reset the demo data, delete the database volume. Migrations recreate the schema on the next start.

```sh
dc down -v
deploy/demo/deploy.sh          # or, on the server: dc up -d
```

To remove everything, also delete the images and files:

```sh
dc down -v --rmi all
docker rm -f $(docker ps -aq --filter label=minerva.run) 2>/dev/null
docker image rm minerva-worker:demo
rm -rf /opt/minerva
```
