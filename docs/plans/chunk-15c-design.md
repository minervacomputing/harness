# Chunk 15c design: make a restore of Laravel safe

Status: proposed, 2026-10-17. This design settles the choices that chunk 15c of [remaining-chunks.md](remaining-chunks.md) leaves open, as trimmed on 2026-10-16: Durable Objects are never rolled back, conversations created after the restore point keep only their usage, the restriction log covers only what Laravel alone holds, and conversation deletions come back from the engine's listing. It splits the work into units that one fresh agent each can finish, and lists what waits for the owner. opencode reviewed it, and the findings that held are folded in (Amendments after opencode's review). Line numbers are at `ed13751` (harness) and at `ef42a56` on the main of `minervacomputing/app` ("the app" below), which holds 15b's unit 1 (the audit log) and not yet its units 2 and 3.

## The rule in brief

- **Backups.** Point-in-time recovery with 7 days of history on both of Laravel Cloud's clusters, the restore window. A restore makes a new cluster, and the environment is moved onto it.
- **The restriction log.** Every audit event that `AuditLog::removesAccess` answers true for is also written, before the change commits, as one object in an R2 bucket of its own, whose lock refuses an overwrite or a delete for 30 days. The object holds ids, not names. A restore applies every object written since a day before its point that the restored audit log does not hold.
- **Sign-in credentials fail closed.** A password reset or changed, a passkey removed and an admin's removal of two factors are logged too. Applying one voids the account's sign-in credentials, so its user resets the password by email.
- **The listing.** One new engine command, `listConversations`, pages through the whole recovery index by id. Laravel compares each row with what it holds: it deletes again what the engine has deleted, records the usage of what it does not hold, and replays what it lacks.
- **Lost runs keep their usage.** A conversation Laravel does not hold gets a tombstone, so its facts take the existing tombstone path (accounting only, no user). A run a held conversation does not hold is recorded as lost by the recovery, and its facts are kept and accounted, its transcript dropped.
- **Restore mode.** One environment variable, `MINERVA_RESTORING`, answers 503 to every request but the health check and reads admission closed. It fences the old database before the restore and the restored one until it is reconciled.
- **One command.** `minerva:recover` runs a recovery, recorded in a `restores` row: it applies the restrictions, ends every session, marks OAuth credentials uncertain, reconciles the conversations, purges what is overdue and checks that every affected run is accounted for. It exits 0 only when nothing is left, which serving and reopening wait for.

## What the code does today

| Claim | What the code does |
|---|---|
| No backups | Both of Laravel Cloud's Serverless Postgres clusters report `retention_days: 0` (read with `cloud database-cluster:list` on 2026-10-17; [data-processing.md](../data-processing.md), Backups and the restore window). |
| The audit log | `AuditLog::record` inserts one `audit_events` row in the change's own transaction (the app's `app/Audit/AuditLog.php:33`). `removesAccess(action, data)` (`:54`) answers true for `member.removed`, `member.left`, a lowered `member.role_changed`, `connection.revoked`, `admin.revoked`, `user.signed_out`, `invitation.revoked`, and the deletions of an account, a workspace and an organization. `user.two_factor_removed` and the admission's events are not among them (retention.md, The audit log). |
| Removing two factors | An instance admin removes them "for an owner who lost their authenticator, or after a password reset, one someone else put their own authenticator on" (`app/Admin/AdminActions.php:21`): the secret, the recovery codes and every session. The password stays. |
| Sign-in credentials | Passwords, two factors and passkeys are all enabled (`config/fortify.php:163`). A password reset is `App\Actions\Fortify\ResetUserPassword`. None of these changes is audited. |
| A member's removal | `Members::detach` deletes the membership, requests the cancel of the member's runs, revokes their connections in the organization with cause `member_removed`, and records `member.removed` or `member.left` (`app/Organizations/Members.php:104`). Each revocation records its own `connection.revoked` (`app/Runs/Revocations.php:158`). |
| A conversation's deletion | `Deletions::mark` sets `deleted_at` and the tombstone's to now and dispatches `SendDeletion` after the commit (`app/Conversations/Deletions.php:82`). The engine learns of it only when that job or the sweep reaches it. |
| Late facts | `Facts::deliver` takes the tombstone's path when Laravel holds no conversation row (`app/Runs/Facts.php:46`, `:81`): a `deleted_conversations` row with the delivery's scope is enough. Accounting facts are recorded with a null user, the transcript is dropped, and the tombstone's `facts_held` is the watermark; a null one takes a batch as it comes (`:94`). With no tombstone either, the delivery is `NOT_FOUND` (`:90`). |
| A run Laravel does not hold | The live path refuses a fact whose run its conversation does not hold with `NOT_FOUND` (`Facts.php:156`), and `conversation_facts.run_id` references `runs` (`database/migrations/2026_10_14_140000_create_runs_tables.php:179`). |
| Accounting tables | `usage_records`, `run_settlements` and `write_records` carry their organization, workspace, conversation and a nullable user, and have no foreign key (`database/migrations/2026_10_19_100000_create_usage_tables.php`). |
| `minerva:usage` | Checks the runs created since `--since` that the engine accepted, and runs known only from their records (`app/Console/Commands/CheckUsage.php:69`, `:74`). A run with no settlement and no end passes as `running` (`:121`). So it cannot see a run created before the point whose settlement came after it, nor a run that left no row at all. |
| `refresh_uncertain` | Set today only after a failed refresh (`app/Connections/Credentials.php:133`). A lease refreshes an uncertain OAuth connection before lending it; one with no refresh token becomes `error` and asks to be reconnected (the app's `docs/plans/connections.md:98`). The refresh token lives inside the encrypted `secret`. |
| Sessions | The database driver (`config/session.php:21`). A session is signed out when its epoch differs from its user's (`app/Http/Middleware/EnsureSessionEpoch.php:30`); `SessionEpoch::end` raises the epoch and replaces the remember token. |
| Maintenance mode | The `file` driver (`config/app.php:122`): state on one instance's disk, which a deploy to new instances does not carry. |
| Admission | `Admission::shared` and `open` read the one row (`app/Runs/Admission.php:34`, `:40`). `SendStart` holds a start while admission is closed and its run has no cancel, or while its cancel is unacknowledged; once the cancel is acknowledged `cancelled` or `ended` it sends the start again, which the engine answers from its stored answer (`app/Jobs/SendStart.php:51`). |
| User ids | `users.id` is an integer sequence (`database/migrations/0001_01_01_000000_create_users_table.php:15`), which a restore rewinds. Everything else Laravel names is a UUIDv7. |
| The recovery index | D1 `recovery_conversations`: `id` (the primary key), `organization_id`, `workspace_id`, `jurisdiction`, `created_at`, `fact_seq`, `deleted_at`, `purged_at` (`cloudflare/migrations/0010` to `0014`). No index besides the primary key. `fact_seq` is raised before any fact up to it is sent to Laravel (`cloudflare/src/conversation/delivery.ts:116`), so every fact Laravel was ever sent is at or below it. |
| Replay | `replayFacts` reads the index, refuses `FACTS_PRUNED` with the floor for an `after` below `floor − 1`, and answers a purged conversation from the index (`cloudflare/src/internal/runs.ts:52`). Pages are at most 500 facts (`MAX_FACTS`). Laravel's `EngineClient` has no `replayFacts` operation yet (`app/Engine/EngineClient.php:27`). |
| Delivery after a gap | A `FACT_GAP` whose watermark is at or above `floor − 1` lowers `acknowledged` and delivers again from it (`delivery.ts:137`). So a conversation with facts still to deliver heals by itself once Laravel answers; one whose facts were all acknowledged is never delivered again. |

## Decisions

### Backups

**What Laravel Cloud offers.** Serverless Postgres (Neon) keeps a continuous log for 0 to 30 days, set per cluster, on every plan, and restores any point inside it ([data-processing.md](../data-processing.md), Backups and the restore window, which also records that the plan is probably Starter, unconfirmed). A restore never overwrites the cluster: it makes a new one at the chosen time ([create a database restore](https://laravel.com/cloud/docs/api/database-restores/create-a-database-restore); `cloud database-restore:create <cluster> <name> --point-in-time=<ISO 8601>`), which the environment is then attached to.

**What this design sets.** 7 days on staging's and production's clusters, the owner's restore window. A longer window buys nothing: the engine keeps facts 7 days after their acknowledgement, so it cannot reconcile an older point (chunk-15a-design.md, Risks). The owner sets it (`cloud database-cluster:update <cluster> --retention-days=7`, then reads it back with `cloud database-cluster:list`): staging now, before the rehearsal; production before the gate. The history starts when it is set.

**What a restore changes on Laravel Cloud.** The restored cluster has a new endpoint. AGENTS.md sets `DB_HOST` to the endpoint's `neon.tech` name by hand, so the runbook sets it again, attaches the new database and deploys. The restored cluster's own retention is read back and set to 7 days, since nothing says it is copied. The old cluster stays until the owner deletes it; it holds data deleted since the point, so the runbook deletes it once the recovery is complete.

### The earliest point

`minerva:recover` refuses a point that is any of:

- **older than 6 days** (owner question 3), so the recovery has a day before the engine prunes facts acknowledged after the point;
- **before the restriction log's start** on the environment, since a removal before it was never logged. The start is the oldest object under `probes/` in the bucket, written by unit 2's first `minerva:restrictions:check`; once that is 30 days old the lifecycle deletes it, and the 6 days are the tighter bound;
- **before the last restore's fence**, read from the restored database's `restores` table (`minerva:recover`, below).

### The key

A restored database is useless without the keys its rows were encrypted with: `MINERVA_CREDENTIALS_KEY` for credentials and registered clients' secrets, and `APP_KEY` for two-factor secrets and sessions. Both of production's are backed up outside Laravel Cloud by the owner, and the place recorded (not the value), as staging's credentials key is under Arm the program. A key rotated after the point must still be among the previous keys (`MINERVA_CREDENTIALS_PREVIOUS_KEYS`, `APP_PREVIOUS_KEYS`) when the restored database is served; the runbook checks it.

### The restriction log

**What is logged: exactly the events `AuditLog::removesAccess` answers true for**, with the changes below in unit 2. The rule stays in one function, so the audit log and the restriction log cannot drift. Its meaning becomes "a restore must apply this event again on its own".

| Event | Logged | What applying it does to the restored database |
|---|---|---|
| `member.removed`, `member.left` | Yes | The membership deleted, the member's runs' cancels requested, their connections in the organization revoked (`Members::detach`'s steps, with no actor checks) |
| `member.role_changed`, role lowered | Yes | The role set to the event's `to`, only when the restored role is above it |
| `connection.revoked`, cause `removed` | Yes | `Revocations::revoke`, cause `removed` |
| `connection.revoked`, any other cause | **No** (change) | Its cause names its parent change (`member_removed`, `account_deleted`, `workspace_deleted`, `organization_deleted`), whose restriction revokes it again. An organization's deletion is then one write, not one per connection |
| `connection.reconnected` with `narrowed: true` | **Yes** (change) | The connection revoked: the restored row holds the earlier, wider credential, which a provider may still honour. Its user connects again |
| `invitation.revoked` | Yes | The invitation revoked, if still pending |
| `admin.revoked` | Yes | `is_admin` false |
| `user.signed_out` | Yes | `SessionEpoch::end` (the recovery ends every session anyway) |
| `user.two_factor_removed` | **Yes** (change) | The account's sign-in credentials voided (below) |
| `user.credentials_changed` (**new**): a password reset or changed, a passkey removed | **Yes** (change) | The account's sign-in credentials voided |
| `account.deleted` | Yes | The account's deletion again, without its refusals; if a step cannot run, the account is closed instead (below) |
| `workspace.deleted`, `organization.deleted` | Yes | The deletion again (15b's locked deletion), with the restriction's time as its deletion time |
| `admission.stopped` | **No** | The runbook closes admission itself |

**Voiding sign-in credentials.** The password is replaced by a random one, every passkey is deleted, two factors and recovery codes are cleared, and every session ends. The user signs in again only through a password reset by email (or a sign-in provider), and enrols their second factor again. This only ever takes a way in away, so it keeps the log's rule: one applied where its change never committed, or one forged, locks a user out until they reset their password, and lets no one in.

**Why sign-in credentials are logged at all (the two calls 15b left).** A restore brings back the password hash, the passkeys and the second factor of the point. An admin removes two factors to take an authenticator away from someone (`AdminActions.php:21`), usually around a password reset; clearing the restored factor alone would leave the restored password, which may be the one that leaked, enough to sign in. Voiding everything closes both. A user's own reset or change of password and removal of a passkey are the same case without an admin, so they are logged as `user.credentials_changed` (owner question 4). A credential added after the point is lost by the restore, which at worst locks its user out. `user.two_factor_removed` keeps its own action, since the admin's removal is already recorded under it.

**`admission.stopped` is not logged.** The runbook closes admission before the restore, closes it again in the restored database before any request, and reopens it only as its last step, by the operator's decision. A logged stop would close what is already closed. What the operator must know is whether a stop for another reason was in force, which the runbook's first step records from the old database's audit log, or from Laravel Cloud's logs ("An admin stopped all agents") when the old database is gone.

**Not covered**, as the trim decided: grant edits and layer restrictions, an agent's connections removed, and an invitation replaced by a new one. Each comes back as it was at the point.

**The object.** One JSON object per restriction, written with `If-None-Match: *` (R2 answers 412 to a second write of the key, [S3 extensions](https://developers.cloudflare.com/r2/api/s3/extensions/)), under a key that sorts by time and is never reused:

```text
restrictions/2026-10-17T06:17:53.123Z_<restriction id, a UUIDv7>.json
{"version": 1, "id": "…", "at": "2026-10-17T06:17:53.123Z", "action": "member.removed",
 "organization": "…", "workspace": null, "subject": {"type": "user", "id": "42", "created": "2026-10-02T09:14:03.000Z"},
 "data": {"role": "admin", "runs": 0}}
```

It is the audit event's ids and data, less any free-text `reason`, and with no actor: the ids are what applying it needs, and nothing else is copied out of the database. A user is named by its id and its `created_at`, since a restore rewinds the users' sequence and a later sign-up can take an id a lost account had. Applying a restriction to a user whose `created_at` differs changes nothing and is reported.

**Written before the commit.** `AuditLog::record` gains an optional `restriction` id. When `removesAccess` is true and no id is given, it makes one, writes the object to R2, and then inserts the event with `data.restriction` set to the id, all inside the change's transaction. A write that fails throws, so the change rolls back and its user sees "This change could not be recorded. Try again." (owner question 1). One whose commit fails after the write leaves an object for a change that never happened, which is harmless by the rule that every restriction only takes access away. The write is a signed `PUT` through the app's own SigV4 signer (`App\Files\Presigner`, as `App\Files\Bucket` uses it), with a 2 s connect and 5 s total timeout. A change holds its locks across one write per logged event: one for most, and for an account's deletion one per organization it deletes and one for itself. In `local` and `testing` the log is a local disk; any other environment without the bucket's settings refuses the change, so a deployed environment never takes access away without logging it. Changes Fortify makes in its own controllers (a passkey removed) are logged from the event Fortify dispatches, which may come after its commit; unit 2 records which ones are written ahead and which right after.

**The bucket.** One per environment, in the engine's Cloudflare account and the EU jurisdiction, used by nothing else, so the staging rehearsal can never touch production's log:

- **The lock:** one rule for every object, `{"id": "restrictions", "enabled": true, "condition": {"type": "Age", "maxAgeSeconds": 2592000}}` (30 days), set with `cf r2 buckets locks update <bucket> --cf-r2-jurisdiction eu --rules @rules.json`. A lock refuses deleting or overwriting a matching object until it is 30 days old, and wins over lifecycle rules ([bucket locks](https://developers.cloudflare.com/r2/buckets/bucket-locks/)). 30 days is four restore windows: long enough for any restore the backups allow, short enough that ids do not pile up.
- **Lifecycle:** delete objects 30 days after they were written.
- **Credentials:** an R2 API token with object read and write on that bucket alone. The lock is what keeps those credentials, and anyone holding them, from rewriting the log; only an account admin can remove a lock rule.
- **Settings:** `MINERVA_RESTRICTIONS_BUCKET`, `MINERVA_RESTRICTIONS_ACCESS_KEY_ID`, `MINERVA_RESTRICTIONS_SECRET_ACCESS_KEY` (secrets), on the endpoint `MINERVA_R2_ENDPOINT` already names. AGENTS.md's table gains them.

**The proof.** `php artisan minerva:restrictions:check` writes a probe object under `probes/`, then writes the same key again without a condition and deletes it, and passes only when both are refused and a read gives back the probe's first bytes. It prints the status of each refusal and exits non-zero otherwise. It runs on staging once the bucket exists, and on production before the gate. The probe stays 30 days, which is what the lock is for, and the first one marks where the log starts (The earliest point).

**Applying them.** The recovery lists the bucket from the later of `P − 24 hours` and the last restore's fence (`start-after`, pages of 1,000 keys), reads each object, and skips every restriction whose id is in the restored `audit_events` (`data->>'restriction'`): that change committed before the point, and so did anything after it that gave access back. The day covers a change written before the point and committed after it, a clock that is off, and a process paused mid-transaction; Laravel Cloud's request and job timeouts are far shorter. The rest are applied in key order, each in its own transaction, by `App\Recovery\Restrictions`, one applier per action as in the table above. Each records its usual audit event as the console under the restriction's own id, so it writes no new object and a later pass skips it. A restriction whose subject is gone changes nothing and records nothing.

**No restriction is refused.** The appliers check no actor and keep no owner: a removal is applied even when it leaves an organization without an owner, which the report names for an instance admin. An account whose deletion cannot run (its organizations' state at the point refuses it, `app/Actions/DeleteAccount.php:66`) is **closed** instead: removed from every organization, its connections revoked, its sign-in credentials voided and its sessions ended, and reported so the operator finishes the deletion. So order does not matter, and every restriction is applied in one pass. A pass that throws leaves the recovery incomplete, and it is run again.

### The listing

**The command (additive).** `listConversations`, `POST /internal/v1/recovery/conversations`:

```ts
input:  { environment: Environment, after: Id.nullable(), limit: z.int().min(1).max(1000) }
output: { conversations: Array<{ conversation: Id, organization: Id, workspace: Id, factSeq: z.int().min(0),
                                 deletedAt: Time.nullable(), purgedAt: Time.nullable() }>, more: boolean }
```

It answers the index's rows in order of id after `after`, every row whatever its state, read with `SELECT … FROM recovery_conversations WHERE id > ?1 ORDER BY id LIMIT ?2`. It names no scope, as `catalog` does not: the engine serves one environment, and Laravel is its only caller. It is checked against the environment like `admission` (`namedEnvironment`, `cloudflare/src/internal/procedures.ts:27`).

**Laravel compares, the engine lists.** The box had Laravel send its watermark per conversation and the engine answer those above it. The conversations created after the point cannot be found that way, since Laravel cannot name them; the engine would have to know every conversation Laravel holds. Listing the whole index answers both at once, with no input pages and no state in the engine, and needs no index beyond the primary key, so none is added. It reads every row each time; at 100,000 conversations that is 100 pages of about 250 kB, once per recovery pass.

**What Laravel does with a row.** Its watermark is `conversations.facts_held`, else the tombstone's `facts_held` (null counts as 0).

| Laravel holds | The row says | Laravel does |
|---|---|---|
| A live conversation | `deletedAt` set | Deletes it again with the engine's `deletedAt` as its deletion time and its tombstone acknowledged then, so nothing is sent and 15b's purge keeps the original clock; then as below |
| A tombstone or deleted conversation whose deletion time is after `deletedAt` | | Moves its deletion time and acknowledgement back to `deletedAt` (the deletions the restrictions applied, above all) |
| The conversation or its tombstone, watermark `w` | `factSeq > w` | Replays from `w` |
| Neither | anything | **Lost**: a tombstone with the row's organization and workspace, `facts_held` 0 and `purged_at` set (nothing of it is here to purge), whose deletion the outbox sends unless `deletedAt` is set; then replays from 0 |
| The conversation under another organization or workspace | | Reports it, changes nothing |
| Anything else | | Nothing |

**Deploy order.** The engine first: it is the receiving side of a new command, and Laravel calls it only from `minerva:recover`. Then the app syncs the contract and calls it.

### Replay

For each conversation to replay, `App\Recovery\Conversations` calls `replayFacts` from the watermark, 500 at a time (unit 3 adds the operation to `EngineClient`), and gives each page to `Facts::deliver` as a delivery from the listing's scope, until `more` is false. A `FACT_GAP` (the engine's own delivery moved the watermark meanwhile) reads the watermark again and goes on. Three outcomes are unresolved items, never skipped in silence: `FACTS_PRUNED` with its floor, a `FACT_CONFLICT` or a stopped delivery (`minerva:facts:resume`), and `SCOPE_MISMATCH`. A tombstone with no watermark (from before chunk 14a kept one) that answers `FACTS_PRUNED` is reported apart as "no watermark", not as unresolved, since its facts were acknowledged long ago.

The engine's own delivery goes on beside it: a conversation with facts still to deliver gets `FACT_GAP` from the restored watermark and delivers again (`delivery.ts:137`). Both go through `Facts::deliver` under the conversation's lock, so each fact is applied once, whichever arrives first.

### Usage of what the restore lost

**Conversations Laravel does not hold** get the tombstone above, so their facts take the tombstone's path that `Facts.php:81` already has: `run.usage`, `run.unmetered`, `run.settled` and `run.write` go into `usage_records`, `run_settlements` and `write_records` with the tombstone's organization and workspace, the conversation's id, the fact's run and a null user; the transcript is dropped. With `facts_held` 0 the first fact must be 1, so a replay that starts later is a gap, not a silent loss. Budgets read settlements by organization, so this spend counts against the organization again before admission reopens. An organization the restore lost keeps the records under its id, with no row, as a deleted organization's do (retention.md, A late usage fact after the organization is gone).

**Runs a held conversation does not hold.** A conversation that existed at the point may have had turns after it. Today their facts are refused `NOT_FOUND` (`Facts.php:156`), so neither replay nor the engine's delivery could pass them, and the conversation's later facts would stop behind them. Unit 3 adds one table, `lost_runs` (`run_id` primary key, `conversation_id`, `restore_id`, `at`), and makes `conversation_facts.run_id` nullable:

- the recovery, before it hands a page to `Facts::deliver`, inserts a `lost_runs` row for every run the page names that a held conversation does not hold;
- the live path applies a fact of a run in `lost_runs` as the "gone" column of `Facts::applyFact`'s table: accounting only, with the conversation's organization, workspace and user (a conversation is its user's alone), and a `run.finished` still sets the conversation's `stored_bytes`;
- the fact is kept in `conversation_facts` with a null `run_id` (its run is in its text), so a repeat is compared with it exactly, as any other;
- a run in neither `runs` nor `lost_runs` is still refused `NOT_FOUND`, so the check against facts for runs Laravel never started stays.

A fact of a lost run that the engine writes after the recovery's pass (a settlement after the run's container ends) is refused until the next pass records the run, and the engine retries it; the recovery is complete only when no conversation is behind (`minerva:recover`, below). The transcript of those turns is lost, as any restore loses what came after its point.

### Credentials

The recovery marks every OAuth connection that is not revoked and whose credentials hold a refresh token `refresh_uncertain`, as `Credentials.php:133` sets it but with no failure, 1,000 a transaction. It must open each secret to see the refresh token; one without a refresh token is left alone, since marking it would make its next lease ask to be reconnected. API keys and built-in services are left as they are. Admission is closed meanwhile, so nothing leases or refreshes.

### Sessions

The recovery deletes every row of `sessions` and runs `SessionEpoch::end` for every user, so everyone signs in again. The restored `sessions` table holds sessions that were signed out after the point (a sign-out on a shared computer), which no restriction names. With the database driver, emptying the table ends every session, and a new remember token ends every remembered sign-in.

### Restore mode

While `MINERVA_RESTORING` is true (`config('minerva.restoring')`):

- a global middleware answers 503, "Minerva is being restored. Try again shortly.", to every request but Laravel's health route `/up`: the pages, Fortify's routes, the OAuth callbacks and the engine's `/internal/v1/` callbacks (facts, leases). The engine retries both;
- `Admission::shared` and `open` answer closed. A start is refused and a lease too; `SendStart` holds a start with no cancel or an unacknowledged one, and sends again only a start whose cancel the engine has acknowledged, which the engine answers from its stored answer or refuses; the sweep requests an `emergency_stop` cancel for every active run;
- artisan commands, the scheduler and queue workers run, so the outboxes keep draining.

It is an environment variable because Laravel's maintenance mode is a file on one instance (`config/app.php:122`), which a deploy to new instances does not carry, and its other driver would keep its flag in the database being restored. It is set twice: first on the old database, which fences every writer (pages, Fortify, the engine's callbacks) before the restore, and then with the attach, so the restored database is never served before it is reconciled.

### `minerva:recover`

`php artisan minerva:recover --point=<ISO 8601>` runs only while `MINERVA_RESTORING` is true, and refuses a point the earliest-point rules refuse. It keeps one row per recovery in a new table, `restores` (`id`, `point`, `fenced_at`, `started_at`, `done` jsonb, `completed_at`), so a second run of the command resumes the same recovery instead of starting another. `fenced_at` is when the old database was fenced (the runbook's step 3, passed as `--fenced=`, or the start when the old database is gone); a later restore lists restrictions from no earlier than it, since what came before was this recovery's.

| Step | Runs | Done when |
|---|---|---|
| `restrictions` | Every pass | Every restriction from the start of the list has been applied or is a no-op |
| `sessions` | Once per recovery | Recorded in `done` |
| `credentials` | Once per recovery | Recorded in `done` |
| `conversations` | Every pass | Every listed conversation's watermark is at least its `factSeq`, or it is reported apart; no unresolved item |
| `retention` | Every pass | `minerva:retention`'s pass has purged every deleted conversation already due, so restored copies of what was deleted long ago go now |
| `accounting` | Every pass | Every run Laravel holds or `lost_runs` names is ended; every one the engine accepted, created since 7 days before the point, that ended and had an allowance, has its settlement, and `minerva:usage` passes for them; no run is `starting` or `running` |

A pass runs the steps in that order and prints what is left: unresolved replays, organizations left without an owner, accounts closed instead of deleted, users whose `created_at` did not match, and runs still owed a settlement. It exits 0 only when every step is done, sets `completed_at`, and records one audit event, `database.restored`, with the point and the counts. A run still owed its settlement keeps the command non-zero until the settlement arrives (or the operator settles it with `minerva:usage --run=`), since the engine writes it once the run's container is gone.

### The runbook

`docs/runbooks/restore.md` in the app, written by unit 4. The steps:

1. **Choose the point P**, the last moment before the damage, in UTC, inside the earliest-point rules. Start the recovery clock.
2. **Close admission on the running app**: `minerva:stop --reason="restore"`, until it exits 0. Record whether a stop for another reason was in force (the audit log's last `admission.*` event, or Laravel Cloud's logs).
3. **Fence the old database**: set `MINERVA_RESTORING=true` and deploy. Wait until the deletions' and cancels' outboxes are empty (`minerva:recover --drain`, which sends each and exits 0 when none is left), and record the time as the fence. If the old database is gone, skip steps 2 and 3.
4. **Restore**: check that `MINERVA_CREDENTIALS_PREVIOUS_KEYS` and `APP_PREVIOUS_KEYS` hold any key rotated since P; `cloud database-restore:create <cluster> <name> --point-in-time=P`; set the new cluster's retention to 7 days and read it back; attach its database, set `DB_HOST` to its endpoint, and deploy with `MINERVA_RESTORING` still true. If the engine's Sanctum token was issued after P, issue it again (AGENTS.md, The engine).
5. **Close admission on the restored database**: `minerva:stop --reason="restore"`, which closes the restored row and cancels the runs it still calls active, until it exits 0.
6. **Reconcile**: `minerva:recover --point=P --fenced=<the fence>`, again until it exits 0. Resolve what it names: `minerva:facts:resume`, an owner for an organization, the deletion of a closed account.
7. **Serve**: set `MINERVA_RESTORING=false` and deploy. Everyone signs in again; users whose credentials were voided reset their password; starts are still refused.
8. **Reopen** with `minerva:stop --reopen`, unless step 2 found a stop that must stay. Stop the recovery clock: from step 2 to here is the recovery time.
9. **Afterwards**, the owner deletes the old cluster within a day, since it holds what users deleted since P.

It also says: Durable Objects are never restored to an earlier point. A broken Conversation object is repaired forward, or its conversation is deleted (remaining-chunks.md, Appendix B). Neither are R2's files, which no restore touches. And what the restore loses: everything users did after P that is not a restriction (messages, new connections, invitations, settings, sign-in credentials added), the transcripts of turns after P, and every queued job that names a row the restore removed, which finds nothing and ends.

## What 15d and 16 inherit

- **15d.** The backups are Laravel Cloud's (Neon's) in `eu-central-1`, kept 7 days once set; the restriction log is in R2's EU jurisdiction, ids only, kept 30 days.
- **16 (billing).** Usage recorded after a restore has a null user for lost conversations, and lost runs have no row. Billing resumes only once a recovery has completed. A lost organization's usage stays under an id with no row.

## Units

Each unit is for one fresh agent, in this order. A unit is done when its checks pass and it is committed to the main of its repository. Engine checks: `pnpm typecheck`, `pnpm test:unit` and `pnpm test:platform` in `cloudflare/`, and `pnpm typecheck` and `pnpm openapi:check` in `contract/`. App checks: `composer test`, `pnpm run check`, `pnpm run types:check` and `pnpm test`. 15b's units 2 and 3 come first, since applying a deletion again needs 15b's deletion path and the recovery runs its retention pass. opencode reviews the diffs of units 2, 3 and 4: unit 2 adds a network write to every removal's transaction, unit 3 changes how facts are applied, unit 4 applies removals without the actor's checks.

1. **The listing (harness: contract and engine).**
   - The contract's `listConversations` in `contract/src/internal/engine.ts`, `pnpm --dir contract openapi`, contract.md's command table.
   - `listIndexed` in `cloudflare/src/internal/recovery.ts` and its procedure, behind `inEnvironment`.
   - Docs: start-and-cancel.md (The recovery index: what the listing answers), ARCHITECTURE.md's recovery paragraph.
   - Platform tests through the Worker's route: pages in order of id with `more`, `after` at the last id answering the rest; a live, a deleted and a purged conversation with their times and `factSeq`; one bound only by `deleteConversation`; another environment refused `WRONG_ENVIRONMENT`; a `limit` of 0 and of 1,001 refused.
   - Deploy: `minerva-cf-test`, then after a green `account.yml`, staging and production with the owner's approval.
2. **The restriction log (app).** The owner's bucket, lock, lifecycle, token and staging's settings come first (What the owner does), or CI's staging deploy refuses every removal there.
   - `removesAccess`'s changes and `user.credentials_changed` with its call sites (the password reset and change, a passkey's removal); `AuditLog::record`'s `restriction` id; `App\Recovery\RestrictionLog` (`write`, `list(since)`, `read`) over the signer, the local disk in `local` and `testing`; the settings in `config/services.php` and AGENTS.md; `minerva:restrictions:check`.
   - Docs: retention.md (The audit log: what `removesAccess` now means, the new action), a Restrictions section in turn.md, accounts.md (credentials changes recorded).
   - Pest tests: each logged action writes one object with its ids, a user's `created_at` and no reason, before the commit; a child revocation writes none and its parent one; a failed write rolls the change back and records no event; a change rolled back after the write leaves the object; a second write of a key is refused; outside `local` and `testing`, missing settings refuse the change. `minerva:restrictions:check` against an HTTP fake that refuses, and one that does not, with its exit codes.
   - On staging: `minerva:restrictions:check` passes, its output recorded, and ten probe writes timed.
3. **The conversations (app).**
   - `composer contract:sync` from unit 1's commit; `EngineClient`'s `listConversations` and `replayFacts`; the migration (`lost_runs`, `restores`, `conversation_facts.run_id` nullable); `Facts`' branch for a lost run; `App\Recovery\Conversations` (list, compare, delete again with the engine's time, lost tombstones, lost runs, replay); `minerva:recover`'s `restores` row, its `conversations` step and its guard on `MINERVA_RESTORING` (the flag's config only).
   - Docs: turn.md (Applying a fact: the lost run's column; Recovery).
   - Pest tests with `EngineFake`: a live conversation the listing answers deleted is deleted again with the engine's time and nothing is sent; one Laravel does not hold gets its tombstone, its deletion sent, and its replayed `run.usage`, `run.unmetered`, `run.settled` and `run.write` recorded once each with the listing's organization and workspace and a null user; a held conversation with runs after the point records them in `lost_runs` and replays them as accounting with its user and its last `stored_bytes`, then applies a later run that Laravel holds; a repeat of a lost run's fact that differs is a conflict; a fact for a run in neither `runs` nor `lost_runs` is still `NOT_FOUND`; a replay applies each fact once while the engine's delivery sends the same facts; `FACTS_PRUNED`, `FACT_CONFLICT` and a scope mismatch are unresolved and change nothing; a second pass changes nothing.
4. **Restore mode, restrictions applied, and the runbook (app).**
   - The middleware and `Admission`'s reading of the flag; `App\Recovery\Restrictions` (one applier per action, closing an account); the earliest-point rules; the `restrictions`, `sessions`, `credentials`, `retention` and `accounting` steps; `--drain`; the report, the exit code and `database.restored`; `docs/runbooks/restore.md`; AGENTS.md (the flag, the command, the runbook) and turn.md.
   - Pest tests: with the flag, a page, a Fortify route, a facts delivery and a lease answer 503, `/up` answers, a start is refused, and `SendStart` holds a start with no cancel and sends one whose cancel was acknowledged `cancelled`. Restrictions logged after a point applied to a restored database: each action's change made, its event and object written, then the rows put back as a restore would and the event deleted; the step undoes each again, skips one whose id the audit log holds, applies one written a day before the point and committed after it, ignores one older than the last restore's fence, changes nothing for a user whose `created_at` differs, closes an account whose deletion would be refused, leaves an organization without an owner and names it, and changes nothing on a second pass. Voided credentials: the password no longer signs in, no passkey is left, two factors are cleared. Sessions and credentials run once per recovery: an OAuth connection with a refresh token is marked, one without is not, a revoked one and an API key are not. `accounting` stays non-zero for a run created before the point that ended after it with no settlement, and for a lost run behind in its facts. The command refuses a point older than 6 days, before the log's first probe and before the last fence, and runs only with the flag.
5. **The rehearsal and the boxes (app's staging, then harness).** After the owner's steps below, the rehearsal (Live checks), then remaining-chunks.md's 15c boxes with their evidence.

**Deploy order.** Unit 1's engine reaches staging before unit 3's app does, since unit 3's sync and the rehearsal need it. Unit 2's app reaches staging only after staging's bucket and settings exist. Production takes unit 1's engine, then the app's units 2 to 4 once production's bucket and settings exist, with the owner's approval. Nothing here changes a fact or an existing command, so the order among the app's units is theirs alone.

## What the owner does

On the account, each an "ask first" item in AGENTS.md:

- **Laravel Cloud:** 7 days of point-in-time history on staging's cluster now, and on production's before the gate (`cloud database-cluster:update <cluster> --retention-days=7`, read back with `cloud database-cluster:list`). Confirm the plan, and record both under Arm the program.
- **Cloudflare:** for staging now and production before the gate, an R2 bucket in the EU jurisdiction, its lock rule and lifecycle rule (above), and an R2 API token with object read and write on it alone. Unit 2's agent can prepare the exact `cf` commands with `--dry-run`.
- **Laravel Cloud's environments:** the three `MINERVA_RESTRICTIONS_*` settings, staging's before unit 2 is pushed.
- **Keys:** production's `MINERVA_CREDENTIALS_KEY` and `APP_KEY` backed up outside Laravel Cloud, with where recorded.
- **The rehearsal:** the go for it, setting `MINERVA_RESTORING`, the restore, the attach and the three deploys on staging, and deleting staging's old cluster afterwards.

## Live checks

| Check | Where | Who |
|---|---|---|
| `test:faults` passes, and the listing answers on `minerva-cf-test` | `minerva-cf-test`, `account.yml` | The agent |
| `minerva:restrictions:check` passes | The app's staging | The agent, once the bucket exists |
| **The rehearsal.** With the history on and unit 2's log started: note P, then run two turns in a conversation that existed at P, remove a member, remove two factors from a test user, revoke a connection, delete a conversation while the engine's deletion is held back (the sweep paused, `SendDeletion` not yet run), delete another normally, and start a new conversation with a turn; then follow the runbook to P. The member stays removed, the test user can sign in only after a password reset, the connection is revoked, both deleted conversations stay deleted (the held-back one through the drain), the new conversation's usage is recorded with a null user and its transcript is gone, the two turns are in `lost_runs` and their usage is recorded, `minerva:recover` exits 0, every fact after P is applied once (`usage_records` and `run_settlements` against the engine's facts for those conversations), and no turn executes while restoring (no `run.status` fact for a run created after step 2). Record each step's time | The app's staging and `minerva-cf-staging` | The agent with the owner, who does the account steps |
| **The lost old database**, the same scenario with steps 2 and 3 skipped: what the held-back deletion leaves, recorded as the case the drain cannot cover (Risks) | The app's staging | The agent with the owner, with the rehearsal |

## Perf probe and rule

**Metric.** The rehearsal's time from closing admission (step 2) to reopening it (step 8), recorded as the recovery time, with each step's share. Also recorded, not judged: the restriction write's time on staging (ten probe writes), since every logged removal now waits for it.

**Rule.** None, since there is no target. The owner sets one from the number, and checks that 6 days plus the recovery time stays under the facts' 7 days (owner question 3).

## Risks

- **A removal waits for R2.** Every logged change holds its locks across one R2 write per logged event, at most 5 s each when R2 is slow. R2 unreachable refuses every logged change (owner question 1).
- **A deletion the engine never received, with the old database lost.** A conversation deleted after the point whose `SendDeletion` had not reached the engine comes back live when the old database cannot be fenced and drained (steps 2 and 3). The window is how long the engine was unreachable. Logging conversation deletions as restrictions would close it, at a write per deletion, which the trim set aside (Appendix B).
- **What the log does not cover comes back**: grant edits, an agent's connections, a replaced invitation. The report cannot list them.
- **Forged restrictions.** Anyone with the bucket's credentials can add objects, which a restore applies. They can only take access away, a voided credential included, and the report lists every one applied.
- **Changes Fortify makes in its own controllers** are logged right after their commit, not before it (The restriction log). A restore to a point inside that moment loses the log of that change.
- **A point older than the facts.** A conversation whose facts were pruned past Laravel's watermark is unresolved, and the recovery cannot complete. The earliest-point rules and the measured recovery time keep this away; a slow recovery near the limit can still meet it.
- **Lost transcripts.** Conversations and turns after P are recorded as usage only. Rebuilding them stays the next step (Appendix B), possible only while the engine still holds their facts; the engine's copy of a lost conversation is deleted (owner question 2).
- **The whole index is listed** on each pass. At millions of conversations that is thousands of pages, still minutes; a filter would come then.
- **Restore mode refuses the engine's callbacks** while it lasts. Leases fail (no run is active), and facts wait in the engine, which is what they are for.

## Owner questions

1. **A restriction that cannot be written.** Default: the change is refused ("This change could not be recorded. Try again."), so no access is taken away without its restriction. R2 unreachable then blocks member removals, revocations, deletions and password resets; the emergency stop still works, since it is not logged. The alternative is to commit and log an error, which leaves that change unprotected against a restore.
2. **The engine's copy of a lost conversation.** Default: Laravel deletes it through the outbox, so the engine purges it 7 days later like any deleted conversation, and nothing outlives what Laravel can show. The alternative is to keep it, so a later chunk could rebuild its transcript, with no bound on how long the engine keeps a conversation no one can see.
3. **The oldest restore point.** Default: 6 days, a day under the facts' 7, if the rehearsal's recovery time is well under a day. The alternative is 15a's owner question 3: keep facts 8 days after acknowledgement and allow 7.
4. **Users' own credential changes.** Default: a password reset or change and a passkey's removal are logged (`user.credentials_changed`), so a restore voids that account's credentials and its user resets the password by email. The alternative is to log only the admin's removal of two factors, and accept that a restore brings back a user's earlier password and passkeys.

## Changes to remaining-chunks.md

Proposed for the owner to apply; this commit does not edit it. Arm the program's backup box already says what 15d found (`ed13751`) and needs nothing from here.

- Chunk 15c's heading paragraph links this design.
- Build, Backups: "Set 7 days of point-in-time history on staging's cluster for the rehearsal, and on production's before the gate (`cloud database-cluster:update <cluster> --retention-days=7`, read back). A restore makes a new cluster, which the environment is moved onto; the old one is deleted once the recovery is complete. `minerva:recover` refuses a point older than 6 days, before the restriction log's start, or before the last restore's fence."
- Build, The key: "Production's `MINERVA_CREDENTIALS_KEY` and `APP_KEY` are backed up outside Laravel Cloud, as staging's credentials key is under Arm the program, since a restored database is useless without them. Record where (not the value)."
- Build, The restriction log: "Before Laravel commits a change `AuditLog::removesAccess` names (a member's removal or lowered role, a connection's revocation or narrowed reconnection, an invitation's revocation, an admin's removal, a sign-out, two factors removed, a password reset or changed, a passkey removed, and the deletion of an account, a workspace or an organization), it writes one object of ids to a bucket of its own in R2, with `If-None-Match: *`, under a key never reused; the bucket's lock refuses an overwrite and a delete for 30 days, proved by `minerva:restrictions:check`. A failed write refuses the change. A restore applies every restriction written since a day before its point that the restored audit log does not hold, without the actor's checks; a changed sign-in credential voids the account's credentials. Each only takes access away, so one whose change never committed is harmless, and their order does not matter. Conversation deletions and the emergency stop are not logged: the listing answers the first, and the runbook fences the old database and closes admission itself."
- Build, The recovery listing: "A new command, `listConversations`, pages through the whole recovery index by id: each conversation's organization, workspace, `fact_seq`, `deleted_at` and `purged_at`. Laravel compares each row with what it holds: it deletes again, with the engine's deletion time, a conversation the engine has deleted, replays one whose `fact_seq` is above its watermark, and records the usage of one it does not hold. No index is needed beyond the primary key. The engine deploys first."
- Build, Replay: "Laravel calls `replayFacts` from its watermark for each conversation it must replay and applies the pages through `Facts::deliver`. `FACTS_PRUNED`, a conflict and a scope mismatch keep the recovery incomplete for the operator, never silently skipped."
- Build, Usage of what the restore lost: "A conversation Laravel does not hold gets a tombstone with the listing's organization and workspace, so its replayed facts take the tombstone's path into `usage_records`, `run_settlements` and `write_records` with a null user; its transcript is lost and the engine's copy is deleted. A run a held conversation does not hold is recorded in `lost_runs`, and its facts are kept and accounted with the conversation's user, instead of being refused."
- Build, Credentials: "A restore marks every OAuth connection whose credentials hold a refresh token `refresh_uncertain` (set today only after a failed refresh), and ends every session."
- Build, the runbook box: "A runbook in the app's docs (`docs/runbooks/restore.md`) that orders the steps: close admission, fence the old database in restore mode (`MINERVA_RESTORING`) and drain its outboxes, restore, close admission again, `minerva:recover` until it exits 0 (apply the restrictions, end sessions, mark credentials, list, delete again, replay, record the lost conversations' and runs' usage, purge what is overdue, check every affected run is settled), serve, reopen admission, delete the old cluster."
- Verify, unit: "Engine platform tests for the listing: pages, deleted and purged conversations, one bound only by its deletion. Laravel's tests apply restrictions logged after a point to a restored database, void a changed credential, delete again a conversation the listing answers as deleted, record the usage of a conversation it does not hold and of a held conversation's lost runs, keep the recovery incomplete while a run is owed its settlement, and refuse every request in restore mode."
- Verify, live: the rehearsal adds "remove two factors from a test user, revoke a connection, delete a conversation whose engine deletion is held back, and run two turns in a conversation that existed at the point", and shows "the test user signs in only after a reset, the connection stays revoked, the held-back deletion stays deleted, the two turns' usage is recorded, and `minerva:recover` exits 0"; and the same with the old database treated as lost, recorded.
- Appendix A, Unproven: "the bucket lock (15c)" moves to evidence once `minerva:restrictions:check` passes on staging.
- Appendix B gains: "**Laravel sending its watermarks for the listing** (15c). The engine would answer only the conversations above them, but could not find those Laravel does not name without knowing every one it holds. The engine lists its whole index instead, and Laravel compares." And: "**Logging the emergency stop as a restriction** (15c). The runbook closes admission before and after the restore and reopens it last, so a logged stop would add nothing."
- Appendix C, the restore risk gains: "and of a held conversation's turns after its point, whose transcripts are lost too", and a new risk: "**A deletion the engine never received** comes back live when the old database is lost before its outbox drained (15c)."

## Amendments after opencode's review

opencode (`plan` agent) reviewed the first draft on 2026-10-17 against the harness and the app's working tree, which held 15b's unit 2 uncommitted. Each finding was checked in the code. `git status` afterwards showed no change by it in either repository.

1. **A deletion the engine never received comes back (accepted in part).** `Deletions::mark` sends the deletion after the commit (`Deletions.php:82`), so a restore while the engine had not answered loses it. The runbook now fences the old database in restore mode and drains the deletions' and cancels' outboxes (`--drain`) before the restore, and the rehearsal holds one deletion back to prove it. With the old database lost, the gap remains, recorded as a risk with its alternative (logging deletions), which the trim set aside; the rehearsal records that case too.
2. **Clearing two factors does not only take access away (accepted).** Cleared alone, it leaves a restored password, perhaps the leaked one, enough to sign in, and a forged object could downgrade an account; passkeys are on too (`config/fortify.php:163`). Applying it now voids every sign-in credential, which only locks out, and a user's own password reset or change and passkey removal are logged as `user.credentials_changed` (owner question 4).
3. **`minerva:usage --since=P` cannot certify the recovery (accepted).** It skips runs created before the point, runs with no row and no record, and passes `running` ones (`CheckUsage.php:69`, `:121`). The `accounting` step now checks every run Laravel holds or `lost_runs` names, created since 7 days before the point, for an end and a settlement, and the command exits 0 only then.
4. **A point before the log started was accepted (accepted).** The history can start before unit 2 deploys. The command now refuses a point before the bucket's first probe, and before the last restore's fence.
5. **A refused restriction was only reported (accepted).** The appliers now check no actor and keep no owner; an account whose deletion cannot run is closed instead (memberships, connections, credentials, sessions), and anything left keeps the command non-zero, which serving waits for.
6. **No fence on the old database (accepted).** Admission closed refuses only starts and leases. The runbook now sets restore mode on the old database first, which refuses every writer, drains the outboxes, and records the fence. The draft's "`SendStart` holds" was too broad: it sends again a start whose cancel is acknowledged (`SendStart.php:51`), which the engine answers from its stored answer; the text and the test say so.
7. **Accepting every unknown run weakened validation (accepted).** Lost runs are now recorded by the recovery in `lost_runs`; only those are applied as accounting, their facts kept with a null `run_id` for exact repeats, and any other unknown run is still `NOT_FOUND`.
8. **"Run again until nothing is left" had no end (accepted).** A `restores` row now makes reruns one recovery: sessions and credentials run once, the other steps to their done conditions, `database.restored` is recorded once at completion. With no actor checks, the restrictions no longer depend on their order.
9. **User ids are reused across timelines (accepted).** A restore rewinds the users' sequence. A restriction now names a user with its `created_at` too, and the list starts no earlier than the last restore's fence.
10. **The recovery restarted deletion clocks (accepted).** Deleting again now uses the engine's `deletedAt`, acknowledged then, and a later deletion time on a tombstone is moved back to it; the recovery runs 15b's retention pass, so restored copies already due are purged before serving.
11. **Smaller corrections (accepted).** The lock bound is one write per logged event, an account's deletion one per organization and one for itself. The lookback is a day, for paused processes and clocks. Unit 3 adds `replayFacts` to `EngineClient`. The rehearsal's "no index row" check was wrong, since a cancel of a run the engine never received binds one (`recovery.ts:52`); it now checks that no turn executes.

## Amendments after opencode's review of unit 1

opencode (`plan` agent) reviewed unit 1's diff on 2026-10-17 and found nothing to fix. It tried one suspected bypass, a `listConversations` with `scope.environment` set to this engine's beside another `environment`: oRPC strips the unknown `scope` before `inEnvironment` reads the input, and the route answers 409 `WRONG_ENVIRONMENT`. `git status` afterwards showed no change by it.

1. **The pages are not one snapshot (set aside).** A row inserted behind the cursor while Laravel pages is not in that pass, and a `fact_seq` raised behind it is read as it was. In restore mode a row is inserted only by a command the restored Laravel sends, a cancel or a deletion, for a conversation it holds, so it misses nothing Laravel lacks; a raised `fact_seq` comes with a delivery, which heals through `FACT_GAP` (`delivery.ts:137`), and the `conversations` step runs on every pass. A snapshot would need state in the engine, which the listing avoids.

## Amendments after opencode's review of unit 3

opencode (`plan` agent) reviewed unit 3's diff (`c760643..b5c594c` in the app) on 2026-10-17; `git status` afterwards showed no change by it. It found no fact applied twice, no usage lost or counted twice, no scope leak and no deletion that comes back. Its one finding:

1. **A stopped delivery that held every fact passed (accepted).** The step skipped a conversation whose watermark was at its `factSeq` without looking at `facts_stopped_at`, so a conflict could complete the recovery and stay hidden. A conversation whose rows are here and whose delivery is stopped is now unresolved (`conflict`) on every pass, with a test for the watermark caught up (`779cd2a`).

Choices the design left open, as built:

- Deleting again requests no cancel and records no audit event: the engine's deletion cancelled the runs, the runbook's `minerva:stop` cancels what the restored database still calls active, and the step's counts (deleted again, lost, replayed) are for `database.restored`.
- A run is recorded lost only when no `runs` row holds it, in any conversation; a run held under another conversation stays `NOT_FOUND`. `lost_runs` has no foreign key to its conversation, so the record outlives the purge, and one to `restores`.
- A conflict found by the replay stops the conversation's delivery, as any conflict does; the operator resumes it with `minerva:facts:resume`.
- A `FACT_GAP` that does not move the watermark, and a replay that ends below `factSeq`, are unresolved as `behind`; a page for another conversation, or a listing that says more follow after no row, is an `EngineUnavailable`.
- The replay's answer is checked whole against `engine-v1.json`, its facts decoded as objects, as the facts route checks a delivery.
- At most one recovery is in progress (a unique partial index on `restores`). `minerva:recover` sets `completed_at` once every step it runs is done; unit 4 adds the other steps and `database.restored`.
