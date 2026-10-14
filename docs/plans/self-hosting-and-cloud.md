# Plan: self-hosting and Minerva Cloud

Status: research, 2026-10-13; nothing here is built. This plan takes over step 8 of [cloudflare.md](cloudflare.md) (self-hosting) and adds what Minerva Cloud needs on top of it. The control plane is a Laravel application on Laravel Cloud with Laravel MySQL (decided 2026-10-13, Part 3), replacing cloudflare.md's Python and Django. opencode reviewed a first draft; its findings are folded in.

## Goals

- **Self-hosting.** A company deploys Minerva into its own Cloudflare account with one setup command, with no Python hosting and no database outside Cloudflare.
- **Minerva Cloud.** Shared instances run by the operator, each holding many organizations, and a small control plane for billing and operations. The application logic stays in the instance.

The line between the two is cloudflare.md's (Instance and control plane): what a company running Minerva for itself needs is in the instance; what only selling it to many customers needs is in the control plane. Neither goal needs a change to the architecture. Most of the work is upgrades, recovery and multi-tenant controls, not the control plane.

## Where things stand

- On the `cloudflare` branch, steps 1 to 7 are done, and so are the backend cleanup, the sandbox's move to the Sandbox SDK, plain Better Auth and its fixes, and the frontend cleanup: the API is one oRPC contract (`contract/`) with camelCase fields, the frontend is on TypeScript 7 with type-aware lint rules, and the run events are camelCase (production was reset for it). The first message's design is in [first-message.md](first-message.md). Left from the frontend cleanup: `cloudflare/` and `contract/` have no linter (one oxlint setup for the workspace), `no-deprecated` stays off until the frontend leaves TanStack Query's and assistant-ui's deprecated APIs, and `@typescript/typescript6` stays until `cloudflare/test/unit/sources.test.ts` has another parser. Production `minerva-cf` is deployed and its first admin has claimed it.
- The branch is pushed (2026-10-13) but not merged. `main` is still Django, and `.github/workflows/main.yml` tests Django, builds its images and deploys staging to the VPS.
- Unit 2 (instances by name) is done, 2026-10-14, apart from production's next deploy, which writes its identity row and waits for the owner. A self-hoster today names an instance (`pnpm instances create`, `pnpm secrets`), runs six `cf` commands by hand (`cloudflare/README.md`, First deploy), writes its `vars.env`, and needs a zone on Cloudflare for email: the operator's own sign-up must verify its address by an emailed code before it can claim the instance (`src/accounts/instance.ts`). The zone stays a requirement (unit 3).
- Operator state is per instance, in `~/.config/minerva/instances/<name>/`; its `deployed.json` is a local record for `deploy:files`, not a release history.

## Part 1: self-hosting

One unit per fresh agent, in order. Each ends like the earlier steps: its tests pass, opencode reviews the diff, and it is committed on `cloudflare`.

1. **Freeze the stored formats.** Before an instance outside ours holds data: an inventory of everything stored:
   - D1's tables, Better Auth's included;
   - each Durable Object's tables, including pi's `pi_*` and the Agents SDK's `cf_agents_*` in the Conversation object, which their packages own;
   - stored hashes and tokens: write keys, fingerprints, page tokens, folder digests;
   - alarms and fencing state, R2 keys, the encryption envelope;
   - the Durable Object class names, since a renamed or retired class loses its storage.

   Each entry says who owns it and how it may change. Additive migrations are not enough on their own: two versions run side by side after a deploy, so each version must read what the other writes. Dependency updates (pi-durable, the Agents SDK, Better Auth) are checked against the inventory. After the first release, instances no longer start fresh.
2. **Instances by name** ([instance-names.md](instance-names.md)). Every resource name is derived from the instance's name: both Workers, D1, both buckets, the AI Gateway and the container application. Operator state moves into a directory per instance outside the checkout (secrets, vars, deploy record, account, whether it is a test instance), and the deploy and reset scripts check derived names, the kind and the account instead of literals. The local modes keep fixed names of their own. Our instances keep `minerva-cf` and `minerva-cf-test`.
3. **Email through the operator's zone.** Decided 2026-10-13: a self-hoster's domain must have its DNS on Cloudflare, and the instance sends through Email Sending from a subdomain of it, as ours does. Starting without email, copyable invitation and reset links, and an HTTP email provider are not planned.
   - Sending subdomains belong to a zone, so the instance's directory records the zone. Setup (unit 4) shows the records `cf email-sending subdomains preview` would add (MX, SPF and DKIM on a bounce subdomain, and DMARC), stops on a conflict, creates the subdomain, and waits until `dns status` says it is verified, which can take minutes or, rarely, a day. Until setup exists, the README gives the commands.
   - The deploy of a production build checks that `MINERVA_EMAIL_FROM`'s domain is a verified sending subdomain of that zone, in the instance's account, since the operator's claim waits for an emailed code. The claim is also the first proof that mail arrives. Test builds have no `EMAIL` binding and skip the check.
4. **`pnpm run setup`.**
   - It creates D1 (location hint asked at setup), both buckets with their jurisdiction and lifecycle rules, and the AI Gateway.
   - It creates the Email Sending subdomain in the zone the operator names (unit 3).
   - It writes the instance's directory (unit 2). The workers.dev subdomain is read from the account, or registered when a fresh account has none yet.
   - It applies the migrations, deploys, and prints the URL where the operator claims the instance.
   - A second run creates only what is missing. It refuses an existing resource whose settings differ from what it would create, and never resets anything.

   `make setup` stays the local development setup; `pnpm run setup` is the one that changes an account.
5. **Export and restore.** `pnpm run export` writes one organization's data:
   - its D1 rows, every Workspace and Conversation object's tables (walked from the indexes through a token-gated endpoint, since Durable Objects have no bulk export) and its R2 objects;
   - as a versioned directory of JSON lines and blobs, with checksums, resumable after an interruption.

   A consistent snapshot needs a boundary: the organization is paused for the export (no runs start, changes are refused), or each object exports at a recorded point and the export says which. Credentials are exported as ciphertext, which is bound to its row and decrypts only with the same instance's keys. Moving an organization to another instance therefore means reconnecting its connections, unless import re-encrypts them (open question). `pnpm run restore` into a fresh instance is tested on every release, because a backup that was never restored is not one. D1's Time Travel and the Durable Objects' point-in-time recovery cover mistakes within 30 days in each store, but not a coordinated restore across them.
6. **Releases and upgrades.** Tagged releases with notes. An upgrade is checking out a newer tag and running `pnpm run deploy`.
   - The instance records in D1 the release it runs and the schema steps it has applied. The deploy refuses to downgrade across a schema step or a change of Durable Object classes.
   - A deploy refuses an instance whose reset stopped partway. Today a reset that stops after quiescing leaves the identity row and the old D1, so the next deploy serves the old tables with fresh, empty objects. A reset-in-progress marker in D1, written before quiescing and gone with the recreated database, tells this apart from a first deploy whose migrations failed (found in instance-names 2c's review).
   - Each release's CI deploys the previous release to the test instance, starts runs, deploys the new one while those runs are busy (so busy objects keep the old code), and checks that they finish and that the new code reads what the old one wrote.
7. **Off pre-release tooling.** `cf` 1.0.0-beta.13 and a commit build of `@cloudflare/vite-plugin` move to released versions before the first public release, or the guide pins them and says why. Email Sending is in beta and required (unit 3); the guide says so.
8. **A self-hosting guide and a rehearsal.** `docs/self-hosting.md` covers:
   - requirements: Workers Paid, a domain whose DNS is on Cloudflare, and Node 24, pnpm and Docker on the deploying machine;
   - setup and the claim, the sending subdomain, and backing up the instance's directory;
   - models: Workers AI by default, or OpenAI and Anthropic keys held by the AI Gateway;
   - connectors: each instance registers its own OAuth apps, the largest effort for a self-hoster, so `docs/connectors.md` becomes steps per provider for the instance's callback URLs;
   - upgrades, export and restore, reset, and costs.

   Then someone follows only the guide in a fresh Cloudflare account with only a zone, through a chat turn, an upgrade and a restore. What they had to work out alone goes back into the guide.
9. **CI and staging on Workers**, before the VPS retires. A workflow for the instance keeps every check that exists now:
   - the frontend's `pnpm check`, the Worker's typecheck, unit, platform and Docker tests, and the container's Python tests;
   - `deploy:test`, then `test:faults`, the browser walk and code mode's rows (`test:cm`). `pnpm test:account` alone also probes production, so the workflow names its suites.

   Jobs that change an account run one at a time. The test instance and staging are separate instances: staging is deployed after the tests pass, behind its Access policy. It is verified (sign-in, a turn, a download, a deploy and a rollback) while the VPS still runs.
10. **Merge into `main`.** Only after unit 9's staging works. `cloudflare` merges into `main` with the new workflow. The same push removes `backend/`, `worker/`, `deploy/`'s VPS files, `compose.yaml`, `Procfile` and the Django targets of the Makefile. `make dev`, `make test` and `make seed` call the instance's commands, and `make screenshots` seeds through the Worker. AGENTS.md, README.md and ARCHITECTURE.md describe the instance, with ARCHITECTURE.md taking the design sections of cloudflare.md. The `demo` branch keeps its Django copy and its server. The push publishes the branch, so ask first.

A "Deploy to Cloudflare" button is not possible yet. Its documentation (updated 2026-10-12) lists D1, R2, Durable Objects and Workers AI, but not Containers, and it needs the app self-contained in its directory, while `cloudflare/` builds `../frontend`. Revisit when Containers are listed.

After Part 1, a self-hoster needs a Cloudflare account on Workers Paid ($5 a month plus usage), a domain whose DNS is on Cloudflare, and Node 24, pnpm and Docker on the machine that deploys.

## Part 2: what the instance needs for Minerva Cloud

A cloud instance is an instance with sign-up open and many organizations. Everything here is an instance feature, which a company running Minerva for itself would also want, except the management API.

| Feature | Why the cloud needs it | Self-hosted |
|---|---|---|
| Organizations in the UI: members, invitations, roles, team workspaces | Selling to teams | Wanted |
| Usage records: one durable record per model call, container session and stored byte change, with an id, the organization, and the price version it was charged at; reconciled after crashes (a call counted unmetered, a container that outlived its run) | Billing must not double-count or miss | Cost visibility |
| Quotas per organization: model spend, container time, storage, seats, runs, enforced across the organization's conversations at once (a reservation before a turn, settled after), so concurrent turns cannot overshoot together | A shared instance pays for every tenant's Workers AI and containers | Budgets an admin sets |
| The signed management API: create, suspend and delete organizations, set entitlements, read usage, version and health, emergency stop | The control plane drives the instance | Not needed; off unless its key is set |
| Deleting an organization across D1, its objects and R2, verified | Offboarding, and the law | Wanted |
| The audit log, and the support-access switch an organization controls (cloudflare.md's table) | Operator access must be visible and consented | Wanted |
| Retention: run events, the write ledger, page tokens and pi's state (cloudflare.md's open questions 3 and 5) | Storage grows with every turn | Wanted |
| Email at volume | Email Sending's quotas are per account, start low and rise with reputation (ours: 1,000 a day), or on request | Usually within the quota |
| Limits for open sign-up: per-organization rate limits, a default free quota, suspension | Free compute invites abuse | No |
| The executor and the decryption key in a Worker of their own (cloudflare.md's open question 1) | One shared Worker holds every customer's credentials | Optional |
| Queries across objects (cloudflare.md's open question 9) | Support and cost: which organization uses what | Partly |
| Compliance and residency answers (cloudflare.md's open questions 7 and 8) | Selling to companies | Enterprise self-hosters ask too |

Today the model wrapper counts calls and token totals per run (`src/model/provider.ts`), with costs at zero and some calls counted unmetered. That is a start for usage records, not billing. Quotas across workspaces need a home that sees the whole organization: an Organization object, or D1 with conditional updates. The unit that builds quotas decides which.

**Gates before open sign-up:** the sign-up limits, a measured cost per turn (open question 5 below), quotas, and a decision on the executor's own Worker. A closed beta with invited organizations can come earlier.

### Decisions before Part 2

1. **One identity, in the instance.** Users sign up and sign in only in the instance, through Better Auth. The control plane keeps organization ids and billing state, never accounts of its own for customers. Billing pages are Stripe Checkout and the Customer Portal.
   - The app's Billing link, shown only when the instance has a billing URL configured, reaches the control plane with a signed handoff: organization, user, role, a short expiry and a single-use nonce.
   - The control plane checks the user's role with the instance before acting on billing, so a role removed after the handoff counts.
   - Later, Better Auth's OIDC provider plugin can replace the handoff.
   - The operator signs in to the control plane separately.
2. **Entitlements are quotas.** The instance has quotas an instance admin can set, and the control plane is one more writer, through the management API. Each entitlement write carries a version, so a late or replayed write cannot undo a newer one. Requests in both directions are signed with a timestamp and a nonce, and their keys rotate like `MINERVA_ENCRYPTION_KEYS` (several valid, the first used). An instance without a control plane has only its admin's quotas.
3. **The instance works without the control plane**, as cloudflare.md decided. It caches its entitlements; usage is pushed to an optional signed endpoint or pulled by the control plane. A control plane outage changes nothing for users but the billing pages.
4. **Shared instances first**, as cloudflare.md decided. A dedicated instance is Part 1's setup run by the control plane through Cloudflare's API, built when a customer asks. One instance per region keeps accounts in the region only if D1 uses the EU jurisdiction. Where an EU workspace's container runs, and where Workers AI and the AI Gateway process its prompts, are still unmeasured (cloudflare.md's open question 8), so regional instances alone do not settle residency.

## Part 3: the control plane

Decided 2026-10-13: a Laravel application on Laravel Cloud, with a Laravel MySQL database, in its own private repository.

Its job:

- plans and prices in Stripe, checkout and the portal, and Stripe's webhooks;
- entitlements from subscriptions, and usage from the instances into Stripe's billing meters;
- an operator admin for customers, organizations, instances, usage and suspension;
- later, provisioning dedicated instances, and the sign-up site.

It holds no organization's content or credentials. It is built last, after Part 2's management API.

How it is built:

- **Hosting.** Laravel Cloud runs the web app, its queue workers and its scheduler, in Frankfurt (EU Central), near the instances' D1. The database is a Laravel MySQL cluster in the same region, which Laravel Cloud requires; its automatic backups and Laravel Cloud's environments (production, and staging against the test instance) are used as they come.
- **Billing.** Cashier (Stripe) handles subscriptions, Checkout, the Customer Portal and Stripe's webhooks, and reports usage as meter events. The billable model is the control plane's mirror of an instance's organization (its id and instance), not a user, since customers have no accounts in the control plane (Decisions 1).
- **Admin.** Filament for the operator admin. Only operators sign in to it, with two-factor.
- **Background work.** Queued jobs and the scheduler deliver entitlements to the instances, pull or receive their usage, process webhooks, and later provision dedicated instances through Cloudflare's API.
- **The contract with the instance.** The management API is declared in the instance's oRPC contract (`contract/`), whose OpenAPI document is what the Laravel side follows. The control plane's CI checks its client against that document and runs its integration tests against the test instance. Signing, nonces, key rotation and entitlement versions (Decisions 2) are implemented on both sides; a small shared test vector (a signed request and its expected verdict) keeps the two implementations agreeing.

Considered and not chosen: TypeScript on Workers with PlanetScale Postgres through Hyperdrive (one language and types shared across the contract, but no admin framework); Django (known from `main`, but no first-party managed host); Rails (nothing Laravel lacks for this job).

## Order

1. Part 1, unit 2 (instances by name), which adds one table to D1 and changes no stored format: done 2026-10-14, apart from production's identity deploy. The frontend cleanup (A3 and A4) and the sandbox on the Sandbox SDK, which came before it, are done.
2. The first message (first-message.md), then unit 1: the compatibility baseline. Then unit 3, email through the operator's zone.
3. Units 4 to 8: setup, export and restore, releases, tooling, the guide and its rehearsal.
4. Unit 9, CI and staging on Workers, verified; then unit 10, the merge into `main`.
5. Part 2: organizations and teams, usage records, quotas, deletion, audit and support access, retention, email; then the management API and the executor's own Worker; then the gates before open sign-up.
6. Part 3.

## Open questions

1. Email at volume for Minerva Cloud: a higher Email Sending quota, or a provider beside it (Part 2).
2. Residency of a cloud instance's accounts: one EU cloud instance with D1 in the EU jurisdiction, or one instance per region; and the container's and the model's placement (cloudflare.md, open question 8).
3. Import into another instance: whether credentials are re-encrypted under the new instance's keys or reconnected.
4. The free tier: its quotas, and whether its model is the default Workers AI model.
5. The cost of a typical turn (container time, Durable Objects, model), measured, to set quotas and prices.

## Sources

- [Deploy to Cloudflare buttons](https://developers.cloudflare.com/workers/platform/deploy-buttons/) (supported resources and the subdirectory rule)
- [Laravel Cloud: Laravel MySQL](https://laravel.com/cloud/docs/resources/databases) (same-region rule, backups), [pricing and regions](https://app.laravel.cloud/pricing)
- [Containers pricing](https://developers.cloudflare.com/containers/pricing/)
