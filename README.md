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
  <a href="ARCHITECTURE.md">Architecture</a> ·
  <a href="#development">Development</a> ·
  <a href="LICENSE">MIT license</a>
</p>

This repository is **Minerva's open harness**: the engine that runs each agent turn, with its sandbox, its permission checks and its connectors, on Cloudflare. It holds the engine alone. Minerva itself is a hosted product, and the product's side (accounts, organizations, connections and the app people use) is a private Laravel application that starts each turn here. **Self-hosting is not supported.**

![A support agent refunds a duplicate charge in Stripe and replies in Gmail. Its post to #general in Slack is refused, so it posts in #support instead.](docs/images/chat.png)

## Why Minerva

Most agents are given the keys and asked to behave. They hold Gmail, Slack and Stripe tokens with broad access, and a prompt asks them to stay within bounds. One persuasive email or web page is enough to change their mind.

Minerva turns this around:

- **Keys stay out of the agent's reach.** The agent's commands run in a sealed microVM that holds no key and has no network. Credentials are encrypted at rest and never reach the sandbox, the model or the browser.
- **Every call is checked.** Each action goes through Minerva's permission check, against the permissions you set, before it reaches the app.
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

Each conversation also has a folder. Attach files to a message, and the agent reads and writes them with ordinary file tools and shell commands, with Python and libraries for PDFs, Word documents, spreadsheets and charts. The chat shows each command and what it printed, and every file it leaves in the folder can be downloaded.

![The Connections page: ten connected apps, each with the resources agents may reach.](docs/images/connections.png)

### The sealed sandbox

Each answer runs its commands in a fresh microVM (Cloudflare Containers), which is destroyed when the answer is finished. It has:

- no network at all: no internet, no DNS, no other containers;
- no credential and no token of any kind;
- write access only to the conversation's folder and a temporary folder;
- no admin rights once it is hardened, which is checked before any command runs.

Scripts the agent writes to call its tools run in isolates with no network either. If an answer is interrupted mid-way, for example by running out of memory, it is picked up from its last saved step (up to twice per answer). The agent's progress and its files are saved outside the sandbox. A read that was cut off runs again. A write to a connected app that was cut off does not: the agent is told, and asking for the same write again gets the first one's outcome rather than sending it twice. The folder goes back to its last saved state, so file changes and commands since then may be lost.

### When an agent is tricked

Prompt injection is not prevented, but it is contained. An email that asks the agent to send your invoices to a stranger fails at the permission check, since the address is not on the recipient list. A web page that asks it to upload its keys finds no keys, and no network to upload them to.

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

What each one lets agents do, and what it hides from them, is in [docs/connectors.md](docs/connectors.md).

## How it is built

The engine is TypeScript on Cloudflare: a Worker, three Durable Objects per conversation (the conversation, its sandbox and its scripts), D1, R2, Containers for the sandbox and Dynamic Workers for scripts. The agent loop is pi's durable harness (pi-durable); models run on Workers AI, or on OpenAI and Anthropic through an AI Gateway with prompt logging off. [ARCHITECTURE.md](ARCHITECTURE.md) describes the design, the trust model and the protocols that keep writes from being sent twice and revoked permissions from being used.

Minerva is two systems ([the plan](docs/plans/product-and-engine.md)): the private Laravel application holds users, organizations, connections and their credentials, grants, agents and the transcript, and decides what may happen; this engine runs the turns Laravel starts through an internal API, borrows each credential for one call, and reports what it did back as facts.

## Development

You need Node 24 and pnpm 10. Docker is optional (it runs the sandbox locally). No Cloudflare account is needed:

```sh
git clone https://github.com/minervacomputing/harness.git minerva
cd minerva && pnpm install
pnpm --dir cloudflare dev:offline     # the engine on http://127.0.0.1:8787, with a scripted fake model
```

| Command | What it does |
|---|---|
| `pnpm typecheck` in `cloudflare/` | The engine's types |
| `pnpm test:unit` in `cloudflare/` | The engine's unit tests, in Node |
| `pnpm test:platform` in `cloudflare/` | The Worker in local workerd, with the internal API and the protocols' fault tests |
| `pnpm typecheck` and `pnpm openapi:check` in `contract/` | The contract's types, and its OpenAPI documents up to date |

Deploying and the tests that run on Cloudflare are in [cloudflare/README.md](cloudflare/README.md).

```text
cloudflare/  the engine: Worker, Durable Objects, sandbox image, connectors, deploy scripts
contract/    the internal API's contract between Laravel and the engine, with its OpenAPI documents
docs/        connectors, images and plans
```

## Status

Minerva is early. The permissions, the sandbox and the connectors work against live accounts, and the engine runs on Cloudflare with fault tests for its protocols. [ARCHITECTURE.md](ARCHITECTURE.md) says what is built and what is open.

**Available now:** agents with their own instructions and connections, chat that shows every tool call, 20 connectors with resource-level permissions, a sealed sandbox per answer, files the agent works on with commands, and two-factor sign-in.

**Next:** budgets per run and an emergency stop, deletion and retention, billing, then schedules and triggers, agents you can reach from Slack and Teams, asking you to allow a single action, and an audit log.

**Later:** SSO and directory sync, a second person for high-risk actions, and dedicated deployments.

## About

Minerva is built by [Szymon Nastaly](https://szymonnastaly.com). For news on agents, subscribe to the newsletter [This Week in Agents](https://buttondown.com/twia).

Released under the [MIT license](LICENSE).
