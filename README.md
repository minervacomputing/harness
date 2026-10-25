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

You chat with an agent that has its own instructions and connections. The chat shows every tool call it makes, with its arguments and whether it was allowed.

| The agent tries to | Permissions | Result |
|---|---|---|
| Read the Receipts label in Gmail | Receipts: read | Done |
| Post in #general in Slack | #support only | Not allowed |
| Refund 120 EUR in Stripe | Refunds up to 50 EUR | Not allowed |
| Cc an unlisted address in Gmail | Send to `*@acme.example` | Not allowed |

An agent may do only what the app's account, your organization, you and the agent all allow, and a deny anywhere wins.

Each conversation has a folder. Attach files, and the agent works on them with shell commands and Python in the conversation's own microVM (Cloudflare Containers). You can download every file it leaves.

![The Connections page: ten connected apps, each with its account, six of them shared with the organization.](docs/images/connections.png)

### When an agent is tricked

Prompt injection is contained, not prevented. An email that asks the agent to send your invoices to a stranger fails the permission check, and a page that asks for its keys finds neither keys nor a network.

![An email in the Invoices label hides an instruction to send all invoices to files@outside.example. The agent tries, Minerva refuses, and the agent warns the user.](docs/images/injection.png)

## Connectors

20 connectors, each with resource-level permissions:

| | |
|---|---|
| **Mail and calendars** | Gmail, Outlook, Google Calendar, Outlook Calendar |
| **Files and docs** | Google Drive, OneDrive and SharePoint, Notion, Confluence |
| **Messaging and support** | Slack, Microsoft Teams, Intercom |
| **Engineering** | GitHub, Linear, Jira, Sentry, Todoist |
| **Finance and sales** | Stripe, Xero, HubSpot |
| **Web** | Reading the sites you allow |

What each one lets agents do, and what it hides from them, is in [docs/connectors.md](docs/connectors.md).

## How it is built

The engine is TypeScript on Cloudflare (Workers, Durable Objects, Containers and Dynamic Workers) around pi's durable agent loop. [ARCHITECTURE.md](ARCHITECTURE.md) describes its design and trust model, [product-and-engine.md](docs/plans/product-and-engine.md) its split from Laravel, and `contract/` the internal API between them.

## Development

You need Node 24 and pnpm 10. No Cloudflare account is needed:

```sh
git clone https://github.com/minervacomputing/harness.git minerva
cd minerva && pnpm install
pnpm --dir cloudflare dev:offline     # the engine on http://127.0.0.1:8787, with a scripted fake model
```

Checks, tests and deploys are in [cloudflare/README.md](cloudflare/README.md).

## Status

Minerva is early, and accounts come only by invitation. Memory across conversations is next. Schedules, triggers and agents you can reach from Slack and Teams come after it, and asking you before a write runs is designed.

## About

Minerva is built by [Szymon Nastaly](https://szymonnastaly.com). For news on agents, subscribe to the newsletter [This Week in Agents](https://buttondown.com/twia).

Released under the [MIT license](LICENSE).
