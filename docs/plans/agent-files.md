# Plan: agent files

Status: planned 2026-10-07. The design is [ARCHITECTURE.md, section 7](../../ARCHITECTURE.md#7-agent-files); this file is the order of work. Update it as steps land, and delete it once ARCHITECTURE.md describes the result.

## Goal of the first release

At the end of phase 1, a user can:

- attach files to a message: text, PDFs, Office documents, images and archives, within size limits;
- watch the agent read, write and edit files and run commands in the conversation's folder, several calls at once, as in a local pi session;
- see in each turn which files changed, browse the conversation's current files, and download any of them;
- stop a turn, or have its worker crash, and keep every change from the tool calls whose results the agent had received.

Not in phase 1: images shown to the model, connectors that upload files, previews, zip downloads, and editing the folder from the app.

## Step 0: the demo moves to its own branch

Done 2026-10-07. `main` is the product; the demo runs from the `demo` branch, which takes bug fixes and small changes only (see AGENTS.md, Git). `main` keeps `backend/demo/` and `deploy/demo/` for now, and its tests keep passing. Whether they stay until the launch, or become the cloud's free tier limits, is decided later.

## Phase 1

The steps are in dependency order. Each ends with `make test` and `make lint` passing, and with an opencode review of the diff before it is committed.

### 1. Spike

Done 2026-10-07 under gVisor release-20260928.0 (`runsc-minerva`, systrap) on a local arm64 VM, with the worker's flags and Node 24. The timings are indicative only; repeat them on the cloud's machines. The script is not kept.

| Check | Result |
|---|---|
| Size limit | A 256 MB `/workspace` fails writes with `ENOSPC` at exactly 256 MiB. |
| What the size counts | Each file in whole 4 KiB pages (1 byte takes one, 4,097 bytes two); empty files, directories and symbolic links nothing; a hard link nothing more; a sparse file only its written pages. This is what the gateway will count. |
| Entry limit | **gVisor ignores `nr_inodes`** (runc enforces it). Unlimited, about 450,000 empty files or 650,000 directories fill 1 GiB of memory in 5 to 7 seconds, and the sandbox is then killed for memory. |
| Memory | tmpfs pages count against the memory limit: with 256 MiB in the folder, the heap can grow 256 MiB less. Going over kills the whole sandbox, so the memory limit must cover both tmpfs sizes. |
| Executable folder | Docker mounts `--tmpfs` with `noexec` unless `exec` is given, so today's `/workspace` is not executable. With `exec` it is, under both runtimes. |
| `kill(-1, SIGKILL)` | From the worker (uid 1000, not init, with `--init`), it kills every other process, `setsid` and orphaned ones included, but not itself or init: one round and 2 ms. Against a running fork loop: two rounds and about 40 ms. |
| Fork loop | **A fork loop crashes the sandbox** (exit 2, from gVisor's Go runtime) instead of failing with `EAGAIN`: each sandboxed process also costs about two host processes (34 at rest), so `--pids-limit 256` is reached on the host side at about 110 processes. `--ulimit nproc=256` makes forks fail inside the sandbox, which survives. |
| Scan and hash | 10,000 files in 100 directories (205 MiB): metadata scan 93 ms, scan with SHA-256 of every file 0.6 s. |
| Hydration | Through socat and the volume socket, from a Node server: one 255 MiB blob in 1.4 s, 64 × 4 MiB four at a time in 1.2 s, 9,000 × 25 KiB eight at a time in 3.1 s. The gateway will be slower than this server. |
| Start | A container under gVisor starts and exits in 0.3 s. |

What changes:

- The scan (step 4) enforces the entry limit: it stops after the limit's entries plus one and fails the turn, so a runaway folder costs at most the scan of 10,001 entries. The checkpoint's own check stays.
- `/workspace` is mounted with `exec` (step 5). `nr_inodes` stays, for runc.
- Done 2026-10-07: under gVisor, the container provider sets `RLIMIT_NPROC` to the process limit and the host limit to 64 + 3 × that (not under runc, where `RLIMIT_NPROC` counts every process of uid 1000 on the host), and `make sandbox-check` checks that a fork past the limit fails with `EAGAIN` and that the sandbox recovers. Not yet run under gVisor.

### 2. Store

Done 2026-10-07, in `backend/files/`. It differs from the outline below in these ways:

- Versions also keep a `digest` of their canonical entries, so an identical manifest is recognised without comparing them.
- Objects are tracked rather than listed. A `LooseObject` row is written before each object and claimed (deleted) in the transaction that records its blob; deleting a blob row, by any path, queues its object as loose and subtracts its size from the workspace counter (a database trigger). The sweep deletes loose objects that are due, twice, a day apart. `manage.py files_reconcile` corrects the counters and, with `--storage`, deletes objects that no row names and that are over a day old.
- Blob identity and version contents cannot change (database triggers), and blob rows cannot be deleted through the ORM.
- The S3 backend is tested against moto, not MinIO.

- **Models.**
  - `Blob(workspace, sha256, size, storage_key, created_at, last_used_at)`, unique on (workspace, sha256).
  - `RunBlob(run, blob, created_at)`: the blobs a run uploaded. This is the only way a run gets a blob that is not in a version it may read.
  - `FolderVersion(workspace, conversation, parent, kind, run, attempt, entries, hashes, size, file_count, created_at)`.
    - `kind` is `turn`, `base` or `checkpoint`.
    - `entries` is a JSONB manifest mapping a path to sha256, size, mode and mtime, plus a list of empty directories.
    - `hashes` is the set of its blobs, GIN-indexed, for access checks and garbage collection.
  - `Conversation.folder`: the conversation's current version (null until it has files).
  - `Run.base_version` (the version the run started from).
  - `Run.checkpoint` (its last accepted checkpoint).
  - `Run.result_version` (the version it produced, shown on the turn).
- **Storage.**
  - Each blob is kept under its own key, `blobs/<workspace id>/<sha256>/<random>`, through a `files` entry in Django's `STORAGES`. A blob that the sweep deleted and a run then uploads again gets a new key, so the sweep never deletes an object that a new upload wrote.
  - An object is written before its row and deleted after it. A storage sweep deletes objects that no row names and that are older than an hour, which covers a crash on either side.
  - Settings choose the backend:
    - a local directory (the default, `MINERVA_FILES_DIR`);
    - an S3-compatible bucket (`MINERVA_FILES_S3_*`: endpoint, bucket, region, keys), through django-storages.
  - CI tests the local backend; the S3 backend is tested against MinIO in Compose.
- **Manifests.** One module validates every manifest the gateway receives:
  - paths are relative POSIX, valid UTF-8 in NFC, without `.` or `..` segments, NUL or control characters;
  - a path has at most 1,024 bytes and 32 levels;
  - a version has at most 10,000 entries, counting every directory, including those only implied by a path, since each takes an inode;
  - no path is listed twice, or is both a file and a directory;
  - hashes are 64 lowercase hex digits, modes are `0644` or `0755`, and mtimes are integers within range;
  - sizes come from the `Blob` rows, never from the manifest.
- **Quotas.**
  - Folder size per conversation, measured as tmpfs charges it: each file rounded up to whole 4 KiB pages, with sizes from the `Blob` rows. It is checked on every checkpoint and every base version, and the sandbox's folder has exactly this size (step 5).
  - Total per workspace, optional (the cloud sets it): the sum of its blobs, kept in a counter row.
    - An upload of a new blob is charged with a conditional update in the transaction that records it, so nothing stays held for an upload that never finishes.
    - Concurrent uploads may each stream a whole file before one of them is refused; the gateway's limit on requests in flight bounds this.
    - The sweep subtracts what it deletes.
  - Bytes one run may upload: four times the folder size, charged the same way on the run for every upload, so rewriting a large file in a loop ends the turn.
- **Garbage collection** (a supervisor sweep).
  - It deletes the checkpoints of finished runs, apart from their results.
  - It deletes a blob when nothing names it and its `last_used_at` is more than an hour old. Names come from versions, uploads not yet attached to a message, and the grants of active runs.
  - Whatever starts to refer to a blob updates its `last_used_at`, locking the rows in hash order: an upload of the same contents, a checkpoint naming a blob its parent did not, an attachment.
  - The sweep deletes a row with a conditional `DELETE` that requires `last_used_at` to still be older than the grace, so whichever transaction commits second sees the other's change. An upload that finds its blob deleted stores it again under a new key.
  - Deleting a conversation deletes its versions, and the sweep removes their blobs.
- **Tests:**
  - manifest validation;
  - quota reservations under concurrent uploads;
  - the sweep keeping referenced and recent blobs, racing an upload of the same contents, and removing objects left by a crash;
  - cross-workspace access.

### 3. Gateway and run services

Done 2026-10-07 (`backend/files/runs.py`, `backend/gateway/files.py`), apart from attachments, which move to step 6 with the uploads they come from. Until then a run's base version is the conversation's folder as it is. Differences from the outline below:

- `GET /run` also returns the folder's version id, which is the parent of the attempt's first checkpoint.
- Refusals carry `{"error": {"code", "message"}}`, with `limit` for `quota`. Status codes: `stale` 401, `conflict` 409, `invalid_manifest` 400, `unknown_blob` 403, `quota` 413. An upload over the folder size is refused with `quota` before its body is read, since no file can be larger than its folder.
- `GET /blobs/{sha256}` answers 404 both for a blob that does not exist and for one the run may not read.
- What a run may read is checked against its uploads, its base version and its last checkpoint only: anything in an earlier checkpoint was in one of them. The arrays are compared in the database, never loaded.
- A run keeps only its last checkpoint. Each accepted checkpoint takes the run's base version as its parent and deletes the one it replaces, in its own transaction, so a run that checkpoints small changes in a loop cannot fill the database with whole manifests. The sweep still deletes checkpoints left by finished runs.
- An upload is checked (attempt and budget) before its body is read and again before anything is written to storage. Bytes received for an upload that is not stored (a wrong hash or length, a disconnect) still count against the run's budget.
- Blob transfers run on a pool of their own (16 threads per gateway process), and a run has at most 4 at once per process; more are answered 429. A transfer keeps its place until the blob I/O it started has finished, since a cancelled request does not stop its thread; only then is an upload's temporary file removed and, if it was not stored, its bytes charged.
- Downloads from an S3 bucket stream the object's body: django-storages' `S3File` would download the whole object into memory on its first read.
- `start_run()` reads the conversation's folder after inserting the run, which waits for a run that is ending, so it sees that run's published folder.

- **Run spec.** `GET /run` gains:
  - `folder`: the version to hydrate, that is the run's last checkpoint if it has one, otherwise its base version, with its entries;
  - the folder's limits (bytes, entries);
  - `local_tools`: which of `read`, `write`, `edit` and `bash` the run has. All of them for now; a per-agent switch can come later.
- **What a run may read.** The blobs of its base version and its checkpoints (looked up through `hashes`), and the blobs granted to it. `GET /blobs/{sha256}` and `PUT /checkpoint` both check against this set.
- **`GET /blobs/{sha256}`** streams a blob from storage.
- **`PUT /blobs/{sha256}`.**
  - Routed beside `/mcp` in `gateway/asgi.py`, after `require_run`, so Django never buffers it.
  - Requires `Content-Length` within the per-file limit, and refuses a body longer or shorter than that.
  - Streams to a temporary file while hashing, and refuses a hash mismatch. The temporary file is removed however the request ends.
  - Receives and hashes the bytes even when the store already has the blob: only that shows the run has the contents.
  - Records the blob and the run's grant in one transaction. It first locks the run row and checks that the token's attempt is current, the run is active and its deadline has not passed, as `runs/journal.py` does. It then charges the run's upload budget and, for a new blob, the workspace quota (step 2). An upload that fails a check stores nothing.
- **`PUT /checkpoint`.**
  - The body is `{parent, entries}`.
  - Under a lock on the run row, the gateway refuses the checkpoint unless:
    - the token's attempt is current, the run is active and its deadline has not passed;
    - `parent` is the run's current checkpoint, or its base version for the first checkpoint;
    - the manifest is valid (step 2);
    - every blob is one the run may read;
    - the folder and workspace quotas hold.
  - Each refusal has its own error code: `stale`, `conflict`, `invalid_manifest`, `unknown_blob`, `quota`.
  - An identical manifest is answered with the current checkpoint.
  - The worker never retries a checkpoint. A lost response ends the attempt, and the next attempt starts from whatever the gateway accepted.
- **Ending a run.**
  - `finish()` locks the run row, reads its last checkpoint and publishes it, in the transaction that ends the run. So do `complete()`, `cancel()`, revocation, deadlines and failed restarts, which end in `finish()`. A run without checkpoints publishes its base version.
  - Publishing sets `Conversation.folder` and `Run.result_version`. It turns the checkpoint into a `turn` version whose parent is the base version, so the run's other checkpoints can be deleted.
  - Because `PUT /checkpoint` takes the same lock and checks the status, no checkpoint lands after the run ended.
- **Starting a run.**
  - `start_run()` takes attachment upload ids.
  - It builds the base version, the conversation's folder plus the attachments at the folder root, with a numbered name when one exists (`report (2).pdf`).
  - It refuses the message, before any run starts, if the base version would exceed the folder's limits.
  - It records which paths the message added.
- **Restarts.** `restart()` keeps `Run.checkpoint` and the run's grants; the next attempt hydrates the checkpoint.
- **Tests:**
  - an old attempt is refused, for uploads and checkpoints, including an upload that was streaming when the attempt changed;
  - a wrong parent is refused;
  - a blob known only by its hash is refused, for reading and in a checkpoint;
  - uploads with a wrong hash, a wrong length, no length, or over a limit are refused and leave no temporary file;
  - checkpoints racing `finish()`, `complete()` and `restart()`;
  - publishing on each way a run ends;
  - a message whose attachments would overfill the folder is refused;
  - cross-workspace access.

### 4. Worker

- **Hydrate** (`worker/src/folder.ts`).
  - Before the session opens, download the run spec's folder into `/workspace` with a few downloads at once.
  - Set modes and mtimes, then index each file's path, size, mtime, ctime, inode, mode and sha256.
- **Tools.**
  - Open the harness with `env: () => new NodeExecutionEnv({ cwd: '/workspace' })` and pi-durable's `CodingTools`, beside the gateway tools.
  - The local tools take four of the 128 tools the relay allows (`MODEL_TOOLS_MAX` in `main.ts`). Connector tools that no longer fit are reached only through `run_script`.
  - `cwd` is where commands start, not a boundary. Absolute paths reach the rest of the container, which is read-only apart from `/workspace` and `/tmp`.
  - `read` is marked `replay: "safe"`, so a read cut off by a crash runs again.
  - `bash` gets a `prepare` that sets `inheritEnv: false` and a fixed environment: `PATH`, `HOME=/tmp/home`, `TMPDIR=/tmp`, `LANG=C.UTF-8`, `MPLCONFIGDIR`.
  - `bash` gets a timeout of 10 minutes when the model asks for none, and no timeout may outlast the run's deadline. pi-durable has no default.
  - pi-durable's timeout kills only the command's process group, and output keeps a call open after its command exits. If a call has not settled a minute after its timeout, the wrapper kills every other process, as a checkpoint does. Commands that other calls are running then fail as killed.
- **Quiet-moment checkpoints** (`worker/src/local-tools.ts`). Each local tool's `execute` is wrapped:
  1. Wait while a checkpoint runs (the admission gate), then count the call as running.
  2. Run the original. When it settles, successfully or not, stop counting it and wait for the next checkpoint before returning.
  3. When no local call is running and some are waiting:
     1. close the gate;
     2. kill every other process of the worker's user (`kill(-1, SIGKILL)`), and repeat until `/proc` shows only the worker and init; if that takes more than a few seconds, end the attempt;
     3. scan with `lstat`, hashing only entries whose metadata changed;
     4. upload missing blobs, at most 4 at once (the gateway answers 429 beyond that);
     5. `PUT /checkpoint`, unless nothing changed;
     6. open the gate and release the waiting results.
  4. The wrapper respects `runtime.signal`, so a stopped turn does not hang on a checkpoint.
- **Scan.**
  - Links are never followed.
  - The scan applies the gateway's whole path policy (step 2), so it never sends an entry the gateway would refuse. It skips symbolic links, sockets, FIFOs and devices, and names that are not valid UTF-8 in NFC, contain control characters, or are too long or too deep.
  - The turn's last checkpoint lists what was skipped as warnings, so the chat can show what was not kept.
  - It counts entries as the gateway does and stops after the entry limit plus one, failing the turn as for `quota`, since gVisor does not limit them (step 1). It reads directories incrementally (`opendir`), so a directory with a million entries is not read whole.
  - It measures the folder as the gateway does. Hard links count once per name and sparse files at their full size, so these are the only way a folder that fits the sandbox can exceed the limit.
- **Checkpoint size.** The gateway accepts a `PUT /checkpoint` body of up to 16 MB. A manifest at the limits fits in about 11 MB, unless its paths are full of characters that JSON escapes (`"` and `\`). The worker checks the body's size before sending it and fails the turn as for `quota` when it is over.
- **Failures.**
  - A failed checkpoint first marks the journal's storage as failed, the way a failed journal write does (`storage.ts`). The call's result, and anything after it, is then never recorded. Only after that does the wrapper settle, and `onFatal` ends the attempt.
  - Output the call streamed earlier may already be in the journal. The next attempt reports the call as interrupted.
  - This covers transport failures and `stale`, as well as `conflict`, `invalid_manifest` and `unknown_blob`, which mean a worker bug.
  - `quota` is handled the same way, except that the worker reports the turn as failed, with a message that names the limit, instead of letting it restart. The worker finds an oversized folder in its scan and fails the same way without sending it.
- **Turn end.** Take a final checkpoint that rehashes every file, then report `completed`.
- **Events.**
  - The worker reports local calls (`local_tool` events: tool, a short summary such as the command or path, ok or error, and a capped output excerpt) through `POST /events`.
  - The gateway stores them as reported by the worker, since they are untrusted like agent text.
  - The checkpoints are the trusted record of what changed.
- **Instructions.** A short paragraph in the run's instructions:
  - the folder is `/workspace` and is kept between turns;
  - commands have no network and nothing can be installed;
  - processes left running are killed at the next checkpoint, once no local call is running;
  - a command stops after 10 minutes unless it asks for longer;
  - symbolic links are not kept;
  - the user sees and downloads the files.
- **Fake model.** Scripted turns that write a file, edit it, run Python on it, and run two commands at once.
- **Tests:**
  - the gate and held results, with parallel calls of different lengths, and with a round that pi-durable runs one call at a time;
  - change detection;
  - a failed checkpoint records no result and ends the attempt;
  - a process left running is gone before the scan, and one that escapes with `setsid` and keeps writing output does not hold its call more than a minute past the timeout;
  - a name the gateway would refuse is skipped with a warning, and a sparse file over the limit fails the turn with the limit's message;
  - the end-to-end kill check: kill the container during a long `bash` call; the next attempt has the last checkpoint and reports the call as interrupted.

### 5. Sandbox and image

- **Worker image.**
  - Add `python3` with pinned, hashed packages: pypdf, pdfplumber, python-docx, openpyxl, matplotlib, pillow and pandas.
  - Add `poppler-utils`, `ripgrep`, `jq`, `file`, `zip`, `unzip` and `sqlite3`.
  - Measure the image size and the container start time before and after.
- **Container provider.**
  - `/workspace` tmpfs, mounted with `exec`:
    - size = the folder limit;
    - `nr_inodes` = the entry limit, plus one for the folder itself (runc only; gVisor ignores it, and the scan enforces the limit);
    - since the size charges what the gateway counts, a folder that fits the sandbox passes the checkpoint's size check, apart from hard links and sparse files.
  - `/tmp` grows to 256 MB for pi's output spill files and Python's temporary files.
  - Memory limit = base + both tmpfs sizes, since tmpfs pages count as memory.
- **gVisor by default.** The container provider refuses to start workers without `MINERVA_SANDBOX_RUNTIME` unless `MINERVA_SANDBOX_ALLOW_RUNC=true`. Local development on Docker Desktop sets it; `make setup` writes it into a new `.env`.
- **`make sandbox-check`:**
  - `/workspace` is writable and executable, and fails with `ENOSPC` at its size limit (and at its entry limit under runc);
  - `/tmp` is not executable;
  - a process started by `bash` does not have `RUN_TOKEN` in its environment.

### 6. Web API and chat

- **Uploads.**
  - `POST /api/workspaces/{ws}/uploads`, multipart with one file per request; Django streams file parts to disk.
  - The web ASGI app gets the body limit the gateway has (`limit_body`): the file limit plus a margin on this route, and Django's default elsewhere. Django itself limits only the fields that are not files.
  - Per-file limit (50 MB) and at most 10 files per message.
  - The media type is sniffed from the content, never taken from the browser.
  - An upload not attached to a message within a day is deleted.
- **Attachments** (moved from step 3). `start_run()` takes upload ids and builds the base version: the conversation's folder plus the attachments at the folder root, with a numbered name when one exists (`report (2).pdf`). It refuses the message, before any run starts, if the base version would exceed the folder's limits, and records which paths the message added. Unattached uploads name their blobs for the sweep.
- **Messages.** `post_message` accepts `attachments: [upload id]`. The run's payload lists the paths each message added and each turn's changes (added, modified, deleted, and warnings), computed from its base and result versions.
- **Files.**
  - `GET /api/workspaces/{ws}/conversations/{id}/files?version=` lists a version, the current one by default.
  - `GET …/files/download?path=&version=`:
    - the version must belong to that conversation, in that workspace, and the user must be able to see the conversation;
    - the file name is sent per RFC 6266, as `filename*=UTF-8''…` with an ASCII fallback;
    - with an S3 backend, it redirects to a presigned URL that expires within minutes, with `response-content-disposition=attachment`;
    - otherwise, it streams an attachment response with `X-Content-Type-Options: nosniff` and `Content-Security-Policy: sandbox`.
- **Chat:**
  - Attach button, drag and drop, and paste in the composer (assistant-ui's attachment adapter), with chips on user messages.
  - In the work row: cards for `bash` (the command and its output) and for `write` and `edit` (the path).
  - A files card on each turn that changed files, with downloads.
  - A files panel for the conversation's current folder.
- **Finish.** Run `make api-types`.

### 7. Documents

- ARCHITECTURE.md: section 7 describes what was built instead of the plan, and section 10 its status and gaps.
- README (features and screenshots, `make screenshots`), AGENTS.md (the new settings), `.env.example`.

## Later phases

2. **Images to the model.**
   - The worker sends image parts as `minerva-blob:<sha256>` references. The relay checks that the run may read the blob and inlines it as a `data:` URL: PNG, JPEG, WebP or GIF, size-capped, and only for models declared to take images.
   - Image attachments are re-encoded on upload, without metadata.
   - `read` on an image returns an image block with the same reference.
   - Image bytes never enter the journal.
3. **Connectors that upload files.**
   - Drive and OneDrive `create_file` accept `path` instead of `content`. The executor resolves it against the run's last checkpoint, records the pinned sha256 with the write, so a repeat is recognized, and uploads with the provider's upload API.
   - Then mail attachments (Gmail, Outlook) and Slack files, each with their own permission checks.
4. **Performance and structure:**
   - warm sandboxes kept a few minutes per conversation, which skip hydration;
   - blob caches near workers;
   - lazy hydration of large files;
   - zip downloads and previews of raster images;
   - project folders that several conversations start from;
   - branches when a user edits an earlier message.

## Starting limits

All are settings.

| Limit | Default |
|---|---|
| Folder size per conversation | 256 MB |
| Entries per folder | 10,000 |
| Attachment size, attachments per message | 50 MB, 10 |
| Bytes uploaded per run | 4 × folder size |
| Workspace total | none (the cloud sets one) |
| Path length, depth | 1,024 bytes, 32 |
| Command timeout | 10 minutes, unless the command asks for longer |

## Open questions

- Free-tier quotas, and holding folders larger than memory allows (a disk-backed folder is provider-specific: Docker volumes have no size limit without XFS project quotas, and Kubernetes evicts a pod over an `emptyDir` limit instead of failing writes).
- Encryption of blobs beyond the storage's own.
- Whether a per-agent switch for commands (`bash`) is needed at launch.
- The blob sweep probes every blob older than an hour, named or not, on each pass; at scale it needs a cursor or a candidate marker set when versions are deleted.
- Each checkpoint writes a whole manifest (about 11 MB at the entry and path limits) and deletes the one before, so a large folder checkpointed at every quiet moment means a lot of WAL and vacuum work. Storing a checkpoint as changes to its parent, or a minimum interval between checkpoints, would reduce it.
- Whether paths with format characters (bidi overrides, zero-width) should be refused, or only escaped where the app shows them.
- What happens to files written from a connector's data after access to it is removed (see "History after revocation" in ARCHITECTURE.md's open questions).
