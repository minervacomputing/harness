# Agent notes

Operational notes for coding agents working in this repository. For background, read [README.md](README.md), [CURRENT_STATE.md](CURRENT_STATE.md), and [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md).

## Environment

Configuration is read from the process environment and `.env` at the repository root (see `backend/minerva/config.py`). Process environment variables override `.env`, so you can change a value for one run without editing the file.

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

**Optional for local development:**

| Variable | Default | Notes |
|---|---|---|
| `MINERVA_DEBUG` | `false` | Set `true` locally. Required by `make seed`. |
| `MINERVA_DATABASE_URL` | `postgres://minerva:minerva@localhost:5432/minerva` | Matches `compose.yaml` |
| `MINERVA_TODOIST_CLIENT_ID`, `MINERVA_TODOIST_CLIENT_SECRET` | empty | Empty means Minerva registers its own OAuth client |
| `MINERVA_SANDBOX_PROVIDER` | `container` | `local-process` has no isolation; avoid it |
| `MINERVA_SANDBOX_IMAGE` | `minerva-worker:dev` | Built by `make worker-image` |
| `MINERVA_GATEWAY_BIND` | `127.0.0.1` | Linux only: set to `172.17.0.1` |

## Starting the app

Prerequisites: Docker running, `uv`, Node 24, and pnpm.

```sh
make setup   # first time only: services, dependencies, migrations, seed accounts, worker image
make dev     # web :8000, gateway :8001, supervisor, frontend :5173
```

Open <http://localhost:5173>. The processes are defined in `Procfile`. `make dev` needs the Compose services (Postgres and the gateway relay); start them with `make services` if they are not running.

**Without a model key**, run the fake model and point the app at it for this run only:

```sh
make fake-model   # separate process, serves 127.0.0.1:9900
MINERVA_MODEL_BASE_URL=http://127.0.0.1:9900/v1 MINERVA_MODEL_API_KEY=fake make dev
```

**Sign in** with a seed account: `ada@example.com` or `grace@example.com`, password `password`. Run `make seed` to create them or reset them (password, verified email, two-factor removed). Resetting signs out existing sessions. Seeding refuses to run unless `MINERVA_DEBUG=true`.

Emails (verification and sign-in codes) are printed in the `web` process output.

**Port in use:** if `web` exits with `Address already in use`, another copy of `make dev` is running. Stop it rather than starting a second one.

## Checks

```sh
make test            # backend pytest (needs Postgres), worker and frontend typechecks
make lint            # ruff check and format check
make sandbox-check   # sandbox isolation probe; needs make dev running
make api-types       # after any backend API schema change
```
