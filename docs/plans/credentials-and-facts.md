# Chunk 7: the engine's credentials and facts

Status: done, 2026-10-14; opencode reviewed the design and the implementation, and their findings are folded in (replay and every delivery state change outside pi's transactions; a durable sequence counter; acknowledgements checked rather than trusted; the backoff persisted; usage written outside pi's transactions; the write's stored hash reused for repeats; the stream closed hard at its token's expiry, with the token's lifetime bounded including skew; CORS on errors; separate socket modes). Chunk 7 of [product-and-engine.md](product-and-engine.md), in the engine: a Laravel run's credentials from `leaseToken`, the provider's refusals reported with `reportUnauthorized`, the outbox of facts with its delivery, backlog bound and `replayFacts`, and the stream that the browser reads with a token Laravel signs. The contract is [contract.md](contract.md); the runs it serves are chunk 6's ([start-and-cancel.md](start-and-cancel.md)). Everything here applies to Laravel's conversations only (`organization_id` set); the Workspace's conversations keep their paths until chunk 13.

## Credentials

**The port.** `#credentials` in the Conversation object chooses by the conversation's kind, as `#workspace()` does. For a Laravel conversation:

- **`lease(fence, connection)`.** The fence is checked, `leaseToken({scope, conversation, run, attempt, connection})` is sent through `laravelClient`, and the fence is checked again before the lease is used, as today. A leased answer becomes a lease that holds its payload in memory (below); it is never written anywhere, nor logged. A retryable failure (no answer, a timeout, a 5xx) is tried twice more, 250 ms and 1 s later, while the fence is current.
- **Refusals** map onto the executor's codes, with the engine's own messages, never Laravel's (they reach the model):
  - `RUN_NOT_ACTIVE` → `RUN_ENDED`;
  - `RECONNECT_NEEDED` → `CONNECTION_UNAUTHORIZED`, "The connection expired. Reconnect it in Minerva." (`EXPIRED`);
  - `NOT_AUTHORIZED`, `PROVIDER_UNAVAILABLE`, any code added since, and a failure after the retries → `PROVIDER_UNAVAILABLE`, "This connection is not available to the agent right now. Try again." A `NOT_AUTHORIZED` is logged: the snapshot authorized the connection, so it is a disagreement between the two sides.
  - Laravel not configured (`MINERVA_LARAVEL_URL` or `MINERVA_LARAVEL_TOKEN` unset) is the last case, logged.
- **Expiry.** Laravel refreshes a token before it lends it. A lease whose `expiresAt` is less than 60 s away is asked for once more, and if it still is, refused as `PROVIDER_UNAVAILABLE`, so a call never starts with a token about to lapse. A lease is used for one call only.
- **`markUnauthorized(fence, connection, generation)`** sends `reportUnauthorized` with the fence the lease was taken for (not the current one: a provider's refusal can arrive after a cancel and is still worth reporting) and the lease's generation, which keeps a late report from marking credentials that replaced it. The port gains the fence (the Workspace ignores it), since Laravel checks the connection against the run's authorized set. It is not retried: the executor logs a failure (its messages carry no secret), and the next call's lease is refused anyway if Laravel marked it. **Laravel's side (chunk 8)** must not mark a connection for a refusal of a token that had expired by its own clock: it refreshes instead.

**The lease's type.** `CredentialLease` becomes a union: the Workspace's `SealedLease` (`sealed`, decrypted by `open` with the instance's keys, as today) and Laravel's `HeldLease` (`payload`, the `CredentialPayload` made from the answer: `{kind: "oauth2", access_token, refresh_token: null, scopes}`, `{kind: "api_key", key}` or `{kind: "builtin"}`). `open` returns a held payload as it is. The executor never reads either field.

**What a compromised engine gets** stays Decision 4's bound: the secrets of runs it is asked to run, never a refresh token or a client secret.

## The outbox of facts

### Written with what they describe

Migration 8 of the Conversation object:

```sql
CREATE TABLE facts (
	seq INTEGER PRIMARY KEY,      -- dense from 1 per conversation, from fact_delivery.written
	run_id TEXT NOT NULL,
	fact TEXT NOT NULL,           -- the fact's JSON as delivered, seq included
	created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE fact_delivery (
	singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
	written INTEGER NOT NULL DEFAULT 0,      -- the last seq written; never lowered, so retention cannot reuse one
	acknowledged INTEGER NOT NULL DEFAULT 0, -- the highest seq Laravel holds, as it last said
	indexed INTEGER NOT NULL DEFAULT 0,      -- the highest seq raised in the recovery index
	failures INTEGER NOT NULL DEFAULT 0,     -- consecutive failed deliveries, for the backoff
	next_at INTEGER NOT NULL DEFAULT 0,      -- no delivery before this, whatever wakes the object
	stopped TEXT                             -- why delivery waits for the operator (FACT_CONFLICT), else null
) STRICT;

ALTER TABLE run_writes ADD COLUMN tool TEXT NOT NULL DEFAULT '';
ALTER TABLE run_writes ADD COLUMN connection_id TEXT NOT NULL DEFAULT '';
ALTER TABLE run_writes ADD COLUMN write_id TEXT NOT NULL DEFAULT '';
```

The store writes a fact in the transaction that makes the change it describes (`RunStore.#fact`), only for a Laravel conversation: `written` is raised and the row inserted with it. A fact's JSON is fixed when it is written, so a repeat is byte for byte the first delivery.

**Order.** Facts are in the order their transactions commit, which is not always the order a reader might expect: a model call's usage commits before the tool calls it asked for finish; a write settles (`run.write`) before its `tool_call` fact is recorded, and a call cut by a cancel may have a settlement and no `tool_call` at all; a late settlement or usage can follow `run.finished`. Since chunk 14a ([chunk-14a-design.md](chunk-14a-design.md)), a call the run's end cut may settle after `run.finished` (`run.usage` or `run.unmetered`), and `run.settled`, the run's totals, always comes after `run.finished` and after every settlement fact of its run, usually within seconds and sometimes more than a minute later; it, not `run.finished`, ends a run's usage. Laravel applies each fact on its own and never requires another to come first, except that every fact names a run it holds.

| Fact | Written by | Data |
|---|---|---|
| `run.status` | `activate` (`provisioning`), `startAttempt` (`running`), the gate's `restart` (`provisioning`) | The status and the run's attempt |
| `run.tool_call` | The `tool_call` event's append (`appendToolCall`) | The event's data, with `arguments` from the call's own arguments: their JSON cut to its first 2000 characters, never splitting a surrogate pair, and `truncated`. The event's `{truncated}` form is ambiguous, so the fact is not made from it |
| `run.local_tool` | The `local_tool` event's append | The event's data |
| `run.write` | The ledger's `settle` (`applied` → `done`, `not_applied` → `failed`, `unknown` → `uncertain`), its sweep and the gate's `markDispatchedUncertain` (`uncertain`) | `write` (the keyed hash the `tool_call` event shows), `tool`, `connection`, `outcome`, and `afterCancel`: the run had ended or been revoked when the write settled |
| `run.usage` | The model host's `settled`, for a metered call | `call`, `model` (the upstream's id), `inputTokens` (input with cache reads and writes, as the run's counters), `outputTokens`, `cachedTokens` (cache reads), `reasoningTokens` (0 when the provider does not say); since chunk 14b, `costMicros` and `prices` (Money, below) |
| `run.finished` | `finish`, in its transaction | The status; `error`, the run's error message; `code`, why the run ended (`budget_reached`, `folder_limit`, …), empty when it completed (since chunk 14b); `message`, the run's assistant message or null; `folder`, `{base, result, changes, warnings}` from the run's row, or null when the run had no folder (no base and no result); `storedBytes`, what the conversation's folder keeps once the run has ended, absent when it could not be summed (since chunk 14d, [chunk-14d-design.md](chunk-14d-design.md)) |

**The write's facts need its tool, connection and hash** in the transaction that settles it, and the hash is an HMAC, which WebCrypto computes only asynchronously. So the executor computes the hash before it dispatches, and `dispatchWrite(fence, key, note)` stores `{tool, connection, write}` on the ledger's row. A repeat answered from the record (`cached`, `knownWrite`) shows the stored hash, so a write and its repeat match even if `MINERVA_SECRET_KEY` was rotated between them; only a row written before this chunk, with no hash, has it computed. The ledger's settlements return the rows they settled, and the Conversation's `LedgerRuns` gets `settled(rows, outcome)`, called in the ledger's transaction.

**An unmetered call** (a stream with no usage reported) had no fact in this chunk: chunk 14a added `run.unmetered` for it and `run.settled`, a run's totals ([chunk-14a-design.md](chunk-14a-design.md)).

**Money** (chunk 14b, [chunk-14b-design.md](chunk-14b-design.md)), in integer micro-dollars (µ$), all optional in the contract:

- `run.usage` and `run.unmetered` carry `costMicros`, the call's charge at the rates its record kept when it was admitted (0 for a refused call; an unmetered one at its reservation, by rule), with `prices`, the version of the price table those rates came from. Both or neither: a call on a route the table has no price for (only in the test build) carries neither.
- `run.settled` carries `modelMicros` and `scriptMicros` (the sums of its calls' and scripts' charges), `containerMicros` (its container time, charged once from the Sandbox's spans), `chargedMicros` (the three added) and `prices` (the version that priced its container time), all five when every call and script of the run was charged, else none.
- `run.finished` carries `code`; a run stopped by its budget is `failed`, `budget_reached`, with the error "This conversation reached its budget."

Laravel adds a run's spend to its organization's only from `run.settled`'s `chargedMicros`, and stores each call's `costMicros`; its side is the Budgets section of `docs/plans/turn.md` in the app.

**pi's transactions.** Every fact is written outside pi's transactions (`outside`), with the change it describes, so none can roll back after it was read. Usage moves there too: the model host's `settled` now hands the run's token counters and the usage fact to `outside`, under `waitUntil`, instead of writing the counters wherever it is called. A provider call's cost does not roll back, so neither may its record. Every read of facts (delivery, replay) is also made outside pi's transactions, in one synchronous step with the checks it depends on, so it never sees a change that is still open.

### Delivered in order

**A job.** Each fact's write also pushes the Lifecycle job `facts` in the same transaction (Lifecycle's queue is SQL), due at `next_at` or now, whichever is later, so new facts never cut a backoff short. The job runs `#deliver` and waits for it at most 10 s (`RPC_WAIT_MS`), as other jobs wait for another object; the delivery goes on. `#deliver` is one promise per object, held until the delivery itself ends, not the job's wait, so a job that runs again joins it. The object's start (`#recover`) delivers too. Whatever wakes it, `#deliver` does nothing before `next_at`, and reschedules the job for then. A push while the job runs wins over the running job's own reschedule (Lifecycle applies an outcome only while its row is still marked running), so no fact waits without a job.

**A batch** is the facts after `acknowledged`, in seq order: at most 500 (`MAX_FACTS`) and at most 4 MiB of JSON, and at least one. Each local step (reading the batch, and each change to `fact_delivery` after an await) is its own `outside` write, since pi may open a transaction while the delivery awaits.

1. **The recovery index first.** If the batch's last seq is above `indexed`, `UPDATE recovery_conversations SET fact_seq = max(fact_seq, ?) WHERE id = ? AND organization_id = ? AND workspace_id = ?` in D1; only if it changed a row is `indexed` raised. A failure, or no row, stops the delivery and is retried like any other.
2. **`deliverFacts`** with the conversation's scope (`MINERVA_ENVIRONMENT`, the conversation's organization and workspace).
3. **The answer**, checked rather than trusted. Laravel applies a batch whole or not at all, so:
   - `{acknowledged}` must be at least the batch's last seq and at most `written`. Then it is stored, `failures` and `next_at` are reset, and the next batch follows at once while there are facts after it. Anything else is a protocol violation: logged as an error, nothing stored, and treated as a failure (below).
   - `FACT_GAP` with `data.acknowledged` between 0 and `written`: stored, even below the old value (Laravel was restored, and what it lost is sent again), and the delivery goes on from there, at most three times in a row before it backs off. A watermark outside that range is a failure. Since chunk 15a ([chunk-15a-design.md](chunk-15a-design.md), Facts and the floor), a watermark below `floor − 1` is not stored: Laravel lacks facts the engine no longer holds, and sending from the floor would skip them in silence. The floor is checked again in the step that would store the watermark, since retention may have raised it meanwhile. The acknowledgement marks above the watermark are deleted, so retention keeps the facts Laravel lacks that are still held. `stopped` then says so (`FACTS_PRUNED`), it is logged as an error and tried again hourly, as a conflict is, and it resumes by itself once Laravel's watermark is at or above `floor − 1`.
   - `FACT_CONFLICT`: `stopped` is set and logged as an error for the operator, and `next_at` is an hour away. Delivery is tried again at that pace, logged each time, and resumes by itself once Laravel accepts it.
   - Anything else (no answer, a 5xx, `NOT_FOUND`, another 4xx, Laravel not configured): `failures` goes up and `next_at` is `min(2^failures s, 5 min)` away; a 4xx and `NOT_FOUND` are logged as errors, being bugs or misconfigurations.

Nothing is ever dropped: a fact leaves the table only through retention, 7 days after Laravel acknowledged it (chunk 15a). Each acknowledgement stored is marked with its time in `fact_acknowledgements` in the same step, and pushes the `retain` job for 7 days later; a gap that lowers the watermark deletes the marks above it. `written` is never lowered, so a sequence is never used twice, even once retention deletes rows; the floor, the lowest sequence still held, never falls.

**What the index guarantees.** Every fact that was ever sent to Laravel, by a delivery or a replay, is at or below the index's `fact_seq`, since the index is raised before either sends it. A fact not yet sent is delivered by its object on its own. So after Laravel is restored, the conversations whose `fact_seq` is above Laravel's restored watermark are exactly those whose objects must be asked to deliver again (chunk 15's listing); the others will deliver what they hold when they next run their job.

### The backlog bound

A start is refused `FACTS_BACKLOG` ("This conversation is catching up. Try again in a few minutes.") when the conversation has more than 10,000 facts written but not acknowledged. It is checked with the other refusals before any work (`#startState`), and stored as the run's answer like them. A turn usually writes tens of facts, so the bound is normally reached only when Laravel has not acknowledged for many runs; it gates starts and does not bound the table, since a run in progress keeps writing (its tool and model calls are not limited until chunk 14).

### `replayFacts`

`POST /internal/v1/conversations/facts`: the environment (the middleware), then the recovery index read without writing (`conversationOf`): an unknown conversation is `NOT_FOUND`, one bound to another organization or workspace `SCOPE_MISMATCH`. The object (`replayInternal`) checks its own binding the same way and reads the facts after `after`, in seq order, at most `limit` and at most 4 MiB of JSON (at least one), with `more` when there are others after them: the check, the page and `more` in one synchronous step outside pi's transactions. Before it answers, it raises the index to the page's last seq, as a delivery does. Facts acknowledged or not are both retained, so a replay can also send what the delivery has not yet. Since chunk 15a, an `after` below `floor − 1` is refused `FACTS_PRUNED` (410), with `data: {floor}`, rather than answered with a page that silently starts later; the floor is read in the same synchronous step as the page.

The recovery index gains `fact_seq` in D1 migration `0011_fact_seq.sql` (`ALTER TABLE recovery_conversations ADD COLUMN fact_seq INTEGER NOT NULL DEFAULT 0`).

## The stream

### The token (open question 1)

A JWT, HS256, signed by Laravel with a key the engine shares (`firebase/php-jwt` there, `jose` here, which the engine already uses for Access). An HMAC over a payload of our own would save a dependency on Laravel's side, but JWT's library checks the claims, times and key ids we would otherwise write twice.

- **Header:** `alg: HS256`, `kid` naming the key.
- **Claims:** `aud: "minerva-engine"`, `purpose: "run-stream"`, `env` (the engine's `MINERVA_ENVIRONMENT`), `org`, `conversation`, `run`, `iat` and `exp`.
- **Checked:** the algorithm is HS256 and only HS256; the key is the `kid`'s; every claim above is present (`requiredClaims`), `aud`, `purpose` and `env` equal the engine's, and the ids are UUIDs; `iat` and `exp` are integers with `exp > iat` and `exp - iat` at most 300 s; `exp` is after now, with no tolerance; `iat` is at most 30 s ahead of the engine's clock, for skew. So a token is used for at most 330 s from the moment it is checked, and its stream closes at `exp`.
- **Keys:** the secret `MINERVA_STREAM_KEYS`, `id:secret` entries comma separated, each secret 32 bytes or more in base64, declared only where it is set (as `MINERVA_LARAVEL_TOKEN`). Laravel signs with one of them; rotation adds a key, Laravel switches, and the old one is removed once every token signed with it has expired (ten minutes covers it). Every environment has its own.

### The route

`GET /stream/v1`, with the token in `Authorization: Bearer` and the cursor in `Last-Event-ID` (else 0): no id in the URL, so none in a log. Off (404) unless the internal API's settings, `MINERVA_LARAVEL_URL` and `MINERVA_STREAM_KEYS` are all set.

1. The token verified; anything wrong is 401 `UNAUTHORIZED`, and nothing says why. The browser asks Laravel for a new token on a 401.
2. The recovery index: the conversation's row must name the token's organization, else 404.
3. The object's socket, addressed through the index's jurisdiction as the commands are, in a mode of its own: the upgrade names either a user (the public stream: the conversation must be the Workspace's, `organization_id` null, and the user its owner) or an organization (Laravel's: `organization_id` must equal it), never both and never one in place of the other. Either way the conversation must not be deleted and must hold the run; every failure is the same 404.
4. The relay (the public stream's `Relay`, moved to `src/stream/relay.ts` and shared) writes SSE frames as today and **closes hard at the token's `exp`**: what it holds for a slow client is dropped, and the client resumes from the last event it took. It also checks the expiry before opening a socket again after a 1013, and the time it took to open the first socket counts. A stream without `event: end` is resumed by the browser from its last event id with a new token, so a removed member loses the stream within one token's life.

**CORS.** The browser reads the stream from Laravel's pages, so the route answers `Access-Control-Allow-Origin` for Laravel's origin (`MINERVA_LARAVEL_URL`) only, with `Vary: Origin`, on every answer (401, 404 and 5xx included, so the browser can see the 401 that asks for a new token). A preflight (`OPTIONS`) needs no token, and from Laravel's origin gets `GET`, the headers `Authorization` and `Last-Event-ID`, and a max age of 10 minutes. CORS is not the authentication: every `GET` needs a valid token, whatever its origin, and no cookie is ever read. The assets' `runWorkerFirst` gains `/stream/*`, and the router gives it the security headers. Access's service-token policy stays on `/internal/*` only: `/stream/*` is reached by browsers.

## Tests

**Unit:** the token's checks (a valid one; each claim wrong; HS256 only, `none` and RS256 refused; an unknown `kid`; a lifetime over five minutes; expired); the fact's arguments (cut, surrogates, not a dict); the lease's mapping of each refusal; the keys' parsing.

**Platform**, with the fake Laravel installed and the fake model:

- A turn with a connector tool: its lease asked of Laravel with the run and attempt, the provider called with the leased secret, and the facts delivered in order: `run.status` provisioning and running, `run.tool_call`, `run.usage`, `run.finished` with the answer and the folder. A refused lease (`RECONNECT_NEEDED`, `RUN_NOT_ACTIVE`) reaches the model as its error; a provider's 401 sends `reportUnauthorized` with the generation.
- A write's settlement as a `run.write` fact, with the hash its `tool_call` fact shows, and one that settles after a cancel with `afterCancel`.
- Delivery: Laravel down, then back (nothing lost, nothing twice); an acknowledgement lost after Laravel applied the batch (sent again, applied once); a `FACT_GAP` after Laravel lost what it held (restored), from its watermark; an acknowledgement out of range refused; a `FACT_CONFLICT` stops it; new facts during a backoff do not cut it short; the index's `fact_seq` raised before a batch is sent.
- A write's repeat shows the hash stored with the write.
- The backlog: a start refused `FACTS_BACKLOG` past the bound (the bound lowered through the test's port).
- `replayFacts`: in order, paged with `more`, `NOT_FOUND` and `SCOPE_MISMATCH`.
- The stream: the events of a Laravel run with a valid token; 401 for a bad one; 404 for another organization, and for a Workspace conversation; a Laravel conversation not reachable through the public stream; closed at the token's expiry and resumed with a new one from the last id; CORS for Laravel's origin on a 401 too, an unauthenticated preflight, and no CORS for another origin; off without the settings.
- The Workspace's conversations write no facts, and their suites pass unchanged.

## Out of scope

- Laravel's side: serving `leaseToken`, `reportUnauthorized` and `deliverFacts`, and signing stream tokens (chunk 8 for the first three, chunk 12 for the stream in the chat).
- The unmetered call's fact and allowances (chunk 14); retention of facts and recovery's listing (chunk 15); `deleteConversation` (chunk 12).
