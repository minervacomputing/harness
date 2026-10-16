# Chunk 14d design: bound storage

Status: proposed, 2026-10-17, in the shape the owner chose on 2026-10-16 (below). This design settles the choices that chunk 14d of [remaining-chunks.md](remaining-chunks.md) leaves open. It splits the work into units that one fresh agent each can finish, and lists what waits for the owner. opencode reviewed it, and the findings that held are folded in (Amendments after opencode's review). Line numbers are at `97444cd` (harness) and at `ef6429f` on the main of `minervacomputing/app` ("the app" below).

## The owner's choice: report at the end of each run, refuse in Laravel

The plan reserved each upload's bytes at presign, moved them into a byte allowance per run that the engine enforced before each write, and reported a conversation's bytes with a new kind of fact that names no run. The owner chose the simple version instead (2026-10-16), in the spirit of 14b's "stop when spent" and 14c's Laravel-only stop:

- **The engine reports.** Every `run.finished` carries the bytes the conversation's folder keeps once the run has ended (`storedBytes`, one optional field).
- **Laravel keeps and sums.** Each conversation keeps the latest number its facts reported. An organization's storage is the sum over its conversations that are not deleted. A deleted conversation stops counting when it is deleted.
- **Laravel refuses.** Once an organization's storage has reached its limit, Laravel refuses new uploads (at presign) and new turns, with a message the chat shows.
- **The other limits stay.** The folder's 256 MB and 10,000 entries per conversation, a run's uploads of four times that, 50 MB per file, 10 files per message and 30 uploads waiting per user.

No upload is reserved, the engine counts nothing new and enforces nothing new, and no fact without a run is added. The plan's version is in Appendix B of remaining-chunks.md, and in a few lines at the end of this document.

**What this does not promise.** The limit is an allowance for the files an organization's live conversations keep, not a bound on what R2 holds, and it is not hard. An organization can pass it by what is stored while the check reads it as under the limit:

- **Each run in flight.** What a run adds is reported only when it ends. A run can keep up to one folder of the agent's files (256 MB) and the attachments it took, which are themselves at most a folder: up to two folders (512 MB) of new contents, of which the attachments came from uploads (The number, below). The folder's cap bounds one version, not a conversation's history, which has no cap.
- **The uploads in flight.** A staged upload is not counted until a run takes it into its folder. The 30 waiting uploads per member bound reservations, not objects: a removed reservation's presigned PUT stays valid for 15 minutes and can still write its object, and R2 deletes staged objects only a day after they were written. So staged bytes are bounded by the presign throttle (120 a minute per user), the URLs' 15 minutes and the lifecycle's day, not by 1.5 GB per member (Risks, owner question 6). A PUT presigned before the limit was reached can still be sent after.
- **Concurrent checks.** Starts and presigns read the sum without a lock, so all that pass the check together are admitted.
- **Deleted conversations.** A deleted conversation stops counting at once, and its blobs stay in R2 until chunk 15a deletes them after the restore window (and only once its facts are acknowledged). An organization can fill its allowance, delete, and fill it again.

So the overshoot of live files is about two folders for each run in flight, plus the uploads in flight. This document says so wherever it matters, and the plan's boxes are reworded to match (Changes to remaining-chunks.md).

## What the code does today

| Claim | What the code does |
|---|---|
| Blobs are per conversation, one per contents | `folder_blobs` holds each R2 object of the conversation with its size and a state: `loose` (recorded before it is written, not yet claimed), `stored` (one per contents, unique on `sha256` while stored) or `doomed` (to be deleted twice, a day apart) (`cloudflare/src/files/schema.ts:39`, `:51`). The same contents in two conversations are two objects. |
| Every turn's version is kept | A checkpoint replaces only the run's earlier checkpoint (`files/store.ts:884`, `:888`, the only call of `#deleteVersion`). A turn's version and a base version with attachments are never deleted, and Laravel can list and download any of them (`#readable`, `store.ts:956`, `:962`). So a stored blob stays stored while any version names it, until the conversation's objects are deleted. |
| What leaves `stored` | Only `publish`, in `finish`'s transaction: what the run stored that neither its base nor its result names is doomed (`store.ts:925`, `:944`). A blob already stored makes a later copy of the same contents doomed at its claim (`#claim`, `:449`). Nothing outside a run changes which blobs are stored. |
| The folder's own total | `total()` sums raw sizes over `stored`, `loose` and `doomed` rows not yet deleted once (`store.ts:498`, `:501`): a bound on what R2 holds, never below it. It is reported to a `ByteCounter` with a revision (`#reportNow`, `:528`), and for Laravel's conversations the counter is `UNCOUNTED`, which accepts everything (`files/folder.ts:15`). |
| Page rounding | `folderBytes` and `pages` round each file up to whole 4 KiB pages, an empty file to none (`files/limits.ts:46`, `:52`), as tmpfs charges it. The folder's 256 MB cap is counted this way, on a start's base version (`store.ts:611`) and on each checkpoint (`:775`). `total()` is not. |
| A run's other limits | Attachments that would pass the folder refuse the start with `FOLDER_FULL` (`store.ts:612`); a run's checkpoint uploads stop at four times the folder (`run_uploads`, `:778`). |
| `run.finished` | Written in `finish`'s transaction, after `publish` (`conversation/store.ts:623`, `:638`, `:649`). Its data is `status`, `error`, `code`, `message` and `folder` (`{base, result, changes, warnings}`, or null when the run had no folder), with no size (`contract/src/internal/facts.ts:203`; `#finishedFact`, `conversation/store.ts:1086`). Facts are Laravel's conversations' only (`#writesFacts`, `:1046`). |
| Laravel applies facts in order | `Facts::deliver` locks the conversation (`app/Runs/Facts.php:44`) and applies each fact once, in sequence, refusing a gap (`:164`, `:171`). A repeat is compared with the stored text and changes nothing. `run.finished` updates the run in a live or a deleted conversation (`:193`, `:334`). |
| Laravel ignores unknown fields | `ContractRequest` checks a request against `laravel-v1.json` and ignores a field it does not know (`app/Http/Middleware/ContractRequest.php:17`). |
| Conversations | Each row has `organization_id` (`database/migrations/2026_10_14_140000_create_runs_tables.php:79`) and `deleted_at`, set by a user's deletion (`app/Conversations/Deletions.php:81`; the migration `2026_10_17_100000_delete_conversations.php`). The only index is `(workspace_id, updated_at)` (`create_runs_tables.php:89`). Only the conversation's own user can delete it (`Deletions.php:49`). An organization's deletion cascades its conversations away (`create_runs_tables.php:79`). |
| Presign | `Uploads::reserve` refuses an empty file and one over 50 MB, then locks the user and the workspace, checks the membership, and refuses a 31st waiting upload under an advisory lock on the user (`app/Files/Uploads.php:45`, `:53`, `:67`, `:70`). The composer shows a `ValidationException`'s message. The PUT's URL is valid for 15 minutes (`app/Files/Bucket.php:17`), and removing a reservation deletes its row and object but cannot revoke the URL (`Uploads.php:98`, `:111`). Presigns are throttled to 120 a minute per user (`app/Providers/AppServiceProvider.php:142`). R2's lifecycle rule deletes an `uploads/` object a day after it was written. |
| A start | `Runs::start` reads the organization's spend without a lock and refuses at or over its budget with "Your organization has used its budget." (`app/Runs/Runs.php:95`, `:97`), before it reads the conversation. |
| The budget's limit | `organizations.budget_micros`, else `minerva.budget.limit_micros` (`app/Models/Organization.php:70`, `config/minerva.php:29`); `minerva:budget` shows and sets it (`app/Console/Commands/SetBudget.php`). |

## Decisions

### The number

`storedBytes` is **the sum, over the conversation's `stored` blobs, of each blob's size rounded up to whole 4 KiB pages** (`pages`, `files/limits.ts:52`), read in `finish`'s transaction right after `publish` doomed what the run left unnamed.

- **What it counts.** Every blob in the state `stored`, once. That is each distinct contents the conversation keeps: every file of every retained version (every turn's result, every base version with attachments), deduplicated within the conversation, rounded as the folder's 256 MB cap is. It also counts what a failed clean-up left: when `publish` cannot read a manifest, it logs "a run's folder could not be compared or cleaned up" and dooms nothing (`store.ts:934`, `:946`), and no later run dooms another run's blobs (`:941`). Those blobs stay stored, and counted, until the conversation is deleted. The number states what is stored, not what a version names.
- **What it leaves out.** `loose` and `doomed` rows. These are copies in flight and objects waiting for the sweep's deletion: the run's unnamed checkpoint uploads (up to four folders, 1 GB) and copies a crash left. The sweep deletes them within an hour of their due time, and finally a day later. Counting them, as `total()` does, would leave a conversation reported up to 1 GB high until its next run, since nothing reports after the sweep.
- **Why pages, not raw bytes.** It is the unit of the folder's cap, which users already meet ("The agent's files grew past the 256 MiB a conversation can keep"), so one full folder reports at most its cap. R2 bills raw bytes. A page-rounded number is never below them and is at most 4 KiB a file above.
- **Why it holds between runs.** Only a run changes which blobs are stored (What the code does today). So the number read at a run's end holds until the conversation's next run starts.

It is one query in `FolderStore`, not a counter: nothing is kept, and nothing changes the `ByteCounter`, `total()` or `UNCOUNTED`.

```sql
SELECT coalesce(sum((size + 4095) / 4096 * 4096), 0) FROM folder_blobs WHERE state = 'stored'
```

`publish` returns it beside `resultVersionId` and `changes` (`FolderPort.publish`, `conversation/ports.ts:83`). It runs in its own `try`, as `publish`'s comparison does (`store.ts:934`): a run must end whatever its folder holds, so a sum that throws is logged, and the field is left out. `emptyFolder`, the tests' folder without files, leaves it out too.

### When it is stale

Laravel's number for a conversation is the one on the last `run.finished` it applied. It is stale:

1. **During a run**, from the start's attachments to the run's `run.finished`: the attachments and the checkpoints are not counted yet. This is the overshoot for each run in flight (above).
2. **While facts wait**: Laravel cannot be reached, or the conversation's delivery is stopped on a conflict (`facts_stopped_at`). The number catches up when the fact is applied.
3. **When a `run.finished` has no `storedBytes`**: the sum threw, or an engine rolled back below unit 1 sent it. Laravel keeps the previous number, which can then be lower than what the conversation keeps: during a rollback, runs grow their folders and nothing reports it. Nothing corrects it before the conversation's next run with the field.
4. **Before a conversation's first `run.finished` with the field**: the conversation counts 0. Conversations from before the deploy count 0 until their next run ends (owner question 4). Facts Laravel applied before it read the field are not applied again, so deploying the app after the engine would not catch up either.

It is never stale after a deletion: Laravel stops counting the conversation at once. A number that is too high cannot be corrected by a turn once the organization is at its limit, since the turn that would report it is refused. Nothing today makes a number too high (owner question 5 says what would).

### The contract (additive)

`run.finished` gains `storedBytes: Count.optional()`, at the top level of its data, not in `folder`, which is null for a run with no folder (the conversation may still keep files from earlier runs). Its doc comment states the rule above. `pnpm --dir contract openapi` regenerates `laravel-v1.json`, contract.md's fact table and `contract/scenarios/facts.json` gain it, and no other fact changes.

Laravel receives it, so the app deploys first (AGENTS.md). Since `ContractRequest` ignores unknown fields, the reverse order would not break delivery, but the facts applied in between would never count (When it is stale, 4).

### Laravel

- **The columns.** One migration:
  - `conversations.stored_bytes`, `bigint` not null, default 0;
  - `organizations.storage_limit_bytes`, `bigint` nullable: the organization's own limit, null for the default;
  - a partial index for the sum: `CREATE INDEX conversations_storage ON conversations (organization_id) INCLUDE (stored_bytes) WHERE deleted_at IS NULL`, which lets Postgres answer it from the index (an index-only scan when the visibility map allows; the perf rule checks the time, not the plan).
- **The default limit.** `minerva.storage.limit_bytes` (`MINERVA_STORAGE_LIMIT_BYTES`), 5 GiB, a total, not per month (owner questions 1 and 2).
- **Applying the fact.** `Facts::finished` sets `conversations.stored_bytes` from `storedBytes` when the field is present, in a live or a deleted conversation, before its early returns. The conversation is already locked by the delivery (`Facts.php:44`), and facts are applied in sequence, so the latest run's number always wins: no revision and no sum of changes.
- **The sum.** `Organization::storage(string $id): int` is `SUM(stored_bytes)` over the organization's conversations whose `deleted_at` is null, as `Organization::spend` sums settlements. `Organization::storageLimit()` mirrors `budgetLimit()`.
- **A start.** In `Runs::start`'s transaction, after the conversation is locked and found idle (after `Runs.php:111`), read without a lock: if the storage is at least the limit, throw `ValidationException` on `content` with "Your organization has used all of its storage for files. Delete conversations you no longer need to make room." (owner question 3). Nothing is registered. Read after the conversation's lock, the sum includes the conversation's own last `run.finished`: a delivery that held the lock has committed by then. Read before it, as the budget is, a start could wait for that delivery and go on with the older sum.
- **A presign.** In `Uploads::reserve`, after the membership is read and before the waiting uploads are counted: the same check and message, on `file`. The composer shows it as it shows "Send or remove some attached files first.".
- **No lock.** Like 14b's spend, the sum is read, not locked. A lock that only starts and presigns took would order them, but bound nothing more, since the sum changes only when a fact is applied or a conversation is deleted. turn.md's lock order does not change.
- **The command.** `minerva:storage {organization} {--limit=} {--default}` shows the limit (and whether it is the default), the storage, what is left, and the organization's five largest conversations that are not deleted, with their `stored_bytes` and their user. `--limit` sets the organization's own limit in bytes first, and `--default` clears it. It mirrors `minerva:budget`, and it drives the live check on staging. It is also the operator's only remedy for storage no member can free (Risks).
- **Sizes for people.** Laravel's `Number::fileSize` formats the command's sizes. The refusal names no number.

## What 15 and 16 inherit

- **15a (retention in the engine).** A deleted conversation's blobs stay in R2, uncounted, until 15a deletes them physically after the restore window. 15a's physical deletion waits for every fact to be acknowledged, so a stopped delivery keeps them longer. If 15a, or a later chunk, ever prunes a live conversation's old versions, that happens outside a run, and the number stays high until the conversation's next run, which a full organization cannot start. So pruning needs a report that does not wait for a turn (the rejected alternative's fact without a run, or a command Laravel calls), built with it. 15a's plan does not prune a live conversation's versions, so their manifests in the Conversation object's SQLite (up to about 11 MB a version at the limits, files of zero bytes included) grow with every turn and are counted nowhere. Container snapshots (sandbox-snapshots.md), if they are ever kept per conversation, are not in the number, and whoever adds them must count them or say so.
- **15b (retention in Laravel).** An organization's deletion removes its conversations, and their numbers with them. Deleting a deleted conversation's rows after the window changes no sum, since it already counts nothing.
- **15c (a restore).** A restore brings `stored_bytes` back to its value at the restore point. Replaying the facts after that point applies each `run.finished` again in order, which restores the latest reported number. A conversation created after the point counts once 15c's import has applied its facts.
- **16 (billing).** If storage is billed, the number is what it is billed from. A GB-month needs the number sampled over time, which 16 adds if it wants it.

## Units

Each unit is for one fresh agent, in this order. A unit is done when its checks pass and it is committed to the main of its repository. Engine checks: `pnpm typecheck`, `pnpm test:unit` and `pnpm test:platform` in `cloudflare/`, and `pnpm typecheck` and `pnpm openapi:check` in `contract/`. App checks: `composer test`, `pnpm run check`, `pnpm run types:check` and `pnpm test`. Neither diff is large; opencode reviews both, since unit 2 refuses starts.

1. **The number (harness: contract and engine).**
   - The contract's field, the OpenAPI documents, `contract/scenarios/facts.json` (a `run.finished` with `storedBytes`) and contract.md's fact table.
   - `FolderStore.storedBytes()`, `publish`'s new return field, `FolderPort.publish`'s type, and `#finishedFact` writing it.
   - Docs: ARCHITECTURE.md (Files: what the number counts; Facts: the field), credentials-and-facts.md's fact table.
   - Unit tests over node:sqlite (`store.test.ts`): after `publish`, `storedBytes` counts each distinct contents once across two turns; leaves out the run's unnamed checkpoint uploads and loose rows; rounds to pages, an empty file to 0; is unchanged after a turn that deletes a file, since the earlier version keeps it; counts the attachments of a run that was cancelled or failed before its first checkpoint; and still counts a run's unnamed blobs when `publish` could not read a manifest. A sum that throws leaves the field out, and the run still ends.
   - A platform test (`facts.test.ts`): a run that writes two files ends with a `run.finished` whose `storedBytes` is their page-rounded sum, and a second run that writes nothing reports the same number.
   - The perf benchmark (Perf probe and rule).
2. **Storage (app).**
   - `composer contract:sync` from unit 1's commit.
   - The migration, the config, `Organization::storage` and `storageLimit`, `Facts::finished`, the checks in `Runs::start` and `Uploads::reserve`, and `minerva:storage`.
   - Docs: turn.md (Tables; a Storage section after Budgets; the command under The operator's commands), and conversations.md's Uploads.
   - Pest tests:
     - A start at or over the limit is refused with its message and registers nothing; under it, it starts.
     - A presign at or over the limit is refused with its message and reserves nothing.
     - A `run.finished` with `storedBytes` sets the conversation's number, and `storedBytes: 0` replaces a positive one; one without it keeps the previous number; one in a deleted conversation sets it but counts nothing; a batch with two runs' `run.finished` leaves the second's number; a repeated delivery changes nothing.
     - A deleted conversation stops counting at once, and a start that was refused before its deletion is then admitted.
     - Conversations in two workspaces of the organization both count; another organization's do not.
     - An organization's own limit wins over the default.
     - `minerva:storage`'s output, `--limit` and `--default`.
3. **The live checks and the boxes (harness).** After the deploys below, the live checks, then remaining-chunks.md's 14d boxes with their evidence.

**Deploy order.** The app first: unit 2 pushed to the app's main reaches staging through CI, and its migration starts every conversation at 0. Then the engine: unit 1 deployed to `minerva-cf-staging`, which the owner approves (AGENTS.md). Production gets the app, then the engine, with the owner's approval. If 14c's unit 1 lands in `Runs::start` first, unit 2 adds its check after the budget's, and the two do not otherwise touch.

## Live checks

| Check | Where | Who |
|---|---|---|
| The engine's regression: `pnpm run deploy:test`, `pnpm test:faults` | `minerva-cf-test` | The agent |
| Deploy the engine to `minerva-cf-staging` | The account | The agent, after asking the owner |
| The exact number: a `minerva:turn` in a new conversation asks the agent to write a file of exactly 10,485,760 bytes (`head -c 10485760 /dev/urandom > big.bin`) and nothing else. Its `stored_bytes` is 10,485,760, and `minerva:storage` shows the organization's storage grown by that much | The app's staging | The agent, once the owner says go (cents of model and container time) |
| A turn over the limit: `minerva:storage --limit=` set to the organization's storage, so it has reached its limit. The next `minerva:turn` is refused with the storage message | The app's staging | The agent |
| An upload over the limit: with the limit still reached, attaching a file in the chat is refused with the same message | The app's staging | The owner, since the agent has no browser session on staging |
| Deleting files: a turn in the same conversation that deletes `big.bin` (with the limit raised first) leaves `stored_bytes` unchanged, since the earlier version keeps it. The check records this as designed | The app's staging | The agent |
| Deleting a conversation: the owner deletes it in the chat. `minerva:storage` shows the storage lowered by its number at once, and with the limit set between the old and the new storage, a `minerva:turn` is admitted. The limit is then put back with `--default` | The app's staging | The owner deletes; the agent checks |

The brief's "deleting files lowers the total" does not hold for files deleted by a turn, since every turn's version stays downloadable. Only deleting a conversation frees its storage (owner question 5).

## Perf probe and rule

**The checkpoint does not change.** The plan's metric, checkpoint time for 500 files within 5% of `main`'s, measures nothing this chunk changes, so it is not run.

**What is measured instead.**

- **The engine.** The one query added to `finish`'s transaction. A benchmark in Node (node:sqlite, the store's own code, as 14b's accepted measure was), timing `publish` over a folder of 20,000 stored blobs (two full folders of distinct contents), base (unit 1's parent) and head, one interleaved pair, 1,000 runs each after a warm-up. **Rule:** the head's p95 is within 5 ms of the base's. 100,000 blobs is measured too, and only recorded. If the rule fails, the smallest fix is a partial index on `folder_blobs (size) WHERE state = 'stored'`, an additive schema step, measured again.
- **Laravel.** The sum each start and presign adds. 500 calls each of `Runs::start` (with `Bus::fake()`, as 14c's probe) and `Uploads::reserve` (with the bucket faked), for an organization with 10,000 conversations, on the base and the head, one interleaved pair, locally against the Postgres of `docker compose`. **Rule:** the head's median is within 5 ms of the base's. With the partial index, under 1 ms is expected.

## Risks

- **The limit is not hard** (What this does not promise). The overshoot of live files is up to two folders for each run in flight, plus the uploads in flight, plus whatever passes concurrent checks. It is an allowance for live conversations' files, not a bound on what R2 holds.
- **Deleting files frees nothing.** A turn's deleted file stays in the earlier version, and only deleting the conversation frees it. An organization at its limit must delete conversations, or the operator raises its limit.
- **Conversations no one can delete.** Only a conversation's own user can delete it (`Deletions.php:49`). A user refused for storage may have nothing of their own to delete, and a member who left keeps counting against the organization until the organization is deleted (15b). The operator's remedy is `minerva:storage --limit`, and the command lists the largest conversations and their users to show where the storage is. A way for an organization's owner to delete others' conversations is product work outside this chunk.
- **Storage the number leaves out.** Staged uploads: a removed reservation's PUT stays valid for 15 minutes, so a member can keep writing staged objects past the 30 waiting reservations, at up to 120 presigns a minute, each kept a day by R2's rule (owner question 6). A run's transient copies, up to 1 GB, until the sweep. A deleted conversation's blobs, until 15a, and longer while its facts are unacknowledged; an organization can fill its allowance, delete and fill it again. The Conversation object's own SQLite: version manifests (up to about 11 MB a version at the limits, zero-byte files included), which no plan prunes in a live conversation, and facts, run events and pi's tables, which 15a prunes.
- **Conversations from before the deploy count 0** until their next run ends. Production has no users. Staging's are test data.
- **A rollback of the engine** below unit 1 leaves every conversation's number at its last value, while its runs go on growing its folder: the numbers are low until each conversation's next run after the engine is deployed again.
- **A failed clean-up is counted for good.** A run whose `publish` could not read a manifest leaves its unnamed blobs stored and counted until the conversation is deleted (The number). It is logged, and it needs a manifest that cannot be read.
- **The sum reads every live conversation's row** of the organization at each start and presign, from the partial index. If that ever costs too much, a total kept per organization is the next step.

## Owner questions

Each question has a recommended default, which the agent builds unless the owner answers otherwise.

1. **The default limit.** Default: 5 GiB per organization, set by `MINERVA_STORAGE_LIMIT_BYTES` and per organization by `minerva:storage --limit`. At R2's list price it costs about $0.08 a month to store. The alternatives are 1 GiB or 10 GiB.
2. **A total or per month.** Default: a total. Storage is a level, not a flow, and a monthly limit would reset nothing that was stored.
3. **The message.** Default: "Your organization has used all of its storage for files. Delete conversations you no longer need to make room.", for both a start and an upload. The refusal names no number.
4. **Conversations from before the deploy.** Default: they count 0 until their next run ends. The alternative is an engine command that reports every conversation's number, which this design does not need.
5. **Deleting files.** Default: accepted that only deleting a conversation frees storage, since every turn's version stays downloadable. Pruning old versions is not 14d's; it would be a retention rule for live conversations after the plan, and it would need a report that does not wait for a turn (What 15 and 16 inherit).
6. **Staged uploads past the waiting limit.** Default: not changed in 14d, and listed among the gate's steps before open sign-up, beside the rate limits on starts. The fix there is small: keep a removed reservation's row, counted as waiting, until its PUT's URL has expired (15 minutes), so the 30 waiting uploads bound staged objects too. The alternative is to build it in unit 2, which touches every query that reads uploads.

## The alternative the owner rejected: reservations and a byte allowance

The plan's version: Laravel reserves each upload's bytes against the organization at presign, under an organization lock, and moves them into a byte allowance on `StartRun` at the start. The engine replaces `UNCOUNTED` with a counter that refuses a write past the run's allowance before it lands. The folder reports its absolute bytes with a revision after each sweep, by a new kind of fact that names no run, and Laravel settles the organization from the highest revision.

- **What it adds.** A nearly hard limit: no run writes past its allowance, and uploads are counted at presign. The total also falls after a sweep, not only at a run's end.
- **What it costs.** A new fact envelope, deployed to Laravel first. A lock in turn.md's order. A reservation table with releases for uploads that expire. `StartRun`'s byte allowance. The counter's checks on the checkpoint path, which the plan's perf rule existed to watch.

It remains possible later, starting from the `ByteCounter` port, which stays in place.

## Changes to remaining-chunks.md

This commit rewrites chunk 14d's boxes to the owner's version:

- The intro states the choice and points here.
- The Build boxes become the field on `run.finished` with the rule of what it counts, Laravel's column and sum, and the two refusals.
- The boxes for the byte allowance, the reservation, the counter that enforces it and the fact without a run are removed.
- You see, the unit, live and perf boxes become this document's tests, live checks and perf rules.

Appendix B records the plan's version as rejected, and the gate's box before open sign-up gains owner question 6's fix for staged uploads.

## Amendments after opencode's review

opencode (`plan` agent) reviewed the first draft on 2026-10-17, reading both repositories. Each finding was checked in the code.

1. **The 1.5 GB per member did not bound staged objects (accepted).** `Uploads::remove` deletes the row and the object (`app/Files/Uploads.php:98`, `:111`), but the PUT presigned for it stays valid for 15 minutes (`app/Files/Bucket.php:17`), and a PUT after the deletion writes the object again, which R2's rule keeps a day. The presign throttle is 120 a minute per user (`AppServiceProvider.php:142`). The bound is now stated as the throttle, the URL's life and the lifecycle's day, with the small fix as owner question 6, not built here, since the owner kept the upload limits as they are.
2. **Deleting conversations repeatedly escapes any bound on R2 (accepted as wording).** That is the owner's rule (a deleted conversation stops counting at once). The design now calls the limit an allowance for live conversations' files, not a bound on what R2 holds, and says that 15a's physical deletion also waits for every fact to be acknowledged (remaining-chunks.md, chunk 15a).
3. **A run can add two folders, not one (accepted).** Attachments up to the cap stay in the base version and a result of the same size with other contents stays too, both downloadable (`store.ts:611`, `:925`). The overshoot now says two folders per run in flight, of which the attachments came from uploads, and that the folder's cap bounds a version, not a conversation's history.
4. **A failed clean-up leaves blobs stored for good (accepted).** When `publish` cannot read a manifest, it logs and dooms nothing (`store.ts:934`, `:946`), and later runs doom only their own blobs (`:941`). The number is now defined as every blob in the state `stored`, which counts that garbage, and a unit test and a risk say so. No repair is added: it needs a manifest that cannot be read.
5. **A number that is too high cannot be corrected by a turn at the limit (accepted).** Nothing in 14d makes a number too high, so this chunk keeps its rule, and What 15 and 16 inherit now says that pruning a live conversation's versions needs a report that does not wait for a turn. The draft's "never lower" for a rollback was wrong: runs go on growing folders while the number stays, so the number is low. Both are corrected, and a restore now restores "the latest reported number", not the exact one.
6. **A start read the sum before waiting for the conversation's delivery (accepted).** `Runs::start` reads the budget before it locks the conversation (`Runs.php:95`, `:154`), and a delivery holds that lock while it applies `run.finished` (`Facts.php:44`). The storage check now runs after the conversation is locked and found idle, so it sees the conversation's own last number. No lock is added. A PUT presigned before the limit can still be sent after it, which What this does not promise now says.
7. **Manifests in SQLite are not bounded by 15a (accepted).** 15a's plan prunes facts, run events, inputs and pi's tables, not a live conversation's versions (remaining-chunks.md, chunk 15a), and zero-byte files and directories add to a manifest without adding to the number (`schema.ts:17`). Risks and What 15 and 16 inherit now say that nothing bounds them.
8. **A refused user may have nothing to delete (accepted in part).** Only a conversation's own user can delete it (`Deletions.php:49`). The message now says "conversations you no longer need", `minerva:storage` lists each large conversation's user and gains `--default`, and Risks names the operator's limit as the remedy. A way for an organization's owner to delete others' conversations is left out as product work.
9. **Missing tests (accepted in part).** Added: `storedBytes: 0` replacing a positive number, two `run.finished` in one batch, a repeated delivery, a cancelled run's attachments, a failed clean-up still counted, and two workspaces of one organization. Set aside: a race test of the start against a delivery, since the check is now under the conversation's lock and a race test of a soft limit would only assert the overshoot this design allows; a replay test, which is 15c's; an old reader with the new field, which `ContractRequest` already ignores (`ContractRequest.php:17`) and the test of a fact without the field covers from the other side.
10. **Simplify (accepted in part).** Accepted: `storage_limit_bytes` for the limit's column, `--default` on the command, the index described as what lets Postgres answer from it rather than a promise of its plan, and one interleaved pair per benchmark instead of two. Set aside: raw bytes instead of pages. The owner's brief asks for the number as `files/limits.ts` counts it, which keeps one full folder at most its cap in the same unit users meet, at a cost of at most 4 KiB a file over R2's raw bytes.

opencode found the contract change additive and the absolute, ordered number free of double counting, and agreed that no reservation or new fact is needed for the owner's rule.
