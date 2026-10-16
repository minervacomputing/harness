# Finish the product plan (chunks 13 to 18)

Status is proposed, as of 2026-10-15. It turns chunks 13 to 18 of [product-and-engine.md](product-and-engine.md) into checklists, from what the engine and `minervacomputing/app` hold after chunk 12. That plan's Decisions and its section on deletion, retention and recovery still hold. Where this file is more specific, it wins.

The engine loses everything Laravel replaced (13a to 13c). Runs then get a budget the engine enforces and Laravel settles, and an emergency stop (14a to 14d). Deleted data then leaves both sides on a schedule, and a restore of Laravel is rehearsed (15a to 15d). Billing (16), connection policies (17) and search (18) follow. Chunks 14 and 15 and the isolation gate stand between Minerva and any customer's data.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a test run, or a commit. The body is a how-to. The appendices explain and record.

The program runs as product-and-engine.md's chunks do, not as a pstack execution playbook, since this repository has no pull requests. A chunk starts with a fresh agent that reads this plan and its chunk, writes a short design where the chunk leaves choices open, has opencode review it, implements, runs the checks, has opencode review the diff and commits to `main` (engine) or to `minervacomputing/app` (Laravel). The owner approves anything that touches production or the account, per AGENTS.md.

Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked. "Live" means the account suites against the test instance for the engine, and turns on staging for Laravel. The pstack template's ten screenshot lanes are not used. Each chunk names the scenarios its live check must pass instead. Each perf box measures `main` first, then the head, with the same probe run interleaved on the same instance.

The contract changes only additively from here (AGENTS.md, Frontend). A new input or a new kind of fact ships optional first and is deployed to the receiving side before the sending side uses it. Each chunk that changes it says which side deploys first.

## Program checklist

### Arm the program

- [ ] Clear the owner's staging steps from earlier chunks, since later live boxes run on staging. Each is listed in the app's plan named.
  - [ ] Chunk 3 (`accounts.md`). Resend's domain and key, the providers' OAuth clients, then sign-in, invitations and the first admin on staging.
  - [ ] Chunk 8 (`turn.md`). A lease of a real secret on staging.
  - [ ] Chunk 9 (`connections.md`). One connector end to end with a refresh after expiry. `grants.md` says the owner's GitHub connection already works on staging, so record which steps are done and fix product-and-engine.md's status line.
  - [ ] Chunks 10 to 12 (`connectors.md`, `grants.md`, `conversations.md`). Their by-hand checks.
  - [ ] Staging's `MINERVA_CREDENTIALS_KEY` is backed up outside Laravel Cloud. Record where (not the value).
- [x] The owner answers open question 3. The repository stays public as Minerva's open harness (owner, 2026-10-15).
- [x] The owner answers open question 9 (owner, 2026-10-15). These are the periods 15a and 15b build to.
  - The restore window is 7 days.
  - Run events (the stream's replay), run inputs and pi's session are kept 30 days after the run.
  - Facts are kept 7 days after Laravel acknowledges them.
  - Transcripts and files are kept until the conversation is deleted. A deleted conversation is removed physically 7 days after its deletion, in both systems.
  - Usage records and the audit log are kept at least 1 year. Check whether invoicing or tax law needs longer before chunk 16.
- [ ] Check that Laravel Cloud's point-in-time backups can be kept 7 days on staging's and production's plans. Record the plan and its retention here. A shorter retention shortens the window.
- [ ] Open question 7 (the cost of a typical turn) is measured in chunk 14a and answered before chunk 16.

### Order and dependencies

- [x] 13a, 13b and 13c run in order.
- [ ] 14a after 13c. 14b after 14a. 14c and 14d after 14b, in either order.
- [ ] 15a and 15b after 14a, beside 14b to 14d. 15c after 15a and 15b. 15d after 15c.
- [ ] The gate (below) after 14 and 15.
- [ ] 16 after the gate and open question 7. 17 after 13c. 18 is Laravel's alone and can run any time after 12.

### The gate before any customer's data

- [ ] Chunks 14 and 15 done.
- [ ] Isolation tests with real foreign rows. Today's `IsolationTest.php` uses random ids for connections and uploads, and its before-and-after snapshot leaves out connections, conversations, messages and uploads. Seed two organizations, then have a member of A name B's real connection, upload, file, conversation and run ids on every route, and snapshot all of those tables. Each answer is 404 and nothing changes.
- [ ] Before open sign-up, on top. Starting a run (`conversations.store`, `conversations.message`) gets a rate limit per user and per organization, since it has none today. The cost per turn is measured (open question 7).

## Free the kept engine from the old paths (chunk 13a)

Done 2026-10-16 (`8873fdb` to `bb01f72`). The design, its amendments, the case counts and the live and perf results are in [chunk-13a-design.md](chunk-13a-design.md). test:faults went from 33 cases to 32 (the Workspace's rotating refresh dropped) and passed at the head; the head's wall time was 1.18 times main's (median of four passing runs each, interleaved), within the 20% rule. A run reset by the memory limit restarts on the Conversation's 20 s watch, which is most of the gap.

**Depends on.** Chunk 12.

The engine's internal path still borrows from the code chunk 13 deletes. This chunk moves what stays and ports the tests that cover kept behaviour through old paths, so 13b deletes without losing coverage.

**Files.**

- [x] Move `contractHandler` from `cloudflare/src/api/orpc.ts` into `cloudflare/src/internal/` (used by `internal/mount.ts`).
- [x] Move `PROVIDER_NETWORK` and `providerAccount` from `cloudflare/src/api/providers.ts` into `cloudflare/src/internal/` (used by `internal/connections.ts` and `faults/index.ts`).
- [x] Move the limits `files/store.ts` and `files/limits.ts` import out of `workspace/limits.ts`.
- [x] Split `contract/src/` into the types the engine keeps (`Folder`, `Attachment`, `RunEvent`, `REFUSALS`, `NewMessage`, `ToolCallEventData`, `MAX_ACCESS_CHANGES`) and the public routes that go.
- [x] Add a fake Laravel to the faults build, hosted by the Worker as `FAULT_PROVIDER` is, so the account suites can send `startRun` and read facts on a deployed instance.
- [x] Edit `cloudflare/test/account/driver.ts` and `src/faults/routes.ts` to build their worlds through `startRun` and the fake Laravel instead of the Workspace object.

**Build.**

- [x] Port the platform suites that cover the Conversation object through the Workspace (`conversation`, `protocols`, `chat`, `files`, `images`, `local-tools`, `scripts-conversation`, `scripts-faults`) to `startInternal` with `fake-laravel.ts`. Keep every case that tests behaviour the internal path has. Delete a case only when it tests the Workspace itself, and list the deleted cases in the commit.
- [x] Port `test:faults` (`faults.test.ts`, `resets.test.ts`, `turns.test.ts`). The end-to-end turns fail, not skip, when a required tool is not called (after-the-plan.md's Arm the program asks for this).
- [x] Rewrite `deployed.test.ts`'s checks that are about the SPA, assets, CSRF and the download Worker as checks that those routes answer 404 after 13b. Until then they stay. Moved to 13b, whose commits deleted the routes and rewrote these checks (chunk-13b-design.md).

**You see.**

- [x] `pnpm test:platform` and `pnpm test:faults` pass with no test reaching `workspaceObject`. A grep for `workspaceObject` under `test/` finds only the suites 13b deletes.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] `pnpm typecheck` and `pnpm test:unit` in `cloudflare/`, `pnpm typecheck` and `pnpm openapi:check` in `contract/`. `engine-v1.json` is unchanged.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. `test:deployed` and the ported `test:faults` pass on `minerva-cf-test` at the chunk's head. Record the count of cases before and after the port, with each dropped case named.
- [x] Make one required tool unavailable in a turn and watch `turns.test.ts` fail.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. The account suites' wall time. Rule. Within 20% of `main`'s. More fails, since CI runs them on every engine push.

**Review.**

- [x] opencode reviewed the design and the diff.

## Delete the old paths (chunk 13b)

Done 2026-10-16 (`2ad5a52` to `cf81e8a`). The design, its amendments and the verification are in [chunk-13b-design.md](chunk-13b-design.md). Startup CPU fell from 83 to 66 ms (median of five interleaved pairs) and the bundle from 9.65 MB to 7.03 MB. test:faults kept 13a's 32 cases; test:deployed went from 11 cases to 6 by merging and dropping the old routes' checks.

**Depends on.** Chunk 13a.

**Files.**

- [x] Delete `cloudflare/src/accounts/`, `cloudflare/src/api/`, `cloudflare/src/workspace/`, `frontend/`, `cloudflare/files-worker/`, `src/files/download.ts`, `src/files/links.ts`, `src/http/assets.ts`, `src/http/csrf.ts` and `src/http/asset-manifest.ts`.
- [x] Delete the contract's public routes, split off in 13a.
- [x] Delete the Workspace and email parts of `src/faults/` (`mailbox.ts`, the Workspace ports).
- [x] Delete `test/account/browser.test.ts`, `chrome.ts`, and the platform and unit suites that test only old paths (accounts, API, OAuth, instance, Workspace, the public contract, the frontend's client, assets, mailbox, email, download links).
- [x] Delete the engine's verify skill under `.claude/skills/verify/` and the `cf-frontend` entry in `.claude/launch.json`. The app has its own verify skill.
- [x] Delete the `minerva-design` skill under `.claude/skills/`. The app's `docs/design.md` becomes the only copy of the design system, which `shell.md` asks to keep in step only until this chunk.
- [x] Edit `.github/workflows/main.yml`. Remove the frontend's check, `test:browser`, and `frontend/` from the path filter.

**Build.**

- [x] Remove the Workspace branch from the Conversation object. `#workspace()` and its calls (`beginRun`, `activate`, release, `conversationTouched`), the lease that decrypts with `MINERVA_ENCRYPTION_KEYS`, and the Workspace-only RPCs. `WorkspaceClient` and `WorkspaceApi` in `ports.ts` collapse to Laravel's behaviour, and `laravel-runs.ts` stops pretending to be a Workspace.
- [x] Decide what happens to the `messages` table and `history.ts`. `history.ts` reads "our own messages table" today, while Laravel's runs send their history with `startRun`. Keep the selection and clipping rules (Decision 7) applied to the command's history, and drop the table if nothing else reads it.
- [x] Remove the dead connector code. `tokenRequest` and `planRefresh` in `workspace/credentials.ts`, and `consentNeeded` and `requestedScopes` in the connectors, since Laravel uses the catalog's descriptors. Keep the connectors' tool tests and drop their token-request assertions.
- [x] Remove the dead settings and secrets from `cloudflare.config.ts` and `src/config.ts`. `MINERVA_SITE_URL`, `MINERVA_DOWNLOAD_ORIGIN`, `MINERVA_SIGNUP_OPEN`, `MINERVA_EMAIL_FROM`, `MINERVA_FILES_WORKSPACE_BYTES`, `MINERVA_ENCRYPTION_KEYS`, `MINERVA_DOWNLOAD_KEY`, `MINERVA_SETUP_KEY`, and the `ASSETS`, `EMAIL` and `FAULT_MAILBOX` bindings.
  - [x] Check each `MINERVA_<APP>_CLIENT_ID` and `_SECRET` pair. The engine needs a client secret only if a kept path uses it. Laravel holds the OAuth clients now.
- [x] Rewrite the scripts that build what this chunk deletes before deleting their inputs. `scripts/deploy.ts` builds and checks `files-worker`, and `scripts/reset.ts` refuses to run without the frontend's assets in `.assets/`. 13c uses both.
- [x] Remove `better-auth` and the package scripts for the frontend, seeding and the download Worker.

**You see.**

- [x] `GET /` and `/api/*` on the test instance answer 404, `/internal/v1/*` and `/stream/v1` answer as before.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] `pnpm typecheck`, `pnpm test:unit`, `pnpm test:platform` and `pnpm startup` in `cloudflare/`. `contract/`'s checks. The workflow is green.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. `test:deployed` and `test:faults` pass on `minerva-cf-test` with the same cases as at 13a's head.
- [x] A turn on Laravel's staging through a test instance built from this head (not `minerva-cf-staging` yet, which 13c changes) calls a connector and its facts reach Laravel. Run on `minerva-cf-staging` itself instead, at the owner's choice (chunk-13b-design.md, open question 1).

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Startup CPU (`pnpm startup`) and the Worker's bundle size. Rule. Neither grows against `main`. Growth fails, since deleting code should only shrink both.

**Review.**

- [x] opencode reviewed the diff.

## Retire the old classes and reset production (chunk 13c)

Done 2026-10-16 (`85618f6` to `7e91275`). The design, its amendments and the verification are in [chunk-13c-design.md](chunk-13c-design.md). `Workspace` was retired with a tombstone on the test, CI and staging instances, `FaultMailbox` on the test and CI instances, and both tombstones were then dropped; staging kept its conversations, files and recovery rows. Production was reset and deployed once, with 0001 to 0013. Startup CPU stayed at 66 ms (median of five interleaved pairs) and the bundle fell by 192 bytes.

**Depends on.** Chunk 13b.

**Build.**

- [x] Replace the `Workspace` export, and `FaultMailbox` on the builds with faults, with a deleted-class tombstone, as `reset-worker` does, and deploy it to `minerva-cf-staging`, `minerva-cf-test` and `minerva-cf-ci`. Then drop the tombstone in a second deploy. `minerva-cf-staging` holds Laravel's staging conversations and is not reset.
- [x] Add D1 migration `0013` that drops the account tables (`user`, `session`, `account`, `verification`, `workspaces`, `memberships`, `oauth_flows`, `oauth_clients`, `instance_setup`, `instance_settings`). Keep `instance_identity` and the `recovery_*` tables. Do not squash migrations, since staging is not reset. 0013 drops 15 tables: the ten named and `twoFactor`, `organization`, `member`, `invitation` and `rateLimit`, which 0003 made.
- [x] Delete each instance's download Worker and its retired secrets with the engine's scripts, never with `cf` by hand. Each instance's deploy did both, and unit 5 removed that step once every instance had run it.
- [x] Update CI's instance secrets (`MINERVA_CI_*_ENV`) to drop the retired settings.
- [x] Ask the owner, then reset production with `node scripts/reset.ts --instance minerva-cf --production --yes`. Delete `minerva-cf-files` by hand after asking, since the reset touches only the app Worker. Production's deploy deleted it instead, as on the other instances.
- [x] Update README.md, AGENTS.md (settings and secrets tables, Starting the app, Checks, Frontend), ARCHITECTURE.md (the Workspace object, the start and revocation sections that describe it, open questions 4 and 6 now moot), cloudflare/README.md (`files-worker`, the suites table) and docs/connectors.md (client setup lives in Laravel).
- [x] The README says what the public repository is now, the engine alone, since the product moved to the private app (open question 3).

**You see.**

- [x] `scripts/reset.ts`'s stray-namespace check passes on every instance. `GET /internal/v1/catalog` on production answers. Staging's reset stops before its stray check on a bucket's CORS policy, so its namespace listing stood in; CI's check is the deploy's guard. Production's catalog answers 404 `NOT_FOUND`, since production has no internal settings (chunk-13c-design.md, open question 1).

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] The probe's "every migration" check passes with `0013`. Run `pnpm test:platform`.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. A turn from Laravel's staging through `minerva-cf-staging` after the tombstone deploy calls a connector, and an older staging conversation still lists its folder and downloads a file. The owner checked it after the drop's deploy (A12), so it covers both deploys: a new chat called the GitHub connector, and staging's logs show the turn with no error beyond the scripts' reset notice that predates 13c. No older conversation was downloaded after 13c; the namespace and recovery-index digests before and after A8 and A12 stand for them.
- [x] CI's account job is green on `minerva-cf-ci`.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] None beyond 13b's. Record that here. Startup CPU and the bundle were measured against `604bd00` and neither grew (chunk-13c-design.md, Verification).

**Review.**

- [x] The owner approved the production reset and the deletions on the account.

## Make usage exact (chunk 14a)

Built 2026-10-16 (`1494b29` to `4b81bdd` in the engine, then these docs; `4f1d034` and `858f785` in the app). The design, its amendments and what each unit built are in [chunk-14a-design.md](chunk-14a-design.md). test:faults went from 32 cases to 33 (a crash mid-stream) and passed at `4b81bdd` on `minerva-cf-test`, and the perf probe found no cost it could resolve. The live boxes that need staging wait for the engine's deploy to `minerva-cf-staging` and the owner's turns; production gets the app first, then the engine, with the owner's approval.

**Depends on.** Chunk 13c.

A budget is only as good as the usage it settles from. Today a model call's usage is written through `ctx.waitUntil` outside any transaction (`conversation.ts`, `settled`), so an eviction can lose it and a `run.usage` fact can land after `run.finished`. A call with no reported usage writes no fact (`settleModelCall` only counts it in `unmetered_model_calls`), and a call the provider refused is counted but never settled. Nothing tells Laravel that every call of a run has settled.

**Build.**

- [x] Record each model call durably before it is sent, outside pi's transactions. The record holds a call id made before the send (today `tokenHex(4)` is made after `host.counted` in `model/provider.ts`, and counting updates only an aggregate), the route, and the amount 14b reserves for it. An eviction during the provider's answer then leaves a record that names the call. `fb9edd2`: Conversation migration 9 (`call_records`), written through `outside` in one change with the fence check and `model_calls`.
- [x] Settle that record before the call's `done` reaches pi (today `done` is forwarded before `host.settled`). Every recorded call ends as reported usage, refused before an answer, or unmetered. On restart, records left unsettled are settled as unmetered. `fb9edd2` holds the terminal event until the settlement commits; `353d08b` settles records a gone instance left open as `unmetered`, cause `lost`.
- [x] Add the fact for an unmetered call (credentials-and-facts.md defers it here). It carries the call's reserved amount, marked as an estimate. `run.unmetered` (`1494b29`, written from `fb9edd2`); a 4xx refusal carries zero tokens, not estimated.
- [x] Each `run.usage` fact carries the call id and the route, so Laravel can store one usage record per call (chunk 16 needs the id for Stripe's meters). `1494b29`: `provider` beside `model`, with `cacheWriteTokens` and `requestBytes`.
- [x] Add a fact `run.settled`, written once every recorded call has settled and the run's container is destroyed or its lease has lapsed. It carries the run's totals. Those are the model calls, the container seconds (from the Sandbox's `startedAt` to its destroy, or to its lease's end when a destroy failed), and the script wall time (`scripts/run.ts`). `run.finished` stays what lets the next turn start (`contract/src/internal/facts.ts`), so the transcript never waits on accounting. `48b8dc7` (the Sandbox's container spans and `seal`), `c92d0ce` (script records), `ece7d51` (the settlement job). Container time is charged per span to the earlier of its destroy and its lease plus 10 minutes, estimated when a span is open, found stopped or past that cutoff (chunk-14a-design.md, amendment 7).
- [x] Laravel stores one usage record per call, keyed by the fact's call id, instead of only the sums on `runs`. Records live in a table of their own that a conversation's or an organization's deletion does not cascade to. The app's `858f785`: `usage_records`, `run_settlements` and `write_records`, with no foreign keys, and `minerva:usage`.
- [x] Laravel applies usage and write settlements for a deleted conversation into those records, in order and with the same conflict check as other facts. Today a soft-deleted conversation still reaches `Facts::apply` (`Conversation::locked` does not look at `deleted_at`), and once its rows are gone `Facts::tombstoned` acknowledges and drops every fact. Branch on `deleted_at` instead. Transcript facts are dropped, accounting facts are kept. The app's `858f785`: one table in `Facts` by conversation state, and `deleted_conversations.facts_held` as a gone conversation's watermark.
- [x] Contract. The new fields are optional. Laravel deploys first. `1494b29` adds them; the app's staging took them (`4f1d034`, `858f785`, deployed by CI) before any engine that writes them reached staging.

**You see.**

- [ ] A turn's usage records in Laravel add up to the run's totals on `run.settled`, and a turn killed mid-stream still has one record per counted call. The fake Laravel shows both on `minerva-cf-test` (`4b81bdd`); Laravel's own records wait for the staging deploy and the owner's turns.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Platform tests evict the object between a call's answer and its settlement, refuse a call at the provider, and end a stream with no usage. Each gives exactly one settlement. Run `pnpm test:platform`. `facts.test.ts` (`fb9edd2`: a 4xx, a 502, an answer with no usage), `protocols.test.ts` (`353d08b`: an abort at `model:recorded`, `model:settle` and `model:settled`, and a throw at `model:settle`) and `settled.test.ts` (`ece7d51`).
- [x] Laravel's tests apply a usage fact for a deleted conversation and for a deleted organization. The record is kept. The app's `858f785` (`FactsTest.php`, `DeletionTest.php`).

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. `test:faults` passes. 33 cases at `4b81bdd` on `minerva-cf-test`.
- [ ] A fault test kills the object mid-stream. Laravel's staging shows one record per counted call and totals that match `run.settled`. The fault half passed on `minerva-cf-test` against the fake Laravel (`4b81bdd`): an abort at `model:delta` gave one `run.unmetered` (`lost`) for the cut call, a `run.usage` for every other counted call, and a `run.settled` that sums them, with container time above zero. A fault cannot be injected on staging, so its half is the stopped turn of the ten below, and it waits for the engine's staging deploy and the owner's turns.
- [ ] Measure ten typical turns on staging (chat only, one connector call, a script, a file upload). Record tokens, container seconds and the cost per turn at the model's list price here. This answers open question 7. Waits for the engine's staging deploy and the owner's turns (chunk-14a-design.md, Live checks); the owner chose list prices without the plan's included allowances.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Time from a model call's last token to the next pi step, and from `host.begin` to the request leaving. Rule. Each within 10 ms of `main`'s at the median. More fails, since a durable write now sits on both paths. Measured with the proxies the owner accepted (chunk-14a-design.md, amendment 13): M1, a call's terminal event to the next request's first answer, and M2, `host.begin` to its own request's first answer, since a request's departure cannot be timed inside the object. On `minerva-cf-test`, unit 3's `b84f253` and `ece7d51` interleaved twice, 100 samples a run: medians 26 and 32 ms, then 39 and 34 ms, so head minus baseline is +6 and −5 ms, within the rule. M1 and M2 were equal in every sample. The calibration, 1 MiB written before each request, put M2's median 37.5 ms above its control, so the probe sees a durable write; the two baseline runs differ by 13 ms, so it cannot resolve a cost much under 10 ms.

**Review.**

- [x] opencode reviewed the design and the diff: the design before unit 1, and the diffs of units 1 to 8, each finding checked before it was fixed or set aside. Units 9 and 10 changed no engine code and had none (the owner's rule since 2026-10-16: a diff review only for large or risky changes).

## Give each run a budget (chunk 14b)

**Depends on.** Chunk 14a.

**Decide first.** Settle each by a prototype on the test instance, and record the result in Appendix A. The design is [chunk-14b-design.md](chunk-14b-design.md).

- [x] The allowance's unit is money (owner, 2026-10-15), in micro-dollars, with a price table per route in the engine (which owns the routes), published in the catalog so Laravel shows the same prices. Tokens were rejected because models price them differently and containers and scripts are billed by time. The product may show it as credits later. The model's prices are read from models.dev at deploy, for every provider, and container and script time are in code (owner, 2026-10-16; chunk-14b-design.md, The price table).
- [x] The rule (owner, 2026-10-16): stop when spent, with no reservation per call. Before each model call the engine compares what the run has spent so far (its settled calls at the price table's rates, its container and script time so far) with its allowance, and ends the run when it is used up. A budget is therefore not a hard limit: a run can pass its allowance by what is in flight when it crosses it, and an organization its limit by that much for each run going at once (chunk-14b-design.md, Overspend). The alternatives are in Appendix B.

**Build.**

- [ ] Contract. `StartRun` gains an optional `allowance` (the unit chosen above). The engine deploys first.
- [ ] Laravel. A limit per organization, and its spend, the sum of its runs' settled charges. A start is refused before it is registered when the spend has reached the limit, with a message the chat shows; otherwise it passes what is left as the run's allowance. No new lock: under this rule a lock would not bound more, since spend changes only when a run settles (chunk-14b-design.md, Laravel).
- [ ] The engine checks each model call at its record (14a's admission point, `recordModelCall`): when what the run has spent so far has reached its allowance, the call is refused, and the run ends with a new terminal reason the chat shows ("This conversation reached its budget"). Each call is charged from its reported usage, a refused one nothing, an unmetered one the tokens 14a records for it.
- [ ] Container and script time draw on the same allowance at a rate from the price table, counted so far at each check and settled from 14a's spans and script records.
- [ ] Laravel adds a run's spend only from `run.settled` (14a), never from `run.finished` or a terminal status alone.

**You see.**

- [ ] A run given a small allowance stops with the budget reason, and the organization's spent amount equals the run's settled usage.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Engine unit tests for admission at, under and over the allowance, and for an unmetered call charged at the tokens 14a records for it. Run `pnpm test:unit`.
- [ ] Laravel's tests against a real Postgres start two runs concurrently, in different workspaces of one organization. Both are admitted with the same allowance (the overshoot the rule allows), and a start after their settled spend reached the limit is refused.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Regression against `main`. `test:faults` passes with a large allowance.
- [ ] On staging, a run with an allowance below one turn's cost stops at the budget, and its spend is added to the organization's after `run.settled`.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The admission check's added time per model call. Rule. Under 5 ms at p95. More fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Add the emergency stop (chunk 14c)

**Depends on.** Chunk 14b.

**Build.**

- [ ] Laravel's admission row. One row with a revision. Every start reads it under a shared lock in `Runs::start`, and closing it takes that row exclusively, so a start and a stop are ordered as a start and a revocation are. `leaseToken` reads it too.
- [ ] The engine answers `admission` (declared, 501 today) with a state stored in D1 with that revision, idempotent by it, and never lowered to an older one. `startRun` checks it in the Worker before `bindRun` and refuses `ADMISSION_CLOSED` (declared, raised by nothing today). The Worker reads D1 on every start. A cache in the isolate is allowed only if the perf box below fails, and then only with a lifetime the owner accepts as the stop's delay.
- [ ] The order. Closing commits Laravel's row with a cancel entry, reason `emergency_stop` (`CancelReason::EmergencyStop` exists unused), for every starting or running run, then a queued job sends `admission` closed and the cancels. The stop answers once all are acknowledged, and past a bound it answers pending, as a revocation does. Laravel fans out the cancels because it holds the run registry, and the engine's `recovery_runs` has no status to find active runs by. Reopening sends `admission` open first and commits Laravel's row only once the engine has acknowledged it.
- [ ] Laravel's admin (Filament) gets the stop and the reopen, behind the instance admin's checks. Each is logged with who and when.
- [ ] While admission is closed, `leaseToken` refuses every lease.
- [ ] Each step that can fail partway (the engine unreachable, a cancel unacknowledged) shows in Filament as pending, and the job keeps going.

**You see.**

- [ ] With two turns running on staging, the stop ends both with "Stopped." and a new message is refused until reopening.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Platform tests for a start racing a close, and a repeated `admission` with the same revision. Laravel's test races a start against the stop on Postgres.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Regression against `main`. `test:faults` passes with admission open.
- [ ] The staging scenario under You see, with a write in flight when the stop lands. The write settles and is recorded.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Time from `startRun` to its answer. Rule. Within 20 ms of `main`'s at the median, since every start now reads the admission row. More fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Bound storage (chunk 14d)

**Depends on.** Chunk 14b.

The folder already reports its absolute byte total with a revision before each growth write and after its sweep (`files/store.ts`, the `ByteCounter` port), and already enforces a per-run cap of four times the folder's size. For Laravel's conversations the counter is `UNCOUNTED` and always answers yes (`files/folder.ts`).

**Build.**

- [ ] Contract. `StartRun` gains an optional byte allowance. The engine deploys first.
- [ ] Laravel reserves an upload's bytes against the organization's storage when it presigns the PUT (`Uploads.php`), since the bytes reach R2 before any start. A start moves those bytes into the run's reservation rather than counting them twice, under the organization's lock from 14b. Uploads keep their per-file, per-message and per-user limits.
- [ ] Count what the folder counts. Retained versions, loose blobs during a copy, and sizes rounded to the folder's pages (`files/limits.ts`). Write the rule into the design before building.
- [ ] Replace `UNCOUNTED` for Laravel's conversations with a counter that enforces the run's allowance before each write.
- [ ] Report a conversation's retained bytes with a fact that has no run, since a sweep or a deletion happens outside one. Every fact names a run today (`contract/src/internal/facts.ts`), so this is a new envelope or a nullable run. Laravel deploys first.
- [ ] Laravel settles the organization's storage from the latest revision it applied, never from a sum of changes.

**You see.**

- [ ] An upload that would pass the organization's storage is refused with a message, and deleting files lowers the settled total after the next sweep.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Platform tests for a checkpoint refused at the allowance, and two storage facts applied out of order (the higher revision wins).

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Regression against `main`. `test:faults` passes.
- [ ] On staging, a script that writes past the allowance fails with the folder's full error, and the settled total matches the folder's listing.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Checkpoint time for 500 files. Rule. Within 5% of `main`'s. More fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Retain and delete in the engine (chunk 15a)

**Depends on.** Chunk 14a.

Today the engine prunes only `start_keys`, answered `internal_starts`, and folder versions and blobs through its sweep. Facts, run events, run inputs, pi's tables, the write ledger and page tokens grow forever, and a deleted conversation keeps all of them. `destroy()` wipes an object's storage, which would also delete unacknowledged facts and the dedupe records.

**Build.**

- [ ] Prune on the object's alarm, by the periods recorded under Arm the program. Run events, run inputs and snapshots, attempts and tool bookkeeping after the run's retention period. Facts only once acknowledged and older than the restore window. The write ledger and page tokens once no run that could resume needs them.
- [ ] Record the floor (the lowest fact retained). `replayFacts` with an `after` below it is refused with a new error naming the floor, instead of a page that silently starts later. The delivery's gap path (`conversation/facts.ts`) refuses a watermark below the floor the same way. Laravel deploys first.
- [ ] pi's tables. Measure their growth per run on the test instance first (ARCHITECTURE.md open question 3; pi-durable 1.2.0 has no delete call). Then either delete a finished run's `pi_*` rows by its session, proved safe by a test that resumes another run afterwards, or wait for pi-durable's API and record the growth as a risk.
- [ ] Physical deletion of a deleted conversation after the restore window, and only once every fact is acknowledged. Delete its R2 prefix (`deletePrefix`), then `destroy()` the object. Its row in `recovery_conversations` stays, with `deleted_at`, so a late command is still refused.
- [ ] Add a lifecycle rule or a sweep for staging uploads no start used, if the `uploads/` rule does not already cover Laravel's staging keys.

**You see.**

- [ ] On the test instance with the periods set to minutes, a finished conversation's run events are gone and its facts remain until acknowledged. A deleted one's blobs and object are gone after the window.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Platform tests. Pruning never removes an unacknowledged fact. A replay below the floor is refused. A deleted conversation with unacknowledged facts is not destroyed. A start for a destroyed conversation is refused.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Regression against `main`. `test:faults` passes.
- [ ] A fault test kills the object mid-prune. The next alarm finishes and nothing unacknowledged is lost.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. One alarm's prune on a conversation of 1,000 runs, and the object's storage before and after. Rule. Under 1 s of wall time, and the storage after is under 10% of before. Either failing fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Retain and delete in Laravel (chunk 15b)

**Depends on.** Chunk 14a.

**Build.**

- [ ] Delete a deleted conversation's rows (the conversation, messages, runs, facts) after the restore window, once the engine acknowledged its deletion. Keep the usage records and write settlements under their own retention.
- [ ] Delete an organization and a workspace on their own, by the same path. Each conversation goes through `deleteConversation`, each connection is revoked, and the usage and audit records stay. Account deletion uses it for the organizations that leave with the account, instead of cascading their runs away.
- [ ] An audit log of changes of authority, deletions and the emergency stop, kept under its own retention. Filament reads it.
- [ ] Delete staging uploads no run took, with their R2 objects, as the sweep does today.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Tests for an organization's deletion with a run in flight, a late usage fact after it, and the rows left after the window.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging, delete an organization with two conversations and a connection. Its conversations are deleted in the engine, its runs are cancelled, and its usage records remain.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The retention job's time on 10,000 deleted conversations' rows. Rule. Under a minute, in batches that hold no lock over 1 s. More fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Make a restore of Laravel safe (chunk 15c)

**Depends on.** Chunks 15a and 15b, and 14c.

**Build.**

- [ ] The restriction log. Before Laravel commits a change that reduces access, or a deletion, it appends a restriction (a removal or a layer's quarantine, by stable ids) to a log in R2 with a bucket lock. A restore applies every restriction logged after its point. Prove the bucket lock refuses an overwrite and a delete on the account first.
- [ ] Backups first. Laravel Cloud's clusters keep no point-in-time backups yet (the app's AGENTS.md). Turn them on for staging for the rehearsal, and for production before the gate. Their retention is the restore window.
- [ ] The recovery listing. Laravel sends its restored watermark per conversation in pages, and the engine answers the conversations whose `fact_seq` is above it, deleted ones included. The engine also lists the conversations of Laravel's organizations that Laravel does not name, since a conversation created after the restore point is missing from the restored database entirely. Add an index on `fact_seq` and on the organization if the listing needs them.
- [ ] Rebuild what the restore lost. Laravel refuses a fact whose run it does not hold (`Facts.php`), and the recovery index stores only a run's id, conversation, digest and time. Define how Laravel imports a conversation and its runs from replayed facts (each run marked recovered, its user and agent from the facts or the index), and add to the facts or the index whatever that import needs.
- [ ] Replay. Laravel calls `replayFacts` for each listed conversation and applies the pages. A conversation whose floor is above Laravel's watermark is reported to the operator, not silently skipped.
- [ ] The object quarantine. The operator sets it in the recovery index before restoring a Durable Object. The attempt gate in `conversation.ts`, which runs before `Harness.open`, checks it. Every restored run ends as uncertain with its writes marked possibly done. A test sends an alarm right after the restore, before the repair.
- [ ] Credentials. A restore marks every OAuth connection with a refresh token `refresh_uncertain` (the state exists, nothing sets it).
- [ ] A runbook in the app's docs that orders the steps. Close admission, restore, apply the restrictions, mark credentials, replay, reconcile usage, reopen admission.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Engine platform tests for the listing and for the quarantine's alarm. Laravel's tests apply restrictions logged after a point to a restored database.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Rehearse on staging. Run turns, remove a member, delete a conversation and start a new one, then restore Laravel's database to before all three and follow the runbook. The member stays removed, the conversation stays deleted, the new conversation and its runs are rebuilt, every fact after the point is applied once, and no run resumes during the restore.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The rehearsal's time from closing admission to reopening it. Record it here as the recovery time. No pass rule yet, since there is no target. The owner sets one from it.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Document where data is processed (chunk 15d)

**Depends on.** Chunk 15c.

- [ ] Answer open question 6 and ARCHITECTURE.md's open question 8. Where the Workers, containers, models (Workers AI, AI Gateway, each upstream), logs, backups (Laravel Cloud's and R2's) and telemetry (Nightwatch) process data, from each vendor's documents, with links.
- [ ] List the subprocessors.
- [ ] Record what Minerva may promise about EU processing (Decision 11), and what blocks a stronger promise.

**Verify.** This chunk changes no code. Its unit, live and perf boxes do not apply. The owner reviews the document.

## Bill for usage (chunk 16)

**Depends on.** The gate, and open question 7 answered.

**Decide first.**

- [ ] The owner sets plans and prices from chunk 14a's measured cost per turn.

**Build.**

- [ ] Cashier with Checkout, the Customer Portal and Stripe's webhooks, on the organization.
- [ ] Pennant for features, and quotas as numbers that feed 14b's budgets and 14d's storage.
- [ ] Usage into Stripe's meters from chunk 14a's records, with each record's id as the event's identifier, sent by a queued job that retries until Stripe answers.
- [ ] Define payment failure, grace, cancellation, plan changes and late usage. Late usage after a cancellation is billed on the final invoice or written off, by the owner's rule.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Tests that send the same usage record twice, and replay a webhook twice. Each is counted once.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging with Stripe's test mode, subscribe, run turns, and see the meter's total equal the usage records. Fail a payment and see the grace rule applied.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Delay from `run.settled` to the meter event in Stripe. Rule. Under five minutes at p95. More fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Let organizations limit connections (chunk 17)

**Depends on.** Chunk 13c.

Laravel already stores the account's tenant (`connections.account_tenant`, from `describeAccount`), and the engine reports none yet.

**Build.**

- [ ] Each connector declares its tenancy in the catalog. One tenant per account (Google's `hd`, Microsoft's `tid`, Slack's team), a tenant per resource (Atlassian by each site's cloud id, GitHub by each repository's current owner, following transfers), or unknown.
- [ ] `describeAccount` returns the tenant where the connector knows one.
- [ ] Laravel stores an organization's policy (the connectors it offers, the tenants it allows) and checks it at the OAuth callback.
- [ ] The policy is a raw authority input in `startRun`, `listResources` and `checkGrantEdit`, compiled by the engine with the layers (Decision 3), so the engine checks tenants in resource discovery, in the grant editor, before each call and on the call's results. The engine deploys first.
- [ ] A grant edit commits only while the policy's revision is the one checked, as it does for the layer's revision (chunk 11).
- [ ] A policy that narrows cancels the runs holding an affected connection, as a revocation does.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Engine unit tests per tenancy kind, a GitHub repository transferred to another owner included. Run `pnpm test:unit`.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Regression against `main`. `test:faults` passes with no policy.
- [ ] On staging, an organization that allows one GitHub owner sees a repository of another owner refused in the grant editor and in a turn.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The tenant check's added time per connector call. Rule. Under 5 ms at p95 when no extra provider call is needed. More fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Search the transcripts (chunk 18)

**Depends on.** Chunk 12.

**Build.**

- [ ] Scout with its database engine on Postgres's full-text search over messages, indexed as facts apply them.
- [ ] Results only from conversations the user can open, never a deleted one, scoped to the organization and workspace in the query itself, not by filtering afterwards.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Tests that another member's, another workspace's and a deleted conversation's messages never appear.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging, find a word from an earlier turn, then delete that conversation and see it gone from the results.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Query time on 1,000,000 seeded messages. Rule. Under 200 ms at p95. More fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] product-and-engine.md's status line and ARCHITECTURE.md describe the engine as built.

## Appendix A. Prototype evidence

- **Read in the code on 2026-10-15**, for this plan. The engine's old paths and what the internal path borrows from them. Its usage, admission, storage and retention. The app's run registry, facts, deletion, uploads, tenants and isolation tests.
- **opencode's review of the draft**, 2026-10-15, each finding checked against the code before folding in. 13b deleted what `deploy.ts` and `reset.ts` still build from, and 13c missed `FaultMailbox`. 14a recorded a call only after its answer, so an eviction mid-call left nothing to settle, and released budgets on `run.finished`, which also starts the next turn (now `run.settled`). 14b's estimate plus a margin was no bound, and its lock was the workspace's, not the organization's. 14c had no lock to order a start against the stop, and an unsafe cache. 14d left uploads outside the organization's storage until a start. 15c could not rebuild a conversation created after the restore point, and assumed backups that are not turned on. The deletion diagnosis missed that a soft-deleted conversation still applies facts. 17 gave the policy to starts only, not to the grant editor.
- **The budget's rule** (14b), 2026-10-16. A prototype of a per-call bound from the request's bytes read Workers AI's `glm-5.3-flash` template and tokenizer configuration and found a bound per term, subject to calibration; OpenAI's and Anthropic's formats are unpublished, so no byte bound holds there. Staging's first ten calls had 4.47 to 4.50 request bytes per reported input token. The owner then chose to stop when spent, with no per-call bound (chunk-14b-design.md).
- **Unproven.** The cost per turn (14a), pi's table growth (15a), the bucket lock (15c), and whether the faults build can host a fake Laravel (13a).

## Appendix B. Alternatives rejected

- **Deleting the old paths in one chunk.** `test:faults` reaches every real-platform turn through the Workspace object, so deleting it first would leave the engine with no end-to-end check on the account.
- **Resetting `minerva-cf-staging` with production.** It holds Laravel's staging conversations. A tombstone deploy retires the class without losing them.
- **The engine finding active runs for the emergency stop.** `recovery_runs` has no status, and Laravel's registry already knows every run that is starting or running.
- **Reserving each model call at its full worst case.** About 136,000 tokens a call makes any allowance small enough to matter useless; at the models' real windows, about $0.16 a call on production's and $2 on staging's.
- **A reservation per call bounded by the request's UTF-8 bytes** (14b's first recommendation). Rejected by the owner (2026-10-16).
- **Counting tokens exactly with the route's tokenizer before each call** (14b). Possible only where the tokenizer and the server's template are published, and a provider's own count is a round trip per call.
- **Reserving each run's allowance against the organization's budget under a lock** (14b). It would make an organization's limit nearly hard, but the owner chose the simpler rule; it remains the next step if one is wanted.
- **Usage only as sums on the run row.** Stripe's meters need an id per record, and a deletion cascades the run away.

## Appendix C. Risks

- **The fake Laravel in the faults build** is test code in a deployed Worker. Only the test build includes it, as `FAULT_PROVIDER` today (13a).
- **The tombstone deploy on staging** is the first time a Durable Object class is retired on an instance that is not reset (13c).
- **Settling usage on the stream's path** adds a durable write per model call (14a). Its perf box watches it.
- **pi's tables cannot be deleted** with pi-durable 1.2.0 (15a). If deleting rows by hand proves unsafe, they grow until pi-durable adds a call.
- **Recovery needs facts the engine keeps** (15c). Rebuilding a conversation created after the restore point depends on what the facts and the recovery index record about its runs.
- **A restore older than the facts' floor** cannot be reconciled from the engine (15c). The restore window and the retention of facts must be set together.

## Appendix D. Links and reading list

- [product-and-engine.md](product-and-engine.md), Decisions 4 to 8, and Deletion, retention and recovery.
- [credentials-and-facts.md](credentials-and-facts.md), for facts, delivery and replay.
- [start-and-cancel.md](start-and-cancel.md), for the recovery index.
- [ARCHITECTURE.md](../../ARCHITECTURE.md), Attempts and recovery, Files, Open questions 3, 5 and 8.
- In `minervacomputing/app`, `docs/plans/turn.md`, `conversations.md` and `grants.md`.
- [after-the-plan.md](after-the-plan.md), which starts from this plan's end.
