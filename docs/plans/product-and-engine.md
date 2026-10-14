# Plan: Laravel is the product, Cloudflare is the engine

Status: design, 2026-10-14; chunks 0 to 6 are done (1b without the staging engine, which moves to chunk 8; 3 with its staging checks waiting on mail and the providers' clients). It replaces self-hosting-and-cloud.md and the "Instance and control plane" section of cloudflare.md (both removed; see git history; cloudflare.md's design is now [ARCHITECTURE.md](../../ARCHITECTURE.md)), whose instance model (everything a company needs in one Cloudflare deployment) and whose later revision (Laravel for identity, the runtime keeping connections and conversations) are both given up. What still holds from them is written out here. opencode reviewed the first draft in a fresh session; its findings are folded in, except that production, which holds only the operator's test data, is still reset.

## Why

The earlier revision split the product's state between Laravel and the Workers: identity in Laravel; memberships, policies, connections and conversations in the runtime, kept in step by a replicated directory. Its reviews found over forty issues, nearly all at that seam (sessions across two systems, revocation lineage, versioned snapshots, outboxes both ways, recovery logs, reconciliation). That is a distributed system a small team pays for on every feature.

This plan splits by responsibility instead: **Laravel decides what may happen; the engine does it and records what it did.** Laravel holds the product's state: who exists, what they connected, what they allowed, what they asked and what they were shown. The engine holds execution facts: what a run did, which writes reached a provider, which files a turn left. Commands go one way, each idempotent; facts come back the other way, through one outbox. Nothing is replicated in both directions, and every admin and support question is answered from Laravel.

The test for every decision is what is best for Minerva as a hosted business. Self-hosting and deployments into a customer's account get worse under this plan, and that is accepted (2026-10-14).

## Decisions

Decided 2026-10-14.

1. **Laravel is the product.** A private Laravel application on Laravel Cloud, with Postgres, owns users, sign-in, organizations, roles, billing and administration; connections and their stored credentials; grants and layers as users set them; agents; the product transcript; the run registry; quotas, usage and the audit log.
2. **The engine executes, and owns execution facts.** The Cloudflare code in this repository (`cloudflare/`) runs a turn: pi's loop in the Conversation object, the sandbox, code mode, the connectors' calls under the permission check, and the live stream. It keeps, durably: each conversation's folder (its versions and manifests in the Conversation object, blobs in R2); each run's input, attempts, pi session, write ledger, page tokens and run events; an outbox of facts for Laravel; and a recovery index in D1. The index holds a row for each run, written before the Conversation object admits it (`startRun` writes it first and is idempotent by run id, so execution never begins without it), and for each conversation the highest fact sequence it has, raised before a batch is delivered. Its rows outlive the restore window, deleted conversations' included. These are the authority on what a run did; Laravel's transcript is built from them (Decisions 7). The engine holds conversation content while it works and for a retention period, but no product transcript, no users, sessions or directory, and no stored credentials. A container lives for one run, as today: started while the model begins its reply, filled from the folder's last version, saved and destroyed when the run ends; only the folder carries over to the next turn.
3. **Connector knowledge and policy stay in TypeScript.** The connectors and the permission pipeline stay in the engine: tools, scopes, resource kinds, grant semantics, scope checks, tool aliases, operation fingerprints, and compiling a run's policy snapshot (`gateway/tools.ts`, `gateway/grants.ts`). Laravel stores the raw inputs (layers, grants, agents' connections, each with a revision) and never interprets them. The engine publishes a versioned catalog: connectors, actions and their scopes, resource kinds, and each connector's complete OAuth descriptor (endpoints, the token request's body format, client authentication, scope separator, extra authorization parameters, PKCE, dynamic registration, refresh behaviour).
4. **Connections live in Laravel.**
   - **The flow.** `league/oauth2-client`'s generic provider, driven by the catalog's descriptor, with an adapter only where a descriptor cannot express a provider, and parity fixtures taken from today's tests of `workspace/credentials.ts` and `api/flows.ts`. Dynamic client registration where a connector has it (Todoist). After the exchange Laravel asks the engine to describe the account (`describeAccount`: id, label, and the tenant where the connector knows one) and stores it. Reconnecting, or replacing a key, must name the same provider and account as the connection, as today; a different account becomes a new connection with no grants, never new credentials under the old one's grants. The owner and admin checks stay as they are.
   - **Stored.** The tokens; the client that issued them and the token endpoint (a refresh uses the same, as today); scopes; generation; refresh state; the account. Encrypted with a key of their own, not `APP_KEY`, with key ids for rotation; the plaintext also carries the organization, the connection and the purpose, checked on every decrypt, so a ciphertext copied to another row does not open (today's binding, `lib/encryption.ts`).
   - **Refresh.** Today's states, persisted (ARCHITECTURE.md, Credentials and refresh): `refreshing` is committed with an operation id, an owner and an expiry before the request is sent; other callers wait for it; a takeover after the expiry, or an answer that was lost, makes the connection `refresh_uncertain`; a result is applied only if the operation id, its owner and the generation are still the ones recorded, since a takeover does not change the generation. A lock or a queued job that expired never makes a retry safe by itself.
   - **What the engine gets.** Never a refresh token, a client secret or the key. `leaseToken` (run, attempt, connection) answers the credential's kind, the secret (an access token, an API key, or a built-in service's), its scopes, its generation and its expiry when known; Laravel answers only for a run that is starting or running, and for a connection in that run's authorized set. The settings calls Laravel makes itself (`describeAccount`, `listResources`, `checkGrantEdit`) carry their credential in the command instead, freshly refreshed, so the engine never asks back for them (contract.md, Credentials). A run's provider rejection is reported with `reportUnauthorized` (run, attempt, connection, generation), fenced by the generation as `markUnauthorized` is today; a settings call answers `CREDENTIAL_REFUSED`. The engine keeps credentials in memory only, and checks the run and attempt before and after each lease, as today.
   - **The bound this gives.** A compromised engine can use the credentials it was handed until the provider expires or revokes them (API keys and some tokens never expire), and can collect more while it stays compromised and runs keep starting. It never sees refresh tokens, nor the credentials of connections that no run and no settings call used. That is narrower than today, where the engine holds every credential's ciphertext and its key, and it answers part of ARCHITECTURE.md's open question 1; keeping credentials out of the loop's Worker entirely would need a separate executor and is not part of this plan.
5. **The interface.** Declared once in TypeScript (the engine's oRPC contract in `contract/`) with an OpenAPI document Laravel's client follows. Each version stays served until both sides have moved past it; a compatibility suite runs Laravel's client against the engine's contract.
   - **Commands, Laravel to the engine**, idempotent by their id: `startRun`, `cancelRun`, `describeAccount`, `listResources`, `checkGrantEdit`, `folder` (a conversation's listing at a version), `resolveDownload` (a file of a version: its R2 key, size and hash), `deleteConversation`, `replayFacts` (a conversation's retained facts after a sequence, for recovery), `admission` (the emergency stop), and the catalog. Every command names the environment, organization, workspace and conversation; an execution object stores the organization and workspace it was created for and refuses a command that names others.
   - **Requests and facts, the engine to Laravel:** `leaseToken`, `reportUnauthorized`, and the outbox's deliveries (Decisions 7).
   - **Authentication.** Laravel's calls carry a Cloudflare Access service token; Access checks it and the Worker checks the assertion again (issuer, audience, the service token's `common_name`). The engine's calls carry a Sanctum token whose abilities allow only these routes. Both are rotated with an overlap.
6. **Starting a run, and strict revocation.**
   - **Start.** In one transaction holding the workspace's row lock (`SELECT … FOR UPDATE`), Laravel checks that the conversation has no active run, the agent, the uploads and the limits; reserves the uploads and the run's budget allowance; captures the raw authority inputs with their revisions; registers the run as `starting` with the user's message; and writes the start to its outbox. A queued job sends `startRun` with the same run id until it is answered. The engine compiles the snapshot, copies the attachments into the folder, and accepts or refuses. It compiles once: the snapshot is stored under the run id, and a repeated `startRun` gets the same answer. An acceptance names the catalog's and the compiler's versions, the snapshot's digest and the run's authorized set (the connections the snapshot can reach), which Laravel stores with the run. Until then the authorized set is the agent's connections, read from the rows without interpreting any grant; Laravel never evaluates grants itself. The page shows the message as sending until then; a refusal marks the run refused, shows the message as not sent with the reason, and releases the reservations. A start still unanswered after a bound is cancelled instead (`cancelRun` tombstones it, so it can never begin), and its reservations are released only once that is acknowledged. This changes today's behaviour, where a refused send leaves nothing: the message now stays visible as failed, as in a chat app.
   - **Ordering.** Every change of authority (a grant or layer edit, a removed connection or reduced scope, an agent's connections, a removed member, the emergency stop) takes the same lock, so a start and a revocation are ordered: a start committed first is found by the revocation's scan of active runs, and one committed after it captures the new inputs. This is tested with concurrent processes against a real Postgres.
   - **Revocation.** The change commits with a cancel entry for each affected run that is starting or running: for a removed connection or a reduced scope, every run whose authorized set holds that connection, whoever started it (today's `deleteConnection` cancels only the deleting user's runs, which the port fixes); for a removed member, their runs; for a layer, the runs of every subject it constrains (a ceiling: all runs using the connection; a user's layer: that user's; an agent's: that agent's). A test with two users on a shared connection covers it. A queued job sends `cancelRun`; the engine acknowledges once the Conversation object has recorded the cancellation durably, or a tombstone for a run it has not received yet, so a late start is refused. Every provider request checks that fence immediately before it is sent (`admits` in `gateway/executor.ts`, as today). A request already sent is not undone; a write in flight settles and is recorded. The change is answered once every cancel is acknowledged; past a bound it answers that it is pending (today's 503) and the job keeps going. Refusing `leaseToken` is a second guard, not the enforcement.
7. **Conversations and the transcript.**
   - **Facts.** In the same transaction as the execution facts they describe, the engine writes product facts to its outbox: a run's status changes; each tool call as the page shows it today (name, truncated arguments, outcome, counts, never a provider's full result); the final message; the run's resulting folder version and changed files; write settlements, including those that settle after a cancellation, for the audit log; and usage per model call.
   - **Delivery.** In order per conversation, with a sequence number. Laravel applies a batch in one transaction and acknowledges only then; a repeat is applied once, and a repeat whose content differs stops that conversation's delivery and alerts the operator. Acknowledged facts stay in the engine through the restore window, so `replayFacts` can send them again. The engine never deletes an unacknowledged fact; a backlog past a bound refuses new starts in that conversation rather than dropping anything.
   - **History.** A conversation has one active run, as today. Laravel marks a run finished only from its terminal fact, which carries the final message and folder version, so a next start always sees the whole previous turn. Laravel sends the conversation's recent messages with `startRun` and the engine applies `history.ts`'s selection and clipping (order, failed and cancelled user messages, attachment notes, the message and budget limits), so those rules stay in one place. Each run is a fresh pi session seeded from that history, as today.
   - **Deltas** are not facts: they are the engine's run events, streamed live and replayed to a reconnecting browser for the run's retention period, and never sent to Laravel.
   - **Search** is Laravel Scout on Postgres full-text search; semantic search later with pgvector.
8. **The browser.** The product's pages are Laravel's: Inertia with React (first-party), moving today's React components and the Ledger design system into the Laravel repository. Inertia replaces the SPA's routing and its API client, since Laravel serves the pages and their data in one request.
   - **The live stream** is read from the engine over SSE, with a token Laravel signs for one run (open question 1) that names the environment, organization, conversation and run, its audience and purpose, and lives at most five minutes. The browser reads it with `fetch` and an `Authorization` header, not `EventSource`, so the token stays out of URLs and logs. The engine closes the stream when the token expires; the browser gets a new one from Laravel, which checks the membership again, and resumes with the last event id. A removed member therefore loses a stream within one token's life (today's relay rechecks every 60 seconds).
   - **Uploads** go from the browser to a staging key in R2 with Laravel's `Storage::temporaryUploadUrl`: a random key, a short expiry, the declared size signed into the request (proved against R2 in chunk 12). Laravel reserves the size first. At `startRun` the engine copies the staging object into the folder, computing its size and hash itself and refusing a mismatch; staging objects are deleted after the run, or after a day if none used them.
   - **Downloads.** Laravel asks `resolveDownload` and signs a GET for that key, with the content disposition that forces a download, on R2's own origin. Laravel never derives an R2 key from a path.
9. **Packages.** Laravel's React starter kit (Inertia, React, Fortify: sign-in, two-factor, passkeys, verification, reset), Socialite (Google, GitHub; Microsoft through the SocialiteProviders adapter), Sanctum, Cashier, Pennant, Scout, Filament for the operator admin (open question 5), Nightwatch, queues and the scheduler on Laravel Cloud, `league/oauth2-client` for connections; WorkOS for enterprise SSO later. Organizations, members and invitations are the application's own models.
10. **Postgres, not MySQL.** Revisits the 2026-10-13 choice: Postgres has pgvector, better full-text search and JSON columns, and Laravel Cloud offers it (open question 2).
11. **Hosted only.** Minerva Cloud runs one Laravel application and one engine deployment. Self-hosting, the hybrid (our Laravel, the engine in a customer's account) and cells are dropped for now. An enterprise that needs its own deployment later gets a dedicated copy of both. Laravel runs in Frankfurt and the engine's storage in the EU jurisdiction, but that is a deployment, not a residency promise: where the Workers, containers, models, logs, backups and telemetry process data is documented first (open question 6), and Minerva promises EU processing only when all of them allow it.

## What moves where

| Today on the `cloudflare` branch | Becomes |
|---|---|
| Better Auth, D1's accounts, sessions, organizations, workspaces and memberships, the instance claim, auth emails (`src/accounts/`, `api/accounts.ts`, `api/members.ts`) | Laravel (Fortify and its own models); deleted from the engine |
| The Workspace object's connections, credentials and refresh (`src/workspace/`, `workspace/credentials.ts`) | Laravel's tables and jobs |
| OAuth flows and clients (`api/flows.ts`, `api/oauth-clients.ts`) | Laravel, generic over the catalog's descriptors, with parity fixtures |
| The Workspace object's layers, grants and agents | Stored in Laravel; checked and compiled by the engine (`checkGrantEdit`, `startRun`) |
| The Workspace object's run registry, uploads, byte counters and outbox of cancels | Laravel; the engine's Workspace object is deleted |
| The connectors and the permission pipeline (`src/connectors/`, `src/gateway/`) | Stay in the engine; the executor's credential port asks Laravel |
| The Conversation object's messages | Laravel's transcript, from the outbox; the history arrives with `startRun` |
| The Conversation object's runs, attempts, run events, write ledger, page tokens, checkpoints, folder; the Sandbox and Scripts objects | Stay in the engine, with the outbox added |
| The SPA's routes, `lib/orpc.ts` and the public API (`api/*`) | Laravel's Inertia pages; the engine keeps its internal API and the stream |
| The files Worker's uploads and download links | Staging uploads and download links Laravel signs to R2, resolved by the engine |
| Email Sending from the engine | Laravel's mail; dropped from the engine |
| Self-hosting: `setup`, export, a guide, the management API | Dropped; the named instances (production, test) stay as they are |

## Chunks

The plan is built in chunks of about one session each, in order. A chunk starts with a fresh agent that reads this plan and its chunk. Where the chunk leaves choices open, the agent writes a short design for it first (in `docs/plans/` here, or in the Laravel repository for its chunks) and has opencode review it. It then implements, runs the checks, has opencode review the diff and commits. A chunk that turns out bigger splits into parts (a, b, …). Laravel's chunks are committed in its own repository; the engine's on `main` from chunk 1 on.

**Ground**

0. **A clean slate.** Done 2026-10-14. The stopped session's email-zone work was discarded, the superseded and finished plans were removed, and this plan is committed.
1. **Into `main`, with CI for the engine.** Done 2026-10-14. `main` has no commits that `cloudflare` lacks (2026-10-14), so `main` fast-forwards. In order:
   1. On `cloudflare`, in one commit, delete what only the Django stack uses: `backend/`, `worker/`, `deploy/` (the VPS), `compose.yaml`, `Procfile`, the Makefile's targets for them, and the old workflow `.github/workflows/main.yml`. The old workflow runs the Django tests and image builds and deploys the VPS staging on every push to `main`, so it must be gone before `main` moves.
   2. Add the engine's workflow on pushes to `main`: lint, types, the unit tests and the frontend's check. Platform tests against the test Worker and a deploy of a staging engine follow in the same chunk if they fit, else as chunk 1b. Production is deployed by hand. Built: the workflow also runs the platform tests in local workerd, which need no account; the account suites and a staging deploy are chunk 1b.
   3. Rewrite the README, `AGENTS.md` (no `cherry-pick -x` from `main` to `demo`: the demo stays frozen on its own Django copy until the hosted product replaces it; the engine's commands, checks and environment) and `ARCHITECTURE.md` for the engine, with `cloudflare.md`'s design sections moved into `ARCHITECTURE.md` and that file removed.
   4. Fast-forward `main` to `cloudflare`, push, watch the first run go green, and delete the `cloudflare` branch.
   5. Ask the owner before retiring the VPS staging (`staging.minervacomputing.com`: the server, its tunnel, its Access application and its DNS record). It shows stale Django once `main` stops deploying it. Done 2026-10-14: all four removed, and the GitHub `staging` environment with them.

   The `demo` branch is untouched. Done when `main` is the engine and its workflow is green.

   **1b. The engine on Cloudflare from CI.** A staging instance of the engine, deployed by the workflow after the checks pass, and the account suites (`test:deployed`, `test:faults`, `test:browser`) against the test Worker. Left out of chunk 1 because each needs decisions and changes on the Cloudflare account that the owner makes: a new instance and its resources (D1, buckets with their jurisdiction and lifecycle rules, the AI Gateway, the container application), a scoped API token, and the instance's `secrets.env` and `vars.env` as repository secrets the workflow writes into a temporary instance directory (`MINERVA_INSTANCES_DIR`). The scripts already pin the account and check the instance's identity, so the workflow only provides them. The test Worker's suites take about five minutes and mutate the shared test instance, so they need a concurrency group and a decision on whether every push runs them or only changes to the paths cloudflare/README.md lists.

   Done 2026-10-14 as [ci-account-suites.md](ci-account-suites.md), green on its first full run: the account suites (`test:deployed`, `test:faults`, `test:browser`) run in CI against a CI-only test instance, `minerva-cf-ci`, on pushes that change the engine or the app. The staging engine is left for the chunk in which Laravel's staging first calls the engine (8, one turn through the seam), since nothing calls one before that.

**The Laravel foundation** (a new private repository; the owner creates it and the Laravel Cloud organization)

2. **The application.** The React starter kit, Postgres (open question 2 answered here), Laravel Cloud's staging and production environments, CI, Nightwatch. Done when staging serves sign-in.

   Done 2026-10-14 in the private repository `minervacomputing/app` (its `docs/plans/foundation.md`): the starter kit (Laravel 13, Inertia with React, Fortify with two-factor and passkeys, Pest, Larastan, Vite+), Postgres 18 with pgvector in development, the tests and CI, and Laravel Cloud's application in Frankfurt with `staging` (deployed by CI after the checks) and `production` (by hand, sign-up closed), each with its own Serverless Postgres cluster. Nightwatch is installed and waits for a token.
3. **Accounts and organizations.**
   - Sign-in: Fortify's features (verification, reset, two-factor, passkeys) and Socialite (Google, GitHub, Microsoft).
   - Organizations: their workspaces, members, invitations and roles.
   - Mail.
   - The operator admin (open question 5 answered here).
   - Tests that one organization cannot reach another's data.

   Done 2026-10-14 in `minervacomputing/app` (its `docs/plans/accounts.md`), in three commits. Sign-in: Socialite for Google, GitHub and Microsoft (whose addresses are never trusted to match an account), lower-cased addresses, credentials added only once an address is verified, and a session epoch that ends every session and remembered sign-in at once. Organizations: a personal one for every account and teams, with workspaces every member reaches, owners, admins and members changed under row locks (tested with concurrent processes), invitations by mail that admit a sign-up while sign-up is closed, and isolation tests. Mail: Resend in its EU region. The admin: Filament at `/admin`, 404 to anyone but an instance admin signed in with two factors and with the password confirmed in the last 15 minutes; the first admin is made with `php artisan minerva:admin`. What waits on the owner: Resend's domain and key, and the providers' OAuth clients, on staging and production; then the plan's checks there.
4. **The shell in Inertia.** The Ledger design system, today's layout, navigation and settings pages, copied from `frontend/` and rendering Laravel's data. Pages that need the engine stay placeholders.

   Done 2026-10-14 in `minervacomputing/app` (its `docs/plans/shell.md`). Ledger's tokens, IBM Plex (served by the app itself), the logo and the primitives replace the starter kit's design. The shell is this frontend's sidebar, with a switcher of the user's organizations and workspaces. The account and organization pages are ruled settings lists. New chat, Agents and Connections are placeholders. Ledger's error page keeps every status code. The components page is local only. The design skill is copied as that repository's `docs/design.md`; until this repository's `frontend/` leaves (chunk 13), a change to the design is made in both.

**The seam**

5. **The contract** (both repositories).
   - The internal API in `contract/`: commands, requests, facts and errors.
   - Its OpenAPI document, Laravel's client for it, and the compatibility suite.
   - Authentication: the Access service token, checked again by the Worker, and Sanctum's abilities.
   - The catalog, with each connector's OAuth descriptor.
   - The fake Laravel that the engine's platform tests use.

   Done 2026-10-14 (`docs/plans/contract.md`; in `minervacomputing/app`, its `docs/plans/contract.md`). The internal API is `contract/src/internal/`: the commands under `/internal/v1/` on the engine, which answer 501 until their chunk, and the requests and facts on Laravel, with `engine-v1.json` and `laravel-v1.json` generated from it and checked in CI. The Worker checks Access's assertion again (RS256, issuer, audience, the service token's client id) before reading a body; Laravel authenticates the engine with Sanctum tokens of an `Engine` model, an ability per route. The catalog carries each connector's OAuth descriptor and a version naming it. Each side's client checks the other's answers and classes failures for retrying. Laravel's copies of the documents and of the delivery scenarios are compared with this `main` in its CI, and its tests fake the engine against `engine-v1.json`; the fake Laravel here passes the scenarios. Settings calls carry their credential (Decision 4), and `replayFacts` recovers by conversation (Decision 5). What waits on the owner: the Access application and service token in front of each engine, and the engine's token on Laravel, when a staging engine is wired to staging's Laravel (chunk 8).
6. **The engine's start and cancel** (engine), next to the current paths.
   - `startRun`: the recovery index row first, the organization and workspace bound to the objects, the history through `history.ts`, compiling once, attachments, and refusals.
   - `cancelRun`: the durable fence, and the tombstone for a run not yet received.

   Done 2026-10-14 ([start-and-cancel.md](start-and-cancel.md)). `startRun` and `cancelRun` answer under `/internal/v1/`. The Worker binds each run to its conversation and each conversation to its organization and workspace in D1's recovery index, in one batch of conditional writes, before it reaches an object; a mismatch is `SCOPE_MISMATCH`, another input for the same run `IDEMPOTENCY_CONFLICT`. Laravel's conversations live in the EU jurisdiction and bind themselves on the first command. A start compiles the command's raw authority once into a preparation the object keeps across resets, measures and copies the staged attachments into the folder, and stores its answer, acceptance or refusal, so a repeat gets it again; an error stores nothing. A cancel fences an active run, answers `ended` for a finished one, and tombstones a run not yet received, which its start then refuses as `CANCELLED`. Until chunk 7 a run Laravel starts has no credentials: every connector lease is refused.
7. **The engine's credentials and facts** (engine).
   - The credential port asking `leaseToken`, and `reportUnauthorized`.
   - The outbox of facts written with the execution facts, delivered in order and acknowledged, with the backlog bound and `replayFacts`.
   - The stream token, and a stream that closes when its token expires.
8. **One turn through the seam** (Laravel), for one connector.
   - The run registry, the start transaction under the workspace lock, and the start and cancel jobs.
   - Facts applied into a minimal transcript, and `leaseToken` served from a connection stored by hand.
   - Tests against a real Postgres: a start racing a revocation, a lost start answer, a lost acknowledgement, a refresh racing a lease.
   - Done when a turn on staging runs from Laravel through the engine and back.

**The product on Laravel**

9. **Connections: the core.**
   - The generic OAuth flow from the catalog's descriptors.
   - Encryption with its binding and key ids.
   - Refresh with its persisted states.
   - `describeAccount`, and reconnecting to the same account only.
   - Parity fixtures from today's tests; one OAuth connector end to end.
10. **Connections: every connector.** The remaining descriptors and adapters, dynamic registration (Todoist), API keys and built-in services, scope upgrades ("Allow in Google Calendar"), deletion, and the connections pages.
11. **Grants and agents.** Layers (ceiling, user, agent), the grant editor with `listResources` and `checkGrantEdit`, agents and their connections, and their pages. `checkGrantEdit`'s answer holds for the layer revision it was checked against: Laravel commits it only if that revision is unchanged, and otherwise checks again.
12. **Conversations.**
    - The chat pages, and runs started with every authority input.
    - The transcript from every fact, and the stream with renewal.
    - Cancel, and strict revocation for every change of authority, with Decisions 6's matching rules and the test with two users.
    - Uploads, downloads, and conversation deletion with tombstones.
13. **The engine's old paths go.** Better Auth, D1's accounts, the Workspace object, the public API and `frontend/` leave this repository (what stays public follows open question 3). Production is reset.

**Before any customer's data**

14. **Usage, budgets and the emergency stop.**
    - **Budgets.** Laravel reserves an allowance per run against the organization's budget at the start, so concurrent runs cannot overshoot together.
    - **Model calls.** The engine admits each one against that allowance before sending it. It reserves the call's worst case (its maximum input and output), and counts a call whose usage is unknown at that worst case. Containers and scripts are counted by time.
    - **Settling.** A run stops at its allowance. Its usage settles in Laravel from the facts, and what was not used is released once every call it made has settled, not at its terminal status.
    - **Emergency stop.** It refuses new starts (`admission`) and cancels every active run.
    - **Storage** works the same way. Each run gets a byte allowance for everything it can store: checkpoints and attachments, today's per-run upload limit, four times the folder's. The allowance is reserved against the organization's storage at the start, and the engine enforces it before each write.
    - **Storage settling.** After each checkpoint and clean-up, the engine reports the conversation's retained bytes as an absolute number with a revision, and Laravel settles the reservation from it.
15. **Deletion, retention and recovery** (below), rehearsed on staging, and the processing locations documented (open question 6).

**Paid launch and after**

16. **Billing.**
    - Cashier with Checkout, the Customer Portal and Stripe's webhooks.
    - Pennant for features; quotas as numbers.
    - Usage into Stripe's meters, with each usage record's id as the event's identifier.
    - Payment failure, grace, cancellation, plan changes and late usage, all defined.
17. **Connection policies.**
    - The connectors an organization offers, and the tenants it allows.
    - Each connector declares how tenancy works for it, one of:
      - one tenant per account (Google's `hd`, Microsoft's `tid`, Slack's team);
      - a tenant per resource, for tokens that reach several organizations: Atlassian by the cloud id of each site; GitHub, whose user-to-server tokens reach every installation and public repositories, by each repository's current owner, following transfers;
      - unknown.
    - The tenant is checked at the callback where there is one, in resource discovery, before each call, and on the call's results.
    - Until this chunk, Minerva makes no promise about tenants.
18. **Search.** Scout on Postgres over the transcripts.

**Gates before any customer's data:** chunks 14 and 15 done, and tests that one organization cannot reach another's conversations, connections or files. Before open sign-up, on top: rate limits and a measured cost per turn.

## Deletion, retention and recovery

**Deletion.** Deleting a conversation commits a tombstone and a deletion entry in Laravel's outbox; the transcript is hidden at once. `deleteConversation` makes the engine tombstone the conversation, refuse starts and writes, cancel its run, and clean up; it acknowledges. A late fact for a tombstoned conversation never brings its content back: transcript facts are acknowledged and dropped, while usage and write settlements are applied to the run's accounting and audit records, which are kept under their own retention rather than the conversation's. Rows and objects are removed physically after the restore window; tombstones outlive it. Deleting an organization does the same for each of its conversations and connections.

**Retention.** Every record that deduplicates (run ids, command ids, cancel tombstones, acknowledged sequence numbers) is kept longer than any retry can arrive; retries stop after a bound. The write ledger is kept for as long as a run can resume. The engine's run events, run inputs and pi sessions are deleted after the run's retention period (deleting pi's session safely is ARCHITECTURE.md's open question 3); facts never before they are acknowledged. The limits for stream events, pi content, transcripts, audit and files are set separately (open question 9).

**Recovery.** Restoring is still a reconciliation, because the engine and the providers move on while Laravel is restored. The rules:

- **Reductions are written ahead.** Before Laravel commits a change that reduces access, or a deletion, it appends a restriction to a log in R2 with a bucket lock. A restriction is not the edit: it is a removal (of a connection, a member, a conversation) or the quarantine of a layer, which then allows nothing until someone with the right reviews it, by stable ids. A restore applies every restriction logged after its point. Each only ever removes access, so one whose change never committed is harmless, and their order does not matter.
- **Everything stops** while Laravel is restored and reconciled: the emergency stop refuses starts and cancels every active run, and no lease is answered.
- **Runs are reconciled from the engine.** Laravel sends its restored watermark, the last applied sequence of each conversation; the engine lists from its recovery index every conversation with facts beyond it, finished and deleted conversations included, and delivers those facts again (`replayFacts` per conversation, for Laravel's runs still marked starting or running). Late usage and settlements of runs that had already ended are found the same way. The engine is not rolled back with Laravel: its write ledgers and facts record what reached providers, which no restore undoes. A Durable Object is restored to an earlier point only to repair it, and then none of its runs resumes: each ends as uncertain, its writes marked possibly done, since neither the restored ledger nor Laravel's audit log can prove that a write did not reach its provider. The restore could also undo the cancellation that stops them, so before it the operator sets a quarantine for that object in the recovery index, outside the storage being rolled back. Every path that opens a run (`Harness.open`, from an alarm or a call) checks it first, and it is lifted only once the restored runs have ended. A test sends an alarm right after the restore, before the repair.
- **Credentials.** A restored OAuth connection with a refresh token is marked `refresh_uncertain`, since the provider may have rotated it since the point. API keys and built-in services are left as they are; a restore cannot make them stale.
- **Files.** Blobs are never overwritten (their keys hold a hash and a random part), and removed only after the restore window; the manifests are in the Conversation objects, which are not rolled back.
- **Money.** Usage facts are kept by the engine until acknowledged, so a restored Laravel receives them again; billing resumes only after its usage has been reconciled with Stripe.
- **The key.** The credentials' encryption key is backed up outside Laravel Cloud, since a restored database is useless without it.

## Open questions

1. The stream token's format: a JWT (`firebase/php-jwt`, maintained by Google; `jose` in the engine), or an HMAC over a fixed payload with PHP's `hash_hmac` and WebCrypto. Laravel Reverb was considered; it would need its own way to close subscriptions that are already open when a member is removed.
2. ~~Laravel Cloud's Postgres~~ Answered 2026-10-14 (chunk 2): Serverless Postgres is Neon, Postgres 18 in `eu-central-1`; pgvector 0.8 is available and Postgres's own full-text search needs no extension; a cluster at 0.25 compute units reports `max_connections` 112 (measured; Neon reserves a few for itself), and its PgBouncer pooler (transaction mode) takes up to 10,000 clients, to be used once queue workers run. TLS is verified against Neon's own host name, since its certificate does not name the alias Laravel Cloud injects.
3. Open source. The frontend moves into the private Laravel repository, so this public repository would hold the engine alone. Keep it public as Minerva's open harness (a trust signal for a product that holds people's accounts), or make it private. The licence follows from that.
4. The credentials key: Laravel's encrypter with a dedicated key, or an envelope with a key service.
5. ~~The operator admin: Filament or Nova~~ Answered 2026-10-14 (chunk 3): Filament 5, free and in the same Livewire stack as the rest of Laravel's first-party tools; Nova's licence buys nothing a read-mostly operator panel needs.
6. Where the engine's Workers, containers and models process data (ARCHITECTURE.md, open question 8), and the subprocessors to list.
7. The cost of a typical turn, measured, to set quotas and prices.
8. When the demo moves from Django to the hosted product.
9. Retention periods, and the restore window (Laravel Cloud's backup retention bounds it).

## Sources

- [Laravel starter kits](https://laravel.com/docs/starter-kits), [Fortify](https://laravel.com/docs/fortify) (passkeys included), [Sanctum](https://laravel.com/docs/sanctum), [Scout](https://laravel.com/docs/scout), [Cashier](https://laravel.com/docs/billing), [Pennant](https://laravel.com/docs/pennant), [Reverb](https://laravel.com/docs/reverb), [file storage](https://laravel.com/docs/filesystem) (`temporaryUploadUrl`)
- [league/oauth2-client](https://oauth2-client.thephpleague.com/)
- [Laravel Cloud](https://cloud.laravel.com/docs)
- [Cloudflare Access service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
