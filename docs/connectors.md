# Connectors

This page describes each connector: how to set it up, what agents can do with it, what stays hidden from them, and its known limits.

Each connector needs an app registered with its provider, except Todoist (which registers its own), Stripe (each user pastes a restricted key) and the Web. Set the client id and secret in `.env`; a connector without them is not offered. Every variable is listed in [`.env.example`](../.env.example).

Callback URLs have the form `{site_url}/api/oauth/<connector>/callback`. Locally, `{site_url}` is `http://localhost:5173`.

After connecting, choose under **Connections** what agents may do with each resource, then add the connection to an agent under **Agents**.

## Permissions

A grant is a connection, a resource kind, a resource and actions. A resource may be `*`, meaning every resource of that kind, including new ones. Where resources nest (folders, sub-teams, a team's channels, a site's projects), a grant covers what is inside, and a block on something inside wins. Every action besides Read also requires Read on the same resource, except Outlook's and Gmail's Send, Gmail's Draft and the Web's Search, which apply to their own kinds, and Stripe's Refund and Credit, which also apply to amounts (a refund or credit also needs Read on the customer).

Each tool also needs the provider scopes behind it, and a tool whose scopes the connection lacks is not offered. Where a section below says so, Minerva asks the provider for read access first and for write scopes once the user allows a write action; the connection then says what is missing and offers to ask for it (for example **Allow in Google Calendar**).

For Gmail and the Microsoft connectors, the provider's permission covers everything the account can reach (the whole mailbox, every calendar, file or channel), so the limits within it are Minerva's.

| Connector | Kind (resource id) | Actions | Notes |
|---|---|---|---|
| [Todoist](#todoist) | Project | Read, Create | |
| [Google Calendar](#google-calendar) | Calendar | Read events, Create events | |
| [Google Drive](#google-drive) | File; folders are files | Read files, Create files | |
| [Gmail](#gmail) | Label (label id); Recipient; the connection itself | Label: Read. Recipient: Send. Connection: Draft | Recipients work as for Outlook. |
| [GitHub](#github) | Repository (numeric id) | Read (code, issues, pull requests), Create (open issues, comment) | The id follows a repository through renames and transfers. |
| [Notion](#notion) | Page or database | Read, Comment, Create (pages inside), Edit | A page whose place Notion does not show is blocked by any block on that action. |
| [Linear](#linear) | Team (team id) | Read, Comment, Create, Edit | Tools name teams by key and issues by identifier. |
| [Slack](#slack) | Channel (channel id) | Read, Reply (in threads), Post | Tools take a channel's name or id. |
| [Outlook](#outlook) | Folder (immutable Graph id); Recipient | Folder: Read. Recipient: Send | A recipient is an address or `*@domain` (that domain only, never a public suffix). |
| [Outlook Calendar](#outlook-calendar) | Calendar (Graph id) | Read events, Create events | |
| [OneDrive and SharePoint](#onedrive-and-sharepoint) | File; folders and libraries are files (`{drive id}:{item id}`) | Read files, Create files | Items shared from someone else's OneDrive sit in folders Graph does not show, so any block on that action blocks them. |
| [Microsoft Teams](#microsoft-teams) | Channel; teams are channels' parents (team id, lowercase GUID; channel id `19:…@thread.tacv2`) | Read, Reply (in threads), Post (start threads) | A channel is reached only through the team that hosts it. |
| [Stripe](#stripe) | Customer (customer id); Amount | Customer: Read, Refund, Credit. Amount: Refund, Credit | An amount is a tier per currency: `usd<=50` ("Up to 50.00 USD"), `usd>500` ("More than 500.00 USD") or `usd` (any amount). |
| [HubSpot](#hubspot) | CRM record: `contacts`, `companies`, `deals` and `pipeline:<id>` | Read, Create (contacts and deals), Edit (contacts and deals), Note | Grants are on collections and pipelines only: a merged record answers under another id, but stays in its collection. Deals sit inside their pipeline, inside `deals`. |
| [Jira](#jira) | Project; sites are projects' parents (site: cloud id; project: `<cloud id>/<project id>`) | Read, Comment, Create, Change status | Tools name projects and issues by key; former keys resolve to the issue's current project. |
| [Confluence](#confluence) | Space; sites are spaces' parents (site: cloud id; space: `<cloud id>/<space id>`) | Read, Comment, Create | Tools name spaces by key or id and pages by id; a page is authorized in the space it is in now. |
| [Intercom](#intercom) | Inbox (team id, or `none` for conversations no team is assigned to) | Read, Note, Reply | Tools name conversations by id; a conversation is authorized in the inbox of the team it is assigned to now. |
| [Xero](#xero) | Organisation (tenant id, lowercase GUID) | Read, Draft sales invoices, Draft bills | An organisation's grant covers everything inside it (contacts, invoices, accounts). Calls name one when a connection reaches several. |
| [Sentry](#sentry) | Project (numeric project id) | Read | Tools name projects by id or slug and issues by id or short id; an issue is authorized in its project. |
| [The Web](#the-web) | Site; the connection itself | Site: Read. Connection: Search | Searching sends the query to Brave Search, so it is its own permission. |

## Todoist

Click **Connections → Connect Todoist**.

- **Default:** Minerva registers its own OAuth client with Todoist on first use. There is nothing to configure.
- **Your own app:** set `MINERVA_TODOIST_CLIENT_ID` and `MINERVA_TODOIST_CLIENT_SECRET`. The redirect URL is `http://localhost:5173/api/oauth/todoist/callback`.

After connecting, choose per project what agents may do, then add the connection to an agent under **Agents**.

**Agents can:** read a project's tasks and create tasks in it.

## Google Calendar, Drive and Gmail

Create an OAuth client of type **Web application** in the Google Cloud console, enable the Google Calendar API, the Google Drive API and the Gmail API, and set `MINERVA_GOOGLE_CLIENT_ID` and `MINERVA_GOOGLE_CLIENT_SECRET`. Add the redirect URIs `http://localhost:5173/api/oauth/google_calendar/callback`, `http://localhost:5173/api/oauth/google_drive/callback` and `http://localhost:5173/api/oauth/gmail/callback`. Without the client, none of them is offered.

Click **Connections → Connect Google Calendar** (or Drive, or Gmail), then choose per calendar, per file or folder, or per label what agents may do. Minerva asks Google only for read access at first, and for write scopes once the user allows creating.

### Google Calendar

**Agents can:** list calendars, list and read events, and create events without guests.

### Google Drive

Folders are chosen in a tree. Access to a folder covers everything inside it.

**Agents can:** list folders, search, read file details, read Google Docs, Sheets, Slides and text files as text, and create text files or Google Docs in a folder. Creating files needs full Drive access, because Google's narrower scope cannot add files to folders Minerva did not create.

### Gmail

Gmail's scopes are restricted: until the app is verified by Google, only test users listed on the OAuth consent screen can connect, and their tokens expire after seven days. Gmail asks for `gmail.readonly` at first, `gmail.send` once the user allows sending, and `gmail.compose` once they allow drafts.

Choose per label what agents may read, per address or domain whom they may send mail to, and whether they may save drafts. A label covers the labels nested under it (`Work/Projects` under `Work`). A message with several labels can be read if one of them is allowed, and is hidden if one of them is blocked. Archived mail without labels is covered only by allowing every label.

**Agents can:** list labels, list and search messages, read a message or a conversation as plain text with the names of attachments, send plain-text mail, reply to a message they may read, and save drafts and reply drafts. Every address a message goes to, Cc and Bcc included, needs permission. A reply goes only to the original's Reply-To addresses, or else its sender, and needs permission for each. Drafts need no recipient permission, since the user sends them.

**Hidden or refused:** chats are out of reach, and replies to drafts and to the account's own mail are refused.

**Limits:** no attachments, forwarding, reply-all, labelling, archiving, deleting or sending drafts. Gmail searches the whole mailbox before Minerva filters the results, so an agent can learn whether mail it may not read matches a search, and so test what that mail says without seeing it. A conversation is read from its last 25 messages, readable or not. Bounces arrive later as mail, since Gmail accepts mail before delivering it. An address grant cannot see mailing lists, aliases or forwarding that pass mail on. Labels can change between Minerva's last check and the write.

## GitHub

Create a GitHub App at <https://github.com/settings/apps> and set `MINERVA_GITHUB_CLIENT_ID`, `MINERVA_GITHUB_CLIENT_SECRET` and `MINERVA_GITHUB_APP_SLUG` (the App's URL name, `github.com/apps/<slug>`). The callback URL is `http://localhost:5173/api/oauth/github/callback`; keep user authorization tokens expiring. Give it the repository permissions Metadata (read), Contents (read), Issues (read and write) and Pull requests (read and write). Without the client, GitHub is not offered.

Click **Connections → Connect GitHub**, install the App on the repositories Minerva may see (the connection card links there), then choose per repository what agents may do.

**Agents can:** list repositories, read a repository's details, list and read issues and pull requests (with comments and diffs, truncated), read text files and list directories, open issues with a title and text only, and comment on issues and pull requests.

**Limits:** a listing still returns a continuation token when every repository on a page from GitHub was filtered out, so an agent can tell that hidden repositories exist, but not which.

## Notion

Create a public integration at <https://www.notion.so/profile/integrations> and set `MINERVA_NOTION_CLIENT_ID` and `MINERVA_NOTION_CLIENT_SECRET`. The redirect URL is `http://localhost:5173/api/oauth/notion/callback`. Give it the capabilities Read content, Update content, Insert content, Read comments and Insert comments, and no user information. Without the client, Notion is not offered.

Click **Connections → Connect Notion** and choose in Notion which pages Minerva may reach. Then choose per page or database what agents may do: read, comment, create pages inside it, and edit it. Each covers the pages inside.

**Agents can:** search, read page details and page text, read and query databases, list and add comments, create pages and database rows, set a page's plain properties, replace text on a page and append to it.

**Hidden or refused:** titles of pages agents cannot read that appear as links or mentions, synced content from other pages, and rollup, formula and file properties are hidden. Written text may not create child pages, embed content from other sites, or mention people.

**Limits:** pages are not moved, archived or deleted. Notion automations that react to an agent's change are outside Minerva's control. A listing or search whose page from Notion was filtered out entirely still returns a continuation token, so an agent can learn that hidden pages match a search, but not which. Relations and people beyond Notion's 25 per page are marked but not listed.

## Linear

Create an OAuth application at <https://linear.app/settings/api/applications> and set `MINERVA_LINEAR_CLIENT_ID` and `MINERVA_LINEAR_CLIENT_SECRET`. The callback URL is `http://localhost:5173/api/oauth/linear/callback`. Leave webhooks off. Without the client, Linear is not offered.

Click **Connections → Connect Linear**, then choose per team what agents may do: read issues, comment, create issues, and edit issues. Each covers the team's sub-teams. Minerva asks Linear only for read access at first, and for the write scopes an action needs once the user allows it.

**Agents can:** list teams, read a team's statuses, labels and members, list a team's issues and search their titles, read an issue with its sub-issues and comments, create issues, comment and reply, and change an issue's title, description, status, priority, labels, assignee and due date.

**Hidden or refused:** titles of other issues, projects and documents in links are hidden, and a parent or sub-issue in another team shows only that it exists. Written text may link to Linear only with addresses of issues in the same team, since Linear turns links into mentions shown on the linked issue. A status change is refused when Linear could then close or reopen issues in other teams on its own.

**Limits:** no tools for projects, cycles, documents, attachments or moving issues between teams, and issues cannot be deleted or archived. Issue identifiers and people written as plain text stay text, but Linear may still link them. Linear's other automations (triage rules, integrations) are outside Minerva's control. A team or sub-issue the connected account cannot see at all is invisible to the checks (a hidden parent issue in another team, for example). Linear can change an issue between Minerva's last check and the write.

## Slack

Create an app at <https://api.slack.com/apps> (**From scratch**) in your own workspace and set `MINERVA_SLACK_CLIENT_ID` and `MINERVA_SLACK_CLIENT_SECRET` from **Basic Information**. Under **OAuth & Permissions**, add the redirect URL `{site_url}/api/oauth/slack/callback` and the bot token scopes `channels:read`, `groups:read`, `channels:history`, `groups:history`, `users:read` and `chat:write`. Leave PKCE off (Slack treats an app that uses it as a public client). Token rotation is optional. Without the client, Slack is not offered.

Slack accepts only HTTPS redirect URLs, so locally the dev server needs an HTTPS tunnel (for example `cloudflared tunnel --url http://localhost:5173`). Set `MINERVA_SITE_URL` and `MINERVA_CSRF_TRUSTED_ORIGINS` to the tunnel's address, add its host to `MINERVA_ALLOWED_HOSTS`, start Vite with `__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=<host>`, and open Minerva through the tunnel. Keep the app unlisted and installed only in your own workspace: Slack rate limits apps distributed outside its Marketplace much more strictly.

Click **Connections → Connect Slack**, then choose per channel what agents may do: read messages, reply in threads, and post to the channel. In Slack, add the app to each channel it should reach (`/invite @<app name>`); Minerva sees no other channels. Minerva asks Slack for `chat:write` only once the user allows replying or posting.

**Agents can:** list the channels they may read, read a channel's messages (newest first, between two times) and a thread, reply in a thread, and post.

**Hidden or refused:** names of channels in links and topics, attachments (link previews and messages shared from other channels) and file contents are hidden. Written text is shown literally, so it cannot mention people or notify a channel (`@channel`, `@here`), and it may not link to Slack, since Slack would show the linked message. Posting to channels shared with other organizations is refused. Direct messages are out of reach.

**Limits:** no search, reactions, edits or deletes. People mentioned by name in plain text stay text. Who joins a channel after it was granted, and Slack workflows or other apps that react to a post, are outside Minerva's control. A channel resolved by name scans at most 2,000 channels.

## Outlook

Register an app in the Microsoft Entra admin center (<https://entra.microsoft.com>, **App registrations → New registration**) and set `MINERVA_MICROSOFT_CLIENT_ID` (the Application (client) ID) and `MINERVA_MICROSOFT_CLIENT_SECRET` (a secret's value from **Certificates & secrets**). Choose **Accounts in any organizational directory and personal Microsoft accounts**, and add a **Web** redirect URI `{site_url}/api/oauth/outlook/callback` (for example `http://localhost:5173/api/oauth/outlook/callback`). Under **API permissions**, add the Microsoft Graph delegated permissions `offline_access`, `User.Read`, `Mail.Read` and `Mail.Send`. Some organizations let only an administrator consent to mail permissions; there, an admin must grant consent for the tenant. Without the client, Outlook is not offered.

Click **Connections → Connect Outlook**, then choose per folder what agents may read, and which addresses or domains they may send mail to. Access to a folder covers its subfolders. Minerva asks Microsoft only for read access at first, and for `Mail.Send` once the user allows sending.

**Agents can:** list folders, list a folder's messages (filtered by unread and received time, or searched), read a message as plain text with the names of its attachments, send plain-text mail, and reply to a message they may read. Recipients are checked as in [Gmail](#gmail), replies included.

**Hidden or refused:** search folders, hidden folders and Exchange's system folders are out of reach. Replies to drafts and to the account's own mail are refused.

**Limits:** no drafts, attachments, forwarding, reply-all, moving, deleting or flagging, and no shared or delegated mailboxes. As in Gmail, bounces arrive later as mail, and an address grant cannot see distribution lists, aliases or forwarding rules that pass mail on. Mail can move between Minerva's last check and the write. Mail sent from an alias Graph does not report (personal accounts may report none) or as another mailbox (Send As) is not recognized as the account's own, so a reply to it is refused only when it sits in Sent Items.

## Outlook Calendar

Outlook Calendar uses the Entra app from [Outlook](#outlook). Add a second **Web** redirect URI, `{site_url}/api/oauth/outlook_calendar/callback`, and the delegated permissions `Calendars.Read` and `Calendars.ReadWrite`.

Click **Connections → Connect Outlook Calendar**, then choose per calendar (or for all calendars) whether agents may read events and create them. Calendars others shared with the account are listed too. Minerva asks Microsoft only for `Calendars.Read` at first, and for `Calendars.ReadWrite` once the user allows creating events.

**Agents can:** list calendars, list one calendar's events over a window of up to 366 days (recurring events expanded, each event in full), and create events without attendees.

**Limits:** events are read only through a calendar's listing, never by id, since Graph does not show which calendar an event id is in. Events cannot be changed, deleted or answered, and created events have no recurrence or online meeting. Group calendars are not listed. All-day events need the calendar owner's time zone, among the IANA names Graph accepts. Graph reports all-day events at midnight UTC without the owner's zone, and is reported to give calendars ahead of UTC the day before; listed all-day dates are not checked against a live account yet.

## OneDrive and SharePoint

OneDrive and SharePoint use the Entra app from [Outlook](#outlook). Add another **Web** redirect URI, `{site_url}/api/oauth/onedrive/callback`, and the delegated permissions `Files.Read.All`, `Sites.Read.All` and `Files.ReadWrite.All`.

Click **Connections → Connect OneDrive and SharePoint**, then choose per library, folder or file (or for everything) whether agents may read files and create them. The choices offered are the account's own OneDrive and the document libraries of the SharePoint sites it follows; searching finds folders and files anywhere the account can open, shared ones included. Access to a folder or library covers everything inside it. Minerva asks Microsoft for read access at first (`Sites.Read.All` lists followed sites), and for `Files.ReadWrite.All` once the user allows creating files.

**Agents can:** list the account's OneDrive and the libraries of the SharePoint sites it follows, list a folder, search files (Microsoft Search for work and school accounts), read a file's details, read the text of Word, PowerPoint, Excel (first sheet, as CSV) and text files, and create text files without replacing existing ones.

**Limits:** no PDFs, images, legacy Office formats (.doc, .xls, .ppt) or OneNote. Excel is read as stored values (no formulas evaluated, dates as numbers). Office files are unpacked in Minerva's own process, under size and entry limits rather than isolation. Files cannot be replaced, edited, moved, renamed, shared or deleted. SharePoint sites cannot be granted as a whole, and libraries of sites the account does not follow are reached only through search or a folder's id. Microsoft Search sees everything the account can open before Minerva filters the results, so a short page tells an agent that hidden files match. An item can move between Minerva's last check and the call. Not checked against a live account yet: download hosts, paging tokens and the Search API's answers.

## Microsoft Teams

Microsoft Teams uses the Entra app from [Outlook](#outlook). Add another **Web** redirect URI, `{site_url}/api/oauth/teams/callback`, and the delegated permissions `Team.ReadBasic.All`, `Channel.ReadBasic.All`, `ChannelMessage.Read.All` and `ChannelMessage.Send`. `ChannelMessage.Read.All` needs a tenant administrator's consent (**Grant admin consent** on the app's **API permissions** page, in each organization whose users connect); without it, users can list teams and channels and post, but agents cannot read messages. Only work and school accounts can connect.

Click **Connections → Connect Microsoft Teams**, then choose per team or channel (or for everything) whether agents may read messages, reply in threads, and start threads. Access to a team covers all its channels, including private channels the account is in and channels added later. Agents post as the signed-in user. Minerva asks Microsoft for the permissions to list teams and channels at first, and for `ChannelMessage.Read.All` and `ChannelMessage.Send` once the user allows reading and writing.

**Agents can:** list teams and channels, read a channel's messages and a thread, start a thread, and reply in one.

**Hidden or refused:** mentions of channels and teams, links and addresses to Teams, and file contents are hidden, and quotes (a person's own included), cards and forwarded messages are left out rather than filtered. Written text is shown literally, so it cannot mention anyone or format, and it may not link to Teams. Posting to shared channels is refused. Chats and meetings are out of reach.

**Limits:** no files, reactions, edits or deletions, and importance is never set. Refusing shared channels limits the kind of channel, not who reads it: standard and private channels can have guests. Only joined teams are offered and named (at most 100), so a shared channel's host team that the account is not in cannot be chosen. A channel can change between Minerva's last check and the write. Not checked against a live account yet: paging tokens, whether a team's channel listing includes the shared channels it hosts, and how posted HTML is shown.

## Stripe

Stripe connects with a restricted key, which each user creates; no operator setup is needed. In the Stripe Dashboard, open **Developers → API keys → Create restricted key** and give it only these permissions: **Customers: Write** (read customers and add balance credits), **Charges: Read**, **Refunds: Write**, **Invoices: Read** and **Subscriptions: Read**. Minerva also reads the account (`GET /v1/account`) to name the connection; if Stripe refuses that, also allow reading the account's details. Secret keys (`sk_`) are refused, since they can do anything in the account. A test key and a live key of one account are two connections.

Click **Connections → Stripe**, paste the key (it is checked with Stripe, stored encrypted and never shown again), then choose per customer (or for every customer) what agents may do: read, refund payments, and credit balances. Each refund or credit also needs its amount allowed: "Up to" a limit in a currency, or the whole currency. A workspace ceiling can deny "More than" a limit. **Replace key** swaps in a new key for the same account.

**Agents can:** list and read customers, list payments (with what is left to refund), invoices and subscriptions, refund part or all of a payment, and add credit to a customer's balance. A customer covers their payments, invoices and subscriptions; payments without a customer are covered only by allowing every customer. A refund is checked against the payment just before it is sent: the currency must match, the payment must have succeeded and not be disputed, and the amount must not exceed what is left.

**Limits:** there are no tools for creating charges, invoices or subscriptions, cancelling subscriptions, disputes, payouts or Stripe Connect accounts. Amount limits apply to each refund or credit on its own: Minerva keeps no budget across calls, so a cap does not bound how many a run makes, and separate runs add up. Listings are filtered after Stripe has listed them, so a page can hold fewer objects than asked for. A lookup of customers by email returns only its first page, so it does not hint at hidden customers with the address. Customer search in the settings page uses Stripe's search, which can lag new customers by about a minute. A key's own Stripe permissions are not read, so a missing one shows up as a refused call.

## HubSpot

Create a public app on HubSpot's developer platform: with the HubSpot CLI, run `hs project create` (an app with OAuth authentication and marketplace distribution), then in `app-hsmeta.json` set `auth.redirectUrls` to `{site_url}/api/oauth/hubspot/callback` (for example `http://localhost:5173/api/oauth/hubspot/callback`) and `auth.requiredScopes` to `oauth`, `crm.objects.contacts.read`, `crm.objects.contacts.write`, `crm.objects.companies.read`, `crm.objects.deals.read` and `crm.objects.deals.write`, with no optional scopes. Run `hs project upload`, and set `MINERVA_HUBSPOT_CLIENT_ID` and `MINERVA_HUBSPOT_CLIENT_SECRET` from the app's **Auth** page. The app does not need to be listed in HubSpot's marketplace. Without the client, HubSpot is not offered.

Click **Connections → Connect HubSpot**; only a Super Admin of the HubSpot account (or a user with Marketplace Access) can install the app. Then choose what agents may do with all contacts, all companies, all deals, or the deals of one pipeline: read, create contacts and deals, edit them, and log notes. Companies are never created or edited, but notes can be logged on them. HubSpot gives the app the same access whoever installed it, so Minerva's grants are the only limit within those scopes.

**Agents can:** search contacts, companies and deals (by words, exact email address or domain, pipeline and stage, or the records they are associated with), read one, list deal pipelines with their stages, create and edit contacts, create deals (associated with contacts and companies they may read), change a deal's name, stage, amount and close date within its pipeline, and log plain-text notes on a contact, company or deal. Searching by association needs Read on both sides.

**Hidden or refused:** a deal that moved to another pipeline since it was checked is refused.

**Limits:** no tickets, tasks, emails, calls, meetings, owners, custom objects, reading notes, deleting, merging or moving deals between pipelines. HubSpot's automations (workflows, creating companies from contacts' email domains) may act on what an agent changes. Search lags behind changes by a few seconds and stops at 10,000 results, which are then marked incomplete. HubSpot pages results before Minerva filters them, so searching deals by anything but their pipeline needs Read on all deals; a block on one pipeline then hides its deals, but where allowed deals land can still tell that hidden ones match. An unnarrowed search still pages when every deal on a page was filtered out, so an agent can learn that hidden deals exist, but not which. A deal can change between Minerva's last check and the write.

## Jira

Create an **OAuth 2.0 integration** in the Atlassian developer console (<https://developer.atlassian.com/console/myapps/>). Under **Permissions**, add the **User identity API** with `read:me`, and the **Jira API** with the classic scopes `read:jira-work` and `write:jira-work`. Under **Authorization**, set the callback URL to `{site_url}/api/oauth/jira/callback` (for example `http://localhost:5173/api/oauth/jira/callback`). Atlassian allows one callback URL per app, so Jira needs an app of its own. Set `MINERVA_JIRA_CLIENT_ID` and `MINERVA_JIRA_CLIENT_SECRET` from **Settings**. The app works for its developer at once; to let others connect, open **Distribution** and share it. Without the client, Jira is not offered.

Click **Connections → Connect Jira** and pick the sites to allow on Atlassian's consent screen. Then choose per site or per project what agents may do: read issues, comment, create issues and change their status. Agents act as you: watchers are notified, and a project's automation rules may act on what they change, in that project or others.

**Agents can:** list projects, search one project's issues (by words in the summary, status category and assignment to themselves; fields, never JQL), read an issue with its latest comments and the related issues in the same project, comment, create issues of a named type, and move an issue through its workflow.

**Hidden or refused:** titles behind links to Atlassian, macro content, and related issues in other projects beyond their number are hidden. Written text is plain, without mentions, formatting or links to Atlassian. An issue that moved to another project since it was checked is refused.

**Limits:** no attachments, worklogs, sprints, boards, edits of fields, assignment, deletion or issue links. Issues are created with a type, summary and description only, so projects that require other fields refuse them, as Jira does transitions that require fields. While Jira's search index lags behind a move (seconds), an issue moved out of a project can still make a page of results empty but continued, telling an agent that a hidden issue matched. An issue can move between Minerva's last check and the write. Not checked against a live account yet: paging tokens, whether bulk fetches leave out issues the account cannot see, and the shape of the issue type listing.

## Confluence

Create another **OAuth 2.0 integration** in the Atlassian developer console (<https://developer.atlassian.com/console/myapps/>); Atlassian allows one callback URL per app, so Confluence cannot share Jira's. Under **Permissions**, add the **User identity API** with `read:me`, and the **Confluence API** with the granular scopes `read:space:confluence`, `read:page:confluence`, `read:comment:confluence`, `read:content-details:confluence`, `write:comment:confluence` and `write:page:confluence`. Under **Authorization**, set the callback URL to `{site_url}/api/oauth/confluence/callback`. Set `MINERVA_CONFLUENCE_CLIENT_ID` and `MINERVA_CONFLUENCE_CLIENT_SECRET` from **Settings**, and open **Distribution** to let others connect. Without the client, Confluence is not offered.

Click **Connections → Connect Confluence** and pick the sites to allow on Atlassian's consent screen. Then choose per site or per space what agents may do: read pages, comment on them and create them. Agents act as you: watchers are notified, and a space's automation rules may act on what they change.

**Agents can:** list spaces, search one space's pages by words in the title (fields, never CQL), read a page with its body, its parent (when in the same space) and its latest top-level footer comments, comment at the foot of a page, and create a page at the top of a space or under a page in it.

**Hidden or refused:** titles behind links to Atlassian and macro content are hidden. Written text is plain, without mentions, formatting or links to Atlassian. A page that moved to another space since it was checked is refused.

**Limits:** pages cannot be edited, moved, archived or deleted. Blog posts, attachments, labels, inline comments and comment replies are neither read nor written, and child pages are not listed. While Confluence's search index lags behind a move, a page moved out of a space can still make a page of results short or empty but continued, telling an agent that a hidden page matched. A page can move between Minerva's last check and the write. Not checked against a live account yet: scopes, paging tokens, CQL and the shape of bodies and comments.

## Intercom

Create an app in Intercom's Developer Hub (<https://app.intercom.com/a/apps/_/developer-hub>). Under **Authentication**, turn on **Use OAuth**, add the redirect URL `{site_url}/api/oauth/intercom/callback`, and give the permissions **Read admins**, **Read conversations** and **Write conversations**. Set `MINERVA_INTERCOM_CLIENT_ID` and `MINERVA_INTERCOM_CLIENT_SECRET` from **Basic information**. The app works in its own workspace at once; other workspaces can install it only once Intercom has reviewed it. Without the client, Intercom is not offered. Intercom accepts only HTTPS redirect URLs, so locally Minerva needs an HTTPS tunnel, set up as for [Slack](#slack).

Click **Connections → Connect Intercom** and authorize the app for your workspace. Then choose per team inbox, or for conversations no team is assigned to, what agents may do: read conversations, add internal notes and reply to customers. Agents act as you; replies reach the customer by email or the Messenger. Conversations move between inboxes when they are reassigned, so one reassigned at the moment an agent writes can receive the write. To revoke access, remove the app from the workspace in Intercom's app settings.

**Agents can:** list inboxes, search one inbox's conversations (by state, update time and words in the first message), read a conversation with its first message and latest replies and notes, add an internal note, and reply to the customer.

**Hidden or refused:** links to Intercom with their labels, assignments and other events, and the names of teams as authors are hidden. Written text is plain, without formatting, mentions or links to Intercom. A conversation is authorized in the inbox it is in when Minerva reads it, and one reassigned to another inbox since it was checked is refused.

**Limits:** no tickets, contacts, companies, articles, tags, assignment, closing, snoozing or attachments. Search is not sorted. While Intercom's search index lags behind a reassignment, a conversation moved out of an inbox can still make a page of results short or empty but continued, telling an agent that a hidden conversation matched. Intercom matches words against the raw message, link labels hidden from agents included; Minerva drops results whose shown text lacks a word, but the short page that leaves says the same. A conversation too large to read is refused like one the account cannot see. Not checked against a live account yet: region routing through `api.intercom.io`, the token response, the reply's answer (`part_id`), whether tickets appear in search, and the value types search accepts.

## Xero

Create an app at <https://developer.xero.com/app/manage> as a **Web app** (authorization code flow), with the redirect URI `{site_url}/api/oauth/xero/callback`. Xero takes HTTPS redirect URIs, and `http://localhost` ones for testing. Set `MINERVA_XERO_CLIENT_ID` and `MINERVA_XERO_CLIENT_SECRET` from the app's **Configuration** page. Minerva asks for Xero's granular scopes: `accounting.invoices.read`, `accounting.contacts.read` and `accounting.settings.read` to read, and `accounting.invoices` once you allow drafting. Without the client, Xero is not offered.

Click **Connections → Connect Xero**, sign in and pick the organisations Minerva may reach. Then choose per organisation (or for all of them, including ones added later) what agents may do: read invoices, bills and contacts, create draft sales invoices, and create draft bills. Drafts are never sent, approved or paid: a person approves them in Xero. To add an organisation, connect again and pick it; to remove one, disconnect it in Xero under **Settings → Connected apps**. Your role in each organisation still applies, and Xero refuses what it does not allow.

**Agents can:** list organisations, search contacts (by name, number or email), search invoices and bills (by type, status, contact, date and number or reference), read an invoice with its lines and payments, and list the active accounts and tax rates. Drafts are created with status DRAFT only, for an active contact named by id; agents cannot void or change invoices.

**Hidden or refused:** bank account numbers and contacts' bank details are hidden.

**Limits:** no credit notes, quotes, purchase orders, payments, contacts or attachments are written. A draft is not deduplicated across runs, so an agent asked twice creates two. Search pages by page number, so invoices added or changed while paging can be skipped or repeated. Contact balances name no currency (Xero's documentation disagrees on whether they are converted to the organisation's base currency). An invoice shows at most 200 lines and 50 payments, with counts. Not checked against a live account yet: userinfo fields, Basic client authentication with PKCE, validation errors, `where` filters, invoice paging and `summaryOnly`, the create-invoice answer and a missing contact's 404.

## Sentry

Create an OAuth application on sentry.io under **Settings → Account → API → Applications** (<https://sentry.io/settings/account/api/applications/>), with the redirect URI `{site_url}/api/oauth/sentry/callback`. Set `MINERVA_SENTRY_CLIENT_ID` and `MINERVA_SENTRY_CLIENT_SECRET` from the application's page. Minerva asks for `org:read`, `project:read` and `event:read`, and only reads. Only sentry.io is supported, not self-hosted Sentry. Without the client, Sentry is not offered.

Click **Connections → Connect Sentry** and pick the organisation on Sentry's consent screen; a connection reaches that one organisation, so connect again for another. Then choose per project (or for all of them, including ones added later) whether agents may read its issues and events. Your team memberships still apply: Sentry shows only the projects you can see. To revoke access, remove the application under **Settings → Account → API → Authorized Applications**.

**Agents can:** list projects, search one project's issues (by status, level, environment, period and one phrase; fields, never Sentry's query syntax), read an issue by id or short id, and read one of its events: the exceptions with their innermost stack frames and the source lines around them, an allowlist of tags, the release, environment, runtime, OS and browser, and the request's method and address without its query.

**Hidden or refused:** local variables, request headers, cookies and bodies, the user, breadcrumbs, other tags, and an issue's comments and activity are hidden.

**Limits:** no resolving, assigning, commenting or muting. An event shows exception stack traces only, not threads or a plain stack trace, and at most 10 exceptions of 40 frames each. Messages, exception values, source lines, transaction names and request paths are shown as your application sent them, and can carry whatever it put there, links to other issues included. Not checked against a live account yet: the undocumented `/api/0/auth/` endpoint, region routing, the organisation list, cursors, the `is:archived` filter, quoted phrases, id types, stack frame fields and token refresh.

## The Web

Click **Connections → Add Web**, then choose which sites agents may read and whether they may search. A site is an exact host (`docs.python.org`) or a domain with its subdomains (`*.python.org`). Patterns stop at the registrable domain (per the Public Suffix List), so `*.org`, `*.co.uk` and `*.github.io` cannot be granted; only `*` allows every site. A block on a domain wins over access to a wider one. Opening an address sends whatever is in it to that site, so the sites an agent may read are also where it could carry data.

Searching uses Brave Search. Set `MINERVA_BRAVE_SEARCH_API_KEY` to a key from <https://brave.com/search/api/>. Without it, agents can only read pages.

**Agents can:** search the web through Brave Search (titles, addresses and snippets only) and read pages as text.

**Fetching:** Minerva fetches pages itself. It checks the site before resolving it, refuses IP addresses and special-use names (`localhost`, `.internal`, `.local`, `.onion`), requires every resolved address to be public, and connects to the checked address with the site's name for TLS, so DNS rebinding cannot redirect the request. Redirects are followed only on the same host and never from https to http; others go back to the agent, which needs permission for the new site. Pages are capped at 3 MB (also after decompression) and 25 seconds, no cookies or credentials are sent, and HTML is reduced to text without scripts, frames or images (images keep their alt text). Page text is still untrusted: reducing HTML does not neutralize prompt injection.

**Limits:** there is no cap on searches per run or workspace, and each search costs the operator money. Deployments have no egress rules for the gateway yet; only the fetcher's own checks refuse private addresses. Continuing a long page fetches it again.
