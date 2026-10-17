# Chunk 14c design: the emergency stop

Status: accepted, 2026-10-17 (the owner accepted every default below). Proposed 2026-10-16, in the shape the owner chose that day (below). This design settles the choices that chunk 14c of [remaining-chunks.md](remaining-chunks.md) leaves open. It splits the work into units that one fresh agent each can finish, and lists what waits for the owner. opencode reviewed it, and the findings that held are folded in (Amendments after opencode's review). Line numbers are at `d09fbf1` (harness) and at `ef6429f` on the `chunk-14b` branch of `minervacomputing/app` ("the app" below), which reaches the app's main before 14c is built.

## The owner's choice: Laravel's stop only

The plan put a second admission state in the engine: a revisioned row in D1 that `startRun` reads on every start, set by the declared `admission` command, refusing starts with `ADMISSION_CLOSED`. The owner chose otherwise (2026-10-16): **the stop is Laravel's alone, with no engine change.**

- **The flag.** A flag in Laravel's database. While it is closed, `Runs::start` refuses every new start and `leaseToken` refuses every lease.
- **Stopping.** The stop closes the flag. It then requests the cancel of every run that is starting or running, with `CancelReason::EmergencyStop`, through the existing cancel path: `Runs::requestCancel`, the `run_cancels` outbox, `SendCancel` and the sweep.
- **Reopening.** Reopening opens the flag. Nothing is sent to the engine.
- **Who.** An instance admin stops and reopens from Laravel's admin (Filament). Each stop and each reopen is recorded with who did it and when.

**Why this is enough.** Laravel holds the run registry and sends every start.

- A start that commits before the flag closes is found by the stop's scan and cancelled.
- A start that begins after the flag closes reads it closed and is refused.
- A start registered before the stop, whether it was sent, is being sent, or is still queued, is ordered against its cancel by the engine. The engine already does this for every cancel (What the code does today).

Only a start that reaches the engine without passing through Laravel's registry would get past the stop. Laravel is the engine's only caller.

**What this does not promise.** These limits are stated plainly here and again in Risks:

- **Starts registered before the stop.** This covers starts already sent, starts in flight, and starts still queued or retried by `SendStart`. A start the engine received before its cancel can begin its turn, and that turn runs until the cancel arrives. During that time it can make a model call, and even a tool call.
  - The stop sends its cancels from the request, within ten seconds. What is left goes to `SendCancel`, and then to the sweep, which runs every five minutes.
  - Once a run's cancel is requested, `SendStart` holds its start back until the engine has acknowledged the cancel (The start's job, below). So a start that has not reached the engine yet arrives after its cancel and is refused. Only a start already on its way when the stop commits can begin.
- **Cancels the engine has not acknowledged.** While the engine cannot be reached, those runs go on until their cancels arrive or the runs end. Their leases are refused, so their connector calls fail. Their model calls, scripts and local tools go on. The admin page lists every such cancel, and `SendCancel` and the sweep keep sending them.
- **Leases already lent.** Closing the flag refuses every later lease. It does not take back a lease already lent. That lease serves its tool call, which can make several provider requests. The engine's fence stops the next request only once the run's cancel has landed (`admits`). A write already sent settles and is recorded (`run.write`, with `afterCancel`).
- **What "stopped" means.** The page and the command separate three states:
  1. starts and leases are refused (the flag is closed);
  2. every cancel is acknowledged (the engine has ended each run in its own state);
  3. every run has ended in Laravel's registry (its `run.finished` arrived).

  An acknowledged cancel does not mean every process is gone. The engine destroys the container and stops pi after the run ends, and retries both if they fail. A write already sent settles later. These steps are the engine's own, and chunk 14a's records cover their usage.
- **What a user sees.** A run that began ends with "Stopped.". A start the engine never received becomes "Not sent." (`Runs::cancelAcknowledged`). A run whose cancel was requested earlier for another reason keeps that reason's message.
- **What is not a run.** The stop does not stop the engine or close the connection pages. These keep running:
  - the settings calls (`describeAccount`, `listResources` and `checkGrantEdit`), which send a credential outside any run;
  - OAuth connects and refreshes;
  - uploads;
  - fact delivery;
  - the engine's own jobs: the seal, container destroys and retention.
- **Laravel itself.** The stop lives in Laravel's database. It cannot be used while Laravel is down. During a restore the database is replaced, flag included (What 14d and 15 inherit). The operator's fallback for the engine is outside this chunk: taking the Worker down with `cf`.
- **Callers other than Laravel.** Anyone else who holds the internal API's Access token and the environment's name could start runs directly. The plan's engine-side admission would have refused them. This design does not.

## What the code does today

| Claim | What the code does |
|---|---|
| The engine already ends a run for `emergency_stop` | The contract's `CancelReason` includes `emergency_stop` (`contract/src/internal/engine.ts:114`). The engine's `endFor` maps it to `EMERGENCY_STOP`, `{status: "cancelled", code: "emergency_stop", message: "Stopped."}` (`cloudflare/src/conversation/events.ts:88`, `:99`). The app has `CancelReason::EmergencyStop` (`app/Enums/CancelReason.php:14`), which nothing uses yet. |
| A cancel is ordered against a start in the engine | `cancelInternal` (`cloudflare/src/conversation/conversation.ts:284`) revokes and ends an active run in one write (`:292`, `:293`). For a run the engine has not received, it writes a tombstone and deletes the run's preparation (`:296`, `:297`). A start in flight finds the tombstone in its final transaction and is refused `CANCELLED`. A later start is refused at once (start-and-cancel.md, `startRun` steps 3 and 6). |
| A cancelled run stops acting | Every provider request checks the fence immediately before it is sent (`admits`, `cloudflare/src/gateway/executor.ts:560`). A request that carries a write goes on, so its outcome is recorded (`:563`). The run's end aborts its controllers, scripts, local tools and pi, and destroys its container (`#afterFinish`, `conversation.ts:866`). A write that settles after the end becomes a `run.write` fact with `afterCancel` (`cloudflare/src/conversation/store.ts:1111`). `cloudflare/test/platform/protocols.test.ts:265` cancels a run while its write is in flight: the write completes and is recorded, and the call's next request is never sent. |
| `admission` and `ADMISSION_CLOSED` | `admission` is declared (`engine.ts:251`) and answers 501 (`cloudflare/src/internal/procedures.ts:59`). `cloudflare/test/platform/internal.test.ts:47` uses it as its example of a 501. `ADMISSION_CLOSED` appears only in `startRun`'s doc comment (`engine.ts:204`) and in contract.md's list of refusals. A refusal's code is a free string (`contract/src/internal/common.ts:35`), so no schema names it. The app's client has no `admission` operation (`app/Engine/EngineClient.php:27`). |
| A start is one transaction | `Runs::start` (`app/Runs/Runs.php:84`) locks the user `FOR SHARE` (`:87`) and then the workspace (`:88`). It reads the membership (`:90`) and the budget (`:95`), locks the conversation (`:154`) and registers the run as `starting` (`:203`). `SendStart` is dispatched after the commit (`:122`). Every start passes through this method: `ConversationController.php:67` and `:101`, and `minerva:turn` (`RunTurn.php:49`). |
| `SendStart` sends until answered | It stops only once the start is answered, or once its cancel was acknowledged `tombstoned` (`app/Jobs/SendStart.php:42`, `:45`). A requested cancel does not hold it back today. |
| A cancel request refuses leases | `requestCancel` sets `cancel_requested_at` and inserts the outbox entry in the caller's transaction, then dispatches `SendCancel` after the commit (`Runs.php:377`). `Run::lendable` requires that no cancel was requested (`app/Models/Run.php:83`). `Leases::lease` checks this with the run locked `FOR SHARE` (`app/Runs/Leases.php:42`, `:43`, `:136`). A cancel request updates the run's row, so a lease is ordered against it (turn.md, Locks). |
| The outbox outlives its runs | `run_cancels` has no foreign key, so an entry is still sent after an account's deletion removed its runs (`database/migrations/2026_10_14_140000_create_runs_tables.php:152`). |
| Revocations already fan out cancels and wait | `Revocations::constrained` scans the active runs in order of conversation, locks each conversation and requests each run's cancel (`app/Runs/Revocations.php:212`). After the commit, `await` sends the cancels one by one from the request, each exchange cut to what is left of ten seconds. It answers whether any cancel is still unacknowledged (`:250`, `WAIT` at `:31`). `SendCancel` retries with backoff (`app/Jobs/SendCancel.php:37`) and skips an entry already acknowledged (`:51`). The sweep, scheduled every five minutes (`routes/console.php:6`), dispatches cancels again that have not been tried for a minute (`app/Console/Commands/SweepRuns.php:55`). |
| Active runs are indexed | `runs_one_active` is a unique index on `conversation_id` where the status is `starting` or `running` (`create_runs_tables.php:131`). |
| The lock order | user → organization → workspaces → conversations → runs → connections (the app's `docs/plans/turn.md:40`). An account's deletion locks the user first and deletes the row last (`app/Actions/DeleteAccount.php:37`, `:105`). |
| Facts can stop for a conversation | A conversation's delivery stops on a conflict (`facts_stopped_at`, `app/Runs/Facts.php:48`), and `minerva:facts:resume` restarts it. |
| The admin and its checks | Filament serves `/admin` only to an instance admin with a verified address and two factors (`app/Models/User.php:74`, `EnsureInstanceAdmin`), whose password was confirmed in the last 15 minutes. Both checks also run on Livewire's requests, which carry the actions (`app/Providers/Filament/AdminPanelProvider.php:55`, `:64`, `:68`). Admin actions live in `App\Admin\AdminActions` and are logged with the admin's id (`app/Admin/AdminActions.php:35`). They are offered as Filament header actions with `requiresConfirmation()` (`app/Filament/Resources/Users/Pages/ViewUser.php:25`). The panel registers its pages one by one (`AdminPanelProvider.php:44`). |
| The chat shows a run's end | It shows `run.finished`'s `error` (`app/Conversations/Transcript.php:184`), and keeps its `code` as `runs.error_code` (`app/Runs/Facts.php:343`). The composer shows a refused start's validation message. |

## Decisions

### The flag and its record

Two tables, made by one migration:

- **`admission`**: exactly one row, `id` smallint primary key `CHECK (id = 1)` and `open` boolean not null. The migration inserts it open.
- **`admission_changes`**: an append-only record, one row per stop or reopen. It has an `id`, `open` (what the change set it to), `reason` (text, nullable, at most 500 characters), `user_id` (a plain bigint, nullable: null for the console) and `at`.

`admission_changes.user_id` has no foreign key. An account's deletion locks the user, then deletes it. A foreign key with an action on delete would then update a row in the admission tables, after the user's lock. That is the reverse of the lock order below, and a start that holds `admission` shared while waiting for the same user would deadlock with it. A plain id keeps who acted, even after their account is gone.

The record is written in the same transaction as the change, so a stop that commits is always recorded. A `Log::warning` follows the commit, as `AdminActions` logs. The record is what the page shows, and what chunk 15b's audit viewer can read later.

The flag is a row, not the cache, because a start must be ordered against the stop. A start's transaction cannot lock a cache key, but it can lock a row: the start reads the row `FOR SHARE`, and the stop takes it `FOR UPDATE`, which waits for every start that holds it shared. A settings package would give the same row with more code, and Laravel has no first-party one.

The class is `App\Runs\Admission`, beside `Runs` and `Revocations`:

- `shared(): bool` reads the row `FOR SHARE`. `Runs::start` calls it inside its transaction.
- `open(): bool` reads the row without a lock. Leases and the sweep call it.
- `stop()`, `reopen()` and `pending()` are described below.

A missing row counts as closed. It is never created again open.

### The lock order

**admission → user → organization → workspaces → conversations → runs → connections.**

- A start takes the row first, before the user.
- The stop holds the row only in its first, short transaction, which takes no other lock.
- Leases read the row without a lock.

So no transaction holds another lock while it waits for this row. turn.md's Locks section gains the row and these rules.

### The start

`Runs::start`'s transaction begins with `Admission::shared()`, before the user's lock (`Runs.php:87`). While the flag is closed, the start throws `ValidationException` with "Minerva has stopped all agents for now. Try again later." (owner question 2). Nothing is registered, and no conversation is created. The composer shows the message, as it shows "Wait for the agent to finish.".

### The start's job

`SendStart` gains one check before it sends: if its run has a cancel requested whose entry is not yet acknowledged, the job releases itself with its backoff and sends nothing. Once the cancel is acknowledged, the job behaves as it does today:

- `tombstoned`: the job stops.
- `cancelled` or `ended`: the engine had the run. The job sends the start again, and the engine answers with its stored answer, which still carries the run's authorized set.

So a start that had not reached the engine when its cancel was requested reaches it after the cancel, and the engine refuses it. Only a start already on its way when the stop commits can begin. This is three lines in the job, and it serves every cancel, not only the stop's.

### The lease

`Leases::lease`'s transaction starts with `Admission::open()`. While the flag is closed, it answers `{outcome: "refused", code: "RUN_NOT_ACTIVE", message: "Minerva has stopped all agents for now."}`. `RUN_NOT_ACTIVE` is already the code for a run that cannot be lent to, so neither the engine nor the contract changes.

Once the closing commit is visible, every lease is refused, including for runs whose cancel the stop has not yet requested (The stop, step 2). A lease that read the flag before that commit was ordered before the stop, as a lease that comes before a cancel is today.

`reportUnauthorized` is not refused: a provider's refusal is still worth recording, as after a cancel.

### The stop

`Admission::stop(?User $admin, string $reason)`:

1. **Close**, in one short transaction. Lock the row `FOR UPDATE`, set `open = false` if it was open, and insert the `admission_changes` row. This transaction waits only for the starts that hold the row, and it takes no other lock.
2. **Request the cancels.** Scan the runs `starting` or `running` with no cancel requested, in every organization, in order of `conversation_id` (`runs_one_active` covers this). For each conversation, in its own transaction, lock the conversation (`Conversation::locked`) and request its active runs' cancels with `CancelReason::EmergencyStop`. A run whose cancel was requested before keeps its first reason.
3. **Send and wait.** After step 2, outside every lock, pass `Revocations::await` the ids of every unacknowledged entry in `run_cancels`, whatever its reason and whether or not its run's rows still exist. It sends them within ten seconds and answers whether any is still unacknowledged.
4. **Log** with `Log::warning('An admin stopped all agents', ['admin' => id or null, 'runs' => count, 'pending' => count])`.

**The order is safe across the two transactions.** The close waits until every start that took the row shared has committed. After the close commits, every start reads the flag closed. So every run registered with the flag open is already committed and visible when step 2 scans, which runs later.

**When a step fails partway.** The close is one statement's wait on one row, so it is quick. A slow conversation delays only its own cancels, and never keeps the flag open. If step 2 or 3 dies partway (the request ends, a lock wait times out, the engine cannot be reached), starts and leases are already refused. Two things finish the stop:

- **The sweep.** While the flag is closed, it requests an `emergency_stop` cancel for every active run without a cancel. This is one indexed query that finds nothing once the stop is complete.
- **Stopping again.** A second stop skips step 1's change, but records the attempt, and runs steps 2 to 4 again.

### The reopen

`Admission::reopen(?User $admin)` runs in one transaction: lock the row `FOR UPDATE`, set `open = true` and insert the `admission_changes` row. It is logged as the stop is. Nothing is sent to the engine.

A run whose cancel is still pending stays unlendable. Its conversation refuses a new start ("Wait for the agent to finish.") until the run ends. So reopening while cancels are pending is safe, and it is allowed (owner question 3). The confirmation shows how many cancels are pending.

### What is pending

`Admission::pending()` is one query, shared by the page and the command. It answers three things:

- every unacknowledged `run_cancels` entry, with its run, reason, organization, `requested_at` and `tried_at`, whatever the reason and whether or not its run's rows exist;
- the runs still `starting` or `running`. A run whose cancel was acknowledged stays `running` until its `run.finished` arrives;
- the conversations among those runs whose fact delivery is stopped (`facts_stopped_at`), named with `minerva:facts:resume`, since stopping again does not repair them.

### The admin page

A Filament page, `App\Filament\Pages\EmergencyStop`, registered in `AdminPanelProvider`'s `pages`, behind the panel's existing checks. It shows:

- the state: open, or stopped since when, by whom and why;
- the `admission_changes` record, newest first;
- what is pending (above), as a table.

It refreshes itself every five seconds while anything is pending (Livewire's `wire:poll` in the page's view).

It has two header actions:

- **Stop all agents.** It has a required reason, `requiresConfirmation()` and the color `danger`. It calls `stop`. Its notification states the three states: "Starts and leases are refused. N cancels are awaiting the engine. M runs have not ended yet."
- **Reopen.** It has `requiresConfirmation()` and is offered only while the flag is closed.

### The command

`php artisan minerva:stop {--reason=} {--reopen}` calls the same class with no admin (`user_id` null). It prints the state and what is pending, and it exits non-zero while any cancel is unacknowledged. It exists for two reasons:

- The live check on staging is driven through Laravel Cloud's commands, as 14b's `minerva:turn` is.
- It works when no instance admin can reach `/admin` (owner question 1).

### The contract

**Unchanged.** `admission` stays declared and keeps answering 501. `ADMISSION_CLOSED` stays in `startRun`'s doc comment and in contract.md's list.

- Removing `admission` would remove an operation from `engine-v1.json`, which Laravel keeps a copy of (`composer contract:sync`, checked by its CI). The contract's v1 changes only additively (AGENTS.md). Nothing calls `admission`, so removing it would be safe, but it is a change in two repositories for no gain, and the platform test's 501 example uses it.
- `ADMISSION_CLOSED` is not in any schema. It is a word in a doc comment and in contract.md.

Unit 2 says in ARCHITECTURE.md and remaining-chunks.md that both are unused, so no one builds against them.

## What 14d and 15 inherit

- **14d.** Nothing it needs. turn.md's lock order now begins with the admission row.
- **15c (restoring Laravel).** The flag lives in the database that a restore replaces. A restore to a point before a stop brings the flag back open, and loses the cancel entries made after that point. Maintenance mode (`php artisan down`) refuses web requests, the engine's leases and facts included, and holds the queue's workers between jobs. It does not interrupt a job that is already running, and it does not reach the engine's turns. So this design does not make a restore safe by itself. It leaves 15c three requirements:
  1. Before the restore, run `minerva:stop` on the old database, wait until every cancel is acknowledged, and then take Laravel down.
  2. After the restore, and before `php artisan up`, run `minerva:stop` again, so the restored flag is closed and the restored registry's active runs are cancelled.
  3. Reconcile the engine's runs that the restored registry does not know, while the flag stays closed. This is 15c's reconciliation.

## Units

Each unit is for one fresh agent, in this order. Both units are in the app and build on its main once `chunk-14b` is merged there (on top of `chunk-14b` if it is not). A unit is done when the app's checks pass (`composer test`, `pnpm run check`, `pnpm run types:check` and `pnpm test`) and it is committed. opencode reviews unit 1's diff, since unit 1 adds a lock to every start.

1. **The flag, the stop and the checks (app).** It builds:
   - the migration with `admission`, its one row, and `admission_changes`;
   - `App\Runs\Admission` (`shared`, `open`, `stop`, `reopen` and `pending`);
   - the check in `Runs::start` before the user's lock, and the one in `Leases::lease`;
   - `SendStart`'s hold while a cancel is unacknowledged;
   - the sweep's clause while the flag is closed;
   - `minerva:stop`;
   - docs: turn.md (Tables, Locks, an Emergency stop section, and the command under The operator's commands) and one sentence in AGENTS.md's Runs paragraph.

   Pest tests:
   - A start while stopped is refused with its message, and creates no conversation, run or message. A missing row refuses too.
   - A lease while stopped is refused with `RUN_NOT_ACTIVE`. A report while stopped is still marked.
   - A stop cancels every `starting` and `running` run in two organizations with `emergency_stop`, and no run that has ended.
   - A run whose cancel was requested before keeps its reason and is waited for.
   - An unacknowledged cancel whose rows were deleted with an account is sent and waited for.
   - A second stop requests no cancel twice and is recorded.
   - A stop whose cancel requests failed partway: the flag is closed, and the sweep requests the rest.
   - `SendStart` holds while its cancel is unacknowledged, stops after `tombstoned`, and sends after `cancelled`.
   - A reopen lets the next start through.
   - An account's deletion of the user who stopped leaves the record's id in place.
   - `minerva:stop`'s output and exit codes, with `EngineFake` first acknowledging and then not.

   A race test in `tests/Concurrency/`, against Postgres in separate processes, as `BudgetRacesTest.php` is, covers two orders:
   - A start holds the row shared while the stop waits. The start commits, and the stop cancels it.
   - A start begins while the stop holds the row. It is refused.
2. **The admin page and the docs (app, then harness).** `App\Filament\Pages\EmergencyStop`, registered in the panel. Livewire tests, as `tests/Feature/Admin/AdminTest.php` tests `ViewUser`, check that:
   - a non-admin gets 404;
   - Stop requires a reason, closes the flag, cancels, records the admin, and shows what is pending while `EngineFake` does not acknowledge;
   - Reopen is offered only while stopped, and shows the pending count.

   Then, in the harness: ARCHITECTURE.md's Emergency stop paragraph (`:153`) and its commands line (`:278`) describe Laravel's stop and say that `admission` stays declared and unused. remaining-chunks.md's 14c boxes get their evidence.

**Deploy order.** The engine does not change. The app deploys as usual: a push to main reaches staging through CI. Production is the owner's. No setting changes, and the migration starts with the flag open.

## Live checks

| Check | Where | Who |
|---|---|---|
| The engine's regression | Not needed: the engine does not change. `protocols.test.ts:265` already proves a write in flight through a cancel | |
| The app's suite, the race test included | Locally, against Postgres | The agent |
| Two `minerva:turn`s started at once, each running a long script (a 120 s `bash` sleep), then `minerva:stop --reason=…`. Both runs end `cancelled` with "Stopped." and `error_code = emergency_stop`. A third `minerva:turn` is refused with the stop's message. `minerva:stop --reopen`, then a turn completes. Record the time from the stop to its last acknowledgement | The app's staging | The agent, once the owner says go (it spends cents of model and container time) |
| A write: a turn that writes through the owner's GitHub connection on staging (a comment on an issue in a repository the owner names), stopped while its tool card shows the call running. Its `run.write` fact reaches `write_records` with its outcome and `afterCancel` | The app's staging | The agent, with the owner's go |
| The page: Stop and Reopen, clicked once by an instance admin | The app's staging | The owner, since the agent has no admin with two factors there |

The agent cannot hold the write in flight on staging. So the staging check proves only that Laravel records the write's fact, whether the stop landed during the call or after it, and it records which case happened. That a write in flight is completed and recorded through a cancel, and that the call's next request is never sent, is the engine's: `protocols.test.ts:265`, which the cancel's reason does not change.

## Perf probe and rule

**The engine's start path is unchanged**, so the plan's metric (the time from `startRun` to its answer) measures nothing this chunk changes. It is not run.

**What is measured instead** is the time this chunk adds to `Runs::start`: one primary-key read `FOR SHARE` of a one-row table. It is measured locally against the Postgres of `docker compose`: 500 starts through `Runs::start` with `Bus::fake()`, so no start is sent, on the base (unit 1's parent) and on the head, interleaved twice. **Rule:** the head's median is within 20 ms of the base's, the plan's number; under 1 ms is expected. The live check above records how long the stop takes to be acknowledged, which no rule judges.

## Risks

- **A start already on its way can begin before its cancel arrives.** The window is how long the cancel takes to reach the engine. The stop sends cancels from its request, `SendCancel` retries them, and the sweep runs every five minutes. Connector calls in that window are refused their leases.
- **Unacknowledged cancels leave runs going** in an engine that Laravel cannot reach. Their leases are refused. Their model calls, scripts and local tools go on until the cancel lands, the run's deadline passes, or the run ends. The page lists them.
- **One row that every start shares.** Every start takes the same row `FOR SHARE`, and Postgres records several sharers of one row as a MultiXact. At today's start rate this costs nothing measurable, and the perf rule watches it.
- **Laravel's stop needs Laravel.** It does not help while Laravel is down or being restored (What 14d and 15 inherit), or against another caller that holds the engine's Access token.
- **Settings calls, OAuth and uploads continue** while stopped. If an emergency concerns credentials outside runs, the operator's tools are revoking the connection or the provider's client.

## Owner questions

Answered 2026-10-17: the owner accepted every default below.

1. **A command beside the page.** Default: yes, `minerva:stop` with `--reopen`, because staging's live check runs through commands and the command works when `/admin` cannot be reached. The alternative is the page alone.
2. **The message a refused start shows.** Default: "Minerva has stopped all agents for now. Try again later." Users do not see the reason the admin typed.
3. **Reopening while cancels are pending.** Default: allowed, with the pending count shown in the confirmation. A pending run stays unlendable, and its conversation refuses new starts until the run ends.

## The alternative the owner rejected: admission in the engine

This was the plan's version. Laravel's row carries a revision. Closing sends `admission` closed with that revision, then the cancels. Reopening sends `admission` open before Laravel commits. The engine stores the state in D1 and keeps the highest revision, and `startRun` reads it before `bindRun` and refuses `ADMISSION_CLOSED`.

- **What it adds.** A start that reaches the engine after the engine stored closed is refused before its turn begins, instead of being stopped by its cancel. A caller other than Laravel is refused too.
- **What it costs.**
  - a D1 read on every start, or an isolate cache whose lifetime becomes the stop's delay;
  - in the engine, a migration, the command's implementation and its platform tests, with the engine deployed before the app;
  - in Laravel, a two-phase reopen whose partial failures need their own pending state.

It remains possible later. The contract still declares `admission`, so adding it needs no contract change.

## Changes to remaining-chunks.md

This commit rewrites chunk 14c's boxes to Laravel's stop:

- The engine's admission box is removed.
- The leases box is kept.
- The plan's ordering box becomes the stop's close-then-cancel.
- The perf box measures `Runs::start`.
- The regression box says the engine does not change.

Appendix B records the engine-side admission as rejected.

## Amendments after opencode's review

opencode (`plan` agent) reviewed the first draft on 2026-10-16, reading both repositories. Each finding was checked in the code.

1. **`changed_by`'s foreign key with `nullOnDelete` reversed the lock order (accepted).** An account's deletion locks the user, then deletes it. The action on delete would then update the admission row, so a start holding it shared while waiting for that user would deadlock (`DeleteAccount.php:37`, `:105`). The actor is now a plain id in `admission_changes`, with no foreign key.
2. **One blocked conversation kept the flag from closing (accepted).** The draft closed the flag and requested every cancel in one transaction, so the flag became visible only after every conversation's lock, and a failure rolled the close back. The close is now its own short transaction. The cancels follow, one conversation per transaction. The sweep finishes a stop that died partway, and the order still holds (The stop).
3. **Active runs are not everything still running (accepted).** `run_cancels` outlives its runs (`create_runs_tables.php:152`), so a cancel left by an account's deletion could still be unacknowledged with no run row to scan. The stop now sends and waits for every unacknowledged entry, whatever its reason, and the page lists them all.
4. **"All agents stopped" overstated what is known (accepted).** `await` checks only acknowledgements (`Revocations.php:261`), and an acknowledgement does not mean cleanup is done. The page and the command now state three states (What this does not promise).
5. **Pending was filtered by reason and gave no way to repair it (accepted).** The draft listed only `emergency_stop` cancels. Pending now shows every unacknowledged cancel with its reason, age and last try, plus conversations whose facts are stopped, named with `minerva:facts:resume` (`Facts.php:48`). The sweep's five-minute schedule (`routes/console.php:6`) is stated.
6. **Queued starts were not only "already sent" (accepted, and narrowed).** `SendStart` sends whatever its run's state (`SendStart.php:39`), so a start registered but not yet sent could first reach the engine after the stop. `SendStart` now holds while its run's cancel is unacknowledged, so only a start already on its way can begin. The draft's "usually well under a second" is replaced by what `await`, the job and the sweep actually do.
7. **A lease covers a tool call, not one request (accepted).** `protocols.test.ts:265` shows two requests in one call. The text now says that closing the flag refuses later leases, that the engine's fence stops later requests once the cancel lands, and that a lease already lent is not taken back. With the close committed first, the lease's read of the flag is ordered against it, so it is now a real check rather than a redundant one.
8. **The record had a crash window (accepted).** The draft logged after the commit and kept only the last change. `admission_changes` is now written in the change's own transaction.
9. **Maintenance mode does not make a restore safe (accepted).** `php artisan down` holds workers between jobs, but does not interrupt a running job or reach the engine (`vendor/laravel/framework/src/Illuminate/Queue/Worker.php`). 15c now inherits requirements, not a solution.
10. **Missing tests (accepted in part).** Added: an orphaned outbox entry, a cancel with an earlier reason, a stop that failed partway, `SendStart`'s hold, the deletion of the user who stopped, and a missing row refusing starts. Two are set aside: "an acknowledgement lost after the engine commits" is what `SendCancel` already converges on today and the engine answers a repeat as the first (`conversation.ts:291`); "a lease lent when the close commits, across requests" is the engine's fence, which `protocols.test.ts:265` covers.
11. **The terminal messages (accepted).** A tombstoned start shows "Not sent." and an earlier reason keeps its message. You see's "Stopped." is about runs that began, as the live check's two turns did.
12. **Three missed attempts do not verify a write in flight (accepted).** The staging check now claims only that Laravel records the write's fact. The in-flight behaviour rests on `protocols.test.ts:265`. The draft's owner question about an engine fault test is dropped, since that test already holds the write through a cancel.
13. **Simplify (accepted).** One pending query for the page and the command, and the outbox as the only backlog, are adopted. The draft's suggested later optimization (reading the flag without a lock and scanning twice) is removed, since without a bound on a start's transaction it bounds nothing.
14. **Measure the stop under contention (set aside).** The perf rule stays on what every start pays. The live check records the stop's time to its last acknowledgement, and a stop with a slow conversation no longer holds the flag (amendment 2).

## Verification

This document was checked against the code at the commits above, by reading each file and line it cites. The engine's write-through-a-cancel test was read at `protocols.test.ts:265`.
