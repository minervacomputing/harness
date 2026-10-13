# Plan: the sandbox on the Sandbox SDK, and the last carryovers

A follow-up to [cleanup.md](cleanup.md). The sandbox still carries the old Node worker: `minerva-fs`, a 1,425-line Python helper with 578 lines of Python tests and a vector file, copies the old worker's file semantics (Node's errno mapping and wording, "today's hydration", "files spec 8.1"), and a unit test pins the image's Python packages to `../worker/python`. A few Django helpers remain elsewhere (`salted_hmac`, comments about earlier steps). This plan replaces our own container code with Cloudflare's Sandbox SDK and standard tools, and deletes `minerva-fs`. The accounts layer has its own plan later.

## What the SDK gives us

`@cloudflare/sandbox` 1.0 (already a dependency, pinned 1.0.0, unused so far) is deliberately small. The Durable Object owns the container through `ctx.container` (start, `exec`, destroy), as ours already does. The package adds:

- **`Files`**: `readFile` (streamed), `writeFile` (streamed), `stat`, `lstat`, `readDirectory`, `mkdir`, `rename`, `remove`, with Linux errno codes, each run by `sandbox-shim` (a static amd64 Rust binary copied into the image) through one `exec`, with a numeric `user` and an `AbortSignal`.
- **`DirectoryBackup`**: one directory as one tar+zstd object in R2. Not used: the files model keeps per-file versions, blobs and downloads, and a backup cannot restore onto the mounted `/workspace` (`EBUSY`).
- **`S3Mount`**: a bucket mounted with FUSE, explicitly not POSIX. Not used: the agent's tools (pandas, sqlite3) need a POSIX folder.

The 0.x `Sandbox` class is gone in 1.0; exec, processes and isolation are the application's. So the lifecycle and fences (`core.ts`), the hardening and its verification, the wrapper and command execution stay ours.

## Security model, and what we accept

The boundary is the Firecracker VM: no route out, nothing secret inside, one container per turn, holding only the conversation's own folder. The hardening keeps the agent's commands unprivileged (uid 1000, no capabilities, `NoNewPrivs`, the agent cgroup, a read-only root) so a turn stays within its limits and cannot tamper with what reports on it; that does not change. What the Durable Object reads from the container is validated (the Conversation validates every manifest, R2 checks every upload's SHA-256), as now.

An earlier version of this plan was reviewed by opencode (2026-10-13). Its findings about `Files` are real, but each one stays inside the hostile VM and its own conversation, so we accept them for a much smaller sandbox:

- **`Files` runs outside the wrapper**: as uid 1000 through `exec`'s `user`, but outside the agent cgroup and without `setpriv`'s extra drops. It runs only `sandbox-shim`, never agent code. Agent commands still go through the wrapper.
- **Frame lengths are not accepted as they are.** The SDK allocates a data frame of whatever length the shim declares (`ShimControl.readFrame`), up to 4 GiB, before checking it. That allocation happens in the Worker's isolate, which other conversations' objects may share, so it reaches beyond the VM. A `pnpm patch` of the SDK caps a data frame at 16 MiB (a protocol error above that), and we report it upstream. A unit test feeds an oversized frame header.
- **Reads follow the path**: `BinaryReader` reads the path again on each call (`Files.readFile`) instead of holding the file open, and checks size and mtime against what it saw at open. A rename or rewrite during a `read` call gives an error or the new contents; pi's conformance cases that pin held-open reads and final-component `noFollow` are skipped with this reason.
- **FIFOs and devices**: reading one blocks until the operation's timeout instead of failing at once. Only the agent's own call waits.

What we keep:

- **Hydration, scans and checkpoints stay confined to `/workspace`**. They run through the wrapper as uid 1000. Scans and checkpoints run only after `cgroup.kill` has emptied the agent cgroup, and nothing else writes the folder until they finish. `find -P` never descends a symlink, `tar` archives a link as a link, and the checkpoint takes only paths the same scan reported as regular files under real directories.
- **One test per accepted trade-off** shows it stays bounded: a FIFO read ends at the timeout, and a broken shim answer fails the call without taking down other conversations.

## Units

One fresh agent per unit, in sequence, on the `sandbox-sdk` branch (worktree `.claude/worktrees/sandbox-sdk`), merged into `cloudflare` when done. The process is cleanup.md's preamble: an opencode review of each diff, `pnpm typecheck`, `test:unit` and `test:platform`, plus `test:docker` for every unit that touches the sandbox.

**L. Small leftovers.**
- **`salted_hmac`**: `saltedHmacHex` (Django's construction, SHA-1 for write ids) is replaced by `hmacSha256Hex` with a purpose label for write ids, the probe token and the faults token, and their tests are updated.
- **The image**: the Dockerfile describes this image, not "today's worker image". `container/python/requirements.*` are its own, and the unit test that compares them with `../worker/python` goes. The probe keeps its checks, and its comments lose `worker/src` and "today's".
- **Comments and messages**: the Fernet check and "step 6b" in lib/encryption.ts, and "(plan: …, step N)" references in `src/` that no longer help.
- **Python names in lib/**: `unquote` becomes `percentDecode` and `htmlUnescape` becomes `decodeCharacterReferences`, each with its callers.
- **Not here**: the UUID forms and the `code_mode` remark in api/input.ts are rewritten by frontend-cleanup.md's A3, and `randomString` goes with A1's CSRF change.

**S1. `Files` for pi's file operations.**
- **The image** gets `COPY --from=docker.io/cloudflare/sandbox:1.0.0@sha256:<digest> /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim`. First check that the amd64 shim runs in the arm64 Docker test image; if not, the Docker tests build for `linux/amd64`.
- **The Docker stand-in** for `ctx.container` (test/docker/sandbox-docker.ts) supports what `Files` passes to `exec`: `user`, streamed stdin and stdout, and `signal`.
- **pi's `FileSystem`** (sandbox/env.ts, sandbox/files.ts) maps onto `Files` with `user: "1000:1000"` and a timeout signal:

  | pi | `Files` |
  |---|---|
  | `readTextFile`, `readBinaryFile` | `readFile`, bounded as now |
  | `writeFile` | `mkdir` of the parent, then `writeFile` |
  | `fileInfo`, `exists` | `lstat` (pi's semantics) |
  | `createDir`, `remove`, `renameFile` | `mkdir`, `remove`, `rename` |
  | `listDir`, `openDirReader` | `readDirectory`, then `lstat` per entry, bounded |

  Only the conformance suite uses the listing operations; pi's tools use `canonicalPath`, `exists`, `fileInfo`, `openBinaryReader`, `readTextFile` and `writeFile`.
- **What `Files` lacks** goes through the wrapper, one coreutils command each, with the path as an argument: `canonicalPath` (`realpath -e --`), `createTempDir` and `createTempFile` (`mktemp`), `truncateFile` (`truncate -c -s`), `flushFile` (`sync --`), `appendFile` (stdin into `dd oflag=append conv=notrunc status=none`), and the output spill (stdin into `cat >`). Their failures map to `unknown` or `not_found` by a pre-check, not by parsing stderr.
- **`watch`** polls (`mode: "polling"`): a `find -printf` snapshot of its targets, compared each interval.
- **`BinaryReader`** works as the trade-offs above say. `scanLines` and `read` stream the file through pi's `LineScanner`.
- **Errors**: `SandboxFileError.code` maps to pi's `FileErrorCode` in one table, with short messages of our own.
- **`minerva-fs`** loses everything except `scan`, `hydrate` and `pull-many`.
- **Tests**: pi's conformance suite in `test:docker`, minus the documented cases; a unit test of the error table; the Docker tests updated.
- **Measured** (S1, `test:docker` on an arm64 Mac, one `docker exec` per call, the amd64 shim under emulation): pi's read tool takes 450 to 550 ms on a small file (eight calls in sequence) and 1.3 to 1.6 s on a 50 MB file (0.7 to 0.9 s from line 1,000,000); `writeFile` of a small file takes 30 to 45 ms.

**S2. The folder through standard tools; `minerva-fs` goes.**
- **Hydration**: the Sandbox object writes a tar of the version's files (regular files and directories only, PAX headers for long paths, mode and mtime from the plan) into `tar -x --no-same-owner -C /workspace`, run through the wrapper as uid 1000. Each blob is read from R2 once and its SHA-256 checked as it streams. A blob shared by several paths is either buffered once, when small, or read again for each later path, when large; the extracted files stay independent. Before extracting, `Files.readDirectory` checks that the folder is empty.
- **Scan**: one wrapped `find -P /workspace -mindepth 1 -printf` with NUL-separated type, size, blocks, mtime and ctime (as decimal strings, parsed exactly), inode, device, mode and path. It is read as a stream with the entry and byte limits, and the process is killed at a limit. TypeScript then:
  - applies the scan policy that `minerva-fs` applies today: warnings for skipped names and kinds, pruned subtrees, page-rounded sizes;
  - keeps the index, so unchanged files are not hashed again, with racy-mtime handling;
  - hashes the changed regular files with one wrapped `xargs -0 sha256sum --zero --`, paths on stdin.
- **Checkpoint**: one wrapped `tar -c -C /workspace --no-recursion --hard-dereference --null -T -` of the plan's paths. Each entry must be a regular file with the planned name and size, in the planned order, and streams into R2 with its claimed SHA-256. Anything else, or a missing, extra or duplicate entry, fails the checkpoint as `mismatch`.
- **A small tar reader and writer**: `modern-tar` (MIT, Web Streams) if it runs in workerd and Node, otherwise our own. Either is bounded: header sizes, PAX records and names up to the manifest's 1,024 bytes.
- **Deletions**: `container/minerva/minerva-fs`, `container/tests/`, `test/docker/sandbox-python.test.ts`, `MINERVA_FS`, `helper()` and the line-scan and display-path vectors.
- **Docker tests that move to TypeScript** before they are deleted: symlinked parents and links in the folder, FIFOs, invalid UTF-8 and decomposed names, hard links, sparse files, millisecond mtimes and shared blobs with different modes.

### Details the units must keep (second review, 2026-10-13)

- **Reads.** `read(offset, length)` returns raw bytes: bounded, exact at end of file, and empty for a zero length. `scanLines` keeps pi's handling of byte-order marks and invalid UTF-8. Both stream the file, so S1 measures pi's read tool on a 50 MB file in the Docker tests. SDK validation errors (`TypeError`) become `Result` failures, never throws.
- **Listing and watch.** Entry metadata is read as pages are consumed, skipping entries that disappeared or have unsupported kinds. `createDir` keeps pi's recursive default. `watch` keeps today's rules: an explicitly watched symlink reports changes to its target, links below a recursive target are not followed, and exclusions apply.
- **The scan's index** keys on size, mtime and ctime in nanoseconds, inode and device. It keeps the one-second ctime guard, `rehashAll`, and the manifest's own mtime where hydration rounded it. Hydration seeds the index, so the first checkpoint does not hash everything again.
- **The scan's policy.** `find` is told to prune what the policy would skip:
  - names it refuses, kinds it skips, and depth beyond the limit are pruned with `-prune` expressions;
  - names are kept as raw bytes until TypeScript validates them as UTF-8;
  - skipped entries count toward the limits as today, and unreadable entries become warnings;
  - warnings keep their order and the 100 cap;
  - sizes count logical bytes rounded to pages, not allocated blocks;
  - a non-zero exit or partial output fails the scan.
- **Tar.** Both directions use `--format=pax`. The reader bounds header and PAX record sizes, checks header checksums, parses numbers strictly, and requires padding, both end blocks and a zero exit; metadata headers are not entries. `sha256sum` gets absolute paths, so no name can mean stdin.
- **Hydration** checks every streamed copy's SHA-256 and length, buffers a shared blob only up to 8 MiB (32 MiB for the whole hydration), reads larger shared blobs again for each path, and succeeds only after the hashes, the tar stream and `tar`'s exit all succeed. A partly hydrated container is destroyed, as today.
- **Tests move before deletion**, as behaviour tests in TypeScript (unit tests where the logic is pure, Docker tests otherwise):
  - the scan: the 100-warning cap, order and display truncation; depth and path-length limits; skipped entries counting toward the limits; unreadable entries; index reuse, a forced rehash and the preserved mtime;
  - hydration: short, long and malformed streams, checksum failures, shared blobs with different modes and mtimes, empty directories;
  - checkpoints: `key: null` verification, malformed tar answers, and the existing crash and fault tests;
  - the reader: byte-order marks, invalid bytes and chunk boundaries;
  - symlinked parents, FIFOs, invalid UTF-8 and decomposed names, hard links, sparse files and millisecond mtimes.
- **Performance gate**, measured in the Docker tests and, after the merge, in the account tests:
  - pi's read tool on small and 50 MB files;
  - `writeFile` of small files;
  - hydration of 1,000 files and of large shared blobs;
  - a checkpoint of 500 files;
  - a scan of 10,000 entries.

  The per-file `Files` path is not used for anything that grows with the folder.

## Done when

- `minerva-fs`, its Python tests and its vector file are gone. Of our own code, the container holds only the probe and the wrapper's script.
- Nothing in `src/` or `container/` cites `worker/`, "today's" or the files spec's sections, and nothing compares the container with `../worker`.
- `pnpm typecheck`, `test:unit`, `test:platform` and `test:docker` pass. pi's conformance suite passes, minus the documented reader cases.
- After merging, `test:account`'s sandbox and faults suites pass on the test Worker. Run them only once the frontend-cleanup agent is not using the test Worker.
