# Minerva architecture

Updated 2026-10-09. How Minerva is built, why, and what is missing. Setup is in [README.md](README.md). What each connector lets agents do, and its limits, is in [docs/connectors.md](docs/connectors.md). Work in progress has a plan in [docs/plans/](docs/plans/).

## Summary

Minerva runs AI agents that **never hold credentials and never decide their own permissions**. Each agent turn runs in a locked-down container whose only way out is a trusted gateway. The gateway holds the keys and checks every action against permissions the user chose. A run never has access to the control API.

| Area | Choice |
|---|---|
| Backend | Python, Django, Django Ninja, Pydantic; one image with several process roles |
| Database | PostgreSQL only: PlanetScale in the cloud, a container when self-hosted |
| Tenancy | Every user has a personal workspace; team workspaces are opt-in (not built) |
| Permissions | Layers that can only narrow: provider account ∩ workspace ceiling ∩ user ∩ agent |
| Login | django-allauth; WorkOS SSO later for enterprise workspaces, never required self-hosted |
| Worker | pi-durable in its own image, one sandbox per turn, reaching only the gateway with a per-run token |
| Durable turns | Worker state is saved behind the gateway; a new worker resumes a turn whose worker died; reads replay, writes never do |
| Files | A folder per conversation kept as versions behind the gateway, worked on with ordinary file and shell tools; attachments and downloads in the chat |
| Sandbox | `SandboxProvider` interface; containers without a network, gVisor in production |
| Models | An OpenAI-compatible relay in the gateway; the backend picks upstream, model, key and caps |
| Chat UI | React, Vite and assistant-ui; conversations stored in our database |
| Order | Personal cloud beta and self-hosting, then teams, then enterprise |

Constraints that shaped all of it: the first offering is a hosted product for individuals that must also self-host on a laptop or VPS; teams and enterprise features (SSO, provisioning, approvals, dedicated deployments) must fit without a rewrite; the agent harness and the sandbox technology must be replaceable without changing the backend; mature, opinionated frameworks are preferred over hand-assembled infrastructure.

## 1. Overview

```text
 Browser (React app)
    │  JSON API + server-sent events, session cookie
    ▼
┌─────────────────── Trusted backend (Django, one codebase) ────────────────────┐
│ web         accounts, workspaces, connections, agents, chat, live updates    │
│ gateway     the only API workers can reach: run spec, MCP tools, model relay │
│ supervisor  claims queued runs, starts/stops sandboxes, deadlines, cleanup   │
└───────┬───────────────────────────────┬───────────────────────────────┬───────┘
        ▼                               ▼                               ▼
   PostgreSQL                 Sandbox container (per turn)      Provider and model APIs
                              worker: pi-durable                (keys live only here)
                                 │ Unix socket, per-run token
                                 └──────────────► gateway
```

| Zone | Trusted? | Holds |
|---|---|---|
| Browser | The signed-in user | Session cookie only |
| Backend | Yes | Provider and model keys, permissions, all state |
| Worker | **No**, treated as hostile | Its run token, nothing else |

All roles run from one codebase. Locally they run under honcho (`Procfile`); in the cloud they scale as separate deployments. Staging runs them on one VPS from images CI builds for every commit of `main` ([deploy/](deploy/README.md)); the public demo does the same from the `demo` branch ([deploy/demo/](deploy/demo/README.md)).

## 2. One chat turn

1. **Browser → web.** The message is stored and a `queued` run is created with a snapshot of the effective permissions and the tool list. A constraint allows one active run per conversation.
2. **Supervisor.** Claims the run (`SKIP LOCKED`, at most 4 at once), issues a run token, and starts a container whose only environment is `GATEWAY_URL`, `RUN_TOKEN` and `RUN_ID`.
3. **Worker.** Fetches the run spec (`GET /run`) and starts a pi-durable agent. Its model points at the gateway relay; its only tools are the gateway's MCP tools, with no shell, files or subprocesses (until [agent files](#7-agent-files)). Read-only tools run in parallel; a round that includes a write runs one call at a time. Earlier messages are replayed up to about 120,000 characters, each cut at 30,000; tool results reach the model whole up to 1 MB. Context is summarized only when it is nearly full.
4. **Gateway.** Model calls go to the configured upstream; the relay parses the stream and publishes text and reasoning deltas as run events every 0.25 s, tagged with their model call. Tool calls go through the [permission pipeline](#3-permissions).
5. **Worker → gateway.** The worker posts only `phase`, `completed` and `failed` events. Each change to its agent state is saved in the run's journal before it takes effect.
6. **End.** On any final state the token is revoked, the saved state deleted, and the container removed.
7. **Browser.** Follows run events over server-sent events, woken by Postgres `NOTIFY`, resuming from the last sequence number after a reconnect. The agent's work folds into one row per stretch ("Used 3 tools"); a call the permissions refused stays a card of its own. Agent text is rendered as Markdown, but images are shown as text and never loaded, and the Content Security Policy blocks remote images: otherwise prompt-injected text could send data out through the browser.

Run states: `queued → provisioning → running → completed | failed | cancelled | timed_out`; a restart goes back to `provisioning`. Stopping a run revokes its token, so the worker's every later call is refused; a write already in flight may still complete. Stopping means "no further effects", not rollback, and security never depends on the container being killed.

**Code mode.** When a run has tools (fewer than the relay's limit of 128), the agent also gets `run_script`: a script in a QuickJS sandbox (pi-codemode, 64 MB, 120 s, no network, files or timers) that can only call the same gateway tools, for example to make independent reads at once or to filter long results before they reach the model. Each call is an ordinary gateway call, checked, recorded and shown as a card. Only what the script prints or returns reaches the model. The worker queues direct and scripted calls together (at most 4 at once, writes one at a time), refuses calls beyond 100 waiting or with arguments over 256 KB, stops a script after 100 refusals, and reports calls left unfinished as cancelled, since a cancelled write may already have happened; the gateway still finishes a call it started, which keeps its place in the queue until then. Values a script `store()`s are saved with the turn when it succeeds, up to 1 MiB. These bounds protect the worker; the gateway's checks are the enforcement.

### Durable turns

A turn survives its worker dying (a crash, or a kill for using too much memory).

- **State behind the gateway.** pi-durable saves each change to the agent's state as a commit, which the worker stores through the gateway (`PUT /journal/{seq}`) before it takes effect. Commits are opaque: stored encrypted, never parsed, capped at 8 MiB each and 32 MiB or 5,000 per run, refused from any attempt but the current one, and deleted when the run ends.
- **Saved state is untrusted.** A compromised worker can write anything into it, so it never becomes a record. Messages and run events stay the history; the next turn starts from stored messages. A resuming worker takes its settings, tools and deadline from `GET /run`.
- **Attempts.** A restart moves the run to its next attempt with a new token. Every gateway endpoint refuses work from an older attempt. A write the old attempt had claimed is still carried out, and the restart waits until it is settled, so the new worker sees how it ended.
- **Only reads replay.** An interrupted read runs again. An interrupted write or script does not, since whether it happened is unknown; the model is told and can check. The same write asked for again (same tool, same arguments) is answered from the run's record, not sent twice.
- **Limits.** At most two restarts per run, none with less than 30 seconds left before a deadline; each attempt gets its own container and 90 seconds to ask for the run spec. The chat drops the old worker's streamed text and shows "Restarting the agent".
- **Versions.** pi-durable is pinned, and each commit names its layout (`pi-durable@1.0.3/1`); a worker refuses state in any other layout.

## 3. Permissions

A grant is **connection + resource kind + resource + actions**, allow or deny. A resource may be `*`, every resource of that kind including new ones. Allows on kinds or wildcards a connector no longer declares are ignored when a run starts; denies always apply. New concrete grants are checked against what the account can see; removals never need the provider. Each connector's kinds and actions are listed in [docs/connectors.md](docs/connectors.md#permissions).

```text
effective = provider account ∩ workspace ceiling ∩ user layer ∩ agent layer   (deny wins)
```

The effective permissions are computed when a run starts and stored with it. Changing access, removing a connection or changing an agent's connections cancels the affected active runs (strict revocation). In a personal workspace the ceiling is unrestricted and never shown: the UI never mentions organizations, roles or ceilings. Each agent uses only the connections selected for it.

Every tool call goes through one pipeline:

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

- **Writes.** Identical writes within a run are deduplicated. A write the provider refused outright, or that never reached it, is forgotten. One whose outcome is unknown (a timeout) is uncertain and pauses the run's further writes; the supervisor marks writes whose gateway process died as uncertain. A write is dispatched under a row lock with a deadline fixed at dispatch, and a provider request sent after the executor judged the attempt is refused. The executor checks revocation around every await.
- **Tokens.** If a provider rejects a connection's token, the connection is marked **Needs reconnecting**, unless it was reconnected meanwhile (a generation counter). Reconnecting keeps the user's choices. Only the owner can reconnect a personal connection, and only an admin a shared one.
- **Changed tools.** A run snapshots a fingerprint of each tool's declaration. If a deploy changes what a tool means, active runs lose it (`OPERATION_CHANGED`) rather than use it under old grants.
- **No caps on work.** A turn has no limit on writes, model calls or tool calls, so an agent can work on one prompt as long as it needs. What is limited is how fast, and the run token's reach:

| Limit (per gateway process) | Value |
|---|---|
| Writes executing at once, per run | 1 |
| Tool calls executing at once | 4; the rest wait |
| Requests in flight per run token | 16; more get 429 before their body is read |
| Token checks queued or running, all runs | 128; more get 503 |
| Model calls reading from the provider | 4, counting calls the worker hung up on |
| Output tokens per model call | 8,192 |
| Wall-clock time per turn | none by default (`MINERVA_RUN_TIMEOUT_SECONDS`); 300 s on the demo |

A request without an active run's current token is refused with 401 before Django or the MCP server reads its body, since Django buffers a whole body before any view runs. The checks run one at a time on one database connection per gateway process, so a worker sending invented tokens quickly can get other runs' requests refused with 503, and a stalled query holds up every check (an availability weakness). Views check the run again once they have the body, because it may have ended or restarted meanwhile. A response holds its request's place until the worker has read nearly all of it, so a worker cannot pin large responses in gateway memory. The MCP endpoint takes only POST: a GET would open a stream that outlives the token. Without a deadline, the worker gives up on a tool call after 10 minutes and the relay drops a model answer quiet for 120 seconds.

## 4. Connectors

A **connector** declares resource kinds, actions (with dependencies such as "create requires read") and operations. Each operation has a strict Pydantic input model and a `prepare()` step that resolves the real resources a call touches: `Need(resource, action)` for a concrete resource, or `Enumerate(kind, action)` for a listing filtered afterwards. The executor rejects a call whose requirements do not match the operation's declared needs, and a write that enumerates or names no concrete resource, so a connector mistake fails closed. How to write one is in [backend/connectors/AGENTS.md](backend/connectors/AGENTS.md); design notes for each provider are in its module docstrings.

- **Canonical ids.** Grants and records use the id the provider lists. Aliases (`primary`, a differently cased address, a name) are resolved before authorization, so a deny cannot be bypassed under a wildcard allow.
- **Hierarchies.** A nesting kind (Drive folders, Notion pages, Linear sub-teams) carries each resource's ancestors. An allow on the resource, an ancestor or `*` allows it; a deny on any of them blocks it. Unknown ancestors never help an allow, and an incomplete chain is blocked by any exact deny for that action. The executor rejects malformed ancestry (wildcards, duplicates, a resource inside itself, more than 64 ancestors, ancestry on a flat kind). Drive resolves ancestry again just before it reads, lists or creates, refusing a file that moved in between (`FILE_MOVED`).
- **Several kinds.** An operation may need actions on more than one kind (an Outlook reply needs Read on a folder and Send on its recipients); records scoped to a kind without the operation's output action are dropped.
- **One write per operation.** A mutating operation sends one mutating request, only from `execute()` and only with time left. The executor judges the write by what the provider client recorded, not by what the connector returned.
- **Provider consent.** A connection starts with the connector's base scopes only. When the user allows an action whose scopes are missing, the connection offers a flow bound to it that asks for the scopes of every allowed action (incremental where the provider supports it) and refuses a different provider account. Tools whose scopes are missing are not offered; a call made after scopes shrank fails with `CONSENT_REQUIRED`.
- **Connections** belong to a workspace and are personal (the user's own OAuth, so the provider's permissions also apply) or shared (admin-made; a team feature, not built). Tools are namespaced per connection, and the gateway routes each call to a connection it chose, never one named in model arguments.
- **Credentials** are encrypted with a key-versioned application key (`MINERVA_ENCRYPTION_KEYS`), so a KMS can replace it later. OAuth apps are configured per app (`MINERVA_<APP>_CLIENT_ID`), and a token is refreshed only through the client that issued it. Todoist registers its own client; OAuth is plain httpx rather than Authlib. API-key connectors (Stripe) and built-in services (the Web) use the same contract.

Content from providers and web pages is untrusted input to the model. Filtering what agents see does not neutralize prompt injection; it bounds what an injected agent can reach.

## 5. Sandbox

```python
class SandboxProvider(Protocol):
    def start(self, run_id: UUID, image: str, env: dict[str, str], limits: Limits) -> Handle: ...
    def stop(self, handle: Handle) -> None: ...
    def status(self, handle: Handle) -> SandboxStatus: ...
```

A provider has one security duty: **the worker reaches the gateway and nothing else**, with no host credentials or readable secrets. It passes the channel as `GATEWAY_URL`, an http(s) URL or `unix:<path>`.

| Provider | Status | Use |
|---|---|---|
| `container` | Built | Docker or Podman, optionally gVisor; self-hosting and the demo |
| `local-process` | Built | Development only; no isolation; refuses to start unless enabled |
| `kubernetes` | Planned | Cloud: a Pod per run with a gVisor or Kata runtime class and network policy |
| `macos-srt` | Planned | Mac development through the Anthropic Sandbox Runtime |

The `container` provider runs each worker with a read-only root, a writable and executable `/workspace` the size of the conversation's folder limit (256 MB by default) and a 256 MB non-executable `/tmp`, user 1000, all capabilities dropped, `no-new-privileges`, no shared IPC, 1 GB memory plus both tmpfs sizes, 1 CPU and 256 processes, and **no network** (`network_mode: none`, only its own loopback). Its one way out is the `minerva-gateway-socket` volume, mounted read-only, holding a Unix socket that a `gateway-socket` container (socat) forwards to the gateway. A loopback bridge in the worker keeps its HTTP clients unchanged. The provider checks that Docker reports no network and exactly that mount before starting the container.

- **Why no network.** A network shared by workers let them reach each other, and a network per run costs a bridge and an address range per turn. With none there is nothing to share, under runc and gVisor alike.
- **gVisor** refuses host-mounted sockets unless started with `--host-uds=open`, so register a runtime for it (`runsc install --runtime=runsc-minerva -- --host-uds=open`) and set `MINERVA_SANDBOX_RUNTIME=runsc-minerva`. The cloud requires gVisor or Kata from the first beta, since strangers' runs share machines. Workers run arbitrary commands, so the provider refuses to start them outside gVisor unless `MINERVA_SANDBOX_ALLOW_RUNC=true`, which local development on Docker Desktop sets.
- **Conformance.** `make sandbox-check` runs a probe in the real image next to a second worker. It checks 21 properties: non-root, only the run token in the environment, root read-only, `/workspace` writable and executable and full at its size (and entry limit under runc), `/tmp` not executable, commands run through the real `bash` tool without the run token and their leftover processes killed, the gateway reachable and the socket's directory unchangeable, only loopback, blocked IPv4 and IPv6 internet, cloud metadata, public DNS, host, database and the other worker, and a process limit that refuses a fork with `EAGAIN` within 32 processes of the configured limit (the worker's own threads count too) and lets processes start again afterwards. All 21 passed locally with runc on 2026-10-09; the first 14 passed on the demo with gVisor on 2026-10-06.
- **Process limit under gVisor.** Each process in the sandbox also costs about two host processes, so a fork loop reaches Docker's `--pids-limit` on the host side first, and the whole sandbox exits instead of the fork failing. Under gVisor the provider therefore sets the limit inside the sandbox (`RLIMIT_NPROC`, which gVisor counts per sandbox) and the host limit to 64 + 3 × that, so forks fail with `EAGAIN`. The headroom is measured (about 34 + 2 per process), not guaranteed across gVisor versions; the conformance probe checks it. gVisor is recognized when the configured runtime, else Docker's default (read once and then named on every container), is its containerd shim by name or a runtime whose binary is `runsc`; Docker does not report what a shim alias stands for, so an alias for gVisor's shim is not. Not under runc, where `RLIMIT_NPROC` counts every process of the worker's uid on the host.
- **Known weakness.** Workers share the socket relay (at most 128 connections, none dropped for idling), so a compromised worker could hold every slot and block other workers from the gateway. This affects availability only; a relay per run would remove it.
- **Self-hosting.** Giving the backend the Docker socket is root-equivalent on the host. A narrow sandbox runner, or rootless Podman, should replace it.

## 6. Models

The gateway exposes an OpenAI-compatible endpoint to the worker and routes it through our own `ModelProvider` interface. The backend chooses upstream, model, key and token caps; the worker cannot.

- **Wire API.** The Responses API by default, since current reasoning models combine reasoning with function tools only there; Chat Completions for servers without it (`MINERVA_MODEL_API`).
- **Allowlist.** The gateway rebuilds every request rather than forwarding it: it forces the model, the output cap, `store: false` and the reasoning settings, accepts only function tools and text, and refuses hosted tools, stored-item references and image or file inputs, each of which would let the provider fetch or reveal data for the worker. Reasoning is replayed between tool calls as encrypted content the gateway never reads.
- **Reasoning summaries** are requested and streamed to the chat apart from the answer. An upstream that refuses them with a 400 (OpenAI, for unverified organizations) gets the request again without, and is not asked again until the process restarts.
- **LiteLLM** may be used as a pinned, hashed library behind the interface, never as LiteLLM Proxy: its 2026 PyPI releases 1.82.7 and 1.82.8 shipped a credential stealer, the Proxy had actively exploited vulnerabilities, and its users and keys would duplicate our tenancy.
- **Keys and cost.** Each model call records its usage on the run. Planned: a platform key with per-workspace quotas, and bring-your-own key per workspace, stored like connection credentials.

## 7. Agent files

Built 2026-10-07 to 2026-10-09; [docs/plans/agent-files.md](docs/plans/agent-files.md) records each step and how it differs from its outline.

Each conversation has a folder that the agent works in as on a laptop: pi's ordinary `read`, `write`, `edit` and `bash` tools on a real directory, called in parallel. Sandboxes stay one per turn.

- **Store** (`backend/files/`). File contents are blobs named by SHA-256, stored once per workspace through Django's storage API (an S3-compatible bucket, or a local directory), each under a key of its own. A folder version is an immutable manifest in Postgres with a parent and a digest; a conversation points at its current one. Only the backend holds storage credentials. Objects are tracked rather than listed: each is recorded as loose before it is written and claimed when its blob row is, and the sweep deletes loose objects, unattached uploads and finished runs' checkpoints. Database triggers keep blob identity and version contents unchangeable and the workspace's byte counter right.
- **Working copy.** A turn downloads its starting version into `/workspace` (at most 4 transfers at once, each checked for size and hash). That is a tmpfs whose size equals the folder's limit as the gateway counts it (each file in whole 4 KiB pages), so a full folder fails with `ENOSPC`. gVisor ignores tmpfs inode limits, so the scan enforces the entry limit, and the memory limit bounds what a runaway costs. Commands run without network, without the worker's environment (which holds the run token), with a timeout of 10 minutes unless the model asks for longer, never past the run's deadline, and with only the tools in the image: Python with document, spreadsheet, plotting and data libraries, poppler, ripgrep, jq, sqlite3 and similar.
- **Checkpoints at quiet moments.** Results of calls that can change the folder are held. When no local tool is running, the worker kills leftover processes (where the provider gives it a PID namespace), scans the folder, uploads changed blobs (`PUT /blobs/{sha256}`), sends the manifest with what the scan left out (`PUT /checkpoint`, accepted only from the current attempt on top of its previous checkpoint), then releases the results; new calls wait meanwhile. So no result the journal records describes files the gateway lacks. A round of reads needs no checkpoint. A failed checkpoint ends the attempt without recording the result. A call that has not settled a minute after its timeout has its leftover processes killed, and the attempt ends if it still does not settle.
- **Crashes and turn end.** A new attempt starts from the last checkpoint, on any machine. The run keeps only its last checkpoint, which becomes the conversation's next version in the transaction that ends the run, however it ends; the run records what the turn added, changed and deleted, and what the scan could not keep (symbolic links, special files, unreadable entries, names too long or deep). A folder over its size or entry limit is not saved in part: the turn fails and says which limit it hit.
- **Attachments.** The composer uploads each file as soon as it is added, as the raw body of `POST /api/workspaces/{ws}/uploads`. That route is an ASGI app beside Django, since Django buffers whole request bodies: it checks the session, CSRF token and membership from the headers, then streams the body to a temporary file while hashing it. The media type is sniffed from the content and the name cleaned to one valid path segment. Sending a message names its uploads, which are added at the folder's root (numbered when the name is taken) as the version the run starts from, in the transaction that starts it. A message over the folder's limits is refused before any run starts, and the composer gets it back.
- **Downloads.** Users download any file of a version the conversation's runs started from or produced. The backend streams it as an attachment with `nosniff` and `Content-Security-Policy: sandbox`; presigned URLs on the storage's origin are planned for the cloud. Agent files are never shown inline from the app's origin.
- **Chat.** The work row shows each local tool call with its command or path and the end of its output. A turn that changed files gets a card with downloads and the scan's warnings, and a files panel lists the conversation's current folder.
- **Files are untrusted.** Attachments and agent files are parsed in sandboxes, never in the backend (the OneDrive connector's Office reader is an existing exception). A run reads only blobs from its starting version, its last checkpoint, or its own uploads, and an upload is hashed even if the store has it, so knowing a hash does not reach another conversation's file. The gateway validates every manifest's paths and takes sizes from its own records.
- **Limits** (settings): 256 MB and 10,000 entries per folder; uploads by a run up to four times the folder size; 50 MB per attached file and 10 files per message; paths of at most 1,024 bytes and 32 levels; optionally a total per workspace.
- **Later.** Images to the model as blob references the relay inlines; connector uploads (Drive, OneDrive) that take a path pinned to a blob, so contents never pass through the model; warm sandboxes, project folders and branches.

Consequences: workers run arbitrary commands, so production needs gVisor, Kata or a microVM, and runc needs an explicit setting. Every provider must offer an executable working folder whose size limit fails with `ENOSPC`. Unlike a laptop, processes left running are killed at each checkpoint, commands have no network, a crash can lose changes since the last checkpoint, and only regular files and directories are kept. Commands run as the worker's user, so one that looks for the run token can find it in the worker's memory; that is accepted, as the worker is already treated as hostile.

Rejected: saving only at turn end (a crash would lose files the journal says were written); saving after each call one at a time (no parallel tools); freezing processes with `SIGSTOP` (not a sound barrier); persistent host folders or FUSE over object storage (provider-specific, privileged or credentialed next to the sandbox); snapshotting whole sandboxes (large, hard to self-host); gateway file tools instead of a folder (awkward, no commands); multipart uploads through Django (it buffers the body before any check).

## 8. Tenancy, accounts and data

- **Workspaces.** The tenant is a workspace, `personal` or `team`; signing up creates a personal one. One database schema: every tenant table has a non-null `workspace` key, scoped managers filter by the current workspace (set from the session and URL, or from the run token in the gateway), unscoped queries appear only in named platform code, and tests check that every endpoint refuses cross-workspace access. Schema per tenant was rejected: migrations multiply and it fights Django. An enterprise needing stronger isolation gets a dedicated deployment of the same code.
- **Roles.** One login per person; owner, admin and member are rights inside a workspace (`Membership`). The platform operator is Django staff, separate from any workspace role. A company wanting dedicated admin accounts grants the admin role only to those.
- **Identity.** Our `User`, `Workspace` and `Membership` tables are always the source of truth, and every login ends in an ordinary Django session. Built with django-allauth (headless): email sign-up with verification, password or emailed code, password reset, and two-factor with an app and recovery codes. Planned: Google and GitHub login, passkeys in the UI (the backend supports WebAuthn), and WorkOS SSO and Directory Sync for enterprise workspaces in the cloud. WorkOS never becomes the source of truth, and self-hosting never depends on it.
- **PostgreSQL only.** It gives `SKIP LOCKED` queues, `LISTEN/NOTIFY` for live updates, JSONB, and full-text search and pgvector for later, without a portable subset. On PlanetScale, app traffic goes through PgBouncer in transaction mode, without server-side cursors or prepared statements; migrations and the one `LISTEN` connection connect directly. Row-level security is not the tenant boundary.

| Table | Contents |
|---|---|
| `User`, `Workspace`, `Membership` | Accounts, workspaces, roles |
| `Connection`, `OAuthClient` | Encrypted provider credentials; registered OAuth clients |
| `PermissionLayer`, `Grant` | Ceiling, user and agent layers with allow and deny grants |
| `Agent` | Name, instructions, connections |
| `Conversation`, `Message` | Chat history |
| `Run`, `RunEvent` | Status, attempt, permission snapshot, token hash, deadline, usage, sandbox handle; ordered events |
| `RunCommit` | A running turn's saved state, encrypted and never read; deleted when the run ends |
| `RunWrite`, `RunPageToken` | Write state and deduplication; run-bound page tokens |
| `Blob`, `RunBlob`, `FolderVersion`, `Upload` | Agent files: contents by hash, what a run uploaded, folder versions, files waiting to be attached |
| `WorkspaceStorage`, `LooseObject` | Bytes stored per workspace; stored objects no row names yet |

Secrets live only in `.env` (mode 600, gitignored). The supervisor removes containers no run owns.

## 9. Frontend, background work, packaging

- **Frontend.** One React and Vite app for chat and settings on assistant-ui, through a custom runtime. Django admin is for platform staff only. Open WebUI and LibreChat were rejected: each is a second control plane with its own users and models, and an OpenAI-compatible integration would lose tool events, denials and files.
- **Background work.** The supervisor claims runs, enforces deadlines, reconciles runs whose sandbox disappeared, and removes orphaned containers. There is no task queue yet; Django's tasks API with a Postgres backend (or Procrastinate) comes when a second kind of job does.
- **Packaging.** One backend image whose role is chosen at start, and one worker image per harness: replacing pi-durable means a new worker image, not backend changes. Cloud: Kubernetes with gVisor or Kata and PlanetScale in the same region. Self-hosted: Docker Compose with Postgres and the container provider. Differences are settings (sign-up mode, sandbox provider, model keys, quotas, email), never `if cloud` branches. Today there is local development (Compose and honcho) and the demo's single-VPS Compose stack.
- **Security baseline.** Dependencies locked with hashes and upgrades reviewed, and no install scripts run in production images; provider and model credentials only in the backend; run tokens random, stored as hashes, bound to one run and attempt, expiring at the run's deadline, and revoked on any final state; provider content treated as untrusted data, with refusals returned as plain results. Audit records are planned for tool calls, permission and connection changes and admin actions; until then, run events record every tool decision.

## 10. Status

Built: accounts and two-factor sign-in, a personal workspace per user, 20 connectors with resource-level permissions ([docs/connectors.md](docs/connectors.md)), agents with their own instructions and connections, streamed chat that shows every tool call, code mode, a hardened container per turn, durable turns, and agent files with attachments and downloads.

| Check | Result |
|---|---|
| Backend tests (`make test`, needs Postgres): includes cross-workspace access and the connector contract | 1070 pass (2026-10-09) |
| Worker tests: includes pi-durable's storage conformance suite and resuming after each kind of interruption | 118 pass (2026-10-09) |
| Lint, typechecks, production build | Pass |
| Sandbox conformance | 21/21 locally with runc (2026-10-09); 14/14 on the demo with gVisor (2026-10-06) |
| A worker killed mid-turn (`docker kill`, fake model) | Resumed without rerunning the read or the script; failed after the second restart; state and containers cleaned up |
| Browser walkthrough | Sign-up, verification, streaming, tool cards, reconnect prompt, agents, two-factor setup; attaching, sending and downloading files with the fake model's file tools (2026-10-09) |

Not verified: a real Todoist account, a real model provider, a cloud deployment, and agent files under gVisor.

**Known limits of agent files.** Two checks need a harness that drives a worker container through attempts and are not done: killing the container during a long `bash` call, and a detached process that keeps writing past its timeout. Downloads stream through the backend rather than from presigned URLs. Images and documents are not shown to the model, only to its tools.

**Known limits of durable turns.** A model or tool call cut off by a dropped connection fails rather than passing to a new worker. A turn cannot wait for an approval without holding its container, and one without a deadline holds a container and a run slot until it ends. A long turn is bounded by what it stores (32 MiB of state, 200 page tokens), while its run events and `RunWrite` records grow with it. Each turn is its own pi session: no steers, follow-ups or background subagents. Restarts count whatever the cause. `RunWrite.result` is stored unencrypted, and it and `RunPageToken` have no retention period.

**Next, roughly in order:**

1. Cloud alpha: production images for the three roles, a cluster with gVisor or Kata, PlanetScale, SMTP email.
2. Audit records.
3. Teams: team workspaces, invitations, a workspace switcher, the ceiling UI, shared connections.
4. Login options: Google, GitHub, passkeys in the UI.
5. Model keys: bring-your-own key per workspace, and quotas.
6. A cap on web searches per run or workspace (each costs the operator), and egress rules for the gateway.

Later: SSO and directory sync, groups, approvals and a two-person rule for high-risk actions, retention policies, support-access controls, a database role per process role, and single-tenant deployments.

**Open questions:**

- Cloud sandbox runtime: GKE Sandbox (gVisor) or Kata elsewhere; needs a spike on startup time and the conformance suite.
- The self-hosted sandbox runner's API.
- Free tier: quotas, bring-your-own-key terms, abuse limits, and folder sizes larger than memory.
- History after revocation: which earlier messages and files may enter a new run after permissions narrow.
- Whether blobs need encryption beyond the storage's own (per-workspace keys would rule out presigned downloads).
- Cloud login: allauth only, or WorkOS AuthKit from the start.

## 11. Technology

| Area | Choice |
|---|---|
| Backend | Python 3.14, Django 6.1, Django Ninja, Pydantic, django-allauth (headless, MFA), MCP SDK 2.2, httpx, psycopg 3, uvicorn |
| Database | PostgreSQL 18 (Compose locally) |
| Worker | Node 24, TypeScript, pi-durable 1.0.3, pi-ai, pi-mcp, pi-codemode, zod |
| Frontend | React 19, Vite 8, TanStack Router, Query and Form, assistant-ui 0.15, Tailwind 4, Radix, a Hey API client generated from OpenAPI |
| Tooling | uv, pnpm, Ruff, pytest, honcho |

The frontend stays on TypeScript 5.9 because the Hey API generator does not run on TypeScript 7.
