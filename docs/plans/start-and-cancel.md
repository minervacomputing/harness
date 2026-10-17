# Chunk 6: the engine's start and cancel

Status: built 2026-10-14. opencode reviewed the design, and its findings are folded in (a durable preparation, so a start compiles once across resets; the index's writes conditional on the scope; no shared start markers; the deletion check in the final transaction; no fallback refusal for an error that is not one). It then reviewed the diff: a refused command could still bind a conversation the index had not seen when its run belonged to another (the conversation's insert is now conditional on the run), and an attachment refusal could be stored over a cancel committed while the copy ran (the refusal is now decided in the transaction that stores it); the tests it found missing (a cancel during the copy itself, two starts at once, a preparation surviving a reset) were added. Chunk 6 of [product-and-engine.md](product-and-engine.md): `startRun` and `cancelRun` of the internal API ([contract.md](contract.md)), next to the public API's paths, which stay as they are until chunk 13.

## What it builds

- **`startRun`.** The recovery index's rows are written first. The Conversation object is bound to its organization and workspace. The history is selected and clipped by `history.ts`, the snapshot is compiled once, the attachments are copied from staging, and the start is accepted or refused.
- **`cancelRun`.** The durable fence on a stored run, and the tombstone for a run the engine has not received yet.

Leases (`leaseToken`), facts and the stream token are chunk 7. Until then a run Laravel starts runs its turn with no connection's credentials: a connector tool's lease is refused (below).

## Two kinds of conversation

A Conversation object now answers to one of two registries:

- **The Workspace object** (the public API's): its conversations are made by `init`, its runs registered by `beginRun`, its cancels sent from the Workspace's outbox. Unchanged.
- **Laravel** (the internal API's): its conversations are bound by the first command that names them, carry an organization, and have no Workspace object behind them.

The conversation row gains `organization_id` (migration 7): null for the Workspace's, set for Laravel's. Neither kind becomes the other:
- The public API never reaches Laravel's conversations, since it finds conversations through the Workspace's index.
- Laravel's conversations are its own UUIDv7s, in the EU jurisdiction. A command that reaches an object the Workspace made (an EU workspace's conversation with the same id) is `SCOPE_MISMATCH`, since that row has no organization. One in another jurisdiction is another object, so the two kinds are apart by construction, not by a check across registries.

A Laravel conversation's `user_id` and `agent_id` are empty: each run's snapshot names its own user and agent.

**Where the Workspace was asked, a Laravel conversation answers itself.** Three things the object asks the Workspace today go to `laravelRuns` (`conversation/laravel-runs.ts`) instead, chosen in one place, `#workspace()`:

| The Workspace's | Laravel's, in this chunk |
|---|---|
| `activate`: is the run still registered? | Always active: a run is admitted by `startRun` itself, and a cancel reaches the object directly |
| `release`: the run ended | Nothing: Laravel learns of an end from the run's terminal fact (chunk 7) |
| `conversationTouched`: the index's title and time | Nothing |
| `lease`, `markUnauthorized` | Refused (`PROVIDER_UNAVAILABLE`, "This connection is not available to the agent yet."), and nothing marked, until chunk 7 asks Laravel |

The folder's byte counter (the Workspace's `setConversationBytes`) answers ok for a Laravel conversation: storage is counted against allowances in chunk 14.

So once a run is stored, its activation, the watch job, the gate, the loop and its end run as they do today. What is new is how a run gets stored (the start) and the cancel. The public start's markers (`starts`), which the watch and the object's recovery send to the Workspace's `beginRun`, are never written for a Laravel conversation.

**Expiry.** The Workspace expires a start not activated within ten minutes. A Laravel start has no such clock in the engine: Laravel's bound is a `cancelRun` with `start_expired`, and the object orders it against the start. If the start committed first, the run is stopped; if the cancel did, the start is refused. A lost acceptance followed by that cancel therefore leaves a run that may have begun and is stopped, never one that begins after the cancel was acknowledged.

## The recovery index

D1 migration `0010_recovery_index.sql`:

```sql
CREATE TABLE recovery_conversations (
	id TEXT PRIMARY KEY,
	organization_id TEXT NOT NULL,
	workspace_id TEXT NOT NULL,
	jurisdiction TEXT CHECK (jurisdiction IS NULL OR jurisdiction = 'eu'),
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE recovery_runs (
	id TEXT PRIMARY KEY,
	conversation_id TEXT NOT NULL REFERENCES recovery_conversations (id),
	-- SHA-256 of startRun's input as canonical JSON; null while only a cancel has named the run.
	input_digest TEXT,
	created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX recovery_runs_conversation ON recovery_runs (conversation_id);
```

- **Binding.** The first command that names a conversation inserts its row, with the scope it named; every later command must name the same organization and workspace, or it is `SCOPE_MISMATCH` before any object is reached. The first command that names a run binds it to its conversation the same way, `cancelRun` included, so a cancel can never fence a run in one conversation while it runs in another: a command naming the run under another conversation is `SCOPE_MISMATCH`.
- **Idempotency.** `startRun` records its input's digest on the run's row (set once, by the first start). A start whose digest differs is `IDEMPOTENCY_CONFLICT`. The answer itself is kept by the Conversation object, so a repeat gets the same answer and nothing is compiled twice.
- **A refused command changes nothing.** Every write after the conversation's insert is conditional on the scope, in SQL: a run is inserted only through a conversation row with the named organization and workspace, and its digest is set only while it is null and the run's conversation and that conversation's scope match. So a command refused `SCOPE_MISMATCH` cannot bind a run or set a digest that a correct command would then conflict with. `SCOPE_MISMATCH` is checked before `IDEMPOTENCY_CONFLICT`.
- **Addressing.** The object is reached through the row's jurisdiction, never the command's (addressing.ts). Laravel's conversations are created in the EU jurisdiction (`INTERNAL_JURISDICTION`, Decisions 11); a row keeps the jurisdiction it was created with.
- **What later chunks add:** the highest fact sequence per conversation, raised before a batch is delivered (chunk 7, `0011`); the deletion's time (chunk 12, `0012`); and the purge's (chunk 15a, `0014_purged_conversations.sql`, `purged_at`), set by the object's retention before it deletes its blobs and its storage ([chunk-15a-design.md](chunk-15a-design.md), Physical deletion). `purged_at` is the sentinel that refuses a delayed command, since `destroy()` deletes the object's storage and a command arriving after it would otherwise bind an empty object again. For a purged conversation the Worker answers from the index and never reaches the object: `startRun` is refused `CONVERSATION_DELETED`, `cancelRun` answers `ended`, `deleteConversation` `deleted`, and `replayFacts` an empty page from `fact_seq` or `FACTS_PRUNED` below it. `bindRun` may still insert a new run id's row first, which is harmless.
- **The listing** (chunk 15c, [chunk-15c-design.md](chunk-15c-design.md), The listing). `listConversations` answers every row in order of id after the one Laravel names, at most 1,000 a page: its organization, workspace, `fact_seq`, `deleted_at` and `purged_at`, whatever its state, a conversation bound only by its deletion included. After a restore Laravel compares each with what it holds. It reads by the primary key alone, so no other index is added.

The rows are written and read back in one D1 batch, before the object is called. So no run executes without its row, and a run row exists for every run an object stored. The rows are kept for good, deleted and purged conversations' included (chunk-15a-design.md, owner question 2).

## `startRun`

In the Worker (`internal/runs.ts`): the environment (the mount's middleware), then the index (above), then the object's `startInternal(command)`. The command is passed whole; the object answers either the outcome or `SCOPE_MISMATCH`.

In the object, one start per run id at a time (a repeat while one is in flight in this instance joins it). Every change below is made outside pi's transactions (store.ts `outside`), so it commits on its own and a rollback of pi's cannot undo it.

1. **The binding.** The conversation row is made on first use with the scope's organization, workspace and jurisdiction; a row with others, or one the Workspace made, is `SCOPE_MISMATCH`.
2. **A stored answer** for the run id is answered again as it is, whatever happened to the conversation since. (The index guarantees the input is the same.)
3. **Refusals before any work,** each stored as the run's answer (and the run's preparation, if any, deleted with it):
   - a tombstone for the run: `CANCELLED`;
   - the conversation deleted: `CONVERSATION_DELETED`;
   - another run active, or another run's preparation: `CONVERSATION_BUSY` (Laravel holds the conversation's lock, so this is a bug or a run the engine has not ended yet);
   - no text and no attachment: `EMPTY_MESSAGE`, as the public API refuses it;
   - the attachments' own checks: more than `MINERVA_FILES_MESSAGE_ATTACHMENTS` (`TOO_MANY_ATTACHMENTS`), the same upload twice (`ATTACHED_TWICE`), an upload key outside the workspace's staging prefix (`ATTACHMENT_UNAVAILABLE`, logged: a bug in Laravel).
4. **The preparation**, written once in the same step: the compiled start snapshot (below), the catalog's and the compiler's versions, and the selected history, in `internal_starts` (parts, like `run_snapshots`). A start sent again after a reset or a failure finds it and uses it, so its instructions, deadline, versions and digest are those of the first try: it compiles once. A preparation also makes the conversation busy for any other run until the start is answered or cancelled. Nothing resumes a preparation by itself: Laravel sends the start again until it is answered, and past its bound cancels it, which deletes the preparation.
5. **The attachments** (below), measured and copied before the transaction, as today's start copies.
6. **One transaction:** a tombstone that arrived meanwhile makes it `CANCELLED`, a deletion `CONVERSATION_DELETED`, another active run `CONVERSATION_BUSY`, each stored. Otherwise the attachments are committed into a base version; the prompt is the message with its attachment note naming them as the folder now holds them; the run is stored `queued` with its snapshot and turn, its `queued` event appended and its watch and deadline jobs pushed; the acceptance is stored as the run's answer, and the preparation deleted.
7. **Then** the run is activated and its loop starts, as for the Workspace's runs (the activation answers at once). The staging objects are deleted; R2's lifecycle rule on `uploads/` deletes any left after a day.

**Errors are not refusals.** Anything else that fails (R2, the object reset mid-start, a folder that changed while its copies were made) stores no answer and answers 500 or 503; the preparation stays, and Laravel sends the start again. Copies a failed try made are found again by the next (the folder records their keys under the run first) or swept. Unlike the public start, no error becomes a stored `START_FAILED`: a stored refusal is final, so only the outcomes above are stored, and an acceptance, once committed, is never replaced.

**The compile.** `startSnapshot` (gateway/tools.ts) as `beginRun` calls it today, from the command instead of the Workspace's rows:

- **Connections:** the agent's, each `{id, provider, ownerId, status, createdAt, scopes}`. A connection is usable as today: active, and shared or the run's user's.
- **Layers:** each layer's grants become `GrantRow`s of that layer (`subject` the user or the agent); a missing layer is null, with today's defaults (the ceiling passes everything, a user allows nothing until they choose, an agent inherits).
- **Providers:** `providerOf` knows the agent's connections only. An allow on any other connection could never be used by this run, so dropping it changes nothing.
- **Each connection once.** The contract refuses an authority whose connections repeat an id (422), since a repeat would be counted twice by `toolsFor` and once by the provider lookup. Repeated grants are harmless: the policy is a union of allows and denies.
- **The answer:** `catalog` is the registry's catalog version (computed once per registry); `compiler` is `COMPILER_VERSION` in gateway/tools.ts, raised whenever a change to the compile (grants.ts, policy.ts, tools.ts) changes what a snapshot allows; `digest` is 64 hex of SHA-256 over the canonical JSON of the start snapshot, which holds the policy, the tools and the instructions but not the history or the prompt; `authorized` is the snapshot's `connectionIds`, the connections its tools reach.

**The history and the prompt.** The command's history becomes `StoredMessage`s (its `run`, `createdAt` and `changes` as they are) and goes through `historyOf` and `recentHistory` when the preparation is written; the prompt is the message with its attachment note (`withFiles`), made in the final transaction, once the attachments' folder paths are known. Both are stored in the run's snapshot as `turn: {history, prompt}`, and the loop reads them from there instead of the object's messages, which a Laravel conversation does not keep. A turn is seeded from them once, when its pi session is created, as today.

**The attachments.** Each is `{upload, name, size, mediaType}`, where `upload` is the R2 staging key that Laravel signed (chunk 12): `uploads/<workspace>/<random>` in the conversation's bucket (`FILES_EU`), so the bucket's existing rule on `uploads/` expires it.

- **Measured, never trusted.** The object's size is read first (`head`): a missing object, a size that differs from the declared one, or one over `MINERVA_FILES_UPLOAD_BYTES` is `ATTACHMENT_UNAVAILABLE` before any byte is read. Then the engine reads it once, counting its bytes and hashing them (`crypto.DigestStream`) and keeping the first 8 KiB to sniff its media type, as the upload route does; a count that differs from the size is `ATTACHMENT_UNAVAILABLE` too. At most four are read at once.
- **Then copied by the folder,** as today's reserved uploads are (`prepareAttachments`): one blob per contents the conversation does not hold, put with its SHA-256, which R2 checks, so an object replaced since it was measured fails the copy (`ATTACHMENT_UNAVAILABLE`). The names are cleaned (`cleanName`, as the upload route does) before the folder numbers them against its root, and the folder's limits apply (`FOLDER_FULL`).
- **The cost:** each attachment is read twice (once to measure, once to copy), at most ten files of 50 MB per start. Chunk 12 can have Laravel's signed upload carry its SHA-256, which R2 then stores, and skip the first read.

## `cancelRun`

In the Worker: the environment, the conversation's and the run's binding in the index (made here if this is the first command naming them), then the object's `cancelInternal(command)`. A conversation the index has deleted is deleted in its object first, as for `startRun`, so a cancel that read the index before a purge's mark makes the object again only as a deleted conversation, which purges itself after its window; a purged one answers `ended` from the index.

In the object, after the same binding check:

- **A stored run** that is active is revoked and ended in one transaction, as the Workspace's cancel does: the revoked flag is the fence every provider request checks immediately before it is sent (`admits`, with no await between the check and the send). It answers `cancelled`. A write already sent is not undone: it settles and is recorded.
- **A stored run that has ended** answers `cancelled` if a cancel ended it (its revoked flag is set), else `ended`. Its end, and so the first reason's code, is set once.
- **No run:** a tombstone is written with the reason, and the run's preparation, if any, is deleted with it; it answers `tombstoned`. A start in flight finds the tombstone in its final transaction and is refused `CANCELLED`; a later start is refused at step 3. A tombstone keeps its first reason.

Each answer is returned only after its change has committed, outside pi's transactions, so a rollback of pi's cannot undo an acknowledged cancel.

**Reasons.** The engine's `CancelReason` gains the contract's `member_removed`, `conversation_deleted` and `start_expired`. `member_removed` ends a run as a revocation does ("Stopped because permissions changed."), `conversation_deleted` as a plain cancel ("Stopped."), and `start_expired` as today's expired start (failed, "The agent could not finish this run. Try again.").

## Tests

**Unit:** the compile: connections and layers mapped, the authorized set, a stable digest, the history clipped and selected and the prompt with its note.

**Platform**, through the internal mount with an assertion, as chunk 5's tests do, and with a fake model:

- An accepted start: its answer; the index's rows; the turn completes with the history and prompt the model saw.
- Idempotency: a repeat gets the same answer and compiles nothing; a different input is `IDEMPOTENCY_CONFLICT`; the same run under another conversation, and a conversation under another organization or workspace, are `SCOPE_MISMATCH`, and a refused command leaves the index as it was (a correct start afterwards is accepted).
- A start that fails after its preparation (a copy failing) answers an error and stores nothing; sent again, it is accepted with the first try's snapshot (the same digest and instructions).
- Refusals: busy, cancelled (tombstoned first), empty, and each attachment refusal; each stored and answered again.
- Attachments: copied into the folder under their cleaned names, measured rather than trusted, the staging objects deleted.
- Cancel: of an active run (the fence set, the turn stopped), of an ended one, of a run not received (tombstoned, then its start refused), of a run named under another conversation; a cancel that arrives while the start copies its attachments, which makes the start `CANCELLED`; and a cancel while a pi transaction is open, which waits for it and stays committed.
- A lost acceptance followed by a cancel: the start sent again answers the same acceptance, and the run stays stopped.
- The public API's paths still pass their suites unchanged.

## Out of scope

- `leaseToken`, `reportUnauthorized`, the outbox of facts, `replayFacts` and the stream token (chunk 7).
- `ADMISSION_CLOSED`, which needs the emergency stop (chunk 14).
- `deleteConversation` (chunk 12), and the staging uploads' signing on Laravel's side (chunk 12).
- Tests left out: an upload over the size limit before its bytes are read (the limit cannot be lowered in the platform tests; the unit of it is one comparison), and a command whose text holds a lone surrogate, which the digest's encoding refuses with a 500 rather than a 422.
