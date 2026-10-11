# Plan: Minerva on Cloudflare

Status: experiment, started 2026-10-10 on the `cloudflare` branch (local until it is pushed). This file is the design and the order of work. `main` and its Django, worker and deploy code are untouched; the rewrite lives in `cloudflare/` and reuses `frontend/` unchanged. Scope decided 2026-10-11 (see Instance and control plane): this becomes the self-hostable Minerva, and the Docker and VPS path retires once it reaches parity.

## Goal

The same product on Cloudflare's platform, deployed with one command to one Cloudflare account:

- the same React app and the same JSON API (`frontend/openapi.json` plus the allauth headless endpoints `frontend/src/lib/auth.ts` uses), so the frontend needs no changes beyond its dev proxy;
- the same permission model and pipeline, and all 20 connectors;
- the same agent: pi-durable with Minerva's tools, history, code mode and files, durable across crashes, with today's guarantees for writes (deduplicated, never replayed, uncertain ones pause the run);
- a sandbox per turn with no network, now a Firecracker microVM;
- fewer moving parts: no supervisor, no Docker socket, no socket relay, no run tokens, no VPS, no Postgres.

What it should show: which of Minerva's hard problems the platform removes (sandbox runtime, the Docker socket, approvals that hold compute, downloads, deploys, logs), and what it costs (laptop and VPS self-hosting, compliance scope, beta dependencies, a larger trusted code base).

Not in scope: Minerva Cloud's control plane (a separate, private repository, below), self-hosting on a laptop or VPS (retired), the demo's features (`backend/demo/`), WebAuthn, social login, data migration from an existing Postgres, team workspaces (as today).

## Instance and control plane

Decided 2026-10-11. Everything a company needs to run Minerva for its own people is an **instance**: one deployment of `cloudflare/` into one Cloudflare account, holding its own users, data and secrets, and needing nothing outside that account. Self-hosting means deploying an instance into your own account. Everything needed only to sell Minerva to many customers is Minerva Cloud's **control plane**, which stays in Python and Django, lives in a separate private repository, and is used only by the operator. The test for a feature: would a company running Minerva for itself need it? Then it belongs in the instance.

| In the instance (this repository) | In the control plane (private) |
|---|---|
| Users, sign-in, two-factor, sessions; SSO and directory sync for organizations | Customers, billing contacts, the signup site |
| Organizations, workspaces, teams, roles, ceilings, connections, agents, permissions | Plans and the entitlements an instance enforces |
| Runs, sandbox, files, code mode, connectors | Creating, upgrading, suspending and deleting instances (Cloudflare's API) |
| The audit log, retention, quotas enforced locally | Billing (Stripe) from the usage instances report |
| Model settings: an instance key and a key per workspace | Minerva's platform model key and shared OAuth apps, configured into cloud instances like any instance's |
| An instance admin, emergency stop, a support-access switch the organization controls | Support workflows that use that switch, abuse handling |

The two meet through Cloudflare's API and a small, signed **management API** in the instance (create or suspend organizations, set entitlements, read usage, version and health, emergency stop). An instance keeps working without the control plane: it caches its entitlements and decides everything else itself, and the control plane never holds an organization's content or credentials.

**Databases.** An instance has no Postgres, self-hosted or in the cloud: D1 holds accounts and the directory, each Workspace and Conversation object its own SQLite, R2 the files. Postgres (PlanetScale later) is the control plane's own database, for customers, billing, entitlements, the list of instances and usage totals; the two never share a database.

- **Organizations** sit above workspaces: an organization owns its members, SSO settings, ceilings, audit log, entitlements and data region (jurisdiction). A self-hosted instance usually has one; a shared cloud instance has many.
- **Cloud hosting** starts with shared instances, each holding many organizations. A dedicated instance for one customer is the same deployment with one organization, so it needs nothing beyond what self-hosting needs (any instance name, any account, the setup script); only the control plane's automation for running many of them waits until a customer asks.
- **Licence.** The instance is meant to be released as MIT or Apache 2.0; the control plane stays private.

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

- **D1** (one database per instance, primary near Frankfurt): `organizations` (from step 5: name, SSO settings, entitlements, jurisdiction), `users`, `emails`, `passwords` (hash, fingerprint), `authenticators` (TOTP secret encrypted, recovery codes), `sessions` (hashed id, user, auth records, password fingerprint), `auth_flows` (pending stages, codes and their attempts, bound to a session), `rate_limits`, `workspaces` (id, organization, kind, name, jurisdiction), `memberships`, `oauth_clients`, `oauth_flows` (one per session, 600 s). Auth transitions use conditional SQL (`UPDATE … WHERE attempts < 3 RETURNING`) or atomic `batch()`, since D1 has no interactive transactions; reads go to the primary (no read replicas).
- **Workspace DO**: authoritative for `connections` (encrypted credentials, status, generation, scopes, refresh state), `layers`, `grants`, `agents`, `uploads` (unattached, per user, with reservations), the `runs` registry (run, conversation, user, agent, connection ids, state, revoked), the cancellation `outbox`, byte counters. Index only: `conversations` (id, user, agent, title, timestamps).
- **Conversation DO**: authoritative for its owner, workspace and agent (fixed at creation), `messages`, `runs` and `attempts`, `run_events`, the write ledger (`run_writes`), `page_tokens`, `folder_versions` (manifests split into rows under 2 MB), the run's checkpoint, the script store, and pi's `pi_*` tables.
- **Sandbox DO**: authoritative for the container's lifecycle: incarnation id, owning run and attempt, hardening state, cleanup pending.
- **Scripts DO**: nothing durable.
- **R2 `minerva-cf-files`**, and **`minerva-cf-files-eu`** (created in R2's EU jurisdiction) for EU workspaces: `blobs/<ws>/<conv>/<sha256>/<random>` and `uploads/<ws>/<user>/<id>`. Content is deduplicated within a conversation, not across conversations. A lifecycle rule deletes `uploads/` objects a day after they were written, attached or not, so a folder never names one (see Starting a run).

**Addressing.** One module (`src/addressing.ts`) maps a workspace's id and jurisdiction (from D1) to its objects (`jurisdiction('eu')` when set) and to its bucket, since the same name with and without a jurisdiction is a different, empty object. The Worker never routes a request to a Durable Object by a client-chosen name without checking it; there are no generic Agent routes (`routeAgentRequest` is not used); objects are reached only through typed RPC from our own code. Local workerd has no jurisdictions (`jurisdiction()` throws), so with `MINERVA_DEBUG` on, and only then, an EU object is named `eu:<name>` in the plain namespace; a production build refuses `MINERVA_DEBUG`. Where an EU workspace's container runs is unmeasured: `durable_object` scheduling has no placement constraint, so the VM may sit outside the EU even when its Sandbox DO does not (measured in step 3). The deployed Worker's `/api/probe` (token-gated) reports each class's jurisdiction as the account tests see it.

## Protocols

These are the parts where a port is most likely to be subtly wrong. Each has fault-injection tests (see Testing) before anything is built on it.

### Starting a run

A message that is refused (409 while a run is active, an unknown agent, a missing or foreign upload, attachments over the folder's limits) must leave nothing behind, as the frontend expects; one that is accepted stores its message and run together.

1. **Conversation DO:** checks that no run is active (409), picks the run id, and records a private `starting` marker for it (invisible to the API).
2. **Workspace DO `beginRun(runId, conversation, user, agent, uploadIds, folderUsage)`**, idempotent by run id and synchronous inside (no awaits): checks the agent, the uploads (the user's own, unattached, complete) and the folder limits with the attachments, reserves the uploads for the run, computes the snapshot, registers the run as active, and returns the snapshot or a refusal. Called again with the same run id, it returns the same answer; it refuses a run it has since revoked or expired.
3. **Conversation DO, copying the attachments** (files spec 15.2, option A): for each reserved upload whose contents the conversation does not hold yet, it records a loose blob key `blobs/<ws>/<conv>/<sha256>/<random>`, then copies the upload's object to it with `get` and `put` with the upload's SHA-256, which R2 checks. The folder then names only the conversation's own blobs, never an `uploads/` key, which the lifecycle rule deletes a day after it was written. An upload already gone refuses the start ("An attached file is no longer available. Remove it and attach it again."). Up to 10 × 50 MB per message pass through the object; its time and CPU are measured in step 3, with a crash during the copy among the fault tests (loose keys not claimed are deleted by an alarm).
4. **Conversation DO, in one transaction:** on a refusal, deletes the marker and answers the API with today's status and message; on success, stores the message, the run (`queued`, attempt 1, `activated` false), the snapshot, and the base version with the copies (claiming their loose keys), sets an alarm, and answers. If a cancel arrived during the awaits, the run is stored as cancelled, as today when a grant change races a start.
5. **Activation:** the Conversation DO then calls `activate(runId)`, which turns the reservation into consumption (the Workspace deletes the upload rows and objects). It is idempotent and answers where the registration stands: active, revoked with its reason, expired, or ended. Until an answer arrives, the Conversation DO sends it again on its alarm and whenever its constructor runs, for every stored active run not yet `activated`; a run that comes back revoked stops with that reason, and one that comes back expired fails (`start_expired`). A Conversation DO that restarts with a `starting` marker calls `beginRun` again; the Workspace DO's alarm releases reservations not activated within ten minutes and marks those runs expired, so a late `beginRun` result cannot start them.

The snapshot holds everything today's does: policy layers, tool refs and fingerprints, instructions with the start time, model alias, base folder version, attachments, deadline.

### Strict revocation

The Workspace DO's transaction that changes grants, removes a connection or changes an agent's connection set is the commit point; the acknowledgement barrier after it is the enforcement point.

1. In that one transaction it applies the change, marks every affected registered run `revoked`, and writes one outbox entry per run.
2. It delivers each entry: `cancel(runId, reason)` on the run's Conversation DO, which sets the run's local `revoked` flag and stops the run with "Stopped because permissions changed." and the matching code (a deletion's cancel and an emergency stop end with "Stopped.", codes `cancelled` and `emergency_stop`).
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

**Model.** pi-ai, with Workers AI by default (`@cf/zai-org/glm-5.3-flash`: all 10 models tried made the right calls; this one was the cheapest, about $0.00015 for a two-read, one-write turn) or an OpenAI or Anthropic upstream, both through the Worker's own AI Gateway `minerva-cf` with prompt logging off. Model settings come from configuration (`MINERVA_MODEL_*`), as today. The wrapper forces the model, the output cap and `store: false`, sends only text and function tools, and taps the stream for deltas. No provider text reaches pi's state, its events or the logs: a failure's text is replaced (a context overflow by our own words that pi-ai still classifies as one, so pi compacts and asks again), createAI's diagnostics, which copy it, are dropped from every message, and the log gets the failure's kind, status, class and createAI's code.

### Attempts and recovery

pi has no restart limit and no notion of Minerva's attempts, so the Conversation DO keeps them. The first execution is attempt 1; there are at most 3.

Measured in step 2a (112 injected deaths across tool, model-stream, factory and submit crashes, memory-limit resets and caps, plus controls; reviewed adversarially):

- **Where the gate runs: first in PiHarness's harness factory**, before `Harness.open`. pi exists only once the factory returns, and every event that opens pi (alarms, requests, RPCs) goes through it, so nothing of pi runs before the gate. The constructor is not usable: the platform sometimes builds an instance, never delivers it an event and discards it (6 times in about 115 restarts), and a constructor counter counted each of those as an attempt.
- **What counts as a restart:** the factory running in a new instance while an *activated* `provisioning` or `running` run has unsettled pi work: its submission (`storage.submissionByRequest(conversationId, "run:<id>")` on the factory's `storage`) is queued or placed, or its session has live tasks (`storage.scanTasks`), background ones included. Queued runs belong to the start protocol: they get no attempt and no marker, and are never submitted to pi before activation. A settled submission with no live tasks is no restart; the run is reconciled from pi's record. PiHarness's own `pending()`, `busy()` and `sessions.list()` cannot be used here: they wait for the open in progress. Controls that must not count, and did not: a turn, idle hibernation and a second turn; an 11-minute tool across 24 alarms; a 150 s model retry handed to the alarm; a redeploy during a turn.
- **The gate's decision**, in one `transactionSync`, then `await ctx.storage.sync()` before `Harness.open`, so a crash right after the gate cannot lose the count: if the deadline has passed, the run ends as `timed_out` ("The run took too long."); if this would be attempt 4, or under 30 s remain, it ends as `worker_exited` ("The worker stopped unexpectedly."); otherwise the attempt is incremented and the restart marker `{status: "provisioning", attempt: N}` appended (then `running` when the loop resumes), before pi does anything. The once-per-instance flag is set only after the decision is committed, so a factory that throws retries the gate on the next event.
- **Stopping pi** when the gate ends a run: after `Harness.open` and before the factory returns, every live task of the run's session, background compactions included, is marked with `pi.abortTask` and queued inputs are withdrawn with `pi.abortSubmission`, all in one synchronous stretch, so the scheduler reserves nothing meanwhile; the abort handlers run after `pi.resume()`. Measured: no tool execution or model call afterwards; the tool result reads "was aborted", the submission ends unanswered, and PiHarness's wake job and alarm are cleared. Deleting the wake job is not a stop (pi resumed on the next request), and `session.reset()` is not either. As a backstop, the model wrapper and the executor refuse calls for runs that are not current.
- **A start that crashed before pi had its input** has no wake-up of its own: a Lifecycle job (`watch:<run>`, 20 s) wakes the object. `this.schedule()` did not fire in the spike.
- **Timing.** The gate costs nothing measurable; recovery waits for PiHarness's 30 s heartbeat (p50 29 s, at most 60 s), so a crash in a run's last minute usually ends it. pi's retry delays stay at or under 60 s, so a long wait is never mistaken for a restart.
- **Deploys** usually leave a busy object on its old code until it is idle, but the platform can reset a busy object on a code update; that counts as a restart, as today ("restarts count whatever the cause").
- **Not covered:** a deterministic crash before the factory (in the Agent's own start-up or `openPiSessionStore`) would repeat without being counted; pi does not run in such an instance.
- Writes the dead instance left `dispatched` are marked uncertain by the gate, in the same transaction as its decision (see Writes); nothing waits in the gate, which runs under `blockConcurrencyWhile`'s 30 s limit.
- **Replay cap:** safe tools are wrapped with a per-call execution counter in SQLite; a call replayed more than twice is answered with an error instead of running again.
- **Fencing:** every asynchronous operation (a tool call, a credential lease, a script and its reset, a sandbox command, a checkpoint, an event append) carries the run id and the attempt it started under, and is refused when either is not current. The one exception is settling a write that an older attempt already dispatched, which is always recorded. The Workspace DO knows runs, not attempts, so the Conversation DO checks a lease's attempt before and after asking for it; the Scripts DO keeps the newest run and attempt it has run a script under and refuses a reset from an older one, since a reset aborts every guest it loaded.

### Writes

The write ledger is today's `RunWrite` protocol, ported to the Conversation DO's SQLite unchanged: the canonical write key (tool and normalized arguments, recursive key-sorted JSON) is claimed before dispatch; one write is dispatched at a time per run, with its deadline fixed at dispatch; refused writes are forgotten, applied ones recorded (with `applied_without_result` when the response was unusable), unknown outcomes marked uncertain, which pauses every later write in the run; writes still dispatched 30 s past their deadline are marked uncertain by an alarm. Today a restart waits while a write is dispatched, because the old gateway process may still settle it; here the write was dispatched by the instance that died, which can never settle it, so the restart gate marks every write of the run still `dispatched` as uncertain in its own transaction (as today's supervisor does for writes whose gateway process died), and the new attempt's later writes pause. Deduplication is by key within the run, so it also catches a model that retries an interrupted write under a new pi call id (measured in the spike). A write settles in the DO that dispatched it, under `ctx.waitUntil`, even if the tool call that asked for it was cancelled. A claim and a settlement are made only while no asynchronous transaction of pi's is open on the object's storage: one made inside it would roll back with it, and a claim the executor was told was dispatched would leave nothing for the restart gate to mark uncertain.

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
2. a tmpfs `/tmp`, `noexec`, with `/tmp/home` and `/tmp/matplotlib` owned by uid 1000 (bash's `HOME` and `MPLCONFIGDIR`);
3. a cgroup `/sys/fs/cgroup/agent` with `pids.max` (256) and `memory.max` set to the base (1 GiB) plus both tmpfs sizes, as today: pages the agent writes to a tmpfs are charged to its cgroup, so with the base alone a growing folder would OOM-kill commands instead of failing with `ENOSPC` at the folder's limit;
4. `mount -o remount,ro /`.

A second `exec` verifies each postcondition (mount options and sizes, `/tmp` not executable, the home directories and their owner, `/` read-only, the cgroup's limits equal to the spec's, that the dropped wrapper reports no capabilities and `NoNewPrivs: 1`). Any failure, or any doubt, destroys the container and fails the turn. A Sandbox DO that restarts never reuses a running container it did not verify in its current incarnation: it destroys it first. If `destroy()` fails, the DO keeps `cleanup pending` and retries on an alarm. Every operation on the Sandbox DO, `destroy` and cleanup included, names the incarnation (and the run and attempt) it is for, and is refused for any other, so a late cleanup from one attempt can never destroy the next attempt's container.

Every agent command runs through one wrapper: `echo $$ > /sys/fs/cgroup/agent/cgroup.procs || exit 125; exec setpriv --reuid=1000 --regid=1000 --clear-groups --inh-caps=-all --ambient-caps=-all --bounding-set=-all --no-new-privs timeout -k 5 <s> bash -c "$0"`, with the command as an argument, never interpolated. `cgroup.kill` replaces today's stray killer and catches `setsid` processes.

**File operations run as the dropped user too.** pi's `read`, `write` and `edit` go through `minerva-fs`, a Python helper on the read-only root, run as `python3 -I -S /opt/minerva/minerva-fs …` through the same wrapper: isolated mode, so nothing the agent writes can change it; paths as arguments, never interpolated; bounded reads. Where a path must stay inside `/workspace` (the scan, hydration, checkpoint reads), it is walked one component at a time with `openat`-style calls relative to directory descriptors, each with `O_NOFOLLOW`, so a symlinked parent cannot lead outside; files are opened with `O_NONBLOCK` and accepted only if `fstat` says regular file. pi's own tools keep pi's semantics for paths the agent names (as today on a laptop), but run without privileges, so a link out of `/workspace` reaches only what uid 1000 may read on a read-only root. Root is used only for hardening, verification and `cgroup.kill`. The SDK's `Files` (which runs as root) is not used on agent-controlled paths.

**The local tools** are pi's own, given an `ExecutionEnv` (`@earendil-works/pi-durable/env`, `FileSystem & Shell`) that forwards to the Sandbox DO; it must pass pi's conformance suite (24 cases). `read` is wrapped to be replay-safe, as today. If the Conversation DO restarts mid-turn it loses its `exec` handles: calls in flight come back as interrupted and the container is replaced from the last checkpoint.

### Code mode

`run_script` keeps its description and its rules, with these measured differences, which the description states: a guest may use about 256 MB (there is no lower setting; today 64 MB), computation is cut by `cpuMs`, about 2 s late, and timers exist. Each script is a Dynamic Worker loaded with `globalOutbound: null`, no `env` and `limits.cpuMs`, run from the per-conversation Scripts DO through an awaited loopback entrypoint, so a CPU-bound script never blocks the conversation. The Conversation DO enforces the wall clock (120 s, cut to the deadline); on timeout it stops the RpcTarget (later calls get a promise that never settles, so a stopped guest cannot spin the host), lets dispatched writes settle, and resets the Scripts DO. The guest's only capability is that RpcTarget, which applies the caps (100 open calls, 256 KB of arguments, stop after 100 refusals, 1 MiB of output) and queues calls with the direct ones. `@cloudflare/codemode` is not used: its replay re-ran an interrupted write (measured), and its executor's timeout can be switched off by the script. Step 4 tests both teardown recipes the spikes found (awaited entrypoint; reset after each script) and keeps whichever stops a looping guest.

### Events and the stream

Events are appended to the Conversation DO's `run_events` with today's types, payloads and dense per-run sequence numbers; a refused append takes no number. Text and reasoning deltas come from a tap on the provider stream, flushed every 0.25 s per model call with the call's 8-hex id; the restart marker before a new attempt makes the frontend drop the earlier attempt's text, as today. History replay into a run reads our `messages` table (final text and file notes only), never pi's transcript, so pi's aborted partial entries never reach the next turn.

**Reading runs.** Workers RPC refuses arguments and results over 32 MiB, and a conversation's events have no retention yet (open question 5), so no Durable Object method returns more than a page of them: `getConversation`, `getRun` and `cancelRun` return runs without events but with the seq of their last event, read with their status, and the Worker streams the API's body (each run with all its events, as today), paging each run's events with `getRunEvents` up to that seq. Step 5 adds a platform test with a conversation whose events pass 32 MiB.

The browser's `EventSource` connects to the stateless Worker, which checks the session and the run's owner, opens a hibernatable WebSocket to the Conversation DO with `after`, and relays frames (`id`, `event`, one-line `data`, 15 s keepalive comments, `end` when the run is inactive and caught up). The DO sends the backlog and subscribes in one synchronous step, so no event falls between them. Hibernatable sockets outlive the instance that accepted them, and one that died may have committed events it never sent: each socket is tagged with the instance that accepted it, and any other instance never writes to it (no frame, no `end`) but closes it with 1013, as it does every socket it inherited when it starts, so the client reconnects with `Last-Event-ID` and gets what it missed, then `end`.

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

- **Uploads** stream into R2 while hashing (`body.tee()` into `crypto.DigestStream` and `put`, about 550 ms CPU per 50 MiB). The edge buffers a request body before the Worker runs, so checks before the body cannot save bandwidth; the 100 MiB request limit is above the 50 MB file limit. Sending a message copies its uploads into the conversation's blobs (Starting a run, step 3); the bucket's lifecycle rule deletes every `uploads/` object a day after it was written.
- **Every object is recorded before it is written**, as today's loose objects: the Workspace DO records an upload as `pending` (with its key and a byte reservation against the workspace's quota) before the `put`, and as complete after it; the Conversation DO records a checkpoint blob's key before the Sandbox DO writes it, and claims it when the checkpoint is recorded. Alarms delete pending and unclaimed objects older than an hour and release their reservations, so a crash between the record and the write leaves nothing that is not eventually removed, and counters stay right.
- **Downloads** are links signed with HMAC (`MINERVA_DOWNLOAD_KEY`) over the download origin, workspace, conversation, version, path, user and an expiry of five minutes, served by `minerva-cf-files` on its own origin, which also checks the request's host, with `Content-Disposition: attachment`, `nosniff` and `Content-Security-Policy: sandbox`. Neither Worker has preview URLs: every uploaded version would stay reachable at an origin of its own, with the bindings of its day, and versions cannot be deleted. A link is a bearer capability until it expires: signing out does not revoke one already issued.
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
| `minerva-cf-files-eu` | R2 bucket | In R2's EU jurisdiction, for EU workspaces; the same rule |
| `minerva-cf` | AI Gateway | Prompt logging off |
| `minerva-cf-sandbox` | Container application | Built by `cf build` from `cloudflare/container/` |

Secrets (`MINERVA_SECRET_KEY`, `MINERVA_ENCRYPTION_KEYS`, `MINERVA_DOWNLOAD_KEY`, model keys, connector clients) live in `.env.cloudflare` at the repository root (gitignored, mode 600) and are uploaded with `cf deploy --secrets-file`; they are never printed. Plain settings (`MINERVA_SITE_URL`, `MINERVA_MODEL_*`, limits, `MINERVA_SIGNUP_OPEN`, `MINERVA_DEBUG`) are text bindings in `cloudflare.config.ts`, checked by the Worker's own parser at build time. Development and tests read them from the environment; a production build reads `.env.cloudflare.vars` alone (gitignored: it names the deployed origins), which must exist, with https origins and debug off, so a shell's `MINERVA_*` (the Django app's names) never reach a deploy. `pnpm run deploy` checks that D1, both buckets (with their jurisdiction and lifecycle rule) and the AI Gateway exist, since `cf deploy` would create a missing one with default settings, and applies D1's migrations before uploading code.

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
- **Platform tests** run the Worker locally in workerd with `@cloudflare/vitest-plugin`, which loads `cloudflare.config.ts` itself (settled in step 1; remote bindings off), for the DOs, D1, R2 and the HTTP API, including tenancy (every endpoint refuses other workspaces; an EU workspace's objects and bucket are separate from a default one's, through the local seam, since workerd has no jurisdictions), CSRF on every unsafe route, and the frontend's contracts (SSE frames, upload and download headers).
- **Fault-injection tests** with a deterministic fake model and fake providers, for every protocol above:

| Protocol | Failures injected |
|---|---|
| Start and revocation | revoke before the run exists, during `beginRun`, after; crash during the attachments' copy; crash between storing the run and `activate`, and a lost `activate` answer; crash after the grant commit; lost cancel acknowledgement; start concurrent with revoke |
| Attempts | crash in a safe tool, in an unsafe tool, during the model stream; repeated memory-limit resets; hibernation between turns; a long tool across alarms; a late call from an old attempt |
| Writes | applied then response lost; claimed then never sent; crash while dispatched; the same write under a new pi call id; deadline passed |
| Refresh | crash during a rotating refresh; reconnect during a refresh |
| Sandbox | each hardening step failing; cgroup admission failing; lost `destroy()`; restart with a container still running |
| Checkpoints | detached writer; FIFO, symlink, oversized file; crash between upload, record, release and pi's commit |
| Scripts | CPU-bound guest; timeout during a write; calls after return; more than ten scripts in a row; a late reset from a replaced attempt |
| Stream | slow client; append during reconnect; reconnect after a deploy |
| Files | attach retried; upload during deletion; lost R2 acknowledgement |

- **Account tests** against a deployed `minerva-cf`, and the fault tests that need the real platform against the test Worker `minerva-cf-test` (the same code built with a fake connector, fault points and a token-gated driver; cloudflare/README.md): the token-gated `/api/probe` (one RPC to each Durable Object class without and with the EU jurisdiction, D1's applied migrations against `migrations/`, the runtime's JSON parser), that neither Worker has preview URLs, the container and the reworked sandbox probe, Dynamic Workers, Workers AI, the fault tests that need the real platform (memory-limit resets, deploys mid-turn), and a walkthrough in a real browser.
- pi's `ExecutionEnv` conformance suite runs against the container-backed environment.

## Steps

The risky protocols come first, proven with fault injection before the API and the connectors are built on them. Each step ends with its tests passing and an opencode review of the diff, then a commit on `cloudflare`.

0. **Research and spikes.** Done 2026-10-10: specs of every subsystem and four spikes on the account (below).
1. **Scaffold.** Project, config, D1 migrations, the router with error shapes, security headers, `lib/` (canonical JSON, Fernet compatible with today's ciphertext, code-point order, text sanitizers), the three test layers, a first deploy as `minerva-cf` serving the frontend. Done 2026-10-11 ([cloudflare/README.md](../../cloudflare/README.md)); the interfaces of steps 2 to 6 are in `cloudflare/src/contracts/`. Found on the way: the runtime's `JSON.parse` can return wrong keys (below), and zod counts string lengths in UTF-16 units and trims differently from Pydantic, so `lib/` reads every JSON text with its own `parseJson` and ports `Field(max_length=…)` with code-point checks (`lib/schema.ts`).
2. **Core protocols.** Workspace DO (connections, layers, grants, agents, run registry, outbox, credentials and refresh), Conversation DO (messages, runs, attempts, events, write ledger, page tokens), the connector contract, policy and executor ported with fake connectors, PiHarness with the fake model and the attempt gate, the model wrapper. Start, revocation, attempts, writes and refresh pass their fault tests, in local workerd and on the account, except the rows still open below. Built and integrated 2026-10-11 on `cf-2b-integration` (Step 2 below).
3. **Sandbox and files.** Container image, Sandbox DO lifecycle and hardening, `minerva-fs`, the `ExecutionEnv`, the R2 store, versions and checkpoints. Their fault tests and the sandbox probe pass on the account.
4. **Code mode.** Scripts DO and `run_script`, with their fault tests.
5. **Web API.** Accounts and sessions, organizations (an additive migration; one per personal signup, the UI unchanged), workspaces, agents, conversations, connections and access, uploads, downloads origin, the SSE relay, instance-admin settings and a first-run setup that creates the first admin. The frontend works end to end against a deployed Worker with the fake model and Workers AI.
6. **Connectors.** All 20, one at a time with their ported tests, on the contract from step 2.
7. **Deploy and verify.** A browser walkthrough of every page, the sandbox probe, timings, and an update of this file and of ARCHITECTURE.md with the comparison.
8. **Self-hosting.** Any instance name in any account (resource names derived from it, not fixed to `minerva-cf`), `pnpm run setup` (creates the resources, generates secrets, applies migrations, creates the first admin; Cloudflare's deploy button does not support containers), upgrades by pulling and deploying (additive migrations), an export command (an organization's data walked from its indexes, since Durable Objects have no bulk export; for backups and offboarding), the signed management API, and a self-hosting guide. The Docker and VPS path on `main` retires once this step passes.

Steps 3, 4 and 5 depend only on step 2 and can proceed in parallel; step 6 needs only the contract and executor from step 2.

### Step 2

Three parts were built in parallel (the executor, the Workspace DO, the Conversation DO with the model wrapper) and then wired together:

- **Wiring.** The Conversation's tools call gateway/'s executor, one per run with the snapshot's deadline and the call's abort (pi's, or the run's end, whichever comes first); a call's `tool_call` event comes from the executor's `settled` callback, so a write sent before pi aborted its call is still recorded with its real outcome. Its write ledger and page tokens live in the Conversation's SQLite (schema step 2) through `lib/sql.ts`, the one SQL interface the Workspace's core, the ledger and every object's schema steps share; the restart gate marks the dead instance's dispatched writes uncertain in its own transaction, and `writes_uncertain` mirrors the ledger's uncertain rows in the same transaction. Every change someone acts on once it is made (a write's claim and settlement, a cancel and its revoked flag, a start, a run's end, the gate's decision, a call's `tool_call` event, the replay cap's count) waits until no asynchronous transaction of pi's is open and is then made with no await after that check (`conversation/store.ts` `outside`); progress (deltas, phases, usage counts) may still join one of pi's, and is dropped with it unannounced. The CredentialPort leases from the Workspace over RPC with the attempt checked before and after, and decrypts for the one call. Both objects reach each other only through `addressing.ts` (an EU workspace's pair stays in its jurisdiction; a platform test checks the local seam). One connector registry (`src/connectors/`) serves the Workspace's snapshots and the executor. A run's snapshot holds every grant of the user, so it can pass the 2 MB a value or a row may have without any API limit being broken: one that does is kept in parts (`run_snapshots`, schema step 3), as the Workspace keeps `beginRun`'s answer, and a start the store refuses after `beginRun` is refused with a 503 and released at once instead of being sent again until it expires. The model wrapper keeps the relay's reasoning-summary retry, its metering of refused and unreachable calls (counted, neither metered nor unmetered) and its 120 s read timeout (on the answer's start, on an answer createAI reads whole, and between chunks; the wrapper stops waiting even if the upstream ignores its abort), and screens every message pi gets (The harness, Model).
- **Fault tests in local workerd** (`test/platform/protocols.test.ts`, 35 cases, with the real objects, the fake Notes connector and provider, and the fake model; each interleaving forced with a held fault point, and each case checked to fail when the step it covers is removed): a grant change before the run exists; a revocation between `beginRun` and the start's transaction (a tombstone: stored cancelled by the start's own transaction, never activated); a revocation during a read in flight (stopped before the answer, no request after it); a revocation while a write is in flight (it completes; the call's next request is not sent); the change answered only once its cancel is acknowledged; a crash between storing the run and its activation; a lost activation answer; a crash after the grant commit (the outbox delivers from the next instance); a lost cancel acknowledgement; a start concurrent with a revocation, before `beginRun`, after the start's transaction, and while the cancel is on its way (activation answers revoked); a snapshot over 2 MB (the platform's limit emulated, as local workerd does not enforce it); a start the store refuses (503, nothing left, released); a resumed start refused as revoked (released, its upload attachable again); a crash in a safe tool (replayed once, same call), in an unsafe tool (not replayed; the retry, with its free-form fields in another order, is answered from the ledger), during the model stream; resets until the cap (`worker_exited` at attempt 3; pi starts no model call or tool after the gate's decision); a crash right after the gate every time, with nothing synced (the gate's sync alone advances a1, a2, a3, then `worker_exited`); a gate that throws (decided again on the next event of the same instance); a deadline passed while the object was away (`timed_out` at the gate, no new attempt); an eviction between turns (no restart); a late call from a replaced attempt through the object's own ports (its write, count, lease and appends refused); an attempt replaced while its lease was given (no lease); a write applied then its response lost (uncertain, then both other refusals); claimed then never sent; a crash while dispatched after the provider applied it; a write with under 2 s left (not sent, forgotten, run timed out); a crash during a rotating refresh (one refresh with the stored token afterwards, refused, so Needs reconnecting, no read meanwhile); a crash before the provider heard; a reconnect during a refresh; and the test build's network, which reaches only the fake provider. Still open: a crash during the attachments' copy (the copy comes with step 3's files). Platform tests in `test/platform/conversation.test.ts` also cover a write claimed, and settled, while a transaction of pi's is open that then rolls back (both kept; the same key is not dispatched again), a revocation's cancel arriving during one (acknowledged only once kept), a provider failure whose text, createAI's diagnostics included, appears nowhere in storage, events or logs, and a socket another instance accepted (closed with 1013, then the backlog and `end` from the new socket). Unit tests: 838; platform tests: 96.
- **The test Worker** `minerva-cf-test` (cloudflare/README.md): the same code built from `src/faults/` in mode `faults`, with the fake connector, its provider as a Durable Object, durable fault plans at named points of the objects' ports, and a token-gated driver; its own secrets, settings and resources (`minerva-cf-test` D1 and AI Gateway, `minerva-cf-test-files(-eu)`), all created, and deployed 2026-10-11. Its network reaches only the fake provider. The production entry cannot reach `src/faults/` or the fake model (a unit test walks its imports with TypeScript's own reader, a bundle check runs before each deploy, and every build but the test build's refuses `MINERVA_MODEL_PROVIDER=fake`). The account fault tests (`test/account/faults.test.ts`, 14 cases) pass on it: `ctx.abort()` in a safe tool, an unsafe tool and the model stream; a memory-limit reset in a tool, and repeated ones until the cap; the cap; a crash right after the gate every time with nothing synced, by `ctx.abort()` and by a memory-limit reset (a1, a2, a3, then `worker_exited`); a 75 s tool across PiHarness's heartbeats (no restart); a revocation during a read; a write applied then its response lost; a crash while dispatched; a crash during a rotating refresh; and a Workers AI smoke run with the fake connector's read. Its seams in production code are two optional ports, `ConversationPorts.gate` and `entered`, which production does not set.

Deviations from the protocols above, and why:

- pi's session for a run is created with `pi.createConversation` (what `sessions.create()` calls), since `sessions.create()` takes neither the instructions nor the history replay, which must be written in the creating commit.
- Every transport error on a write is an unknown outcome: `fetch` cannot tell a connection that never opened from one dropped after sending, so writes pause more often than with httpx's ConnectError. The platform's own refusal (403 `error code: 1003`) is a refusal.
- A write already sent when its call is cancelled finishes and settles with its real outcome under `waitUntil`; today the request was cancelled and the write became uncertain.
- A reconnect waits for a refresh in flight in its instance, so a refresh token it keeps is the rotated one; the generation fence ("reconnect wins") then decides only for a refresh whose instance died.
- The reasoning-summary retry looks for "summar" in the provider's error message, as createAI reads it from the body (OpenAI's `error.message`), where the relay searched the body's first 16 KiB.
- A provider's context overflow reaches pi as "The request exceeds the context window of the model.", which pi-ai classifies as an overflow, so pi compacts and asks again; today's relay replaced it with the generic error, so the run failed. An abort reaches pi with pi-ai's own "Request was aborted".
- Model calls go through createAI's readers, not the relay's: a 200 that is not an event stream is read as the answer when it is a chat completion's JSON (the relay refused it, unmetered); usage that only a `response.failed` event carries is lost, so that call is unmetered (the relay recorded it); a chat answer of JSON that stalls is neither metered nor unmetered, since createAI reports its status only once it read the body (the relay never read such a body and counted it unmetered); and since pi's message always has a usage, a report of none in and none out counts as no report.
- A start the Conversation's store refuses after `beginRun` answers 503 "The agent could not finish this run. Try again." and releases its registration; today the one transaction rolled back with a 500.
- The Conversation's `destroy()` is the Agents SDK's, which resolves and then resets the object; the Workspace counts a resolved call as done and retries one that broke. `lease` also refuses `RUN_ENDED` for a run that is not activated, is revoked, ended or another user's, and `deleteConversation` answers with its revocation, as `deleteAgent` does.

Found on the way:

- A Durable Object's SQLite refuses a compound SELECT of seven terms ("too many terms in compound SELECT"); node:sqlite allows it.
- pi commits with the storage's asynchronous `transaction()`, whose callback awaits between its statements (microtasks only). A synchronous statement of ours that runs meanwhile joins pi's transaction and rolls back with it (reproduced: a claim answered `dispatched`, the transaction rolled back, and the same key was dispatched again). The store counts pi's transactions, holds its notifications until they commit, and makes every change someone acts on only when none is open (Step 2, Wiring).
- pi-durable reads its own stored rows with `JSON.parse`, so a tool call replayed from storage can come back with a misread escaped key (Spike results, JSON keys). The wrapper reads the model's text again with `parseJson` before pi validates or stores a call, and a replayed read reads it again too; a strict schema still refuses a misread key pi validated from its own copy. pi needs a safe decoder.
- `ctx.abort()` inside a plain Durable Object's RPC leaves the reset's own rejection unhandled in the isolate, which the platform tests share; vitest ignores exactly those injected resets.

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
- `/assets/<missing>` would get the SPA shell, cached as immutable by the `/assets/*` header rule; the Worker therefore runs first for `/assets/*` and answers a miss with today's 404 (`no-store`).
- The sandbox checks are reworked for this platform (no loopback-only check; network checks over HTTP and TLS, not TCP connect) and run against the deployed Worker.
- A deploy usually reaches a busy object only once it is idle (and may reset it, which counts as a restart), so revocation, policy and security fixes can never rely on a deploy reaching running turns.
- **JSON keys** (found in step 1, in Node 24's V8, in workerd 1.20261006.1 and on the deployed Worker): after any JSON text with the key `"\\"` was parsed in an isolate, a later key written with an escape in the same place (`"\n"`, `"\u00e9"`) comes back as `"\\"`. `JSON.parse`, `Response.json()` and Hono's `c.req.json()` are affected, values are not. The state is per isolate, so one tenant's input could change another's parsed keys and the hashes over them; every port parses JSON with `lib/json.ts`'s `parseJson`, a unit test refuses `JSON.parse` elsewhere in `src/`, and a platform test and the deployed probe keep the bug visible until the runtime is fixed. Still to be reported upstream.

## Open questions

1. Move the executor and the decryption key to a separate Worker script with its own secrets, so the loop's isolate never holds a credential?
2. Warm containers: keep a conversation's container between turns for its idle timeout, or start one per turn as today?
3. pi's state grows with every run (a new session each), and PiHarness cannot delete conversations yet. How large does it get, and does `reset()` or a periodic compaction bound it?
4. A team's Workspace DO serializes its control plane (grants, refresh, run registry). What throughput and revocation fan-out does one object sustain?
5. Retention: run events, the write ledger and page tokens grow with every turn (today without a retention period too). Pick limits per conversation, and measure whether a very long turn approaches the 10,000 subrequests of one invocation (not tested in the spike).
6. Email Sending is in beta; a provider API may be needed for production.
7. Compliance scope: Containers, Dynamic Workers and Secrets Store are missing from Cloudflare's published SOC 2 and HIPAA lists.
8. Residency of an EU workspace beyond its Durable Objects and bucket: where its container's VM runs (no placement constraint for `durable_object` scheduling), where Workers AI and AI Gateway process its prompts, and its users' accounts, which live in the one D1 database (location hint `weur`, not the EU jurisdiction D1 also offers).
9. **Later, not in the current steps (to be designed in the coming weeks): queries across objects.** Durable Objects cannot be queried together, so operator dashboards, admin search and analytics across conversations and workspaces need their own path. The direction: indexes kept in the objects where the product needs them (the conversation list already lives in the Workspace DO), and an append-only export of events to R2 through Cloudflare Pipelines (Iceberg, queryable with SQL), which would also feed the audit log.
10. **Later, not in the current steps (to be designed in the coming weeks): search.** SQLite's FTS5 works within one object only. Full-text search across a workspace needs an index in the Workspace DO, or Cloudflare's Vectorize or AI Search, which also covers semantic (vector) search; pgvector, which ARCHITECTURE.md planned for later, is not available.
