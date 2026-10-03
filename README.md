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

## Outlook Calendar

Outlook Calendar uses the Entra app from [Outlook](#outlook). Add a second **Web** redirect URI, `{site_url}/api/oauth/outlook_calendar/callback`, and the delegated permissions `Calendars.Read` and `Calendars.ReadWrite`.

Click **Connections → Connect Outlook Calendar**, then choose per calendar (or for all calendars) whether agents may read events and create them. Calendars others shared with the account are listed too. Minerva asks Microsoft only for `Calendars.Read` at first, and for `Calendars.ReadWrite` once the user allows creating events.

## OneDrive and SharePoint

OneDrive and SharePoint use the Entra app from [Outlook](#outlook). Add another **Web** redirect URI, `{site_url}/api/oauth/onedrive/callback`, and the delegated permissions `Files.Read.All`, `Sites.Read.All` and `Files.ReadWrite.All`.

Click **Connections → Connect OneDrive and SharePoint**, then choose per library, folder or file (or for everything) whether agents may read files and create them. The choices offered are the account's own OneDrive and the document libraries of the SharePoint sites it follows; searching finds folders and files anywhere the account can open, shared ones included. Access to a folder or library covers everything inside it. Minerva asks Microsoft for read access at first (`Sites.Read.All` lists followed sites), and for `Files.ReadWrite.All` once the user allows creating files.

## Microsoft Teams

Microsoft Teams uses the Entra app from [Outlook](#outlook). Add another **Web** redirect URI, `{site_url}/api/oauth/teams/callback`, and the delegated permissions `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` and `ChannelMessage.Send`. `ChannelMessage.Read.All` needs a tenant administrator's consent (**Grant admin consent** on the app's **API permissions** page, in each organization whose users connect); without it, users can list teams and channels and post, but agents cannot read messages. Only work and school accounts can connect.

Click **Connections → Connect Microsoft Teams**, then choose per team or channel (or for everything) whether agents may read messages, reply in threads, and start threads. Access to a team covers all its channels, including private channels the account is in and channels added later. Agents post as the signed-in user. Minerva asks Microsoft for the permissions to list teams and channels at first, and for `ChannelMessage.Read.All` and `ChannelMessage.Send` once the user allows reading and writing.

## Stripe

Stripe connects with a restricted key, which each user creates; no operator setup is needed. In the Stripe Dashboard, open **Developers → API keys → Create restricted key** and give it only these permissions: **Customers: Write** (read customers and add balance credits), **Charges: Read**, **Refunds: Write**, **Invoices: Read** and **Subscriptions: Read**. Minerva also reads the account (`GET /v1/account`) to name the connection; if Stripe refuses that, also allow reading the account's details. Secret keys (`sk_`) are refused, since they can do anything in the account. A test key and a live key of one account are two connections.

Click **Connections → Stripe**, paste the key (it is checked with Stripe, stored encrypted and never shown again), then choose per customer (or for every customer) what agents may do: read, refund payments, and credit balances. Each refund or credit also needs its amount allowed: "Up to" a limit in a currency, or the whole currency. A workspace ceiling can deny "More than" a limit. **Replace key** swaps in a new key for the same account.

## HubSpot

Create a public app on HubSpot's developer platform: with the HubSpot CLI, run `hs project create` (an app with OAuth authentication and marketplace distribution), then in `app-hsmeta.json` set `auth.redirectUrls` to `{site_url}/api/oauth/hubspot/callback` (for example `http://localhost:5173/api/oauth/hubspot/callback`) and `auth.requiredScopes` to `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.deals.read` and `crm.objects.deals.write`, with no optional scopes. Run `hs project upload`, and set `MINERVA_HUBSPOT_CLIENT_ID` and `MINERVA_HUBSPOT_CLIENT_SECRET` from the app's **Auth** page. The app does not need to be listed in HubSpot's marketplace. Without the client, HubSpot is not offered.

Click **Connections → Connect HubSpot**; only a Super Admin of the HubSpot account (or a user with Marketplace Access) can install the app. Then choose what agents may do with all contacts, all companies, all deals, or the deals of one pipeline: read, create contacts and deals, edit them, and log notes. Companies are never created or edited, but notes can be logged on them. HubSpot gives the app the same access whoever installed it, so Minerva's grants are the only limit within those scopes.

## Jira

Create an **OAuth 2.0 integration** in the Atlassian developer console (<https://developer.atlassian.com/console/myapps/>). Under **Permissions**, add the **User identity API** with `read:me`, and the **Jira API** with the classic scopes `read:jira-work` and `write:jira-work`. Under **Authorization**, set the callback URL to `{site_url}/api/oauth/jira/callback` (for example `http://localhost:5173/api/oauth/jira/callback`). Atlassian allows one callback URL per app, so Jira needs an app of its own. Set `MINERVA_JIRA_CLIENT_ID` and `MINERVA_JIRA_CLIENT_SECRET` from **Settings**. The app works for its developer at once; to let others connect, open **Distribution** and share it. Without the client, Jira is not offered.

Click **Connections → Connect Jira** and pick the sites to allow on Atlassian's consent screen. Then choose per site or per project what agents may do: read issues, comment, create issues and change their status. Agents act as you: watchers are notified, and a project's automation rules may act on what they change.

## Confluence

Create another **OAuth 2.0 integration** in the Atlassian developer console (<https://developer.atlassian.com/console/myapps/>); Atlassian allows one callback URL per app, so Confluence cannot share Jira's. Under **Permissions**, add the **User identity API** with `read:me`, and the **Confluence API** with the granular scopes `read:space:confluence`, `read:page:confluence`, `read:comment:confluence`, `read:content-details:confluence`, `write:comment:confluence` and `write:page:confluence`. Under **Authorization**, set the callback URL to `{site_url}/api/oauth/confluence/callback`. Set `MINERVA_CONFLUENCE_CLIENT_ID` and `MINERVA_CONFLUENCE_CLIENT_SECRET` from **Settings**, and open **Distribution** to let others connect. Without the client, Confluence is not offered.

Click **Connections → Connect Confluence** and pick the sites to allow on Atlassian's consent screen. Then choose per site or per space what agents may do: read pages, comment on them and create them. Agents act as you: watchers are notified, and a space's automation rules may act on what they change.

## Intercom

Create an app in Intercom's Developer Hub (<https://app.intercom.com/a/apps/_/developer-hub>). Under **Authentication**, turn on **Use OAuth**, add the redirect URL `{site_url}/api/oauth/intercom/callback`, and give the permissions **Read admins**, **Read conversations** and **Write conversations**. Set `MINERVA_INTERCOM_CLIENT_ID` and `MINERVA_INTERCOM_CLIENT_SECRET` from **Basic information**. The app works in its own workspace at once; other workspaces can install it only once Intercom has reviewed it. Without the client, Intercom is not offered. Intercom accepts only HTTPS redirect URLs, so locally Minerva needs an HTTPS tunnel, set up as for [Slack](#slack).

Click **Connections → Connect Intercom** and authorize the app for your workspace. Then choose per team inbox, or for conversations no team is assigned to, what agents may do: read conversations, add internal notes and reply to customers. Agents act as you; replies reach the customer by email or the Messenger. Conversations move between inboxes when they are reassigned, so one reassigned at the moment an agent writes can receive the write. To revoke access, remove the app from the workspace in Intercom's app settings.

## Xero

Create an app at <https://developer.xero.com/app/manage> as a **Web app** (authorization code flow), with the redirect URI `{site_url}/api/oauth/xero/callback`. Xero takes HTTPS redirect URIs, and `http://localhost` ones for testing. Set `MINERVA_XERO_CLIENT_ID` and `MINERVA_XERO_CLIENT_SECRET` from the app's **Configuration** page. Minerva asks for Xero's granular scopes: `accounting.invoices.read`, `accounting.contacts.read` and `accounting.settings.read` to read, and `accounting.invoices` once you allow drafting. Without the client, Xero is not offered.

Click **Connections → Connect Xero**, sign in and pick the organisations Minerva may reach. Then choose per organisation (or for all of them, including ones added later) what agents may do: read invoices, bills and contacts, create draft sales invoices, and create draft bills. Drafts are never sent, approved or paid: a person approves them in Xero. To add an organisation, connect again and pick it; to remove one, disconnect it in Xero under **Settings → Connected apps**. Your role in each organisation still applies.

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
