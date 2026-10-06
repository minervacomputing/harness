# Minerva — current state

Updated 2026-10-06. This describes the code in this repository. For the reasons behind it, see [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md). For setup, see [README.md](README.md).

## 1. Summary

Minerva runs AI agents that **never hold credentials and never decide their own permissions**. Each agent turn runs in a locked-down container. The container can only call a trusted gateway, which holds the keys and checks every action against permissions the user chose.

This is the first real implementation. It is not a prototype and is built to be extended. It runs locally today and is structured for a cloud alpha.

**What works:**

- Sign up with email verification, sign in with a password or an emailed code, reset a password, and use two-factor authentication with an app and recovery codes.
- A personal workspace for every user, with a default agent.
- Connecting Todoist through OAuth, then choosing per project what agents may do: read tasks and/or create tasks.
- Connecting Google Calendar, then choosing per calendar (or for all calendars) what agents may do: read events and/or create events. Agents can list calendars, list and read events, and create events without guests. Minerva asks Google only for read access at first, and for write access once the user allows creating events (see [section 4](#4-permissions)).
- Connecting Google Drive, then choosing per folder or file (or for all of Drive) what agents may do: read files and/or create files. Access to a folder covers everything inside it, and a block on a folder wins over access to a folder around it. Agents can list folders, search, read file details, read Google Docs, Sheets, Slides and text files as text, and create text files or Google Docs in a folder. Minerva asks Google for read-only access at first, and for full Drive access once the user allows creating files, because Google's narrower scope cannot add files to folders Minerva did not create.
- Connecting GitHub through a GitHub App, then choosing per repository (or for all repositories) what agents may do: read code, issues and pull requests, and/or open issues and comment. Agents can list repositories, read a repository's details, list and read issues and pull requests (with comments and diffs, truncated), read text files and list directories, open issues with a title and text only, and comment on issues and pull requests. Minerva sees only the repositories the user installs the App on; the connection links to GitHub to choose them.
- Connecting Notion, then choosing per page or database (or for everything Notion shares with Minerva) what agents may do: read, comment, create pages, and edit. Access to a page covers the pages inside it, and a block wins over access to a page around it. Agents can search, read page details and page text, read and query databases, list and add comments, create pages and database rows, set a page's plain properties, replace text on a page and append to it. Hidden from agents: titles of pages they cannot read that appear as links or mentions, synced content from other pages, and rollup, formula and file properties. Written text may not create child pages, embed content from other sites, or mention people. Notion automations that react to an agent's change are outside Minerva's control.
- Connecting Linear, then choosing per team (or for every team) what agents may do: read issues, comment, create issues, and edit issues. Access to a team covers its sub-teams, and a block on a sub-team wins over access to the team around it. Agents can list teams, read a team's statuses, labels and members, list a team's issues and search their titles, read an issue with its sub-issues and comments, create issues, comment (and reply), and change an issue's title, description, status, priority, labels, assignee and due date. Hidden from agents: titles of other issues, projects and documents in links, and anything but the existence of a parent or sub-issue in another team. Written text may link to Linear only with addresses of issues in the same team, since Linear turns links into mentions shown on the linked issue. A status change is refused when Linear could then close or reopen issues in other teams on its own. Linear's other automations (triage rules, integrations) are outside Minerva's control.
- Connecting Slack as the operator's own Slack app, then choosing per channel (or for every channel) what agents may do: read messages, reply in threads, and post to the channel. The app reaches only channels it has been added to in Slack, so a channel needs both. Agents can list the channels they may read, read a channel's messages (newest first, between two times) and a thread, reply in a thread, and post. Hidden from agents: names of channels in links and in topics, attachments (link previews and messages shared from other channels), and file contents. Written text is shown literally, so it cannot mention people or notify a channel (`@channel`, `@here`), and it may not link to Slack, since Slack would show the linked message. Posting to channels shared with other organizations is refused. Direct messages are out of reach.
- Connecting Outlook (work, school or personal Microsoft accounts), then choosing per mail folder (or for all folders) what agents may read, and per address or domain (or for everyone) whom they may send mail to. Access to a folder covers its subfolders, and a block on a subfolder wins. Agents can list folders, list a folder's messages (filtered by unread and received time, or searched), read a message as plain text with the names of its attachments, send plain-text mail, and reply to a message they may read. Every address a message goes to, Cc and Bcc included, needs permission; a reply goes only to the addresses the original asks replies to go to, or else its sender, and needs permission for each of them. Search folders, hidden folders and Exchange's system folders are out of reach, and replies to drafts and to the account's own mail are refused. Not supported: drafts, attachments (reading or sending), forwarding, reply-all, moving, deleting or flagging mail, and shared mailboxes.
- Connecting Outlook Calendar (same Microsoft accounts), then choosing per calendar (or for all calendars) what agents may do: read events and/or create events. Agents can list calendars, list one calendar's events over a window of up to 366 days (recurring events expanded, each event in full), and create events without attendees. Minerva asks Microsoft only for read access at first, and for write access once the user allows creating events.
- Connecting OneDrive and SharePoint (same Microsoft accounts), then choosing per library, folder or file (or for everything) what agents may do: read files and/or create them. Access to a folder or library covers everything inside it, and a block on a folder inside wins. Agents can list the account's OneDrive and the libraries of the SharePoint sites it follows, list a folder, search files (Microsoft Search for work and school accounts), read a file's details, read the text of Word, PowerPoint, Excel (first sheet, as CSV) and text files, and create text files without replacing existing ones. Minerva asks Microsoft only for read access at first, and for write access once the user allows creating files.
- Connecting Microsoft Teams (work and school accounts), then choosing per team or channel (or for everything) what agents may do: read messages, reply in threads, and start threads. Access to a team covers all its channels, private ones the account is in and new ones included, and a block on a channel inside wins. Agents can list teams and channels, read a channel's messages and a thread, start a thread and reply in one, posting as the signed-in user. Hidden from agents: mentions of channels and teams, links and addresses to Teams, quotes, cards and forwarded messages, and file contents. Written text is shown literally, so it cannot mention anyone or format, and it may not link to Teams. Posting to shared channels is refused. Chats and meetings are out of reach. Reading messages needs an administrator's consent in the user's organization.
- Connecting Gmail, then choosing per label (or for all mail) what agents may read, per address or domain (or for everyone) whom they may send mail to, and whether they may save drafts. Access to a label covers the labels nested under it (`Work/Projects` under `Work`). A message with several labels can be read if one of them is allowed and is hidden if one of them is blocked; archived mail without labels is covered only by allowing every label. Agents can list labels, list and search messages, read a message or a conversation as plain text with the names of attachments, send plain-text mail, reply to a message they may read, and save drafts and reply drafts. Every address a message goes to, Cc and Bcc included, needs permission; a reply goes only to the original's Reply-To addresses, or else its sender, and needs permission for each. Drafts need no recipient permission, since the user sends them. Chats are out of reach, and replies to drafts and to the account's own mail are refused. Not supported: attachments (reading or sending), forwarding, reply-all, labelling, archiving, deleting, and sending drafts.
- Connecting Stripe with a restricted key, then choosing per customer (or for every customer) what agents may do: read, refund payments, and credit balances, and separately up to what amount, per currency, each refund or credit may be. Access to a customer covers their payments, invoices and subscriptions; payments without a customer are covered only by allowing every customer. Agents can list and read customers, list payments (with what is left to refund), invoices and subscriptions, refund part or all of a payment, and add credit to a customer's balance. A refund is checked against the payment just before it is sent: the currency must match, the payment must have succeeded and not be disputed, and the amount must not exceed what is left. Secret keys are refused, and a test key and a live key are separate connections. Not supported: creating charges, invoices or subscriptions, cancelling subscriptions, disputes, payouts, and Stripe Connect accounts.
- Connecting HubSpot through the operator's public app, then choosing for all contacts, all companies, all deals, or the deals of one pipeline what agents may do: read, create contacts and deals, edit them, and log notes. Agents can search contacts, companies and deals (by words, exact email address or domain, pipeline and stage, or the records they are associated with), read one, list deal pipelines with their stages, create and edit contacts, create deals (associated with contacts and companies they may read), change a deal's name, stage, amount and close date within its pipeline, and log plain-text notes on a contact, company or deal. Searching by association needs Read on both sides, searching deals by anything but their pipeline needs Read on all deals, and a deal that moved to another pipeline since it was checked is refused. Not supported: tickets, tasks, emails, calls, meetings, owners, custom objects, reading notes, writing companies, deleting, merging, moving deals between pipelines, and grants on single contacts or companies.
- Connecting Jira Cloud through the operator's Atlassian app, then choosing per site or project (or for everything) what agents may do: read issues, comment, create issues, and change their status. Access to a site covers all its projects, new ones included, and a block on a project inside wins. One connection can reach several sites, the ones picked on Atlassian's consent screen. Agents can list projects, search one project's issues (by words in the summary, status category and assignment to themselves), read an issue with its latest comments and the related issues in the same project, comment, create issues of a named type, and move an issue through its workflow. Search takes fields, never JQL. Hidden from agents: titles behind links to Atlassian, macro content, and related issues in other projects beyond their number. Written text is plain, without mentions, formatting or links to Atlassian. An issue that moved to another project since it was checked is refused.
- Connecting Confluence Cloud through the operator's second Atlassian app, then choosing per site or space (or for everything) what agents may do: read pages, comment on them and create them. Access to a site covers all its spaces, new ones included, and a block on a space inside wins. Agents can list spaces, search one space's pages by words in the title, read a page with its body, its parent (when in the same space) and its latest top-level footer comments, comment at the foot of a page, and create a page, at the top of a space or under a page in it. Search takes fields, never CQL. Hidden from agents: titles behind links to Atlassian and macro content. Written text is plain, without mentions, formatting or links to Atlassian. A page that moved to another space since it was checked is refused.
- Connecting Intercom through the operator's app, as one teammate in one workspace, then choosing per team inbox (or for conversations no team is assigned to, or for everything) what agents may do: read conversations, add internal notes and reply to customers. Agents can list inboxes, search one inbox's conversations (by state, update time and words in the first message), read a conversation with its first message and latest replies and notes, add an internal note, and reply to the customer. A conversation is authorized in the inbox it is in when Minerva reads it, and one reassigned to another inbox since it was checked is refused. Hidden from agents: links to Intercom with their labels, assignments and other events, and the names of teams as authors. Written text is plain, without formatting, mentions or links to Intercom.
- Connecting Xero through the operator's app, as one Xero user reaching the organisations they picked, then choosing per organisation (or for all of them) what agents may do: read invoices, bills and contacts, create draft sales invoices, and create draft bills. Agents can list organisations, search contacts (by name, number or email), search invoices and bills (by type, status, contact, date and number or reference), read an invoice with its lines and payments, and list the active accounts and tax rates. Drafts are created with status DRAFT only, for an active contact named by id; agents cannot approve, send, pay, void or change invoices. Hidden from agents: bank account numbers and contacts' bank details.
- Connecting Sentry (sentry.io) through the operator's OAuth application, as one user in one organisation, then choosing per project (or for all of them) whether agents may read its issues. Agents can list projects, search one project's issues (by status, level, environment, period and a phrase), read an issue by id or short id, and read one of its events: the exceptions with their innermost stack frames and the source lines around them, an allowlist of tags, the release, environment, runtime, OS and browser, and the request's method and address without its query. Search takes fields, never Sentry's query syntax. Hidden from agents: local variables, request headers, cookies and bodies, the user, breadcrumbs, other tags, and an issue's comments and activity.
- Adding the Web, then choosing which sites agents may read (an exact host such as `docs.python.org`, a domain with its subdomains such as `*.python.org`, or every site) and, separately, whether they may search. Agents can search the web through Brave Search (titles, addresses and snippets only) and read pages as text. Minerva fetches pages itself and never opens private networks (see [section 4](#4-permissions)).
- Creating agents with their own instructions and connections. An agent with tools can also write a short script that calls several of them in one step, for example to make independent reads at once or to filter long results before they reach the model. Every call in a script is checked, counted and shown as a card like a direct call.
- Chatting with an agent. The answer streams in live, tool calls appear as cards (done, not allowed, failed), and a run can be stopped.
- Every turn runs in a fresh hardened container, which is removed afterwards. If the container dies mid-turn (it crashes, or runs out of memory), a new one resumes the turn from state the gateway saved, without running an interrupted write again.

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
                              worker: pi-durable                (keys live only here)
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
3. **Worker → gateway:** it fetches the run spec with `GET /run` and starts a pi-durable agent. The agent's model points at the gateway relay and its only tools are the gateway's MCP tools: it has no shell, file or subprocess tools. Tools the gateway marks read-only run in parallel; a round that includes a write runs its calls one at a time. The newest earlier messages that fit in about 120,000 characters are replayed in order, each cut at 30,000. Tool results reach the model whole up to 1 MB, since the gateway already pages long ones; a larger result is cut and marked as cut. Older context is summarized only when the context is nearly full or overflows, and that summary briefly shows in the streamed text. pi-durable saves the agent's state through the gateway as the turn goes, so a new worker can resume it (see [When a worker dies](#when-a-worker-dies)). When the run has tools (and fewer than the relay's limit of 128), the agent also gets a `run_script` tool: the script runs in a QuickJS sandbox (pi-codemode, in a worker thread, 64 MB of memory, at most 120 seconds) with no network, files or timers, and can only call the same gateway tools. Its description says when a script is worth it (reads that page through long lists, repeat across many resources, or count, filter or total results) and how results page. The gateway declares the result every successful call returns (`items`, `count`, and `next_cursor`, `incomplete` or `outcome` when present) as its output schema, so scripts see one shared `Result` type; item fields are not declared. A refused or failed call rejects inside the script with the gateway's message, and only what the script prints or returns reaches the model. The worker sends direct and scripted calls through one queue: at most 4 at once, writes one at a time. The worker refuses a scripted call itself when 100 calls are already waiting, or when its arguments exceed 256 KB of JSON, and it stops a script after 100 such refusals. Calls still unfinished when a script ends are cancelled and reported to the model, since a cancelled write may already have happened; the gateway still finishes a call it has started, so that call keeps its place in the queue until the gateway answers (or the turn runs out of time, on an instance that limits it). The worker's notes (a failure, cancelled calls) come before the script's output, so cutting a long result cannot drop them. Values a script keeps with `store()` are saved with the turn when the script succeeds, up to 1 MiB.
4. **Gateway:**
   - Model calls go to the configured upstream. The relay parses the stream and publishes text deltas as run events every 0.25 s.
   - Tool calls go through the permission executor ([section 4](#4-permissions)).
5. **Worker → gateway:** it posts only `phase`, `completed` (with the final answer), and `failed` events, and saves each change to the agent's state in the run's journal (`PUT /journal/{seq}`) before it takes effect.
6. **End of the run:** the token is revoked when the run reaches any final state, the run's saved state is deleted, and the supervisor removes the container.
7. **Browser:** follows run events through server-sent events, woken by Postgres `NOTIFY`, and resumes after a reconnect from the last sequence number. Agent text is rendered as Markdown, but images in it are shown as text and never loaded, and a Content Security Policy also blocks remote images. Otherwise, prompt-injected content could send data out through the browser.

Run states: `queued → provisioning → running → completed | failed | cancelled | timed_out`. A restart takes a run back to `provisioning`.

Stopping a run revokes its token, so every later call from the worker is rejected. A Todoist write that is already in flight may still complete. The token is checked when a request opens, so the MCP endpoint takes only POST: a GET would open a stream for server messages that stays up after the run ends, and is refused with 405.

### When a worker dies

If a worker exits before its run ends (it crashed, or was killed for using too much memory), the supervisor starts a new one for the same run: at most twice per run, and, if the run has a deadline, only while at least 30 seconds are left before it. The restart:

- Moves the run to its next **attempt** and gives it a new token. Every gateway request is checked against the attempt its token was issued for, so the old worker, if it is somehow still connected, can no longer call tools or the model, post events, save state, or finish the run. A write it had already started is still carried out, and the restart waits until the write is settled (succeeded, not applied, or uncertain), so the new worker sees how it ended.
- Gives the new worker its own container and its own 90 seconds to ask for the run spec.
- Posts a status event naming the attempt. The chat then drops the text the old worker streamed and shows "Restarting the agent".

The new worker loads the saved state (`GET /journal`, then `GET /journal/{seq}` for each commit), takes its agent settings, tools and deadline from `GET /run` as a first worker would, and resumes the turn:

- A read that was interrupted runs again.
- A write or script that was interrupted does not, because whether it happened is unknown. The model is told it was interrupted and can check before trying again.
- If the model asks again for the same write (same tool, same arguments), the gateway answers from its record instead of repeating it, as it does within one worker, and the chat shows the write's card once. A write whose outcome is uncertain still pauses the run's further writes.
- A worker that cannot reach the gateway to load the saved state, or cannot save a change to it, exits and leaves the turn to the next attempt. Other failures, such as not reaching the gateway's tools, fail the run as before.

If a worker dies after the run's second restart, or with less than 30 seconds left before its deadline, the run fails with "The worker stopped unexpectedly."

The saved state comes from an untrusted worker. The gateway stores it encrypted and never reads it, refuses it from any attempt but the current one, caps it at 8 MiB per commit and 32 MiB or 5,000 commits per run, and deletes it when the run ends. Stored messages and run events stay the record of a turn: the next turn starts from the stored messages, never from saved state.

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
| Outlook Calendar | Calendar (Graph id) | Read events, Create events | Microsoft's permission covers every calendar the account lists, shared ones included, so calendar limits are Minerva's. |
| OneDrive and SharePoint | File; folders and libraries are files (`{drive id}:{item id}`) | Read files, Create files | Microsoft's permission covers every file the account can open, so file limits are Minerva's; a folder or library grant covers everything inside it. Items shared from someone else's OneDrive sit in folders Graph does not show, so any block on that action blocks them. |
| Microsoft Teams | Channel; teams are channels' parents (team id, lowercase GUID; channel id `19:…@thread.tacv2`) | Read, Reply (in threads), Post (start threads) | Microsoft's read permission covers every channel the account is in, so channel limits are Minerva's; a team grant covers its channels. A channel is reached only through the team that hosts it. |
| Gmail | Label (label id); Recipient; the connection itself | Label: Read. Recipient: Send. Connection: Draft | Google's read scope covers the whole mailbox, so label limits are Minerva's; a label grant covers nested labels, and a message is inside every label it carries. Recipients work as for Outlook. |
| Stripe | Customer (customer id); Amount | Customer: Read, Refund, Credit. Amount: Refund, Credit | A customer grant covers what is billed to them. An amount is chosen as a tier per currency (`usd<=50`, "Up to 50.00 USD"; `usd>500`, "More than 500.00 USD"; `usd`, any amount); caps apply to each call on its own. |
| HubSpot | CRM record: `contacts`, `companies`, `deals` and `pipeline:<id>` | Read, Create (contacts and deals), Edit (contacts and deals), Note | Grants are on collections and pipelines only: a merged record answers under another id, but stays in its collection. Deals sit inside their pipeline, inside `deals`. |
| Jira | Project; sites are projects' parents (site: cloud id; project: `<cloud id>/<project id>`) | Read, Comment, Create, Change status | A site grant covers its projects. Tools name projects by key and issues by key; former keys resolve to the issue's current project. |
| Confluence | Space; sites are spaces' parents (site: cloud id; space: `<cloud id>/<space id>`) | Read, Comment, Create | A site grant covers its spaces. Tools name spaces by key or id and pages by id; a page is authorized in the space it is in now. |
| Intercom | Inbox (team id, or `none` for conversations no team is assigned to) | Read, Note, Reply | Tools name conversations by id; a conversation is authorized in the inbox of the team it is assigned to now. |
| Xero | Organisation (tenant id, lowercase GUID) | Read, Draft sales invoices, Draft bills | Everything inside an organisation (contacts, invoices, accounts) is covered by its grant. A connection reaches the organisations picked when connecting; calls name one when it reaches several. |
| Sentry | Project (numeric project id) | Read | A connection reaches one organisation, the one picked on Sentry's consent screen. Tools name projects by id or slug and issues by id or short id; an issue is authorized in its project. |
| Web | Site; the connection itself | Site: Read. Connection: Search | Searching sends the query to Brave Search, so it is its own permission. |

Connector declarations are described in [ARCHITECTURE_DECISIONS.md, D8](ARCHITECTURE_DECISIONS.md#d8-connectors-and-the-permission-executor).

Layers can only narrow, and deny wins:

```text
effective = provider account ∩ workspace ceiling ∩ user layer ∩ agent layer
```

In a personal workspace the ceiling is unrestricted and hidden. The UI edits the user layer in each connection's row on **Connections** (a row lists what it allows; connections with nothing allowed or needing a reconnect are listed first under **Needs your attention**). Google Drive folders are chosen in a tree, browsed folder by folder. Listings are cached for five minutes; **Refresh** loads them again. Each agent can use only the connections selected for it.

**Provider consent:** each tool also needs the provider scopes behind it. A tool whose scopes the connection lacks is not offered. When the user allows an action whose scopes Google has not granted (for example Create events on a connection made with read-only access), the connection says so and offers **Allow in Google Calendar**. That flow is tied to the connection: it asks Google for the scopes behind every action the user allows (on a shared connection, any member), since stored scopes may be stale after a revocation. Google's incremental authorization keeps earlier grants. The flow hints the same Google account and is rejected if the user signs in to a different account or the connection was removed meanwhile. **Reconnect** uses the same flow. Only the owner can reconnect a personal connection, and only an admin a shared one.

**Web sites:** a site grant is an exact host or `*.domain`, which covers the domain and every subdomain. Patterns stop at the registrable domain (per the Public Suffix List), so `*.org`, `*.co.uk` and `*.github.io` cannot be granted; only `*` allows every site. A block on a domain wins over access to a wider one. Opening an address sends whatever is in it to that site, so the sites an agent may read are also where it could carry data; the settings page says so. The gateway checks the site before it resolves anything, refuses IP addresses and special-use names (`localhost`, `.internal`, `.local`, `.onion`), requires every resolved address to be public, and connects to the checked address with the site's name for TLS, so DNS rebinding cannot redirect the request. Redirects are followed only on the same host and never from https to http; any other redirect is returned to the agent, which must open the new address under that site's permission. Pages are capped at 3 MB (also after decompression) and 25 seconds, no cookies or credentials are sent, and HTML is reduced to text: scripts, frames and images are dropped (images keep only their alt text). Page text is untrusted input to the model; reducing HTML does not neutralize prompt injection.

**Strict revocation:** changing access, removing a connection, or changing an agent's connections cancels the affected active runs, so no run continues with outdated permissions.

Every tool call goes through one pipeline:

```text
strict argument validation
  → provider consent (the connection's OAuth scopes)
  → connector resolves the real resources the call touches, checked against its declaration
  → permission check
  → (writes) dispatch the write, one at a time per run
  → call the provider
  → (writes) settle: succeeded, not applied (forgotten, so it can be tried again), or uncertain
  → drop returned records the run may not see
  → return, with an opaque run-bound page token
```

**Guardrails per run:** a turn has no limit on its writes, model calls or tool calls, so an agent can work on one prompt for as long as it needs. What is limited is how fast it goes:

| Limit | Value |
|---|---|
| Writes executing at once | 1 |
| Tool calls executing at once | 4 (per gateway process; the rest wait) |
| Requests in flight to the gateway | 16 per run token (per gateway process; more are refused with 429) |
| Run token checks queued or running | 128 (per gateway process, for all runs; more requests are refused with 503) |
| Model calls reading from the provider | 4, counting calls the worker hung up on (per gateway process; more are refused with 429) |
| Output tokens per call | 8,192 |
| Wall-clock time | None by default (`MINERVA_RUN_TIMEOUT_SECONDS`); 300 s in the public demo unless set |

- **Identical writes** within a run are deduplicated.
- **No deadline:** a turn without one runs until it ends, the user stops it, or its worker fails for good. The worker gives up on a tool call after 10 minutes, and the relay drops a model answer that goes quiet for 120 seconds; the gateway itself does not bound how long a read takes, beyond each provider request's own timeouts.
- **Uncertain writes:** if a write's outcome is unknown, for example after a timeout, further writes in that run are paused.
- **Refused writes:** a write the provider refused outright (for example 401, 403, 404, 409, or 429), or one that never reached it, is forgotten, so it can be tried again, and does not pause further writes.
- **Lost writes:** a write whose gateway process died is marked uncertain by the supervisor.
- **Rejected tokens:** if the provider rejects a token, the connection is marked **Needs reconnecting**, unless it was reconnected in the meantime. Reconnecting keeps the user's access choices.
- **Requests without a run token:** a request without an active run's token, or with an invented one, is refused with 401 before Django or the MCP server reads its body, so a worker cannot make the gateway hold large uploads without one. Tokens are checked one at a time on one database connection per gateway process, so a worker sending invented tokens quickly can get other runs' requests refused with 503 too, and a query that stalls on that connection holds up every check until it ends.
- **Requests in flight:** a response holds its request's place until the worker has read nearly all of it, so a worker cannot pin many large responses (run specs, saved state) in gateway memory by not reading them.
- **Changed tools:** if a deploy changes what a tool means, active runs lose that tool instead of using it under their old grants.

## 5. Sandbox

The `container` provider (Docker or Podman) runs each worker with:

- A read-only root filesystem.
- A 256 MB writable `/workspace` and a 64 MB `/tmp`, which does not allow executables.
- Non-root user 1000, all capabilities dropped, `no-new-privileges`, and no shared IPC.
- 1 GB memory, 1 CPU, and 256 processes.
- The internal `minerva-sandbox` network, whose only exit is a relay to the gateway port. The provider refuses to start if that network is not internal.
- Optional gVisor (`MINERVA_SANDBOX_RUNTIME=runsc`).

`make sandbox-check` runs the conformance probe inside the real image. On 2026-10-06 all 11 checks passed:

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
| `Run`, `RunEvent` | Status, attempt, permission snapshot, token hash, deadline, usage, sandbox handle; ordered events |
| `RunCommit` | A running turn's saved agent state: the worker's commits, encrypted and never read by the backend; deleted when the run ends |
| `RunWrite`, `RunPageToken` | Write state (dispatched, succeeded, uncertain) and deduplication; run-bound page tokens |

Other state:

- **Secrets** live only in `.env` (mode 600, gitignored).
- **Containers:** the supervisor removes sandboxes that no run owns anymore.

## 7. Verification (2026-09-29)

| Check | Result |
|---|---|
| Backend tests (`pytest`), including cross-workspace access and the connector contract; needs Postgres running (`make services`) | 837 pass (2026-10-06) |
| Worker tests, including pi-durable's storage conformance suite run on the journal adapter (against a fake gateway), and resuming a turn after each kind of interruption | 73 pass (2026-10-06) |
| Ruff lint and format; worker and frontend typechecks; production build | Pass |
| Sandbox conformance | 11/11 |
| End-to-end run in the container with the fake model | Pass: tool call, streamed text, stored answer, usage recorded, container removed |
| Worker killed mid-turn (`docker kill`), in the container with the fake model (2026-10-06) | Pass: killed while streaming its answer after a read, the turn resumed as attempt 2 without running the read again and showed one tool card and one answer; killed during a script, the script did not run again and the model was told; killed three times, the run failed after its second restart. Saved state deleted and containers removed each time |
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
3. **Durable turns:** a turn survives its worker dying, and no more than that:
   - A model or tool call cut off by a dropped connection still fails the turn or the call, rather than leaving it to a new worker. A resumed worker that cannot connect to the gateway's tools fails the run.
   - A turn cannot wait for an approval: there is no parked state without a container yet. A turn without a deadline holds its container and a slot among the instance's concurrent runs until it ends or is stopped.
   - A long turn is bounded by what it stores rather than by a count: its saved state is capped at 32 MiB or 5,000 commits, and it is issued at most 200 page tokens (`LIMIT_REACHED` after that). Its run events, which the conversation loads whole, and `RunWrite` records grow with it.
   - Each turn is its own pi session, so there are no steers, follow-ups or background subagents.
   - Restarts are counted whatever the cause, so a worker that the same input crashes every time spends both restarts before the run fails.
   - `RunWrite.result` (a write's answer, kept so that a repeated write is answered from it) is stored unencrypted, and it and `RunPageToken` have no retention period.
   - A script's `store()` drops the key `__proto__` (pi-codemode does).
4. **Report files and artifacts:** the gateway `PUT /artifacts` endpoint and UI.
5. **Audit records:** today, run events are the record of tool decisions.
6. **Teams:** team workspaces, invitations, workspace switcher, ceiling UI, shared connections.
7. **Login options:** Google and GitHub; passkeys in the UI (the backend already supports WebAuthn).
8. **Model keys:** bring-your-own key per workspace, and quotas.
9. **Web:** a per-run or per-workspace cap on searches (each costs the operator money); egress rules for the gateway in deployment (the fetcher already refuses private addresses); continuing a long page refetches it.
10. **Notion:** a listing or search whose provider page was filtered out entirely still returns a continuation token (as for GitHub), so an agent can learn that hidden pages match a search, but not which; relations and people beyond Notion's 25 per page are marked but not listed; pages are not moved, archived or deleted.
11. **Linear:** issue identifiers and people written as plain text (not links) stay text, and Linear may still link them; there are no tools for projects, cycles, documents, attachments or moving issues between teams; issues cannot be deleted or archived; a team or sub-issue the connected account cannot see at all is invisible to the checks (a hidden parent issue in another team, for example), and Linear can change an issue between Minerva's last check and the write.
12. **Slack:** no direct messages, search, file contents, reactions, edits or deletes; people mentioned by name in plain text stay text; who joins a channel after it was granted, and Slack workflows or other apps that react to a post, are outside Minerva's control; a channel resolved by name scans at most 2,000 channels.
13. **Outlook:** no drafts, attachments, forwarding, reply-all, moving, deleting or flagging, and no shared or delegated mailboxes; Graph accepts mail before delivering it, so a bounce arrives later as mail; an address grant cannot see distribution lists, aliases or forwarding rules that pass mail on; mail can move between Minerva's last check and the write; and an alias Graph does not report (personal Microsoft accounts may report none) is not recognized as the account's own, and neither is mail the account sent as another mailbox (Send As, which Graph shows only as that mailbox), so a reply to such mail is refused only when it sits in Sent Items.
14. **Gmail:** no attachments, forwarding, reply-all, labelling, archiving, deleting or sending drafts; Gmail searches the whole mailbox before Minerva filters the results, so an agent can learn whether mail it may not read matches a search, and with Gmail's search terms test what that mail says, without seeing it; a conversation is read from its last 25 messages, readable or not; Gmail accepts mail before delivering it, so a bounce arrives later as mail; an address grant cannot see mailing lists, aliases or forwarding that pass mail on; labels can change between Minerva's last check and the write; and until the operator's Google app is verified, only its test users can connect and must reconnect every seven days.
15. **Stripe:** amount limits apply to each refund or credit on its own, and Minerva keeps no budget across calls, so the cap bounds each refund or credit, not how many a run makes, and separate runs add up; listings are filtered after Stripe has listed them, so a page can hold fewer objects than asked for; a lookup of customers by email returns only its first page, so it does not hint at hidden customers with the address; customer search in the settings page uses Stripe's search, which can lag new customers by about a minute; a key's own Stripe permissions are not read, so a missing one shows up as a refused call.
16. **HubSpot:** tokens carry the app's scopes, not the HubSpot permissions of the user who installed it; HubSpot's automations (workflows, creating companies from contacts' email domains) may act on what an agent changes; search lags behind changes by a few seconds and stops at 10,000 results (then marked incomplete); a deal search across pipelines narrowed by words, stage or association needs Read on all deals, since HubSpot pages results before Minerva filters them (a block on one pipeline then hides its deals, but where allowed deals land can still tell that hidden ones match); an unnarrowed search still pages when every deal on a page was filtered out, so an agent can learn that hidden deals exist, but not which; a deal can change between Minerva's last check and the write.
17. **Outlook Calendar:** events are read only through a calendar's listing, never by id (Graph does not show which calendar an event id is in); events cannot be changed, deleted or answered, and created events have no attendees, recurrence or online meeting; group calendars are not listed; all-day events need the calendar owner's time zone, among the IANA names Graph accepts. Graph reports all-day events at midnight UTC without the owner's zone, and is reported to give a calendar in a zone ahead of UTC the day before; listed all-day dates have not been checked against a live account.
18. **OneDrive and SharePoint:** no PDFs, images, legacy Office formats (.doc, .xls, .ppt) or OneNote; Excel is read from its first sheet as stored values (no formulas evaluated, dates as numbers); Office files are unpacked in Minerva's own process, under size and entry limits rather than isolation; files cannot be replaced, edited, moved, renamed, shared or deleted, and only text files are created; SharePoint sites cannot be granted as a whole, and libraries of sites the account does not follow are reached only through search or a folder's id; Microsoft Search sees what the whole account can open before Minerva filters the results, so an agent can learn that hidden files match a search when a page comes back short; an item can move between Minerva's last check and the call. Download hosts, paging tokens and the Search API's answers have not been checked against a live account.
19. **Microsoft Teams:** no chats, meetings, files, reactions, edits or deletions; written text is plain, without formatting or mentions, and importance is never set; refusing shared channels limits the kind of channel, not who reads it (standard and private channels can have guests); posts appear as the signed-in user; only joined teams are offered and named (at most 100), so the host team of a shared channel the account reaches without being in the team cannot be chosen; cards, quotes (a person's own included) and forwarded messages are left out rather than filtered; a channel can change between Minerva's last check and the write. Paging tokens, whether a team's channel listing includes the shared channels it hosts, and how posted HTML is shown have not been checked against a live account.
20. **Jira:** no attachments, worklogs, sprints, boards, edits of fields, assignment, deletion or issue links; issues are created with a type, summary and description only, so projects that require other fields refuse them, as Jira does transitions that require fields; search covers summaries only, and while Jira's search index lags behind a move (seconds), an issue moved out of a project can still make a page of results empty but continued, telling an agent that a hidden issue matched; written text is plain; watchers are notified and a project's automation rules may act on what an agent changes, in that project or others; an issue can move between Minerva's last check and the write. Paging tokens, whether bulk fetches leave out issues the account cannot see, and the issue type listing's shape have not been checked against a live account.
21. **Confluence:** pages cannot be edited, moved, archived or deleted, and blog posts, attachments, labels, inline comments and comment replies are neither read nor written; child pages are not listed; search covers titles only, and while Confluence's search index lags behind a move, a page moved out of a space can still make a page of results short or empty but continued, telling an agent that a hidden page matched; written text is plain; watchers are notified and a space's automation rules may act on what an agent changes; a page can move between Minerva's last check and the write. Nothing has been checked against a live account yet: scopes, paging tokens, CQL and the shape of bodies and comments follow Atlassian's documentation.
22. **Intercom:** no tickets, contacts, companies, articles, tags, assignment, closing, snoozing or attachments; search matches words in the first message only, is not sorted, and while Intercom's search index lags behind a reassignment, a conversation moved out of an inbox can still make a page of results short or empty but continued, telling an agent that a hidden conversation matched. Intercom matches words against the raw message, link labels hidden from agents included; Minerva drops results whose shown text lacks a word, but the short page that leaves says the same; a conversation too large to read is refused like one the account cannot see; written text is plain, and replies reach the customer as the connected teammate; a conversation can be reassigned between Minerva's last check and the write, and the write then lands in the new inbox. Nothing has been checked against a live account yet: region routing through `api.intercom.io`, the token response, the reply endpoint's answer (and so `part_id`), whether tickets appear in conversation search, and the value types search accepts follow Intercom's documentation.
23. **Xero:** only draft sales invoices and draft bills are written: no credit notes, quotes, purchase orders, payments, contacts, attachments or changes to existing invoices; a draft is not deduplicated across runs, so an agent asked twice creates two; search pages by page number, so invoices added or changed while paging can be skipped or repeated; contact balances name no currency (Xero's documentation disagrees on whether they are converted to the organisation's base currency); an invoice shows at most 200 lines and 50 payments, with counts; the user's role in each organisation still applies, and Xero refuses what it does not allow. Nothing has been checked against a live account yet: the userinfo fields, Basic client authentication with PKCE, the shape of validation errors, the `where` filter on type and dates, paging and `summaryOnly` on invoices, the answer to creating an invoice, and a missing contact's 404 follow Xero's documentation and OpenAPI description.
24. **Sentry:** read-only: no resolving, assigning, commenting or muting; only sentry.io, not self-hosted Sentry; one organisation per connection; an event shows exception stack traces only, not threads or a plain stack trace, and at most 10 exceptions of 40 frames each; messages, exception values, source lines, transaction names and request paths are shown as the application sent them, and can carry what it put there, links to other issues included; search takes a status, level, environment, period and one phrase, not Sentry's query syntax; the user's team memberships still apply, and Sentry refuses projects they cannot see. Nothing has been checked against a live account yet: the current user endpoint (`/api/0/auth/`, which Sentry does not document as public), routing to the organisation's region, whether the organisation list holds exactly the connected organisation, the cursor format, the `is:archived` filter, quoted phrases in search, the event's `groupID` and `projectID` types, the stack frame field names, and refreshing tokens follow Sentry's documentation and OpenAPI description.

## 9. Technology

| Area | Choice |
|---|---|
| Backend | Python 3.14, Django 6.1, Django Ninja, Pydantic, django-allauth (headless, MFA), MCP SDK 2.2, httpx, psycopg 3, uvicorn |
| Database | PostgreSQL 18 (Compose locally) |
| Worker | Node 24, TypeScript, pi-durable 1.0.3 (agent loop), pi-ai (model adapter), pi-mcp (MCP client), zod |
| Frontend | React 19, Vite 8, TanStack Router/Query/Form, assistant-ui 0.15, Tailwind 4, Radix, Hey API client generated from OpenAPI |
| Tooling | uv, pnpm, Ruff, pytest, honcho |

TypeScript is pinned to 5.9 in the frontend because the Hey API generator does not run on TypeScript 7.
