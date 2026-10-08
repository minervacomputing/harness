# Deployment

The product (`main`) runs on one server per environment. Only staging exists so far: <https://staging.minervacomputing.com>, behind Cloudflare Access. Every push to `main` is tested and built into images, and the newest commit of `main` is deployed there without anyone running a script. The public demo is separate: it runs from the `demo` branch with [deploy/demo/](demo/README.md).

```text
push to main ─ GitHub Actions: test ─ images (GHCR, tagged with the commit) ─ deploy-staging
deploy-staging ─ ssh (forced command) ─ minerva-deploy <commit> ─ release.sh: pull, up, check

Cloudflare Access ─ tunnel ─ cloudflared ─ proxy (Caddy: SPA, /api → web:8000)
                                           web, gateway, supervisor ─ postgres
supervisor ─ /var/run/docker.sock ─ worker containers (gVisor, no network)
worker ─ gateway.sock (read-only volume) ─ gateway-socket ─ gateway:8001
```

| File | Purpose |
|---|---|
| `compose.yaml` | The stack (project `minerva`). Images by commit, no builds on the server. |
| `Dockerfile.backend` | One image for web, gateway, supervisor and migrate (`minerva-backend`) |
| `Dockerfile.frontend`, `Caddyfile` | The Vite build served by Caddy, which also proxies `/api` (`minerva-proxy`) |
| `../worker/Dockerfile` | The agent's sandbox (`minerva-worker`) |
| `bootstrap.sh` | One-time server setup: Docker, gVisor, firewall, SSH by key only, swap, the deploy commands |
| `server/minerva-deploy` | The deploy entry point on the server, and the CI key's forced command |
| `server/minerva-compose` | `docker compose` with the server's env files, for `ps`, `logs` and `exec` |
| `release.sh` | One release on the server: pull, start, check, record |
| `ops.sh` | Everything you run from your checkout: `deploy/ops.sh <env> <command>` |
| `../.github/workflows/main.yml` | `test` → `images` → `deploy-staging` on every push to `main` |

`<env>` selects `.env.<env>` at the repository root (gitignored), which says where the server is and holds its configuration.

## How a deploy works

1. **CI** runs `make lint` and `make test`, then builds the three images and pushes them to `ghcr.io/minervacomputing/minerva-{backend,proxy,worker}:<commit>`. The packages are public, like the repository, so servers pull without credentials. Nothing secret is in an image: the `.dockerignore` files keep `.env*` out, and the frontend build has no environment-specific values, so one image serves every environment.
2. **The deploy job** (GitHub environment `staging`, which admits only `main`) connects as root with a key that can run nothing but `minerva-deploy` (`restrict,command=…` in `authorized_keys`) and passes the commit id. GitHub runs one deploy at a time, never cancels one halfway, and keeps only the newest waiting, so when pushes come faster than deploys, the commits in between are skipped.
3. **`minerva-deploy`** accepts only a 40-character commit id, refuses while another release runs, and runs the release as a transient systemd unit, so that a dropped connection does not stop it halfway. The SSH session follows its log and returns its result. The unit takes the deploy lock, fetches `main` from the public repository into `/opt/minerva/src` (a sparse checkout of `deploy/`), refuses a commit that is not on `main`, checks it out, and runs that commit's `deploy/release.sh`. The check matters: GitHub serves the commits of every pull request by id, forks' included. CI only moves forward: builds can finish out of order, so a CI deploy of a commit older than the running release is skipped. Rollbacks are done by hand. If the release fails before starting anything, the checkout goes back to the running release.
4. **`release.sh`** pulls the three images (the supervisor creates workers through the Docker API, which does not pull), writes the commit to `/opt/minerva/release.env`, and runs `docker compose up --wait`. The one-shot `migrate` runs first, on every release, and nothing else starts if it fails. Then it checks `/api/health` through Caddy and runs `sandbox_check` in the supervisor, which starts workers under gVisor and checks that they reach the gateway and nothing else. It appends the result and the image digests to `/opt/minerva/releases`, and deletes the images of all but the last five successful releases.

A failed step fails the deploy job, and GitHub shows it on the commit. A failed release leaves running whatever had started by then; deploy the last good commit from `releases` to go back.

`deploy/ops.sh staging env` restarts the backend when a secret file changed. Services restart during a deploy, and runs in progress are interrupted. That is acceptable on staging; production will need draining first.

### Why this design

- **Docker Compose on one VPS**, as the demo. The stack needs things Compose expresses directly and app-deploy tools work around: a supervisor that holds the Docker socket through its group, workers started outside the tool's knowledge under the `runsc-minerva` runtime from an image already on the host, a socket relay in a volume with a fixed name, and Caddy streaming server-sent events.
- **Not Kamal:** it is built around one web role behind kamal-proxy. The worker image, the socket volume and the relay would live in hooks and accessories, and its gains (zero-downtime switching, Let's Encrypt) are not needed behind Cloudflare on staging.
- **Not Coolify, Dokploy and the like:** a web panel with Docker socket access on the server, for a product whose point is isolation.
- **Not Kubernetes with Argo CD or Flux:** a cluster for one machine. Kubernetes may return as a sandbox provider, not as the deploy tool.
- **Images built once, by CI.** Servers never build, so what staging ran is exactly what production will run, and any earlier commit can be redeployed in a minute.
- **Configuration outside CI.** `.env.<env>` stays on the operator's machine and the server. CI holds only a key that can deploy a commit of `main`; changing a secret does not need a deploy, and deploys do not touch the configuration.

**Trust model.** The deployed code is root on the server in any case, because the supervisor holds the Docker socket. So whoever can push to `main` is root on staging, and the forced command does not change that. What it limits is a leaked CI key: its holder can redeploy an older commit of `main`, and nothing else. `minerva-deploy` itself is installed by `bootstrap.sh` and never taken from the commit being deployed.

## Configuration: `.env.staging`

Keep `.env.staging` at the repository root. It is gitignored. `deploy/ops.sh staging env` installs it on the server as `/opt/minerva/.env` (mode 600) and restarts what changed.

| Variable | Notes |
|---|---|
| `DEPLOY_HOST` | The server's address, for `ops.sh` |
| `PUBLIC_HOST` | `staging.minervacomputing.com`. `compose.yaml` derives the allowed hosts, site URL and CSRF origins from it. |
| `CLOUDFLARE_TUNNEL_TOKEN` | From the tunnel's page in Cloudflare Zero Trust |
| `POSTGRES_PASSWORD` | `openssl rand -hex 32`: it goes into the database URL, so it must be URL-safe. Postgres takes it only when it creates the database; changing it later needs `ALTER USER` as well. |
| `MINERVA_SECRET_KEY`, `MINERVA_ENCRYPTION_KEYS` | `cd backend && uv run python manage.py generate_secrets`. New values for each environment. |
| `MINERVA_MODEL_*` | The model provider (see [AGENTS.md](../AGENTS.md)) |
| `MINERVA_SIGNUP_OPEN` | `false`. Create accounts with `deploy/ops.sh staging manage createsuperuser`; each gets its personal workspace. |
| `MINERVA_MAX_CONCURRENT_RUNS` | `2`: each worker may use 1 GiB, and the server has 4 |
| `MINERVA_EMAIL_BACKEND`, `MINERVA_EMAIL_OPTIONS`, `MINERVA_EMAIL_FROM` | Optional. Without them, sign-in codes appear in the `web` logs (`deploy/ops.sh staging compose logs web`). |
| Connector clients | Optional, names in `.env.example`. Staging's own OAuth clients and test accounts at the providers, never production's: redirect URLs `https://staging.minervacomputing.com/api/oauth/<provider>/callback`. |
| `MINERVA_GOOGLE_LOGIN_*`, `MINERVA_APPLE_*` | Optional sign-in providers, as in [the demo](demo/README.md#configuration-envdemo) with the staging host |

`compose.yaml` sets the database URL, host names, sandbox and files settings itself; those win over the env file. Files in `.env.staging.d/` (gitignored), such as an Apple `.p8` key, are installed as `/opt/minerva/secrets`, readable by the backend user only, and mounted read-only at `/run/secrets/minerva`.

## Cloudflare

In Cloudflare Zero Trust:

1. **Tunnel** `minerva-staging` (Networks > Tunnels, type Cloudflared): one public hostname, `staging.minervacomputing.com` → `http://proxy:80`. Its token goes into `CLOUDFLARE_TUNNEL_TOKEN`.
2. **Access application** (Access > Applications, self-hosted) for `staging.minervacomputing.com`, with an Allow policy for your email.
3. For agents and scripts: a **service token** (Access > Service credentials), and a second policy on the application with the action Service Auth that includes it. Requests then pass the Access check with two headers:

   ```sh
   curl -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET" \
     https://staging.minervacomputing.com/api/health
   ```

   Keep the token in your password manager, not in `.env.staging`, which goes to the server.

In the zone's settings: SSL/TLS Full, Rocket Loader off, and no caching rule for `/api/*`.

OAuth callbacks are top-level navigations, so the Access cookie comes with them. Sign in with Apple posts its callback from Apple's site, and the cookie may not: if it fails on staging, set the application's cookie to `SameSite=None`, or add a Bypass policy for `/api/accounts/apple/login/callback/` alone.

## First setup

1. Put your SSH key on the server (`ssh-copy-id root@<host>`): `bootstrap.sh` turns off password logins and stops if `/root/.ssh/authorized_keys` is empty.
2. Write `.env.staging` (above), then:

   ```sh
   deploy/ops.sh staging bootstrap   # again after any change to bootstrap.sh or server/minerva-deploy
   deploy/ops.sh staging env
   ```

3. Push to `main`. The first build creates the three packages at `github.com/orgs/minervacomputing/packages`; make each one public (Package settings > Change visibility). The deploy job skips until step 4.
4. Give CI its key. This needs the GitHub CLI signed in with admin rights on the repository. It authorizes a new key on the server for `minerva-deploy` only, creates the `staging` environment restricted to `main`, and stores the key, the host and its host key there. Run it again to replace the key.

   ```sh
   deploy/ops.sh staging ci-key
   ```

5. Deploy once by hand, and check the sandbox:

   ```sh
   deploy/ops.sh staging deploy
   MANAGE_SERVICE=supervisor deploy/ops.sh staging manage sandbox_check
   ```

## Deploy and roll back

Pushes to `main` deploy themselves. By hand, any commit of `main` whose images CI has built, also an older one (one release at a time: a deploy is refused while another runs):

```sh
deploy/ops.sh staging deploy             # origin/main
deploy/ops.sh staging deploy 1a2b3c4     # an earlier commit: a rollback
deploy/ops.sh staging releases           # time, commit, result and image digests of the last deploys
```

A rollback does not reverse migrations. It is safe when the newer migrations are backward compatible: add first, remove in a later release, which is the rule for anything that reaches production. Otherwise reverse the migration while the newer code is still deployed (`deploy/ops.sh staging manage migrate <app> <migration>`), or restore a backup.

## Operating

```sh
deploy/ops.sh staging compose ps
deploy/ops.sh staging compose logs -f web gateway supervisor
deploy/ops.sh staging manage createsuperuser
MANAGE_SERVICE=supervisor deploy/ops.sh staging manage sandbox_check   # needs the Docker socket
deploy/ops.sh staging ssh
```

On the server:

```sh
minerva-compose ps                                     # docker compose with the deployed release
docker ps --filter label=minerva.run                   # running workers
journalctl -u 'minerva-release-*' --since today        # release logs
cat /opt/minerva/releases
```

The Django admin is not reachable from outside, because Caddy proxies only `/api`.

## Backups

Not automated yet. By hand:

```sh
deploy/ops.sh staging ssh
minerva-compose exec -T postgres pg_dump -U minerva -Fc minerva > /opt/minerva/backups/minerva-$(date +%F).dump
```

Restore with the app services stopped (`minerva-compose stop web gateway supervisor`), then `minerva-compose exec -T postgres pg_restore -U minerva -d minerva --clean --if-exists < <dump>`. Connection credentials in a dump are encrypted with `MINERVA_ENCRYPTION_KEYS`, so keep the env file with the dump. Agent files are in the `minerva_files` volume.

## Later

- Production: a second env file and server, and a `deploy-production` job started by hand with a commit staging has run, from a GitHub environment with a required reviewer. It promotes the digests staging recorded, never a fresh build.
- Nightly backups of the database and the files volume, copied off the server, with a tested restore.
- A health check that touches the database, an external uptime check, and disk and memory alerts.
- A retention policy for old images in GHCR that keeps every image an environment has run.
