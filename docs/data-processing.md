# Where Minerva processes data

This page lists every place that Minerva's data goes: the Laravel application (`minervacomputing/app` on Laravel Cloud), the engine in this repository (`cloudflare/`), and the vendors behind both. For each one it says what data reaches it, where that data is processed and stored, and whether an EU-only option exists and is used. It ends with what Minerva may promise about EU processing today (ARCHITECTURE.md, The engine and the product), what blocks a stronger promise, and how Laravel's backups keep the restore window.

Each claim carries its basis:

- **Vendor.** The vendor's own documentation says so. The row links the page.
- **Measured.** Read from Minerva's code, its configuration, or the accounts (`cf`, `cloud`). No identifier read from an account is copied here.
- **Inference.** My conclusion from the vendor's documents and the code. No vendor states it.

## Summary

Stored in the EU, by a vendor's guarantee or by region choice:

- Laravel's compute and database run in AWS `eu-central-1` (Frankfurt). The database is Neon, through Laravel Cloud.
- The engine's Durable Objects (`Conversation`, `Sandbox`, `Scripts`) of every Laravel conversation run and store in Cloudflare's EU jurisdiction.
- Files (attachments, staged uploads, checkpoint blobs) are stored in the R2 bucket `minerva-cf-files-eu`, in R2's EU jurisdiction. The browser reaches it on the bucket's EU endpoint.

Not EU-only:

- **The model.** OpenAI processes every turn under a global project with no processing constraint, and keeps abuse-monitoring logs up to 30 days.
- **The sandbox.** The container that runs the agent's commands has no placement constraint. It starts where a free instance is, which can be outside the EU.
- **The edge.** Cloudflare decrypts every request at the data center nearest the caller, worldwide, both for Laravel Cloud's edge and for the engine's Worker.
- **Web pages.** Every page an agent opens goes to Cloudflare Browser Run, which renders it close to the incoming request with no location guarantee, so possibly outside the EU, also for an EU workspace's conversation. The owner accepted this.
- **Operational data.** Workers Logs, container logs, Laravel Cloud's logs and AI Gateway's processing have no documented location. Durable Object ids are logged outside the jurisdiction. Resend stores mail metadata in the US. The recovery index in D1 has a location hint, not the EU jurisdiction.

Not in use (measured): Nightwatch (no token on either environment), social sign-in (production has no provider clients; staging offers Google, GitHub and Microsoft, and no account has signed in with one), and Workers AI and Anthropic (staging and production run OpenAI). Stripe runs only on staging, in a sandbox in test mode, so no real payment; production has no Stripe keys yet. Production's Laravel has no engine or R2 settings yet, so only staging sends conversations to an engine.

## Laravel on Laravel Cloud

The application `minerva` runs in `eu-central-1` (measured: `cloud environment:list`, both environments). Laravel Cloud's own subprocessor list is in its [Trust Center](https://trust.laravel.com/?product=cloud), behind its Data Processing Agreement.

| Component | Vendor | What data | Where processed | Where stored | EU option, used? | Source |
|---|---|---|---|---|---|---|
| Web, scheduler and queue workers | Laravel Cloud, on AWS EC2 | Everything Laravel handles: accounts, members, credentials (decrypted in memory), transcripts, usage, uploads' metadata | Frankfurt | Nothing durable (ephemeral disks) | Region choice. Yes, Frankfurt | [Pricing FAQ](https://laravel.com/cloud/pricing) ("dedicated AWS EC2 servers"), [Network](https://laravel.com/cloud/docs/network.md) |
| Edge network | Cloudflare, through Laravel Cloud | Every request and response to Laravel, decrypted at the edge: pages, chat transcripts, form posts, OAuth callbacks | The Cloudflare data center nearest the user, in any of 335 cities | Cached static assets. Responses that set a cookie are not cached, so pages are not (inference from the cache rules) | None documented by Laravel Cloud. No | [Network](https://laravel.com/cloud/docs/network.md) |
| Database | Laravel Serverless Postgres (Neon, on AWS) | Users, organizations, workspaces, members, invitations, stored credentials (encrypted with `MINERVA_CREDENTIALS_KEY`), transcripts built from facts, usage records, the audit log, sessions, the cache table, production's job table | Frankfurt | Frankfurt | Region choice. Yes | [Serverless Postgres](https://laravel.com/cloud/docs/resources/databases/postgres), [Neon regions](https://neon.com/docs/introduction/regions) |
| Point-in-time backups | Neon, through Laravel Cloud | The whole database | Frankfurt (inference: a Neon project lives in one region) | Retention 7 days on both clusters (measured: `cloud database-cluster:list`) | Same region. Yes | [Backup strategies](https://laravel.com/blog/creating-backup-strategies-in-serverless-postgres-with-laravel-cloud) |
| Managed queue (staging) | Laravel Cloud, on Amazon SQS | Job payloads: `SendStart`, `SendCancel`, `SendDeletion` and `CancelNarrowed` carry one id each (measured: `app/Jobs/`). Mail is sent without the queue | The environment's region | SQS keeps a message at most 14 days | Region. Yes. Production uses the database queue instead (measured) | [Managed queues](https://laravel.com/cloud/docs/queues.md) |
| Logs | Laravel Cloud | Application logs (errors with stack traces) and access logs | Not documented | Not documented. Kept 1, 7 or 30 days by plan | None documented. No | [Logs](https://laravel.com/cloud/docs/logs.md), [Pricing](https://laravel.com/cloud/pricing) |
| Mail | Resend, attached through Laravel Cloud's integration | Recipients' addresses and names, and the messages: verification, password reset, invitations, whose links carry tokens | Sent from `eu-west-1` (Ireland): the sending domain is verified there (measured: `cloud resend:domains`) | "All account data, including email metadata, logs, and API records" in the United States (vendor) | EU sending region, used. EU storage not offered | [Resend regions](https://www.resend.com/docs/dashboard/domains/regions.md) |
| Monitoring | Laravel Nightwatch | When on: requests, queries, jobs, exceptions, and by default each user's id, name and email. Payloads only if `NIGHTWATCH_CAPTURE_REQUEST_PAYLOAD` is set. Minerva redacts credential URLs and API keys (`AppServiceProvider`) | Not documented | US, EU or Australia, chosen when the Nightwatch application is created. 90 days | EU region exists. Off: neither environment has `NIGHTWATCH_TOKEN` (measured) | [Nightwatch FAQ](https://nightwatch.laravel.com/docs/guides/faqs.md), [User details](https://nightwatch.laravel.com/docs/user) |
| Social sign-in | Google, GitHub, Microsoft through Socialite | The user's address and profile from their own account | The provider's | The provider's | Not applicable. Staging only: its clients are Laravel Cloud secrets, and no account is linked. Production has none (measured with `cloud environment-secret:list`) | `config/services.php` |
| Leaked-password check | Have I Been Pwned (Pwned Passwords) | In production, `Password::uncompromised()` sends the first five characters of the password's SHA-1 hash, never the password | The service's | Not documented | Not applicable. Used in production | [Validating passwords](https://laravel.com/docs/validation#validating-passwords) |
| Billing (staging only, a sandbox in test mode) | Stripe: Stripe Payments Europe, Limited (Ireland), contracting for accounts outside the US, with Stripe, Inc. and Stripe, LLC (US) | A team's name and id, the billing email the buyer enters in Checkout (or sets in the portal), the legal business name, billing address and VAT number the buyer enters, card details entered on Stripe's pages only, invoices, payments and the subscription's seats. No transcript, file or usage | Stripe's infrastructure, in the US among other places | Stripe's infrastructure, in the US among other places | None | Stripe's [Data Processing Agreement](https://stripe.com/legal/dpa) and its [service providers](https://stripe.com/legal/service-providers), the app's `docs/architecture/billing.md` |

Stripe is a processor for its payment and billing services, and an independent controller for fraud prevention and its legal duties. Transfers to Stripe, LLC rely on Stripe's Data Transfer Addendum and the Data Privacy Framework, the Swiss-US one included. The app sends Stripe no conversation data. Laravel's database keeps the billing email on the organization, for its Billing page, until the organization's row is purged. A member's account deletion does not reach the billing email at Stripe: it is the business's billing contact, which its admins change in the portal, and it is on invoices kept 10 years. The contracting entity is confirmed when production is set up (the app's billing.md, Owner steps, step 1).

## The engine on Cloudflare

Every Laravel conversation is created in the EU jurisdiction, and `src/addressing.ts` puts its three Durable Objects and its files there (measured). The account has no Data Localization Suite: it is an "Enterprise-only paid add-on" ([Data Localization Suite](https://developers.cloudflare.com/data-localization/)).

| Component | Vendor | What data | Where processed | Where stored | EU option, used? | Source |
|---|---|---|---|---|---|---|
| The Worker (`/internal/v1/`, `/stream/v1`) | Cloudflare Workers | Every command and answer: the user's message and attachments' keys in a start, compiled grants, leased credentials for one provider call, facts with transcript text, stream events | The data center that receives the request. Laravel's calls likely enter near Frankfurt (inference). A browser's stream enters nearest the user, anywhere | Nothing (stateless) | Regional Services (Data Localization Suite). No | [Product compatibility](https://developers.cloudflare.com/data-localization/compatibility/) |
| Access in front of `/internal/` | Cloudflare Access | Request metadata and the service token's client id | Global. "Access JWT is not yet localized" | Access logs. Customer Metadata Boundary exists for Access (Enterprise) | No | [Product compatibility](https://developers.cloudflare.com/data-localization/compatibility/) |
| `Conversation`, `Sandbox` and `Scripts` objects | Cloudflare Durable Objects | Runs, attempts, run events, pi's conversation (the whole conversation, tool results included; compacted for the model, every entry kept until deletion), facts until acknowledged, folder manifests, the write ledger, preparations, call and script records | EU | EU. Point-in-time recovery covers the past 30 days; its location is not documented | EU jurisdiction. Yes. "A DurableObjectId will be logged outside of the specified jurisdiction for billing and debugging purposes" | [Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/), [SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) |
| Script guests | Cloudflare Worker Loader (Dynamic Workers) | The script the model writes and the tool results it reads | Not documented (inference: beside the `Scripts` object that loads them) | Nothing | None documented | `src/scripts/scripts.ts` |
| Recovery index | Cloudflare D1, one database | Conversation, organization, workspace and run ids, each conversation's jurisdiction, fact sequence and deletion times, start input digests. No content | Primary near Frankfurt (location hint `weur`), which "does not guarantee that D1 runs in your preferred location" | The same. Time Travel keeps 30 days of history; its location is not documented | EU jurisdiction exists, set only at creation. No | [D1 data location](https://developers.cloudflare.com/d1/configuration/data-location/), [Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) |
| Files | Cloudflare R2, `minerva-cf-files-eu` | Every file of every kept version, attachments, staged uploads (deleted after a day) | Cloudflare (inference: the EU endpoint "won't access resources outside the EU", but the guarantee is written for storage) | EU: "objects in a bucket are stored within a specific jurisdiction" | EU jurisdiction. Yes. Staging's Laravel signs URLs on the EU endpoint (measured) | [R2 data location](https://developers.cloudflare.com/r2/reference/data-location/) |
| Sandbox | Cloudflare Containers (`durable_object` scheduling, `standard-1`) | The conversation's whole folder in `/workspace`, the agent's commands and their output | Without constraints, "the location nearest to the incoming request with a pre-fetched image". No constraint is set (measured: `cloudflare.config.ts`) | Ephemeral: kept at most 5 minutes after a completed turn for the conversation's next one, then up to 3 more while it retires and archives a large folder for a snapshot (below), and destroyed when the conversation is deleted. Container logs are on; their location is not documented | `constraints.jurisdiction: "eu"`. Whether it applies under `durable_object` scheduling is not documented. No | [Placement](https://developers.cloudflare.com/containers/concepts/placement/), [Containers changelog](https://developers.cloudflare.com/changelog/product/containers/), [FAQ](https://developers.cloudflare.com/containers/faq) |
| Container snapshots | Cloudflare Containers | A retired container's root disk, with an archive of the conversation's folder at one version | Not documented | Not documented. A 30-day lifetime that each restore renews, with no deletion. The engine forgets its record when the conversation is deleted, so nothing restores it again | None documented. Taken when a parked container whose folder holds 300 files or 20 MB retires; the owner accepted the unknown location for EU conversations | [Snapshots](https://developers.cloudflare.com/containers/guides/snapshots/) |
| AI Gateway `minerva-cf` | Cloudflare | Every model request and response: system prompt, history, tool results, images the model reads. It also holds the provider keys (Secrets Store) | Not documented (inference: the data center of the calling `Conversation` object) | No logs: the gateway has `collect_logs` off (checked by every deploy, `scripts/resources.ts`) and each request sends `collectLog: false` | Regional Services not supported. Log storage jurisdiction not supported. Not applicable while logs are off | [Logging](https://developers.cloudflare.com/ai-gateway/observability/logging/), [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/), [Product compatibility](https://developers.cloudflare.com/data-localization/compatibility/) |
| Model (staging and production) | OpenAI, `gpt-6.1-sol` on the Responses API, through the gateway with Minerva's own key | The same as the gateway | A global project on the unprefixed host: "No processing constraint" | `store: false` is forced (`src/model/provider.ts`), so no application state. Abuse-monitoring logs "up to 30 days". Prompt cache entries stay eligible for reuse at least 30 minutes after their last use, and OpenAI may keep them longer (its guide states no deletion time); they are grouped under a key per conversation and not shared across organizations | Europe residency on `eu.api.openai.com` covers `/v1/responses` and `gpt-6.1-sol`, but needs an EU project or the EU host and approval for zero data retention or modified abuse monitoring. No | [Your data](https://developers.openai.com/api/docs/guides/your-data) |
| Model (possible) | Anthropic | The same | `inference_geo` is `global` or `us` only | Workspace geo is `us` only | None. Not configured | [Data residency](https://platform.claude.com/docs/en/manage-claude/data-residency) |
| Model (the build's default) | Cloudflare Workers AI | The same | Not documented. Cloudflare lists CoreWeave (US) and Nebius (England) as Workers AI subprocessors | "Cloudflare does not retain inputs or outputs after they are no longer needed" | Regional Services not supported. Not used on staging or production (measured: their `vars.env`) | [Workers AI privacy](https://developers.cloudflare.com/workers-ai/platform/privacy/), [Cloudflare subprocessors](https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/) |
| Images for the model | Cloudflare Images binding | Image bytes that `read` resizes for the model | Not documented | Not stored | Regional Services only on a custom domain. No | [Product compatibility](https://developers.cloudflare.com/data-localization/compatibility/) |
| Logs | Cloudflare Workers Logs (query strings redacted) | Invocation logs (method and URL), warnings and errors with conversation ids and error messages. An error message can quote a provider's or the model's text (inference) | Not documented | "Data is written to your Cloudflare Account", 7 days | None listed for Workers Logs. No | [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/) |
| Connectors | The user's own providers (GitHub, Google, Microsoft, Slack and the others in `src/connectors/`) | What the user's grants let a run read or write, with the user's leased credential | The provider's | The provider's | Not applicable | `src/connectors/` |
| Web pages | Cloudflare Browser Run (Kitesurf), and the sites it opens | The address an agent opens, with whatever the agent put in it, tokens included; the page and its own host's resources; the session a sign-in link sets and the account pages it shows | "Close to the incoming request", with no location guarantee, so possibly outside the EU | Page content is discarded after the response, and Browser Run's cache is off (`cacheTTL: 0`). How long addresses and request metadata are kept is not documented. The page's text stays in the conversation as the tool result | None. Accepted by the owner | [Kitesurf](https://developers.cloudflare.com/browser-run/kitesurf/), `src/connectors/web/` |

## Subprocessors

These vendors process Minerva's customer data on Minerva's behalf today:

| Subprocessor | Role | Data | Location |
|---|---|---|---|
| Laravel (Laravel Cloud) | Hosts the product: compute, database, queue, logs and edge | All product data | Compute and database in Frankfurt. Edge worldwide. Logs not documented |
| Neon (through Laravel Cloud) | The Postgres database and its backups | All product data at rest | AWS Frankfurt |
| Amazon Web Services (through Laravel Cloud and Neon) | EC2 compute, SQS queue, Neon's infrastructure | All product data | Frankfurt |
| Cloudflare | The engine (Workers, Durable Objects, D1, R2, Containers, AI Gateway, Images, Browser Run, Access, Workers Logs) and Laravel Cloud's edge | Transcripts, files, run state, leased credentials in memory, the pages agents open, logs | EU for Durable Objects and R2. Worldwide or not documented for the rest |
| OpenAI | The model | Each turn's prompts and outputs | Not constrained. Abuse-monitoring logs up to 30 days |
| Resend | Account mail | Addresses, names, messages with links | Sent from Ireland. Metadata and logs stored in the US |
| Stripe (staging's sandbox only, until production's keys are set) | Payments, invoices and subscriptions for teams' seats | Teams' names and ids, billing emails, business names, billing addresses, VAT numbers, card details on Stripe's pages, invoices and payments | The US among other places |

Each vendor names its own subprocessors: Laravel in its [Trust Center](https://trust.laravel.com/?product=cloud), Cloudflare on its [subprocessor page](https://www.cloudflare.com/gdpr/subprocessors/cloudflare-services/) (which lists Google and Oracle for the Developer Platform, with US locations among others, without naming which products), [Neon](https://neon.com/subprocessors), OpenAI, Resend and Stripe ([service providers](https://stripe.com/legal/service-providers)) on theirs.

Not in use, and added to the list when turned on: Laravel Nightwatch (choose the EU region), Anthropic and Workers AI.

Not Minerva's subprocessors, in my reading: the connectors' providers and the sign-in providers, which are the user's own accounts that the user directs Minerva to use, and Have I Been Pwned, which receives no personal data. This is an inference for the owner or counsel to confirm.

## What Minerva may promise today

Minerva promises EU processing only when every component allows it. Today they do not, so Minerva may promise EU storage of its primary data, with the exceptions named. Proposed wording:

> Minerva stores your account, your conversations and your files in the European Union. The application and its database run in Frankfurt on Laravel Cloud (AWS), and the engine keeps each conversation's state and files in Cloudflare's EU jurisdiction. Some processing happens outside the EU. The AI model (OpenAI) processes each turn and may keep it for up to 30 days for abuse monitoring. The sandbox that runs the agent's commands may run outside the EU, and so may Cloudflare's browser, which opens the web pages your agents read. Requests are decrypted at the Cloudflare data center nearest you. Operational records (logs, email delivery records and internal ids) may be stored outside the EU. Our subprocessors are listed at [link].

Minerva must not say "EU data residency", "processed only in the EU" or "your data never leaves the EU".

Two checks belong to the owner before the wording is published: that a data processing agreement is in place with each subprocessor above, and that it covers transfers outside the EU (Cloudflare's, OpenAI's, Laravel's, Resend's and, before production's keys, Stripe's). I have not read those agreements.

## What blocks a stronger promise

Each row is one reason the promise above cannot say "processed in the EU". Removing every row would allow it.

| Blocker | What would remove it | Basis |
|---|---|---|
| OpenAI processes outside the EU | Europe residency: an EU project or the `eu.api.openai.com` host, after OpenAI approves zero data retention or modified abuse monitoring (a sales conversation). Whether AI Gateway can forward to the EU host is not documented; if not, the Worker calls OpenAI directly, which puts the key in the Worker against today's design | Vendor, and inference for the gateway |
| No other model has an EU option | Anthropic offers `global` and `us` only. Workers AI has no region control | Vendor |
| The sandbox can run outside the EU | Set `constraints: { jurisdiction: "eu" }` on the container in `cloudflare.config.ts` (`cf` accepts it), then measure on the test instance where containers start. It is undocumented whether the constraint applies under `durable_object` scheduling, and whether `eu`'s regions (EEUR and WEUR) leave out data centers outside the EU, such as London or Zurich | Vendor for the setting. The two questions are open |
| Container snapshots have no documented location | Cloudflare documents a location or an EU option, or the engine skips snapshots for EU conversations. The owner accepted the risk | Vendor |
| Cloudflare decrypts requests at the nearest data center worldwide | For the engine: Regional Services, an Enterprise add-on. For Laravel: Laravel Cloud documents no such option (its Private Cloud has a dedicated edge, whose regional controls I did not find) | Vendor, and inference for Laravel |
| AI Gateway's processing location is not documented | Cloudflare documents it, or the Worker calls the model directly | Vendor |
| Browser Run renders pages with no location guarantee | Cloudflare documents a location or an EU option for Browser Run. The owner accepted the risk | Vendor |
| The recovery index has a location hint, not the EU jurisdiction | Create a D1 database in the EU jurisdiction (a jurisdiction is set only at creation) and move the index; the deploy and reset scripts and `scripts/instance.ts` change with it. It holds ids, no content | Vendor |
| Logs have no documented location | Workers Logs, container logs and Laravel Cloud's logs: no regional control is documented. Cloudflare's Customer Metadata Boundary is Enterprise-only, and Logpush "doesn't interact with jurisdiction-restricted buckets". Keep logs to ids and codes, and turn invocation logs off if they are not needed | Vendor |
| Durable Object ids and account metadata leave the EU | Cloudflare logs object ids outside the jurisdiction; OpenAI's residency "doesn't cover system data"; dashboards and APIs are global. No self-serve option removes these (inference) | Vendor, and inference |
| Mail metadata is stored in the US | Resend has no EU storage. Another provider with EU storage would remove it | Vendor |
| Telemetry, once turned on | Create the Nightwatch application in the EU region, and send only the user's id with `Nightwatch::user` | Vendor |

## Backups and the restore window

Laravel Cloud's point-in-time backups keep 7 days, the restore window, on staging's and production's clusters.

**Any plan allows it.** Serverless Postgres keeps point-in-time backups for "between 0 and 30 days", set per cluster under the cluster's backup retention ([Backup strategies](https://laravel.com/blog/creating-backup-strategies-in-serverless-postgres-with-laravel-cloud)). The plan limits give database snapshots a 30-day maximum retention on Starter, Growth and Business alike, and name no lower limit for point-in-time backups on any plan ([Pricing](https://laravel.com/cloud/docs/pricing)). So 7 days fits any plan. Backup storage is billed per GB-month.

**Both clusters keep 7 days.** The owner sets a cluster's retention in the dashboard or with `cloud database-cluster:update <cluster> --retention-days=7`, and reads it back with `cloud database-cluster:list`. The plan is Starter. The CLI does not report the plan, so the owner reads it in the dashboard.

The engine's own history is separate, and none of it replaces Laravel's backups:

- Durable Objects' point-in-time recovery covers the past 30 days. Its location is not documented. The engine never rolls an object back (ARCHITECTURE.md, The engine and the product).
- D1's Time Travel covers 30 days on Workers Paid. Its location is not documented.
- R2 keeps no backups. Blobs survive a restore because the engine deletes them only after the 7-day window (ARCHITECTURE.md, Files).

## What public documents do not settle

- Where Workers Logs, container logs, Laravel Cloud's logs, AI Gateway, the Images binding, Durable Objects' recovery log, D1's Time Travel and container snapshots process or store data.
- Whether the container's `jurisdiction` constraint works under `durable_object` scheduling, and which data centers `eu` includes. A test on the test instance can settle the first.
- Whether AI Gateway can forward to `eu.api.openai.com`, and whether OpenAI approves Minerva for Europe residency.
- Laravel Cloud's full subprocessor list. The Trust Center page, as fetched, showed only some names; the owner reads the list in the DPA.
- Whether Laravel Cloud's Private Cloud edge can be limited to EU data centers.
- Cloudflare's product compatibility page marks D1 as not supporting jurisdictions, while D1's own page documents `eu`. D1's page is newer and more specific, so this page follows it.
