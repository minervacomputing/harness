# Plan: Minerva on Cloudflare

Status: experiment, started 2026-10-10 on the `cloudflare` branch (local until it is pushed). This file is the design and the order of work. `main` and its Django, worker and deploy code are untouched; the rewrite lives in `cloudflare/` and reuses `frontend/` unchanged.

## Goal

The same product on Cloudflare's platform, deployed with one command to one Cloudflare account:

- the same React app and the same JSON API (`frontend/openapi.json` plus the allauth headless endpoints `frontend/src/lib/auth.ts` uses), so the frontend needs no changes beyond its dev proxy;
- the same permission model and pipeline, and all 20 connectors;
- the same agent: pi-durable with Minerva's tools, history, code mode and files, durable across crashes, with today's guarantees for writes (deduplicated, never replayed, uncertain ones pause the run);
- a sandbox per turn with no network, now a Firecracker microVM;
- fewer moving parts: no supervisor, no Docker socket, no socket relay, no run tokens, no VPS, no Postgres.

What it should show: which of Minerva's hard problems the platform removes (sandbox runtime, the Docker socket, approvals that hold compute, downloads, deploys, logs), and what it costs (self-hosting, compliance scope, beta dependencies, a larger trusted code base).

Not in scope: self-hosting on a VPS (this shape cannot run there), the demo's features (`backend/demo/`), WebAuthn, social login, data migration from an existing Postgres, team workspaces (as today).

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
R2 minerva-cf-files: blobs, uploads ◄── Worker minerva-cf-files (download origin, signed links)
Workers AI / AI Gateway minerva-cf: models
```

## Trust model

| Zone | Trusted? | Holds |
|---|---|---|
| Browser | The signed-in user | Session cookie, CSRF token |
| Worker and Durable Objects | Yes: our code and its dependencies | Secrets, all state, decrypted credentials for one provider call at a time |
| Sandbox container | **No**, hostile | The turn's files; no token, no route out |
| Script guests | **No**, hostile | One RpcTarget that queues tool calls |
| Model output, provider content, files | **No** | — |

**What changes from today, stated plainly.** Today the agent loop (pi-durable and its extensions) runs inside the hostile container, and a compromise of it reaches nothing but the gateway. Here the loop is trusted code in the Conversation DO, in the same Worker script as the secrets and the executor, so the trusted code base now includes pi-durable, pi-ai, the Agents SDK and their dependencies. A bug or supply-chain compromise in any of them runs with the Worker's bindings and secrets: it could address any workspace's objects and decrypt **every** workspace's credentials, not only its own conversation's. Model output cannot execute as host code: it reaches the loop only as tool names, arguments and text, which go through the permission pipeline as today. Code the model writes runs only in the container and in script guests, which hold nothing and reach nothing.

Mitigations in this plan: dependencies pinned with exact versions and lockfile hashes; credentials decrypted only in the executor, for one call, never stored in pi's state, events or logs; the model request built by our own provider wrapper, which still refuses anything but text input and function tools (a defence in depth, now that the request is not hostile). Later (open question 1): the executor and the decryption key move to their own Worker script, so the loop's isolate never holds a credential.

## What maps to what

| Today | On Cloudflare |
|---|---|
| Django `web` | Worker `fetch` handler: router, allauth-compatible auth, JSON API |
| Postgres (accounts, sessions) | D1 |
| Postgres (tenant tables, scoped managers) | One Workspace DO per workspace: its data is physically separate |
| `gateway` (MCP tools, permission pipeline) | The executor module, called in the Conversation DO |
| `gateway` relay (model requests) | Our pi-ai provider wrapper over Workers AI or AI Gateway |
| `gateway` journal | PiHarness stores pi's tables in the Conversation DO's SQLite |
| `supervisor` (SKIP LOCKED, deadlines, reconcile) | The Conversation DO owns its runs; alarms for deadlines, lost writes and the outbox |
| Run tokens | Gone; the run and attempt identity stays and is checked on every operation |
| SSE woken by `LISTEN/NOTIFY` | SSE from the stateless Worker, relayed from a hibernatable WebSocket to the Conversation DO |
| Docker container per turn, gVisor, socket relay | A Container per turn driven by a Sandbox DO; no egress at all |
| pi-codemode QuickJS | Dynamic Workers (`globalOutbound: null`) in a Scripts DO |
| S3 or a local directory | R2 |
| Downloads streamed by Django | A second Worker on its own origin streams from R2 behind signed links |
| Raw ASGI upload app | The Worker streams the body into R2 while hashing it |
| `.env`, SSH deploy, Caddy, tunnel | Worker secrets, `cf deploy`, Workers static assets |
| `docker compose logs` | Workers Logs and traces (`cf o11y`) |

## Data placement

Each piece of state has one authoritative home; everything else is an index that can be rebuilt from it.

- **D1 `minerva-cf`** (one database, primary near Frankfurt): `users`, `emails`, `passwords` (hash, fingerprint), `authenticators` (TOTP secret encrypted, recovery codes), `sessions` (hashed id, user, auth records, password fingerprint), `auth_flows` (pending stages, codes and their attempts, bound to a session), `rate_limits`, `workspaces` (id, kind, name, jurisdiction), `memberships`, `oauth_clients`, `oauth_flows` (one per session, 600 s). Auth transitions use conditional SQL (`UPDATE … WHERE attempts < 3 RETURNING`) or atomic `batch()`, since D1 has no interactive transactions; reads go to the primary (no read replicas).
- **Workspace DO**: authoritative for `connections` (encrypted credentials, status, generation, scopes, refresh state), `layers`, `grants`, `agents`, `uploads` (unattached, per user, with reservations), the `runs` registry (run, conversation, user, agent, connection ids, state, revoked), the cancellation `outbox`, byte counters. Index only: `conversations` (id, user, agent, title, timestamps).
- **Conversation DO**: authoritative for its owner, workspace and agent (fixed at creation), `messages`, `runs` and `attempts`, `run_events`, the write ledger (`run_writes`), `page_tokens`, `folder_versions` (manifests split into rows under 2 MB), the run's checkpoint, the script store, and pi's `pi_*` tables.
- **Sandbox DO**: authoritative for the container's lifecycle: incarnation id, owning run and attempt, hardening state, cleanup pending.
- **Scripts DO**: nothing durable.
- **R2 `minerva-cf-files`**: `blobs/<ws>/<conv>/<sha256>/<random>` and `uploads/<ws>/<user>/<id>`. Content is deduplicated within a conversation, not across conversations.

**Addressing.** One function maps a workspace's id and jurisdiction (from D1) to its objects (`jurisdiction('eu')` when set), since the same name with and without a jurisdiction is a different, empty object. The Worker never routes a request to a Durable Object by a client-chosen name without checking it; there are no generic Agent routes (`routeAgentRequest` is not used); objects are reached only through typed RPC from our own code.

## Protocols

These are the parts where a port is most likely to be subtly wrong. Each has fault-injection tests (see Testing) before anything is built on it.

### Starting a run

A message that is refused (409 while a run is active, an unknown agent, a missing or foreign upload, attachments over the folder's limits) must leave nothing behind, as the frontend expects; one that is accepted stores its message and run together.

1. **Conversation DO:** checks that no run is active (409), picks the run id, and records a private `starting` marker for it (invisible to the API).
2. **Workspace DO `beginRun(runId, conversation, user, agent, uploadIds, folderUsage)`**, idempotent by run id and synchronous inside (no awaits): checks the agent, the uploads (the user's own, unattached, complete) and the folder limits with the attachments, reserves the uploads for the run, computes the snapshot, registers the run as active, and returns the snapshot or a refusal. Called again with the same run id, it returns the same answer; it refuses a run it has since revoked or expired.
3. **Conversation DO, in one transaction:** on a refusal, deletes the marker and answers the API with today's status and message; on success, stores the message, the run (`queued`, attempt 1), the snapshot, and the base version with the attachments, and answers. If a cancel arrived during the await, the run is stored as cancelled, as today when a grant change races a start.
4. **Activation:** the Conversation DO then calls `activate(runId)`, which turns the reservation into consumption. A Conversation DO that restarts with a `starting` marker calls `beginRun` again; the Workspace DO's alarm releases reservations not activated within ten minutes and marks those runs expired, so a late `beginRun` result cannot start them.

The snapshot holds everything today's does: policy layers, tool refs and fingerprints, instructions with the start time, model alias, base folder version, attachments, deadline.

### Strict revocation

The Workspace DO's transaction that changes grants, removes a connection or changes an agent's connection set is the commit point; the acknowledgement barrier after it is the enforcement point.

1. In that one transaction it applies the change, marks every affected registered run `revoked`, and writes one outbox entry per run.
2. It delivers each entry: `cancel(runId, reason)` on the run's Conversation DO, which sets the run's local `revoked` flag and stops the run with "Stopped because permissions changed." and the matching code.
3. The API answers the browser only after every delivery is acknowledged. An entry that fails is retried by the Workspace DO's alarm until acknowledged; the request answers 503 if that takes over 10 s (the change stays saved and the runs are stopped shortly after).
4. A cancel for a run the Conversation DO has not stored yet leaves a tombstone, so step 3 of a start stores it as cancelled.

The executor checks the local `revoked` flag and the run's state synchronously, with no await in between, immediately before it dispatches any provider request, and again before it returns a result. The guarantee is the same as today's from the user's side: once the browser is told the change is saved, no new provider request starts under the old permissions; a request already sent may complete ("no further effects", not rollback). Between the commit and the acknowledgement, a run may still start a request, which today's database check would have stopped a few milliseconds earlier. Which runs a change affects follows today's rules exactly (a grant change cancels all of the user's active runs, queued included).

**Emergency stop.** Busy objects keep running their old code for minutes after a deploy, so a security fix cannot rely on a deploy reaching running turns. An operator command cancels every active run in a workspace or in all of them, through the same outbox.

### The harness

PiHarness (`agents/harness/pi`, agents 0.28.0) runs pi-durable 1.1.0 in the Conversation DO, which extends the Agents SDK's `Agent` and attaches it with `this.lifecycle.use(...)`; pi's tables live in the object's SQLite. Requirements, each from the spike:

- `settings.contextRetentionMs: 0`, since pi otherwise keeps every object active, and billed, for 10 minutes after each turn;
- one extension, `minerva`, registers the tools; a new pi session per run (`sessions.create()`), submitted once with `operationId: run:<id>` (idempotent) and today's history replay, so what the model sees does not change; steers and follow-ups (`whenBusy`) work and come later;
- the model through our provider wrapper (below), never `createAI`'s default AI Gateway, which logs prompts;
- tools honour `context.abortSignal`.

**Model.** pi-ai, with Workers AI by default (`@cf/zai-org/glm-5.3-flash`: all 10 models tried made the right calls; this one was the cheapest, about $0.00015 for a two-read, one-write turn) or an OpenAI or Anthropic upstream, both through the Worker's own AI Gateway `minerva-cf` with prompt logging off. Model settings come from configuration (`MINERVA_MODEL_*`), as today. The wrapper forces the model, the output cap and `store: false`, sends only text and function tools, and taps the stream for deltas.

### Attempts and recovery

pi has no restart limit and no notion of Minerva's attempts, so the Conversation DO keeps them. The first execution is attempt 1; there are at most 3.

- **What counts as a restart:** the Conversation DO's constructor running while a run is `running` and pi has work in progress. PiHarness keeps the object active while pi works, so an idle eviction cannot happen mid-turn; a deploy does not replace a busy object; a long tool waiting across alarms keeps the same instance. Constructor runs therefore mean the previous instance died (crash, memory limit, `ctx.abort()`). Hibernation between turns is not a restart.
- **The gate:** inside the constructor's `blockConcurrencyWhile`, before any alarm or request is delivered and so before pi resumes, the DO increments the run's attempt, emits the restart marker (`status: running` with `attempt`), and, if the attempt would be over 3 or under 30 s remain before the deadline, aborts pi's session and fails the run. This ordering is an assumption until proven: it is the first task of step 2, with fault injection against PiHarness (crash in a tool, in a model stream, during provisioning, during lifecycle start-up). If the constructor cannot gate pi, the gate moves into PiHarness's harness factory, which also runs before pi resumes; if neither can, step 2 stops and the plan is revised.
- **Replay cap:** safe tools are wrapped with a per-call execution counter in SQLite; a call replayed more than twice is answered with an error instead of running again.
- **Fencing:** every asynchronous operation (a tool call, a script, a sandbox command, a checkpoint, an event append) carries the run id and the attempt it started under, and is refused when either is not current. The one exception is settling a write that an older attempt already dispatched, which is always recorded.

### Writes

The write ledger is today's `RunWrite` protocol, ported to the Conversation DO's SQLite unchanged: the canonical write key (tool and normalized arguments, recursive key-sorted JSON) is claimed before dispatch; one write is dispatched at a time per run, with its deadline fixed at dispatch; refused writes are forgotten, applied ones recorded (with `applied_without_result` when the response was unusable), unknown outcomes marked uncertain, which pauses every later write in the run; writes still dispatched 30 s past their deadline are marked uncertain by an alarm; a new attempt waits while any write is dispatched. Deduplication is by key within the run, so it also catches a model that retries an interrupted write under a new pi call id (measured in the spike). A write settles in the DO that dispatched it, under `ctx.waitUntil`, even if the tool call that asked for it was cancelled.

### Credentials and refresh

Credentials stay encrypted in the Workspace DO (Fernet with `MINERVA_ENCRYPTION_KEYS`, byte-compatible with today). A refresh is single-flight per connection in memory and fenced by the credential generation in storage:

- Before calling the token endpoint, the DO records `refreshing` at generation g. On success it stores the new tokens as g + 1 and clears the state.
- A `refreshing` state found after a restart means the outcome is unknown: the provider may have rotated the refresh token. The connection becomes `refresh_uncertain`, and the next use makes exactly one refresh with the stored token. If that succeeds, the connection is normal again; if the provider refuses it (`invalid_grant`), the connection is marked "Needs reconnecting". No other request uses the connection while it is `refresh_uncertain`.
- A reconnect or delete during a refresh wins: the refresh's result is discarded when the generation moved.

### Checkpoints

The order from today's LocalCalls invariant, now driven by the Conversation DO:

1. close admission to new local calls; 2. wait for running ones; 3. `cgroup.kill` the agent cgroup and verify it is empty; 4. scan the folder as the dropped user; 5. stream changed files from the container into R2 (the Sandbox DO writes R2 itself, so file contents never cross an RPC, which is limited to 32 MiB) and verify each hash; 6. record the checkpoint for the current attempt on top of its previous one; 7. release the held tool results to pi.

If any step fails, the Conversation DO calls `ctx.abort()` before releasing results, so pi never commits them: the attempt ends, recovery starts the next one from pi's last commit, the held calls come back as interrupted, and the container is replaced from the last checkpoint. This is today's rule ("a failed checkpoint ends the attempt without recording the result").

### The sandbox lifecycle

A Sandbox DO per conversation runs one container per turn: `durable_object` scheduling policy, instance `standard-1` (1 vCPU, 4 GiB; `lite` takes about 100 ms per exec and moves 1–4 MB/s), `enableInternet: false`, and no outbound intercepts, so it has no route out (other ports time out; 80 and 443 accept and then reset). Nothing secret is passed to its environment, since a root process can read PID 1's.

Hardening is a state machine recorded with the container's incarnation id: `starting → hardening → verified → in_use → destroying`. Before `verified`, no agent command or file operation is admitted. One root `exec` runs, with `set -eu`:

1. a tmpfs `/workspace` with `size` and `nr_inodes` set to the folder limits, owned by uid 1000, so a full folder fails with `ENOSPC` at the size the store counts;
2. a tmpfs `/tmp`, `noexec`;
3. a cgroup `/sys/fs/cgroup/agent` with `pids.max` and `memory.max`;
4. `mount -o remount,ro /`.

A second `exec` verifies each postcondition (mount options and sizes, `/tmp` not executable, `/` read-only, the cgroup's limits, that the dropped wrapper reports no capabilities and `NoNewPrivs: 1`). Any failure, or any doubt, destroys the container and fails the turn. A Sandbox DO that restarts never reuses a running container it did not verify in its current incarnation: it destroys it first. If `destroy()` fails, the DO keeps `cleanup pending` and retries on an alarm. Every operation on the Sandbox DO, `destroy` and cleanup included, names the incarnation (and the run and attempt) it is for, and is refused for any other, so a late cleanup from one attempt can never destroy the next attempt's container.

Every agent command runs through one wrapper: `echo $$ > /sys/fs/cgroup/agent/cgroup.procs || exit 125; exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs timeout -k 5 <s> bash -c "$0"`, with the command as an argument, never interpolated. `cgroup.kill` replaces today's stray killer and catches `setsid` processes.

**File operations run as the dropped user too.** pi's `read`, `write` and `edit` go through `minerva-fs`, a Python helper on the read-only root, run as `python3 -I -S /opt/minerva/minerva-fs …` through the same wrapper: isolated mode, so nothing the agent writes can change it; paths as arguments, never interpolated; bounded reads. Where a path must stay inside `/workspace` (the scan, hydration, checkpoint reads), it is walked one component at a time with `openat`-style calls relative to directory descriptors, each with `O_NOFOLLOW`, so a symlinked parent cannot lead outside; files are opened with `O_NONBLOCK` and accepted only if `fstat` says regular file. pi's own tools keep pi's semantics for paths the agent names (as today on a laptop), but run without privileges, so a link out of `/workspace` reaches only what uid 1000 may read on a read-only root. Root is used only for hardening, verification and `cgroup.kill`. The SDK's `Files` (which runs as root) is not used on agent-controlled paths.

**The local tools** are pi's own, given an `ExecutionEnv` (`@earendil-works/pi-durable/env`, `FileSystem & Shell`) that forwards to the Sandbox DO; it must pass pi's conformance suite (24 cases). `read` is wrapped to be replay-safe, as today. If the Conversation DO restarts mid-turn it loses its `exec` handles: calls in flight come back as interrupted and the container is replaced from the last checkpoint.

### Code mode

`run_script` keeps its description and its rules, with these measured differences, which the description states: a guest may use about 256 MB (there is no lower setting; today 64 MB), computation is cut by `cpuMs`, about 2 s late, and timers exist. Each script is a Dynamic Worker loaded with `globalOutbound: null`, no `env` and `limits.cpuMs`, run from the per-conversation Scripts DO through an awaited loopback entrypoint, so a CPU-bound script never blocks the conversation. The Conversation DO enforces the wall clock (120 s, cut to the deadline); on timeout it stops the RpcTarget (later calls get a promise that never settles, so a stopped guest cannot spin the host), lets dispatched writes settle, and resets the Scripts DO. The guest's only capability is that RpcTarget, which applies the caps (100 open calls, 256 KB of arguments, stop after 100 refusals, 1 MiB of output) and queues calls with the direct ones. `@cloudflare/codemode` is not used: its replay re-ran an interrupted write (measured), and its executor's timeout can be switched off by the script. Step 4 tests both teardown recipes the spikes found (awaited entrypoint; reset after each script) and keeps whichever stops a looping guest.

### Events and the stream

Events are appended to the Conversation DO's `run_events` with today's types, payloads and dense per-run sequence numbers; a refused append takes no number. Text and reasoning deltas come from a tap on the provider stream, flushed every 0.25 s per model call with the call's 8-hex id; the restart marker before a new attempt makes the frontend drop the earlier attempt's text, as today. History replay into a run reads our `messages` table (final text and file notes only), never pi's transcript, so pi's aborted partial entries never reach the next turn.

The browser's `EventSource` connects to the stateless Worker, which checks the session and the run's owner, opens a hibernatable WebSocket to the Conversation DO with `after`, and relays frames (`id`, `event`, one-line `data`, 15 s keepalive comments, `end` when the run is inactive and caught up). The DO sends the backlog and subscribes in one synchronous step, so no event falls between them.

- **Backpressure:** the DO drops a socket whose buffered amount passes a limit, and the Worker closes the SSE response when its own stream's queue stays full; either way the client reconnects with `Last-Event-ID` and loses nothing.
- **Session during a stream:** the Worker checks the session again every 60 s and on every reconnect, and closes the stream when the session has ended (sign-out, password change, expiry). Workspaces are personal for now, so membership removal does not arise; team workspaces will need it.

## The web API

The Worker implements the endpoint table of the web-api spec exactly: paths, status codes, error shapes (`{detail}`, allauth's `{status, data, meta, errors}`), cookies (`sessionid`, `csrftoken`), CSRF (double submit plus Origin), the order of checks, and the allauth flows and their order. Known deviations:

- **Passwords** are hashed with scrypt (N 2^15, r 8, p 3, measured in step 5), in a versioned format. Django's PBKDF2 at 1,500,000 iterations is above what WebCrypto allows.
- **Email** codes are written to the Worker's logs only when `MINERVA_DEBUG` is true; otherwise they go through the Email Sending binding, and a deploy without either refuses to start.
- **Rate limits** are counters in D1, per account rather than per process.
- The resend bug in today's email verification is fixed rather than copied.

## Files

The store, versions, uploads, downloads and limits keep today's semantics (files spec). What changes:

- **Uploads** stream into R2 while hashing (`body.tee()` into `crypto.DigestStream` and `put`, about 550 ms CPU per 50 MiB). The edge buffers a request body before the Worker runs, so checks before the body cannot save bandwidth; the 100 MiB request limit is above the 50 MB file limit.
- **Every object is recorded before it is written**, as today's loose objects: the Workspace DO records an upload as `pending` (with its key and a byte reservation against the workspace's quota) before the `put`, and as complete after it; the Conversation DO records a checkpoint blob's key before the Sandbox DO writes it, and claims it when the checkpoint is recorded. Alarms delete pending and unclaimed objects older than an hour and release their reservations, so a crash between the record and the write leaves nothing that is not eventually removed, and counters stay right.
- **Downloads** are links signed with HMAC (`MINERVA_DOWNLOAD_KEY`) over the workspace, conversation, version, path, user and an expiry of five minutes, served by `minerva-cf-files` on its own origin with `Content-Disposition: attachment`, `nosniff` and `Content-Security-Policy: sandbox`. A link is a bearer capability until it expires: signing out does not revoke one already issued.
- **Encryption.** Blobs use R2's own encryption at first. Per-workspace keys (SSE-C, proven in the spike) are a later step: both Workers then hold a derivation secret and derive the workspace's key; keys never appear in links.
- **Blob keys** keep a random part, so deleting an object never races a re-upload of the same contents.
- **Deletion** of a conversation (or an agent, which deletes its conversations) tombstones it in the Workspace DO and the Conversation DO first, after which both refuse new runs, uploads and object writes; cancels its active run through the revocation outbox and waits for the run to end (its container destroyed and its Scripts DO reset); then deletes the Conversation DO's storage and the R2 prefix, and deletes the prefix again an hour later to catch any write that was already in flight. An alarm finishes an interrupted deletion.

## Configuration

| Name | Kind | Notes |
|---|---|---|
| `minerva-cf` | Worker | The app: assets, `/api`, the DO classes, the container |
| `minerva-cf-files` | Worker | The download origin; holds the R2 binding and the link key |
| `minerva-cf` | D1 | Primary near Frankfurt (`weur`) |
| `minerva-cf-files` | R2 bucket | Lifecycle rule expires `uploads/` after a day |
| `minerva-cf` | AI Gateway | Prompt logging off |
| `minerva-cf-sandbox` | Container application | Built by `cf build` from `cloudflare/container/` |

Secrets (`MINERVA_SECRET_KEY`, `MINERVA_ENCRYPTION_KEYS`, `MINERVA_DOWNLOAD_KEY`, model keys, connector clients) live in `.env.cloudflare` at the repository root (gitignored, mode 600) and are uploaded with `cf deploy --secrets-file`; they are never printed. Plain settings (`MINERVA_SITE_URL`, `MINERVA_MODEL_*`, limits, `MINERVA_SIGNUP_OPEN`, `MINERVA_DEBUG`) are text bindings in `cloudflare.config.ts`, read from the environment at build time.

## Repository layout

```text
cloudflare/
  cloudflare.config.ts     the two Workers, bindings, DO classes, container
  package.json             pnpm, exact versions
  migrations/              D1
  src/
    index.ts               fetch handler, exports
    http/                  router, errors, cookies, CSRF, headers, SSE relay
    auth/                  allauth-compatible endpoints, sessions, TOTP, codes, scrypt
    api/                   workspaces, agents, conversations, connections, access, uploads
    workspace/             Workspace DO: registry, revocation outbox, credentials
    conversation/          Conversation DO: runs, attempts, events, history, loop, tools
    gateway/               executor, policy, write ledger, page tokens, OAuth
    connectors/<name>/     the 20 connectors
    files/                 manifests, versions, store, uploads, folder_changes
    sandbox/               Sandbox DO, lifecycle, ExecutionEnv, checkpoints
    scripts/               Scripts DO, guest prelude, run_script
    model/                 provider wrapper, request policy, stream tap
    lib/                   canonical JSON, Fernet, text, code-point order, time
  files-worker/            the download origin
  container/               Dockerfile, Python requirements, minerva-fs, probe
  test/                    vitest: unit, platform, faults, account
```

## Testing

- **Unit tests** with Vitest in Node for everything that is plain TypeScript: `lib/`, the policy (with today's randomized equivalence test, seed 7), the executor with fake connectors and an injected `fetch`, each connector against recorded provider responses (today's tests ported case by case, normalized outcomes compared with the Python implementation where the cases allow), manifests and `folder_changes`, the allauth flows over an in-memory store, history replay, event rules.
- **Platform tests** run the Worker locally in workerd (the Vite plugin's dev server or Miniflare, settled in step 1) for the DOs, D1, R2 and the HTTP API, including tenancy (every endpoint refuses other workspaces, jurisdiction-qualified addressing) and the frontend's contracts (SSE frames, upload and download headers).
- **Fault-injection tests** with a deterministic fake model and fake providers, for every protocol above:

| Protocol | Failures injected |
|---|---|
| Start and revocation | revoke before the run exists, during `beginRun`, after; crash after the grant commit; lost cancel acknowledgement; start concurrent with revoke |
| Attempts | crash in a safe tool, in an unsafe tool, during the model stream; repeated memory-limit resets; hibernation between turns; a long tool across alarms; a late call from an old attempt |
| Writes | applied then response lost; claimed then never sent; crash while dispatched; the same write under a new pi call id; deadline passed |
| Refresh | crash during a rotating refresh; reconnect during a refresh |
| Sandbox | each hardening step failing; cgroup admission failing; lost `destroy()`; restart with a container still running |
| Checkpoints | detached writer; FIFO, symlink, oversized file; crash between upload, record, release and pi's commit |
| Scripts | CPU-bound guest; timeout during a write; calls after return; more than ten scripts in a row |
| Stream | slow client; append during reconnect; reconnect after a deploy |
| Files | attach retried; upload during deletion; lost R2 acknowledgement |

- **Account tests** against a deployed `minerva-cf`: the container and the reworked sandbox probe, Dynamic Workers, Workers AI, the fault tests that need the real platform (memory-limit resets, deploys mid-turn), and a walkthrough in a real browser.
- pi's `ExecutionEnv` conformance suite runs against the container-backed environment.

## Steps

The risky protocols come first, proven with fault injection before the API and the connectors are built on them. Each step ends with its tests passing and an opencode review of the diff, then a commit on `cloudflare`.

0. **Research and spikes.** Done 2026-10-10: specs of every subsystem and four spikes on the account (below).
1. **Scaffold.** Project, config, D1 migrations, the router with error shapes, security headers, `lib/` (canonical JSON, Fernet compatible with today's ciphertext, code-point order, text sanitizers), the three test layers, a first deploy as `minerva-cf` serving the frontend.
2. **Core protocols.** Workspace DO (connections, layers, grants, agents, run registry, outbox, credentials and refresh), Conversation DO (messages, runs, attempts, events, write ledger, page tokens), the connector contract, policy and executor ported with fake connectors, PiHarness with the fake model and the attempt gate, the model wrapper. Start, revocation, attempts, writes and refresh pass their fault tests.
3. **Sandbox and files.** Container image, Sandbox DO lifecycle and hardening, `minerva-fs`, the `ExecutionEnv`, the R2 store, versions and checkpoints. Their fault tests and the sandbox probe pass on the account.
4. **Code mode.** Scripts DO and `run_script`, with their fault tests.
5. **Web API.** Accounts and sessions, workspaces, agents, conversations, connections and access, uploads, downloads origin, the SSE relay. The frontend works end to end against a deployed Worker with the fake model and Workers AI.
6. **Connectors.** All 20, one at a time with their ported tests, on the contract from step 2.
7. **Deploy and verify.** A browser walkthrough of every page, the sandbox probe, timings, and an update of this file and of ARCHITECTURE.md with the comparison.

Steps 3, 4 and 5 depend only on step 2 and can proceed in parallel; step 6 needs only the contract and executor from step 2.

## Spike results (2026-10-10)

Measured on the account (Workers Paid, Frankfurt), with `cf` 1.0.0-beta.13, its `cloudflare.config.ts` format and Vite. All spike resources were deleted (one container snapshot expires by itself). Full reports are kept outside the repository.

| Spike | Result |
|---|---|
| PiHarness | Worked with pi-durable 1.1.0 and 1.0.3. Two reads in parallel then a write, from one prompt; idempotent submit; steer and follow-up; recovery after `ctx.abort()`, memory-limit resets (7 in a row, no cap) and an interrupted model stream, each about 30 s later; a redeploy mid-turn interrupted nothing; a 17-minute tool call completed. After an interrupted write, the model retried it under a new call id. First text delta 2–4 s after submit. pi-mcp works; pi-codemode does not (no `worker_threads`). `contextRetentionMs` must be 0, or every object stays active 10 minutes after each turn. |
| Sandbox | A Firecracker microVM (KVM, kernel 6.18). With `enableInternet: false` and no intercepts: ports other than 80/443 time out, 80/443 accept and reset, DNS answers nothing, metadata and other containers are unreachable. Processes have root's capabilities until `setpriv` drops them; tmpfs size and inode limits give `ENOSPC`; `/` can be remounted read-only; a cgroup bounds pids and memory and `cgroup.kill` ends strays. `standard-1`: start 0.3–0.5 s, `exec` 6 ms, 50 MiB out in 1.5 s. A root fork bomb outside the cgroup wedges `exec`. `/tmp` `noexec` was not verified separately. |
| Code mode | Dynamic Workers with `globalOutbound: null` block fetch, connect and WebSockets; `eval` is blocked, so each script is its own Worker (about 12 ms to load). Props on a stub cannot be read or forged. Memory is about 256 MB per guest, with no lower setting; `cpuMs` kills about 2 s late. A busy guest blocks the object that loaded it, and a guest can outlive its host's timeout until that object is reset. `@cloudflare/codemode`'s replay ran an interrupted write twice. |
| Storage and realtime | Request bodies up to exactly 100 MiB, buffered by the edge before the Worker runs. Upload hashing with `tee()` and `DigestStream`: 550 ms CPU per 50 MiB. Downloads from a second Worker keep `CSP: sandbox`; SSE-C with per-workspace keys works. SSE served by a DO keeps it awake; relayed by the Worker from a hibernatable WebSocket, the DO sleeps between events, and neither path dropped a client across deploys (Node clients; not yet a browser). D1: atomic `batch()`, triggers, FTS5, unique-row locks, no `BEGIN`. `fetch()` from a Worker answers private, loopback, link-local and non-Cloudflare IP literals with a 403 (error 1003) rather than throwing. Static assets with an SPA fallback and the Worker first for `/api/*`. |

Consequences for the design:

- The Web connector keeps its URL and host policy and its same-host redirect rule; the DNS-pinning guard against private networks becomes the platform's refusal, which the connector must recognise (a 403 with `error code: 1003`) and report as today. That refusal is measured, not documented, so step 6 adds adversarial tests (rebinding names, `nip.io`, IPv6 encodings, redirects to private addresses) against the deployed Worker.
- **Versions.** Busy objects keep their old code for minutes after a deploy and new objects may start on the previous version, so two versions run side by side: Durable Object storage changes are additive only, code accepts rows written by the previous and the next version, and a changed tool still fails through its fingerprint (`OPERATION_CHANGED`).
- `/assets/<missing>` gets the SPA shell instead of today's 404 (accepted: a stale page fails to load its chunk either way).
- The sandbox checks are reworked for this platform (no loopback-only check; network checks over HTTP and TLS, not TCP connect) and run against the deployed Worker.
- Deploys never reach a busy object, so revocation and policy can never rely on a deploy.

## Open questions

1. Move the executor and the decryption key to a separate Worker script with its own secrets, so the loop's isolate never holds a credential?
2. Warm containers: keep a conversation's container between turns for its idle timeout, or start one per turn as today?
3. pi's state grows with every run (a new session each), and PiHarness cannot delete conversations yet. How large does it get, and does `reset()` or a periodic compaction bound it?
4. A team's Workspace DO serializes its control plane (grants, refresh, run registry). What throughput and revocation fan-out does one object sustain?
5. Retention: run events, the write ledger and page tokens grow with every turn (today without a retention period too). Pick limits per conversation, and measure whether a very long turn approaches the 10,000 subrequests of one invocation (not tested in the spike).
6. Email Sending is in beta; a provider API may be needed for production.
7. Compliance scope: Containers, Dynamic Workers and Secrets Store are missing from Cloudflare's published SOC 2 and HIPAA lists.
