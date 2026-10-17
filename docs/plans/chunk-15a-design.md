# Chunk 15a design: retain and delete in the engine

Status: proposed, 2026-10-17. This design settles the choices that chunk 15a of [remaining-chunks.md](remaining-chunks.md) leaves open, by the owner's periods (remaining-chunks.md, Arm the program, answered 2026-10-15). It splits the work into units that one fresh agent each can finish, and lists what waits for the owner. opencode reviewed it, and the findings that held are folded in (Amendments after opencode's review). Line numbers are at `02f13c3` (harness) and at `1c522ed` on the main of `minervacomputing/app` ("the app" below).

## The rule in brief

- **A run's own records go 30 days after the run ended**: its events, its inputs, its attempts and tool bookkeeping, its call and script records, its write ledger and page tokens, and its pi session. The run's row (emptied of its inputs) and the stored answer to its start stay until the conversation is destroyed, since they deduplicate Laravel's commands, which have no bound in time.
- **A fact goes 7 days after Laravel acknowledged it**, never before. The lowest sequence still held is the floor. A replay below it is refused with `FACTS_PRUNED`, which names the floor, and a `FACT_GAP` below it stops the delivery for the operator.
- **A deleted conversation is removed 7 days after its deletion**, once every fact it wrote is acknowledged and pruned. It is marked purged in the recovery index, then its R2 prefix is deleted, then its storage. The index's row stays, so the Worker refuses later commands from it.
- **One Lifecycle job, `retain`**, does all of it on the object's alarm, in steps of a bounded number of rows that each leave a consistent state, and only while no run is active.

## What the code does today

| Claim | What the code does |
|---|---|
| What the plan says is pruned today | Less than the plan says. `start_keys` is unused since chunk 13b, and nothing reads, writes or prunes it (`conversation/schema.ts:154`; no other reference in `src/`). A start's preparation (`internal_starts`) is deleted when the start is answered or cancelled (`store.ts:1014`, `conversation.ts:297`), not by an alarm. The folder's sweep deletes loose and doomed blobs (`files/store.ts:1023`). Nothing else is ever deleted. |
| Deletion helpers with no caller | `WriteLedger.forget(runId)` (`gateway/ledger.ts:258`), `PageTokens.forget(runId)` (`gateway/page-tokens.ts:84`) and `FolderPort.deleteObjects()`, which runs `deletePrefix` over `blobs/<ws>/<conv>/` (`conversation/ports.ts:90`, `files/store.ts:1081`), are called only by tests. |
| A run's rows | `runs` (one row; `snapshot` holds the compiled snapshot with the turn's history and prompt, or `run_snapshots` its parts), `attempts`, `run_events` (every event, deltas included), `tool_executions`, `tool_arguments`, `call_records`, `script_records`, `run_writes` and `page_tokens`, all keyed or indexed by `run_id` (`conversation/schema.ts:46` to `:260`, `gateway/schema.ts`). `folder_grants` is deleted at the run's end (`files/store.ts:962`). Nothing bounds a run's events or pi entries. |
| Records that answer a repeated command | `internal_answers` (a start's answer, replayed to a repeat, `conversation.ts:274`), `tombstones` (a cancel before the start), the `runs` row (a cancel of an ended run answers `cancelled` or `ended`, `conversation.ts:288`), and in D1 `recovery_runs.input_digest` (`IDEMPOTENCY_CONFLICT`). |
| Laravel's retries | Unbounded in time. The sweep sends again, every minute, every start not answered and not tombstoned, every cancel not acknowledged and every deletion not answered (the app's `app/Console/Commands/SweepRuns.php:54`, `:62`, `:69`). A restore of Laravel (15c) can bring back commands up to the restore window old. |
| Facts | `facts` (seq, run, JSON, created_at) and `fact_delivery` (`written`, never lowered; `acknowledged`; `indexed`; `failures`; `next_at`; `stopped`) (`conversation/schema.ts:196`). Nothing records when a fact was acknowledged. |
| Replay | `replayInternal` answers `factPage(after, limit)`, the facts with `seq > after` (`conversation.ts:315`, `store.ts:1124`). Once rows are deleted, a page would silently start later. Its only refusal is `SCOPE_MISMATCH` (`InternalAnswer`, `conversation.ts:130`), and `internalRefusal` takes no data (`internal/errors.ts:7`). |
| The gap path | A `FACT_GAP` with a watermark from 0 to `written` is stored as `acknowledged`, and the delivery goes on from it (`facts.ts:97`, `delivery.ts:53`). Below deleted rows it would skip them in silence. |
| The stream's end | A socket gets `end` only once its cursor reaches `runs.event_seq` (`conversation/stream.ts:121`). With the events deleted and the counter kept, it would stay open. |
| A run's pi session | Created by `pi.createConversation`, history replay included, and only then claimed on the run (`claimSession`) in a separate step (`conversation.ts:517`, `:528`). A reset between the two leaves a pi conversation no run names, and the retry creates another. |
| Deletion | `deleteConversation` marks the index's `deleted_at` (`internal/recovery.ts:112`), then the object marks itself deleted, answers prepared starts, cancels its run, closes its streams, and destroys its scripts and sandbox (`conversation.ts:347`). Facts, the folder and blobs stay. |
| Late commands | `startRun` on a deleted conversation runs `deleteInternal` again and then `startInternal`, which answers a stored answer or refuses `CONVERSATION_DELETED` (`internal/runs.ts:28`). `cancelRun` goes to `cancelInternal` directly (`internal/runs.ts:36`). The object binds itself on first use (`store.ts:445`), and its constructor migrates its schema (`conversation.ts:221`), so a command that reached a destroyed object would make it again. |
| Lifecycle's failures | A job that throws is tried three times, then dropped unless its error hook answers an outcome (`agents/dist/lifecycle-DGorpAmA.js:604`, `:630`). Only a platform failure (a reset) keeps it for a fresh invocation (`:619`). |
| The SDK's `destroy()` | Writes a marker, deletes the alarm, then deletes all storage (`agents/dist/src-CQxJFv4l.js:5789`). The marker is honoured on the next alarm (`:3884`), which a reset between the alarm's deletion and the storage's would not get. |
| pi's tables | `pi_` plus pi-durable 1.2.0's schema version 1: `durable_metadata`, `record_ids`, `conversations`, `entries`, `tasks`, `submissions`, `documents`, `document_revisions`, `durable_schema` (`node_modules/@earendil-works/pi-durable/dist/storage/sqlite/migrations.js`; the prefix in `agents/dist/harness/pi/index.js:29`). Each run gets its own pi conversation (`runs.session`), seeded with the history the start carried, up to 20 messages and 120,000 characters (`history.ts:10`, `:16`). The root conversation is id 1 (`pi-durable/dist/types.js:2`). pi-durable deletes no conversation, entry, task or submission. |
| Staged uploads | Laravel signs `uploads/<workspace>/<32 hex>` in the engine's EU files bucket (the app's `app/Files/Uploads.php:83`, `config/services.php:71`). `r2-lifecycle.json`'s rule deletes every `uploads/` object a day after it was written, and the deploy refuses a bucket without it (`scripts/resources.ts:60`, `scripts/lifecycle.ts:42`). |

## Decisions

### Every record, its period and its clock

| Record | What it is | Kept | Clock |
|---|---|---|---|
| `run_events` | The stream's replay | 30 days | The run's `finished_at` |
| `runs.snapshot`, `run_snapshots` | The run's inputs: snapshot, instructions, history, prompt | 30 days; the column is emptied, the parts deleted | `finished_at` |
| `tool_arguments` | A call's arguments, kept for its fact | 30 days | `finished_at` |
| `attempts`, `tool_executions` | Attempt bookkeeping and the replay cap (dedupe within the run) | 30 days | `finished_at` |
| `call_records`, `script_records` | Settle-once records (dedupe within the run) | 30 days, and only after `run.settled` | `finished_at` |
| `run_writes`, `page_tokens` | The write ledger (a repeated write gets the first's outcome) and cursors | 30 days | `finished_at` |
| pi's rows of `runs.session` | The run's pi conversation | 30 days | `finished_at` |
| A pi conversation no run names | A session a reset left before it was claimed | Deleted when found, while no run is active | None |
| `runs` row (without its snapshot), `internal_answers`, `tombstones` | **Dedupe records** of Laravel's commands | Until the conversation is destroyed | None |
| `conversation`, `fact_delivery` | The binding, `deleted_at`, `written` (never lowered) | Until destroyed | None |
| `facts` | The outbox | 7 days after Laravel acknowledged it, never before (owner question 3) | The acknowledgement |
| `fact_acknowledgements` (new) | When Laravel acknowledged up to a sequence | Until its facts are pruned | Its own time |
| Folder versions, blobs, `folder_blobs` | The files | Until destroyed (Out of 15a) | None |
| The object as a whole | | 7 days after deletion, once every fact is acknowledged and pruned | `deleted_at` |
| `recovery_conversations`, `recovery_runs` (D1) | **Dedupe records**: binding, `input_digest`, `deleted_at`, `fact_seq`, the new `purged_at` | For good (owner question 2) | None |

The 30 days count from the run's end, the moment the run stops changing. Every record that deduplicates a command from Laravel outlives any retry, since those have no bound: it goes only with the object, after which the index refuses the command (Physical deletion). The records that deduplicate within a run (the ledger, the replay cap, the settle-once records, pi's `run:<id>` submission) are needed only while the run can resume or settle, which ends long before 30 days.

The dedupe records are not opaque ids alone. A stored acceptance lists the start's attachments with their names and folder paths, and a run's row keeps its folder changes and warnings, which name files. They are kept on purpose, as the files themselves are, until the conversation is deleted.

### A run's retention state

A run gets a state of its own, `runs.prune` (step 15): null while it is kept; `records` once its prune has started; `pi` once its own rows are gone and its pi session's remain; `done`. `runs.pruned_at` is the time it started.

- **`records`.** The first step of a run's prune empties `runs.snapshot`, sets the state and the time. From then `RunStore.snapshot()` throws (its readers are the loop, the local run and the executor, which only an active run reaches: `conversation.ts:513`, `:976`, `:1157`); `#stopPi` returns at once; and the stream sends `end` at once for the run, whatever its cursor, since its events may be partly gone (the fix for `stream.ts:121`). `event_seq` is kept.
- **`pi`.** Its own tables are empty. Its pi session's rows are deleted when pi's deletion is available (pi's tables, below), else the run waits here.
- **`done`.** Nothing of the run is left but its row, its answer and its tombstone.

A partial index, `runs (finished_at) WHERE finished_at IS NOT NULL AND (prune IS NULL OR prune != 'done')`, finds the runs to work on.

### The `retain` job

**One job per object**, id `retain`, a Lifecycle job of the host like `files` and `sweep` (`conversation.ts:676`). It is pushed, moved only earlier, as `files` is (`conversation.ts:1436`):

- by the delivery's step that stores an acknowledgement, for `now + 7 days`, when what it acknowledged is due;
- by `deleteInternal`, for `deleted_at + 7 days`;
- by `#recover`, for the next due time computed from the data, so an object from before the deploy gets its job when it next wakes.

**A pass** does, in this order, until nothing is due or 250 ms have passed:

1. **Nothing while a run is active or a start is prepared.** The pass ends and comes back in an hour. A turn never waits behind a prune, and a preparation cancelled without a run finishing is still followed by a pass.
2. **Facts** (Facts and the floor).
3. **Runs**, the oldest due first (A run's steps).
4. **Orphan pi conversations** (pi's tables).
5. **The purge**, for a deleted conversation (Physical deletion).
6. **The next time**, computed last with no await after it, as the folder's sweep does (`files/store.ts:1072`). Now, if the pass stopped on its budget. Else the earliest of: the oldest run not `done`'s `finished_at + 30 days`; the oldest acknowledgement mark's time `+ 7 days`; `deleted_at + 7 days`. An item that is due but blocked (a run not settled, a pi session with live work, a deleted conversation whose facts are not all acknowledged) counts as a day from now. No job when nothing is left.

**Bounded.** A step is one `transactionSync`, made with `outside` (`store.ts:397`) so it never joins a transaction of pi's, and deletes at most 500 rows (`RETENTION.rowsPerStep`), in each table's key order. Rows of a table are bounded in size by their writers (an event, an entry, a part of at most 2 MB), so a step is bounded too, and a run of any size takes as many steps as it needs. The pass checks its 250 ms budget between steps and between R2 calls.

**Idempotent.** A step selects what it deletes and records how far it got in the same transaction: the run's state, the floor, or simply the rows that are no longer there. A kill rolls back the step in flight. The next pass starts again from step 1 and finds only what is left.

**It never throws.** Every failure (R2, D1, the sandbox, an unexpected error) is logged and answered with a reschedule, 30 s doubling to an hour as the folder's sweep does (`files/store.ts`, `backoff`), so Lifecycle never drops the job after its three tries. A reset is a platform failure, which Lifecycle keeps the job for.

**With the alarm's other jobs.** Lifecycle runs due jobs one after another. A pass's budget, rescheduled for now when work is left, lets `facts`, `settle`, `files` and `sweep` run between passes.

**Periods.** Constants in a new `conversation/retention.ts`, `RETENTION = { runMs: 30 days, factsMs: 7 days, deletedMs: 7 days, busyMs: 1 hour, blockedMs: 1 day, passMs: 250, rowsPerStep: 500 }`, which the platform tests shorten as they shorten `FACT_DELIVERY`. The test build's plan (`src/faults/plan.ts`) gains `retention`, so one conversation on the test instance can have periods of minutes, as it can have `run_timeout_ms`. Production has no setting.

### Facts and the floor

**The acknowledgement marks.** A new table, `fact_acknowledgements (seq INTEGER PRIMARY KEY, at INTEGER NOT NULL)`. Each accepted acknowledgement inserts `(acknowledged, now)` in the step that stores it (`delivery.ts:50`), `ON CONFLICT DO NOTHING`, and pushes `retain` (above). A `FACT_GAP` that lowers `acknowledged` deletes the marks above the new watermark in its step, since Laravel no longer holds them. A batch is one row, so the table has a few rows per run until they are pruned.

**The cut.** `cut = min(acknowledged, max(seq) of the marks whose at ≤ now − 7 days)`. Every fact at or below a mark was acknowledged at or before the mark's time, so every fact at or below the cut was acknowledged more than 7 days ago. A fact above `acknowledged` is never below the cut.

**Why the acknowledgement, not `created_at`.** A Laravel restored to a point P holds what it acknowledged before P. A restore point is at most 7 days old, so a fact acknowledged less than 7 days ago may be needed again, whenever it was written. Pruning by `created_at` would delete a fact written 8 days ago and acknowledged yesterday, which a restore to the day before yesterday needs. The restore itself takes time, during which pruning goes on, so the usable window is 7 days less that time (owner question 3).

**The floor.** A new column, `fact_delivery.floor INTEGER NOT NULL DEFAULT 1`: the lowest sequence still held. Every fact below it is deleted, every fact from it to `written` is held. Facts are deleted from the floor upwards, at most 500 a step, and each step raises `floor` past what it deleted in the same transaction, then deletes the marks below the floor. The floor never falls.

**The replay's refusal.** `replayInternal` reads the floor in the same synchronous step as the page. An `after` below `floor − 1` (Laravel lacks a fact the engine no longer holds) is refused with `FACTS_PRUNED`, `data: { floor }`, instead of a page that starts later. `after ≥ floor − 1` is answered as today. `InternalAnswer` gains `{ ok: false, code: "FACTS_PRUNED", floor }`, and `internalRefusal` an optional `data`, so the floor reaches Laravel through the oRPC route.

**The gap path.** `gap()` (`facts.ts:97`) gains the floor. A watermark below `floor − 1` is a new verdict, `pruned`: `acknowledged` is left as it is, `stopped` says "Laravel lost facts up to the floor F, which the engine no longer holds (FACTS_PRUNED)", it is logged as an error, and it is tried again hourly, as a `FACT_CONFLICT` is (`delivery.ts:127`). It resumes by itself once Laravel's watermark is at or above `floor − 1`. Storing the watermark would make the next batch start at the floor and skip the lost facts in silence.

**The contract (additive).** `INTERNAL_REFUSALS` gains `FACTS_PRUNED: 410` (Gone), and `INTERNAL_ERRORS` its data, `z.object({ floor: Seq })`, in `contract/src/internal/common.ts`. Every operation declares every code, as today; only `replayFacts` answers it, and its doc comment says so. `pnpm --dir contract openapi` regenerates both documents, and contract.md's table of errors gains it. Laravel does not call `replayFacts` yet (15c will), and its `EngineClient` already decodes any code with its data (the app's `app/Engine/EngineClient.php:256`), so the app's part is `composer contract:sync` and a Pest test that the refusal reaches `EngineRefusal` with its floor, not retryable. Laravel deploys first, per the plan.

### A run's steps

**Due.** A run whose `finished_at` is at least 30 days old, not `done`, and settled: `metered = 0` (runs older than chunk 14a) or `settled_at` set.

**`records`.** Each step deletes up to the step's rows of the run's `run_events`, `run_snapshots`, `attempts`, `tool_executions`, `tool_arguments`, `call_records`, `script_records`, `run_writes` (as `WriteLedger.forget`) and `page_tokens` (as `PageTokens.forget`), in that order; the step that finds them all empty sets the state to `pi` (or `done` when the run has no session).

**`pi`.** Each step deletes up to the step's rows of the session's pi rows (pi's tables); the step that finds none left sets `done`.

**Kept.** The `runs` row, `internal_answers` and `tombstones`. A repeated start of a pruned run answers its stored acceptance, a cancel answers `cancelled` or `ended`, and its stream ends at once.

### pi's tables

**The deletion.** For a session S, in this order, each a bounded step: the revisions of the documents scoped to S, to one of S's tasks, or to a conversation S or its tasks own (Minerva makes only ownerless ones, so that set is S alone, but the statements cover it); those documents; the `pi_record_ids` of those documents, entries, tasks, submissions and conversations; the entries, tasks and submissions; the conversations' rows last. Each statement reads through an index that exists (`entries_by_conversation`, `tasks_by_conversation`, `submissions_by_conversation`, `documents_by_scope`, `conversations_by_owner_*`, the primary keys). The conversation's row goes last, so a session part-deleted is still found by its run, or as an orphan.

**Guards**, read in each step:

- **pi's schema is version 1** (`pi_durable_schema.version`). Otherwise the pi stage stops, logged once per pass. Runs then wait in `pi`, and their own records are still pruned. An upgrade of pi-durable must be read before this check is raised.
- **No live work.** None of S's tasks has a status other than `terminal`, and none of its submissions is `queued` or `placed`. A session with live work is aborted through pi, as `#stopEnded` aborts an ended run's (`conversation.ts:639`), and skipped for the rest of the pass (a set held in memory), so blocked sessions never hide later ones and are tried once a pass.

**Orphans.** While no run is active (pass step 1), any pi conversation other than the root (id 1) that no `runs.session` names is a session a reset left between `createConversation` and `claimSession`, or a later run's that has been pruned to its last row. Nothing can claim it then, since only an acting run's loop creates sessions. Each pass drains the first such conversation within its budget.

**Why this is expected to be safe** (inferred from pi-durable 1.2.0's code; unit 1 proves or refutes it):

- **Ids are never reused.** pi mints ids from `durable_metadata.next_id`, which only grows, never from the rows (`storage/sqlite/storage.js:85`, `:103`, `:123`). `record_ids` only checks that an id is not claimed twice (`:457`).
- **Nothing reads a whole table on the paths Minerva uses.** pi's open, its scheduler and its inspection scan tasks and submissions by live status (`harness/scheduler.js:138`, `harness/harness.js:159`, `harness/task-graph.js:79`), and Minerva reads pi by conversation id (`conversation.ts:828`, `:901`, `submissionByRequest`). The only scans of every conversation, `Harness.usage()` and PiHarness's `sessions.list()` (`agents/dist/harness/pi/index.js:669`), are never called by Minerva.
- **No foreign keys** tie pi's tables together, and a session's documents are found by scope and owner (`documents_by_scope`).
- **The root conversation** that PiHarness opens (`pi.root`, `index.js:535`) is never a run's session, so it is never touched.
- **pi's in-memory caches are not proof by time.** On Workers pi evicts an idle document only at the end of a later commit, and a document with an observer stays pinned (`session/session.js:426` to `:500`). A deleted session's cached documents are never read again, since nothing names that session any more, so a stale entry is memory only. The proof therefore runs with the same Harness open, not only after a reopen (below).

**The measurement** (unit 1). The test build's driver gains a read of an object's storage: `databaseSize`, and per table its row count and the summed length of its TEXT and BLOB columns (from `PRAGMA table_info`). An account probe (`MINERVA_PERF=1`) runs 20 turns in one conversation on `minerva-cf-test` with the fake model, each with a tool call and an answer of 2,000 characters. Each start carries the conversation's history as Laravel sends it (the latest 20 messages, within the caps), since the driver's `post()` sends none (`test/account/driver.ts:183`). It records each turn's growth per table. Expected from the code: pi's rows and `runs.snapshot` both carry the run's history (up to 120,000 characters each), so together with `run_events` they are most of a run's bytes, tens to hundreds of kilobytes a run (a guess; As measured, below, replaces it).

**The two outcomes.**

- **Delete by session (expected).** A unit test over node:sqlite opens pi-durable's own `SqliteStorage` and Harness, runs two conversations to the end with their documents cached, deletes the first's rows with the statements above while the same Harness stays open, then runs a third conversation to its answer, commits, reads the second's history unchanged, and does it all again after reopening the Harness from the same database. A platform test then prunes a run with short periods right after it ended and runs another turn that is reset mid-turn (a fault point's `abort`), restarts and completes. A third test resets the object between `createConversation` and `claimSession` (a new fault point, `loop:created`), and the orphan is drained once the run has ended. All pass: the pi stage is built in unit 3.
- **Growth as a risk.** If any fails, unit 3 builds the `records` stage alone, and runs stop in `pi`. The growth per run (the measurement) goes into Appendix C, ARCHITECTURE.md's open question 3 stays open until pi-durable has a delete call, and chunk 15a's pi box is recorded as not met, not as done.

**A local measurement already taken.** In local workerd, a Durable Object's `databaseSize` went from 20,504,576 to 2,064,384 bytes after deleting 90% of a table's 20 MB, with no VACUUM (which it refuses, as it refuses `PRAGMA auto_vacuum` and `incremental_vacuum`). So deleted pages are released, and the perf rule's "storage after" is measurable as `databaseSize`. Unit 1 checks the same on the test instance.

**As measured** (unit 1, 2026-10-17, on `minerva-cf-test`). `MINERVA_PERF=1 pnpm test:faults test/account/retention-measure.test.ts`, run twice: every turn's rows and `databaseSize` were the same in both runs, and its bytes within 1 byte (15 bytes over the 20 turns, in the facts' timestamps). The fake model, 20 turns in one conversation, each a call of `notes_list_notes` and an answer of 2,000 characters, each start with the latest 20 messages of the conversation (a user message, the turn's script, is about 2,070 characters). The history reaches its cap of 20 messages, about 41,000 characters, at turn 11, so turns 11 to 20 grow alike. Bytes are the summed length of a table's TEXT and BLOB columns, read after the turn's `run.settled` reached the fake Laravel.

| Table | Turn 1, no history: rows, bytes | Each of turns 11 to 20: rows, bytes | 20 turns: rows, bytes |
|---|---|---|---|
| `pi_entries` | 5, 14,667 | 25, 60,730 | 390, 961,240 |
| `pi_document_revisions` | 10, 1,349 | 5, 1,189 | 105, 23,938 |
| `pi_documents` | 10, 1,523 | 5, 790 | 105, 16,463 |
| `pi_tasks` | 3, 898 | 3, 912 | 60, 18,184 |
| `pi_record_ids` | 21, 151 | 35, 199 | 596, 3,482 |
| `pi_submissions` | 1, 183 | 1, 188 | 20, 3,740 |
| `pi_conversations` | 2, 16 | 1, 10 | 21, 202 |
| **pi's tables** | 54, 18,789 | 75, 64,018 | 1,299, 1,027,252 |
| `runs` | 1, 3,963 | 1, 45,824 | 20, 686,245 |
| `run_events` | 11, 4,884 | 11, 4,884 | 220, 97,680 |
| `facts` | 7, 4,233 | 7, 4,254 | 140, 84,939 |
| `call_records` | 2, 382 | 2, 382 | 40, 7,640 |
| `internal_answers` | 1, 249 | 1, 249 | 20, 4,980 |
| `attempts`, `tool_executions` | 2, 96 | 2, 96 | 40, 1,920 |
| **Every table** | 80, 32,706 | 99, 119,707 | 1,781, 1,910,766 |
| `databaseSize` | 397,312 to 577,536 | 147,456 to 176,128 more a turn, median 163,840 | 397,312 to 3,174,400 |

Turn 1 includes the object's first rows: pi's schema and metadata rows (in pi's total), the root conversation with its 5 documents and revisions, and `conversation` and `fact_delivery` (in every table's). The test build's `fault_entered` (2 rows, 81 bytes a turn) is left out. A run whose history is at the cap keeps about 120 kB: pi's rows are 53% of it and `runs` (the snapshot, which holds the history again) 38%, so the history is stored twice a run, once in each. `databaseSize` grows by about 1.4 times the column bytes (pages, indexes, keys). A real model's turns make more calls and write longer answers, so they would keep more entries and events (inferred, not measured): these numbers are a floor.

The scratch table, in a conversation of its own: `databaseSize` was 397,312 bytes empty, 20,496,384 with 200 rows of 100,000 random bytes, 2,473,984 after deleting 180 of them, and 397,312 after dropping the table, in both runs. Deleted rows give their pages back on the platform too, without VACUUM, so `databaseSize` measures the perf rule's "storage after".

**Which outcome holds: delete by session.** `test/unit/pi-tables.test.ts` runs pi-durable 1.2.0's Harness over node:sqlite on PiHarness's own session store (`openPiSessionStore`, the `pi_` tables), with pi's documents kept in memory for the default ten minutes and, again, evicted at once. Two runs' sessions are seeded with history, each run makes a tool call and answers. The first session is deleted (`src/conversation/pi-tables.ts`, `deletePiSession`, 5 rows a step) while the same Harness stays open: what remains equals the rows before less the session's (its entries, tasks, submissions, documents, their revisions and record ids, and its row), with exact counts per table. The second session then answers another turn and a third session starts and answers on that Harness, and nothing of the first comes back. Reopened from the file, the third session is deleted, a fourth answers, and a fifth, cut off mid-turn by dropping its instance without a close, resumes in the next one and answers. The second session's entries are unchanged throughout. The guards leave a session with a running model call, or pi's schema at version 2, untouched, and an orphan (a session with history no `runs.session` names) is found and drained while claimed ones and the root are not. Two deliberate breaks, `conversation_id >= ?` for entries, tasks and submissions and `document_id >= ?` for revisions, each failed the test. So unit 3 builds the pi stage and the orphan drain on these statements; its platform tests (a prune right after a run, a reset mid-turn after it, the reset at `loop:created`) are the last check before the box is met. At the history's cap a run's pi rows are 75 rows a step counts (a record and its `pi_record_ids` row are two), so one step of 500 removes a run's session.

### Physical deletion

**When.** In the pass's step 5, read in one synchronous step: the conversation is Laravel's and deleted, `deleted_at` is at least 7 days old, no run is active and no start prepared, every metered run is settled, no write is dispatched, `acknowledged = written`, and the `facts` table is empty. The last condition holds only once the facts' own rule has pruned every fact, so the object also outlives its last acknowledgement by 7 days.

**The order**, each step idempotent, run again from the first after a failure or a kill:

1. **deleteInternal's clean-up again**: scripts destroyed, sandbox destroyed and not `cleanupPending` (`conversation.ts:368`).
2. **Marked purged in D1**: `UPDATE recovery_conversations SET purged_at = coalesce(purged_at, ?) WHERE id = ? AND organization_id = ? AND workspace_id = ? AND deleted_at IS NOT NULL`. From here a command that reads the index no longer reaches the object.
3. **The R2 prefix**: `deletePrefix` over `blobs/<ws>/<conv>/` (`files/objects.ts:28`), whether the folder recorded each object or not, a page of 1,000 at a time, at least one page a pass and then within the budget, each call bounded by a timeout as the jobs' calls are (`RPC_WAIT_MS`).
4. **The storage**: `ctx.storage.deleteAll()`, one operation that removes every table (ours, pi's and the SDK's) while the alarm still stands, then the SDK's `destroy()` for its own teardown and abort. Deleting first means a reset inside `destroy()`, after it removed the alarm (What the code does today), strands no data: what could be left is empty.

**What survives.** The `recovery_conversations` row with `deleted_at`, `fact_seq` and `purged_at`, and its `recovery_runs` rows. 15c's listing reads them.

**A late command**, refused by the Worker from the index, before the object:

| Command | Answer for a purged conversation |
|---|---|
| `startRun` | Refused `CONVERSATION_DELETED`, "This conversation was deleted." A start accepted before the deletion and sent again now gets this, not its acceptance; the conversation is gone either way |
| `cancelRun` | `{state: "ended"}` |
| `deleteConversation` | `{outcome: "deleted"}` |
| `replayFacts` | Every fact was acknowledged, so `written = fact_seq`: an empty page for `after ≥ fact_seq`, else `FACTS_PRUNED` with `floor: fact_seq + 1` |
| `folder`, `resolveDownload`, the stream | `NOT_FOUND` or 404, as for any deleted conversation |

`bindRun` may still insert a run's row for a new run id before the refusal. It is harmless, and kept so the index's batch does not change.

**Commands already in flight.** A command that read the index before the mark can still reach the object after the purge. Any such command read `deleted: true`, since the purge comes 7 days after the deletion. So `cancelRun` on a deleted conversation runs `deleteInternal` first, as `startRun` already does (`internal/runs.ts:31`). A command in flight then makes the object again only as a deleted conversation, which pushes its own `retain` and purges itself after its window: the D1 mark is kept, R2 is empty, and its storage goes again. A read in flight (`folder`, `resolveDownload`, `replayFacts`, the stream) binds nothing, and leaves at most the empty schema the constructor migrates, with no data and no alarm.

**Facts never acknowledged.** The object then stays: its facts, its folder rows and its blobs. Its runs are still pruned after 30 days. From `deleted_at + 7 days` the pass logs an error once a day ("a deleted conversation is kept: N facts are not acknowledged"), and the delivery goes on retrying as it does. The cause is on Laravel's side. A deleted conversation's late facts are acknowledged through its `deleted_conversations` tombstone (the app's `app/Runs/Facts.php:81`), so 15b must keep that tombstone. The engine never destroys an unacknowledged fact, which may be money (owner question 1).

### Staged uploads

Covered, so no fix. Laravel's keys are `uploads/<workspace>/<random>` in the engine's EU files bucket, the bucket's rule on `uploads/` deletes them a day after they were written, and the deploy refuses a bucket without that rule (What the code does today). Unit 5's live check reads the rule on staging's bucket with `cf r2 buckets lifecycle get`. The removed reservations whose PUTs can still write (chunk-14d-design.md, owner question 6) are the gate's, not 15a's.

### Out of 15a

- **Version manifests.** Every turn's version stays downloadable (chunk-14d-design.md), and the owner keeps files until the conversation is deleted, so a live conversation's manifests are not pruned. Pruning them is a retention rule for files, which would also need a stored-bytes report outside a run (14d, What 15 and 16 inherit). A deleted conversation's go with its storage.
- **The Sandbox object's rows.** `container_spans` and `sealed_runs` keep a run id, an incarnation and times per container, about 100 bytes a run, no content of the conversation (`sandbox/schema.ts:34`). They stay after the purge. A `forget` call at the purge's step 1 would remove them, if wanted later.
- **The recovery index's rows**, kept for good (owner question 2).
- **The unused tables** of chunk 13b (`messages`, `starts`, `releases`, `start_keys`): Laravel's conversations never wrote them.
- **Objects that never wake.** An object from before the deploy gets its `retain` job only when something wakes it (`#recover`). An abandoned conversation on staging, or one deleted there before the deploy, keeps its data until then. Production has no users, and staging's are test data. A Worker cron over the index's deleted rows would reach them, if it is ever needed.

### The schema, and rollbacks

- **Conversation step 14** (facts): `fact_delivery.floor`, `fact_acknowledgements`, and a mark for what was acknowledged before the step, at the time of the migration: `INSERT INTO fact_acknowledgements (seq, at) SELECT acknowledged, CAST(unixepoch('subsec') * 1000 AS INTEGER) FROM fact_delivery WHERE acknowledged > 0`. Staging's facts are then kept 7 days from the deploy, the conservative reading.
- **Conversation step 15** (runs): `runs.prune`, `runs.pruned_at`, and the partial index on `finished_at`.
- **D1 `0014_purged_conversations.sql`**: `ALTER TABLE recovery_conversations ADD COLUMN purged_at INTEGER`. `IndexedConversation` and `Bound` gain `purged`.

All are additive, so staging's objects and index keep their data. Additive is not enough for a rollback, though. Code from before a unit replays without the floor, takes a gap below it, reads a pruned run's empty snapshot, and lets commands reach a purged object. **Once an instance has run a unit's deletion, the engine is never rolled back below that unit's commit.** The deploy notes in cloudflare/README.md say so. Each unit ships its checks in the same commit as its deletion, so there is no safe intermediate release to keep, and production has no users.

## What 15b and 15c inherit

- **15b.** Laravel must keep each `deleted_conversations` row (the tombstone that acknowledges a deleted conversation's late facts) at least until the engine has purged the conversation. Laravel cannot see the purge, so the simple rule is to keep the rows for good, like the engine's index. Without them a late fact is `NOT_FOUND`, and the object is never destroyed.
- **15c.** A conversation can be replayed from a watermark w only while `w ≥ floor − 1`. `FACTS_PRUNED` names the floor, and the runbook reports such a conversation to the operator. A delivery stopped as `pruned` says the same in its log. A purged conversation is listed with `deleted_at` and `purged_at` and needs nothing replayed. The restore point must be younger than 7 days by at least the time the restore takes to reach replay, which the rehearsal measures, unless owner question 3 adds a margin.

## Units

Each unit is for one fresh agent, in this order, and is done when its checks pass and it is committed to the main of its repository. Engine checks: `pnpm typecheck`, `pnpm test:unit` and `pnpm test:platform` in `cloudflare/`, and `pnpm typecheck` and `pnpm openapi:check` in `contract/`. App checks: `composer test`, `pnpm run check`, `pnpm run types:check` and `pnpm test`. opencode reviews the diffs of units 2, 3 and 4.

1. **Measure pi and prove its deletion (harness, test build and tests only).**
   - The driver's storage read (`src/faults/`), and the account probe of 20 turns with their history (`test/account/retention-measure.test.ts`, `MINERVA_PERF=1`), run on `minerva-cf-test` after `pnpm run deploy:test`. It also deletes 90% of a scratch table and reads `databaseSize`, to confirm the local measurement on the platform.
   - The pi deletion's statements in `src/conversation/pi-tables.ts`, not yet called by production code, and the unit test over node:sqlite with the Harness kept open (The two outcomes).
   - Check: the unit test passes; the numbers per table and turn are recorded in this document (As measured). They decide unit 3's pi stage.
2. **Facts and the floor (harness: contract and engine; then the app's sync).**
   - The contract's `FACTS_PRUNED`, the OpenAPI documents, contract.md.
   - Conversation step 14; `conversation/retention.ts`; the `retain` job with pass steps 1, 2 and 6, its pushes, its never-throwing outcome; the marks in the delivery; the replay's refusal through `InternalAnswer` and `internalRefusal`'s data; the `pruned` verdict; a fault point `retain:step` (detail: the step) after each committed step, in the test build.
   - Docs: ARCHITECTURE.md (Facts: retention, the floor, `FACTS_PRUNED`), credentials-and-facts.md (Replay; Delivered in order), and the rollback rule in cloudflare/README.md.
   - Unit tests: the cut from marks and `acknowledged`; `gap()` with a floor; the next time.
   - Platform tests: an unacknowledged fact is never pruned, however old; an acknowledged fact is kept 7 days after its acknowledgement, not its writing, and a late acknowledgement moves the job earlier; a replay below the floor through the Worker's route is refused `FACTS_PRUNED` with the floor, and one at `floor − 1` is answered; a `FACT_GAP` below the floor stops the delivery and leaves `acknowledged`, and one above it goes on; an object migrated from step 13 gets its mark; an `abort` at `retain:step` after the first facts step, then the next alarm finishes, and every unacknowledged fact is still there; a failing step reschedules and keeps the job; nothing is pruned while a run is active, and a pass blocked by a preparation that is then cancelled runs within the hour.
   - The app: `composer contract:sync` from this commit, and the Pest test of the refusal's floor. Pushed to the app's main, it reaches staging through CI.
3. **Runs (harness: engine).**
   - Conversation step 15; the run states; pass steps 3 and 4; the guards in `snapshot()`, `#stopPi` and the stream; the pi stage and orphans if unit 1 proved them.
   - Docs: ARCHITECTURE.md (Attempts and recovery; Events and the stream; open questions 3 and 5 answered or narrowed).
   - Platform tests: a run past 30 days has no events, inputs, attempts, bookkeeping, call or script records, ledger, page tokens or pi rows, and keeps its row, answer and tombstone; a repeated start answers its stored acceptance, a cancel `ended`; its stream ends at once from cursor 0, from a cursor inside its old events and from its last; a run not settled is not pruned; more than one pass's worth of runs with live pi work ahead of one without, and the later one is still pruned in the first pass; a single run with 10,000 events takes several steps, each within the budget; with short periods, a run pruned right after it ended, then another turn reset mid-turn by an `abort`, which restarts and completes; a reset at `loop:created`, and the orphan drained after the run ends; an `abort` at `retain:step` mid-run, then the next alarm finishes.
4. **Physical deletion (harness: engine and D1).**
   - D1 `0014`; the Worker's refusals for a purged conversation; `cancelRun`'s `deleteInternal` first on a deleted conversation; pass step 5, with the daily error for facts not acknowledged; the fault point's detail per purge step, and one between `deleteAll()` and `destroy()`.
   - Docs: ARCHITECTURE.md (Files, Deletion), start-and-cancel.md (The recovery index).
   - Platform tests: a deleted conversation with unacknowledged facts is not destroyed and logs; one whose last acknowledgement is under 7 days old is not destroyed; then it is: its object's storage is empty, its R2 prefix is empty, its index row has `purged_at`; afterwards `startRun` is refused `CONVERSATION_DELETED`, `cancelRun` answers `ended`, `deleteConversation` `deleted`, `replayFacts` an empty page or `FACTS_PRUNED`, and the stream 404; a cancel sent to the object as a Worker that read the index before the mark would send it (`deleteInternal`, then `cancelInternal`) makes a deleted conversation that purges itself again after its window; an R2 failure past three tries keeps the job; an `abort` after each purge step and between `deleteAll()` and `destroy()`, then nothing of the conversation's data is left.
5. **The live checks, the perf probe and the boxes (harness).** After the deploys below, the live checks, then remaining-chunks.md's 15a boxes with their evidence.

**Deploy order.** The app first: unit 2's sync pushed to the app's main reaches staging through CI. Then the engine to `minerva-cf-test` (the agent), and, after a green `account.yml` on the commit, to `minerva-cf-staging` and production, which the owner approves (AGENTS.md). On staging this starts pruning runs that ended more than 30 days ago, and facts 7 days after the deploy, as each object wakes.

## Live checks

| Check | Where | Who |
|---|---|---|
| The engine's regression: `pnpm run deploy:test`, `pnpm test:faults` | `minerva-cf-test` | The agent |
| A new case in `test:faults`: a conversation with periods of minutes and two finished turns; an `abort` at `retain:step` after the first step; the next alarm finishes; the runs' events, inputs and pi rows are gone, every unacknowledged fact remains (the fake Laravel holds some back), and a replay below the floor is refused | `minerva-cf-test` | The agent |
| You see: periods of minutes, a finished conversation's run events gone and its facts kept until acknowledged; a deleted one's blobs and object gone after its window, and a late start refused | `minerva-cf-test` | The agent |
| The rule on `uploads/` is on the bucket Laravel's staging names in `MINERVA_R2_BUCKET` (`cf r2 buckets lifecycle get`); record that it is, not the bucket's name | The account | The agent |
| Deploy the engine to `minerva-cf-staging` and production | The account | The agent, after asking the owner |

## Perf probe and rule

**The probe.** On `minerva-cf-test`, `MINERVA_PERF=1`, two conversations:

- **1,000 turns** of the fake model, one after another, each with a tool call and an answer of 2,000 characters, and each start with the conversation's history, so the history grows to its cap as a real conversation's does;
- **one large turn**: 200 tool calls and a long streamed answer, about 10,000 events.

For each, the plan sets the periods to zero, every fact is acknowledged by the fake Laravel, and the driver reads `databaseSize`, makes `retain` due and records each pass's wall time on the object's clock (a `note` at the pass's start and end) until no job is left, then reads `databaseSize` again. Main has no prune, so the base is the same conversation before the job; there is nothing to interleave.

**The rule.** Every pass under 1 s of wall time, and `databaseSize` after under 10% of before, for both. Any failing fails. The whole chain's time is recorded, not judged. The box's "one alarm's prune" is read as each alarm's, since a pass is bounded at 250 ms by design: one alarm pruning every run at once would block the object for as long as that takes. If a pass runs over, `rowsPerStep` is lowered and the probe runs again.

**Expected.** What remains is a row and a stored answer per run, about a kilobyte (a guess), against the tens of kilobytes or more a run keeps today (unit 1 measures it). Under 10% is expected.

## Risks

- **pi's rows** are deleted by statements over another library's schema. The schema version is checked at every step, and pi-durable's upgrades must be read for it; behaviour can change within a version, so the unit test runs against each pi-durable the engine takes. If unit 1 or 3 fails, the growth stays (Appendix C).
- **Facts never acknowledged** keep a deleted conversation, its blobs included, for good (owner question 1). It is logged daily.
- **A restore older than the floor** cannot be replayed, and the restore's own duration shortens the usable window (owner question 3). A longer backup retention than 7 days does not lengthen what the engine can replay.
- **Rollbacks** below a unit that has deleted are unsafe (The schema, and rollbacks).
- **Version manifests** and the Sandbox object's per-run rows grow with every turn, and only deletion removes them (Out of 15a).
- **Objects that never wake** after the deploy keep their old data (Out of 15a). Staging only.
- **The index grows for good**: a row per conversation and per run in D1, about 150 bytes each (a guess). D1's 10 GB holds tens of millions of them.
- **A start resent after the purge** is refused, though its run may have been accepted before the deletion. Laravel's conversation is deleted by then.
- **A read in flight at the purge** can leave an empty schema in the destroyed object, with no data and no alarm.

## Owner questions

1. **Facts a deleted conversation never gets acknowledged.** Default: the object is never destroyed while it holds an unacknowledged fact, which may be usage or a write's settlement; the engine logs an error once a day, and the fix is Laravel's (15b keeps its tombstones). The alternative is to destroy it anyway after a longer bound, such as 30 days, losing those facts.
2. **The recovery index's rows.** Default: kept for good, the conversations' and the runs' alike, since they refuse a late command and 15c's listing reads them; they hold ids, a jurisdiction, times and a sequence, no content. The alternative is to delete a purged conversation's rows after a year, past which a late command would bind a new, empty object.
3. **A margin on the facts' 7 days.** A restore point chosen nearly 7 days back loses facts to pruning while the restore runs. Default: the owner's 7 days, and 15c's runbook picks a restore point younger than 7 days by the time its rehearsal measured. The alternative is to keep facts 8 days after acknowledgement (one constant), which also puts a deleted conversation's purge at about 8 days.

## Changes to remaining-chunks.md

This commit links this design from chunk 15a's heading paragraph and corrects what it says the engine prunes today. The Build boxes keep their order and say: the dedupe records kept until the object is destroyed; facts 7 days after their acknowledgement; the error's name, `FACTS_PRUNED`, with `floor`; pi's growth measured with its history, and the box left unmet if deletion is not proved; the purge's order (the index's mark, the R2 prefix, the storage) and its condition (every fact acknowledged and pruned); staged uploads covered by the existing rule. The unit box gains the stream's end, the orphan session and the command in flight. The perf box reads "each alarm's prune" and adds the large run.

## Amendments after opencode's review

opencode (`plan` agent) reviewed the first draft on 2026-10-17 against the checkout and the installed `agents` and pi-durable packages. Each finding was checked in the code. `git status` afterwards showed no change by it.

1. **A purge could be stranded (accepted, both parts).** Lifecycle drops a job that throws three times unless its error hook answers (`lifecycle-DGorpAmA.js:604`, `:630`), so the draft's "Lifecycle keeps the job" was wrong: the job now never throws and answers every failure with a reschedule. `destroy()` deletes the alarm before the storage (`src-CQxJFv4l.js:5796`, `:5799`), and with the index's mark set nothing would wake the object again: the purge now runs `ctx.storage.deleteAll()` first, while the alarm stands, so a reset inside `destroy()` strands nothing but an empty object. An index-driven reconciler outside the object was set aside: with the data gone first, it would have nothing to finish.
2. **Retention missed the events that make work due (accepted).** A late acknowledgement left facts until the runs' 30 days, and a pass that found a preparation dropped its job, which a cancelled preparation never brings back (`conversation.ts:297`). The delivery's acknowledgement now pushes `retain`, and a busy pass comes back in an hour. A pass blocked by settlement retries daily, so no push from the settlement was added.
3. **Orphan pi conversations (accepted).** `createConversation` commits before `claimSession` (`conversation.ts:517`, `:528`), so a reset between them leaves a session with the history that no run names. While no run is active, any pi conversation other than the root that no run names is now drained, with a fault point and a test for the reset. Making the claim atomic with pi's transaction was set aside, since it would move a write into pi's transaction, which every other write of the store avoids.
4. **Additive migrations do not make a rollback safe (accepted).** The older code replays without the floor, takes a gap below it, and ignores `purged_at`. The design now forbids a rollback below a unit whose deletion has run, and says so in cloudflare/README.md. A compatibility release with the checks before the deletions was set aside: each unit ships its checks with its deletion, and production has no users.
5. **7 days of facts against a 7-day-old restore point (accepted as a question).** Pruning goes on during the restore, so the usable window is 7 days less the restore's time. It is owner question 3, with the owner's 7 days as the default and the margin as the alternative; 15c inherits the constraint.
6. **A pruned run's stream would not end (accepted).** `end` waits for the cursor to reach `event_seq` (`stream.ts:121`). A run whose prune has started now ends its stream at once, `event_seq` kept, with tests from three cursors.
7. **Ten runs a transaction was not bounded (accepted).** Nothing bounds a run's events or pi entries. A step now deletes at most 500 rows, a run takes as many steps as it needs with its progress in `runs.prune`, R2's pages count against the pass's budget with a timeout on each call, and the perf probe adds a single large run.
8. **The index does not fence commands already in flight (accepted).** A `cancelRun` that read the index before the mark would bind a fresh, live object (`internal/runs.ts:36`, `conversation.ts:284`). Every such command saw `deleted: true`, so `cancelRun` now runs `deleteInternal` first, as `startRun` does, and an object made again purges itself. Reads in flight leave an empty schema, now a risk. Holding a real Worker request mid-way was set aside for a test that sends the object the same calls directly.
9. **The pi cache argument was too strong (accepted).** pi evicts on a later commit and pins observed documents (`session/session.js:426`). The argument now rests on nothing reading a deleted session again, and the unit test deletes with the same Harness open and keeps working.
10. **Blocked runs could starve later ones (accepted).** A session with live work is now aborted and skipped for the rest of the pass, from a set held in memory, and a test puts more blocked runs than a pass's worth ahead of a free one. A persisted cursor was set aside as heavier than needed.
11. **The pi fallback disabled unrelated retention (accepted).** An unknown pi schema now pauses only the pi stage; a run's own records are still pruned, and runs wait in `pi`. If pi's deletion is not proved, the pi box is recorded as not met.
12. **The floor's data path (accepted).** `InternalAnswer` and `internalRefusal` carry no data (`conversation.ts:130`, `internal/errors.ts:7`); both gain it, and the test goes through the Worker's route.
13. **The probe sent no history (accepted).** `post()` sends `history: []` (`test/account/driver.ts:183`); the probes now send the conversation's history as Laravel does.
14. **The dedupe records are not opaque (accepted as wording).** Stored acceptances list attachments' names and paths, and runs keep folder changes; the design now says they are kept on purpose until deletion, as the files are.

opencode found the acknowledgement marks and the floor sound, and did not check Laravel's side.

**Unit 2's review** (opencode, 2026-10-17, on the built diff). Three findings held and are built: the gap's floor is checked again in the step that stores the watermark, since a pass can raise the floor while the delivery awaits; a `pruned` gap also deletes the marks above Laravel's watermark, so retention stops deleting the facts Laravel lacks that are still held (the acknowledgement itself stays, as above); and a pass returns the time it scheduled as its outcome too, so a schedule that failed does not drop the job.

**Unit 3 as built** (2026-10-17). Conversation step 15 adds `runs.prune`, `runs.pruned_at` and the partial index `runs_unpruned`. A pass's run steps are `RunStore.pruneRecords` (the first empties the snapshot and sets `records`; a step that deletes fewer than its 500 rows has deleted the last, and moves the run to `pi`, or `done` without a session), `prunePi` (unit 1's `deletePiSession`; `gone` sets `done`) and `pruneOrphan` (`orphanPiSession`, which gained a list of sessions to skip). Two additions to the design: a run is due only once no write of it is still `dispatched`, since that write's settlement is a fact not yet written; and a run's end pushes `retain` for `finished_at + 30 days`, so a conversation whose facts Laravel never acknowledges still gets its runs pruned. The next time counts the oldest acknowledgement and the oldest run not `done` separately, so a blocked run (a day from now) never delays a mark that is due sooner; a run that becomes due behind a blocked one waits up to that day. The fault point `loop:created` has the new session's id as its detail.

**Unit 3's review** (opencode, 2026-10-17, on the built diff). The pass awaited pi's abort of a session with live work, which waits until every task ends (`pi-durable/dist/harness/scheduler.js`, `abortConversation`) with no signal: a task that never ended would have held the pass, and with it every later job on the alarm; and an abort longer than the pass's budget would have ended every pass on the same session, so the runs behind it starved across passes (it reproduced this with a stub store). Built: the host starts the abort and does not wait (`RetentionHost.abort` returns nothing; the Conversation defers it), so a live session costs a pass a few reads. Set aside: a blocked session is still tried once a pass, so the runs behind it could starve only if the live checks of the sessions ahead filled a whole pass's 250 ms, which takes thousands of them. Also set aside: `deletePiSession` reads every task of the session on each step (one owned-conversation lookup and one document lookup per task), so its reads are not bounded by the step's rows; opencode measured 30,013 statements for a step over a session of 10,000 tasks (139 ms in Node). A Minerva session holds one turn, three tasks for a turn with one tool call (As measured), so a step reads few rows unless a turn makes a great many calls (inferred); a set-based rewrite of those reads is left until a session can hold many turns. opencode found no race with a resuming run: the busy check is read again in each step's synchronous stretch, after the wait for pi's transactions.
