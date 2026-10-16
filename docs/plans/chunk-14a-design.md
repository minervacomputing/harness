# Chunk 14a design: make usage exact

Status is proposed, as of 2026-10-16. It settles the choices that chunk 14a of [remaining-chunks.md](remaining-chunks.md) leaves open, splits the work into units one fresh agent each can finish, and lists the steps that wait for the owner. Line numbers are at `c4e0be7` (harness) and `9b9ab74` (`minervacomputing/app`, "the app" below). Nothing here is implemented yet.

## What the code does today

Each claim the chunk makes was read in the code. Two need correcting.

| Claim | What the code does |
|---|---|
| The call id is made after counting | True. `options.host.counted(fence)` (`model/provider.ts:236`), then `const call = tokenHex(4)` (`:238`). Counting is `UPDATE runs SET model_calls = model_calls + 1` (`conversation/store.ts:584`), an aggregate only, and a bare statement: it is not made through `outside`, so it can join a transaction of pi's and roll back with it. |
| `done` reaches pi before `host.settled` | True. The `done` event is pushed inside the stream loop (`provider.ts:362`); `settled` is called after the loop (`:387`). pi-ai's `EventStream.push` resolves the stream's result as soon as it sees a terminal event (`node_modules/@earendil-works/pi-ai/dist/utils/event-stream.js`, `push`), so pi can go on before the settlement starts. The error path does the same (`provider.ts:376`, then `:385`). |
| Usage is written through `ctx.waitUntil` outside any transaction | Partly wrong. `settled` hands the write to `store.outside(() => store.settleModelCall(...))` under `ctx.waitUntil` (`conversation.ts:1284`), so it is outside pi's transactions and is its own transaction (`store.ts:592`, `write`). The defect is that nothing waits for it: an eviction between `done` and that write loses it, and pi has already acted on the answer. |
| A `run.usage` fact can land after `run.finished` | True, and it stays true after this chunk: a call the run's end cuts settles after the end (credentials-and-facts.md, Order). `run.settled` is the new barrier, not `run.finished`. |
| A call with no reported usage writes no fact | True. `settleModelCall(runId, null)` only adds one to `unmetered_model_calls` (`store.ts:594`). |
| A call the provider refused is counted but never settled | True. `accepted = streamed \|\| status === 200` (`provider.ts:384`); a refused request (a status, no stream) reaches neither branch. A request that failed before any status and was not stopped (a network failure, the 120 s quiet timeout) is not settled either. |
| `run.finished` lets the next turn start | True (`contract/src/internal/facts.ts:109`; the app's `Facts::finished`, `app/Runs/Facts.php:172`). |
| The Sandbox's `startedAt` | Exists, but per incarnation, in the Sandbox's one state row (`sandbox/store.ts`, `StateRow.startedAt`), overwritten by the next start (`sandbox/core.ts:360`). Nothing keeps a run's containers or when each ended. |
| The script wall time in `scripts/run.ts` | Nothing measures it. `executeScript` (`scripts/run.ts:173`) only enforces the clock with a timer. |
| `Conversation::locked` does not look at `deleted_at` | True (`app/Models/Conversation.php:58`): a soft-deleted conversation reaches `Facts::apply` and gets transcript changes. |
| `Facts::tombstoned` drops every fact | True (`app/Runs/Facts.php:74`): it answers the batch's last sequence and keeps nothing. Deleting an organization cascades its conversations, runs and `conversation_facts` (`database/migrations/2026_10_14_140000_create_runs_tables.php:79`, `:95`, `:178`; `app/Actions/DeleteAccount.php:100`). |

pi's own transactions are short commits of SQL with no I/O inside (`pi-durable/dist/storage/sqlite/storage.js:103`, `commit`), so `outside` always drains. Awaiting it on the stream's path cannot deadlock.

## Decisions

**The call record lives in the Conversation object's SQLite.** The fence checks, the run's counters and the facts outbox are there, and they are synchronous. A record in D1 would put a network round trip on both measured paths and could not share a transaction with the fence or the fact. Migration 9 (`conversation/schema.ts`):

```sql
CREATE TABLE call_records (
	run_id TEXT NOT NULL,
	call TEXT NOT NULL,            -- 8 lowercase hex, unique within the run
	attempt INTEGER NOT NULL,
	instance TEXT NOT NULL,        -- the object instance that sent it
	provider TEXT NOT NULL,        -- the route: provider and model
	model TEXT NOT NULL,
	reserved_input INTEGER NOT NULL,
	reserved_output INTEGER NOT NULL,
	request_bytes INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	outcome TEXT CHECK (outcome IN ('reported', 'refused', 'unmetered')),  -- NULL while open
	cause TEXT CHECK (cause IN ('no_usage', 'stopped', 'failed', 'lost')),
	input_tokens INTEGER, output_tokens INTEGER, cached_tokens INTEGER, reasoning_tokens INTEGER,
	settled_at INTEGER,
	PRIMARY KEY (run_id, call),
	CHECK ((outcome = 'unmetered') = (cause IS NOT NULL))
) STRICT;
CREATE INDEX call_records_open ON call_records (instance) WHERE outcome IS NULL;
CREATE TABLE script_records (
	run_id TEXT NOT NULL,
	script_id TEXT PRIMARY KEY,
	instance TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	timeout_ms INTEGER NOT NULL,
	ended_at INTEGER
) STRICT;
ALTER TABLE runs ADD COLUMN metered INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN settled_at INTEGER;
```

**The call id stays 8 hex, made before the send, unique within its run by construction.** The record's insert is `ON CONFLICT DO NOTHING RETURNING`; a collision draws a new id. The id keeps naming the call's deltas and `callOf` unchanged, so no reader of run events changes. Laravel and Stripe key a call by `(run, call)`; chunk 16's meter event identifier is `<run>:<call>` (45 characters).

**The reservation is the window's worst case until 14b replaces it.** `reserved_input` is `CONTEXT_WINDOW` (128,000, `model/route.ts:15`) and `reserved_output` the call's cap (`outputCap`, `provider.ts:244`). That is a true bound, which is what an unmetered estimate must be. 14b swaps the one function that computes it (`reservation(context, route)` in `model/policy.ts`) after its prototype. `request_bytes` is the UTF-8 length of the request's JSON as pi hands it (`forModel(context, upstream.model)`): it is the data 14b's prototype compares with reported usage, so chunk 14a's ten turns already hold it.

**A record is written before the request and settled before pi hears the answer.** `ModelHost.counted` and `settled` (`provider.ts:83`, `:94`) become two awaited calls:

- `record(fence, request): Promise<string | null>`, inside the stream's async body, before `send`. It runs through `outside`, and in its one synchronous change checks `isCurrent(fence)` again, inserts the record, adds one to `runs.model_calls` and answers the call id. Null means the run ended meanwhile: the call is refused with `RUN_ENDED_TEXT`, with nothing recorded or counted, as a call `begin` refused is today. This is also where 14b's admission goes, in the same change.
- `settle(fence, call, settlement): Promise<void>`, after the upstream's terminal event and before it is pushed to pi. The stream loop holds the terminal event (`done`, or `error`), settles, then pushes it and ends the stream. A settlement that throws resets the object (`#reset`, as a failed checkpoint does) before pi hears the answer, and the next instance settles the record as lost.

**Settlement states.** A record is open (`outcome IS NULL`) or settled, once: `UPDATE call_records SET … WHERE run_id = ? AND call = ? AND outcome IS NULL RETURNING …`, so a second settlement changes nothing and writes no fact. The outcome is decided from what the wrapper saw, in this order:

| The wrapper saw | Outcome | Tokens on the record and its fact |
|---|---|---|
| An answer (`streamed`, or status 200) with a usage report (`reportedUsage`) | `reported` | As reported |
| An answer with no usage report | `unmetered`, cause `no_usage` | The reservation, estimated |
| No answer, a status other than 200 (the provider refused it) | `refused` | 0 |
| No answer, no status, stopped by the run or pi | `unmetered`, cause `stopped` | The reservation, estimated |
| No answer, no status, not stopped (a network failure, the quiet timeout) | `unmetered`, cause `failed` | The reservation, estimated |
| The record is open and another instance made it | `unmetered`, cause `lost` | The reservation, estimated |

The summary retry (`provider.ts:313`) is one call and one record; if the run ends between the refused try and the second, it settles `refused`. Calls refused before the record (`begin`, `refusal(context)`, no upstream) have no record and are not counted, as today.

**The restart rule.** Each Conversation instance gets an id when it is built (one `crypto.randomUUID()`, which `stream.ts`'s instance tag can share). A record or script record that is open and carries another instance's id belongs to an instance that is gone, since a Durable Object has one live instance and a reset ends the old one's work. `settleLost()` settles every such call record as `unmetered`, cause `lost`, and ends every such script record at `min(now, started_at + timeout_ms)`. It runs outside pi's transactions in `#recover` (`conversation.ts:539`, once per instance) and first in each settlement job. It never touches this instance's records, which its own streams and scripts settle. The aggregate columns follow the records in the same transactions: `model_calls` at the insert, `input_tokens` and `output_tokens` at a reported settlement, `unmetered_model_calls` at an unmetered one. A unit test checks they equal the table's sums.

**Container seconds are kept by the Sandbox, as spans.** The Sandbox object is the only side that sees every start and every end, its own lease destroys and recoveries included. Migration 2 (`sandbox/schema.ts`):

```sql
CREATE TABLE container_spans (
	incarnation TEXT PRIMARY KEY,
	run_id TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	started_at INTEGER NOT NULL,
	lease_until INTEGER,
	ended_at INTEGER,
	ended TEXT CHECK (ended IN ('destroyed', 'gone'))
) STRICT;
CREATE INDEX container_spans_run ON container_spans (run_id);
```

`writeState` (`sandbox/store.ts`) is the one place the state row changes, so the spans change there, in the same synchronous step and therefore the same implicit transaction: a new incarnation opens a span at its `startedAt`; a lease change updates `lease_until`; the incarnation going away (state `none`) closes the span at `now`, `destroyed` when a destroy succeeded and `gone` when the object found the container stopped (`recover`, `sandbox/core.ts:304`; an unusable container in `#release`, `:527`). The rule is a pure function `spanChange(previous, next, now)`, unit tested over every transition. A destroy that fails keeps the incarnation (`destroying`, `cleanupPending`), so its span stays open until the alarm's destroy succeeds. The Sandbox gains one RPC, `usage(runId): { spans: { startedAt, leaseUntil, endedAt }[] }`.

**Script time is wall time from the run to its answer, recorded like a call.** `scripts/tool.ts:164` writes a script record through `outside` before `executeScript` and ends it after `executeScript` returns, before the result is rendered. The time is `ended_at - started_at`: the reset wait at the start counts (it is in the script's clock), the reset after the answer does not. A script record left open by a dead instance ends at its clock's bound (restart rule).

**`run.settled` is written once, by a job.** `finish` (`store.ts`) gains a listener call inside its transaction, as `factWritten` does, that pushes the Lifecycle job `settle:<run>` for a run with `metered = 1`. `metered` is set by `insertRun` from this version on, so a run an older version started is never settled with records it does not have. The job:

1. Runs `settleLost()`.
2. If a call or script record of the run is still open (this instance's, cut by the end), it asks again in 5 s.
3. Asks the Sandbox `usage(run)` within `RPC_WAIT_MS` (`conversation.ts:164`). A failure asks again in 30 s. A span still open asks again at `min(now + 30 s, lease_until + HARD_GRACE_MS)` (`sandbox/core.ts:98`). A span still open past `lease_until + HARD_GRACE_MS` is counted to that bound and marks the totals estimated: by then the Sandbox's alarm has tried to destroy it, and the platform's inactivity timeout (`#keepAlive`, lease plus 5 minutes) has stopped an idle one.
4. Outside pi's transactions, in one write: if `settled_at` is null and no record of the run is open, it computes the totals, writes the `run.settled` fact and sets `settled_at`. Otherwise it does nothing.

The job is idempotent: a second run finds `settled_at` set, and a crash at any step leaves the job, which Lifecycle runs again. `#recover` pushes the job for every run with `metered = 1`, a terminal status and `settled_at` null, so a job lost with a reset is made again. A deleted conversation still settles: `deleteInternal` destroys the container (`conversation.ts:364`), which closes the span, and its facts are still delivered. A conversation with no organization writes no facts, so the job only sets `settled_at`.

**The facts.** All additive; the engine writes none of them until Laravel takes them.

- `run.usage` gains two optional fields: `provider` (the route's provider; with `model`, the route 14b prices) and `requestBytes`.
- `run.unmetered` (new): `{ call, provider, model, cause: 'refused' | 'no_usage' | 'stopped' | 'failed' | 'lost', inputTokens, outputTokens, estimated, requestBytes }`. A refused call has `cause: 'refused'`, zero tokens and `estimated: false`; every other has the reservation and `estimated: true`. (The record's `outcome` is `refused` or `unmetered`; on the wire one fact type carries both, since both are calls that reported no usage.)
- `run.settled` (new): `{ modelCalls, refusedCalls, unmeteredCalls, inputTokens, outputTokens, cachedTokens, reasoningTokens, estimatedInputTokens, estimatedOutputTokens, containers, containerMs, containerEstimated, scripts, scriptMs }`. Reported tokens and estimates are kept apart. `modelCalls` counts every record, so Laravel's records for the run must number exactly that.

Every call settlement is a fact: one record per counted call reaches Laravel, refused ones included. `run.settled` is written after every settlement fact of its run, so its sequence is higher than theirs; `run.usage` and `run.unmetered` may still follow `run.finished`.

**Laravel keeps accounting in tables of its own, with no foreign keys.** One migration in the app:

- `usage_records`, primary key `(run_id, call)`: `organization_id`, `workspace_id`, `conversation_id` (uuid, no foreign key), `user_id` (nullable, no foreign key), `outcome` (`reported`, `refused`, `unmetered`), `cause`, `provider`, `model`, the four token counts, `estimated`, `request_bytes`, `fact_seq`, `at` (the fact's), `created_at`; index `(organization_id, at)`.
- `run_settlements`, primary key `run_id`: the same scope columns, every total of `run.settled`, `fact_seq`, `at`. 14b releases a reservation from this row.
- `write_records`, primary key `(conversation_id, fact_seq)`: the scope columns, `run_id`, `write`, `tool`, `connection_id`, `outcome`, `after_cancel`, `at`. Today the audit log reads write settlements from `conversation_facts`, which a deletion cascades away; product-and-engine.md (Deletion) keeps them under their own retention. Keyed by the fact itself, it needs no rule for a write that settles twice.

Each insert is `insertOrIgnore`; when nothing was inserted, the stored row is compared with the fact's, and a difference is `FACT_CONFLICT`. `runs` keeps its sums: `run.usage` adds as today, and `run.unmetered` adds one to `model_calls` too, so `runs.model_calls` counts every settled call. `minerva:turn` keeps printing them.

**Fact application branches on the conversation's state.** One table in `Facts` (`app/Runs/Facts.php:144`) says what each fact does in each state, instead of conditions spread through the handlers:

| Fact | Live | Soft-deleted (`deleted_at` set) | Gone (rows cascaded, `deleted_conversations` holds it) |
|---|---|---|---|
| `run.status` | Run status and attempt; the user's message sent | Run status and attempt only | Dropped |
| `run.tool_call`, `run.local_tool` | `conversation_facts` | `conversation_facts` | Dropped |
| `run.write` | `conversation_facts`, `write_records` | `conversation_facts`, `write_records` | `write_records` |
| `run.usage`, `run.unmetered` | `usage_records`, run sums | `usage_records`, run sums | `usage_records` |
| `run.settled` | `run_settlements` | `run_settlements` | `run_settlements` |
| `run.finished` | Run status, error, folder, finished; the assistant's message | Run status and `finished_at` only | Dropped |

A soft-deleted conversation keeps the live path's lock, order, gap and conflict checks and still inserts every fact into `conversation_facts`, since a repeat is compared with that row; nothing reaches `messages`, and chunk 15b removes those rows with the conversation. A gone conversation has no watermark, so `tombstoned` checks the batch's order, applies each accounting fact through its key (idempotent, with the conflict check above), and answers the batch's last sequence as today. Its `user_id` is null. A conflict there is logged and refused `FACT_CONFLICT`; the engine stops the delivery for the operator.

**Contract and deploy order.** The new fields are optional and the new types additive. Laravel takes them before the engine writes them: Laravel's `ContractRequest` refuses an unknown fact type (an issue, 422), and the engine would back off and retry until it is taken (nothing is lost; starts are refused after 10,000 unacknowledged facts). So: the contract lands on the harness's `main` first with nothing writing the new facts; the app syncs it and deploys (staging by CI, production by the owner); then the engine is deployed to `minerva-cf-staging`, and to production only after the app's production has the change. `minerva-cf-test` and `minerva-cf-ci` use the fake Laravel (`src/faults/laravel.ts`), which takes whatever the contract allows, so the engine's units can be deployed there at any time.

## What 14b inherits

- The record insert is the admission point, in one synchronous step with the fence check. 14b adds its allowance check there and replaces `reservation(context, route)`.
- `request_bytes` beside reported tokens on every call of the ten turns, for its bound's prototype.
- `run_settlements` as the only release signal. A run the engine never accepted (a refused or tombstoned start, `start_expired`) has no `run.settled`: Laravel releases its reservation from the start's answer or the cancel's acknowledgement.
- Spans only close at the end. Charging container time against an allowance while a run is still going needs the open span's start, which `usage(run)` already returns.

## Units

One fresh agent each, in this order. A unit is done when its checks pass, opencode has reviewed its diff, and it is committed to `main` of its repository. Engine checks are `pnpm typecheck`, `pnpm test:unit` and `pnpm test:platform` in `cloudflare/`, plus `pnpm typecheck` and `pnpm openapi:check` in `contract/` when the contract changes. App checks are those in its AGENTS.md (`composer test`, `pnpm run check`, `pnpm run types:check`, `pnpm test`).

1. **Contract (harness).** `run.usage`'s optional `provider` and `requestBytes`; `run.unmetered` and `run.settled` in `contract/src/internal/facts.ts`; `pnpm --dir contract openapi`; new scenarios in `contract/scenarios/facts.json` (both new types applied and acknowledged, an identical repeat acknowledged, a differing repeat `FACT_CONFLICT`); `docs/plans/contract.md`'s fact list. The engine writes none of them. `test/platform/internal.test.ts` passes the scenarios against the fake Laravel. Pushing it turns the app's CI red until unit 2 lands, so unit 2 follows at once.
2. **Accounting tables and fact application (app).** `composer contract:sync`; the migration of the three tables; the state table in `Facts`, the soft-deleted branch in `apply`, the accounting branch in `tombstoned`; `minerva:usage {--run=} {--since=}`, which prints each run's records beside its `run_settlements` row and exits non-zero when a count or a sum differs or a finished run has no settlement after ten minutes (the live checks' lever, and 16's later); `docs/plans/turn.md` (Tables, Applying a fact, Deletion). Pest tests in `tests/Feature/Runs/FactsTest.php` and `tests/Feature/Conversations/DeletionTest.php`: each new fact applied with its rows; an identical repeat by key ignored and a differing one `FACT_CONFLICT`; a soft-deleted conversation keeps usage, settlement and write rows, gets no assistant message and its run becomes terminal; a deleted organization's late usage, settlement and write are kept with its id; deleting a conversation and an organization leaves `usage_records`, `run_settlements` and `write_records` as they were; the shared scenarios. Pushing deploys staging through CI.
3. **The perf probe (harness, before any change it measures).** In the faults build only: a model config `fake-remote`, the fake model with one `fetch` to `model.fake.invalid` (answered by the workspace's `FaultProvider`, which `providerFetch` already routes, `src/faults/ports.ts:53`) before each answer, so each call's request is a real outbound message; and marks the faults ports keep in memory per run (`begin`, `answered` when that fetch resolves, `last` at the upstream's terminal event), read with `faultView`. `test/account/perf.test.ts`, skipped unless `MINERVA_PERF=1`: 20 turns, each six model calls (a fake script whose first five answers call a tool that does not exist, which pi answers at once with an error), on `minerva-cf-test`. It prints the medians and spreads of the two metrics below. Run it on `main` and keep the numbers.
4. **Record and settle each call (harness).** Migration 9; `record` and `settle` in `ModelHost`, `provider.ts` and `#modelHost`; the outcome table; `run.usage`'s new fields and `run.unmetered`; the aggregate columns in the same transactions; the fake model's `refused: { status }` turn option (it calls `onResponse` with the status and fails without a `start` event). Unit tests (`test/unit/model-provider.test.ts`) for each row of the outcome table, and that the terminal event reaches the consumer only after `settle` resolved. Platform tests (`test/platform/facts.test.ts`): a refused call, a stream with no usage and a reported call each give exactly one settlement fact, and `run.unmetered` carries the reservation.
5. **The restart rule (harness).** The instance id; `settleLost()` in `#recover`; fault points `model:settle` (after the terminal event, before the settlement) and `model:settled` (after it, before pi hears it) in the faults ports. Platform tests (`test/platform/protocols.test.ts`): `abort` at `model:settle` leaves one `lost` settlement for that call and a new record for the next attempt's call; `abort` at `model:settled` leaves one `reported` settlement and pi asks again under a new id; neither gives a second settlement for the first call.
6. **Container spans (harness).** Sandbox migration 2; `spanChange` in `writeState`; `usage(runId)` on `SandboxApi` and the object. Unit tests over every transition of `spanChange` and through `SandboxCore` with its ports (start, destroy, a failed destroy then the alarm's, `recover` with the container gone, an unusable container, a start that replaces another run's). The platform sandbox test (`test/platform/sandbox.test.ts`) reads one span for a run's container after its end.
7. **Script records (harness).** `script_records`; begin and end around `executeScript`; `settleLost()` ends open ones at their bound. Platform test (`test/platform/scripts-conversation.test.ts`): a script's record spans its run; an object reset during a script leaves one record ended at its bound.
8. **`run.settled` (harness).** `runs.metered` and `settled_at`; the job; `#recover`'s pushes; the totals. Platform tests: the fact follows `run.finished` and every settlement fact of its run, once, with totals equal to the sums of its records and spans; it waits for a call the end cut; it waits for an open span and counts a span past its bound to the bound with `containerEstimated`; running the job twice, and resetting the object inside it, writes one fact; a run inserted without `metered` gets none.
9. **The account suites (harness).** A case in `test/account/faults.test.ts`: `abort` at `model:delta` (step 1, delta 3) kills the object mid-stream; the fake Laravel's facts then hold one `run.usage` or `run.unmetered` per counted call (the run's `model_calls`), and a `run.settled` whose totals equal their sums and whose `containerMs` is above zero for a turn that ran `bash`. Deploy `minerva-cf-test` (`pnpm run deploy:test`), run `pnpm test:faults`, then the perf probe interleaved with `main` (Perf below).
10. **Docs (harness).** ARCHITECTURE.md: Facts (the new facts, `run.settled` as the barrier), Attempts and recovery (Fencing's exception now names the call record), The sandbox lifecycle (spans), Writes (the record and the settlement among the changes made through `outside`); credentials-and-facts.md's Order note; remaining-chunks.md's 14a boxes with their evidence and the cost per turn (open question 7).

Units 4 to 8 change only the harness and need nothing from the app until they are deployed to staging.

## Live checks

| Check | Where | Who |
|---|---|---|
| `test:faults` passes, with unit 9's new case | `minerva-cf-test` | The agent |
| The perf probe, `main` and head interleaved | `minerva-cf-test` | The agent |
| The app's migration and CI smoke test | The app's staging (CI deploys it) | The agent pushes |
| Deploy the engine to `minerva-cf-staging` after the app's staging has unit 2 | The account | The agent, telling the owner |
| Ten typical turns: three chat-only, two with one connector call, two with `run_script`, two with a file upload, one stopped mid-answer; then `minerva:usage --since=` shows every run's records adding up to its `run.settled` and one record per counted call, the stopped one with a `reported` or an estimated `unmetered` record (amendment 12) | The app's staging, through `minerva:turn` and the chat | The owner: the connector turns use the owner's GitHub connection on staging, the upload and the stop are done in the browser, and the turns spend Workers AI and container time |
| Cost per turn: tokens from `usage_records`, container and script seconds from `run_settlements`, at the model's and Containers' list prices, recorded in remaining-chunks.md | From the ten turns | The agent, after the owner confirms which prices apply |
| Deploy the app's production, then the engine's production | Laravel Cloud, the account | The owner |

A fault cannot be injected on staging, whose engine is no faults build. The chunk's "a fault test kills the object mid-stream" therefore runs on `minerva-cf-test` against the fake Laravel (unit 9), and staging's mid-stream case is the stopped turn, which may settle either way on the real model.

## Perf probe and rule

**Metrics.** M1, a model call's last token (the upstream's terminal event) to the first answer of the next call's request: pi's step, the settlement, the next record, and one round trip. M2, `host.begin` to the first answer of that call's request: the record and one round trip. Per call, calls 2 to 6 of each turn.

**Why the fetch.** A Durable Object's clock moves only when I/O completes, and its output gate holds outgoing messages until its writes are durable. A record is a synchronous SQLite write, so its cost appears as the next outgoing request waiting for that write, not as CPU. The in-process fake makes no outgoing request, so it would show zero on both sides. With one fetch per call to a sibling object, the gate's wait and the round trip land inside M1 and M2, and the round trip is the same on both sides. This is inferred from the platform's documented output gate, not yet measured: the probe's first run on head includes a calibration build that writes 1 MB more per record, and M2 must rise with it. If it does not, the probe does not see the writes, and the rule is measured instead on the ten staging turns' Workers AI calls, `main` and head, from Workers Logs.

**Procedure.** `main`, then head, then `main`, then head, each a fresh `pnpm run deploy:test` and one probe run of 20 turns (100 samples per metric per run). Report each run's median and interquartile range, and the head-minus-`main` difference of medians.

**Rule.** For each metric, head's median is within 10 ms of `main`'s, in both pairs. More fails.

## Risks

- **A durable write on the stream's path** (remaining-chunks.md, Appendix C). The record and the settlement each wait for `outside`; a long commit of pi's delays a call by its length. The probe measures it.
- **The deploy window.** A busy object keeps its old code for minutes. A run it started has `metered = 0` and gets no `run.settled`; a Sandbox on old code has no `usage` RPC, so a settlement job retries until it is replaced. Container time of a container an old Sandbox started is not counted. Staging is affected; production has no customers.
- **A destroy that keeps failing** is billed to `lease_until + HARD_GRACE_MS`. With no run deadline (`MINERVA_RUN_TIMEOUT_SECONDS` empty) the lease is an hour past last use, so such a span can count about 70 minutes. It is marked estimated.
- **`write_records` without an audit log yet.** It is kept apart from the transcript now so deletions cannot lose it; the log that reads it comes later.
- **The facts backlog.** A turn now writes one more fact per refused call and one `run.settled`. It does not change the bound.

## Open questions for the owner

1. **The staging turns.** Default: the agent runs the chat-only and script turns with `minerva:turn` once the owner says go; the owner runs the two connector turns on their GitHub connection, the two upload turns and the stopped turn in the browser. They spend a few cents of Workers AI and container time on the account.
2. **Which prices the cost per turn uses.** Default: the published list price of `@cf/zai-org/glm-5.3-flash` on Workers AI and of `standard-1` on Containers, ignoring the Workers Paid plan's included allowances. The alternative counts the allowances, which makes small volumes look free.
3. **Production deploys.** Default: the owner deploys the app's production first, then approves the engine's (`pnpm run deploy --instance minerva-cf`), each when its staging checks pass. Until both are done, production writes no new facts.
4. **The perf box's metrics** (amendment 13). Default: accept M1 and M2 as defined, which end at the next request's first answer rather than at the request leaving, since a request's departure cannot be timed from inside the object. The alternative is to keep the plan's wording and find another way to time a departure.

## Amendments after opencode's review

opencode (`plan` agent) reviewed this design against both repositories on 2026-10-16. Each finding was checked in the code. Where an amendment and the body above differ, the amendment wins; the units it touches are named.

1. **The settlement had no barrier against a late container (accepted).** `LocalRun.#prepare` checks `#ended` before and after `prepareSandbox` (`conversation/local-run.ts:108`, `:116`), but `prepareSandbox` starts a second container when the first did not start (`sandbox/session.ts:35`), and the Sandbox's `start` refuses only an older attempt (`sandbox/core.ts:343`), never an ended run. A job that saw every span closed could settle before that second start. Fix (unit 6 and 8): `usage(runId)` becomes `seal(runId)`. It runs in the Sandbox's `#serial`, so it is ordered after any lifecycle step in flight; it records the run as sealed (a `sealed_runs` table in the Sandbox's migration 2), destroys the run's container if it is the current incarnation, and answers the spans. `start` for a sealed run is refused `stale`. The settlement job seals before it reads, and a seal answered with an open span (a failed destroy) is asked again. Test: a run cancelled between a first start that failed and its retry gets no second container, and its `run.settled` counts one span.
2. **Script records were not fenced (accepted).** `run_script` checks `host.current` (`scripts/tool.ts:156`), then awaits `loadStore` (`:160`), so a run can end in between. Fix (unit 7): the script record's insert checks `isCurrent(fence)` in the same synchronous change, as a call's record does, and a refused insert answers `RUN_ENDED_MESSAGE` without running the script. Every record insert now requires an acting run, so once the run is terminal and no record is open, none can appear: that is the barrier `run.settled` relies on. Test: a cancel during `loadStore` leaves no script record and runs nothing.
3. **A gone conversation lost the conflict check (accepted).** Laravel compares the whole canonical fact at `(conversation, seq)` (`app/Runs/Facts.php:117`). Keys by call, run and sequence alone would let a different fact at a repeated sequence insert a row, and comparing derived columns would refuse an identical replay whose `user_id` became null. Fix (unit 2): every accounting row also holds `conversation_id`, `fact_seq` and the canonical `fact` text, unique on `(conversation_id, fact_seq)`, and a repeat is compared on that text alone. `deleted_conversations` gains `facts_held`, copied from the conversation when its rows go: `Revocations::tombstone` (`app/Runs/Revocations.php:100`) copies it for every conversation of the organization, standing or soft-deleted, under the conversation locks `lockHistory` already took (`:54`); chunk 15b's physical deletion must do the same. `tombstoned` then applies the live path's rules to the accounting facts: a sequence at or below the watermark is compared with the accounting row of that sequence when there is one (a transcript fact has none and is acknowledged), the next must be the watermark plus one (`FACT_GAP` otherwise), and the watermark advances. A key that already exists at another sequence is `FACT_CONFLICT`. Tests: a differing repeat at an accounting sequence, a gap, and an identical replay after the organization's deletion of a fact first applied live.
4. **Any status other than 200 was a zero-cost refusal (accepted).** Requests go through AI Gateway (`model/route.ts`), and a gateway's 5xx or timeout does not prove the provider did no billable work. Fix (unit 4): `refused` only for a status from 400 to 499; any other status without an answer settles `unmetered`, cause `failed`, at the reservation. The fake model's `refused: { status }` covers a 429 (zero) and a 502 (estimated).
5. **`CONTEXT_WINDOW` is not an enforced bound (accepted).** It is what pi is told (`model/route.ts:15`), not a check on the request, and the configured model may differ. The reservation is a provisional accounting policy until 14b proves a bound per route; the body's "true bound" is withdrawn. 14b's prototype must check it as it checks the byte bound.
6. **A span's end was a guess where the code only observes (accepted).** `recover` learns that a container stopped when it looks (`sandbox/core.ts:305`), not when it stopped, and a state change alone cannot tell a destroy from a discovery. Fix (unit 6): each call site that clears the incarnation passes why: `destroyed` (a destroy that answered), `gone` (a failed destroy that found it stopped, `recover`, an unusable container). `spanChange` takes that reason. A `gone` span ends when the Sandbox noticed and is counted as estimated. These are observed lifecycle durations, not the platform's billing records.
7. **The lease cutoff depended on when the job looked (accepted).** One rule now: a span is charged to `min(ended_at, lease_until + HARD_GRACE_MS)`, with an open span counting to that cutoff, so the totals do not depend on the job's timing. It is a charging cutoff, not proof that the container stopped; `containerEstimated` is set when any span is open, `gone`, or ended past the cutoff.
8. **Recovered script time was not marked (accepted).** `script_records` gains `estimated` (set when the restart rule ends it), and `run.settled` gains `scriptEstimated`. The measure stays wall time from the run to its answer, which is the chunk's choice; it is not the guest's CPU, and a reset or a guest's leftover work after the answer (`scripts/run.ts:199`) is not counted.
9. **`request_bytes` measured the transcript, not the request (accepted).** `forModel` returns a `TranscriptContext` (`model/policy.ts:44`); createAI builds the body later and hands it to `onPayload`, where `forcePayload` changes it (`provider.ts:263`). Fix (unit 4): the wrapper measures the UTF-8 length of the forced payload's JSON in `onPayload`, keeps it in memory and writes it with the settlement. A call that never built a payload, and every fake call, has none: `requestBytes` is optional on both facts and nullable in both tables.
10. **Cache writes were lost (accepted).** `reportedUsage` folds cache writes into `input` and keeps only cache reads apart (`model/tap.ts:142`). Fix (units 1 and 4): it also returns `cacheWrite`; the record, `run.usage` (optional `cacheWriteTokens`), `run.settled` and `usage_records` carry it, since Anthropic prices cache writes apart.
11. **Laravel could not tell which runs must settle (accepted).** `metered` lives only in the engine, and Laravel refuses runs without the engine (`app/Runs/Runs.php:355`). Fix (unit 2): `minerva:usage` requires `--since`, the time the engine deploy that writes the new facts finished, and checks only runs created after it that the engine accepted (`answered_at` set, no `refusal_code`). The new columns are nullable for facts written before it.
12. **An old Sandbox could leave an empty list that looks like no container (accepted).** Fix (unit 6 and 8): the Sandbox records when it started keeping spans (`spans_since`, written once by migration 2's first use) and `seal` answers it; a run created before it gets `containerEstimated`. A rollback between two deploys of this chunk is still not detected; production has no customers.
13. **The perf metrics are proxies, and "main" moves (accepted).** M1 and M2 end at the next request's first answer, not at the request leaving, since a departure is held by the output gate and cannot be timed inside the object; the round trip is the same on both sides, so the difference is the change's. That departs from the plan's wording, so it is owner question 4. The baseline is pinned to unit 3's commit, and "head" is the commit after unit 8. The Workers Logs fallback is dropped: if the calibration does not move M2, the agent stops and asks the owner.
14. **The stopped staging turn may report usage (accepted).** A provider can report usage on a cut stream. The staging check accepts either outcome, and the unmetered path is proved by the fault suite (unit 9) and the platform tests.
15. **More fault points (accepted).** Unit 5 adds `model:recorded` (after the insert, before the send: one `lost` settlement), and a `throw` at `model:settle`: the object resets and pi never gets the answer, then the next instance settles the record as `lost`.
16. **`write_records` is required, not optional (accepted).** product-and-engine.md (Deletion) keeps write settlements under their own retention. It is no longer an owner question.
17. **The scenarios do not prove deduplication (accepted, no change).** `contract/scenarios/facts.json` proves delivery per sequence; the key rules, tombstones and totals are proved by unit 2's Pest tests, which already list them.
18. **"Asking first" before deploying `minerva-cf-staging` (rejected).** The harness's AGENTS.md asks first for production, resources on the account, tunnels, Access and DNS. A staging deploy is none of those. The agent deploys it and tells the owner, as the table says.

## Verification

This document was checked against the code at the commits above, by reading each file and line cited, and every opencode finding was checked again in the code before it was accepted or rejected.
