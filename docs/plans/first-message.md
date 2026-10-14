# Design: a first message creates its conversation

Dropped 2026-10-14, never built: under [product-and-engine.md](product-and-engine.md) Laravel creates a conversation and its first message in one transaction, and the Worker's conversation API goes. Kept as the record of the design.

Unit A2b of the frontend cleanup, 2026-10-13. A design, not built. Goal: the new-chat page sends one request that creates the conversation and posts its first message under one `Idempotency-Key`, so it can repeat the whole send after a lost answer and never creates and then deletes a conversation.

## Today

Two requests, two objects:

1. `POST /api/workspaces/{ws}/conversations` `{agent_id}` → Workspace object `createConversation`: inserts the index row (`ready = 0`), calls the new Conversation object's `init` (idempotent: the same owner, workspace and agent), then sets `ready = 1` and answers 201 `ConversationOut`. A failed `init` tombstones the row; an alarm tombstones rows still `ready = 0` after `CREATE_TTL_MS` (10 minutes). No key: a repeat makes a second conversation.
2. `POST …/conversations/{c}/messages` `{content, attachments}` with an optional `Idempotency-Key` → the Worker checks `ownsConversation` (`ready = 1`, the caller's, not deleted), then Conversation `postMessage`: in one transaction, a known key with the same digest of `[content, attachments]` replays its run (a start in flight is joined through `#begins`), another digest is 422 `IDEMPOTENCY_KEY_REUSED`; otherwise the busy check (409), a `starting` marker and the key in `start_keys` (24 hours). `#begin` then calls the Workspace's `beginRun` (agent, uploads, folder limits; reserves the uploads; registers the run `starting`), copies the attachments, and stores message and run in one transaction. Any refusal deletes the marker and the key and releases the registration (`release(run, "refused")`).

The frontend (`components/chat/runtime.ts`, `routes/w.$workspaceId.chat.index.tsx`) creates the conversation once without retry, sends the message with retries (`components/chat/send.ts`), and on a refusal (4xx or `START_FAILED`) calls `DELETE` on the conversation it created and gives the message back to the composer. A lost answer to the create, or a failure after it, leaves an empty conversation in the list.

## Proposal

### Endpoint

`POST /api/workspaces/{ws}/conversations` takes the first message: `{agent_id, content, attachments}` (`MessageIn` plus `agent_id`) and an optional `Idempotency-Key` (the same 1 to 255 visible ASCII characters as on `/messages`). It answers 201 with the message answer (`PostedView`: the message and its run) plus `conversation_id`. The body without a message goes: a conversation always starts with one. The Workspace's `createConversation` stays as an RPC for tests until they move to the new method.

Order in the Worker: membership, schema (422), well-formed text, key syntax (400), empty message (400 `EMPTY_MESSAGE`, before anything is created), the first-message digest (SHA-256 of `[agent_id, content, attachments]`, computed here because the Workspace's transactions are synchronous), then `openConversation` and `postMessage` below. The Worker addresses the Conversation object by the id the Workspace returned, never one from the request.

### Who owns which key

- **The Workspace owns the first message's key**, in a new table `conversation_keys (user_id, key, digest, conversation_id, created_at, PRIMARY KEY (user_id, key))`. It maps a key to the conversation the first send created, for 24 hours like `start_keys`: an older row is ignored on lookup and deleted by the Workspace's alarm (not only on the caller's next lookup, since the table is the whole workspace's).
- **The Conversation keeps owning the run's key**: the Worker passes the same key to `postMessage`, so `start_keys` dedupes the run inside the conversation exactly as today.

### `openConversation(caller, {agentId, uploadIds, digest, key})`, Workspace

One synchronous transaction, then `init`:

1. With a key: delete the caller's keys older than 24 hours, then look it up. Found with another digest: 422 `IDEMPOTENCY_KEY_REUSED`. Found, conversation deleted: 404. Found: its id, and nothing else is checked (the first send may already hold the uploads).
2. Not found: the agent (404), then the attachments' checks of `beginRun` against an empty folder (count, duplicates, the user's own complete unreserved uploads, folder limits), read only, sharing `#attachable` and the limit check with `beginRun`. A refusal here creates nothing.
3. Insert the conversation row with `ready = 0` and, with a key, the key row.

After the transaction, if the row is still `ready = 0`, call `init` (idempotent; a repeat calls it again), then check the row again, as `createConversation` does: tombstoned meanwhile (the sweep, or its agent deleted) is 404. A failed `init` no longer tombstones: the row stays for a retry, and the sweep removes it.

### Hidden until its first message is stored

`ready` changes meaning from "initialized" to "published": a conversation is listed, readable, deletable, and reachable through `/messages` and its runs' URLs (`locateRun` checks `ready` too, as `ownsConversation` does) only once its first message is stored. Registering a run is not enough, because a registered start can still be refused or expire before it stores anything.

- `beginRun` accepts a conversation with `ready = 0` (only its own Conversation object calls it, and that object is initialized). It publishes nothing.
- **The Conversation object publishes**, because only it knows when a message is stored. The transaction that stores its first message also records a pending publication. After it commits, the object calls the Workspace's `publishConversation(id)` (sets `ready = 1` unless the row is tombstoned; idempotent) and waits for it before answering, so the page the client navigates to finds the conversation. If the call fails, the answer is a 503, which the frontend repeats; a replay of a stored first message whose publication is pending also waits for it. The pending publication is sent again on the object's retry alarm and whenever it starts, as releases are (`#retryReleases`), until it is heard. This covers every stored first message whatever its run's status, including one stored already cancelled (a revocation during the copy) and one whose `activate` comes back `expired`.
- Collection: the sweep tombstones a `ready = 0` row older than 10 minutes only when every run the registry holds for that conversation ended `refused` (none counts). `release(run, "refused")` records `refused` on an `expired` run too, which `#endRun` ignores today, so a start that expired and was then refused counts as one that stored nothing. The alarm's schedule (`nextWake`, which today wakes for every `ready = 0` row at `created_at + CREATE_TTL_MS`) uses the same condition, so a hidden row that is not yet collectable does not wake the alarm again and again; a refused release that makes one collectable schedules the alarm. A hidden conversation whose start expired without being refused or stored (its Conversation object never came back) stays hidden and is not swept.
- A refused first message therefore never shows: nothing has to be hidden again, and there is no window in which another request sees an empty conversation, deletes it during its first start, or gets `CONVERSATION_BUSY` from it.

### Repeats and concurrent sends

- **Same key, sequential:** step 1 finds the conversation; `postMessage` with the key replays the stored run, or joins the start in flight. One conversation, one run.
- **Same key, concurrent:** the Workspace's first transaction serializes them: one inserts, the other finds the row. Both call `init` (idempotent) and `postMessage`; the Conversation's transaction makes one the start and the other its replay, which joins the same `#begin`. Both name the same conversation, message and run (a replay of a stored run shows the run as it is now, not the first answer). A start refused in between forgets its run key (today's rule), so a repeat arriving after the refusal starts again in the same hidden conversation and may succeed where the first failed (`START_FAILED`).
- **Different key:** a new conversation, by construction. Two keys never share a conversation.
- **Same key, other body or agent:** 422 at the Workspace, before the Conversation is reached.

### A failure between the steps

| Where it stops | What is left | How it completes |
|---|---|---|
| After the insert, before `init` finished | A hidden row and the key | A retry finds the key and calls `init`; otherwise swept after 10 minutes |
| After `init`, before `postMessage` | A hidden, initialized conversation | A retry posts the message; otherwise swept and purged |
| `postMessage` took the message, answer lost | A start in flight (the Conversation's watch drives it to stored or refused) | A retry joins or replays it; a stored one is published by the Conversation either way, and a refused one leaves the conversation to the sweep |
| The message stored, publication not heard | A stored run in a hidden conversation, its publication pending | A retry replays and publishes; otherwise the retry alarm sends the publication again |

A key completes its send while its hidden conversation exists: for at least 10 minutes after the first attempt, and as long as a start in it is registered. After the sweep, the key answers 404 for the rest of its 24 hours. Repeats come within seconds (the frontend's two retries), so the window is wide enough; it is not the 24 hours of `start_keys`.

A start that reaches `beginRun` only after the sweep tombstoned its hidden conversation (the Conversation object was away for 10 minutes before registering) is refused 404, as a start in a deleted conversation is today.

### Refusals

| Refusal | Decided by | Left behind |
|---|---|---|
| 422 schema, 400 key syntax, `EMPTY_MESSAGE` | Worker | nothing |
| `IDEMPOTENCY_KEY_REUSED` | Workspace, step 1 | the first send's conversation, unchanged |
| `NOT_FOUND` (agent), `TOO_MANY_ATTACHMENTS`, `ATTACHED_TWICE`, `ATTACHMENT_UNAVAILABLE`, `FOLDER_FULL` | Workspace, step 2 | nothing |
| The same codes from `beginRun` (another send took the upload meanwhile) | Conversation, through `beginRun` | a hidden conversation and its key, swept |
| `ATTACHMENT_UNAVAILABLE` from the copy, `START_FAILED`, `RUN_STOPPED`, 404 deleted meanwhile | Conversation, after registration | the same: never published, swept once the release is heard |
| `CONVERSATION_BUSY` | cannot happen: `/messages` cannot reach an unpublished conversation, and a repeat with the key replays rather than starts while a start is in flight | |

A refused start forgets its run key (today's rule), but the Workspace keeps the first-message key: the same key sent again posts to the same hidden conversation and is judged again. The frontend sends a refused message again only under a new key, so the old hidden conversation is swept.

### Attachments

Unchanged where it matters: uploads are reserved by `beginRun` and consumed by `activate`. Step 2's checks only refuse early and reserve nothing; a repeat skips them, because the first attempt may hold the reservation. A refused start releases its reservation as today: `#refuseStart` answers first and delivers the release afterwards (retried every 30 seconds until heard), so a resend under a new key right after a refusal can still find the uploads reserved and be refused `ATTACHMENT_UNAVAILABLE` by step 2. That is today's behaviour for `/messages` too; making the refusal wait for the release would be a separate change.

### Frontend

- `send.ts`: a `Send` names its target, an existing conversation or `{agent_id}` for a new one; one `mutationFn` calls `postMessage` or the new create with the same key and body on every retry, and returns the conversation id with the answer. The retry rule is today's (network failure, 502, 503, 504; at most two).
- `runtime.ts`: `conversation` becomes `string | {agentId}`; `startConversation`, the nested try, `deleteConversation` and the comment about deleting go. `onSent` gets the id from the answer.
- The new-chat page loses its create mutation and its error branch.
- About 45 lines removed and 20 added, plus the request and answer types: the generated client comes from Django's schema until A3, so the new body is typed by hand there, or the endpoint lands with A3's contract.
- The guarantee covers the automatic repeats. After they are exhausted the page gives up as today: the message is not given back (it may have started), and a later send is a new key and possibly a second conversation, which is published only if its message was stored.
- A tab still running the previous frontend sends `{agent_id}` alone and gets 422 until it reloads; the frontend's chunk-error reload covers most of them, and nobody depends on the old shape yet.

## Tests

Worker, platform (`chat.test.ts`, `protocols.test.ts`):

- A first message answers 201 with `conversation_id`, its message and run, and the conversation is listed.
- The same key twice, sequential and concurrent (`Promise.all`): one conversation, one message, one run; the answers name the same ids.
- Another key: a second conversation. The same key with other content, attachments or agent: 422, and nothing new.
- Every early refusal leaves no row in the Workspace's `conversations` and no initialized Conversation object.
- A fault after `init` (a new fault point before `postMessage`): not listed, `GET`, `DELETE` and `/messages` 404; a retry with the key completes it; without one, the sweep (fake clock) tombstones and purges it.
- A fault after the message is stored and before the publication is heard: hidden, then published by the retry alarm, or by a retry of the request; the same for a first message stored already cancelled.
- A refusal after registration (the upload's object deleted before the copy): never listed, swept after the release is heard. A delayed release keeps it unswept until then.
- A start registered and then expired: swept only after its refused release, and the alarm does not spin on it meanwhile; a start stored and then expired: published, never swept.
- A hidden conversation's run: `GET`, cancel and the stream by run id answer 404.
- `init` racing the sweep and the agent's deletion: 404, not a conversation.
- A key older than 24 hours starts a new conversation; the alarm deletes old key rows.

Worker, unit (Workspace core over SQLite): `openConversation`'s steps; `beginRun` on a hidden conversation; `publishConversation`; `locateRun` on a hidden conversation; the sweep's condition and the alarm's schedule, including an `expired` run released as refused.

Frontend: `frontend-messages.test.ts` gains the case "a first message whose answer is lost is sent again with the same key and makes one conversation and one run"; the browser walk sends a first message, and one with an unavailable attachment, which comes back to the composer and leaves nothing in the list.

## Size

About 200 lines in `cloudflare/src` (route 35, Workspace 85, the Conversation's pending publication 35, schema steps 15, RPC surface and digest 30), 300 in Worker tests, the API types (hand-written until A3), and in `frontend/` about 25 fewer lines plus 40 of test. Three quarters of it is the Workspace's conversation lifecycle and start protocol: schema steps in both objects, a change to what `ready` means, `beginRun`, `locateRun`, `release`, the sweep and its schedule touching conversations, a publication the Conversation object owes the Workspace, and two new fault points.

## Recommendation

Move it to the backend's plan rather than doing it as A2b here. It changes both objects' invariants and the start protocol, which the plan's fault tests guard, and adds schema steps and a new message between the objects that must be retried until heard; the frontend's gain is a few dozen lines and a retry of the first send. Until then the new-chat page keeps create, send and delete-on-refusal, and A3 declares today's two endpoints. When the backend takes it, the frontend part is a small vertical change in the same commit.

Open questions:

- Should the key be required on the first message? This design keeps it optional, as on `/messages`; without one a repeat makes a second conversation.
- Should an API client still create an empty conversation (a desktop client opening a chat before typing)? This design says no.
- `CREATE_TTL_MS` and `START_TTL_MS` are both 10 minutes; a start that waits that long before registering loses its hidden conversation. A longer sweep for keyed rows would avoid it.
- Should a refusal wait until its release is heard, so the composer's attachments can be sent again at once? It would change `/messages` too.
