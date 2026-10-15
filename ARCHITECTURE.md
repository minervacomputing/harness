# Minerva architecture

Updated 2026-10-14. This repository is **Minerva's open harness**: the engine that runs an agent's turns on Cloudflare (Workers, Durable Objects, D1, R2, Containers), with its permission pipeline, its 20 connectors and its sandbox. Minerva the product is hosted; **self-hosting is not supported**. How to develop and deploy the engine is in [cloudflare/README.md](cloudflare/README.md); what each connector lets agents do is in [docs/connectors.md](docs/connectors.md); work in progress is planned in [docs/plans/](docs/plans/).

## Summary

The agent **never holds a credential and never decides its own permissions**. Each turn's commands run in a microVM with no network at all; the scripts it writes run in isolates with no network; every call to a connected app goes through a permission check that the user's grants decide, in trusted code that holds the keys.

| Area | Choice |
|---|---|
| Runtime | One Worker (`minerva-cf`) and a download Worker; a Durable Object per workspace, per conversation, and per conversation's sandbox and scripts |
| Agent loop | pi-durable through PiHarness in the Conversation object: durable across crashes, with Minerva's tools, history and code mode |
| Sandbox | A Firecracker microVM per turn (Cloudflare Containers), no route out, hardened before any command runs |
| Code mode | Each script a Dynamic Worker with no network, no `env` and a CPU limit |
| Permissions | Layers that only narrow: provider account ∩ ceiling ∩ user ∩ agent, deny wins; checked on every call |
| Models | Workers AI, or OpenAI and Anthropic through the instance's AI Gateway (prompt logging off), behind our own request policy |
| Files | A folder per conversation: versions in the Conversation object, blobs in R2 (an EU-jurisdiction bucket for EU workspaces) |
| Accounts and API | Better Auth on D1, an oRPC contract (`contract/`) the frontend's client derives from; both move to the product (below) |

## The engine and the product

Minerva is becoming two systems ([docs/plans/product-and-engine.md](docs/plans/product-and-engine.md), decided 2026-10-14): **a private Laravel application decides what may happen; this engine does it and records what it did.** Laravel will hold users, organizations, connections and their credentials, grants and agents as users set them, the product transcript, billing and administration. The engine keeps execution: pi's loop, the sandbox, code mode, the connectors and the permission pipeline, each conversation's folder, and each run's attempts, write ledger and events, with an outbox of facts for Laravel.

Until that plan's chunks land, the engine still carries what it was built with as a complete product: accounts and sessions (Better Auth), the Workspace object's connections, grants, agents and run registry, the public API and the React frontend in `frontend/`. This document describes the engine as it is; the plan says what moves and when. There is one engine deployment per environment (production, and the test instance with fault points); a dedicated copy for an enterprise would be a second deployment, not a self-hosted one.

## Shape

```text
Browser ── HTTPS (cookie session, CSRF) ──► Worker minerva-cf
                                             static assets (frontend build), /api router
                                             SSE relay ◄─ hibernatable WebSocket ─┐
                                               │                                  │
              D1 minerva-cf ◄──────────────────┤                                  │
              users, sessions, auth flows,     ▼                                  │
              workspaces, memberships     Workspace DO (one per workspace)        │
                                          connections (encrypted), layers,        │
                                          grants, agents, conversation and        │
                                          run registry, uploads, outbox           │
                                               │ RPC                              │
                                               ▼                                  │
                                          Conversation DO (one per chat) ─────────┘
                                          messages, runs, attempts, events,
                                          write ledger, page tokens, folder
                                          versions, pi-durable (PiHarness), executor
                                            │ RPC                  │ RPC
                                            ▼                      ▼
                                   Scripts DO (per chat)     Sandbox DO (per chat)
                                   Dynamic Worker guests,    ctx.container: Firecracker VM,
                                   no network                no egress at all
R2 minerva-cf-files(-eu): blobs, uploads ◄── Worker minerva-cf-files (download origin, signed links)
Workers AI / AI Gateway minerva-cf: models
```

The names are production's; every resource name derives from the instance's name (cloudflare/README.md, Names).

## Trust model

| Zone | Trusted? | Holds |
|---|---|---|
| Browser | The signed-in user | Session cookie, CSRF token |
| Worker and Durable Objects | Yes: our code and its dependencies | Secrets, all state, decrypted credentials for one provider call at a time |
| Sandbox container | **No**, hostile | The turn's files; no token, no route out |
| Script guests | **No**, hostile | One RpcTarget that queues tool calls |
| Model output, provider content, files | **No** | — |

**The agent loop is trusted code.** In Minerva's first version (Django, with the loop inside the container), a compromised loop reached nothing but a gateway. Here the loop runs in the Conversation object, in the same Worker script as the secrets and the executor, so the trusted code base includes pi-durable, pi-ai, the Agents SDK and their dependencies. A bug or supply-chain compromise in any of them runs with the Worker's bindings and secrets: it could address any workspace's objects and decrypt **every** workspace's credentials, not only its own conversation's. Model output cannot execute as host code: it reaches the loop only as tool names, arguments and text, which go through the permission pipeline. Code the model writes runs only in the container and in script guests, which hold nothing and reach nothing.

Mitigations: dependencies pinned with exact versions and lockfile hashes; credentials decrypted only where they are used (the executor for one provider call, the Workspace object for a refresh or reconnect, the API Worker for a settings call such as listing resources), never stored in pi's state, events or logs; the model request built by our own provider wrapper, which refuses anything but text input and function tools (a defence in depth, since the request is not hostile). The product plan narrows this: the engine will lease credentials from Laravel per run and never hold refresh tokens, the key or the credentials no run uses, though a leased API key or token may not expire (product-and-engine.md, Decisions 4). Moving the executor into a Worker of its own is open question 1.

## Data placement

Each piece of state has one authoritative home; everything else is an index that can be rebuilt from it.

- **D1** (one database per instance, primary near Frankfurt): Better Auth's tables (users, sessions, accounts, verifications, two-factor secrets and backup codes, organizations with members and invitations, its per-IP rate limits; organizations also carry `personalOwner` and jurisdiction), and ours: `workspaces` (id, organization, kind, name, `personal_owner`, jurisdiction; organization and owner RESTRICT), `memberships`, `oauth_clients`, `oauth_flows` (one per session, 600 s), `instance_setup`, `instance_settings` and `instance_identity` (the instance's name and kind, which deploys and resets check). Auth transitions use conditional SQL (`UPDATE … WHERE attempts < 3 RETURNING`) or atomic `batch()`, since D1 has no interactive transactions; reads go to the primary (no read replicas).
- **Workspace DO**: authoritative for `connections` (encrypted credentials, status, generation, scopes, refresh state), `layers`, `grants`, `agents`, `uploads` (unattached, per user, with reservations), the `runs` registry (run, conversation, user, agent, connection ids, state, revoked), the cancellation `outbox`, byte counters. Index only: `conversations` (id, user, agent, title, timestamps).
- **Conversation DO**: authoritative for its owner, workspace and agent (fixed at creation), `messages`, `runs` and `attempts`, `run_events`, the write ledger (`run_writes`), `page_tokens`, `start_keys` (Idempotency-Key, kept 24 hours), `folder_versions` (manifests split into rows under 2 MB), the run's checkpoint, the script store, and pi's `pi_*` tables.
- **Sandbox DO**: authoritative for the container's lifecycle: incarnation id, owning run and attempt, hardening state, cleanup pending.
- **Scripts DO**: only its fence (`script_fence`): the newest run, attempt and script it has run, and whether that script ended, so a stale script or reset from a replaced attempt is refused after a restart too (Attempts and recovery, Fencing).
- **R2 `minerva-cf-files`**, and **`minerva-cf-files-eu`** (created in R2's EU jurisdiction) for EU workspaces: `blobs/<ws>/<conv>/<sha256>/<random>` and `uploads/<ws>/<user>/<id>`; the default-jurisdiction bucket also holds `static/assets/...`, the earlier builds' hashed frontend files, so a page opened before a deploy still finds its chunks. Content is deduplicated within a conversation, not across conversations. A lifecycle rule deletes `uploads/` objects a day after they were written, attached or not, so a folder never names one (Starting a run).

A workspace's data is therefore in databases of its own rather than in rows filtered by a key, and a request reaches an object only by typed calls after a membership check; the Worker that makes those calls is trusted with all of them, and D1 and R2 are shared. The price is queries across tenants: objects cannot be queried together, so admin search, analytics and an audit log need a path of their own (open question 9), which the product plan gives Laravel.

**Addressing.** One module (`src/addressing.ts`) maps a workspace's id and jurisdiction (from D1) to its objects (`jurisdiction('eu')` when set) and to its bucket, since the same name with and without a jurisdiction is a different, empty object. The Worker never routes a request to a Durable Object by a client-chosen name without checking it; there are no generic Agent routes (`routeAgentRequest` is not used); objects are reached only through typed RPC from our own code. Local workerd has no jurisdictions (`jurisdiction()` throws), so with `MINERVA_DEBUG` on, and only then, an EU object is named `eu:<name>` in the plain namespace; a production build refuses `MINERVA_DEBUG`. Where an EU workspace's container runs is unmeasured: `durable_object` scheduling has no placement constraint, so the VM may sit outside the EU even when its Sandbox DO does not (open question 8). The deployed Worker's `/api/probe` (token-gated) reports each class's jurisdiction as the account tests see it.

## Permissions

A grant is **connection + resource kind + resource + actions**, allow or deny. A resource may be `*`, every resource of that kind including new ones. Allows on kinds or wildcards a connector no longer declares are ignored when a run starts; denies always apply. New concrete grants are checked against what the account can see; removals never need the provider. Each connector's kinds and actions are listed in [docs/connectors.md](docs/connectors.md#permissions).

```text
effective = provider account ∩ workspace ceiling ∩ user layer ∩ agent layer   (deny wins)
```

The effective permissions are computed when a run starts and stored with it (`gateway/policy.ts`, `gateway/grants.ts`). Changing access, removing a connection or changing an agent's connections cancels the affected active runs (Strict revocation). In a personal workspace the ceiling is unrestricted and never shown. Each agent uses only the connections selected for it.

Every tool call goes through one pipeline (`gateway/executor.ts`):

```text
strict argument validation
  → provider consent (the connection's OAuth scopes)
  → connector resolves the real resources the call touches, checked against its declaration
  → permission check
  → (writes) dispatch the write, one at a time per run
  → call the provider
  → (writes) settle: succeeded, not applied (forgotten, so it can be tried again), or uncertain
  → drop returned records the run may not see
  → return, with an opaque run-bound page token
```

- **Writes.** Identical writes within a run are deduplicated. A write the provider refused outright, or that never reached it, is forgotten. One whose outcome is unknown (a timeout) is uncertain and pauses the run's further writes (Writes, below).
- **Tokens.** If a provider rejects a connection's token, the connection is marked **Needs reconnecting**, unless it was reconnected meanwhile (a generation counter). Reconnecting keeps the user's choices. Only the owner can reconnect a personal connection, and only an admin a shared one.
- **Changed tools.** A run snapshots a fingerprint of each tool's declaration. If a deploy changes what a tool means, active runs lose it (`OPERATION_CHANGED`) rather than use it under old grants.
- **No caps on work.** A turn has no limit on writes, model calls or tool calls, so an agent can work on one prompt as long as it needs; a deadline per turn is optional (`MINERVA_RUN_TIMEOUT_SECONDS`).

## Connectors

A **connector** (`src/connectors/<name>/`, the contract in `gateway/connector.ts`) declares resource kinds, actions (with dependencies such as "create requires read") and operations. Each operation has a strict zod input schema and a `prepare()` step that resolves the real resources a call touches: `{ need }` for a concrete resource, or `{ enumerate }` for a listing filtered afterwards. The executor rejects a call whose requirements do not match the operation's declared needs, and a write that enumerates or names no concrete resource, so a connector mistake fails closed. Design notes for each provider are in its module's comments.

- **Canonical ids.** Grants and records use the id the provider lists. Aliases (`primary`, a differently cased address, a name) are resolved before authorization, so a deny cannot be bypassed under a wildcard allow.
- **Hierarchies.** A nesting kind (Drive folders, Notion pages, Linear sub-teams) carries each resource's ancestors. An allow on the resource, an ancestor or `*` allows it; a deny on any of them blocks it. Unknown ancestors never help an allow, and an incomplete chain is blocked by any exact deny for that action. The executor rejects malformed ancestry (wildcards, duplicates, a resource inside itself, more than 64 ancestors, ancestry on a flat kind). Connectors resolve ancestry again just before they read, list or create, refusing what moved in between (`FILE_MOVED`, `PAGE_MOVED`, …).
- **Several kinds.** An operation may need actions on more than one kind (an Outlook reply needs Read on a folder and Send on its recipients); records scoped to a kind without the operation's output action are dropped.
- **One write per operation.** A mutating operation sends one mutating request, only from `execute()` and only with time left. The executor judges the write by what the provider client recorded, not by what the connector returned.
- **Provider consent.** A connection starts with the connector's base scopes only. When the user allows an action whose scopes are missing, the connection offers a flow bound to it that asks for the scopes of every allowed action (incremental where the provider supports it) and refuses a different provider account. Tools whose scopes are missing are not offered; a call made after scopes shrank fails with `CONSENT_REQUIRED`.
- **Connections** belong to a workspace and are personal (the user's own OAuth, so the provider's permissions also apply) or shared (admin-made; not built). Tools are namespaced per connection, and the executor routes each call to a connection it chose, never one named in model arguments.
- **OAuth apps** are configured per app (`MINERVA_<APP>_CLIENT_ID` and `_SECRET`), and a token is refreshed only through the client that issued it. Todoist registers its own client. API-key connectors (Stripe) and built-in services (the Web) use the same contract.

Content from providers and web pages is untrusted input to the model. Filtering what agents see does not neutralize prompt injection; it bounds what an injected agent can reach.

## Protocols

These are the parts most likely to be subtly wrong. Each has fault-injection tests (Testing).

### Starting a run

A message that is refused (409 while a run is active, an unknown agent, a missing or foreign upload, attachments over the folder's limits) leaves nothing behind, as the frontend expects; one that is accepted stores its message and run together.

1. **Conversation DO:** checks that no run is active (409), picks the run id, and records a private `starting` marker for it (invisible to the API).
2. **Workspace DO `beginRun(runId, conversation, user, agent, uploadIds, folderUsage)`**, idempotent by run id and synchronous inside (no awaits): checks the agent, the uploads (the user's own, unattached, complete) and the folder limits with the attachments, reserves the uploads for the run, computes the snapshot, registers the run as active, and returns the snapshot or a refusal. Called again with the same run id, it returns the same answer; it refuses a run it has since revoked or expired.
3. **Conversation DO, copying the attachments:** for each reserved upload whose contents the conversation does not hold yet, it records a loose blob key `blobs/<ws>/<conv>/<sha256>/<random>`, then copies the upload's object to it with `get` and `put` with the upload's SHA-256, which R2 checks. The folder then names only the conversation's own blobs, never an `uploads/` key, which the lifecycle rule deletes a day after it was written. An upload already gone refuses the start ("An attached file is no longer available. Remove it and attach it again."). Loose keys a crash left unclaimed are deleted by an alarm.
4. **Conversation DO, in one transaction:** on a refusal, deletes the marker and answers the API with the refusal's status and message; on success, stores the message, the run (`queued`, attempt 1, `activated` false), the snapshot, and the base version with the copies (claiming their loose keys), sets an alarm, and answers. If a cancel arrived during the awaits, the run is stored as cancelled.
5. **Activation:** the Conversation DO then calls `activate(runId)`, which turns the reservation into consumption (the Workspace deletes the upload rows and objects). It is idempotent and answers where the registration stands: active, revoked with its reason, expired, or ended. Until an answer arrives, the Conversation DO sends it again on its alarm and whenever its constructor runs, for every stored active run not yet `activated`; a run that comes back revoked stops with that reason, and one that comes back expired fails (`start_expired`). A Conversation DO that restarts with a `starting` marker calls `beginRun` again; the Workspace DO's alarm releases reservations not activated within ten minutes and marks those runs expired, so a late `beginRun` result cannot start them.

The snapshot holds policy layers, tool refs and fingerprints, instructions with the start time, model alias, base folder version, attachments and deadline.

### Strict revocation

The Workspace DO's transaction that changes grants, removes a connection or changes an agent's connection set is the commit point; the acknowledgement barrier after it is the enforcement point.

1. In that one transaction it applies the change, marks every affected registered run `revoked`, and writes one outbox entry per run.
2. It delivers each entry: `cancel(runId, reason)` on the run's Conversation DO, which sets the run's local `revoked` flag and stops the run with "Stopped because permissions changed." and the matching code (a deletion's cancel and an emergency stop end with "Stopped.", codes `cancelled` and `emergency_stop`).
3. The API answers the browser only after every delivery is acknowledged. An entry that fails is retried by the Workspace DO's alarm until acknowledged; the request answers 503 if that takes over 10 s (the change stays saved and the runs are stopped shortly after).
4. A cancel for a run the Conversation DO has not stored yet leaves a tombstone, so step 4 of a start stores it as cancelled.

The executor checks the local `revoked` flag and the run's state synchronously, with no await in between, immediately before it dispatches any provider request, and again before it returns a result. Once the browser is told the change is saved, no new provider request starts under the old permissions; a request already sent may complete ("no further effects", not rollback). Between the commit and the acknowledgement, a run may still start a request. A grant change cancels all of the user's active runs, queued included.

**Emergency stop.** Busy objects keep running their old code for minutes after a deploy, so a security fix cannot rely on a deploy reaching running turns. An operator command cancels every active run in a workspace or in all of them, through the same outbox.

### The harness

PiHarness (`agents/harness/pi`, agents 0.28.0) runs pi-durable 1.2.0 in the Conversation DO, which extends the Agents SDK's `Agent` and attaches it with `this.lifecycle.use(...)`; pi's tables live in the object's SQLite. Requirements, each from the spike:

- `settings.contextRetentionMs: 0`, since pi otherwise keeps every object active, and billed, for 10 minutes after each turn;
- one extension, `minerva`, registers the tools; a new pi session per run (`sessions.create()`), submitted once with `operationId: run:<id>` (idempotent) and the conversation's history (`conversation/history.ts`: the latest 20 messages, each clipped to 30,000 characters, newest first within 120,000); steers and follow-ups (`whenBusy`) work and come later;
- the model through our provider wrapper (below), never `createAI`'s default AI Gateway, which logs prompts;
- tools honour `context.abortSignal`.

**Model.** pi-ai, with Workers AI by default (`@cf/zai-org/glm-5.3-flash`: all 10 models tried made the right calls; this one was the cheapest, about $0.00015 for a two-read, one-write turn) or an OpenAI or Anthropic upstream, both through the instance's own AI Gateway with prompt logging off, so no model key is in the Worker. Model settings come from configuration (`MINERVA_MODEL_*`). The wrapper forces the model, the output cap and `store: false`, sends only text, images and function tools, refuses hosted tools, stored-item references and file inputs, and taps the stream for deltas. Images reach the model through pi's `read` (a file the user attached is in the conversation's folder): the model pi sees takes images when its upstream does (Workers AI and OpenAI models as pi-ai's catalog says, an OpenAI model it does not know and every Anthropic model always), at most 2000 pixels a side and 1.5 MB of base64, since pi keeps a tool's result in one SQLite row and a row holds at most 2 MB. A larger image is shrunk by the Images binding (`src/conversation/images.ts`), outside the isolate: pi-durable's own processor, Photon, decodes in WebAssembly memory, 241 MB for a 12-megapixel photo. A model that takes text only gets pi-ai's placeholder instead of each image. No provider text reaches pi's state, its events or the logs: a failure's text is replaced (a context overflow by our own words that pi-ai still classifies as one, so pi compacts and asks again), createAI's diagnostics, which copy it, are dropped from every message, and the log gets the failure's kind, status, class and createAI's code.

### Attempts and recovery

pi has no restart limit and no notion of Minerva's attempts, so the Conversation DO keeps them. The first execution is attempt 1; there are at most 3.

Measured with 112 injected deaths across tool, model-stream, factory and submit crashes, memory-limit resets and caps, plus controls; reviewed adversarially:

- **Where the gate runs: first in PiHarness's harness factory**, before `Harness.open`. pi exists only once the factory returns, and every event that opens pi (alarms, requests, RPCs) goes through it, so nothing of pi runs before the gate. The constructor is not usable: the platform sometimes builds an instance, never delivers it an event and discards it (6 times in about 115 restarts), and a constructor counter counted each of those as an attempt.
- **What counts as a restart:** the factory running in a new instance while an *activated* `provisioning` or `running` run has unsettled pi work: its submission (`storage.submissionByRequest(conversationId, "run:<id>")` on the factory's `storage`) is queued or placed, or its session has live tasks (`storage.scanTasks`), background ones included. Queued runs belong to the start protocol: they get no attempt and no marker, and are never submitted to pi before activation. A settled submission with no live tasks is no restart; the run is reconciled from pi's record. PiHarness's own `pending()`, `busy()` and `sessions.list()` cannot be used here: they wait for the open in progress. Controls that must not count, and did not: a turn, idle hibernation and a second turn; an 11-minute tool across 24 alarms; a 150 s model retry handed to the alarm; a redeploy during a turn.
- **The gate's decision**, in one `transactionSync`, then `await ctx.storage.sync()` before `Harness.open`, so a crash right after the gate cannot lose the count: if the deadline has passed, the run ends as `timed_out` ("The run took too long."); if this would be attempt 4, or under 30 s remain, it ends as `worker_exited` ("The worker stopped unexpectedly."); otherwise the attempt is incremented and the restart marker `{status: "provisioning", attempt: N}` appended (then `running` when the loop resumes), before pi does anything. The once-per-instance flag is set only after the decision is committed, so a factory that throws retries the gate on the next event.
- **Stopping pi** when the gate ends a run: after `Harness.open` and before the factory returns, every live task of the run's session, background compactions included, is marked with `pi.abortTask` and queued inputs are withdrawn with `pi.abortSubmission`, all in one synchronous stretch, so the scheduler reserves nothing meanwhile; the abort handlers run after `pi.resume()`. Measured: no tool execution or model call afterwards; the tool result reads "was aborted", the submission ends unanswered, and PiHarness's wake job and alarm are cleared. Deleting the wake job is not a stop (pi resumed on the next request), and `session.reset()` is not either. As a backstop, the model wrapper and the executor refuse calls for runs that are not current.
- **A start that crashed before pi had its input** has no wake-up of its own: a Lifecycle job (`watch:<run>`, 20 s) wakes the object. `this.schedule()` did not fire in the spike.
- **Timing.** The gate costs nothing measurable; recovery waits for PiHarness's 30 s heartbeat (p50 29 s, at most 60 s), so a crash in a run's last minute usually ends it. pi's retry delays stay at or under 60 s, so a long wait is never mistaken for a restart.
- **Deploys** usually leave a busy object on its old code until it is idle, but the platform can reset a busy object on a code update; that counts as a restart, whatever the cause.
- **Not covered:** a deterministic crash before the factory (in the Agent's own start-up or `openPiSessionStore`) would repeat without being counted; pi does not run in such an instance.
- Writes the dead instance left `dispatched` are marked uncertain by the gate, in the same transaction as its decision (Writes); nothing waits in the gate, which runs under `blockConcurrencyWhile`'s 30 s limit.
- **Replay cap:** safe tools are wrapped with a per-call execution counter in SQLite; a call replayed more than twice is answered with an error instead of running again.
- **Fencing:** every asynchronous operation (a tool call, a credential lease, a script and its reset, a sandbox command, a checkpoint, an event append) carries the run id and the attempt it started under, and is refused when either is not current. The one exception is settling a write that an older attempt already dispatched, which is always recorded. The Workspace DO knows runs, not attempts, so the Conversation DO checks a lease's attempt before and after asking for it; the Scripts DO keeps the newest run and attempt it has run a script under and refuses a reset from an older one, since a reset aborts every guest it loaded.

What the user sees: if a turn's instance dies mid-answer, the next attempt picks the answer up from pi's last commit, the chat drops the earlier attempt's streamed text, a read that was cut off runs again, and a write that was cut off does not (the model is told and can check; asking for the same write again gets the first one's outcome). The folder goes back to its last checkpoint.

### Writes

The write ledger lives in the Conversation DO's SQLite (`gateway/ledger.ts`). The write key (SHA-256 of the label `minerva:write-key:` and the RFC 8785 canonical JSON of the tool and its normalized arguments; query hashes, operation fingerprints and folder-version digests hash the same way under labels of their own, `lib/canonical.ts`) is claimed before dispatch; one write is dispatched at a time per run, with its deadline fixed at dispatch; refused writes are forgotten, applied ones recorded (with `applied_without_result` when the response was unusable), unknown outcomes marked uncertain, which pauses every later write in the run; writes still dispatched 30 s past their deadline are marked uncertain by an alarm. A write is dispatched by the instance that may die, which can then never settle it, so the restart gate marks every write of the run still `dispatched` as uncertain in its own transaction, and the new attempt's later writes pause. Deduplication is by key within the run, so it also catches a model that retries an interrupted write under a new pi call id (measured in the spike). A write settles in the DO that dispatched it, under `ctx.waitUntil`, even if the tool call that asked for it was cancelled. A claim and a settlement are made only while no asynchronous transaction of pi's is open on the object's storage: one made inside it would roll back with it, and a claim the executor was told was dispatched would leave nothing for the restart gate to mark uncertain. The same holds for every change someone acts on once it is made: a revocation, a cancel, a start, a run's end, the attempt gate's decision, a call's `tool_call` event and the replay cap's count all go through `outside` (`conversation/store.ts`), which waits until no such transaction is open and makes the change with no await in between. Only progress (deltas, phases, usage counts) may run inside pi's transaction; rolled back with it, it was never announced either.

### Credentials and refresh

Credentials are encrypted in the Workspace DO with `MINERVA_ENCRYPTION_KEYS`, as are the secrets of dynamically registered OAuth clients in D1, with WebCrypto AES-256-GCM (`lib/encryption.ts`). A value is one envelope, `m2.<key id>.<base64url(nonce ‖ ciphertext ‖ tag)>`: `m2` is the format version, the nonce 96 random bits, the tag 128 bits, and anything malformed, truncated, re-spelled or of another version is refused. Each purpose (`credential`, `oauth-client`) has its own key, derived from the secret with HKDF-SHA-256 (a fixed salt, `info` = `minerva/m2/<purpose>`). The associated data is the canonical JSON of the format version, the key id, the purpose and the row (a credential's workspace and connection ids, allocated before encryption; an OAuth client's provider, redirect URI and client id), so an envelope copied to another row, workspace or purpose does not decrypt. A derived key is good for at most 2^32 encryptions (random nonces); rotating the key is the remedy. AEAD does not stop an older envelope of the same row from being written back. The credential generation fences that for Minerva's own writes: every write of credentials (a reconnect or a refresh) is a compare-and-set on the generation it read and moves it to the next, so a stale result is discarded (below). Someone who can write the object's storage directly can roll a row back, which no key held beside that storage can detect. Data stored with the earlier Fernet format is refused with a message to reset the instance's data. A refresh is single-flight per connection in memory and fenced by the credential generation in storage:

- Before calling the token endpoint, the DO records `refreshing` at generation g. On success it stores the new tokens as g + 1 and clears the state.
- A `refreshing` state found after a restart means the outcome is unknown: the provider may have rotated the refresh token. The connection becomes `refresh_uncertain`, and the next use makes exactly one refresh with the stored token. If that succeeds, the connection is normal again; if the provider refuses it (`invalid_grant`), the connection is marked "Needs reconnecting". No other request uses the connection while it is `refresh_uncertain`.
- A reconnect or delete during a refresh wins: the refresh's result is discarded when the generation moved. A reconnect that finds a refresh in flight in the same instance first waits for it and reads the credentials again, so the refresh token it keeps is the one the refresh stored (`workspace/core.ts`).

### Checkpoints

A turn's folder is saved at quiet moments, driven by the Conversation DO, so no result pi records describes files the store lacks:

1. close admission to new local calls; 2. wait for running ones; 3. `cgroup.kill` the agent cgroup and verify it is empty; 4. scan the folder as the dropped user; 5. stream changed files from the container into R2 (the Sandbox DO writes R2 itself, so file contents never cross an RPC, which is limited to 32 MiB) and verify each hash; 6. record the checkpoint for the current attempt on top of its previous one; 7. release the held tool results to pi.

A round of reads needs no checkpoint. If any step fails, the Conversation DO calls `ctx.abort()` before releasing results, so pi never commits them: the attempt ends, recovery starts the next one from pi's last commit, the held calls come back as interrupted, and the container is replaced from the last checkpoint. A failed checkpoint ends the attempt without recording the result.

The run keeps only its last checkpoint, which becomes the conversation's next version when the run ends, however it ends; the run records what the turn added, changed and deleted, and what the scan could not keep (symbolic links, special files, unreadable entries, names too long or deep). A folder over its size or entry limit is not saved in part: the turn fails and says which limit it hit.

### The sandbox lifecycle

A Sandbox DO per conversation runs one container per turn: `durable_object` scheduling policy, instance `standard-1` (1 vCPU, 4 GiB; `lite` takes about 100 ms per exec and moves 1–4 MB/s), `enableInternet: false`, and no outbound intercepts, so it has no route out (other ports time out; 80 and 443 accept and then reset). Nothing secret is passed to its environment, since a root process can read PID 1's.

Hardening is a state machine recorded with the container's incarnation id: `starting → hardening → verified → in_use → destroying`. Before `verified`, no agent command or file operation is admitted. One root `exec` runs, with `set -eu`:

1. a tmpfs `/workspace` with `size` and `nr_inodes` set to the folder limits, owned by uid 1000, so a full folder fails with `ENOSPC` at the size the store counts;
2. a tmpfs `/tmp`, `noexec`, with `/tmp/home` and `/tmp/matplotlib` owned by uid 1000 (bash's `HOME` and `MPLCONFIGDIR`);
3. a cgroup `/sys/fs/cgroup/agent` with `pids.max` (256) and `memory.max` set to the base (1 GiB) plus both tmpfs sizes: pages the agent writes to a tmpfs are charged to its cgroup, so with the base alone a growing folder would OOM-kill commands instead of failing with `ENOSPC` at the folder's limit;
4. `mount -o remount,ro /`.

A second `exec` verifies each postcondition (mount options and sizes, `/tmp` not executable, the home directories and their owner, `/` read-only, the cgroup's limits equal to the spec's, that the dropped wrapper reports no capabilities and `NoNewPrivs: 1`). Any failure, or any doubt, destroys the container and fails the turn. A Sandbox DO that restarts never reuses a running container it did not verify in its current incarnation: it destroys it first. If `destroy()` fails, the DO keeps `cleanup pending` and retries on an alarm. Every operation on the Sandbox DO, `destroy` and cleanup included, names the incarnation (and the run and attempt) it is for, and is refused for any other, so a late cleanup from one attempt can never destroy the next attempt's container.

Every agent command runs through one wrapper: `echo $$ > /sys/fs/cgroup/agent/cgroup.procs || exit 125; exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs timeout -k 5 <s> bash -c "$0"`, with the command as an argument, never interpolated. `cgroup.kill` ends leftover processes, `setsid` ones included. A kill first closes the gate to new wrapped processes and waits for those already starting to join the cgroup (or fail), so none joins after it was found empty. Commands run without network, with a timeout of 10 minutes unless the model asks for longer, never past the run's deadline, and with only the tools in the image (`container/`): Python with document, spreadsheet, plotting and data libraries, poppler, ripgrep, jq, sqlite3 and similar.

**File operations run as the dropped user too.** pi's `read`, `write` and `edit` go through `minerva-fs`, a Python helper on the read-only root, run as `python3 -I -S /opt/minerva/minerva-fs …` through the same wrapper: isolated mode, so nothing the agent writes can change it; paths as arguments, never interpolated; bounded reads. Where a path must stay inside `/workspace` (the scan, hydration, checkpoint reads), it is walked one component at a time with `openat`-style calls relative to directory descriptors, each with `O_NOFOLLOW`, so a symlinked parent cannot lead outside; files are opened with `O_NONBLOCK` and accepted only if `fstat` says regular file. pi's own tools keep pi's semantics for paths the agent names, but run without privileges, so a link out of `/workspace` reaches only what uid 1000 may read on a read-only root. Root is used only for hardening, verification and `cgroup.kill`. The SDK's `Files` (which runs as root) is not used on agent-controlled paths.

**The local tools** are pi's own, given an `ExecutionEnv` (`@earendil-works/pi-durable/env`, `FileSystem & Shell`) that forwards to the Sandbox DO; it passes pi's conformance suite (24 cases). `read` is wrapped to be replay-safe. If the Conversation DO restarts mid-turn it loses its `exec` handles: calls in flight come back as interrupted and the container is replaced from the last checkpoint.

### Code mode

When a run has tools, the agent also gets `run_script`: a script that can only call the same tools, for example to make independent reads at once or to filter long results before they reach the model. Each call is an ordinary checked call, recorded and shown as a card; only what the script prints or returns reaches the model. Its description states the runtime's limits: a guest may use about 256 MB (there is no lower setting), computation is cut by `cpuMs` (30 s, or the wall clock when shorter) a few seconds late, timers exist, and `eval` does not.

Each script is a Dynamic Worker loaded with `globalOutbound: null`, no `env` and `limits.cpuMs` by the per-conversation Scripts DO itself, so a CPU-bound script blocks that object, never the conversation. The Conversation DO enforces the wall clock (120 s, cut to the deadline); on timeout, pi's abort or the script's refusals it stops the RpcTarget (later calls get a promise that never settles, so a stopped guest that awaits one stops; past 100 of them more are answered at once, so they cannot fill its memory), lets dispatched writes settle, and the Scripts DO resets itself (`ctx.abort()`) as soon as it hears of the stop, or when its call to the conversation breaks (the conversation is gone). After every script, stopped or not, the conversation resets the Scripts DO with the script's fence, and its next script waits for that reset within its own wall clock, so timers and unawaited work a guest left end and the object's 10 Dynamic Worker slots stay free. The guest's only capability is that RpcTarget, which applies the caps (100 open calls, 256 KB of arguments, stop after 100 refusals, the output limits) and queues calls with the direct ones; a long output or value crosses as its head and the size of the rest, and the conversation cuts the result exactly as pi would (1 MiB, pi's own note). `@cloudflare/codemode` is not used: its replay re-ran an interrupted write (measured), and its executor's timeout can be switched off by the script. Of the two teardown recipes the spikes found, only the reset ends a guest that ignores its stop (measured on the account with the code mode lab, cloudflare/README.md).

### Events and the stream

Events are appended to the Conversation DO's `run_events` with dense per-run sequence numbers; a refused append takes no number. Their types and payloads are the contract's (`contract/`), with values such as `text_delta` and `timed_out`. Text and reasoning deltas come from a tap on the provider stream, flushed every 0.25 s per model call with the call's 8-hex id; the restart marker before a new attempt makes the frontend drop the earlier attempt's text. History replay into a run reads our `messages` table (final text and file notes only), never pi's transcript, so pi's aborted partial entries never reach the next turn.

**Reading runs.** Workers RPC refuses arguments and results over 32 MiB, and a conversation's events have no retention yet (open question 5), so no Durable Object method returns more than a page of them: `getConversation`, `getRun` and `cancelRun` return runs without events but with the seq of their last event, read with their status, and the Worker streams the API's body (each run with all its events), paging each run's events with `getRunEvents` up to that seq. A platform test covers a conversation whose events pass 32 MiB.

The browser's `EventSource` connects to the stateless Worker, which checks the session and the run's owner, opens a hibernatable WebSocket to the Conversation DO with `after`, and relays frames (`id`, `event`, one-line `data`, 15 s keepalive comments, `end` when the run is inactive and caught up). The DO sends the backlog and subscribes in one synchronous step, so no event falls between them. Hibernatable sockets outlive the instance that accepted them, and one that died may have committed events it never sent: each socket is tagged with the instance that accepted it, and any other instance never writes to it (no frame, no `end`) but closes it with 1013, as it does every socket it inherited when it starts, so the client reconnects with `Last-Event-ID` and gets what it missed, then `end`.

- **Backpressure:** the DO drops a socket whose buffered amount passes a limit, and the Worker closes the SSE response when its own stream's queue stays full; either way the client reconnects with `Last-Event-ID` and loses nothing.
- **Session during a stream:** the Worker checks the session again every 60 s and on every reconnect, and closes the stream when the session has ended (sign-out, password change, expiry) or the user is no longer a member of the workspace.

The chat folds the agent's work into one row per stretch ("Used 3 tools"); a call the permissions refused stays a card of its own. Agent text is rendered as Markdown, but images are shown as text and never loaded, and the Content Security Policy blocks remote images: otherwise prompt-injected text could send data out through the browser.

## The web API

The JSON API is one oRPC contract (`contract/`: method, path, input, output and typed errors, camelCase fields), which the Worker implements in `src/api/` and the frontend's client derives from (`frontend/src/lib/orpc.ts`). Errors keep the `{detail}` shape and the 422 list carries zod's messages; the Worker checks CSRF (double submit plus `Origin`) on its own routes. A message may carry an `Idempotency-Key`. Accounts and sign-in use **Better Auth** (MIT, version pinned); the frontend uses its client. The product plan moves all of this to Laravel and keeps only an internal API and the stream in the engine. The internal API is in `contract/src/internal/` and served under `/internal/v1/` to Laravel alone, with a Cloudflare Access service token the Worker checks again; its design is [docs/plans/contract.md](docs/plans/contract.md).

- **Library and storage.** Better Auth 1.7.7 (exact) runs in the Worker at `/api/auth/*` on D1 through its Kysely adapter. Its tables (and its plugins') are created by our D1 migrations from the schema its CLI generates (`pnpm auth:schema`). Plugins: email and password, email OTP (verification, sign-in and reset codes), two-factor (TOTP with backup codes), organization (organizations and members, read-only through the API for now) and admin (the instance admin's role only; its endpoints are not exposed). Only the routes in an allowlist (`BROWSER_ROUTES`) reach it, and its own routes check its trusted origin.
- **Passwords** use Better Auth's scrypt (N 2^14, r 16, p 1; about 30 ms locally). A login with an unknown address takes as long as a wrong password.
- **Sessions** are Better Auth's database sessions in D1 behind an HttpOnly, SameSite=Lax cookie (`minerva.session_token`; `__Secure-` and Secure with debug off), 14 days, extended daily, read from D1 on every request (no cookie cache; our routes through `currentSession`). A password reset ends every session, and a password change can end the others. Sensitive account actions ask for the password each time.
- **Organizations and workspaces.** A sign-up creates, in Better Auth's hooks, a personal organization the user owns and our row for its personal workspace with our membership; the Workspace DO is initialized right after; if that failed, the next sign-in or `/api/me` repairs the organization, membership and workspace (all idempotent), and `/api/me` leaves out a workspace until it is initialized. Workspaces and their memberships stay our tables, keyed by Better Auth's organization and user ids. The UI does not show organizations yet.
- **Email** codes are written to the Worker's logs only when `MINERVA_DEBUG` is true; otherwise they go through the `EMAIL` binding (Cloudflare Email Sending, in beta, from a sending subdomain of the production zone), and `/api` answers 500 without one. The test build has no binding: its emails go to a mailbox the driver reads, for the account tests.
- **Rate limits** are Better Auth's per IP (from `cf-connecting-ip` only), stored in D1, with a rule of our own for every route the browser reaches (`src/accounts/ip-limits.ts`).
- **Seed accounts** (`pnpm run seed`) are created or reset through Better Auth's API by `POST /api/dev/seed`, which exists only with `MINERVA_DEBUG`.
- **Accepted trade-offs** of using Better Auth as it is (decided by the owner, 2026-10-13): no limit per account on password guesses and none per address on code emails, only per IP (two-factor covers guessing for users who turn it on); a TOTP code can be reused within its window of about 90 seconds; a trusted device can skip the second factor for 30 days from its last use, and a reset does not end that (the client does not offer it); a session made while a reset runs stays alive until it is revoked, since sessions in use are renewed; a password change already in flight can overwrite a reset, which an attacker with the password and a live session could use, though they could lock the owner out more simply with their own authenticator; and a wrong email code checked while a resend runs can bring the older code back, so the resent one fails and the owner asks again. Better Auth's D1 adapter has no interactive transactions, so its multi-row operations are separate statements.

## Files

Each conversation has a folder that the agent works in as on a laptop: pi's ordinary `read`, `write`, `edit` and `bash` tools on a real directory, called in parallel. A turn downloads its starting version into `/workspace`; checkpoints save it back (Checkpoints). Users attach files to a message, download any file of a version the conversation's runs started from or produced, and see each command and its output in the chat.

- **Store.** File contents are blobs in R2 under keys of their own, named by SHA-256 with a random part, so deleting an object never races a re-upload of the same contents. A folder version is an immutable manifest in the Conversation object with a parent and a digest; a conversation points at its current one.
- **Uploads** stream into R2 while hashing (`body.tee()` into `crypto.DigestStream` and `put`, about 550 ms CPU per 50 MiB). The edge buffers a request body before the Worker runs, so checks before the body cannot save bandwidth; the 100 MiB request limit is above the 50 MB file limit. The media type is sniffed from the content and the name cleaned to one valid path segment. Sending a message copies its uploads into the conversation's blobs, added at the folder's root (numbered when the name is taken) (Starting a run, step 3); the bucket's lifecycle rule deletes every `uploads/` object a day after it was written.
- **Every object is recorded before it is written**: the Workspace DO records an upload as `pending` (with its key and a byte reservation against the workspace's quota) before the `put`, and as complete after it; the Conversation DO records a checkpoint blob's key before the Sandbox DO writes it, and claims it when the checkpoint is recorded. Contents the conversation already stores get no key: the Sandbox DO only hashes the container's bytes (`crypto.DigestStream`), as proof the run has them, and the run is granted the stored blob, so nothing is written, recorded or counted against the quota. Alarms delete pending and unclaimed objects older than an hour and release their reservations, so a crash between the record and the write leaves nothing that is not eventually removed, and counters stay right.
- **Downloads** are links signed with HMAC (`MINERVA_DOWNLOAD_KEY`) over the download origin, workspace, conversation, version, path, user and an expiry of five minutes, served by `minerva-cf-files` on its own origin, which also checks the request's host, with `Content-Disposition: attachment`, `nosniff` and `Content-Security-Policy: sandbox`. Agent files are never shown inline from the app's origin. Neither Worker has preview URLs: every uploaded version would stay reachable at an origin of its own, with the bindings of its day, and versions cannot be deleted. A link is a bearer capability until it expires: signing out does not revoke one already issued.
- **Files are untrusted.** Attachments and agent files are parsed in the sandbox, never in the Worker (the OneDrive connector's Office reader is an exception). A run reads only blobs from its starting version, its last checkpoint, or its own uploads, and an upload is hashed even if the store has it, so knowing a hash does not reach another conversation's file. Every manifest's paths are validated, and sizes come from the store's own records.
- **Limits** (settings): 256 MB and 10,000 entries per folder (`/workspace` is a tmpfs of that size); uploads by a run up to four times the folder size; 50 MB per attached file and 10 files per message; paths of at most 1,024 bytes and 32 levels; optionally a total per workspace.
- **Encryption.** Blobs use R2's own encryption. Per-workspace keys (SSE-C, proven in the spike) are a later step: both Workers then hold a derivation secret and derive the workspace's key; keys never appear in links.
- **Deletion** of a conversation (or an agent, which deletes its conversations) tombstones it in the Workspace DO and the Conversation DO first, after which both refuse new runs, uploads and object writes; cancels its active run through the revocation outbox and waits for the run to end (its container destroyed and its Scripts DO reset); then deletes the Conversation DO's storage and the R2 prefix, and deletes the prefix again an hour later to catch any write that was already in flight. An alarm finishes an interrupted deletion.

Unlike a laptop, processes left running are killed at each checkpoint, commands have no network, a crash can lose changes since the last checkpoint, and only regular files and directories are kept. Folders move between R2 and the container per file, which is slow for many small files (500 files, 50 MB: a checkpoint takes about 19 s).

## Configuration

| Name | Kind | Notes |
|---|---|---|
| `minerva-cf` | Worker | The app: assets, `/api`, the DO classes, the container |
| `minerva-cf-files` | Worker | The download origin; holds the R2 binding and the link key |
| `minerva-cf` | D1 | Primary near Frankfurt (`weur`) |
| `minerva-cf-files` | R2 bucket | Lifecycle rules expire `uploads/` after a day and `static/` (the earlier builds' hashed assets, kept by the Worker) after 30 days |
| `minerva-cf-files-eu` | R2 bucket | In R2's EU jurisdiction, for EU workspaces; the same rules (it never holds `static/`) |
| `minerva-cf` | AI Gateway | Prompt logging off |
| `minerva-cf-sandbox` | Container application | Built by `cf build` from `cloudflare/container/` |

These are production's names; the test instance's add `-test` (cloudflare/README.md, Names). An instance's operator files live outside the checkout, in its instance directory (`~/.config/minerva/instances/<name>/`, cloudflare/README.md): `secrets.env` holds the Workers' secrets (`MINERVA_SECRET_KEY`, `MINERVA_ENCRYPTION_KEYS`, `MINERVA_DOWNLOAD_KEY`, `MINERVA_SETUP_KEY`, connector clients) and is uploaded by `pnpm run deploy`; `vars.env` holds a deployed build's plain settings. Neither is ever printed. Connector clients (`MINERVA_<APP>_CLIENT_ID` and `_SECRET`) are declared only for the apps whose pair is set (half a pair fails the build); an unset app hides its connectors, except Todoist, which registers a client of its own. Removing a pair stops declaring it but does not delete the uploaded secret. `MINERVA_ENCRYPTION_KEYS` is an ordered, comma-separated list of `id:secret` entries: an id of 1 to 32 letters, digits, `-` or `_`, used once, and a secret of at least 32 random bytes in URL-safe base64, padded or not (`pnpm secrets` writes `v1:` and 43 characters). The first entry encrypts and every entry decrypts, so a key is rotated by putting a new entry first and dropping the old one once no row's key version names it. A malformed entry or a duplicate id is refused with a message saying what to write, by `scripts/secrets.ts check` before a deploy and wherever the Worker first reads the keys. Plain settings (`MINERVA_SITE_URL`, `MINERVA_DOWNLOAD_ORIGIN`, `MINERVA_MODEL_*`, limits, `MINERVA_SIGNUP_OPEN`, `MINERVA_DEBUG`, `MINERVA_EMAIL_FROM`, the sender behind the `EMAIL` binding, which accepts that address only) are text bindings in `cloudflare.config.ts`, checked by the Worker's own parser (`src/config.ts`) at build time. Development and tests read them from the environment; a deployed build reads its instance's `vars.env` alone, which must exist, with https origins and debug off, so a shell's `MINERVA_*` never reach a deploy. `pnpm run deploy` checks that D1, both buckets (with their jurisdiction and lifecycle rule) and the AI Gateway exist, since `cf deploy` would create a missing one with default settings, and applies D1's migrations before uploading code.

**Local development without an account** (`pnpm dev:offline` in `cloudflare/`; cloudflare/README.md, Local development). It runs `vite --mode offline`: the test build's entry with the fake model, `MINERVA_DEBUG` on (emails go to the log), local D1 and R2 under `cloudflare/.cloudflare/state`, no Workers AI or AI Gateway binding and no remote bindings, and the sandbox container only when Docker runs (otherwise the Sandbox class has none and a tool that needs it says so). Its secrets are `cloudflare/.dev.vars` (`pnpm secrets:offline`, gitignored). The mode exists only for the dev server: `cloudflare.config.ts` refuses it unless `vite.config.ts` has marked a serve (`MINERVA_DEV_OFFLINE`), its names are `minerva-dev…` and its D1 id is a placeholder, so it cannot be built or deployed by accident (a source rule in `sources.test.ts` checks).

**First-run setup.** `pnpm secrets` generates `MINERVA_SETUP_KEY` (32 random bytes) with the other secrets; the operator reads it from `secrets.env`. Signed in, `POST /api/setup` with the key in the `X-Minerva-Setup-Key` header makes the caller the instance's first admin (Better Auth's `admin` role, which `/api/me` reports as `user.role: "admin"`; apart from organization and workspace roles). The claim is one row of D1's `instance_setup`, written with the role in one batch, so it succeeds once; later claims are refused (`ALREADY_SET_UP`). Sign-up is by emailed code (the password is set right after); on an instance whose sign-up is closed, the same header on those email-code requests admits the operator's own sign-up until setup is done, and the code proves the address as for anyone else. Instance admins then manage `GET`/`PATCH /api/instance/settings` (`signupOpenOverride` overrides `MINERVA_SIGNUP_OPEN`; null follows it) and `GET`/`POST /api/instance/admins`, `DELETE /api/instance/admins/{userId}` (the last admin cannot be removed), and remove another user's two-factor with their sessions, `POST /api/instance/users/remove-two-factor`, to recover a taken-over account after the owner resets the password. Rotating the key after setup changes nothing; an instance whose admins are all gone is repaired by setting a user's `role` to `admin` in D1. All of this goes when Laravel takes over accounts (product-and-engine.md, chunk 13).

**Deploys and resets.** A deploy builds, checks (secrets, that the test build's code is not in production, buckets and their lifecycle rules, the database's schema against the migrations, the Worker's startup CPU), applies additive migrations and uploads the two Workers. Old and new versions run side by side for a while, so storage changes stay additive (Spike results, Versions). Code and settings can be rolled back; a change to the Durable Object classes cannot. Emptying an instance (`scripts/reset.ts`) retires every class so that Cloudflare deletes its objects, empties and recreates the buckets, and recreates D1. Logs are Workers Logs. Production is deployed by hand.

## Repository layout

```text
cloudflare/                the engine (cloudflare/README.md)
  cloudflare.config.ts     the app Worker, bindings, DO classes, container
  package.json             pnpm, exact versions
  migrations/              D1
  src/
    index.ts               fetch handler, exports
    http/                  router, errors, cookies, CSRF, headers, SSE relay
    accounts/              Better Auth's configuration and policy, provisioning, TOTP steps, instance admin, email sender, seed
    api/                   workspaces, agents, conversations, connections, access, OAuth, uploads
    internal/              the internal API Laravel calls: Access, the commands, the catalog
    laravel/               the engine's client of Laravel
    workspace/             Workspace DO: registry, revocation outbox, credentials
    conversation/          Conversation DO: runs, attempts, events, history, loop, tools
    gateway/               executor, policy, write ledger, page tokens, OAuth
    connectors/<name>/     the 20 connectors
    files/                 manifests, versions, store, uploads, folder_changes
    sandbox/               Sandbox DO, lifecycle, ExecutionEnv, checkpoints
    scripts/               Scripts DO, guest prelude, run_script
    model/                 provider wrapper, request policy, stream tap
    faults/                the test build only: fault points, the fake connector, the driver
    lib/                   JSON, canonical JSON, AES-GCM, text, dates, HTML, hosts and addresses, SQL
  files-worker/            the download origin
  reset-worker/            the quiesced Worker a reset deploys
  container/               Dockerfile, Python requirements, minerva-fs, probe
  scripts/                 instances, deploy, reset, secrets, the account suites' runner, offline development
  test/                    vitest: unit, platform, docker, account
contract/                  the API's oRPC contract, shared by the Worker and the frontend; the internal API's, with its OpenAPI documents
frontend/                  the React app (Vite, TanStack, assistant-ui) the Worker serves as static assets
design/                    the logo's sources
docs/                      connectors, images, plans
```

## Testing

- **Unit tests** (`pnpm test:unit`) with Vitest in Node for everything that is plain TypeScript: `lib/`, the policy (with a randomized equivalence test, seed 7), the executor with fake connectors and an injected `fetch`, each connector against scripted provider answers with inline expectations, manifests and `folder_changes`, the objects' logic over SQLite, history replay, event rules, and rules on the sources (`sources.test.ts`: no `JSON.parse` outside `lib/json.ts`, no `z.coerce`, nothing of the test build reachable from production's entry, no other file naming an instance's resources).
- **Docker tests** (`pnpm test:docker`, `test/docker/`) run the Sandbox against the real image in a local container; the unit tests need no Docker.
- **Platform tests** (`pnpm test:platform`) run the Worker locally in workerd with `@cloudflare/vitest-plugin`, which loads `cloudflare.config.ts` itself (remote bindings off), for the DOs, D1, R2 and the HTTP API, including tenancy (every endpoint refuses other workspaces; an EU workspace's objects and bucket are separate from a default one's, through the local seam, since workerd has no jurisdictions), CSRF on every unsafe route, and the frontend's contracts (its client against the Worker, SSE frames, upload and download headers).
- **Fault-injection tests** with a deterministic fake model and fake providers, for every protocol above:

| Protocol | Failures injected |
|---|---|
| Start and revocation | revoke before the run exists, during `beginRun`, after; crash during the attachments' copy; crash between storing the run and `activate`, and a lost `activate` answer; crash after the grant commit; lost cancel acknowledgement; start concurrent with revoke |
| Attempts | crash in a safe tool, in an unsafe tool, during the model stream; repeated memory-limit resets; hibernation between turns; a long tool across alarms; a late call from an old attempt |
| Writes | applied then response lost; claimed then never sent; crash while dispatched; the same write under a new pi call id; deadline passed |
| Refresh | crash during a rotating refresh; reconnect during a refresh |
| Sandbox | each hardening step failing; cgroup admission failing; lost `destroy()`; restart with a container still running |
| Checkpoints | detached writer; FIFO, symlink, oversized file; crash between upload, record, release and pi's commit |
| Scripts | CPU-bound guest; timeout during a write; calls after return; more than ten scripts in a row; a late reset from a replaced attempt; the conversation lost during a script |
| Stream | slow client; append during reconnect; reconnect after a deploy |
| Files | attach retried; upload during deletion; lost R2 acknowledgement |

- **Account tests** against a deployed instance (`pnpm test:deployed`), and the fault tests that need the real platform against the test Worker `minerva-cf-test` (the same code built with a fake connector, fault points and a token-gated driver; cloudflare/README.md, The test Worker): the token-gated `/api/probe` (one RPC to each Durable Object class without and with the EU jurisdiction, D1's applied migrations against `migrations/`, the runtime's JSON parser), that neither Worker has preview URLs, the container and the sandbox probe, Dynamic Workers, Workers AI, the fault tests that need the real platform (memory-limit resets, deploys mid-turn), two end-to-end turns (fake model, Workers AI) that run a command, a script and publish the folder, and a walkthrough in a real browser (`pnpm test:browser`).
- pi's `ExecutionEnv` conformance suite runs against the container-backed environment.

Every push to `main` runs the unit tests, the platform tests, the engine's and the contract's types, and the frontend's check (`.github/workflows/main.yml`). The account suites run by hand against the test instance (cloudflare/README.md says which a change needs).

## Spike results

Measured on the account on 2026-10-10 (Workers Paid, Frankfurt), with `cf` 1.0.0-beta.13, its `cloudflare.config.ts` format and Vite. Full reports are kept outside the repository.

| Spike | Result |
|---|---|
| PiHarness | Worked with pi-durable 1.1.0 and 1.0.3. Two reads in parallel then a write, from one prompt; idempotent submit; steer and follow-up; recovery after `ctx.abort()`, memory-limit resets (7 in a row, no cap) and an interrupted model stream, each about 30 s later; a redeploy mid-turn interrupted nothing; a 17-minute tool call completed. After an interrupted write, the model retried it under a new call id. First text delta 2–4 s after submit. pi-mcp works; pi-codemode does not (no `worker_threads`). `contextRetentionMs` must be 0, or every object stays active 10 minutes after each turn. |
| Sandbox | A Firecracker microVM (KVM, kernel 6.18). With `enableInternet: false` and no intercepts: ports other than 80/443 time out, 80/443 accept and reset, DNS answers nothing, metadata and other containers are unreachable. Processes have root's capabilities until `setpriv` drops them; tmpfs size and inode limits give `ENOSPC`; `/` can be remounted read-only; a cgroup bounds pids and memory and `cgroup.kill` ends strays. `standard-1`: start 0.3–0.5 s, `exec` 6 ms, 50 MiB out in 1.5 s. A root fork bomb outside the cgroup wedges `exec`. |
| Code mode | Dynamic Workers with `globalOutbound: null` block fetch, connect and WebSockets; `eval` is blocked, so each script is its own Worker (about 12 ms to load). Props on a stub cannot be read or forged. Memory is about 256 MB per guest, with no lower setting; `cpuMs` kills about 2 s late. A busy guest blocks the object that loaded it, and a guest can outlive its host's timeout until that object is reset. `@cloudflare/codemode`'s replay ran an interrupted write twice. |
| Storage and realtime | Request bodies up to exactly 100 MiB, buffered by the edge before the Worker runs. Upload hashing with `tee()` and `DigestStream`: 550 ms CPU per 50 MiB. Downloads from a second Worker keep `CSP: sandbox`; SSE-C with per-workspace keys works. SSE served by a DO keeps it awake; relayed by the Worker from a hibernatable WebSocket, the DO sleeps between events, and neither path dropped a client across deploys. D1: atomic `batch()`, triggers, FTS5, unique-row locks, no `BEGIN`. `fetch()` from a Worker answers private, loopback, link-local and non-Cloudflare IP literals with a 403 (error 1003) rather than throwing (below). Static assets with an SPA fallback and the Worker first for `/api/*`. |

Consequences for the design:

- **Private addresses.** The Web connector keeps its URL and host policy and its same-host redirect rule; the guard against private networks is the platform's refusal, which the connector recognises (a 403 from `server: cloudflare`, `platformRefusal` in `gateway/http.ts`) and reports as a blocked site. That refusal is measured, not documented, and has adversarial tests (rebinding names, `nip.io`, IPv6 encodings, redirects to private addresses) against the deployed Worker. It comes in two forms. A request with an empty Accept header gets the text `error code: NNNN` (1003 for a private, loopback, link-local or non-Cloudflare IP literal, 1002 for a name that resolves to a private address, 1102 for loopback names such as `localtest.me`). A request with any Accept header, which the Web connector always sends, gets Cloudflare's HTML error page instead (text/html, about 6.5 KB, headed `Error` and the code); the connector reads both.
- **Versions.** Busy objects keep their old code for minutes after a deploy and new objects may start on the previous version, so two versions run side by side: Durable Object storage changes are additive only, code accepts rows written by the previous and the next version, and a changed tool still fails through its fingerprint (`OPERATION_CHANGED`). A deploy usually reaches a busy object only once it is idle (and may reset it, which counts as a restart), so revocation, policy and security fixes can never rely on a deploy reaching running turns.
- `/assets/<missing>` would get the SPA shell, cached as immutable by the `/assets/*` header rule; the Worker therefore runs first for `/assets/*` and answers a miss with a 404 (`no-store`).
- The sandbox checks are built for this platform (network checks over HTTP and TLS, not TCP connect) and run against the deployed Worker.
- **JSON keys** (found in Node 24's V8, in workerd 1.20261006.1 and on the deployed Worker): after any JSON text with the key `"\\"` was parsed in an isolate, a later key written with an escape in the same place (`"\n"`, `"\u00e9"`) comes back as `"\\"`. `JSON.parse`, `Response.json()` and Hono's `c.req.json()` are affected, values are not. The state is per isolate, so one tenant's input could change another's parsed keys and the hashes over them; all code parses JSON with `lib/json.ts`'s `parseJson`, and a unit test refuses `JSON.parse` elsewhere in `src/`. A platform test keeps the bug visible in local workerd; on Cloudflare's edge it no longer shows since 2026-10-14 (the deployed probe checks), and `parseJson` stays while the runtimes the tests run in still have it.
- **Dates, text and numbers** follow the runtime and its libraries: `lib/dates.ts` reads RFC 3339 by a strict pattern, checks the calendar fields, reads an offsetless time as UTC (never in the runtime's zone) and checks IANA zone names with `Intl.DateTimeFormat`; Slack's `ts` stays an exact decimal string, converted through BigInt; tool inputs are strict zod objects and provider answers zod schemas, with no coercion (`z.coerce` is refused by a source rule). Identifiers are never normalized with NFKC or NFKD, which join text that should stay apart (NFKC only to refuse or redact, NFC only for file names and manifest paths; `sources.test.ts` checks), and decimal amounts stay their text (`xero/decimal.ts`, `stripe/money.ts`), never floats.

## Status

Built and deployed on 2026-10-10 to 2026-10-13 (the record of each step is in the git history of `docs/plans/cloudflare.md`, removed 2026-10-14): the protocols above with their fault tests, the sandbox and files, code mode, the web API with accounts, all 20 connectors, the deploy and reset scripts. The test instance passes the fault tests, a browser walkthrough and the sandbox probe on the account; a production instance is deployed and holds only the operator's test data. Next is [docs/plans/product-and-engine.md](docs/plans/product-and-engine.md): the Laravel product, the seam between it and the engine, and then the engine's account, connection and public API paths leave this repository.

Known limits: each turn is its own pi session (no steers, follow-ups or background subagents yet); run events, the write ledger and page tokens have no retention period (open question 5); images and documents reach the model only through its tools.

## Open questions

1. Move the executor and the decryption key to a separate Worker script with its own secrets, so the loop's isolate never holds a credential? (The product plan's leases narrow what the engine holds, but not where.)
2. Warm containers: keep a conversation's container between turns for its idle timeout, or start one per turn?
3. pi's state grows with every run (a new session each), and PiHarness cannot delete conversations yet. How large does it get, and does `reset()` or a periodic compaction bound it?
4. A team's Workspace DO serializes its control plane (grants, refresh, run registry). What throughput and revocation fan-out does one object sustain? (Moot once Laravel holds the control plane.)
5. Retention: run events, the write ledger and page tokens grow with every turn. Pick limits per conversation, and measure whether a very long turn approaches the 10,000 subrequests of one invocation.
6. Email Sending is in beta and limited to 1,000 messages a day (moot once Laravel sends the mail).
7. Compliance scope: Containers, Dynamic Workers and Secrets Store are missing from Cloudflare's published SOC 2 and HIPAA lists.
8. Residency of an EU workspace beyond its Durable Objects and bucket: where its container's VM runs (no placement constraint for `durable_object` scheduling), where Workers AI and AI Gateway process its prompts, and its users' accounts, which live in the one D1 database (location hint `weur`, not the EU jurisdiction D1 also offers).
9. Queries across objects. Durable Objects cannot be queried together, so operator dashboards, admin search and analytics across conversations and workspaces need their own path; the product plan answers this with Laravel's database, fed by the engine's facts.
10. Search across a workspace: SQLite's FTS5 works within one object only. The product plan puts search in Laravel (Scout on Postgres).
11. Agent files, later: whether a per-agent switch for commands (`bash`) is needed at launch, and whether file names with format characters (bidi overrides, zero-width) are refused or only escaped where the app shows them. Still intended:
    - images to the model as blob references the model wrapper inlines, re-encoded on upload without metadata, never stored as bytes in pi's state or the run's events;
    - connectors that upload files by path (Drive and OneDrive first, then mail attachments in Gmail and Outlook, and Slack files), each with its own permission checks;
    - warm sandboxes (open question 2), lazy hydration of large files, zip downloads, previews of raster images, project folders that several conversations start from, and branches when a user edits an earlier message.
