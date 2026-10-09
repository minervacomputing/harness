# Agent notes

Operational notes for coding agents working in this repository. For background, read [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md). Work in progress is planned in [docs/plans/](docs/plans/).

## Environment

Configuration is read from the process environment and `.env` at the repository root (see `backend/minerva/config.py`). Process environment variables override `.env`, except under `make dev`: honcho loads `.env` into every process and its values replace the shell's. To override a value for one run, start honcho without `.env` (see [Starting the app](#starting-the-app)).

`.env` holds secrets. Never print, commit, or copy its values. To check a value, report only whether it is set.

**Required** (no default; the backend does not start without them):

| Variable | How to get it |
|---|---|
| `MINERVA_SECRET_KEY` | `cd backend && uv run python manage.py generate_secrets` |
| `MINERVA_ENCRYPTION_KEYS` | Same command. Format: `v1:<fernet key>`, comma separated; the first encrypts. |

**Needed for chat** (defaults exist, but chat turns fail without a working model):

| Variable | Default | Notes |
|---|---|---|
| `MINERVA_MODEL_BASE_URL` | `https://api.openai.com/v1` | Any OpenAI-compatible endpoint |
| `MINERVA_MODEL_API_KEY` | empty | Use `fake` with the fake model |
| `MINERVA_MODEL_NAME` | `gpt-5-mini` | |
| `MINERVA_MODEL_API` | `responses` | `chat` for servers without the Responses API |
| `MINERVA_MODEL_REASONING_EFFORT` | `medium` | Responses API only; empty for models that do not reason |
| `MINERVA_MODEL_REASONING_SUMMARY` | `auto` | Responses API only: the reasoning shown in the chat (`auto`, `concise`, `detailed`); empty for none |

**Optional for local development:**

| Variable | Default | Notes |
|---|---|---|
| `MINERVA_DEBUG` | `false` | Set `true` locally. Required by `make seed`. |
| `MINERVA_DATABASE_URL` | `postgres://minerva:minerva@localhost:5432/minerva` | Matches `compose.yaml` |
| Connector clients and keys (`MINERVA_<APP>_CLIENT_ID`, …) | empty | Unset hides that connector (Todoist registers its own client). Each is listed in `.env.example`; setup is in [docs/connectors.md](docs/connectors.md). |
| `MINERVA_SANDBOX_PROVIDER` | `container` | `local-process` has no isolation; avoid it |
| `MINERVA_SANDBOX_IMAGE` | `minerva-worker:dev` | Built by `make worker-image` |
| `MINERVA_SANDBOX_GATEWAY_VOLUME` | `minerva-gateway-socket` | Holds the workers' socket to the gateway; created by `make services` |
| `MINERVA_SANDBOX_RUNTIME` | empty | gVisor needs a runtime registered with `--host-uds=open`, such as `runsc-minerva` |
| `MINERVA_GATEWAY_BIND` | `127.0.0.1` | Linux only: set to `172.17.0.1` |

## Starting the app

Prerequisites: Docker running, `uv`, Node 24, and pnpm.

```sh
make setup   # first time only: services, dependencies, migrations, seed accounts, worker image
make dev     # web :8000, gateway :8001, supervisor, frontend :5173
```

Open <http://localhost:5173>. The processes are defined in `Procfile`. `make dev` needs the Compose services (Postgres and the gateway socket relay); start them with `make services` if they are not running.

**Overriding a value for one run:** `VAR=x make dev` has no effect on a variable that `.env` sets. Run honcho with an empty env file instead. The backend still reads `.env` itself, so only the variables you pass change. `.env` no longer feeds the Procfile, so pass `MINERVA_GATEWAY_BIND` too if you rely on it (Linux).

```sh
MINERVA_MODEL_NAME=gpt-5-mini uv run --project backend honcho -e /dev/null -f Procfile start
```

**Without a model key**, run the fake model and point the app at it for this run only:

```sh
make fake-model   # separate process, serves 127.0.0.1:9900
MINERVA_MODEL_BASE_URL=http://127.0.0.1:9900/v1 MINERVA_MODEL_API_KEY=fake uv run --project backend honcho -e /dev/null -f Procfile start
```

**Sign in** with a seed account: `ada@example.com` or `grace@example.com`, password `password`. Run `make seed` to create them or reset them (password, verified email, two-factor removed). Resetting signs out existing sessions. Seeding refuses to run unless `MINERVA_DEBUG=true`.

Emails (verification and sign-in codes) are printed in the `web` process output.

**Demo data:** `make seed-demo` (re)creates `demo@example.com` (password `password`) with ten connections, grants, three agents and sample conversations. The connections hold placeholder credentials, so they list in the app but cannot reach a provider, and the conversations were never run. Like `make seed`, it needs `MINERVA_DEBUG=true`.

**README screenshots:** `make screenshots` runs `make seed-demo`, then `docs/screenshots/capture.mjs`, which signs in as the demo account and writes `docs/images/chat.png`, `injection.png` and `connections.png`. It needs `make dev` running, Google Chrome and ImageMagick (`magick`). After a UI change that shows in these pages, run it and check the images before committing them. To change what they show, edit the data in `backend/accounts/management/commands/seed_demo.py`.

**Port in use:** if `web` exits with `Address already in use`, another copy of `make dev` is running. Stop it rather than starting a second one.

## Git

This project does not use pull requests. Commit directly to `main` (or merge a short-lived branch into it) and push `main`.

`main` is the product. Every push to `main` is tested and built into images by GitHub Actions, which deploy the newest commit to staging; see [deploy/README.md](deploy/README.md). When the `main` workflow fails, read which job failed: tests, image builds or the deploy. The public demo runs from the `demo` branch, which takes bug fixes and small changes only, never new features:

- A fix that both need is committed on `main` first, then copied onto `demo` with `git cherry-pick -x`.
- A change only the demo needs (demo settings, `backend/demo/`, `deploy/demo/`) is committed on `demo` only.
- `main` is never merged into `demo`. Deploy the demo only from `demo`.

**This repository is public** (`github.com/minervacomputing/harness`). Everything you commit is published, history included. Never commit:

- secrets (they belong in `.env`, `.env.demo`, `.env.staging`, `.env.staging.access` or a `.env.<env>.d/` directory, all gitignored);
- personal data: real people's email addresses, phone numbers, or names other than the author credit in the README;
- server details: IP addresses, provider hostnames, SSH users;
- account identifiers: cloud project IDs, OAuth client IDs, Stripe account IDs, Apple team and key IDs, Cloudflare account, zone and tunnel IDs.

Use reserved `.example` domains and placeholders in docs, tests and seed data. Notes for the operator that need real identifiers, such as prompts for browser agents, go in `deploy/demo/private/`, which is gitignored. Check the staged diff for these before every commit.

## Cloudflare

Staging sits behind a Cloudflare Tunnel and Cloudflare Access (see [deploy/README.md](deploy/README.md)), the demo behind a tunnel only. Use Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/) (npm package `cf`), not Wrangler. Find commands with `cf cli search "<task>"` and preview API changes with `--dry-run`. A destructive command without `--force` in a non-interactive shell prints `Aborted.` and still exits 0, so read the output or check the resource. Changes to the tunnel, Access policies or DNS affect the running deployments: ask before making them.

## Staging

<https://staging.minervacomputing.com> runs the newest commit of `main` (see [deploy/README.md](deploy/README.md)). Its configuration is `.env.staging` at the repository root; never print its values.

- **Reaching it:** Cloudflare Access sends requests without a session to a sign-in page. Pass the service token in `.env.staging.access` as headers, read from a file descriptor so the secret stays out of the process list (and never with `set -x`):

  ```sh
  set -a; . ./.env.staging.access; set +a
  curl -H @<(printf 'CF-Access-Client-Id: %s\nCF-Access-Client-Secret: %s\n' "$CF_ACCESS_CLIENT_ID" "$CF_ACCESS_CLIENT_SECRET") \
    https://staging.minervacomputing.com/api/health
  ```

  In the in-app browser, use the app only after the user has signed in there; never type their password.
- **Operating it** with `deploy/ops.sh staging <command>`: `releases` (what is deployed), `compose ps`, `compose logs --tail 100 web` (sign-in codes appear there: do not quote them), `manage <command>`, `deploy [<ref>]` (a commit of `main`, also to roll back). `env` installs a changed `.env.staging` and restarts what it affects.
- **Ask first** before `env`, a deploy or rollback by hand, `ci-key`, `bootstrap`, stopping or restarting services, or anything that changes data on the server.

## Second opinions with opencode

Use opencode as a read-only subagent for code review, adversarial review, or critiques of plans. Always use the `plan` agent (it does not edit files) with `--auto` (no permission prompts):

```sh
git diff | opencode run --agent plan --auto "Adversarially review this diff for bugs and security issues."
opencode run --agent plan --auto -f plan.md "Critique this plan: what is wrong, risky, or missing?"
```

- Input can be piped on stdin or attached with `-f`.
- Add `-c` to ask a follow-up in the same session.
- Its output is advice. Verify each finding before acting on it.
- Run `git status` afterwards. The `plan` agent should not change anything, but `--auto` approves any shell command that is not explicitly denied.

## Checks

```sh
make test            # backend pytest (needs Postgres), worker and frontend typechecks
make lint            # ruff check and format check
make sandbox-check   # sandbox isolation probe; needs make dev running
make api-types       # after any backend API schema change
```
