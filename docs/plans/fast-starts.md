# Fast starts design: answering before the copy, and a schedule that sleeps

Status: proposed, 2026-10-24, and reviewed the same day by four reviewers (protocol, contract, ops and ux) and by opencode. The findings that held are folded in (Amendments after the review). Every owner question is answered (Owner questions). Not built, and nothing deployed. Line numbers are at `4559201` (harness) and at `c817ec0` of `minervacomputing/app` ("the app's" below), and the app's `vendor/` is Laravel 13.36.0. A claim about code with no label was read at the lines cited; one marked (inferred) follows from code that was read, and one marked (guess) rests on platform behaviour no document states. Once built, what stays true moves into ARCHITECTURE.md, cloudflare/README.md and the app's `docs/architecture/`, and this file is deleted.

## Why

Measured on 2026-10-24 unless dated otherwise.

- **Staging never sleeps.** Over the week before, staging's app was up about 97% of each day, and its database used about 5.9 of a possible 6 compute-unit hours a day.
- **The schedule keeps it awake.** Laravel Cloud wakes a sleeping environment for every task that `schedule:list` lists, and keeps it up for the sleep timeout (Cloud's scheduled-tasks docs, read 2026-10-24). Staging lists two tasks every 5 minutes, the sweep and `billing:sync --due` (the app's `routes/console.php:7`, `:18`). `schedule:list` lists the second although its `when()` is false on staging.
- **The scheduler keeps the database awake.** While the app is up, `schedule:run` reads the scheduler's pause flag from the cache store every minute, and the cache store is Postgres (the app's `vendor/laravel/framework/src/Illuminate/Console/Scheduling/ScheduleRunCommand.php:116`, `:293-300`; the app's `config/cache.php:18`).
- **Production slept all week**, because its scheduler is off. So production has no sweep, no retention purge and no billing sync.
- **Starts are fast once sent.** Of the 95 starts staging answered, the time from registration to answer had a median of 2 s and a p90 of 3 s. The slow ones, 77 to 210 s on 2026-10-16, were all time in the queue before the first try. Since 2026-10-17, 72 starts were answered, the slowest in 17 s.

So what a user waits for is the managed queue, not the engine. Today's bound on that wait is five minutes (the app's `app/Runs/Runs.php:57`). And the engine copies every attachment before it answers, so a start with large files would outlast a 10-second bound even on a warm queue (inferred, since up to 10 files of 50 MB are read twice and written once before the answer).

## The owner's requirements and what they change

The owner's requirements, 2026-10-24:

1. A message whose start cannot reach the engine within about 10 seconds fails visibly, and the user can send it again. No user waits longer than that just for the message to reach the engine. The owner accepts a contract change so that the engine answers before the slow work, the copy of the attachments.
2. Each queued job gets the policy its purpose needs. Starts fail fast. Cancels, deletions, narrowed-connection cancels and billing fixes are obligations that keep retrying.
3. The 5-minute sweep becomes a rare backstop for what only a sweep can catch. Per-item timers do the rest, and housekeeping runs on its own slower schedule.
4. Staging, and later production, sleeps when nobody uses it. No scheduled task runs more often than the sleep timeout, nothing reads Postgres every minute, and the sleep timeout is short.
5. No code changes now. This is a design to review.

What this design changes:

- **The engine answers before the copy.** `startRun` is answered `accepted` once the run is stored. Before that, the engine reads only each attachment's size and first 8 KiB, and checks the folder's limits from the names and the declared sizes. The full read, hash and copy become the run's first step. A copy that fails ends the run `failed` with one of two new codes. A run that ends before its copy commits never holds its files, and Laravel fails its message. No schema changes. What `accepted` promises changes, and the contract documents it (The contract).
- **Laravel makes the first try itself, in the request,** for 8 seconds, behind a 10-second bound, with a delayed job as the fallback. A start not answered in that window is cancelled, and the page shows "Not sent" with Send again about 11 seconds after Send at worst.
- **Each job has the policy its purpose needs** (Each job's policy).
- **The sweep becomes a backstop that runs every 3 hours.** Upload housekeeping runs daily, and at a member's reservation that their removed uploads would refuse. Every task runs at minute 0, every 3 hours or daily, and `schedule:run` stops reading the cache when nothing is due.
- **Staging sleeps** between wakes 3 hours apart once its sleep timeout is 5 minutes, awake about 3% of the day instead of 97% (inferred; owner questions 3 and 5). Production sleeps the same way once its scheduler is on (owner question 4).

**What this does not promise.** The 10 seconds cover a message's way to the engine, not the agent's first words, and they start at the POST, after the browser's uploads. A run with large files then shows "Copying the attached files" for the copy's seconds. A file that vanishes, or a workspace found full, after the acceptance fails the message after the page has shown the run starting, not as a refusal (owner question 9). So does a Stop during the copy.

## What the code does today

| Claim | What the code does |
|---|---|
| The engine answers only after the copy | `#startOnce` stores the preparation (`cloudflare/src/conversation/conversation.ts:464-476`), reads every staged object in full (`:480`; `cloudflare/src/files/staging.ts:49-74`, `:80-99`), then plans the folder, records loose keys, reports to the workspace counter and copies each object (`conversation.ts:482`; `cloudflare/src/files/store.ts:591-677`, `#copy` at `:685-698`). Only then does one write store the run, activate it and store the acceptance (`conversation.ts:487-521`). The loop and the staged objects' deletion are deferred (`:522-525`). |
| The folder's limits wait for every byte | `FOLDER_FULL` by entries and `INVALID_ATTACHMENTS` come from `parseManifest` (`files/store.ts:609-617`; `cloudflare/src/files/manifest.ts:155-171`), and `FOLDER_FULL` by bytes from sizes keyed by hash (`files/store.ts:618-623`). All of them run after `measureStaged`. Up to 10 files of 50 MB are read before a full folder is refused (inferred). |
| The plan needs only names, sizes and heads | Paths are numbered from cleaned names against the folder's root names (`files/store.ts:597-608`). The type is sniffed from the first `SNIFF_BYTES`, 8 KiB (`staging.ts:56-66`, `:96`; `cloudflare/src/files/limits.ts:32`). The byte limit sums each entry's size in whole pages (`limits.ts:46-50`). |
| The acceptance promises a copied folder | "The message's attachments as the folder holds them" (`contract/src/internal/engine.ts:119-120`). The app stores them on the message (the app's `app/Runs/Runs.php:388-389`). |
| A repeat joins the start in flight | Tries in one live instance share one `#startOnce`, and a stored answer is replayed (`conversation.ts:304-314`). The digest is over the parsed command (`cloudflare/src/internal/start.ts:148-151`). |
| The engine restarts a stored run's loop | The watch, every 20 s (`conversation.ts:148`), and `onStart` start the loop again for an acting run pi has no submission for (`:768-772`, `:808-826`). Deferred work runs under `ctx.waitUntil`, its failures logged (`:1614-1620`). |
| The section's 30 s bound counts from queueing | `PI_SETTLE_MS` counts from when the section is queued and covers its time in the lane (`cloudflare/src/conversation/pi-stops.ts:15-16`, `:96-113`). |
| Only a run's end moves the folder | `folder_version_id` is written only by `touch` (`cloudflare/src/conversation/store.ts:517-521`), called from `finish`, which publishes the run's checkpoint, else its base version (`:710`, `:719`; `files/store.ts:936-955`). |
| A cancel is ordered against a start | `cancelInternal` ends a stored active run, or tombstones an unknown one and deletes its preparation, in one write (`conversation.ts:316-334`). `start_expired` ends a run `failed` with "The agent could not finish this run. Try again." (`cloudflare/src/conversation/events.ts:97`, `:114-120`). |
| Laravel's first try waits for the queue | `Runs::start` commits, then dispatches `SendStart` (the app's `app/Runs/Runs.php:87-145`). The job checks the 300 s bound before its first send (the app's `app/Jobs/SendStart.php:58-62`). |
| One try can take about 40 s | The client allows 5 s to connect, 30 s for the exchange and 10 s per read (the app's `app/Engine/EngineClient.php:45-51`). `startRun` passes no `within` (`:120-123`), though `send` takes one (`:224-237`). A streamed request goes to Guzzle's stream handler (the app's `vendor/guzzlehttp/guzzle/src/Handler/Proxy.php:63`), which never reads `connect_timeout` (`Handler/StreamHandler.php` has no use of it), so the total timeout bounds the call. That holds where `allow_url_fopen` is on (inferred for Cloud). |
| A cancel acknowledged `cancelled` leaves the run unanswered | Past the bound, `SendStart` calls `expire` even when the cancel was acknowledged (the app's `app/Jobs/SendStart.php:47-62`), and `expire` does nothing once a cancel is requested (the app's `app/Runs/Runs.php:410-414`, `:496-504`). Only a later dispatch recovers the acceptance (the app's `app/Console/Commands/SweepRuns.php:64-70`). Until then a conversation whose run took files refuses later messages (`Runs.php:125-130`) (inferred). |
| The user waits on "Waiting to start" | A starting run is `queued` (the app's `app/Conversations/Transcript.php:122-130`), shown as "Waiting to start" (the app's `resources/js/components/chat/model.ts:107-110`) and reloaded every 2 s with no end (the app's `resources/js/hooks/use-run-stream.ts:24`, `:155-165`). A tombstoned start reads "Not sent." (the app's `app/Runs/Runs.php:519-522`). A registered start never gives its text or files back (the app's `resources/js/components/chat/runtime.ts:18-43`). |
| The jobs retry for a day with no backoff of their own | `SendStart`, `SendCancel` and `SendDeletion` have `$tries = 0` and `retryUntil` a day (the app's `app/Jobs/SendStart.php:31-39`, `app/Jobs/SendCancel.php:28-35`, `app/Jobs/SendDeletion.php:25-32`), as do `SyncBilling` and `SyncSeatChange`. They release with 5, 10, 20, 30 s (the app's `app/Jobs/Backoff.php:5-13`). None declares `$backoff`, so an exception it does not catch is retried at once under the worker's `--backoff=0` (the app's `vendor/laravel/framework/src/Illuminate/Queue/Worker.php:876-885`) (inferred, since the worker's flags are Cloud's). |
| A non-retryable error ends the job | `SendCancel` and `SendDeletion` log it and end unacknowledged (the app's `app/Jobs/SendCancel.php:58-65`, `app/Jobs/SendDeletion.php:58-65`), and `SendStart` logs and ends (the app's `app/Jobs/SendStart.php:73-76`). The sweep is then their only retry. |
| `CancelNarrowed` tries once | It declares no tries and no `retryUntil` (the app's `app/Jobs/CancelNarrowed.php:21-51`), so the sweep is its retry (the app's `app/Console/Commands/SweepRuns.php:89-91`). |
| Large deletions need the sweep | A change of many conversations dispatches 100 deletions (the app's `app/Conversations/Deletions.php:35`, `:127-132`). The sweep sends the rest, 1,000 a pass (the app's `app/Console/Commands/SweepRuns.php:79-87`). |
| Removed uploads wait for the sweep | The sweep deletes their objects (the app's `app/Console/Commands/SweepRuns.php:104-105`; the app's `app/Files/Uploads.php:152-179`) once 30 minutes have passed since presigning (`Uploads.php:40`). Until then they count against the member's 30 (`Uploads.php:97-101`). |
| The schedule | The sweep and `billing:sync --due` every five minutes, retention hourly, the connections' describe and the billing sync daily, each `withoutOverlapping()` (the app's `routes/console.php:7-18`). That lock lasts 1,440 minutes by default (the app's `vendor/laravel/framework/src/Illuminate/Console/Scheduling/ManagesAttributes.php:184-195`). |
| The pause flag is read every minute | `schedule:run` reads `illuminate:schedule:paused` unless `Schedule::withoutInterruptionPolling()` was called (the app's `vendor/laravel/framework/src/Illuminate/Console/Scheduling/ScheduleRunCommand.php:116`, `:293-300`; the app's `vendor/laravel/framework/src/Illuminate/Console/Scheduling/Schedule.php:531-535`). Nothing in the app's `app/`, `bootstrap/`, `routes/` or `config/` calls it. |
| The contract's open strings | A refusal's code is any string (`contract/src/internal/common.ts:34-35`; the app's `app/Engine/StartRefused.php:5-9`), and so is `run.finished`'s `code` (`contract/src/internal/facts.ts:209-210`). The start's `outcome` is a closed literal for the app (the app's `app/Engine/AnswerMapper.php:78-84`). |

## Decisions

### The start protocol, both sides

t is seconds from the POST that registers the run (`runs.created_at`). Files still uploading at Send are put first: assistant-ui holds the message until they finish, with their chips showing progress, and the bound starts after (the app's `@assistant-ui/core` 0.3.28, `dist/runtime/base/base-composer-runtime-core.js:200-260`). Below, "after Send" means after that POST. L is Laravel and E the engine.

1. **t = 0, L, in the POST.** `Runs::start`'s transaction does not change (the app's `app/Runs/Runs.php:87-143`). It checks admission, the locks, seats, budget, the start limits, a busy conversation, the history gate and storage, registers the run `starting` with `start_body`, makes the message `sending` and takes the uploads. `start_body` keeps its bytes and gains no field. The commit takes about 0.1 to 0.3 s (inferred).
2. **t = 0.2, L, after the commit, outside every lock.** The fallback `SendStart` is dispatched with a delay of `START_BOUND + 5`, 15 s, before any try, so a request that dies later still has it. A failed push is reported and not thrown, and the backstop then covers that start. This replaces the dispatch at `Runs.php:145`.
3. **t = 0.2 to 8, L, still in the request.** `Runs::sendFirst` tries the start until 8 s after `created_at` (Laravel's start in the request).
4. **E, in the Worker.** Access, the 16 MB cap, zod, the digest over the unchanged input and the D1 bind stay as they are (ARCHITECTURE.md, Starting a run, step 1).
5. **E, in the Conversation object.** The bind, a stored answer replayed, the in-memory join, the message's own refusals, the preparation compiled once and txn1 stay as they are (`cloudflare/src/conversation/conversation.ts:304-314`, `:455-476`). Then come the inspection, the plan and txn2 (The engine's answer). It answers 200 in about 0.3 to 2 s on a warm object, whatever the files weigh (inferred, since today's median of 2 s from registration to answer includes the queue's pickup, and the inspection is at most 10 small R2 reads).
6. **L, in `sendFirst`.** `Runs::answered` applies the answer as today (the app's `app/Runs/Runs.php:372-403`). A refusal now also releases the run's uploads, unless its code is `ATTACHMENT_UNAVAILABLE`. The redirect follows, and the page opens on the running run, takes a stream token and reads `/stream/v1`.
7. **E, deferred.** The run's loop copies the attachments as its first step, then runs its section as today (The copy, the run's first step).
8. **t = 8, L, when no answer came.** The start is expired, and its `start_expired` cancel is sent once within 3 s (Laravel's start in the request). The redirect comes about 11 s after Send at worst, unless the connects themselves are slow (Accepted, not fixed).
9. **t = 15 plus the queue's pickup, L.** The fallback `SendStart` finds the run answered, or expires it, or recovers its stored acceptance.
10. **Every 3 hours, L.** The backstop catches a start whose request died and whose fallback push failed.

A typical start is answered 0.3 to 3 s after Send, inside the POST. The worst visible failure comes about 11 s after Send, unless the connects themselves are slow (Accepted, not fixed).

### The engine's answer

**The inspection.** A new `inspectStaged` in `cloudflare/src/files/staging.ts` replaces the call to `measureStaged` at `conversation.ts:480`. It runs four at a time, as `MEASURES` does (`staging.ts:38`), with one `bucket.get` per attachment.

- **Missing, of a size other than the declared one, or over the 50 MB file limit:** `ATTACHMENT_UNAVAILABLE`, with the body cancelled, as `measure` does (`staging.ts:49-55`).
- **Otherwise** it reads up to `SNIFF_BYTES` from the body, cancels the rest, and answers the cleaned name, the size and `sniff(head, name)`.

The `Bucket` port does not change (`cloudflare/src/files/objects.ts:9-16`).

**The plan.** A new `planAttachments` is the first half of today's `prepareAttachments` (`files/store.ts:593-624`), synchronous over the folder's current version.

- The paths are numbered against the root names, as today.
- `parseManifest` runs over the parent's files and each new path, with a distinct placeholder SHA-256 for each new entry, since `parseManifest` requires a valid one (`cloudflare/src/files/manifest.ts:164`). So `FOLDER_FULL` by entries and `INVALID_ATTACHMENTS` are decided as today.
- `FOLDER_FULL` by bytes is `folderBytes` over the parent's entry sizes and the declared sizes. That is the total today's check reaches, since `folderBytes` counts each entry (`limits.ts:46-50`; `files/store.ts:618-623`). It is never a map keyed by the placeholder hashes.

A refusal goes through `#refuseInternal`, as today (`conversation.ts:549-551`). A full folder is now refused before any byte past a head is read.

**txn2** checks `#startState` first, as today (`conversation.ts:487-492`). Then, in the same write:

- `insertRun` with `base_version_id` set to the folder's current version, which is the plan's parent;
- new `run_attachments` rows, each with the run's id, the position, the upload key, the name, the size, the media type, the path, the parent's id and the mtime (a migration in `cloudflare/src/conversation/schema.ts`; the rows go with the run's prune);
- the snapshot's attachments and the turn's prompt from the plan (`conversation.ts:495-502`);
- the `queued` event, `activate` (`run.status` `provisioning` attempt 1, with the facts job due), the watch and deadline jobs, and the acceptance stored with the plan's `{path, size, mediaType}` and the preparation deleted, all as today (`:503-519`).

Only the loop is deferred. The deletion of the staged objects moves from the answer (`:524`) to after the copy's commit.

A preparation now lives about a second, not the whole copy. So it holds the conversation busy, and holds back the retention job (`cloudflare/src/conversation/retention.ts:204`), for that long only.

The `FolderPort` (`cloudflare/src/conversation/ports.ts:73-83`; `cloudflare/src/files/folder.ts:48-68`) gains `inspectStaged`, `planAttachments` and `copyAttachments` in place of `prepareAttachments`.

### The contract

No schema changes. `StartRun`, `StartRunResult`'s fields, `CancelRun` and every fact keep their schemas, so the wire is unchanged and an app built before this design reads every answer and fact. What `accepted` promises does change, and that is none of the additive kinds in contract.md's Versions (`docs/plans/contract.md:21-27`). It is an exception the owner approved (owner question 1). Like a new kind of fact, it goes receiving side first: Laravel's handling of a run that ends before its copy commits (unit 1) runs on every environment before the engine it calls runs unit 3 (Deploy order and rollback).

- **The input** does not change, so neither does the digest (`cloudflare/src/internal/start.ts:148-151`). Tries that straddle an engine deploy or a rollback get no `IDEMPOTENCY_CONFLICT`.
- **`accepted`** (`contract/src/internal/engine.ts:110-121`) changes in its doc comments only. The member's comment becomes "The run is stored and active. Its attachments were checked against their staged objects by size and head, and against the folder's limits. The run copies them before its first step." The comment on `attachments` becomes "The message's attachments as the folder will hold them, in the message's order. Paths are numbered against the folder at the start, sizes are as declared and as the staged objects hold them, and types are sniffed from their first 8 KiB. The run copies them before its prompt is submitted, and a copy that fails ends the run `failed` with code `attachment_unavailable` or `workspace_full`. A run that ends before its copy commits, a cancelled one say, leaves the folder without them. Laravel stores these on the message." `catalog`, `compiler`, `digest` and `authorized` do not change, and are computed at the preparation as today.
- **`startRun`'s own comment** (`engine.ts:261-265`) says it "copies its attachments and admits it". It becomes "checks its attachments and admits it; the run copies them".
- **Refusals.** A refusal's code is an open string (`contract/src/internal/common.ts:34-35`; the app's `app/Engine/StartRefused.php:5-9`), so these are documentation only. `ATTACHMENT_UNAVAILABLE` now means missing, of another size or over the file limit, judged from the object and its head. `FOLDER_FULL` and `INVALID_ATTACHMENTS` are decided before any byte past a head is read. `WORKSPACE_FULL` is no longer a refusal of `startRun`; it becomes a run's end.
- **`run.finished`'s `code`** is an optional string (`contract/src/internal/facts.ts:209-210`). It gains two documented values, `attachment_unavailable` (status `failed`, error "An attached file is no longer available. Remove it and attach it again.", `cloudflare/src/files/limits.ts:8`) and `workspace_full` (status `failed`, error "This workspace has no room for more files.", `limits.ts:7`). The app checks `code` only as a string, so an app built before this design accepts the fact (inferred).
- **A phase text,** "Copying the attached files". Phases go only to the browser's stream, never into facts.
- **Unchanged.** `cancelRun` (its reasons, its states `cancelled`, `tombstoned` and `ended`, and its order against a start), the kinds of fact and the other operations. A repeated start still replays the stored answer, after a cancel too.
- **The documents.** Doc comments do not reach the OpenAPI documents (none of the start's comments is in `contract/openapi/engine-v1.json`), so `pnpm --dir contract openapi:check` stays green. The app's `composer contract:sync` then only refreshes `contract/SOURCE`, and its CI's byte comparison stays green. contract.md's `startRun` entry (`docs/plans/contract.md:91-92`) gets one sentence on what `accepted` promises and on the two end codes, and its Versions one on such a change in meaning (unit 3). ARCHITECTURE.md's Starting a run (`ARCHITECTURE.md:132-144`) is rewritten in the same commit as the code, and says that a run that ends before its copy commits never holds its files.

**Why not a third outcome.** The owner agreed to a contract change that answers before the copy (owner question 1). A `received` outcome would be malformed and not retryable for an app built before it (the app's `app/Engine/AnswerMapper.php:78-84`), so it would need an opt-in input kept out of the digest, a `received_at` column, a lease gate that reads it (the app's `app/Runs/Leases.php:75-83`), and a channel for the final answer. Refusals could still come after it. Answering `accepted` before the copy needs none of these (Alternatives rejected).

### The copy, the run's first step

`#startLoop` (`conversation.ts:557-568`) changes in one place. When the run has `run_attachments` rows, `#attach` runs first, and `this.#stops.section(...)` follows as today. It stays under `#loops`, so one instance runs one copy per run, and a watch that arrives during the copy joins it.

**Before the section, not inside it.** The section's 30 s `PI_SETTLE_MS` counts from when the section is queued (`cloudflare/src/conversation/pi-stops.ts:15-16`, `:96-113`). A copy inside it would reset the object after 30 s.

`#attach` does five things in order.

1. It checks the run's fence, and shows the phase "Copying the attached files" on the stream.
2. It measures the rows' objects with `measureStaged`, a full read, counted and hashed (`staging.ts:80-99`). Null, or a type other than the row's, ends the run `failed` with `attachment_unavailable`.
3. It copies with `copyAttachments`, the second half of today's `prepareAttachments`, over the stored paths. Held hashes are reused, loose keys are recorded or reused from this run's earlier try (`files/store.ts:626-645`), the workspace counter is asked, and `#copy` puts each object with R2's SHA-256 check (`:685-698`). `WORKSPACE_FULL` ends the run `failed` with `workspace_full`, and `gone` with `attachment_unavailable`.
4. It makes one write outside pi's transactions.
   - **The run is no longer current or acting** (a cancel, a deletion or a stop came first). Its fresh keys are doomed, and nothing is committed.
   - **The folder moved, or a claim failed.** The run ends `failed` with `attachment_unavailable`. `commitAttachments` answers `moved` or `unclaimed` for these instead of throwing (`files/store.ts:705-716`).
   - **Otherwise** `commitAttachments` inserts the base version on top of the plan's parent, a new `store.setBase` sets `runs.base_version_id` to it, and the rows are deleted.
5. It defers the deletion of the staged objects.

The section then runs as today, with the settle, the tools, `startAttempt` (`run.status` `running`) and the submit (`conversation.ts:576-622`).

**Retries.** An R2 error thrown in `#attach` is logged by `#defer`, and the watch (20 s) or `onStart` runs the loop again (`conversation.ts:768-772`, `:808-826`). A reset during the copy leaves the run's keys loose, so the next try copies into them and a blob is stored once. An R2 error thrown from the copy dooms that try's fresh keys, as today (`files/store.ts:650`, `:666-669`), so the next try records new ones. The doomed keys count toward `total()` until their first deletion (`:499-503`), which the deployed engine reports to no counter (`cloudflare/src/files/folder.ts:14-15`). Unit 3 corrects `prepareAttachments`' comment (`files/store.ts:587-589`), which says the watch copies into the same keys. Ten minutes after the run was stored (the engine's `runs.created_at`), the next error ends the run `failed` with `attachment_unavailable`. That bound stays under the loose keys' one-hour sweep (`files/store.ts:403-417`; `limits.ts:118`). A copy of up to about 256 MB, read twice and written once, takes seconds to tens of seconds (inferred).

**What stays.** A cancel during the copy finishes the run through `cancelInternal` as today, and the copy's write then commits nothing. `finish` publishes the checkpoint, else the base version (`cloudflare/src/conversation/store.ts:710`), so a run that ends before its copy leaves the folder as it was and never holds the attachments its acceptance named. Its `run_attachments` rows stay until the run's prune, which is how later code knows it never copied. The snapshot's `baseVersionId` keeps the parent, and what reads a run's base reads the column (`files/store.ts:570`, `:745`, `:872`, `:915`; `conversation.ts:237`). The copy's seconds count toward the run's deadline, which starts at the preparation, as the measure and the copy do today (`conversation.ts:462`).

**The turn note.** `#turnNote` (`conversation.ts:629-640`) leaves out every earlier run whose copy never committed, which is every run that ended with its `run_attachments` rows still stored, since only the copy's commit deletes them. Those are the two copy failures, and any run that a Stop, a `start_expired` cancel, a revocation, an emergency stop or its deadline ended during the copy. Laravel shows their messages as not sent (The copy's failure in the registry), and their prompts name paths the folder never held (`cloudflare/src/conversation/history.ts:169-183`).

**New ends and a phase.** `RunEnd` (`cloudflare/src/conversation/events.ts:39-62`) gains `{failed, attachment_unavailable, NO_LONGER_AVAILABLE}` and `{failed, workspace_full, NO_ROOM}`, and `PhaseText` (`events.ts:22-30`) gains "Copying the attached files". The fault points `start:planned` and `copy:copied` use the existing `#point` (`conversation.ts:609`). The chat shows the phase only with unit 5's change to `phaseOf` (the app's `resources/js/components/chat/model.ts:220-233`). Today a `provisioning` run always reads "Starting the agent" there, whatever phases follow.

### Laravel's start in the request

**Why in the request.** The managed queue caused every slow start measured. So the first try runs inline in the POST, after the commit and outside every lock (the app's `docs/architecture/turn.md:56`). It does not run after the response through `defer()`, since Laravel Cloud does not document whether that work survives the response or a scale-down (Alternatives rejected). The page then lands on a running run, and `minerva:turn` (the app's `app/Console/Commands/RunTurn.php:49`) and the tests get the try through `Runs::start` too.

**The constants** (the app's `app/Runs/Runs.php`). `START_BOUND` goes from 300 to 10 (`:57`), and a new `SEND_WITHIN` is 8.

**`Runs::start`** dispatches `SendStart::dispatch($id)->delay(START_BOUND + 5)` after `DB::transaction`, then calls `$this->sendFirst($id)`. A failed push is reported and not thrown.

**`Runs::sendFirst($id)`.** While now is before `created_at + 8 s`, it calls `SendStart::attempt($engine, $runs, $id, within: max(1, floor(created_at + 8 - now)))`. `attempt` is a static method the job shares. `created_at` is stored to the second, so the window is 7 to 8 s, never longer.

- It reads the run again, and stops if the run is gone or answered, has a cancel in any state, finds admission closed, or is no longer `starting` (facts moved it, and the fallback then recovers the answer).
- It stamps `start_tried_at`.
- It sends `start_body` byte for byte through `EngineClient::startRun($body, $within)`, which passes `$within` to `send` (the app's `app/Engine/EngineClient.php:120-123`, `:224-237`). Guzzle's stream handler ignores the connect timeout (What the code does today). It bounds the connect, and each wait for the answer's headers, by `within` apiece, and checks the whole deadline only once the headers are in (the app's `vendor/guzzlehttp/guzzle/src/Handler/StreamHandler.php:476-490`, `:1008-1016`). So a try ends at `within` against an engine that refuses or hangs after a quick connect, and at up to about twice that when the connect itself is slow.

Then, by the answer:

- **Accepted or refused:** `Runs::answered`, and the loop ends.
- **Retryable** (no answer, a timeout, a 5xx). A 1 s sleep, then another try if at least 1.5 s remain.
- **Not retryable:** logged, and the loop ends at once.

**When the start is not answered.** When the loop ends with the run still `starting`, unanswered and without a cancel, `Runs::expire($id, due: true)` requests the `start_expired` cancel. With `$due` the bound is not checked again, and the other conditions of `Runs.php:496-504` stay. Then `SendCancel::attempt(within: 3)` (the app's `app/Jobs/SendCancel.php:48-70`) sends it once.

- **`tombstoned`:** the run becomes `cancelled`, and the message `failed` with the reason alone, "Minerva could not reach the agent in time.", which the chat shows as "Not sent: Minerva could not reach the agent in time." (the app's `resources/js/components/chat/model.ts:236-240`). The uploads are released.
- **`cancelled`:** the engine had stored the run and stopped it. Its `run.finished` (`failed`, `start_expired`) shows on the page, and the fallback recovers the stored acceptance.
- **`ended`:** the engine had stored the run, and it ended on its own before the cancel (`conversation.ts:323`). Its own `run.finished` shows how it ended, and the fallback recovers the stored acceptance.
- **Unacknowledged:** the run is held (What the user sees). The page shows "Not sent yet: Minerva cannot reach the agent. You can send it again once it can.", derived from the pending cancel, and Send stays disabled until `SendCancel` lands.

The redirect comes about 11 s after Send at worst, unless the connects themselves are slow (Accepted, not fixed). `cancelAcknowledged` (`Runs.php:510-524`) writes the new reason only for a tombstoned `start_expired` cancel, and other reasons keep today's text. Both release the uploads.

**A Stop during the request.** The composer shows Stop while the POST runs (the app's `resources/js/components/chat/runtime.ts:89`). A click posts `cancel`, and the browser drops the POST, though the server goes on. `sendFirst` then stops at its next check and leaves the cancel to its job. So `ConversationController::cancel` makes one `SendCancel::attempt(within: 3)` after `Runs::cancel` commits, as `Revocations::await` does (the app's `app/Runs/Revocations.php:288-299`). Against a reachable engine the start is tombstoned and reads "Not sent.", or the stored run stops. The transcript holds a `starting` run with any unacknowledged cancel, not only `start_expired` (What the user sees).

**Released uploads.** A refusal other than `ATTACHMENT_UNAVAILABLE`, and a tombstoned cancel, release the run's uploads, setting `run_id` to null on those still inside `Uploads::expiry()` (the app's `app/Files/Uploads.php:182-185`). The same write stores the message's files on the failed message as `attachments` (`{path: name, size, mediaType}`, as the transcript shows pending ones, the app's `app/Conversations/Transcript.php:86-87`), which the history never reads, since it sends only sent messages (`Runs.php:330`). Each upload keeps the run it came from in a new nullable `uploads.released_from`, which only the retry payload reads and which the next start that takes it clears. So the failed message keeps its chips after Send again takes its files.

**The fallback job.** `SendStart::handle` (the app's `app/Jobs/SendStart.php:41-80`), delayed 15 s, decides in this order.

1. When the run is answered or gone, or its cancel tombstoned, it returns.
2. While a cancel is unacknowledged, or admission is closed and the run has no cancel, it holds, released with `Backoff`, as today (`:51-56`). Once the cancel is past `SendCancel::OVERDUE`, the hold is released after 900 s instead, the pace of the cancel's own non-retryable error.
3. When the run is `starting` with no cancel past `START_BOUND`, the request died. It expires the start, sends `SendCancel::attempt(within: 5)`, releases itself for 5 s, and then holds until the acknowledgement.
4. Otherwise it sends. A run whose cancel was acknowledged `cancelled` or `ended`, or one that facts moved on, is sent to read its stored acceptance. That is an obligation, retried with `Backoff` for a day, and a non-retryable error is released after 900 s. A `starting` run with no cancel inside the bound is sent with `within` set to the time left.

The bound now applies only to a run with no cancel. That closes today's gap (the app's `app/Jobs/SendStart.php:58-62`; the app's `app/Runs/Runs.php:410-414`). A cancel acknowledged `cancelled` or `ended` leads to a send that sets `answered_at`, so the history gate (`Runs.php:125-130`) stops blocking the conversation's next message with files.

**The copy's failure in the registry.** `Facts::finished` (the app's `app/Runs/Facts.php:360-397`) turns every run that ended before its copy committed into a failed user message with the run's error, whatever its code. Laravel knows such a run as one that took uploads, as the history gate reads it (`Runs.php:125-130`), and that ended with no `run.status` `running` fact, since the engine's `startAttempt` comes only after the copy's commit (`conversation.ts:584`). `Facts::status` stamps the first `running` fact in a new nullable `runs.started_at`; today it reads only the attempt (the app's `app/Runs/Facts.php:336-345`). The message is `sent` by then (`Runs.php:390-393`), and `Runs::userMessage` moves only a `sending` one (`Runs.php:538-545`), so this is its own update from `sending` or `sent` to `failed`. The history already leaves out messages that are not sent (`Runs.php:330`). The transcript gives a failed user message's files no version, so its chips are names, not links to a version that lacks the files (the app's `resources/js/components/chat/model.ts:271-274`).

**The request's length.** The POST lasts 0.3 to 3 s, and up to about 11 s while the engine cannot be reached (inferred). Laravel Cloud's environment timeout must be at least 15 s, set and deployed before unit 4, or a 504 would hide a run that exists (owner question 2).

### Each job's policy

Every engine job keeps `Backoff` for its own releases (5, 10, 20, 30 s, then every 30 s; the app's `app/Jobs/Backoff.php:5-13`) and gains `public array $backoff = [5, 10, 20, 30];`. So an exception a job does not catch, a database error while Postgres resumes say, is retried after 5 to 30 s instead of at once in a loop (the app's `vendor/laravel/framework/src/Illuminate/Queue/Worker.php:876-885`). Every try stays under the worker's `--timeout=60` and the Flex queue's 90 s.

| Job | Purpose | Policy | Change from today |
|---|---|---|---|
| `sendFirst`, in the POST | A start, which fails fast | Tries for 8 s, then expires the start and sends its cancel once, within 3 s | New |
| `SendStart`, delayed 15 s | A start, then an acceptance's recovery | Fast before the bound, since a `starting` run with no cancel past 10 s is expired, never sent. It holds while a cancel is unacknowledged, or while admission is closed and the run has none, 900 s at a time once the cancel is past `OVERDUE`. An obligation once it recovers a stored acceptance, retried for a day, with a non-retryable error released after 900 s | The fallback, delayed. The bound only with no cancel. A non-retryable error released, not ended |
| `SendCancel` | Security | An obligation, `$tries = 0` for a day, errors logged past `OVERDUE` (600 s). A non-retryable error is released after 900 s. The inline first tries stay, in `Revocations::await` (10 s) and in `sendFirst`'s and the fallback's `start_expired` cancel, and a user's Stop gains one (3 s) | A non-retryable error released, not ended. A user's Stop tried inline |
| `SendDeletion` | Privacy | The same. A deletion refused for good is retried every 15 minutes for a day, then by the backstop, never-tried first | A non-retryable error released, not ended |
| `DrainDeletions(cursor)` | Privacy | Dispatches `SendDeletion` for the next 100 deletions in `(deleted_at, id)` order after its cursor, as `Deletions::dispatch` does for the first 100, and chains itself 30 s later until a hop finds fewer than 100. It sends nothing itself, so a hop is one query and 100 pushes, and each deletion keeps its own job's policy. `$tries = 0` for a day | New. It replaces the sweep as the only sender past the first 100 (the app's `app/Conversations/Deletions.php:35`) |
| `CancelNarrowed` | Security | `$tries = 0`, `retryUntil` a day | From one try under `--tries=1`, with the sweep as its retry |
| `SyncBilling`, `SyncSeatChange` | Money | A day, then the daily sync, as today. Not swept | `$backoff` only |

`Deletions::dispatch` (`Deletions.php:127-132`) sends the first 100 as today, and dispatches `DrainDeletions` after its commit while more remain. That keeps today's 12,000 deletions an hour.

900 s is the 15 minutes Cloud documents as the longest release. A non-retryable obligation that keeps failing, a misconfiguration say, is then retried every 15 minutes for a day, and so are the held fallbacks of the starts it caught, each failure logged as an error (Risks).

**Per-item timers instead of the 5-minute sweep.**

- **A start's bound.** The request (8 s), then the delayed fallback (15 s).
- **Cancels, deletions and narrowings.** Their own job's release.
- **Large deletions.** `DrainDeletions`.
- **Removed uploads.** No timer. They are deleted at a reservation that their count would refuse, once 30 minutes have passed, and daily for everyone else. R2's day-long rule is the net.

### The backstop and housekeeping

**The backstop.** `minerva:runs:sweep` (the app's `app/Console/Commands/SweepRuns.php`) runs every 3 hours at :00 (`everyThreeHours()`, so 00:00, 03:00 and so on), with `IDLE` raised from 60 s to 20 minutes (owner question 5). It is for what only a sweep catches. That is a dispatch lost between the commit and the push (an `afterCommit` callback lives only in memory), a job past its day, and a job the queue lost. Twenty minutes is longer than any job's own release (30 s, or 900 s for a non-retryable obligation or a hold past `OVERDUE`), so the backstop dispatches only what no job is retrying.

1. While admission is closed or restoring, `Admission::requestCancels`, as today (`SweepRuns.php:52-54`).
2. It expires `starting`, unanswered runs past `START_BOUND` that have no cancel (`:56-62`).
3. It dispatches `SendStart` for unanswered runs that are not tombstoned, have no unacknowledged cancel, and were not tried for 20 minutes. Today's query (`:64-70`) also matches held runs, whose holds never stamp `start_tried_at` (the app's `app/Jobs/SendStart.php:51-56`), so each pass adds another holding job (inferred).
4. It dispatches `SendCancel` for unacknowledged cancels not tried for 20 minutes.
5. It dispatches `SendDeletion` for unacknowledged deletions not tried for 20 minutes, at most 1,000, never-tried first.
6. It dispatches `CancelNarrowed` for narrowings at least 20 minutes old.

The upload work moves out. The app's turn.md says the sweep "runs one indexed query when there is nothing to do" (the app's `docs/architecture/turn.md:88`); a pass runs about nine statements, and the text is corrected.

**Housekeeping.** A new `minerva:uploads:clean` runs daily at 03:00, inside that hour's wake.

- It deletes the staged upload rows of `SweepRuns.php:93-102`, with the same predicate, 1,000 rows a statement, until none are left or 60 s have passed.
- Then it runs `Uploads::deleteRemoved` (100 objects, 60 s, three failures; the app's `app/Files/Uploads.php:152-179`).

**On demand at a reservation.** `Uploads::reserve` (`Uploads.php:65`), before its transaction, counts the member's pending and removed uploads as the transaction does (`Uploads.php:93-101`). Only when they make the 30 does it delete the member's removed uploads whose PUT was presigned at least `REMOVED_DELETE_SECONDS` ago: oldest first, as many as bring the count under 30, within 5 s, stopping at three failures. This is `deleteRemoved` for one user. So a reservation calls R2 only when it would otherwise be refused. It waits for these deletions before it answers, a few hundred milliseconds for a few removed files and 5 s at most, and the chip shows no progress meanwhile. Two reservations at once may send the same delete, which is harmless since R2's 404 counts as deleted. Otherwise a removed upload's object stays until 03:00's `uploads:clean`, a day at most, as an unsent upload's does, and conversations.md's Remove (the app's `docs/architecture/conversations.md:130`) says so. "You removed many files just now. Try again in half an hour." (`Uploads.php:100`) stays true with no timer.

**Retention** runs every 3 hours at :00, last, in the backstop's wake, since an hourly retention would keep an hourly wake. A deleted conversation's rows then go at most 3 hours after their 7 days instead of 1. Its pass's budget goes from 5 to 3 minutes (the app's `docs/architecture/retention.md:65`). So a wake's tasks end inside a 5-minute sleep timeout while the others take under 2 minutes, as they do with the pilots' few connections and organizations (inferred).

### The schedule and sleeping

The app's `routes/console.php` (`:7-18`) becomes:

- `Schedule::withoutInterruptionPolling()`, so a `schedule:run` with nothing due reads nothing from the cache (the app's `vendor/laravel/framework/src/Illuminate/Console/Scheduling/Schedule.php:531-535`). `schedule:pause` and `schedule:interrupt` stop working; the app uses neither.
- the backstop every 3 hours at :00, `withoutOverlapping(30)`;
- `minerva:connections:describe` daily at 00:00 and `minerva:uploads:clean` daily at 03:00, each `withoutOverlapping(60)`;
- inside `if (Billing::enabled())`, the billing sync daily with `withoutOverlapping(60)` and its `--due` every 3 hours with `withoutOverlapping(30)`. They are registered only then, since Cloud reads `schedule:list`, which does not evaluate `when()`;
- retention every 3 hours at :00, `withoutOverlapping(30)`, registered last.

`schedule:run` runs a minute's due tasks one after another, in the order they are registered (the app's `vendor/laravel/framework/src/Illuminate/Console/Scheduling/ScheduleRunCommand.php:114-142`), and a wake lasts the sleep timeout. So retention goes last and takes what the wake has left. Its pass is built to be cut anywhere and finished at the next pass (the app's `app/Conversations/Retention.php:17-19`).

The short expiries replace the default 1,440 minutes (the app's `vendor/laravel/framework/src/Illuminate/Console/Scheduling/ManagesAttributes.php:184-195`). So a pass killed by the sleep timeout, a signal or running out of memory leaves a lock that expires before the next pass, and every check in these tasks is idempotent.

With billing off, staging's `schedule:list` then shows only `0 */3 * * *`, `0 0 * * *` and `0 3 * * *`, and one wake every 3 hours covers every task. Cloud reads `schedule:list` at each deploy, so the new schedule takes effect with the deploy of the commit that changes it (Cloud's docs, read 2026-10-24).

**Sleeping.** Staging's sleep timeout becomes 5 minutes (owner question 3). An idle staging then wakes at 00:00, 03:00 and every 3 hours after for its tasks, and sleeps 5 minutes later. Its database suspends 5 minutes after the last query, since nothing reads the cache every minute. That is about 6 minutes awake every 3 hours, roughly 3% of the day, and about a fifth of a compute-unit hour a day for the database instead of 5.9 (inferred).

**Production.** It is not being deployed yet (owner question 4). When it is, its scheduler is turned on with the same schedule, and its sleep timeout is set to 5 minutes (Deploy order, step 4). Cloud never lets an environment sleep when its most frequent wake is at or under its sleep timeout (Cloud's environment-not-sleeping article, read 2026-10-24), which a wake every 3 hours never is, since the timeout is at most 60 minutes. It then wakes every 3 hours instead of never, and gets the backstop, retention and the billing sync it lacks today.

### What the user sees

- **While the POST runs.** The composer shows the text and its existing "Sending" row (the app's `resources/js/components/chat/runtime.ts:75-116`), usually for 0.3 to 3 s. Stop is shown, and a click sends its cancel at once (A Stop during the request).
- **Accepted.** The page opens on the running run and streams as today. With files, the first phase is "Copying the attached files", then "Starting the agent" (unit 5's `phaseOf`). The chips show the paths the acceptance named.
- **Refused.** "Not sent: <reason>" under the message, as today, now with Send again. Send again puts the text back in the composer, and the files too when they were released, which is every refusal but an unavailable file.
- **Not answered within 8 s.** After the redirect, about 11 s after Send at worst, the message shows "Not sent: Minerva could not reach the agent in time." with Send again, which refills the composer with the text and the same files. Send comes back and Stop goes away.
  - While the engine has not confirmed the cancel, the run is held, and the message shows "Not sent yet: Minerva cannot reach the agent. You can send it again once it can.", with Send disabled, the input usable, Stop hidden, and the page reloaded every 10 s. An inline cancel the engine acknowledges lands before the redirect, so this state shows mostly while the engine cannot be reached. It then lasts until the engine is back and `SendCancel`'s next try lands, up to 30 s later plus the queue's pickup. It lasts under a second only after a request that died, when the fallback's inline cancel is acknowledged. A message sent meanwhile from another tab is refused "Wait for the agent to finish.", as today.
  - If the engine had in fact stored the run, which is rare (Accepted, not fixed), its `run.finished` shows how it ended under a sent message. When the cancel stopped it, that is "The agent could not finish this run. Try again.", and Send again gives the text back; the files must be attached again. A cancel that lands during that run's copy fails the message instead, with Send again giving the text back (The copy's failure in the registry).
- **The run ends before its copy committed.** "Not sent: An attached file is no longer available. Remove it and attach it again.", or "Not sent: This workspace has no room for more files.", with Send again giving the text back. A Stop during the copy shows "Not sent: Stopped.", with Send again giving the text back.
- **"Sending"** replaces "Waiting to start" for a `starting` run (the app's `resources/js/components/chat/model.ts:107-110`), as the pending row (`model.ts:370`) and the other phases are written, with no ellipsis. After the redirect it appears only when the request died, until the fallback at about 15 s.
- **Removed uploads.** "You removed many files just now. Try again in half an hour." stays true.

The transcript (the app's `app/Conversations/Transcript.php:70-130`) carries these states.

- A `starting` run with any unacknowledged cancel, a pending `start_expired` one or a user's Stop, is held. It is left out of `live` and named in a new prop, `held` (its run id), which `TRANSCRIPT_PROPS` gains (the app's `resources/js/hooks/use-run-stream.ts:15-21`), and its message shows the phase `not_sent_pending`. Every loop `useRunStream` has needs `live` (`:155-172`), so it gains one that reloads every 10 s while `held` is set, beside `waiting`. With `live` null the composer shows Send, not Stop (the app's `resources/js/pages/chat/show.tsx:86`). `held` renders Send disabled and leaves the input usable, since `isDisabled` (`:87`) would lock the input too, and a start then is refused "Wait for the agent to finish." (the app's `app/Runs/Runs.php:119-121`).
- A failed user message gets a `retry` payload with its content and its released uploads (id, name, size, type), found through `released_from`. A sent message whose run ended `start_expired` before it ran (`runs.started_at` null) gets one with its content only.
- A run that ended before its copy committed is shown only through its message's failure.

Send again is new code. The give-back path restores only the same page's entries after a refusal (the app's `resources/js/components/chat/runtime.ts:109-111`). So the adapter gains `adopt(uploads)`, which registers the `retry` payload's uploads as returned entries. Send again then sets the composer's text and calls `addAttachment` with each upload as a complete attachment of the same id, replacing the draft. Leaving the page deletes adopted uploads as it deletes any unsent one (the app's `resources/js/lib/uploads.ts:94-98`). The strings go through the minerva-design skill and `__()`, as the app's others do, and the component tests pin them. No other screen changes.

## Deploy order and rollback

Deploys of the engine's staging and production ask the owner first (AGENTS.md, Cloudflare). So do the app's production deploys and any Laravel Cloud setting (the app's AGENTS.md, Laravel Cloud). A push to the app's `main` deploys the app's staging through CI.

1. **App units 1 and 2.** They are harmless against today's engine, which sends neither end code and sends a run's `running` fact within milliseconds of its acceptance, and every policy change applies to today's jobs. CI deploys them to staging, and that deploy also applies staging's environment timeout of 15 s, already set (owner question 2). Then staging's sleep timeout is set to 5 minutes with `cloud instance:update --scale-to-zero-timeout`, with the owner's go, and a redeploy follows. Cloud applies the environment's timeout at the next deployment and a cluster's sleep settings at a redeploy (Cloud's API docs for updating an environment; its environment-not-sleeping article, read 2026-10-24).
2. **The harness unit, unit 3,** in one commit, as a protocol change must be (AGENTS.md, Where docs go). `pnpm check --instance minerva-cf-test`, push `main`, green `main.yml` and `account.yml` runs (`gh workflow run account.yml`), then deploy `minerva-cf-staging` once the app's staging runs unit 1. `minerva-cf` waits for step 4. The deploy's CI gate checks the runs. Today's app keeps working against it. Starts with files get faster, its 300 s bound finds them answered, and a run that ends before its copy commits arrives as a `run.finished` that unit 1 already maps.
3. **App units 4 and 5,** pushed to the app's `main` only once `minerva-cf-staging` runs the new engine. Before unit 4 is pushed, staging's environment timeout is at least 15 s, and a deploy since the change carries it (owner question 2). Unit 4 against an engine that still copies before it answers would expire every start with large files.
4. **Production, once the owner deploys it.** It is not being deployed yet (owner question 4), so the app's `main` runs ahead of it. The app's production deploys only `main`'s head, so it gets units 1, 2, 4 and 5 in one deploy, and `minerva-cf` gets unit 3 just before it. In the minutes between the two, the old app does not map the two new end codes, which is better than the reverse order, where unit 4's 10 s bound would expire every start with large files. Before the app's deploy, the owner raises production's environment timeout to 15 s if it is under that. After it, production's scheduler is turned on and its sleep timeout set to 5 minutes (`cloud instance:update --uses-scheduler --scale-to-zero-timeout`, with the owner's go), followed by a redeploy, since the toggle takes effect at a deploy (Cloud's scheduled-tasks docs).
5. **The next day,** staging's sleep timeline and its database's compute-unit hours, and production's once step 4 is done (Live checks).

**Rollback.** Units 5 and 4 first, which bring back the 300 s bound and the first try on the queue. Then the owner stops all agents (the emergency stop, the app's `app/Runs/Admission.php:51-73`), waits until its cancels are acknowledged, rolls the engine back, and reopens. Today's code submits an acting run it has no submission for (`conversation.ts:768-772`, `:808-826`) with a prompt that names its attachments. A run still in its copy would therefore run without its files, and a rollback made because copies fail finds runs retrying for up to 10 minutes. Units 1 and 2 and the doc comments need no rollback. The `run_attachments` rows a rolled-back engine leaves belong to ended runs, and the old code ignores them. cloudflare/README.md's Deploy and the app's turn.md carry this floor once built (units 3 and 4).

## Units

Each unit is for one fresh agent, in this order. An app unit is done when the app's checks pass (`composer test`, `pnpm run check`, `pnpm run types:check` and `pnpm test`) and it is committed. The harness unit is done when `pnpm check --instance minerva-cf-test` passes and it is committed. opencode reviews the diffs of units 3 and 4, which change every start.

1. **The jobs' policies and the copy's failure (app).** It builds:
   - `$backoff` on `SendStart`, `SendCancel`, `SendDeletion`, `SyncBilling`, `SyncSeatChange` and `CancelNarrowed`, and `$tries = 0` with `retryUntil` a day on `CancelNarrowed`;
   - the release after 900 s of a non-retryable error in `SendCancel` and `SendDeletion`, logged as today;
   - `SendStart`'s bound only for a run with no cancel, and its hold released after 900 s once the cancel is past `OVERDUE`;
   - `DrainDeletions` and its dispatch from `Deletions::dispatch`;
   - `runs.started_at`, stamped by `Facts::status` at the first `running` fact, and `Facts::finished`'s failed message for every run that took uploads and ended with no `running` fact, whatever its code;
   - the docs in the app's turn.md, SendStart and Cancelling a run (`docs/architecture/turn.md:72-86`), and in conversations.md's deletions;
   - the app's `docs/architecture/conversations.md:133-134` (the engine inspects each file by size and head before it answers, and the acceptance's attachments are as the folder will hold them once the run copies them, or never, for a run that ends before its copy), and the comments at the app's `app/Models/Message.php:27`, `app/Engine/StartAccepted.php:5-7` and `app/Runs/Runs.php:388`, worded the same.

   Its Pest tests:
   - a cancel acknowledged `cancelled` leads `SendStart` to send and set `answered_at`, and `SendStart` holds while a cancel is pending and is released after 900 s once the cancel is past `OVERDUE`;
   - a throwing `CancelNarrowed` is released and retried (the app's `tests/Feature/Connections/NarrowingTest.php:127`, `:157`);
   - `SendCancel` and `SendDeletion` release a non-retryable error;
   - a drain sends 1,001 deletions in hops (the app's `tests/Feature/Organizations/DeletionTest.php:245`, `:268`);
   - `run.finished` with either code fails the message, and so does `run.finished` with no earlier `running` fact for a run that took uploads, whatever its code. A run with a `running` fact keeps its message sent.
2. **The backstop, housekeeping and the schedule (app).** It builds:
   - the sweep as the backstop, with `IDLE` at 20 minutes, held runs skipped and the upload work moved out;
   - `minerva:uploads:clean`, and `Uploads::reserve`'s deletion of the member's own removed uploads when their count would refuse it;
   - retention's 3-minute budget;
   - `routes/console.php` as above, retention registered last;
   - the docs in the app's `docs/architecture/`, turn.md (`:88`), gate.md (`:135-140`), billing.md (`:193`, `:209`), retention.md (`:7`, `:65`, `:285`, `:304`, and its stale `:11`) and conversations.md's uploads (`:130-135`).

   Its Pest tests:
   - the sweep's tests at the new `IDLE` (the app's `tests/Feature/Runs/StartTest.php:218`, `:233`);
   - the deletion at a reservation, and `uploads:clean` (the app's `tests/Feature/Files/UploadsTest.php:146`, `:358`);
   - billing registered every 3 hours and daily, only while it is on. `routes/console.php` runs once, when the console kernel boots in `createApplication`, before a test's `config()`. phpunit.xml forces both Stripe secrets empty (the app's `phpunit.xml:42-45`), so billing is off at boot, and the existing test's toggle (the app's `tests/Feature/Billing/SyncBillingTest.php:247-255`) cannot reach the registration. For each case, the test sets the config, binds a fresh `Schedule` in the container and clears the facade's resolved instance, requires `routes/console.php` again, and asserts on that schedule's events: both billing events when on, none when off;
   - one schedule test that every registered event runs every 3 hours or daily and that `Schedule::$pausable` is false. It tests the registered events, which is what Cloud reads, not the source.
3. **The answer before the copy (harness).** It builds:
   - `inspectStaged`, `planAttachments`, `copyAttachments`, `commitAttachments`' answers and the `FolderPort`'s methods;
   - the `run_attachments` migration;
   - `#attach` in `#startLoop`, `store.setBase`, and `#turnNote` leaving out every run whose `run_attachments` rows remain;
   - the two `RunEnd` entries, the phase text and the two fault points;
   - the contract's doc comments, ARCHITECTURE.md (Starting a run, `:132-144`; Files, Uploads, `:324`) and contract.md's `startRun` entry (`:91-92`);
   - ARCHITECTURE.md's Testing rows, Start and revocation (`:397`) and Files (`:407`), for the copy as the run's first step: a cancel during the copy step, a reset at `copy:copied`, a staged object gone after acceptance, an R2 error retried by the watch;
   - contract.md's Versions gains one sentence: a change in what an outcome promises, with the wire unchanged, needs the owner's approval and the receiving side's handling deployed first;
   - cloudflare/README.md, Deploy, beside retention and 19b: while the app's start in the request (unit 4) runs on an environment, the engine that environment calls is never rolled back below unit 3, since an engine that copies before it answers misses the 8 s window for every start with large files. Roll the app's units 5 and 4 back first, and stop all agents before the engine's rollback;
   - `prepareAttachments`' comment (`files/store.ts:587-589`), now `copyAttachments`', on which keys a retry copies into.

   Platform tests in `cloudflare/test/platform/internal-runs.test.ts`:
   - `:281` becomes an acceptance after reading at most 8 KiB per staged object (a bucket wrapper counts the bytes read before the answer), with the planned paths, sizes and types, the `run_attachments` rows and no new base version yet. Then the run copies, commits its base version and deletes the staged objects.
   - A staged object missing, or of another size, is refused `ATTACHMENT_UNAVAILABLE` at once.
   - `FOLDER_FULL` is refused without reading past the heads. No cleaned name reaches `INVALID_ATTACHMENTS`.
   - A staged object deleted after acceptance ends the run `attachment_unavailable`. Its prompt is never submitted, the folder is unchanged, and the next run's turn note leaves it out.
   - The workspace counter refusing the copy ends the run `workspace_full`.
   - A reset at `copy:copied`. The watch copies again into the recorded keys, and the blob is stored once.
   - A `start_expired` cancel during the copy (today's `:401`). The run is stopped, no base version is committed, its fresh keys are doomed, its rows stay, a repeated start still answers the stored acceptance, and the next run's turn note leaves that run out.
   - A user's Stop during the copy, then another message. The run ends `cancelled` with its rows kept and the folder unchanged, and the next run's turn note leaves it out.
   - A copy stubbed to outlast a shortened section bound does not reset the object.
   - An R2 error during the copy is retried by the watch with new keys, and past a shortened copy bound ends the run `attachment_unavailable`.
   - `:298` (a reset after the preparation) stays, and `:355-418` (a cancel against each step) run again at the new txn2.

   The start's copy tests in `cloudflare/test/platform/files.test.ts` (`:165`, `:235`, `:271`, `:311`, `:341`, `:367`) move to the copy step. Its unit tests check that `planAttachments` gives the same refusals and byte totals as today's `prepareAttachments` for the same folder and uploads, with placeholder hashes, and that `inspectStaged`'s type equals `measureStaged`'s for the same object. `pnpm --dir contract openapi:check` stays green.
4. **The start in the request (app).** It builds:
   - `START_BOUND = 10`, `SEND_WITHIN = 8`, `sendFirst`, the delayed fallback, and `SendStart::attempt` with the new decision order;
   - `EngineClient::startRun($body, $within)`;
   - `expire($id, $due)`, `cancelAcknowledged`'s reason, and the release of uploads, with `uploads.released_from` and the failed message's `attachments`, on refusals and tombstones;
   - `ConversationController::cancel`'s inline `SendCancel::attempt(within: 3)`;
   - the docs in the app's turn.md, Starting a run (`docs/architecture/turn.md:58-77`), with the engine's rollback floor of unit 3, and in conversations.md's starting states.

   The queue stays `sync` in tests, and the inline paths use `Queue::fake()` and `Sleep::fake(syncWithCarbon: true)`. Under the sync queue the delayed fallback runs at its dispatch and takes the first faked answer, so the fixture queues the fake's answers for it (the app's `tests/Runs/Fixture.php:133-153`). Its Pest tests, in the app's `tests/Feature/Runs/StartTest.php`:
   - `:74` stays, a lost answer sent again byte for byte;
   - `:90` expires at 8 s, and a tombstone gives the new reason and releases the uploads;
   - `:110` and `:124` recover a lost acceptance and never expire it;
   - new, the inline try accepted inside `Runs::start` with only the fallback queued;
   - new, a 503 and then an acceptance within the window;
   - new, `EngineFake::noAnswer` giving the expire, the inline cancel and "Not sent";
   - new, a non-retryable error giving the expire;
   - new, a user's cancel during the inline try is sent inline, tombstones the start and reads "Not sent.";
   - new, a refusal, then a start with the same files: the failed message keeps its `attachments`, and the uploads' `released_from` is cleared.
5. **The user's states (app).** It builds:
   - the transcript's states, the `held` prop and `useRunStream`'s 10 s reload while it is set, and the `retry` payload;
   - `phaseOf` (the app's `resources/js/components/chat/model.ts:220-233`): a `provisioning` run shows the newest phase event after its latest status event, else "Starting the agent", and a restart still shows "Restarting the agent";
   - a failed user message's files with no version (`model.ts:271-274`);
   - the strings, and Send again with the adapter's `adopt`.

   Its tests are the app's `tests/Feature/Conversations/ChatTest.php:163` and `resources/js/components/chat/model.test.ts:257-338`:
   - "Sending", the held state's text, the reasons and the retry payload;
   - the rendered "Not sent: Minerva could not reach the agent in time." from the stored reason;
   - "Copying the attached files" for a `provisioning` run with that phase, then "Starting the agent" once the engine shows it as a phase when the section starts (`conversation.ts:585`);
   - a held page reloads, and shows Send again once the cancel lands, with the stream on and off;
   - after a refusal and Send again with the same files, a reload keeps the failed message's chips, and its retry payload has no uploads.

   The app's verify skill then shows the unanswered states in the browser, locally, where no engine runs.

## Live checks

One short round each, after the owner's go.

| Check | Where | Who |
|---|---|---|
| A start with 5 files of 50 MB into a new conversation is answered in under 3 s, the copy's phase shows in the engine's stream, and the folder lists the files. A start with 10 files of 50 MB is refused `FOLDER_FULL` in under 3 s. A staged object deleted right after acceptance ends the run `attachment_unavailable` | The test instance | The agent |
| `php artisan schedule:list` shows only `0 */3 * * *`, `0 0 * * *` and `0 3 * * *`. A job dispatched with a 15 s delay while the queue is at zero runs between 15 and about 20 s after its dispatch | Staging, after unit 2 | The agent, through Laravel Cloud's commands |
| The next day, Cloud's hibernation timeline shows sleep between wakes, and the database reports under 1 compute-unit hour a day. If an environment stays awake, the engine's logs name any conversation whose delivery is failing or stopped | Staging, and production once its scheduler is on | The owner, or the agent with the owner's go |
| `minerva:turn` with no file and with a 20 MB file, once after an idle hour with the queue at zero. `answered_at` minus `created_at` is under 3 s | Staging, after unit 4 | The agent |
| A start with a 20 MB file shows "Copying the attached files" on the app's page, then "Starting the agent" | Staging, after unit 5 | The agent |
| No "deferred work failed" for a copy in the engine's logs | Staging's engine | The agent |

## Risks

- **Deferred work as long as a copy (guess).** A Durable Object keeps deferred work alive under `ctx.waitUntil` (`conversation.ts:1614-1620`) for the copy's length. The loop already relies on this. If the work is cut short, the watch restarts it within 20 s.
- **A delayed job on a Flex queue at zero.** Cloud documents per-job delays of up to 15 minutes on standard queues, and delivers jobs itself by long-polling each queue; a Flex queue at zero picks one up within a second (Cloud's queues docs, Queue types and How jobs are processed, read 2026-10-24). FIFO queues take no delay, but staging's queue is `default`, a standard one, since Cloud names every FIFO queue `.fifo` (the app's `AGENTS.md:103`). If the fallback still ran late, the backstop is the bound for a request that died. The second live check measures it.
- **The POST holds a PHP worker** for 0.3 to 3 s per message, and up to about 11 s while the engine cannot be reached (inferred). Cloud's environment timeout must be at least 15 s, set and deployed before unit 4.
- **A task still running when the sleep timeout passes.** Cloud keeps a woken environment up for the sleep timeout and asks that scheduled tasks finish inside it (Cloud's compute docs, Scheduled tasks and queues, read 2026-10-24). The App cluster then stops, even mid-process (Cloud's workers docs). The backstop runs first and retention last, so while the others take under 2 minutes a pass cut short is retention's, and the next pass finishes it. `minerva:connections:describe` and the billing sync have no budget and start again at their first row (Accepted, not fixed). The locks expire within 30 or 60 minutes.
- **The first request after a sleep waits for the app to wake.** Cloud documents under 500 ms on its new Flex sizes and 5 to 20 s on legacy ones (Cloud's compute docs, Scale-to-Zero, read 2026-10-24). Both environments' App clusters run `flex-512mb` (`cloud instance:list`, 2026-10-24). Production, whose replica count had been 0 for the six hours before, answered its first request to `/up` in 0.94 s and the next two in 0.07 s, so this size wakes as a new one does (measured once, 2026-10-24). On a legacy size the first Send after a sleep would outlast the 10 s, so a later change of size must keep a new one. The wait also hits a user's first page, and the engine's first fact delivery or lease of a run. Fact delivery retries; a lease asked during a cold start may fail once.
- **A non-retryable obligation keeps the database waking (inferred).** A misconfiguration is retried every 15 minutes for a day, and so are the held fallbacks of the starts it caught, so the database wakes every 15 minutes until the operator fixes it. Each failure is logged as an error. An exception a job does not catch is retried every 30 s for a day, the last step of `$backoff` (the app's `vendor/laravel/framework/src/Illuminate/Queue/Worker.php:876-885`), and keeps the database awake for as long as the bug lasts.

## Accepted, not fixed

- **The request dies after its commit and the fallback's push failed too.** Two failures at once. The message shows "Sending" until the backstop expires the start, up to 3 hours and twenty minutes later, and Stop works.
- **The engine stores a start just after the request's 8 s window.** It needs an engine try of over about 7 s, against 1 to 3 s measured. The inline cancel stops the run, the page shows the `start_expired` failure, Send again gives the text back, and the files stay taken.
- **A staged object vanishes, or changes size or type, between acceptance and the copy.** It needs an upload at its 24-hour edge, or the user's own browser putting it again within its 15-minute URL. The run ends `attachment_unavailable` instead of being refused, and the user attaches the file again. A replacement of the same size and type is copied as it then is, and only the user's own browser can make one.
- **`WORKSPACE_FULL` after acceptance.** The deployed engine has no byte counter yet (`cloudflare/src/files/folder.ts:14-15`, `:28`), so the copy never meets it, and Laravel's storage gate is the cap meanwhile (the app's `app/Runs/Runs.php:133-135`). Once a counter is wired, a large file sent into a nearly full workspace passes Laravel's gate and ends its run `workspace_full` after the page has shown it starting.
- **R2 is down after acceptance.** An outage that breaks the folder anyway. The run shows the copy's phase for up to 10 minutes, then ends `attachment_unavailable`, and Stop works throughout.
- **A cancel between the copy's commit and `startAttempt`** fails a message whose files the folder holds. It needs a cancel within the milliseconds between two writes, as between today's acceptance and `startAttempt`, or within the 20 s before the watch restarts an object reset between them. The user attaches the files again, and the folder keeps a copy that no message names.
- **An object that restarts onto the previous engine version during a copy,** in the minutes after unit 3's deploy while two versions run side by side (ARCHITECTURE.md, Versions), runs that run's section without its attachments, since old code ignores `run_attachments`. It needs a restart within a copy's seconds during those minutes. The run answers without the files its prompt names, and the user attaches them again. A rollback stops every run first (Deploy order and rollback).
- **A cancel whose push was lost** waits up to 3 hours and twenty minutes for the backstop. A push runs at its transaction's commit, before any inline try (the app's `app/Runs/Runs.php:428`), so one that throws also skips the inline try that follows it, in `Revocations::await` or a user's Stop. `CancelNarrowed` has no inline try, and its retry finds the narrowing cleared. So one failure is enough, and a push throws only when the queue's SendMessage fails. A job the queue loses after its push needs the inline try to fail too. Laravel lends the run nothing meanwhile, and the engine's acknowledgement stays the enforcement point. A push that throws among `Deletions::dispatch`'s first 100 also skips the others and `DrainDeletions`, and the backstop then sends 1,000 a pass.
- **A lost acceptance whose recovering jobs were lost too** keeps `answered_at` null until the backstop. Two failures. A later message with files in that conversation is refused "Wait for the agent to finish." for up to 3 hours and twenty minutes.
- **Between units 2 and 4, the backstop runs every 3 hours with the 300 s bound and the first try still on the queue.** It needs a lost start dispatch in that window. That start then waits up to 3 hours and twenty minutes before it reads "Not sent.", instead of 5 to 10 minutes.
- **Runs registered before unit 4's deploy and still unanswered** are expired by the new 10 s bound at their next `SendStart`. Only at that deploy, and only for a start in flight.
- **A cancel during the copy does not stop it,** since the run is checked only before the copy and at its commit, as today (`conversation.ts:478-486`). The measure and every transfer run to the end, then nothing is committed.
- **Released uploads count toward the member's 30 waiting** until a start takes them or a day passes. It needs a member who sends files several times while the engine cannot be reached and attaches new ones instead of pressing Send again. They are refused "Send or remove some attached files first." until Send again gives the files back to remove.
- **An emergency stop that closes admission at a `sendFirst` try's boundary, before its `requestCancels` reaches that run's conversation,** gives the run a `start_expired` cancel instead of `emergency_stop`. It needs that boundary to land in the milliseconds the stop takes to reach the conversation, during an operator's stop. The run is still cancelled before any lease. Only its texts differ: "Not sent: Minerva could not reach the agent in time." instead of "Not sent.", or a failed run instead of "Stopped.", and Send again is refused until admission opens.
- **A slow connect to the engine, then a hanging Worker.** The connect and the wait for headers are each bounded by `within`, so the redirect can come about 20 s after Send instead of 11. It needs a connect to Cloudflare's edge taking seconds, followed by an engine that does not answer, for both the start and its cancel in one request. The message still ends "Not sent" with Send again.
- **A queue push that throws in the request while the engine cannot be reached.** Two failures at once. `expire`'s `SendCancel` push runs at its commit, before the inline cancel (the app's `app/Runs/Runs.php:428`), so a throw skips the inline try and the POST answers 500. The run stays held, "Not sent yet: Minerva cannot reach the agent. You can send it again once it can.", until the backstop sends the cancel, up to 3 hours and twenty minutes.
- **The daily walks outgrow a wake.** `minerva:connections:describe` and the billing sync at 00:00 have no budget, and each starts again at its first row. With more live connections or customers than a wake's 5 minutes cover, or an engine answering slowly, the same tail is cut each night until they get a budget and a cursor. With the pilots' few connections and organizations they take seconds (inferred).
- **R2 slow at a reservation.** The 5 s budget is checked between deletions, and one delete may take 10 s (the app's `app/Files/Bucket.php:77`). So a reservation waits about 15 s once, when R2 answers slowly and the member's removed uploads past half an hour would refuse it.
- **A reset between the copy's commit and the deferred deletion of the staged objects.** A crash at one instruction, as today after the answer. The staged objects stay in R2 until the bucket's day-long rule deletes them, which costs storage only.

## Owner questions

1. **The contract change.** You agreed to change the contract so the engine answers before it copies the files. This design answers `accepted` before the copy, a documented change in meaning plus two end codes for a failed copy, and adds no third `received` answer, which would need a second message carrying the final answer. That is none of v1's additive kinds, so contract.md's Versions gains a sentence on such an approved change, deployed receiving side first (The contract). Answered: this is the change meant.
2. **The environment timeout.** The POST now waits for the engine for up to about 11 s when the engine cannot be reached, so Laravel Cloud's environment timeout on staging and production must be at least 15 s, set and deployed before unit 4. Answered: 15 s. Staging's is set to 15 s, and unit 1's deploy applies it. Production's is read in the dashboard before its deploy, since Cloud's CLI can neither read nor set it, and raised to 15 s if it is lower. A higher value stays, since lowering it would cut off any other request that runs long.
3. **The sleep timeout and retention's budget.** Laravel Cloud allows 1 to 60 minutes. Shorter is cheaper, but the first click after a sleep waits for the app to wake. Both environments run `flex-512mb`, which woke production in 0.94 s, not a legacy size's 5 to 20 s (Risks). Answered: staging's sleep timeout at 5 minutes, and retention's pass at 3 minutes.
4. **Production's scheduler and sleep timeout.** The scheduler is off today, so production has no backstop, no retention purge and no billing sync. With wakes 3 hours apart, production sleeps between them at any sleep timeout Cloud allows. Answered: the scheduler goes on with the same schedule and a 5-minute sleep timeout, as staging's, once production is deployed, which it is not yet (Deploy order, step 4). Cloud's CLI sets both.
5. **How often the backstop runs.** Hourly keeps staging awake about 10% of the day and every 3 hours about 3% (inferred), but a lost cancel dispatch can then wait up to 3 hours. Answered: every 3 hours. Retention moves to the same wake, since an hourly retention would keep the hourly wake.
6. **Billing's `--due` sync, once billing is on.** Every 3 hours, in the backstop's wake, instead of every five minutes, so a subscription that ended loses its seats within 3 hours when Stripe's webhook is lost. Hourly would bring back an hourly wake. This changes the app's billing.md (`:193`, `:209`) and `SyncBillingTest`. Answered: every 3 hours.
7. **Send again.** It can put the text and files back in the composer to be edited first, through a new `adopt` on the upload adapter (What the user sees), or resend in one click and hide the failed message. Answered: back in the composer.
8. **The bounds.** 10 s for a message to reach the engine, with 8 s of tries from the request, and 10 minutes before a copy that keeps hitting R2 errors fails its run. Answered: as proposed.
9. **A copy's failure after acceptance.** A file that vanishes after acceptance, or a full workspace found while copying, shows as "Not sent: <reason>" on a run that had already started provisioning, not as a refusal. So does a Stop during the copy, as "Not sent: Stopped.", and its files must be attached again. Answered: acceptable.
10. **Anything else that calls staging.** An uptime monitor or another health check would keep it awake. So does the engine while a conversation's fact delivery fails. It tries again at most every 5 minutes, the sleep timeout itself (`cloudflare/src/conversation/facts.ts:22-37`), and a delivery stopped for the operator adds an hourly wake at its own minute (`cloudflare/src/conversation/delivery.ts:151-171`). Both are logged as errors ("fact delivery failed", "fact delivery stopped for the operator"), and both end once the operator fixes the delivery. Answered: nothing else is known to call staging, and the third live check shows it.

## How this design was chosen

Four readers mapped the engine's start, Laravel's start, Laravel's jobs and sweep, and the platform (the app's Laravel 13.36.0 and Laravel Cloud's docs, read 2026-10-24). Three designs followed.

- **Two-phase answer.** A third outcome, `received`, before the copy, with the final answer recovered by later tries.
- **Accept, then fail.** `accepted` before the copy, the stored preparation retired, a HEAD and a ranged GET per object, and the bound enforced from the conversation's page.
- **Stage before start.** `accepted` before the copy with the preparation kept, and the first try deferred until after the response.

A judge scored the three against the code and chose stage before start as the base. This design is its synthesis, with these grafts.

- **From accept, then fail:** the first try inline in the POST, after the commit and outside every lock, instead of in `defer()`.
- **From two-phase answer:** the delayed fallback dispatched before the inline try, so a request that dies after its commit still has it.
- **From two-phase answer:** "Not sent" derived from a pending `start_expired` cancel, so the failure shows before the engine acknowledges, and the reload slowed to 10 s in that state.
- **From accept, then fail:** a reservation that deletes the member's own removed uploads first, so "half an hour" stays true with no timer.
- **From accept, then fail:** retention's 3-minute budget, with the backstop first in the :00 wake.
- **From accept, then fail:** a folder that moved, or a claim that failed, at the copy's commit ends the run instead of throwing into a retry loop.
- **From two-phase answer and accept, then fail:** `SendStart`'s bound only for a run with no cancel, which closes the gap at the app's `app/Jobs/SendStart.php:58-62` and `app/Runs/Runs.php:410-414`.
- **From two-phase answer:** an obligation that meets a non-retryable error released, not ended. The judge chose 900 s over 300 s, so the database can suspend in between.
- **From all three:** `$backoff` on every engine job, `CancelNarrowed` retried for a day, a self-chaining drain for large deletions, `withoutInterruptionPolling()`, billing registered only while on, and short overlap expiries.
- **From accept, then fail and stage before start:** the backstop skips runs whose cancel is unacknowledged, instead of stamping `start_tried_at` on holds.
- **The judge's own:** a distinct placeholder hash per new entry when planning, and a byte check over the parent's sizes and the declared sizes, since `parseManifest` requires a valid SHA-256 (`cloudflare/src/files/manifest.ts:164`) and today's byte check maps sizes by hash (`cloudflare/src/files/store.ts:618-620`).
- **The judge's own:** a second sniff at the copy, ending the run when the type differs from the accepted one, and R2 errors retried by the watch for 10 minutes, under the loose keys' one-hour sweep.

## Alternatives rejected

- **A third `startRun` outcome, `received`, behind an opt-in `receipt` input.** It needs the input kept out of the digest, `received_at`, a change to the lease gate, and a channel for the final answer, either a poll that resends the whole body on a queue that can take minutes to start a worker, or a new fact. Refusals can still come after the receipt. It is heavier than answering `accepted` before the copy, for no gain a user sees.
- **A new `run.attached` fact for the copied attachments.** It must be deployed to Laravel first, and it carries what `run.finished`'s open code and the acceptance already carry.
- **Staging uploads into the engine's folder as they are uploaded.** A new chat has no conversation yet. Loose copies are swept after an hour while uploads live a day, so the start would still need a copy path. It also needs a new callback from the browser.
- **A 10 s bound alone, with the copy left before the answer.** It would cancel every start whose files take more than a few seconds to copy.
- **The first try in `defer()` after the response.** Cloud does not document whether FPM work survives after the response or a scale-down. The inline try is testable, covers `minerva:turn`, and lands the page on a running run.
- **`dispatchAfterResponse`, or the deferred and background queue drivers.** They run on the sync connection, where `release()` does nothing, so `SendStart`'s retries would be lost.
- **Expiring starts from `ConversationController::show`.** It puts side effects on a GET. The request, the delayed fallback and the backstop already enforce the bound.
- **Retiring the stored preparation.** A large engine deletion with no gain a user sees. Keeping txn1 keeps the change small.
- **A HEAD and a ranged GET with etag preconditions.** It changes the `Bucket` port. One get with the body cancelled gives the same size and head checks, and a replacement after the inspection is caught by the copy's size check or second sniff when its size or type changed. R2's SHA-256 check catches one made between the copy's measure and its put.
- **Removing `SendStart`'s hold and dispatching it again on the cancel's acknowledgement.** It changes the emergency stop's ordering for no gain. Skipping held runs in the backstop already ends the duplicate jobs.
- **Ending the run on the first double R2 failure during the copy.** It retries less than today, where Laravel retries the whole start. The watch's retry for 10 minutes keeps today's retries.
- **Stamping `start_tried_at` on holds.** Skipping runs with an unacknowledged cancel in the backstop gives the same result with one condition in a query.
- **Delayed `DeleteRemovedUpload` jobs in two 15-minute hops.** They add two jobs per removal, where deleting at the member's reservation that their count would refuse keeps "half an hour" with none.
- **Keeping a run stopped during its copy as a sent message whose files are dropped.** The turn note would quote it without its files, its prompt would be stored without them, and its terminal fact's `folder.base` would be null or Laravel's history would drop the files. Failing the message, as a stop before acceptance does today, gives the user Send again and needs only `runs.started_at`.
- **Changing the removed uploads' text to "Try again in an hour."** Deleting at the reservation keeps today's promise.
- **A Valkey or KV cache store so the scheduler leaves Postgres alone.** `withoutInterruptionPolling()` removes the per-minute read without a new Cloud resource.
- **Keeping `billing:sync --due` every five minutes.** Cloud reads `schedule:list` and does not evaluate `when()`, so it keeps any environment awake. It is registered only while billing is on, and every 3 hours (owner question 6).
- **A `CompleteStop` job for an emergency stop that died partway.** The operator watches the admin page and can stop again, and the backstop completes it. A new job is not worth its code for a crash at one instruction.

## Amendments after the review

Four reviewers, one per lens (protocol, contract, ops and ux), and opencode reviewed this design on 2026-10-24. Each line is one change made from a finding that held. Where several findings named one defect, they share a line.

- **protocol, contract, ux and opencode:** a run that ends before its copy commits, by any end, is left out of the turn note while its `run_attachments` rows remain, and Laravel fails its message when it took uploads and had no `running` fact (`runs.started_at`), instead of only for the two copy codes. Its chips are names. A Stop during the copy reads "Not sent: Stopped.". Quoting such a run without its files was rejected (Alternatives rejected).
- **protocol and ux:** an emergency stop that meets a `sendFirst` try's boundary before its cancel reaches the conversation is recorded under Accepted, not fixed.
- **protocol, ux and opencode:** an `ended` acknowledgement is told apart from `cancelled`, and a sent message whose run ended `start_expired` before it ran gets a `retry` payload with its text, so the Send again the late acceptance promises exists.
- **contract and opencode:** the deploy order puts units 1 and 2 on the app's staging before `minerva-cf-staging` gets unit 3, and units 4 and 5 on the app's `main` only once it runs unit 3. The app's production deploys `main`'s head and is not being deployed yet, so `minerva-cf` gets unit 3 just before it (owner question 4).
- **contract and ux:** unit 5 changes `phaseOf`, so "Copying the attached files" shows on the app's page, and a live check on staging's page proves it.
- **contract:** the engine's rollback floor of unit 3 goes into cloudflare/README.md's Deploy and the app's turn.md.
- **contract:** two engine versions side by side after unit 3's deploy are recorded under Accepted, not fixed, in place of the rollback line.
- **contract:** The contract says the meaning of `accepted` changes, an owner-approved exception deployed receiving side first, and contract.md's Versions gains a sentence on it.
- **contract:** ARCHITECTURE.md's Testing rows, and the app's doc and comments that describe the acceptance, join the units' doc lists.
- **ops:** retention is registered last, after the daily tasks, and the Risks cite Cloud's documented rule that a wake lasts the sleep timeout.
- **ops:** production's sleep timeout is set under 60 minutes, in owner question 4, deploy step 4 and the third live check.
- **ops:** Cloud's settings take effect at a redeploy, and the environment timeout is set and deployed before unit 4.
- **ops:** `within` bounds the connect and the wait for headers apiece, `created_at` is stored to the second, and a slow connect is recorded under Accepted, not fixed.
- **ops:** the fallback holds 900 s at a time once its cancel is past `OVERDUE`, and the Risks give the real cadence of holds and uncaught exceptions.
- **ops:** the engine's fact-delivery retries are named in owner question 10 and in the third live check.
- **ops:** both environments must run a new Flex size. A later pass measured production's wake on `flex-512mb` at 0.94 s, so the Risks and owner question 3 record it and the deploy steps no longer check it.
- **ops:** a reservation deletes removed uploads only when their count would refuse it, and the removed objects' lifetime of up to a day is stated.
- **ops:** delayed jobs are documented for standard queues, the second live check asserts the 15 s lower bound, and the rejected delayed-job alternative is corrected.
- **ops:** unit 2's billing test loads `routes/console.php` again against a fresh `Schedule`.
- **ops:** `DrainDeletions` dispatches `SendDeletion` and sends nothing itself.
- **ux:** a Stop during the request is sent inline by `ConversationController::cancel`, and a held run covers any unacknowledged cancel.
- **ux:** the held state's text says why, and the doc says when it lasts.
- **ux and opencode:** a new `held` prop drives its own 10 s reload, with Send disabled and the input usable.
- **ux:** Send again is new code, the adapter's `adopt`.
- **ux:** a tombstone stores the reason alone, "Sending" has no ellipsis, and the strings go through `__()`.
- **ux:** t counts from the POST, after the browser's uploads, and a reservation's wait is stated.
- **opencode:** a queue push that throws while the engine cannot be reached is recorded under Accepted, not fixed.
- **opencode:** a lost cancel push is one failure, since a push runs at its commit before any inline try, and the Accepted line says so.
- **opencode:** a rollback stops all agents first, and the old rollback line is replaced.
- **opencode:** the daily walks that outgrow a wake are recorded under Accepted, not fixed.
- **opencode:** a same-size, same-type replacement is copied as it is, in Accepted, not fixed and the rejected HEAD alternative.
- **opencode:** a retry after a thrown R2 error records new keys, and unit 3 corrects `prepareAttachments`' comment.
- **opencode:** a failed message keeps its `attachments`, and `released_from` serves only the retry payload.
- **opencode:** a slow R2 at a reservation is recorded under Accepted, not fixed.
- **opencode:** the first live check uses 5 files of 50 MB, and 10 of them expect `FOLDER_FULL`.
- **opencode:** the `WORKSPACE_FULL` line says the deployed engine has no byte counter yet.
- **opencode:** a reset before the staged objects' deferred deletion is recorded under Accepted, not fixed.

## Verification

This document was checked against the code at the two heads above, by opening each file and line it cites, the app's `vendor/` included. Laravel Cloud's behaviour comes from its docs, read on 2026-10-24. The measured facts are the owner's figures of 2026-10-24 and staging's start times; they were not measured again here. The citations the review added come from its findings, each checked by the reviewer that raised it, and this pass opened a sample of them again. Apart from reading both environments' settings with Cloud's CLI and timing three requests to production's `/up`, nothing was run against an account, and nothing was deployed.
