<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/minerva-logo-dark.svg">
    <img src="docs/images/minerva-logo.svg" alt="Minerva" width="300">
  </picture>
</p>

<p align="center">
  <strong>AI agents for sensitive data and business-critical apps.</strong><br>
  The agent never holds a key, and never decides its own permissions.
</p>

<p align="center">
  <a href="https://minervacomputing.com">Website</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="LICENSE">MIT license</a>
</p>

![A support agent refunds a duplicate charge in Stripe and replies in Gmail. Its post to #general in Slack is refused, so it posts in #support instead.](docs/images/chat.png)

## Why Minerva

Most agents are given the keys and asked to behave. They hold Gmail, Slack and Stripe tokens with broad access, and a prompt asks them to stay within bounds. One persuasive email or web page is enough to change their mind.

Minerva turns this around:

- **Keys stay in a gateway.** The agent runs in a sealed container that holds only a temporary pass. Credentials are encrypted at rest and never reach the container or the browser.
- **Every call is checked.** Each action goes through the gateway, which checks it against the permissions you set before it reaches the app.
- **Access is set per resource.** You allow or deny per folder, label, channel, project, customer or amount, in each app's own structure. Not per app.

## How it works

You chat with an agent. Each agent has its own instructions and its own connections. Every tool call it makes is shown in the chat, with what it asked for and whether it was allowed.

| The agent tries to | Permissions | Result |
|---|---|---|
| Read the Receipts label in Gmail | Receipts: read | Done |
| Post in #general in Slack | #support only | Not allowed |
| Refund 120 EUR in Stripe | Refunds up to 50 EUR | Not allowed |
| Cc an unlisted address in Gmail | Send to `*@acme.com` | Not allowed |

What an agent may do is the intersection of what your account, the connection and the agent allow.

![The Connections page: ten connected apps, each with the resources agents may reach.](docs/images/connections.png)

### The sealed container

Each answer runs in a fresh container, which is removed when the answer is finished. It has:

- no internet access: it reaches only the gateway;
- no access to the host or the database;
- write access only to its scratch folder;
- no admin rights, and no secrets in its environment.

If the container dies mid-answer, for example by running out of memory, a new one picks the answer up from its last saved step (up to twice per answer). The agent's progress is saved behind the gateway, not in the container. A read that was cut off runs again. A write that was cut off does not: the agent is told, and asking for the same write again gets the first one's outcome rather than sending it twice.

### When an agent is tricked

Prompt injection is not prevented, but it is contained. An email that asks the agent to send your invoices to a stranger fails at the gateway, since the address is not on the recipient list. A web page that asks it to upload its keys finds no keys, and no internet to upload them to.

![An email in the Invoices label hides an instruction to send all invoices to files@outside.io. The agent tries, Minerva refuses, and the agent warns the user.](docs/images/injection.png)

## Connectors

20 apps, each with resource-level permissions:

| | |
|---|---|
| **Mail and calendars** | Gmail, Outlook, Google Calendar, Outlook Calendar |
| **Files and docs** | Google Drive, OneDrive and SharePoint, Notion, Confluence |
| **Messaging and support** | Slack, Microsoft Teams, Intercom |
| **Engineering** | GitHub, Linear, Jira, Sentry, Todoist |
| **Finance and sales** | Stripe, Xero, HubSpot |
| **Web** | Reading sites you allow, and Brave search |

Setting up each one is described in [docs/connectors.md](docs/connectors.md).

## Models and hosting

Minerva works with any OpenAI-compatible provider, or with models on your own servers through vLLM or Ollama. It runs on Docker or Podman.

## Quick start

You need Docker with Compose v2, Python 3.14 with [uv](https://docs.astral.sh/uv/), and Node 24 with pnpm 10.

```sh
git clone https://github.com/minervacomputing/harness.git minerva
cd minerva
cp .env.example .env && chmod 600 .env
cd backend && uv run python manage.py generate_secrets   # paste the output into .env
cd .. && make setup
make dev
```

Open <http://localhost:5173> and sign in as `ada@example.com` with the password `password`.

`make setup` starts Postgres and the gateway socket relay (`compose.yaml`), installs dependencies, runs migrations, seeds two accounts (`ada@` and `grace@example.com`; this needs `MINERVA_DEBUG=true`, and `make seed` resets them) and builds the worker image `minerva-worker:dev`.

`make dev` starts four processes:

| Process | Address | Role |
|---|---|---|
| `web` | 127.0.0.1:8000 | API, login, live updates |
| `gateway` | 127.0.0.1:8001 | The only API that workers can reach |
| `supervisor` | – | Starts and stops sandboxes |
| `frontend` | localhost:5173 | React app; proxies `/api` to `web` |

Emails (verification codes, sign-in codes, password resets) are printed in the `web` output. No mail server is needed locally.

### Models

Set an OpenAI-compatible endpoint in `.env`:

```sh
MINERVA_MODEL_BASE_URL=https://api.openai.com/v1
MINERVA_MODEL_API_KEY=sk-...
MINERVA_MODEL_NAME=gpt-5-mini
```

Minerva uses the Responses API. For a server that offers only Chat Completions, set `MINERVA_MODEL_API=chat`. `MINERVA_MODEL_REASONING_EFFORT` (default `medium`) sets the reasoning effort; leave it empty for a model that does not reason. The chat shows the model's reasoning summary, which `MINERVA_MODEL_REASONING_SUMMARY` asks for (`auto`, `concise` or `detailed`; empty for none). OpenAI may refuse summaries for an organization it has not verified; Minerva then retries without one and logs a warning. The setting only controls what Minerva asks for: reasoning that a server streams anyway, such as `reasoning_content` over Chat Completions, is shown too.

To try the app without a key, run the scripted fake model:

```sh
make fake-model                      # serves on 127.0.0.1:9900
# in .env:
MINERVA_MODEL_BASE_URL=http://127.0.0.1:9900/v1
MINERVA_MODEL_API_KEY=fake
```

The fake model calls a list-projects tool when tools are offered, then answers with text.

### Sandbox

Every agent turn runs in a hardened container with no network. Its only way out is a Unix socket, mounted read-only, that the `gateway-socket` container forwards to the gateway. To check isolation while `make dev` is running:

```sh
make sandbox-check
```

It starts the worker image with a probe and verifies 15 properties, including a non-root user, no secrets in the environment, a read-only filesystem, only a loopback interface, blocked internet, DNS, cloud metadata, host, database and other-worker access, and a process limit that refuses further forks.

- **Linux:** the relay reaches the host through the Docker bridge, so set `MINERVA_GATEWAY_BIND=172.17.0.1`.
- **gVisor:** register a runtime that lets workers connect to the socket, `sudo runsc install --runtime=runsc-minerva -- --host-uds=open`, restart Docker, and set `MINERVA_SANDBOX_RUNTIME=runsc-minerva`.

### Development

| Command | What it does |
|---|---|
| `make test` | Backend tests, then worker and frontend typechecks |
| `make lint` | Ruff lint and format check |
| `make api-types` | Regenerates the frontend API client from the backend's OpenAPI schema; run it after changing a backend API schema |

```text
backend/     Django project (web, gateway and supervisor roles) and the connectors
worker/      TypeScript worker image around pi-durable
frontend/    React app (Vite, TanStack, assistant-ui)
docs/        Connector setup and images
compose.yaml Postgres and the gateway socket relay for development
```

## Status

Minerva is early. The permissions, the sandbox and the connectors work against live accounts. [ARCHITECTURE.md](ARCHITECTURE.md) describes how it is built and why, what works today, and what is next.

**Available now:** agents with their own instructions and connections, chat that shows every tool call, 20 connectors with resource-level permissions, a sealed container per answer, two-factor sign-in, and self-hosting.

**Next:** schedules and triggers, agents you can reach from Slack and Teams, team workspaces with admin limits, asking you to allow a single action, an audit log, and a hosted beta.

**Later:** SSO and directory sync, a second person for high-risk actions, and single-tenant deployments.

## About

Minerva is built by [Szymon Nastaly](https://szymonnastaly.com). For news on agents, subscribe to the newsletter [This Week in Agents](https://buttondown.com/twia).

Released under the [MIT license](LICENSE).
