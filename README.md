# Minerva

Governed AI agents: the agent never holds credentials and never decides its own permissions.

- **What exists today:** [CURRENT_STATE.md](CURRENT_STATE.md)
- **Why it is built this way:** [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md)

## Requirements

| Tool | Version |
|---|---|
| Docker (Docker Desktop or Engine) | recent, with Compose v2 |
| Python and [uv](https://docs.astral.sh/uv/) | Python 3.14 |
| Node.js and pnpm | Node 24, pnpm 10 |

## First-time setup

```sh
cp .env.example .env && chmod 600 .env
cd backend && uv run python manage.py generate_secrets   # paste the output into .env
cd .. && make setup
```

`make setup` does four things:

1. Starts Postgres and the gateway relay (`compose.yaml`).
2. Installs the backend, worker, and frontend dependencies.
3. Runs the database migrations.
4. Builds the worker image `minerva-worker:dev`.

## Run it

```sh
make dev
```

Then open <http://localhost:5173>.

| Process | Address | Role |
|---|---|---|
| `web` | 127.0.0.1:8000 | API, login, live updates |
| `gateway` | 127.0.0.1:8001 | The only API that workers can reach |
| `supervisor` | – | Starts and stops sandboxes |
| `frontend` | localhost:5173 | React app; proxies `/api` to `web` |

**Emails** (verification codes, sign-in codes, password resets) are printed in the `web` output. No mail server is needed locally.

## Models

Set any OpenAI-compatible endpoint in `.env`:

```sh
MINERVA_MODEL_BASE_URL=https://api.openai.com/v1
MINERVA_MODEL_API_KEY=sk-...
MINERVA_MODEL_NAME=gpt-5-mini
```

To try the app without a key, use the scripted fake model:

```sh
make fake-model                      # serves on 127.0.0.1:9900
# in .env:
MINERVA_MODEL_BASE_URL=http://127.0.0.1:9900/v1
MINERVA_MODEL_API_KEY=fake
```

The fake model calls a list-projects tool when tools are offered, then answers with text.

## Todoist

Click **Connections → Connect Todoist**.

- **Default:** Minerva registers its own OAuth client with Todoist on first use. There is nothing to configure.
- **Your own app:** set `MINERVA_TODOIST_CLIENT_ID` and `MINERVA_TODOIST_CLIENT_SECRET`. The redirect URL is `http://localhost:5173/api/oauth/todoist/callback`.

After connecting, choose per project what agents may do, then add the connection to an agent under **Agents**.

## Sandbox

Every agent turn runs in a fresh, hardened container on the internal `minerva-sandbox` network. It can reach only the gateway, through the `gateway-relay` container.

To check isolation, run this while `make dev` is up:

```sh
make sandbox-check
```

The check starts the worker image with a probe and verifies 11 properties, including a non-root user, no secrets in the environment, a read-only filesystem, and blocked internet, DNS, cloud metadata, host, and database access.

**Linux:** the relay reaches the host through the Docker bridge, so bind the gateway to the bridge address:

```sh
MINERVA_GATEWAY_BIND=172.17.0.1 make dev
```

**gVisor:** set `MINERVA_SANDBOX_RUNTIME=runsc`.

## Development

| Command | What it does |
|---|---|
| `make test` | Backend tests, then worker and frontend typechecks |
| `make lint` | Ruff lint and format check |
| `make api-types` | Regenerates the frontend API client from the backend's OpenAPI schema |

Run `make api-types` after changing any backend API schema.

## Repository layout

```text
backend/     Django project (web, gateway, and supervisor roles)
worker/      TypeScript worker image around DeepSeek Harness
frontend/    React app (Vite, TanStack, assistant-ui)
compose.yaml Postgres and the sandbox network for development
```

`deepseek-harness/` is an upstream reference checkout. It is not part of this repository and not needed to build.
