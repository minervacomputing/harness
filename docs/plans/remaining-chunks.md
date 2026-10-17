# Finish the product plan (chunks 13 to 18)

Status is proposed, as of 2026-10-15. It turns chunks 13 to 18 of [product-and-engine.md](product-and-engine.md) into checklists, from what the engine and `minervacomputing/app` hold after chunk 12. That plan's Decisions and its section on deletion, retention and recovery still hold. Where this file is more specific, it wins.

The engine loses everything Laravel replaced (13a to 13c). Runs then get a budget the engine enforces and Laravel settles, and an emergency stop (14a to 14d). Deleted data then leaves both sides on a schedule, and a restore of Laravel is rehearsed (15a to 15d). Billing (16), connection policies (17) and search (18) follow. Chunks 14 and 15 and the isolation gate stand between Minerva and any customer's data.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a test run, or a commit. The body is a how-to. The appendices explain and record.

The program runs as product-and-engine.md's chunks do, not as a pstack execution playbook, since this repository has no pull requests. A chunk starts with a fresh agent that reads this plan and its chunk, writes a short design where the chunk leaves choices open, has opencode review it, implements, runs the checks, has opencode review the diff and commits to `main` (engine) or to `minervacomputing/app` (Laravel). A unit of work runs `pnpm check` (cloudflare/README.md, Checks), commits and pushes, and does not wait for CI. A chunk starts once the chunks its order line names are done (Order and dependencies, below), so "15a and 15b after 14a, beside 14b to 14d" starts 15a and 15b when 14a is done, while 14b to 14d still run. Its design may be written before then. The owner approves anything that touches production or the account, per AGENTS.md.

Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked. "Live" means the account suites against the test instance for the engine, and turns on staging for Laravel. The pstack template's ten screenshot lanes are not used. Each chunk names the scenarios its live check must pass instead. Each perf box measures `main` first, then the head, with the same probe run interleaved on the same instance. A perf probe is debugged at a small size and run at full size only for the numbers a box records. The full account suites run once per chunk, in `account.yml` (`gh workflow run account.yml --ref main`), for the chunk's "Regression against `main`" box and before a deploy.

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
- [ ] Check that Laravel Cloud's point-in-time backups can be kept 7 days on staging's and production's plans. Record the plan and its retention here. A shorter retention shortens the window. Laravel's documents allow 0 to 30 days per Serverless Postgres cluster on every plan, so 7 days fits ([data-processing.md](../data-processing.md), Backups and the restore window). Both clusters keep 0 days today (2026-10-17), so the restore window is 0 days until they are set. Left for the owner: confirm the plan in the dashboard (probably Starter), set 7 days on both clusters, and record the plan and the retention read back here.
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
- [ ] Before open sign-up, on top. Starting a run (`conversations.store`, `conversations.message`) gets a rate limit per user and per organization, since it has none today. The cost per turn is measured (open question 7). A removed upload stays counted among its user's waiting uploads until its PUT's URL has expired, so a member cannot write staged objects past that limit (chunk-14d-design.md, owner question 6).

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

- [x] A turn's usage records in Laravel add up to the run's totals on `run.settled`, and a turn killed mid-stream still has one record per counted call. The fake Laravel shows both on `minerva-cf-test` (`4b81bdd`). On the app's staging, 2026-10-17, `minerva:usage --since=2026-10-16T18:00:00Z` checked 18 runs, the ten turns below among them, every one `ok`: records adding up to `run.settled`, one record per counted call, and the stopped turn with one estimated `run.unmetered` record.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Platform tests evict the object between a call's answer and its settlement, refuse a call at the provider, and end a stream with no usage. Each gives exactly one settlement. Run `pnpm test:platform`. `facts.test.ts` (`fb9edd2`: a 4xx, a 502, an answer with no usage), `protocols.test.ts` (`353d08b`: an abort at `model:recorded`, `model:settle` and `model:settled`, and a throw at `model:settle`) and `settled.test.ts` (`ece7d51`).
- [x] Laravel's tests apply a usage fact for a deleted conversation and for a deleted organization. The record is kept. The app's `858f785` (`FactsTest.php`, `DeletionTest.php`).

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. `test:faults` passes. 33 cases at `4b81bdd` on `minerva-cf-test`.
- [x] A fault test kills the object mid-stream. Laravel's staging shows one record per counted call and totals that match `run.settled`. The fault half passed on `minerva-cf-test` against the fake Laravel (`4b81bdd`): an abort at `model:delta` gave one `run.unmetered` (`lost`) for the cut call, a `run.usage` for every other counted call, and a `run.settled` that sums them, with container time above zero. A fault cannot be injected on staging, so its half is the stopped turn of the ten below: one counted call with one estimated `run.unmetered` record (128,000 input and 8,192 output tokens, the route's limits) and a `run.settled` that matches it, `ok` in `minerva:usage` (2026-10-17).
- [x] Measure ten typical turns on staging (chat only, one connector call, a script, a file upload). Record tokens, container seconds and the cost per turn at the model's list price here. This answers open question 7. Measured 2026-10-16 and 17 on the app's staging, which runs OpenAI `gpt-6.1-sol`; the dollars are at models.dev's list prices (gpt-6.1-sol $2 input, $0.10 cached, $2.50 cache write, $10 output per million tokens; `@cf/zai-org/glm-5.3-flash` $0.15, $0.03 cached, $0.50 output), and container and script time at the prices in `src/budget/prices.ts`. The GLM column prices the same tokens, as an estimate of production: GLM's tokenizer and answers differ. The charged runs (since 14b) match the computed cost to the micro-dollar.

  | Turn | Calls | Input (cached, cache writes) | Output | Container, scripts | gpt-6.1-sol | GLM estimate |
  |---|---|---|---|---|---|---|
  | Chat ×3 | 1 | ~6,975 (0, ~6,972) | 10–63 | 2.7–3.3 s | $0.018 | $0.0011 |
  | Script ×2 | 2 | ~14,050 (~6,980, ~7,070) | 71–131 | 6.2–6.5 s, 1 script ~1 s | $0.021–0.022 | $0.0035 |
  | GitHub ×2 (list repositories) | 2 | ~14,240 (6,966, ~7,270) | 191–287 | 7.7–9.7 s, 0–1 script | $0.021–0.024 | $0.0016–0.0037 |
  | Image upload ×2 (read) | 3 | 24,828 (14,075, 10,744) | 80–94 | 8.7–10.1 s | $0.029 | $0.0023 |
  | Stopped mid-answer | 1 | 128,000 estimated | 8,192 estimated | 2.9 s | $0.338 | $0.023 |

  **The cost per turn:** about $0.02 on gpt-6.1-sol and $0.002 on GLM for the nine turns that ended, $0.054 and $0.0043 with the stopped one. Containers cost under $0.0003 a turn; a script adds $0.002. Two findings: every turn writes its ~7,000-token prefix to the cache and no turn reads another conversation's (cached 0 on each turn's first call), which is most of a chat turn's cost on gpt-6.1-sol; and a stopped call is charged at the route's limits, 15 typical turns on gpt-6.1-sol, since its usage never arrives.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Time from a model call's last token to the next pi step, and from `host.begin` to the request leaving. Rule. Each within 10 ms of `main`'s at the median. More fails, since a durable write now sits on both paths. Measured with the proxies the owner accepted (chunk-14a-design.md, amendment 13): M1, a call's terminal event to the next request's first answer, and M2, `host.begin` to its own request's first answer, since a request's departure cannot be timed inside the object. On `minerva-cf-test`, unit 3's `b84f253` and `ece7d51` interleaved twice, 100 samples a run: medians 26 and 32 ms, then 39 and 34 ms, so head minus baseline is +6 and −5 ms, within the rule. M1 and M2 were equal in every sample. The calibration, 1 MiB written before each request, put M2's median 37.5 ms above its control, so the probe sees a durable write; the two baseline runs differ by 13 ms, so it cannot resolve a cost much under 10 ms.

**Review.**

- [x] opencode reviewed the design and the diff: the design before unit 1, and the diffs of units 1 to 8, each finding checked before it was fixed or set aside. Units 9 and 10 changed no engine code and had none (the owner's rule since 2026-10-16: a diff review only for large or risky changes).

## Give each run a budget (chunk 14b)

Built 2026-10-16 (`55bcd78` to `98d4f15` in the engine, then `8ad74ee`, `9f9929a` and these docs; `b5c1faa` and `ef6429f` in the app, on its `chunk-14b` branch until the engine is deployed to `minerva-cf-staging`). The design, its amendments and what each unit built are in [chunk-14b-design.md](chunk-14b-design.md). test:faults went from 33 cases to 34 (a run stopped at its budget) and passed at `98d4f15` on `minerva-cf-test`, and the perf rule is met by the Node benchmark the owner accepted. The live boxes wait for the engine's deploy to `minerva-cf-staging` (the owner approves it), then the app's push and the owner's go for a staging turn; production gets the engine first, then the app, with the owner's approval.

**Depends on.** Chunk 14a.

**Decide first.** Settle each by a prototype on the test instance, and record the result in Appendix A. The design is [chunk-14b-design.md](chunk-14b-design.md).

- [x] The allowance's unit is money (owner, 2026-10-15), in micro-dollars, with a price table per route in the engine (which owns the routes), published in the catalog so Laravel shows the same prices. Tokens were rejected because models price them differently and containers and scripts are billed by time. The product may show it as credits later. The model's prices are read from models.dev at deploy, for every provider, and container and script time are in code (owner, 2026-10-16; chunk-14b-design.md, The price table).
- [x] The rule (owner, 2026-10-16): stop when spent, with no reservation per call. Before each model call the engine compares what the run has spent so far (its settled calls at the price table's rates, its container and script time so far) with its allowance, and ends the run when it is used up. A budget is therefore not a hard limit: a run can pass its allowance by what is in flight when it crosses it, and an organization its limit by that much for each run started before earlier runs settled (chunk-14b-design.md, Overspend and The overshoot). The alternatives are in Appendix B.

**Build.**

- [x] Contract. `StartRun` gains an optional `allowance` (the unit chosen above). The engine deploys first. `55bcd78`, with the money fields on the facts and the catalog's `prices`, all optional; the app synced it in `b5c1faa`, which stays off its main until the engine is on staging.
- [x] Laravel. A limit per organization, and its spend, the sum of its runs' settled charges. A start is refused before it is registered when the spend has reached the limit, with a message the chat shows; otherwise it passes what is left as the run's allowance. No new lock: under this rule a lock would not bound more, since spend changes only when a run settles (chunk-14b-design.md, Laravel). The app's `ef6429f`, on its `chunk-14b` branch: a limit per calendar month in UTC (owner, 2026-10-16), $5 by default, set with `minerva:budget`; "Your organization has used its budget." at or over it.
- [x] The engine checks each model call at its record (14a's admission point, `recordModelCall`): when what the run has spent so far has reached its allowance, the call is refused, and the run ends with a new terminal reason the chat shows ("This conversation reached its budget"). Each call is charged from its reported usage, a refused one nothing, an unmetered one the tokens 14a records for it. Charges in `ce1449e` (prices from models.dev at deploy, migration 12, money on the facts); the check and `budget_reached` in `98d4f15`, which also settles a gone instance's open records before it counts.
- [x] Container and script time draw on the same allowance at a rate from the price table, counted so far at each check and settled from 14a's spans and script records. Rates and charges in `ce1449e`; counted so far at the check (open scripts, and container time from `container_since`, set before the Sandbox is asked for a container) in `98d4f15`.
- [x] Laravel adds a run's spend only from `run.settled` (14a), never from `run.finished` or a terminal status alone. The app's `ef6429f`: spend is the sum of `run_settlements.charged_micros` this month; a settlement without money for a run given an allowance counts at the allowance.

**You see.**

- [x] A run given a small allowance stops with the budget reason, and the organization's spent amount equals the run's settled usage. The engine's half passed on `minerva-cf-test` against the fake Laravel (`98d4f15`). On Laravel's staging, 2026-10-16: the chat showed "This conversation reached its budget.", and the organization's spend this month went from 17,905 to 37,661 µ$, by exactly the run's `chargedMicros` (19,756).

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Engine unit tests for admission at, under and over the allowance, and for an unmetered call charged at the tokens 14a records for it. Run `pnpm test:unit`. `conversation-admission.test.ts` (9 tests, `98d4f15`) and `conversation-charges.test.ts` (5, `ce1449e`), with `model-prices.test.ts` and `budget-prices.test.ts`; 2,713 unit tests and 329 platform tests passed at `9f9929a`.
- [x] Laravel's tests against a real Postgres start two runs concurrently, in different workspaces of one organization. Both are admitted with the same allowance (the overshoot the rule allows), and a start after their settled spend reached the limit is refused. The app's `ef6429f`: `BudgetRacesTest.php` (2 tests, separate processes on Postgres, with a settlement committed between a start's read and its commit), and `BudgetsTest.php` (11).

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. `test:faults` passes with a large allowance. 34 cases at `98d4f15` on `minerva-cf-test`, the driver giving every other start 10^12 µ$, the small-allowance case among them.
- [x] On staging, a run with an allowance below one turn's cost stops at the budget, and its spend is added to the organization's after `run.settled`. 2026-10-16, the engine at `d09fbf1` on `minerva-cf-staging` and the app at `ef6429f`: `minerva:budget` set the organization's limit 1,000 µ$ above its spend; a `minerva:turn` asking for a script made one call (6,979 input tokens), ran its script, and ended `failed` with "This conversation reached its budget." at its second call; `minerva:usage` checked the run `ok`, charged 19,756 µ$ (the stated overspend: the call in flight, its script and the container); the next start was refused with "Your organization has used its budget."; the limit was then put back to the default. A smoke turn before it was charged 17,905 µ$ for one call on OpenAI `gpt-6.1-sol` (mostly 6,966 cache-write tokens at $2.50 a million).

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. The admission check's added time per model call. Rule. Under 5 ms at p95. More fails. On `minerva-cf-test` the probe's two baselines differed by 21 ms at p95, too noisy to judge, so by the owner's answer the Node benchmark decides (`8ad74ee`): `recordModelCall` over node:sqlite, 3,600 calls, p95 35.7 µs without an allowance and 43.8 µs with one, about 10 µs a call (chunk-14b-design.md, Perf probe and rule).

**Review.**

- [x] opencode reviewed the design and the diff. The design twice (chunk-14b-design.md, Amendments after opencode's review) and the diffs of units 1 to 4, each finding checked before it was fixed or set aside: unit 1, money fields sent in part and a refused call with a cost (both refused by the schema now); unit 2, none that held (the deployed fault build already runs the fake route); unit 3, a resumed attempt admitted before a gone instance's call was charged (fixed, As built (unit 3)); unit 4, `minerva:usage` not comparing calls' costs with `modelMicros` and passing partial money (both fixed). Unit 5 changed docs only and had none.

## Add the emergency stop (chunk 14c)

**Depends on.** Chunk 14b.

The stop is Laravel's alone, with no engine change (owner, 2026-10-16). The design, what it does not cover and the units are in [chunk-14c-design.md](chunk-14c-design.md).

**Build.**

- [x] The rule (owner, 2026-10-16): a flag in Laravel that `Runs::start` and `leaseToken` read, and a stop that cancels every starting or running run through the existing cancel path. The engine keeps no admission state; `admission` and `ADMISSION_CLOSED` stay declared and unused (chunk-14c-design.md, The contract). The engine-side admission is in Appendix B.
- [x] Laravel's admission row. One row, first in `turn.md`'s lock order, and an append-only record of each stop and reopen with who and when, written in the change's transaction. `Runs::start` reads the row `FOR SHARE` before the user's lock and refuses a start while it is closed; the stop takes it `FOR UPDATE`, so a start and a stop are ordered as a start and a revocation are. In the app's `ff01764` (`App\Runs\Admission`, migration `admission` and `admission_changes`).
- [x] The stop. Close the row in a short transaction of its own, then request the cancel of every starting or running run, a conversation per transaction, with `CancelReason::EmergencyStop`; then send and wait for every unacknowledged cancel, whatever its reason. While the row is closed the sweep requests the cancels a stop that died partway left, and a second stop is idempotent. Reopening opens the row and sends nothing to the engine. In `ff01764`.
- [x] `SendStart` holds a start back while its run's cancel is unacknowledged, so a start not yet sent reaches the engine after its cancel. In `ff01764`, which also holds it while the row is closed and its run has no cancel yet.
- [x] While the row is closed, `leaseToken` refuses every lease (`RUN_NOT_ACTIVE`). In `ff01764`.
- [x] Laravel's admin (Filament) gets the stop and the reopen on a page of their own, behind the instance admin's checks, and `minerva:stop` does the same from the console. `minerva:stop` in `ff01764`; the page, `App\Filament\Pages\EmergencyStop`, in `6f97844`.
- [x] The page and the command show what is pending (every unacknowledged cancel, runs not yet ended, conversations whose facts are stopped), while the jobs and the sweep keep sending. `Admission::pending()`, one query for both; the page refreshes every five seconds while anything is pending.

**You see.**

- [x] With two turns running on staging, the stop ends both with "Stopped." and a new message is refused until reopening. On the app's staging at `6f97844`, 2026-10-17: two `minerva:turn`s each running a 120 s `sleep`, then `minerva:stop --reason=…`. Both runs ended `cancelled` with "Stopped." and `error_code = emergency_stop`, their cancels acknowledged within a second of the stop (`run_cancels`: requested 06:17:53, acknowledged 06:17:53 and 06:17:54 UTC). A third `minerva:turn` was refused with "Minerva has stopped all agents for now. Try again later."; `minerva:stop --reopen`, then a turn completed. `admission_changes` holds the stop and the reopen.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Pest tests for a start and a lease refused while stopped, a stop that cancels every active run across organizations and waits for an orphaned cancel, a stop that failed partway finished by the sweep, `SendStart`'s hold, a repeated stop, and a reopen. Laravel's race test runs a start against the stop on Postgres in separate processes, both orders. `tests/Feature/Runs/EmergencyStopTest.php` (19 tests, `minerva:stop`'s output and exit codes included) and `tests/Concurrency/AdmissionRacesTest.php` (2) in `ff01764`; the page's Livewire tests (`tests/Feature/Admin/EmergencyStopPageTest.php`, 3: a non-admin's 404, Stop's required reason and its pending runs while the engine does not acknowledge, Reopen with its pending count) in `6f97844`. The app's suite passed locally against Postgres at `6f97844`: 745 Pest tests, PHPStan, Pint, and the front end's checks and 28 Vitest tests.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. The engine does not change, so `test:faults` is not run for this chunk; the app's suite passes (745 at `6f97844`, above).
- [x] ~~The staging scenario under You see, with a write when the stop lands. Its fact is recorded in Laravel; the write in flight completing through a cancel is the engine's `protocols.test.ts` case (chunk-14c-design.md, Live checks).~~ Dropped by the owner, 2026-10-17: not run.
- [x] ~~The page's Stop and Reopen, clicked once on staging by an instance admin (the owner, who has the two factors there).~~ Dropped by the owner, 2026-10-17: not run.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. The engine's start path is unchanged, so `Runs::start`'s time is measured instead, locally against Postgres, base and head interleaved. Rule. Within 20 ms of the base's at the median. More fails. 500 starts a run with `Bus::fake()`, base `ef6429f` and head `ff01764` interleaved twice: pooled medians 6.774 ms and 7.155 ms, +0.381 ms; again in the reverse order on a fresh database, 6.727 ms and 7.334 ms, +0.607 ms.

**Review.**

- [x] opencode reviewed the design and the diff. The design (chunk-14c-design.md, Amendments after opencode's review) and unit 1's diff, each finding checked: a queued start reaching the engine after the close (fixed: `SendStart` holds while the flag is closed and its run has no cancel), a scan overtaken by a reopen cancelling a newer run (fixed: the flag is read again under each conversation's lock), a partial stop reported as done (fixed: `minerva:stop` lists runs with no cancel and exits non-zero), reopening after a partial stop (left to the admin, now visible), and one held lock delaying later cancels (set aside: the sweep and a second stop finish them). Unit 2 added the page and docs and had none.

## Bound storage (chunk 14d)

**Depends on.** Chunk 14b.

The engine reports a conversation's stored bytes at the end of each run, and Laravel sums them per organization and refuses uploads and turns over its limit, with no engine check (owner, 2026-10-16). The limit is an allowance for live conversations' files, not a hard bound: it can be passed by about two folders for each run in flight plus the uploads in flight. The design, what it does not cover and the units are in [chunk-14d-design.md](chunk-14d-design.md).

**Build.**

- [x] The rule (owner, 2026-10-16): report at the end of each run, refuse in Laravel. No reservation per upload, no byte allowance on `StartRun`, no counter enforced in the engine (`UNCOUNTED` stays), and no fact without a run. The plan's version is in Appendix B.
- [x] Contract. `run.finished` gains an optional `storedBytes`: the sum over the conversation's `stored` blobs of each size rounded up to whole pages (`files/limits.ts`), read in `finish`'s transaction after `publish`. Loose and doomed blobs are left out. Laravel deploys first. `9770d41`; the app synced it (`3dd47f1`) and reached staging (`1c522ed`) before the engine.
- [x] The engine. `publish` returns the number, and `run.finished` carries it; a sum that throws leaves the field out, and the run still ends. `9770d41`, with conversation migration 13 (`88612a7`): a partial index on stored blobs' sizes, which the sum reads alone.
- [x] Laravel. `conversations.stored_bytes` from each `run.finished` that has the field (facts are applied in order, so the latest wins); an organization's storage is the sum over its conversations not deleted, against `organizations.storage_limit_bytes` or the default. `Runs::start`, after the conversation's lock, and `Uploads::reserve` refuse at or over the limit with a message the chat shows. `minerva:storage` shows and sets the limit. The per-folder, per-file, per-message and per-user limits stay. The app's `1c522ed`: 5 GiB per organization by default (`MINERVA_STORAGE_LIMIT_BYTES`).

**You see.**

- [x] Over its organization's limit, a turn and an upload are refused with the storage message; deleting a conversation lowers the organization's storage at once. A turn that deletes a file leaves the number unchanged, since the earlier version keeps it. On staging, 2026-10-17 (Verify, live).

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Engine unit tests for the number (distinct contents once, pages, unnamed and loose blobs left out, a deleted file still counted) and a platform test of `run.finished`'s `storedBytes`. Pest tests for both refusals, the number applied from facts (absent keeps the last, zero replaces it), a deleted conversation not counted, and `minerva:storage`. Engine (`9770d41`, `88612a7`): 9 unit tests in `files-store.test.ts` (one checks with EXPLAIN QUERY PLAN that the sum reads the index alone, after migrating an object from step 12), `conversation-finished.test.ts`, and platform tests in `files.test.ts` (two attachments report 12,288, a second run that adds nothing the same) and `facts.test.ts` (`storedBytes: 0`); 2,724 unit and 330 platform tests pass. App (`1c522ed`): `StorageTest.php` (11), the presign refusal in `UploadsTest.php`, `minerva:storage` in `CommandsTest.php`; 765 Pest tests pass.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. `test:faults` passes. 34 cases on `minerva-cf-test` at unit 1, and `account.yml` on `88612a7`, green on its second attempt (the first timed out starting a container in `sandbox-faults.test.ts`'s restart case, code 14d does not touch).
- [x] On staging, a turn that writes a file of 10,485,760 bytes reports exactly that; with the limit reached, a turn and an upload are refused with the message; deleting the conversation lowers the total at once (chunk-14d-design.md, Live checks). 2026-10-17, the app at `1c522ed` and the engine at `88612a7`: a `minerva:turn` wrote `big.bin` (`head -c 10485760`), and `minerva:storage` showed the conversation and the organization at exactly 10,485,760. With `--limit=10485760`, a `minerva:turn` was refused with the storage message, and the owner's upload in the chat too. A turn in the same conversation that ran `rm big.bin` left the number at 10,485,760, as designed. The owner deleted the conversation, and the organization's storage read 0 at once; a turn was then admitted under the same limit, and `--default` put the limit back.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. The checkpoint does not change, so the plan's checkpoint metric is not run. Instead, `publish`'s added time over 20,000 stored blobs (a Node benchmark), and the time the sum adds to `Runs::start` and `Uploads::reserve` for an organization of 10,000 conversations. Rule. Within 5 ms of the base's, at p95 for the engine and at the median for Laravel. More fails. Engine: `publish` over node:sqlite, 1,000 interleaved runs each, p95 +0.29 ms at 20,000 stored blobs and +1.91 ms at 100,000 with migration 13's index (+4.47 ms and +36.2 ms without it). Laravel: 500 calls each, an organization of 10,000 conversations, local Postgres: `Runs::start` +0.76 ms and `Uploads::reserve` +0.85 ms at the median, an index-only scan.

**Review.**

- [x] opencode reviewed the design and the diff. The design on 2026-10-17 (chunk-14d-design.md, Amendments after opencode's review). The engine's diff: no counting bug or non-additive change; a test through the real `RunStore.finish` added, and the docs now say only a run changes which blobs are stored. The app's diff: none blocking; a test of a repeated terminal fact still setting the number added. The index (one schema step) had none.

## Retain and delete in the engine (chunk 15a)

**Depends on.** Chunk 14a.

Today the engine deletes only answered or cancelled `internal_starts` and, through its sweep, loose and doomed blobs; `start_keys` has been unused since 13b. Facts, run events, run inputs, pi's tables, the write ledger and page tokens grow forever, and a deleted conversation keeps all of them. `destroy()` wipes an object's storage, which would also delete unacknowledged facts and the dedupe records. The design, its periods and clocks, and the units are in [chunk-15a-design.md](chunk-15a-design.md). Built on 2026-10-17 (`0af3a78` to `17bc2d5`, with the app's sync of `FACTS_PRUNED`, `9eeff5e` and `6ca423f`, on its main) and verified on `minerva-cf-test`; the owner accepted the perf box on 2026-10-17 (storage net of the empty conversation's floor; a pass slowed by a platform stall recorded, not failed). `e850d65`, green on `account.yml`, was deployed with the owner's approval to `minerva-cf-staging` and then to production on 2026-10-17, production now on the staging's model (`openai` `gpt-6.1-sol`, the responses API, reasoning effort medium) with its OpenAI key stored in its gateway by the owner.

**Build.**

- [x] Prune on the object's alarm, by the periods recorded under Arm the program, in one Lifecycle job (`retain`) of bounded, idempotent steps, only while no run is active. 30 days after a run ended: its events, inputs and snapshot, attempts and tool bookkeeping, call and script records (once settled), write ledger and page tokens. The dedupe records of Laravel's commands (the run's row, its stored answer, its tombstone) stay until the object is destroyed. Facts 7 days after Laravel acknowledged them, never before. `214eb09` (`conversation/retention.ts`, conversation step 14, a pass of steps of at most 500 rows until 250 ms), `92c068a` (the runs, step 15), `3245f79`: the object's clock stands still through SQL on the platform, so a pass now syncs after each step and its budget holds (chunk-15a-design.md, Perf probe and rule, As measured).
- [x] Record the floor (the lowest fact retained, `fact_delivery.floor`). `replayFacts` with an `after` below `floor − 1` is refused with `FACTS_PRUNED` (410, `data: {floor}`), instead of a page that silently starts later. The delivery's gap path (`conversation/facts.ts`) stops on a watermark below the floor and leaves `acknowledged` as it is. Laravel deploys first. Contract `91b871c`, engine `214eb09` and `a0a84b8` (the gap's floor checked again where it is stored, and the marks Laravel lost dropped); the app synced it (`9eeff5e`) and gives the floor to `EngineRefusal` (`6ca423f`).
- [x] pi's tables. Measure their growth per run on the test instance first, with each start carrying its history (ARCHITECTURE.md open question 3; pi-durable 1.2.0 has no delete call). Then either delete a finished run's `pi_*` rows by its session, and pi conversations no run names, proved safe by tests that keep working with the same Harness open and resume another run afterwards, or record the growth as a risk and leave this box unmet. Measured at about 64 kB and 75 rows a run at the history's cap, 53% of what a run keeps (chunk-15a-design.md, pi's tables, As measured); deletion by session proved over node:sqlite with the Harness open (`0af3a78`, `test/unit/pi-tables.test.ts`) and built with the orphans' drain (`92c068a`).
- [x] Physical deletion of a deleted conversation 7 days after its deletion, and only once every fact is acknowledged and pruned. Mark `recovery_conversations.purged_at`, delete its R2 prefix (`deletePrefix`), delete its storage (`deleteAll()`), then `destroy()` the object. Its rows in the recovery index stay, so a late command is refused by the Worker without reaching the object. `3cbccb9` (D1 `0014`; `startInternal` and `cancelInternal` carry the index's `deleted`, so an object made again by a command in flight only purges itself).
- [x] Staged uploads: the `uploads/` rule already covers Laravel's keys (`uploads/<workspace>/<random>` in the engine's files bucket), so no sweep. Confirm the rule on staging's bucket. 2026-10-17: the enabled rule deleting `uploads/` at most a day after writing is on the EU files bucket of `minerva-cf-staging`, the one Laravel's staging names in `MINERVA_R2_BUCKET`, and on its other files bucket, read through `scripts/lifecycle.ts` with no problem reported.

**You see.**

- [x] On the test instance with the periods set to minutes, a finished conversation's run events are gone and its facts remain until acknowledged. A deleted one's blobs and object are gone after the window, and a late start is refused. `4ea90e7`, `test/account/retention.test.ts` in `test:faults`: with periods of a minute, the finished conversation keeps no run event, snapshot, attempt or pi entry and holds exactly the facts above Laravel's watermark; the deleted one's R2 prefix was emptied about 60 s after `deleteConversation`, its object holds none of its data and no alarm, a late `startRun` is refused `CONVERSATION_DELETED`, a `cancelRun` answers `ended`.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Unit tests: the cut from the acknowledgement marks, the gap path with a floor, the next due time, and pi's deletion over node:sqlite with the Harness kept open. Platform tests. Pruning never removes an unacknowledged fact, and keeps an acknowledged one 7 days from its acknowledgement. A replay below the floor is refused through the Worker's route. A pruned run's stream ends at once. A reset between a session's creation and its claim leaves an orphan that is drained. A deleted conversation with unacknowledged facts is not destroyed. A start for a destroyed conversation is refused, and a cancel already in flight makes only a deleted object that purges itself. `test/unit/retention.test.ts` (15, among them the pass's budget on the clock its sync moves, which fails without the sync), `facts.test.ts` (the gap with a floor), `pi-tables.test.ts` (4); 21 platform tests in `test/platform/retention.test.ts`. 2,745 unit and 357 platform tests pass at `4ea90e7`, with both typechecks and `openapi:check`.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Regression against `main`. `test:faults` passes. 36 cases in 6 files on `minerva-cf-test` at `4ea90e7` (34 before 15a, and the two of `retention.test.ts`); `account.yml` on `17bc2d5`, green (36 cases), after one failure on `4ea90e7`: the platform dropped a connection mid-start and `startRun` answered 500, which Laravel sends again and the account driver now does too (chunk-15a-design.md, Unit 5 as built).
- [x] A fault test kills the object mid-prune. The next alarm finishes and nothing unacknowledged is lost. `test/account/retention.test.ts`, "a reset after a pass's first step": an `abort` at the first `retain:step` of two finished turns, the fake Laravel holding back the second's facts; the platform's alarm retry finished both runs (`done`), the engine holds exactly Laravel's watermark + 1 to `written` with the floor at the watermark + 1, a replay from the watermark answers them all and one from 0 is refused `FACTS_PRUNED` (410) with the floor. Locally, platform tests reset after each kind of step and between `deleteAll()` and `destroy()`.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [x] Metric. Each alarm's prune on a conversation of 1,000 runs with a growing history, and on one run of about 10,000 events, and the object's storage before and after. Rule. Every alarm's prune under 1 s of wall time, and the storage after is under 10% of before. Either failing fails. Checked by the owner's reading (2026-10-17): storage after is counted net of the floor below, and a pass slowed by a platform stall is recorded, not failed (chunk-15a-design.md, Perf probe and rule, As measured; `retention-perf.test.ts`, three runs on `minerva-cf-test`). 1,000 turns: 166.9 MB to 2.39 MB (1.43%), passes at a median of 256 to 259 ms; in two runs every pass was under 1 s (at most 449 and 360 ms), in the first 2 of 385 were not (1,120 and 1,362 ms), each a pass whose storage sync waited 0.4 to 1.4 s in a stall of the platform that came about every 5 s, with 4 ms of CPU. A pass is bound by the storage's durability (CPU per alarm a median of 20 to 28 ms), and 200 or 100 rows a step changed nothing, so `rowsPerStep` stays 500. One turn of 10,000 events: 3.38 MB to 552,960 bytes (16.4%), passes at most 267 ms; 552,960 is the floor, what a conversation of one short turn keeps once pruned (pi's root and the schema's pages), so nothing of the turn is left, and the 10% cannot hold for a conversation of under about 5.5 MB. Met on that reading: net of the floor, both conversations keep under 10%, and every pass not caught in a stall is under 1 s.

**Review.**

- [x] opencode reviewed the design and the diff. The design on 2026-10-17 (chunk-15a-design.md, Amendments after opencode's review). The diffs of units 2 to 5 (Unit 2's to Unit 5's review there): the gap's floor checked again where it is stored, the marks above a lost watermark dropped, pi's abort not awaited, a command in flight to a purged object, and the test build's bounds, all built; no regression in production code at unit 5.

## Retain and delete in Laravel (chunk 15b)

**Depends on.** Chunk 14a.

Designed 2026-10-17 in `minervacomputing/app` (its `docs/plans/retention.md`, `a4ebf0e`), reviewed by opencode. The owner's questions take its defaults: owners delete a workspace (never the last), the audit log keeps ids and no names, and a deleted account's integer id stays on usage and audit records.

**Build.**

- [ ] Delete a deleted conversation's rows (the conversation, messages, runs, facts, and the uploads its runs took) 7 days after the engine acknowledged its deletion, by an hourly `minerva:retention` in transactions of at most 1,000 rows. Its tombstone stays for good, with `purged_at`. The accounting tables and the audit log are never touched.
- [ ] Delete a workspace (owners, not the last) and a team organization (owners, instance admins in Filament or `minerva:organization:delete`) by the same path. Each conversation is marked deleted and sent to the engine through the deletions' outbox, each active run cancelled, each connection revoked, and the workspace or organization soft-deleted; an organization's memberships and invitations go at once. Its own rows go once its last conversation is purged. Account deletion uses it for the organizations that leave with the account, instead of cascading, and `personal_owner_id` no longer cascades.
- [ ] An audit log (`audit_events`, ids and no names) of changes of authority (members, roles, invitations, connections, grants, agents, instance admins), deletions and the emergency stop, written in each change's transaction. 14c's `admission_changes` moves into it. Kept at least 1 year; nothing deletes it in 15b. Filament reads it. `AuditLog::removesAccess()` names the events 15c's restriction log covers.
- [ ] Staged uploads no run took: the sweep deletes their rows after a day, at most 1,000 a pass, and R2's rule on `uploads/` deletes their objects (15a). Laravel deletes no object in the sweep.
- [ ] Every foreign key has an index, checked by a test.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Tests for an organization's deletion with a run in flight, a late usage fact after it and after the purge, the rows left after the window, a tombstone's watermark that never falls, an interrupted pass, and a start and a workspace's creation racing a deletion.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging, delete an organization with two conversations and a connection. Its conversations are deleted in the engine, its runs are cancelled, and its usage records remain; and the first scheduled passes of `minerva:retention` on staging's deleted conversations, with their times.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. One pass of the retention job over 10,000 deleted conversations' rows (about 270,000) and 10 deleted organizations' configuration, beside 100,000 live conversations, locally. Rule. Under a minute, and no transaction of 1 s or more. Either failing fails.

**Review.**

- [ ] opencode reviewed the design and the diff. The design on 2026-10-17 (retention.md, Amendments after opencode's review).

## Make a restore of Laravel safe (chunk 15c)

**Depends on.** Chunks 15a and 15b, and 14c.

The design, its decisions and the units are in [chunk-15c-design.md](chunk-15c-design.md), reviewed by opencode; its owner questions take their defaults. Unit 1 (`listConversations`, `9b8864d` to `fa9b128`) is on `minerva-cf-staging` and production since 2026-10-17, deployed with the owner's approval at `e416627`, green on `main.yml` and `account.yml`.

**Build.**

- [ ] Backups. Set 7 days of point-in-time history on staging's cluster for the rehearsal, and on production's before the gate (`cloud database-cluster:update <cluster> --retention-days=7`, read back). A restore makes a new cluster, which the environment is moved onto; the old one is deleted once the recovery is complete. `minerva:recover` refuses a point older than 6 days, before the restriction log's start, or before the last restore's fence.
- [ ] The key. Production's `MINERVA_CREDENTIALS_KEY` and `APP_KEY` are backed up outside Laravel Cloud, as staging's credentials key is under Arm the program, since a restored database is useless without them. Record where (not the value).
- [ ] The restriction log. Before Laravel commits a change `AuditLog::removesAccess` names (a member's removal or lowered role, a connection's revocation or narrowed reconnection, an invitation's revocation, an admin's removal, a sign-out, two factors removed, a password reset or changed, a passkey removed, and the deletion of an account, a workspace or an organization), it writes one object of ids to a bucket of its own in R2, with `If-None-Match: *`, under a key never reused; the bucket's lock refuses an overwrite and a delete for 30 days, proved by `minerva:restrictions:check`. A failed write refuses the change. A restore applies every restriction written since a day before its point that the restored audit log does not hold, without the actor's checks; a changed sign-in credential voids the account's credentials. Each only takes access away, so one whose change never committed is harmless, and their order does not matter. Conversation deletions and the emergency stop are not logged: the listing answers the first, and the runbook fences the old database and closes admission itself.
- [ ] The recovery listing. A new command, `listConversations`, pages through the whole recovery index by id: each conversation's organization, workspace, `fact_seq`, `deleted_at` and `purged_at`. Laravel compares each row with what it holds: it deletes again, with the engine's deletion time, a conversation the engine has deleted, replays one whose `fact_seq` is above its watermark, and records the usage of one it does not hold. No index is needed beyond the primary key. The engine deploys first.
- [ ] Replay. Laravel calls `replayFacts` from its watermark for each conversation it must replay and applies the pages through `Facts::deliver`. `FACTS_PRUNED`, a conflict and a scope mismatch keep the recovery incomplete for the operator, never silently skipped.
- [ ] Usage of what the restore lost. A conversation Laravel does not hold gets a tombstone with the listing's organization and workspace, so its replayed facts take the tombstone's path into `usage_records`, `run_settlements` and `write_records` with a null user; its transcript is lost and the engine's copy is deleted. A run a held conversation does not hold is recorded in `lost_runs`, and its facts are kept and accounted with the conversation's user, instead of being refused.
- [ ] Durable Objects are not rolled back. A broken Conversation object is repaired forward or its conversation deleted, never restored to an earlier point (Appendix B). The runbook says so.
- [ ] Credentials. A restore marks every OAuth connection whose credentials hold a refresh token `refresh_uncertain` (set today only after a failed refresh), and ends every session.
- [ ] A runbook in the app's docs (`docs/runbooks/restore.md`) that orders the steps: close admission, fence the old database in restore mode (`MINERVA_RESTORING`) and drain its outboxes, restore, close admission again, `minerva:recover` until it exits 0 (apply the restrictions, end sessions, mark credentials, list, delete again, replay, record the lost conversations' and runs' usage, purge what is overdue, check every affected run is settled), serve, reopen admission, delete the old cluster.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Engine platform tests for the listing: pages, deleted and purged conversations, one bound only by its deletion. Laravel's tests apply restrictions logged after a point to a restored database, void a changed credential, delete again a conversation the listing answers as deleted, record the usage of a conversation it does not hold and of a held conversation's lost runs, keep the recovery incomplete while a run is owed its settlement, and refuse every request in restore mode.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Rehearse on staging. Run two turns in a conversation that existed at the point, remove a member, remove two factors from a test user, revoke a connection, delete a conversation whose engine deletion is held back, delete another, and start a new one; then restore Laravel's database to before all of them and follow the runbook. The member stays removed, the test user signs in only after a reset, the connection stays revoked, both deleted conversations stay deleted (the held-back one included), the new conversation's usage is recorded (its transcript is gone), the two turns' usage is recorded, every fact after the point is applied once, no run resumes during the restore, and `minerva:recover` exits 0. Then the same with the old database treated as lost, recorded.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The rehearsal's time from closing admission to reopening it. Record it here as the recovery time. No pass rule yet, since there is no target. The owner sets one from it.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Document where data is processed (chunk 15d)

**Depends on.** Chunk 15c.

- [x] Answer open question 6 and ARCHITECTURE.md's open question 8. Where the Workers, containers, models (Workers AI, AI Gateway, each upstream), logs, backups (Laravel Cloud's and R2's) and telemetry (Nightwatch) process data, from each vendor's documents, with links. `eca14bc`, [data-processing.md](../data-processing.md).
- [x] List the subprocessors. [data-processing.md](../data-processing.md), Subprocessors: Laravel Cloud (with Neon and AWS), Cloudflare, OpenAI, Resend.
- [x] Record what Minerva may promise about EU processing (Decision 11), and what blocks a stronger promise. [data-processing.md](../data-processing.md): EU storage of the primary data with named exceptions, not EU processing; eleven blockers.

**Verify.** This chunk changes no code. Its unit, live and perf boxes do not apply. The owner reviews the document.

- [ ] The owner reviewed [data-processing.md](../data-processing.md).

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
- **Admission in the engine for the emergency stop** (14c's first plan). A state in D1 with Laravel's revision, read by every `startRun`, set by `admission` and refusing `ADMISSION_CLOSED`. It would refuse a start that reaches the engine after the stop instead of stopping it by its cancel, and a caller other than Laravel, at the cost of a D1 read per start, an engine deploy first and a two-phase reopen. Rejected by the owner (2026-10-16) for Laravel's stop alone (chunk-14c-design.md).
- **The engine finding active runs for the emergency stop.** `recovery_runs` has no status, and Laravel's registry already knows every run that is starting or running.
- **Reserving each model call at its full worst case.** About 136,000 tokens a call makes any allowance small enough to matter useless; at the models' real windows, about $0.16 a call on production's and $2 on staging's.
- **A reservation per call bounded by the request's UTF-8 bytes** (14b's first recommendation). Rejected by the owner (2026-10-16).
- **Counting tokens exactly with the route's tokenizer before each call** (14b). Possible only where the tokenizer and the server's template are published, and a provider's own count is a round trip per call.
- **Reserving each run's allowance against the organization's budget under a lock** (14b). It would make an organization's limit nearly hard, but the owner chose the simpler rule; it remains the next step if one is wanted.
- **Reserving storage and enforcing a byte allowance in the engine** (14d's first plan). Laravel reserves an upload's bytes against the organization at presign under a lock and moves them into a byte allowance on `StartRun`; the engine replaces `UNCOUNTED` with a counter that refuses a write past it, and reports the folder's bytes after each sweep by a new fact that names no run. A nearly hard limit, at the cost of a new fact envelope, a lock, a reservation table and checks on the checkpoint path. Rejected by the owner (2026-10-16) for a number on `run.finished` and Laravel's refusals (chunk-14d-design.md).
- **Rebuilding a conversation created after the restore point** (15c, trimmed 2026-10-16). Laravel would import the conversation and its runs from replayed facts, each run marked recovered, which needs the user and agent added to the facts or the recovery index. Any restore loses what came after its point, and the money is kept by recording the usage alone. It is the next step if a real restore shows the lost transcripts matter.
- **A quarantine for restoring a Durable Object** (15c, trimmed 2026-10-16). The operator would set it in the recovery index before rolling an object back, the attempt gate would check it before `Harness.open`, and every restored run would end as uncertain. Not rolling objects back at all needs none of it. This supersedes product-and-engine.md's rule for restoring an object to repair it.
- **Logging conversation deletions as restrictions** (15c). The engine already refuses a deleted conversation and keeps `deleted_at` past the restore window, so the listing answers them.
- **Laravel sending its watermarks for the listing** (15c). The engine would answer only the conversations above them, but could not find those Laravel does not name without knowing every one it holds. The engine lists its whole index instead, and Laravel compares.
- **Logging the emergency stop as a restriction** (15c). The runbook closes admission before and after the restore and reopens it last, so a logged stop would add nothing.
- **Usage only as sums on the run row.** Stripe's meters need an id per record, and a deletion cascades the run away.

## Appendix C. Risks

- **The fake Laravel in the faults build** is test code in a deployed Worker. Only the test build includes it, as `FAULT_PROVIDER` today (13a).
- **The tombstone deploy on staging** is the first time a Durable Object class is retired on an instance that is not reset (13c).
- **Settling usage on the stream's path** adds a durable write per model call (14a). Its perf box watches it.
- **pi's tables cannot be deleted** with pi-durable 1.2.0 (15a). If deleting rows by hand proves unsafe, they grow until pi-durable adds a call.
- **A restore loses the conversations created after its point** (15c). Their usage is recorded, and of a held conversation's turns after its point, whose transcripts are lost too. Their transcripts are not rebuilt (Appendix B). Recording that usage depends on the engine keeping their facts until Laravel acknowledges them.
- **A deletion the engine never received** comes back live when the old database is lost before its outbox drained (15c).
- **A restore older than the facts' floor** cannot be reconciled from the engine (15c). The restore window and the retention of facts must be set together.

## Appendix D. Links and reading list

- [product-and-engine.md](product-and-engine.md), Decisions 4 to 8, and Deletion, retention and recovery.
- [credentials-and-facts.md](credentials-and-facts.md), for facts, delivery and replay.
- [start-and-cancel.md](start-and-cancel.md), for the recovery index.
- [ARCHITECTURE.md](../../ARCHITECTURE.md), Attempts and recovery, Files, Open questions 3, 5 and 8.
- In `minervacomputing/app`, `docs/plans/turn.md`, `conversations.md` and `grants.md`.
- [after-the-plan.md](after-the-plan.md), which starts from this plan's end.
