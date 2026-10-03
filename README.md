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
4. Seeds development accounts (`make seed`).
5. Builds the worker image `minerva-worker:dev`.

Sign in as `ada@example.com` or `grace@example.com` with the password `password`. The seed only runs with `MINERVA_DEBUG=true`; run `make seed` again to reset them.

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

Minerva talks to the model over the Responses API. For a server that only offers Chat Completions, set `MINERVA_MODEL_API=chat`. `MINERVA_MODEL_REASONING_EFFORT` (default `medium`) sets the reasoning effort; leave it empty for a model that does not reason.

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

## Google Calendar, Drive and Gmail

Create an OAuth client of type **Web application** in the Google Cloud console, enable the Google Calendar API, the Google Drive API and the Gmail API, and set `MINERVA_GOOGLE_CLIENT_ID` and `MINERVA_GOOGLE_CLIENT_SECRET`. Add the redirect URIs `http://localhost:5173/api/oauth/google_calendar/callback`, `http://localhost:5173/api/oauth/google_drive/callback` and `http://localhost:5173/api/oauth/gmail/callback`. Without the client, none of them is offered.

Click **Connections → Connect Google Calendar** (or Drive, or Gmail), then choose per calendar, per file or folder, or per label what agents may do. Minerva asks Google only for read access at first, and for write scopes once the user allows creating.

Gmail's scopes are restricted: until the app is verified by Google, only test users listed on the OAuth consent screen can connect, and their tokens expire after seven days. Gmail asks for `gmail.readonly` at first, `gmail.send` once the user allows sending, and `gmail.compose` once they allow drafts.

## GitHub

Create a GitHub App at <https://github.com/settings/apps> and set `MINERVA_GITHUB_CLIENT_ID`, `MINERVA_GITHUB_CLIENT_SECRET` and `MINERVA_GITHUB_APP_SLUG` (the App's URL name, `github.com/apps/<slug>`). The callback URL is `http://localhost:5173/api/oauth/github/callback`; keep user authorization tokens expiring. Give it the repository permissions Metadata (read), Contents (read), Issues (read and write) and Pull requests (read and write). Without the client, GitHub is not offered.

Click **Connections → Connect GitHub**, install the App on the repositories Minerva may see (the connection card links there), then choose per repository what agents may do.

## Notion

Create a public integration at <https://www.notion.so/profile/integrations> and set `MINERVA_NOTION_CLIENT_ID` and `MINERVA_NOTION_CLIENT_SECRET`. The redirect URL is `http://localhost:5173/api/oauth/notion/callback`. Give it the capabilities Read content, Update content, Insert content, Read comments and Insert comments, and no user information. Without the client, Notion is not offered.

Click **Connections → Connect Notion** and choose in Notion which pages Minerva may reach. Then choose per page or database what agents may do: read, comment, create pages inside it, and edit it. Each covers the pages inside.

## Linear

Create an OAuth application at <https://linear.app/settings/api/applications> and set `MINERVA_LINEAR_CLIENT_ID` and `MINERVA_LINEAR_CLIENT_SECRET`. The callback URL is `http://localhost:5173/api/oauth/linear/callback`. Leave webhooks off. Without the client, Linear is not offered.

Click **Connections → Connect Linear**, then choose per team what agents may do: read issues, comment, create issues, and edit issues. Each covers the team's sub-teams. Minerva asks Linear only for read access at first, and for the write scopes an action needs once the user allows it.

## Slack

Create an app at <https://api.slack.com/apps> (**From scratch**) in your own workspace and set `MINERVA_SLACK_CLIENT_ID` and `MINERVA_SLACK_CLIENT_SECRET` from **Basic Information**. Under **OAuth & Permissions**, add the redirect URL `{site_url}/api/oauth/slack/callback` and the bot token scopes `channels:read`, `groups:read`, `channels:history`, `groups:history`, `users:read` and `chat:write`. Leave PKCE off (Slack treats an app that uses it as a public client). Token rotation is optional. Without the client, Slack is not offered.

Slack accepts only HTTPS redirect URLs, so locally the dev server needs an HTTPS tunnel (for example `cloudflared tunnel --url http://localhost:5173`). Set `MINERVA_SITE_URL` and `MINERVA_CSRF_TRUSTED_ORIGINS` to the tunnel's address, add its host to `MINERVA_ALLOWED_HOSTS`, start Vite with `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<host>`, and open Minerva through the tunnel. Keep the app unlisted and installed only in your own workspace: Slack rate limits apps distributed outside its Marketplace much more strictly.

Click **Connections → Connect Slack**, then choose per channel what agents may do: read messages, reply in threads, and post to the channel. In Slack, add the app to each channel it should reach (`/invite @<app name>`); Minerva sees no other channels. Minerva asks Slack for `chat:write` only once the user allows replying or posting.

## Outlook

Register an app in the Microsoft Entra admin center (<https://entra.microsoft.com>, **App registrations → New registration**) and set `MINERVA_MICROSOFT_CLIENT_ID` (the Application (client) ID) and `MINERVA_MICROSOFT_CLIENT_SECRET` (a secret's value from **Certificates & secrets**). Choose **Accounts in any organizational directory and personal Microsoft accounts**, and add a **Web** redirect URI `{site_url}/api/oauth/outlook/callback` (for example `http://localhost:5173/api/oauth/outlook/callback`). Under **API permissions**, add the Microsoft Graph delegated permissions `offline_access`, `User.Read`, `Mail.Read` and `Mail.Send`. Some organizations let only an administrator consent to mail permissions; there, an admin must grant consent for the tenant. Without the client, Outlook is not offered.

Click **Connections → Connect Outlook**, then choose per folder what agents may read, and which addresses or domains they may send mail to. Access to a folder covers its subfolders. Minerva asks Microsoft only for read access at first, and for `Mail.Send` once the user allows sending.

## Stripe

Stripe connects with a restricted key, which each user creates; no operator setup is needed. In the Stripe Dashboard, open **Developers → API keys → Create restricted key** and give it only these permissions: **Customers: Write** (read customers and add balance credits), **Charges: Read**, **Refunds: Write**, **Invoices: Read** and **Subscriptions: Read**. Minerva also reads the account (`GET /v1/account`) to name the connection; if Stripe refuses that, also allow reading the account's details. Secret keys (`sk_`) are refused, since they can do anything in the account. A test key and a live key of one account are two connections.

Click **Connections → Stripe**, paste the key (it is checked with Stripe, stored encrypted and never shown again), then choose per customer (or for every customer) what agents may do: read, refund payments, and credit balances. Each refund or credit also needs its amount allowed: "Up to" a limit in a currency, or the whole currency. A workspace ceiling can deny "More than" a limit. **Replace key** swaps in a new key for the same account.

## The Web

Click **Connections → Add Web**, then choose which sites agents may read and whether they may search. A site is an exact host (`docs.python.org`) or a domain with its subdomains (`*.python.org`).

Searching uses Brave Search. Set `MINERVA_BRAVE_SEARCH_API_KEY` to a key from <https://brave.com/search/api/>. Without it, agents can only read pages.

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
