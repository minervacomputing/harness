# Chunk 13a design: free the kept engine from the old paths

Status is proposed, as of 2026-10-15. It settles the choices that chunk 13a of [remaining-chunks.md](remaining-chunks.md) leaves open, so that each unit below can be done by one fresh agent and checked before the next. Line numbers are at `e49c92d`. Rebase `chunk-13a` onto `main` (`cd33bae` or later) before unit 9: `cd33bae` already changed `test/account/driver.ts` (`outcome`), `faults.test.ts`, `resets.test.ts`, `turns.test.ts`, `client.ts` and added `test/account/warm.ts`, and unit 9 keeps all of them.

## Decisions

**The rule for a case.** A case is ported when the internal path has the behaviour it checks. A case is deleted only when its world cannot exist without the Workspace (its object, the `FakeWorkspace` of `conversation.test.ts`, `postMessage`, `beginRun`, activation, the Workspace's leases, refreshes, grants and outbox) and the internal path lacks the behaviour. A case whose ported form would repeat an existing internal case is not ported twice. The commit names each deleted case and, for a repeat, the case that covers it. A suite that tests only old paths (`chat.test.ts`, which runs through `/api` and Better Auth) stays whole for 13b to delete, after its kept behaviour is copied to the internal path.

**Laravel's commands reach a deployed test instance through the fault driver, not through Access.** `minerva-cf-test` has no internal settings today (its `vars.env` sets none of `MINERVA_ENVIRONMENT`, `MINERVA_ACCESS_*`, `MINERVA_LARAVEL_URL`), so `/internal/` answers 404 there (`src/internal/mount.ts:38`). Putting the test instance behind a real Access application would need an account change and service-token secrets on two instances and in CI. Instead, the faults build serves `POST|GET /api/faults/internal/*` behind the faults token (`src/faults/routes.ts:218`) and hands it to the same oRPC handler `/internal/` uses, with every step after the Access check. The faults token already grants full control of a test build, so this widens nothing. The account suites send the contract's own commands with oRPC's client of `engine`, as Laravel does.

**The faults build turns the internal API on by itself.** `cloudflare.config.ts` gets `FAULTS_DEFAULTS` beside `OFFLINE_DEFAULTS` (`cloudflare.config.ts:119`), applied in mode `faults` only (`target.instance !== null && target.faults`), under the vars file as every default is (`cloudflare.config.ts:151`). The values live in a new `src/faults/settings.ts` with no imports, which the config and `test/account/driver.ts` both import: `MINERVA_ENVIRONMENT=faults`, `MINERVA_ACCESS_ISSUER=https://faults.cloudflareaccess.example`, `MINERVA_ACCESS_AUDIENCE=faults`, `MINERVA_ACCESS_CLIENTS=faults`, `MINERVA_LARAVEL_URL=https://laravel.fake.invalid`. `src/faults/index.ts` sets `ACCESS_KEYS.of` (`src/internal/access.ts:30`) to an empty local key set, so `/internal/` on a test instance refuses every assertion with 401 and never fetches the placeholder issuer. Mode `test` keeps the values `vitest.platform.config.ts:16` sets, and no instance file or CI secret changes.

**The fake Laravel is one implementation, hosted by `FaultProvider`.** The engine calls three Laravel routes, all with `scope` in the body: `leaseToken` and `reportUnauthorized` (`src/conversation/laravel-runs.ts:68`, `:123`) and `deliverFacts` (`src/conversation/delivery.ts:108`). Nothing else goes to `MINERVA_LARAVEL_URL`; the stream route uses it only as the CORS origin (`src/stream/route.ts:40`). `test/platform/fake-laravel.ts` already implements all three over in-memory state. It moves to `src/faults/laravel.ts`, unchanged in behaviour, and gains `snapshot()` and a constructor from a snapshot, and `holdLeases`, a promise a lease answer waits on (the Laravel side of the deleted `lease:before` point). Its three importers (`test/platform/facts.test.ts:25`, `internal-conversations.test.ts:19`, `internal.test.ts:16`) import it from there. The faults build hosts it inside the per-workspace `FaultProvider` (`src/faults/provider.ts:72`) rather than in a new class. `providerFetch` already sends every `*.fake.invalid` host to the workspace's `FaultProvider` (`src/faults/ports.ts:53`), so `FaultProvider.fetch` (`provider.ts:145`) answers host `laravel.fake.invalid` with the fake Laravel, loaded from `ctx.storage.kv` key `laravel` and saved after each request, and every other host with Notes as today. A new class would add a Durable Object namespace on two accounts' instances, a binding, a bundle marker and fixture edits for no gain. `src/faults/index.ts` sets `LARAVEL_NETWORK.fetch` (`src/laravel/client.ts:23`) to a fetch that refuses any host but `laravel.fake.invalid` (as `providerFetch` refuses non-fake hosts) and routes by the body's `scope.workspace`, and `LARAVEL_NETWORK.token` to a constant the fake checks. `FakeLaravel.install()` still overrides both for the platform tests. `FaultProvider` gains RPCs over the same state: `laravelHold(run)`, `laravelConnection(id, connection)`, `laravelState(conversation)` (facts, calls, connections) and `laravelFail(deliveries)`. `reset` clears it with the provider's tables.

**Runs are read through the faults Conversation, never through API RPCs.** `getRun`, `getRunEvents`, `cancelRun(caller)`, `listFiles` and `resolveDownload(caller)` (`src/conversation/conversation.ts:362` onward) are Workspace-only RPCs that 13b removes. The faults Conversation (`src/faults/index.ts:50`) gains `faultView(runId)`: `RunStore`'s `runHead` and every event, beside `faultRun`'s internals and `faultFired`. Platform tests and the driver read runs with it. Cancels, folders, downloads and deletions go through `cancelRun`, `readFolder`, `resolveDownload` and `deleteConversation` of the internal contract.

**A run timeout a test can set.** The Laravel start reads `settings(this.env).runTimeoutMs` (`conversation.ts:637`), which a test cannot change. `ConversationPorts` (`src/conversation/ports.ts:132`) gains `runTimeoutMs(context): number | null`, defaulting to the setting, and `faultConversationPorts` reads the plan's `run_timeout_ms`, which moves from the faults Workspace (`src/faults/ports.ts:208`) to `Conversation.faultPlan(faults, { model, runTimeoutMs })`. The deadline cases of `conversation.test.ts` and `protocols.test.ts` use it.

**One world builder.** `src/faults/world.ts` replaces `setUpWorkspace` and `ALL_FOLDERS` (`src/faults/routes.ts:44`) with plain functions over a `Scope`: `notesConnection(id)` (the authority row, provider `notes`), `notesLayers(connectionId, grants)` (default every folder, read and create, as `ALL_FOLDERS`), `notesLease()` (kind `oauth2`, secret `notes-access-0`, an hour) and `seedProvider(env, workspace, delays)`. Platform tests use them with the in-memory fake, the driver with the hosted one. `test/platform/internal-support.ts` gains `held(fake, start)` and `objectOf(start)` (now private to `facts.test.ts:71`, `:66`), `viewOf(stub, runId)` and `notesStart(within, change)`. Laravel's conversations are in the EU (`src/internal/connections.ts:59`), so every ported world is an EU one, on the account too.

## The moves (question 1)

`contractHandler` (`src/api/orpc.ts:111`) moves to a new `src/internal/handler.ts`. It no longer defaults its codes to the public `REFUSALS` or uses `api/procedures.ts`'s `refusal` (`procedures.ts:28`); it builds its `ORPCError`s from the `codes` it is given, which the caller passes. Importers that change: `src/internal/mount.ts:16` (and its comment at `:2`), `src/api/orpc.ts:143` (passes `{ codes: REFUSALS, maxBody: MAX_JSON_BODY }`), `test/platform/contract.test.ts:21`.

`PROVIDER_NETWORK`, `providerAccount` and the `call` helper (`src/api/providers.ts:21`, `:35`, `:52`) move to a new `src/internal/providers.ts`, with `call` exported as `withProvider`. `src/internal/connections.ts:85` (`withCredential`, a copy of `call`) uses it. Importers that change: `src/internal/connections.ts:17`, `src/faults/index.ts:19`, `src/api/providers.ts` (keeps `encryptionKeys`, `keyAccount`, `withConnection`), `src/api/flows.ts:31`, `src/api/oauth-clients.ts:16`, `test/platform/internal-connections.test.ts:5`, `oauth.test.ts:12`, `contract.test.ts:23`, `api.test.ts:10`.

`sizeText`, `thousands`, `overFolder`, `NO_ROOM` and `NO_LONGER_AVAILABLE` (`src/workspace/limits.ts:17` to `:48`) move to `src/files/limits.ts`, which drops its re-export (`files/limits.ts:9`) and keeps its own `pages`. `workspace/limits.ts` imports them and its `pages` from there. Importers that change: `src/files/store.ts:28`, `src/files/limits.ts:4`, and whatever `tsc` names in `src/workspace/`, `src/api/` and `test/unit/workspace-limits.test.ts:5`, `files-names.test.ts:9`, `workspace-uploads.test.ts:8`.

Two more borrowings outside api/, accounts/ and workspace/ found by grep: `START_FAILED` (`src/workspace/core.ts:306`, used at `conversation.ts:60`) moves to `src/conversation/events.ts` beside `CANCELLED`, and `EXPIRED` (`src/workspace/credentials.ts:21`, used at `laravel-runs.ts:14`) moves to `src/conversation/laravel-runs.ts`; `workspace/core.ts`, `workspace/credentials.ts` and `test/platform/facts.test.ts:24` import them. What remains is what 13b deletes: `src/index.ts:4`, `:34`, `src/addressing.ts:17`, `src/http/router.ts:24` to `:31`, `src/conversation/ports.ts:25` and the Workspace and mailbox parts of `src/faults/`.

## The contract split (question 2)

The kept engine (everything outside `api/`, `accounts/`, `workspace/`) imports from the package root: `Attachment`, `Conversation`, `DeltaEventData`, `Folder`, `FolderChanges`, `FolderWarnings`, `LocalToolEventData`, `MAX_ACCESS_CHANGES`, `Message`, `MessageEventData`, `NewMessage`, `PhaseEventData`, `REFUSALS`, `RefusalCode`, `Run`, `RunEvent`, `RunEventType`, `RunStatus`, `StatusEventData`, `ToolCallAllowed`, `ToolCallEventData`, `ToolCallRefused` and `Upload` (`src/conversation/*.ts`, `src/files/{manifest,store,uploads}.ts`, `src/gateway/{grants,results}.ts`, `src/internal/{conversations,start}.ts`, `src/shared/rpc.ts`). `contract/src/internal/engine.ts:6` and `facts.ts:6` import `Folder`, `Attachment`, `FolderChanges`, `FolderWarnings` and `LocalToolEventData` from `../conversations.ts`.

Layout after the split:

- `contract/src/shapes.ts` (new) holds every kept shape now in `conversations.ts` (lines 6 to 181, and `Upload` at `:252`), with what they need (`ConversationSummary`, `RUN_EVENT_TYPES`, the `Json` types, `ToolCallBase`), and `MAX_ACCESS_CHANGES` from `connections.ts:110`.
- `contract/src/refusals.ts` and `contract/src/ids.ts` stay at the root (`NewMessage` uses `uuid`).
- `contract/src/public/` holds the routes 13b deletes, moved with `git mv`: `accounts.ts`, `agents.ts`, `connections.ts`, `conversations.ts` (routes and path helpers only, importing shapes from `../shapes.ts`), `errors.ts`, and `index.ts` with the `contract` object and the public re-exports.
- `contract/src/index.ts` exports `shapes.ts`, `REFUSALS`, `RefusalCode`, `uuid`, `canonicalUuid`, and one line `export * from './public/index.ts'` that 13b deletes with the directory.
- `internal/engine.ts` and `internal/facts.ts` import from `../shapes.ts`.

No import specifier in `cloudflare/` or `frontend/` changes. `engine-v1.json` and `laravel-v1.json` stay byte for byte: the generator (`contract/openapi/generate.ts:8`) reads only `internal/`, the moved zod objects are the same objects, and `facts.ts`'s `Same` checks are type-level. `pnpm --dir contract openapi:check` proves it.

## The fault driver and the account suites (questions 3 and 4)

`src/internal/mount.ts:36` splits into the Access step and an exported `serveInternal(request, env, client)`: the `settings(env).internal` check, `declaredOver`, and `handler.handle`. `faultRoutes` answers `/api/faults/internal/*`, for any method, by rewriting the path to `/internal/*` and calling `serveInternal(request, env, "faults")` after the token check, before its POST-only check (`routes.ts:220`).

`src/faults/routes.ts` keeps the operations the browser walk uses until 13b (`emails`, `emails-clear`, `setup-reopen`, `password-hash`, `download`, `provider-authorize`, `conversation-model`) and the sandbox lab. It replaces the Workspace world:

| Today | After 13a |
|---|---|
| `setup` (Workspace, connection, grants, agent) | `setup`: `seedProvider`, then `laravelConnection` for a new connection id; answers `{ connectionId }` |
| `conversation`, `workspace-faults` | `conversation`: `faultPlan(faults, { model, runTimeoutMs })` on the conversation's EU object, before its start |
| `post`, `upload` | `hold`: `laravelHold` for the run; `stage`: an object under `uploads/<workspace>/` in the EU bucket (`src/internal/start.ts:35`), streamed as `upload` streams today; then `startRun` through the internal API |
| `run` | `run`: `faultView` |
| `cancel`, `grants`, `files`, `file`, `delete-conversation` | `cancelRun` (a revocation is `permissions_changed`), `readFolder`, `resolveDownload` with `object` (the first 4,000 characters of a key), `deleteConversation` |
| `connection` | `laravel`: the fake Laravel's facts, calls and connections |
| `provider`, `delays`, `objects`, `conversation-sandbox`, `script-clock` | unchanged, on the EU refs |

`test/account/driver.ts` keeps its exports and shapes (`RunView`, `outcome`, `settled`, `later`, `finish`, `drain`) so the suites change little. `World` becomes `{ scope, conversationId, connectionId }` with `environment` from `src/faults/settings.ts`. `commands` is oRPC's client of `engine` at `${origin}/api/faults` whose fetch adds the faults token and goes through `fetchDeployed` (keeping its ECONNRESET retry). `post` holds the run, sends `startRun` built with `notesConnection` and `notesLayers`, and throws on `refused`. `upload` stages and answers the attachment. `laravel(w)` reads the facts.

## The ports (question 5)

| Suite | Cases | Port | Deleted, named | Covered elsewhere |
|---|---|---|---|---|
| `conversation` | 42 | 24 | 15 | 3 |
| `protocols` | 35 | 21 | 14 | 0 |
| `chat` | 20 | 5 copied | 0 now; the file stays for 13b | 15 API cases |
| `files` | 19 | 5, plus 3 staged counterparts | 12 | 2 |
| `images` | 4 | 4 | 0 | 0 |
| `local-tools` | 9 | 9 | 0 | 0 |
| `scripts-conversation` | 7 | 7 | 0 | 0 |
| `scripts-faults` | 2 | 2 | 0 | 0 |
| `faults.test.ts` (account) | 15 | 14 | 1 | 0 |
| `resets.test.ts` (account) | 4 | 4 | 0 | 0 |
| `turns.test.ts` (account) | 2 | 2 | 0 | 0 |

`conversation.test.ts` deletes, as Workspace-bound: "refusals leave nothing behind", "an upload the folder cannot take refuses the start, and the Workspace releases it", "one run at a time: a second message is 409, also while the first start is in flight", "a message sent again with its key...", "a refused start forgets its key...", "another user's conversation and runs are not found", "the title is the first message cut to 80 UTF-16 units...", "a cancel during beginRun leaves a tombstone...", the three "activation answering %o ends the run", "an activation that failed is sent again by the watch alarm", "pages of events by seq...", "a queued run is no restart...", "a Workspace conversation's runs write no facts...". Covered: "a later run replays the earlier messages..." by `internal-runs.test.ts:104`, "a revocation's cancel that arrives while pi's transaction is open..." by `internal-runs.test.ts:397`, "a lease is for the call's attempt..." by `facts.test.ts:289`. The outbox cancels port to `cancelInternal`, the stream cases open the object's socket with `organization=` instead of `user=`, and deletion ports to `deleteInternal`.

`protocols.test.ts` deletes "a grant change before the run exists is in its snapshot", "a revocation between beginRun and the start's transaction...", "the change answers only once the cancel is acknowledged...", "a crash between storing the run and its activation...", "a lost activation answer...", "a crash after the grant commit...", "a lost cancel acknowledgement...", the three cases of "a start concurrent with a revocation", "a resumed start refused as revoked...", and the three "refresh" cases. The two in-flight revocations port to `cancelInternal` with `permissions_changed`. "an attempt replaced while its lease was being given" ports with `holdLeases`.

`chat.test.ts`'s relay cases (Last-Event-ID resume, a stop during a run, the keepalive, a client that does not read, backlogs past 4 MiB and 32 MiB) are copied into `facts.test.ts`'s "Laravel's run stream" (`facts.test.ts:321`) against `/stream/v1`, which shares `stream/relay.ts`. The other 15 test the API, sessions, uploads and signed links only.

`files.test.ts` deletes the eight upload-route cases (`files.test.ts:154` to `:260`) and the four download-origin cases (`:296` to `:333`). "uploads are copied into the conversation's blobs..." is covered by `internal-runs.test.ts:244`, "an upload whose object is gone..." by `internal-runs.test.ts:383`. Hashing a large upload, sniffing an empty one as text, and a size other than declared get staged counterparts, since `files/staging.ts` measures, hashes and sniffs Laravel's uploads. `images.test.ts` attaches staged images.

`faults.test.ts` deletes "a crash during a rotating refresh..." (the Workspace's refresh; Laravel refreshes before it lends). The revocation case sends `cancelRun` with `permissions_changed`. `turns.test.ts`'s Workers AI case fails with what each attempt called when the model has not called the tools in two attempts, in place of `ctx.skip` (after-the-plan.md, Arm the program), and both turns check that the fake Laravel's facts end with `run.finished`. `deployed.test.ts`'s SPA, asset, CSRF and download-Worker checks (`deployed.test.ts:53` to `:83`, `:136` to `:158`) cannot assert 404 before the routes go, so their rewrite lands in 13b's commit that deletes the routes.

`test/platform/worker.test.ts` names `workspaceObject` at `:108` to `:137`. Its jurisdiction and schema-step cases use the Conversation object instead; the Workspace's own class check moves to `workspace.test.ts`, which 13b deletes.

## Units

Each unit is one commit after opencode reviews its diff. Every unit runs, in `cloudflare/`, `pnpm typecheck`, `pnpm test:unit` and `pnpm test:platform`; units 1, 2 and 9 also run `pnpm check` in `frontend/`.

1. **Move the borrowed engine code.** contractHandler, the provider network, the limits, `START_FAILED`, `EXPIRED`. Done when `grep -rn "api/\|workspace/" src/internal src/files src/conversation/laravel-runs.ts` finds only `conversation/ports.ts:25` and comments.
2. **Split the contract.** Also `pnpm typecheck` and `pnpm openapi:check` in `contract/`; `git diff --exit-code contract/openapi/`.
3. **Host the fake Laravel.** `src/faults/laravel.ts`, `src/faults/settings.ts`, `FaultProvider`'s host and RPCs, the `LARAVEL_NETWORK` and `ACCESS_KEYS` overrides, `FAULTS_DEFAULTS`. A platform case in `facts.test.ts`: a run of a conversation whose Laravel is the hosted fake leases from it and delivers its facts to it. A unit case in `test/unit/config.test.ts` or `deploy-checks.test.ts`: mode faults parses with the internal settings on, and a vars file still overrides them.
4. **Internal commands through the driver, and the seams.** `serveInternal`, `/api/faults/internal/*`, `faultView`, the `runTimeoutMs` port, `src/faults/world.ts`, `internal-support.ts`'s helpers. Platform cases: with the token, `/api/faults/internal/v1/catalog` answers the catalog and `startRun` is accepted; without it, 404.
5. **Port `conversation.test.ts`.**
6. **Port `protocols.test.ts`.**
7. **Port `files.test.ts` and `images.test.ts`.**
8. **Port `local-tools`, `scripts-conversation`, `scripts-faults`, copy `chat`'s relay cases, and fix `worker.test.ts`.** Then `grep -rlw workspaceObject test/` lists only `accounts`, `api`, `oauth` and `workspace` suites.
9. **Rework the driver and port `test:faults`.** Rebase first. `routes.ts`, `driver.ts`, the three suites, `setUpWorkspace` and the Workspace ops removed; cloudflare/README.md's test Worker section updated (the fake Laravel, EU worlds, the forwarded internal API). `pnpm typecheck` covers `test/account` (`tsconfig.node.json:15`). On the account: `pnpm run deploy:test`, then `pnpm test:faults`.
10. **Verify live and perf.** On `minerva-cf-test`: `test:deployed` and the ported `test:faults` pass at the head; record the cases before (21) and after (20), naming the dropped one. Remove the Notes connection from the fake-model turn's authority, run `turns.test.ts`, keep its failure output, revert. Measure `pnpm test:faults` wall time at `main` and at the head, interleaved (main, head, main, head, a `deploy:test` before each and outside the timing), and fail the box when the head is more than 20% slower.

Only the deployed test instance shows: the forwarded internal API under the real Worker, the hosted fake Laravel across memory-limit resets (`resets.test.ts`), EU objects and the EU bucket on the account, staged 50 MiB attachments, Workers AI, and the wall time.

## Risks

- The memory-limit resets take the `FaultProvider` that hosts the fake Laravel with them. Its state is written before each answer leaves, and the engine retries leases and deliveries, so a reset costs a retry. `resets.test.ts` shows whether that holds.
- Every account world moves to the EU jurisdiction. Its objects and bucket are untested by the account suites today, so a failure there is a finding, not a porting mistake.
- `faults.test.ts`'s refresh case leaves no account case of a refused credential. `facts.test.ts:252` to `:304` cover leases and reports in workerd; add an account case only if the owner wants one.

## Open questions for the owner

1. Two decisions read the chunk's boxes by intent rather than wording. `chat.test.ts` is not rewritten in place; its five kept cases are copied to `/stream/v1` and the file is left for 13b. `deployed.test.ts`'s 404 rewrite lands in 13b, since a 404 check fails until the routes go. Confirm both.

## Amendments after opencode's review

opencode reviewed this design at `cd33bae`. Where an amendment and the body disagree, the amendment wins.

1. **The hosted fake Laravel keeps its state in rows, never in one snapshot.** `FaultProvider` stores the fake's connections, calls, facts and watermarks as rows in its SQLite storage (one table each, created with the provider's other tables), not as one `kv` value. Each request reads and writes the rows it touches synchronously, with no `await` between the read and the write, so the Durable Object's input gates keep every mutation atomic. A held lease awaits its hold first, then reads the current rows. No state is held across an `await`. `FakeLaravel` keeps its in-memory form for the platform tests; the hosted form shares its request handling through a small storage interface (memory or SQL) rather than a snapshot. Facts and calls are bounded by the rows, not by a value size.
2. **Cases that test kept behaviour through the Workspace are ported, not deleted.** `conversation.test.ts:332` (one run at a time while a start is still being prepared; the internal path checks `preparedOther` at `conversation.ts:711`), `protocols.test.ts:302` and `conversation.test.ts:878` (a run stored but not yet activated is recovered by the watch; internal starts defer activation too, `conversation.ts:701`, `:923`, `:1064`) port to the internal path. The implementing agent re-checks every case on the delete list against the internal path's code before deleting it and names the evidence in the commit.
3. **The missing-upload case's cover is `internal-runs.test.ts:222` to `:241`**, not `:383`. Port the cleanup and reuse assertions of `files.test.ts:446` to `:462` that the internal path has into that case or a new one.
4. **`faultView` pages its events.** It answers the head, the internals and one page of events after a given `seq` (bounded as `store.ts:75` to `:86` bounds pages), with the `eventSeq` captured at the first page. The driver and the tests read pages until they reach it.
5. **The fake Laravel's durability is tested directly.** A platform case aborts the `FaultProvider` between a lease's mutation and its answer (and once between a delivery's write and its answer), then shows that the engine's retry finds the registrations, the credential status, and the facts deduplicated with their watermark intact.
6. **Production builds are proved not to get the faults defaults.** Unit 3's config test also asserts that modes `production`, `test` and offline parse without `FAULTS_DEFAULTS` (the internal settings stay off unless a vars file sets them), beside the positive faults case.

The two open questions are settled: `chat.test.ts` stays whole for 13b after its relay cases are copied, and `deployed.test.ts`'s 404 rewrite lands in 13b. Both follow the chunk's own text ("Until then they stay") and lose no coverage.
