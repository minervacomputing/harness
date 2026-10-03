# Minerva — current state

Updated 2026-10-01. This describes the code in this repository. For the reasons behind it, see [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md). For setup, see [README.md](README.md).

## 1. Summary

Minerva runs AI agents that **never hold credentials and never decide their own permissions**. Each agent turn runs in a locked-down container. The container can only call a trusted gateway, which holds the keys and checks every action against permissions the user chose.

This is the first real implementation. It is not a prototype and is built to be extended. It runs locally today and is structured for a cloud alpha.

**What works:**

- Sign up with email verification, sign in with a password or an emailed code, reset a password, and use two-factor authentication with an app and recovery codes.
- A personal workspace for every user, with a default agent.
- Connecting Todoist through OAuth, then choosing per project what agents may do: read tasks and/or create tasks.
- Connecting Google Calendar, then choosing per calendar (or for all calendars) what agents may do: read events and/or create events. Agents can list calendars, list and read events, and create events without guests. Minerva asks Google only for read access at first, and for write access once the user allows creating events (see [section 4](#4-permissions)).
- Connecting Google Drive, then choosing per folder or file (or for all of Drive) what agents may do: read files and/or create files. Access to a folder covers everything inside it, and a block on a folder wins over access to a folder around it. Agents can list folders, search, read file details, read Google Docs, Sheets, Slides and text files as text, and create text files or Google Docs in a folder. Minerva asks Google for read-only access at first, and for full Drive access once the user allows creating files, because Google's narrower scope cannot add files to folders Minerva did not create.
- Connecting GitHub through a GitHub App, then choosing per repository (or for all repositories) what agents may do: read code, issues and pull requests, and/or open issues and comment. Agents can list repositories, read a repository's details, list and read issues and pull requests (with comments and diffs, truncated), read text files and list directories, open issues with a title and text only, and comment on issues and pull requests. Minerva sees only the repositories the user installs the App on; the connection card links to GitHub to choose them.
- Connecting Notion, then choosing per page or database (or for everything Notion shares with Minerva) what agents may do: read, comment, create pages, and edit. Access to a page covers the pages inside it, and a block wins over access to a page around it. Agents can search, read page details and page text, read and query databases, list and add comments, create pages and database rows, set a page's plain properties, replace text on a page and append to it. Hidden from agents: titles of pages they cannot read that appear as links or mentions, synced content from other pages, and rollup, formula and file properties. Written text may not create child pages, embed content from other sites, or mention people. Notion automations that react to an agent's change are outside Minerva's control.
- Connecting Linear, then choosing per team (or for every team) what agents may do: read issues, comment, create issues, and edit issues. Access to a team covers its sub-teams, and a block on a sub-team wins over access to the team around it. Agents can list teams, read a team's statuses, labels and members, list a team's issues and search their titles, read an issue with its sub-issues and comments, create issues, comment (and reply), and change an issue's title, description, status, priority, labels, assignee and due date. Hidden from agents: titles of other issues, projects and documents in links, and anything but the existence of a parent or sub-issue in another team. Written text may link to Linear only with addresses of issues in the same team, since Linear turns links into mentions shown on the linked issue. A status change is refused when Linear could then close or reopen issues in other teams on its own. Linear's other automations (triage rules, integrations) are outside Minerva's control.
- Connecting Slack as the operator's own Slack app, then choosing per channel (or for every channel) what agents may do: read messages, reply in threads, and post to the channel. The app reaches only channels it has been added to in Slack, so a channel needs both. Agents can list the channels they may read, read a channel's messages (newest first, between two times) and a thread, reply in a thread, and post. Hidden from agents: names of channels in links and in topics, attachments (link previews and messages shared from other channels), and file contents. Written text is shown literally, so it cannot mention people or notify a channel (`@channel`, `@here`), and it may not link to Slack, since Slack would show the linked message. Posting to channels shared with other organizations is refused. Direct messages are out of reach.
- Connecting Outlook (work, school or personal Microsoft accounts), then choosing per mail folder (or for all folders) what agents may read, and per address or domain (or for everyone) whom they may send mail to. Access to a folder covers its subfolders, and a block on a subfolder wins. Agents can list folders, list a folder's messages (filtered by unread and received time, or searched), read a message as plain text with the names of its attachments, send plain-text mail, and reply to a message they may read. Every address a message goes to, Cc and Bcc included, needs permission; a reply goes only to the addresses the original asks replies to go to, or else its sender, and needs permission for each of them. Search folders, hidden folders and Exchange's system folders are out of reach, and replies to drafts and to the account's own mail are refused. Not supported: drafts, attachments (reading or sending), forwarding, reply-all, moving, deleting or flagging mail, and shared mailboxes.
- Connecting Gmail, then choosing per label (or for all mail) what agents may read, per address or domain (or for everyone) whom they may send mail to, and whether they may save drafts. Access to a label covers the labels nested under it (`Work/Projects` under `Work`). A message with several labels can be read if one of them is allowed and is hidden if one of them is blocked; archived mail without labels is covered only by allowing every label. Agents can list labels, list and search messages, read a message or a conversation as plain text with the names of attachments, send plain-text mail, reply to a message they may read, and save drafts and reply drafts. Every address a message goes to, Cc and Bcc included, needs permission; a reply goes only to the original's Reply-To addresses, or else its sender, and needs permission for each. Drafts need no recipient permission, since the user sends them. Chats are out of reach, and replies to drafts and to the account's own mail are refused. Not supported: attachments (reading or sending), forwarding, reply-all, labelling, archiving, deleting, and sending drafts.
- Connecting Stripe with a restricted key, then choosing per customer (or for every customer) what agents may do: read, refund payments, and credit balances, and separately up to what amount, per currency, each refund or credit may be. Access to a customer covers their payments, invoices and subscriptions; payments without a customer are covered only by allowing every customer. Agents can list and read customers, list payments (with what is left to refund), invoices and subscriptions, refund part or all of a payment, and add credit to a customer's balance. A refund is checked against the payment just before it is sent: the currency must match, the payment must have succeeded and not be disputed, and the amount must not exceed what is left. Secret keys are refused, and a test key and a live key are separate connections. Not supported: creating charges, invoices or subscriptions, cancelling subscriptions, disputes, payouts, and Stripe Connect accounts.
- Connecting HubSpot through the operator's public app, then choosing for all contacts, all companies, all deals, or the deals of one pipeline what agents may do: read, create contacts and deals, edit them, and log notes. Agents can search contacts, companies and deals (by words, exact email address or domain, pipeline and stage, or the records they are associated with), read one, list deal pipelines with their stages, create and edit contacts, create deals (associated with contacts and companies they may read), change a deal's name, stage, amount and close date within its pipeline, and log plain-text notes on a contact, company or deal. Searching by association needs Read on both sides, searching deals by anything but their pipeline needs Read on all deals, and a deal that moved to another pipeline since it was checked is refused. Not supported: tickets, tasks, emails, calls, meetings, owners, custom objects, reading notes, writing companies, deleting, merging, moving deals between pipelines, and grants on single contacts or companies.
- Adding the Web, then choosing which sites agents may read (an exact host such as `docs.python.org`, a domain with its subdomains such as `*.python.org`, or every site) and, separately, whether they may search. Agents can search the web through Brave Search (titles, addresses and snippets only) and read pages as text. Minerva fetches pages itself and never opens private networks (see [section 4](#4-permissions)).
- Creating agents with their own instructions and connections.
- Chatting with an agent. The answer streams in live, tool calls appear as cards (done, not allowed, failed), and a run can be stopped.
- Every turn runs in a fresh hardened container, which is removed afterwards.

**Not built yet:** team workspaces, Google or GitHub login, passkeys in the UI, report files and other artifacts, audit records, bring-your-own model key, and cloud deployment files. See [section 8](#8-gaps-and-next-steps).

## 2. Architecture

```text
 Browser (React app)
    │  JSON API + server-sent events, session cookie
    ▼
┌─────────────────── Trusted backend (Django, one codebase) ────────────────────┐
│ web         accounts, workspaces, connections, agents, chat, live updates    │
│ gateway     the only API workers can reach: run spec, MCP tools, model relay │
│ supervisor  claims queued runs, starts/stops sandboxes, deadlines, cleanup   │
└───────┬───────────────────────────────┬───────────────────────────────┬───────┘
        ▼                               ▼                               ▼
   PostgreSQL                 Sandbox container (per turn)      Todoist API, model API
                              worker: DeepSeek Harness          (keys live only here)
                                 │ outbound HTTP only, per-run token
                                 └──────────────► gateway
```

| Zone | Trusted? | Holds |
|---|---|---|
| Browser | The signed-in user | Session cookie only |
| Backend | Yes | Provider and model keys, permissions, all state |
| Worker | **No**, treated as hostile | Its run token, nothing else |

## 3. One chat turn, step by step

1. **Browser → web:** the message is stored, and a run is created with status `queued`. The run stores a snapshot of the effective permissions and the tool list. A database constraint allows one active run per conversation.
2. **Supervisor:** claims the run (`SKIP LOCKED`, at most 4 at once) and issues a run token. It then starts a container whose only environment variables are `GATEWAY_URL`, `RUN_TOKEN`, and `RUN_ID`.
3. **Worker → gateway:** it fetches the run spec with `GET /run` and configures DeepSeek Harness. The agent's model points at the gateway relay and its tools at the gateway's MCP endpoint. Shell, terminal, and subprocess plugins are disabled.
4. **Gateway:**
   - Model calls go to the configured upstream. The relay parses the stream and publishes text deltas as run events every 0.25 s.
   - Tool calls go through the permission executor ([section 4](#4-permissions)).
5. **Worker → gateway:** it posts only `phase`, `completed` (with the final answer), and `failed` events.
6. **End of the run:** the token is revoked when the run reaches any final state, and the supervisor removes the container.
7. **Browser:** follows run events through server-sent events, woken by Postgres `NOTIFY`, and resumes after a reconnect from the last sequence number. Agent text is rendered as Markdown, but images in it are shown as text and never loaded, and a Content Security Policy also blocks remote images. Otherwise, prompt-injected content could send data out through the browser.

Run states: `queued → provisioning → running → completed | failed | cancelled | timed_out`.

Stopping a run revokes its token, so every later call from the worker is rejected. A Todoist write that is already in flight may still complete.

## 4. Permissions

**A grant is: connection + resource kind + resource + actions.** A resource may be `*`, meaning every resource of that kind, including new ones. Every action besides Read also requires Read on the same resource, except Outlook's and Gmail's Send, Gmail's Draft and the Web's Search, which apply to their own kinds, and Stripe's Refund and Credit, which also apply to amounts (a refund or credit also needs Read on the customer).

| Connector | Kind (resource id) | Actions | Notes |
|---|---|---|---|
| Todoist | Project | Read, Create | |
| Google Calendar | Calendar | Read events, Create events | |
| Google Drive | File; folders are files | Read files, Create files | A folder grant covers everything inside it. |
| GitHub | Repository (numeric id) | Read (code, issues, pull requests), Create (open issues, comment) | The id follows a repository through renames and transfers. |
| Notion | Page or database | Read, Comment, Create (pages inside), Edit | A grant covers the pages inside; a page whose place Notion does not show is blocked by any block on that action. |
| Linear | Team (team id) | Read, Comment, Create, Edit | A grant covers sub-teams; tools name teams by key and issues by identifier. |
| Slack | Channel (channel id) | Read, Reply (in threads), Post | Tools take a channel's name or id. |
| Outlook | Folder (immutable Graph id); Recipient | Folder: Read. Recipient: Send | Microsoft's read permission covers the whole mailbox, so folder limits are Minerva's; a folder grant covers subfolders. A recipient is an address or `*@domain` (that domain only, never a public suffix). |
| Gmail | Label (label id); Recipient; the connection itself | Label: Read. Recipient: Send. Connection: Draft | Google's read scope covers the whole mailbox, so label limits are Minerva's; a label grant covers nested labels, and a message is inside every label it carries. Recipients work as for Outlook. |
| Stripe | Customer (customer id); Amount | Customer: Read, Refund, Credit. Amount: Refund, Credit | A customer grant covers what is billed to them. An amount is chosen as a tier per currency (`usd<=50`, "Up to 50.00 USD"; `usd>500`, "More than 500.00 USD"; `usd`, any amount); caps apply to each call on its own. |
| HubSpot | CRM record: `contacts`, `companies`, `deals` and `pipeline:<id>` | Read, Create (contacts and deals), Edit (contacts and deals), Note | Grants are on collections and pipelines only: a merged record answers under another id, but stays in its collection. Deals sit inside their pipeline, inside `deals`. |
| Web | Site; the connection itself | Site: Read. Connection: Search | Searching sends the query to Brave Search, so it is its own permission. |

Connector declarations are described in [ARCHITECTURE_DECISIONS.md, D8](ARCHITECTURE_DECISIONS.md#d8-connectors-and-the-permission-executor).

Layers can only narrow, and deny wins:

```text
effective = provider account ∩ workspace ceiling ∩ user layer ∩ agent layer
```

In a personal workspace the ceiling is unrestricted and hidden. The UI edits the user layer under **Connections → Choose access**, and each agent can use only the connections selected for it.

**Provider consent:** each tool also needs the provider scopes behind it. A tool whose scopes the connection lacks is not offered. When the user allows an action whose scopes Google has not granted (for example Create events on a connection made with read-only access), the connection card says so and offers **Allow in Google Calendar**. That flow is tied to the connection: it asks Google for the scopes behind every action the user allows (on a shared connection, any member), since stored scopes may be stale after a revocation. Google's incremental authorization keeps earlier grants. The flow hints the same Google account and is rejected if the user signs in to a different account or the connection was removed meanwhile. **Reconnect** uses the same flow. Only the owner can reconnect a personal connection, and only an admin a shared one.

**Web sites:** a site grant is an exact host or `*.domain`, which covers the domain and every subdomain. Patterns stop at the registrable domain (per the Public Suffix List), so `*.org`, `*.co.uk` and `*.github.io` cannot be granted; only `*` allows every site. A block on a domain wins over access to a wider one. Opening an address sends whatever is in it to that site, so the sites an agent may read are also where it could carry data; the settings page says so. The gateway checks the site before it resolves anything, refuses IP addresses and special-use names (`localhost`, `.internal`, `.local`, `.onion`), requires every resolved address to be public, and connects to the checked address with the site's name for TLS, so DNS rebinding cannot redirect the request. Redirects are followed only on the same host and never from https to http; any other redirect is returned to the agent, which must open the new address under that site's permission. Pages are capped at 3 MB (also after decompression) and 25 seconds, no cookies or credentials are sent, and HTML is reduced to text: scripts, frames and images are dropped (images keep only their alt text). Page text is untrusted input to the model; reducing HTML does not neutralize prompt injection.

**Strict revocation:** changing access, removing a connection, or changing an agent's connections cancels the affected active runs, so no run continues with outdated permissions.

Every tool call goes through one pipeline:

```text
strict argument validation
  → provider consent (the connection's OAuth scopes)
  → connector resolves the real resources the call touches, checked against its declaration
  → permission check
  → (writes) dispatch one of the run's writes, one at a time
  → call the provider
  → (writes) settle: succeeded, not applied (quota returned), or uncertain
  → drop returned records the run may not see
  → return, with an opaque run-bound page token
```

**Guardrails per run:**

| Limit | Value |
|---|---|
| Writes (task or event creations) | 3 |
| Model calls | 30 |
| Output tokens per call | 8,192 |
| Wall-clock time | 300 s |

- **Identical writes** within a run are deduplicated.
- **Uncertain writes:** if a write's outcome is unknown, for example after a timeout, further writes in that run are paused.
- **Refused writes:** a write the provider refused outright (for example 401, 403, 404, 409, or 429), or one that never reached it, returns its quota and does not pause further writes.
- **Lost writes:** a write whose gateway process died is marked uncertain by the supervisor.
- **Rejected tokens:** if the provider rejects a token, the connection is marked **Needs reconnecting**, unless it was reconnected in the meantime. Reconnecting keeps the user's access choices.
- **Changed tools:** if a deploy changes what a tool means, active runs lose that tool instead of using it under their old grants.

## 5. Sandbox

The `container` provider (Docker or Podman) runs each worker with:

- A read-only root filesystem.
- A 256 MB writable `/workspace` and a 64 MB `/tmp`, which does not allow executables.
- Non-root user 1000, all capabilities dropped, `no-new-privileges`, and no shared IPC.
- 1 GB memory, 1 CPU, and 256 processes.
- The internal `minerva-sandbox` network, whose only exit is a relay to the gateway port. The provider refuses to start if that network is not internal.
- Optional gVisor (`MINERVA_SANDBOX_RUNTIME=runsc`).

`make sandbox-check` runs the conformance probe inside the real image. On 2026-09-29 all 11 checks passed:

- Non-root user.
- Only the run token in the environment.
- Workspace writable, root filesystem read-only.
- Gateway reachable.
- Blocked: IPv4 internet, IPv6 internet, cloud metadata, public DNS, host, and database.

The `local-process` provider exists for development. It has no isolation and refuses to start unless explicitly enabled.

**Known weakness:** workers share one network, so two concurrent workers can reach each other.

## 6. Where state lives

Everything is in PostgreSQL. Tenant tables carry a `workspace` key, and scoped managers filter by the current workspace.

| Table | Contents |
|---|---|
| `User`, `Workspace`, `Membership` | Accounts, personal and team workspaces, roles |
| `Connection`, `OAuthClient` | Encrypted provider credentials (key-versioned); registered OAuth clients |
| `PermissionLayer`, `Grant` | Ceiling, user, and agent layers with allow/deny grants |
| `Agent` | Name, instructions, connections |
| `Conversation`, `Message` | Chat history |
| `Run`, `RunEvent` | Status, permission snapshot, token hash, deadline, usage, sandbox handle; ordered events |
| `RunWrite`, `RunPageToken` | Write state (dispatched, succeeded, uncertain), deduplication, and quota; run-bound page tokens |

Other state:

- **Secrets** live only in `.env` (mode 600, gitignored).
- **Containers:** the supervisor removes sandboxes that no run owns anymore.

## 7. Verification (2026-09-29)

| Check | Result |
|---|---|
| Backend tests (`pytest`), including cross-workspace access and the connector contract; needs Postgres running (`make services`) | 266 pass (2026-10-01) |
| Ruff lint and format; worker and frontend typechecks; production build | Pass |
| Sandbox conformance | 11/11 |
| End-to-end run in the container with the fake model | Pass: tool call, streamed text, stored answer, usage recorded, container removed |
| Browser walkthrough | Pass: sign-up, email verification, chat streaming, tool-call card, connection status and reconnect prompt, agent create and validation, two-factor setup with re-authentication |
| Two-factor sign-in | Pass, through the API (the browser step was not driven) |

**Not verified yet:**

- A real Todoist account.
- A real model provider.
- Any cloud deployment.

## 8. Gaps and next steps

Roughly in priority order:

1. **Live check:** a real model key and a real Todoist account.
2. **Cloud alpha:**
   - A production backend image with the web, gateway, and supervisor roles.
   - A worker network per run.
   - A deployment target with gVisor or Kata.
   - PlanetScale Postgres.
   - SMTP email.
3. **Report files and artifacts:** the gateway `PUT /artifacts` endpoint and UI.
4. **Audit records:** today, run events are the record of tool decisions.
5. **Teams:** team workspaces, invitations, workspace switcher, ceiling UI, shared connections.
6. **Login options:** Google and GitHub; passkeys in the UI (the backend already supports WebAuthn).
7. **Model keys:** bring-your-own key per workspace, and quotas.
8. **Web:** a per-run or per-workspace cap on searches (each costs the operator money); egress rules for the gateway in deployment (the fetcher already refuses private addresses); continuing a long page refetches it.
9. **Notion:** a listing or search whose provider page was filtered out entirely still returns a continuation token (as for GitHub), so an agent can learn that hidden pages match a search, but not which; relations and people beyond Notion's 25 per page are marked but not listed; pages are not moved, archived or deleted.
10. **Linear:** issue identifiers and people written as plain text (not links) stay text, and Linear may still link them; there are no tools for projects, cycles, documents, attachments or moving issues between teams; issues cannot be deleted or archived; a team or sub-issue the connected account cannot see at all is invisible to the checks (a hidden parent issue in another team, for example), and Linear can change an issue between Minerva's last check and the write.
11. **Slack:** no direct messages, search, file contents, reactions, edits or deletes; people mentioned by name in plain text stay text; who joins a channel after it was granted, and Slack workflows or other apps that react to a post, are outside Minerva's control; a channel resolved by name scans at most 2,000 channels.
12. **Outlook:** no drafts, attachments, forwarding, reply-all, moving, deleting or flagging, and no shared or delegated mailboxes; Graph accepts mail before delivering it, so a bounce arrives later as mail; an address grant cannot see distribution lists, aliases or forwarding rules that pass mail on; mail can move between Minerva's last check and the write; and an alias Graph does not report (personal Microsoft accounts may report none) is not recognized as the account's own, and neither is mail the account sent as another mailbox (Send As, which Graph shows only as that mailbox), so a reply to such mail is refused only when it sits in Sent Items.
13. **Gmail:** no attachments, forwarding, reply-all, labelling, archiving, deleting or sending drafts; Gmail searches the whole mailbox before Minerva filters the results, so an agent can learn whether mail it may not read matches a search, and with Gmail's search terms test what that mail says, without seeing it; a conversation is read from its last 25 messages, readable or not; Gmail accepts mail before delivering it, so a bounce arrives later as mail; an address grant cannot see mailing lists, aliases or forwarding that pass mail on; labels can change between Minerva's last check and the write; and until the operator's Google app is verified, only its test users can connect and must reconnect every seven days.
14. **Stripe:** amount limits apply to each refund or credit on its own, and Minerva keeps no budget across calls, so a run can move up to its write limit times the cap and separate runs add up; listings are filtered after Stripe has listed them, so a page can hold fewer objects than asked for; a lookup of customers by email returns only its first page, so it does not hint at hidden customers with the address; customer search in the settings page uses Stripe's search, which can lag new customers by about a minute; a key's own Stripe permissions are not read, so a missing one shows up as a refused call.
15. **HubSpot:** tokens carry the app's scopes, not the HubSpot permissions of the user who installed it; HubSpot's automations (workflows, creating companies from contacts' email domains) may act on what an agent changes; search lags behind changes by a few seconds and stops at 10,000 results (then marked incomplete); a deal search across pipelines narrowed by words, stage or association needs Read on all deals, since HubSpot pages results before Minerva filters them (a block on one pipeline then hides its deals, but where allowed deals land can still tell that hidden ones match); an unnarrowed search still pages when every deal on a page was filtered out, so an agent can learn that hidden deals exist, but not which; a deal can change between Minerva's last check and the write.

## 9. Technology

| Area | Choice |
|---|---|
| Backend | Python 3.14, Django 6.1, Django Ninja, Pydantic, django-allauth (headless, MFA), MCP SDK 2.2, httpx, psycopg 3, uvicorn |
| Database | PostgreSQL 18 (Compose locally) |
| Worker | Node 24, TypeScript, DeepSeek Harness 0.1.7-rc.2 (SDK client, pi-ai model adapter, MCP client), zod |
| Frontend | React 19, Vite 8, TanStack Router/Query/Form, assistant-ui 0.15, Tailwind 4, Radix, Hey API client generated from OpenAPI |
| Tooling | uv, pnpm, Ruff, pytest, honcho |

TypeScript is pinned to 5.9 in the frontend because the Hey API generator does not run on TypeScript 7.
