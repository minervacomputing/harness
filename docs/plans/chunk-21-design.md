# Chunk 21: restore a cold sandbox from a snapshot (design)

The plan's section is after-the-plan.md, "Restore a cold sandbox from a snapshot (chunk 21)". This design says how, at the size the owner asks for: two code units, one short live round and a short perf round on minerva-cf-test-19.

## What changes for a user

Take a conversation with a large folder (20 MB or 300 files and up) that sat idle past the 5-minute parking window. Its next turn runs its first command after a few seconds instead of 20 to 35. A turn whose message carries attachments starts as today, since its folder is a new version the snapshot does not hold (chunk 20's acquire has the same limit). The folder in R2 stays the record. A snapshot that cannot be used costs the turn the failed restore's few seconds, then today's cold start.

## One change to the plan: the folder stays on tmpfs, and the snapshot carries a copy

The plan puts every container's folder in a loop-mounted ext4 image, so that a snapshot keeps it. This design keeps today's tmpfs `/workspace` and copies the folder onto the root disk only when the container retires. A restore copies it back. The reasons:

- **The offline dev server cannot loop-mount.** Under the Docker flags workerd uses locally (`SYS_ADMIN`, `/dev/fuse`, no devices), `mount -o loop` fails with "Operation not permitted" (measured 2026-10-19 with `minerva-sandbox:local`). A privileged container mounts it. The ext4 folder would break every local turn that uses files, or need a second folder format.
- **Fresh containers do not change.** The hardening, the verification, `memory.max` and the agent's file I/O stay exactly as they are. The plan's 10% rule for agent commands on ext4, its memory question and its new writable exception on the read-only root all go away.
- **Deleted data cannot ride along.** An ext4 image keeps deleted files in its free blocks. The root disk is a file system of its own, and the retire writes the folder's files there fresh each time.
- **The plan's raw pass is not needed.** The plan restores the agent's image as the folder itself, so it must check owners, extended attributes and link counts. Here the agent's own `tar -x` rebuilds the folder in a fresh tmpfs, as hydration does, so those come out as hydration makes them.

The cost is one more pass over the folder before the first command: the copy from the root disk into the tmpfs. For 200 MB the restore adds up to about 4 to 6 s against the 5 s rule. The hashed scan is 2 to 3 s of that, as it is in the plan's design. The seed's time is measured in the first Docker test and in the live round, before the perf round. If 200 MB misses 5 s, the measurement and the options go to the owner. The gain against the spike's 32.7 to 34.9 s stands either way.

## The Sandbox (sandbox/core.ts, store.ts, schema.ts, hardening.ts, constants.ts, ports.ts, sandbox.ts)

**States.** `… in_use → parked → retiring → destroying → none`. The alarm moves a parked container to `retiring` at its lease instead of destroying it. The row keeps the parked row's incarnation, run and attempt. A retiring container belongs to no run and holds no span, as a parked one. It admits nothing, `acquire` answers "Nothing is parked.", and `seal` leaves it. `start` destroys it, as it destroys whatever runs. `recover` destroys it, since `retiring` is not a state it keeps, so an object restarted while retiring writes no record.

**The digest covers the image.** The hardening digest (`hardeningDigest`) also covers `images.base`, the image the class starts. It is computed at `harden`, right after the container started, so the row records what the container was started from. `acquire` compares it with what the current code would start, so a parked container from an image that a deploy replaced is destroyed, not acquired. This closes chunk 20's Accepted 2. Containers parked by chunk 20 fail one acquire after this deploy and start cold once.

**Retiring.** `alarm()` is split so that only its first and last steps run in the serial queue:

1. In the queue, at the parked lease. The container is destroyed as today when any of these holds: the port has no image name, the row's digest is not the one the current code would give its spec (an older image or hardening), or the record already holds this version with the same digest and format. Otherwise the row is written `retiring`, with a lease of `RETIRE_MS` (3 minutes). The generation, the version and the digest are kept for the record.
2. Outside the queue, so a start is never held behind it, the retire script runs as one root exec with `set -eu`. Parking already refused work in flight, and a parked container admitted nothing, so no helper or file operation runs. The script:
   - kills the agent cgroup until it is empty;
   - counts the folder's regular files and their bytes, and exits with its own code when both are under the threshold, 300 files and 20 MB to start with;
   - exits with an error when the folder holds anything but regular files and directories, a file with more than one link, a directory not 0755 or a file neither 0644 nor 0755 (parking leaves none of these);
   - remounts `/` read-write, removes `/var/lib/minerva`, makes it again with mode 0700, and copies `/workspace` into `/var/lib/minerva/folder` with root's `tar --format=pax --hard-dereference --no-xattrs --no-acls --no-selinux` piped into `tar -x`. Owner root, no extended attributes or ACLs, no links between files, modes and modification times kept to the nanosecond;
   - runs `sync`, then remounts `/` read-only, so the disk is clean when it is snapshotted.
3. Still outside the queue, the Sandbox checks synchronously that the generation is live and current, and only then calls `snapshotContainer`. No await sits between that check and the call. The container port is the object's, not the incarnation's, so a call made after a start would snapshot the new container. The exec and the snapshot together have `RETIRE_MS`.
4. Every outcome comes back to the queue as `#doubt` does. Nothing happens unless the retiring generation is still the current one. If it is, the record is written for a snapshot, replacing any earlier one, and the container is destroyed. A small folder, a failure or the deadline only destroys it.

A start, `forget`, the deletion or `recover` ends the generation first, so a retire that finishes after them neither writes a record nor destroys the next container. A snapshot already running when a start destroys its container is left to the platform. If it completes, nothing records it, and it expires in 30 days. Alarms do not overlap, so the retire holds its own deadline. The row's lease is for an alarm that runs after a restart, which destroys the container.

**The record** (schema step 4, one row): the snapshot's id, the folder version, the digest (hardening and image), the format digest, when it was taken and when it was last restored. The digest covers the folder's limits too, since they are arguments of the hardening exec. The format digest is the SHA-256 of the retire and seed scripts, so changing either makes old snapshots unusable with no version to bump. There is no list call, so this row is the only way back to a snapshot.

**Restoring.** `start(fence, spec, restore?)` takes the version the attempt will hydrate. It restores when the record holds that version, the digest the spec gives with the current image, and the current format digest, and was taken or last restored less than 29 days ago. A record past 29 days is dropped. The port starts with `containerSnapshot: { id }` and no `image`. The answer says `restored: true`. The row records the snapshot's id as `restoring` (a new column of the rebuilt table) until the folder check passes. An older Conversation that sends no version never restores.

**Hydrating a restored container.** `hydrate(fence, plan)` keeps its promise that the folder equals the plan. For a generation whose row is `restoring` and whose record holds `plan.versionId`:

1. The seed script runs as one root exec with `set -eu -o pipefail`: `tar -c --format=pax --hard-dereference --no-xattrs --no-acls -C /var/lib/minerva/folder .` piped into the agent's own `tar -x -C /workspace --no-same-owner --preserve-permissions`. The agent's tar runs through the wrapper, in the agent cgroup, as hydration's does. Its `timeout` is shorter than the root exec's deadline, so a slow seed exits with an error rather than losing the container.
2. A scan with every file hashed and an empty index.
3. A pure comparison with the plan: files keyed by path, each with the plan's size, mode, mtime and SHA-256, the directories as sets, and no warnings. Symbolic links and special files would be warnings. A difference logs the first path and field that differ.

When everything matches, `restoring` is cleared, the generation keeps the scan's index, and the record's restore time is written, only where its snapshot id is the one restored. Anything else ends in the queue, behind the generation check, as the retire's outcome does: the container is destroyed, and the record is dropped if it still holds that snapshot. The answer is `{ ok: false, reason: "restore_failed" }`. A cached folder is never patched.

The comparison is the manifest's equality, the same one a checkpoint and an acquired parked container rely on. The scan sees a file's mode only through its owner's execute bit. The raw modes are canonical anyway: the retire refuses any other and the seed keeps them. Sub-millisecond mtimes stay as the parked folder had them, as on a container chunk 20 acquires.

**Admission while restoring.** While the row is `restoring`, commands and file operations are refused as `not_verified`, so the run cannot use a folder that was not checked. `recover` destroys a running container whose row is `restoring`. A restart is not the snapshot's fault, so that leaves the record.

**A failed restore drops the record.** That covers a start that does not become ready, a hardening, verification or folder check that fails, and a container lost on the way. A destroy someone asked for (a new start, `destroy`, `seal`, the deletion) leaves it. The plan counts failures. One is enough to stop trusting a snapshot, and a transient failure only costs the next cold start its restore.

**`forget()`**, in the serial queue, with no container needed: drops the record, and destroys a retiring container. It is idempotent.

**`status()`** also gives the record's version and when it was taken, for the tests and the logs.

**Storage, migration 4.** The step rebuilds `sandbox_state` as step 3 did, with every existing column and key, `state` also allowing `'retiring'`, and the new nullable column `restoring`. It also creates the record's table. The previous version's writes name their columns, so they leave `restoring` alone. It reads `retiring` as a state it does not know, so its `recover`, `start` and `seal` destroy the container, and it never reads the new table.

**Ports.** `ContainerPort` gets the image's name (`images.base`, empty where the class has none), `snapshot(name)` and a start option to restore. The object maps them to `ctx.container`. The Docker tests' port snapshots with `docker commit`, which keeps the container's own layer and no mount made inside it, as the platform does, and restores by running the committed image. The test build's Sandbox gets two per-object faults, set through the driver on a conversation's Sandbox: `parkedMs`, a shorter parked window, and a seed that also writes a stray file, which breaks the folder check. Chunk 20's account tests set neither and keep 5 minutes.

## The Conversation (sandbox/session.ts, conversation/local-run.ts, conversation.ts)

**`prepareSandbox(sandbox, fence, spec, restore)`.** With a version, the first attempt may restore. A restore that fails at any step falls back to today's two attempts from the image. That covers a start that is not ready, the hardening, the verification and a lost container. A start that found no record is a container from the image. Its hardening or verification failure still fails the turn, and a start that does not become ready gets today's retry. A stale or sealed refusal is never retried. `Prepared` says whether the container was restored.

**`LocalRun.#prepare`** passes the plan's version. When a restored container's `hydrate` fails in any way (`restore_failed`, a refusal, a thrown call), it prepares again from the image, with a new incarnation whose fence replaces the first, and hydrates from R2. Only a failure of that second preparation counts as today's failures do. The log line and `preparation` say when a container was restored, with the seed's and the check's times apart.

**Deletion.** `#cleanUp` destroys the container first (`destroyRunSandbox`), then calls `forget()`. The order keeps a deleted conversation's container from running on while a Sandbox on the previous version refuses `forget`. `destroyRunSandbox` leaves a retiring container to its Sandbox, as it leaves a parked one, except for the deletion.

**During a deploy.** A Conversation on this version that meets a Sandbox on the previous one sends `start` an argument it ignores. Its deletion destroys the container, fails at `forget`, and is retried by Laravel until the Sandbox runs this version. A Sandbox on this version never restores for an older Conversation.

## Tests

- **Unit, `sandbox-core.test.ts` and `sandbox-spans.test.ts`.**
  - The retire writes the record and destroys the container. A small folder, a version already recorded and an outdated digest take no snapshot.
  - A start during the retire's exec or snapshot, after which the retire fails or answers: the new container is untouched and no record is written. So for a snapshot that never answers, and an object restarted while retiring.
  - A start restores with a matching record, and starts from the image on a version, digest (image or hardening), format or age mismatch.
  - A restore that is not ready, fails its hardening or verification, or fails its folder check drops the record. A late failure of a replaced restore leaves the next attempt's container and record alone.
  - Commands are refused while restoring, and `recover` destroys a container that was restoring.
  - `forget` drops the record and destroys a retiring container.
  - `seal` leaves a retiring container, and retiring holds no span.
  - An acquire of a container started from another image is refused.
  - Migration 4 keeps a parked row's digest, version and closed span.
- **Unit, the comparison.** An extra file, a missing one, a changed byte, execute bit, mtime or size, another set of directories, and a warning each fail.
- **Docker, `sandbox-local.test.ts`.** In the real image, a folder is parked, retired, committed and restored. It has a file the agent made 0600, an extended attribute, a dotfile (`.git/config`), a non-ASCII name in NFC and an empty directory. The seed and the check pass. The restored folder has the agent as owner, hydration's modes and no extended attribute, and the root-disk copy has no extended attribute or ACL. A committed copy with an extra file or a changed byte answers `restore_failed`. The seed's time for 200 MB is logged.
- **Platform, `local-tools.test.ts`.** The start carries the plan's version. A failed hydration of a restored container prepares again from the image, and the turn completes. The deletion destroys the container, then calls `forget`.

## Live and perf, kept short

On minerva-cf-test-19, one round, with the shorter parked window set as a fault on each test's conversation:

- A conversation whose first turn writes a 200 MB file. Its container retires with a snapshot, and the Sandbox's status shows the record. Between that retire and the second turn, `pnpm run deploy:test` runs with `container/` unchanged. The second turn's log shows a restore, the seed, the folder check and no hydration from R2, which proves `images.base` survives a deploy that keeps the image.
- Regression: a small folder retires with no snapshot, and its next cold start hydrates as on `main`.
- A conversation deleted after its snapshot has no record left. So does one deleted while retiring.
- With the broken seed, the restore falls back within the turn, and the turn succeeds.
- A turn that starts while its container's snapshot runs succeeds from R2, and no record is written. The log gives when the snapshot was called, when the start's destroy answered and the turn's time to ready.
- Three turns delete, overwrite and truncate files, each after the window. Every turn after the first restores. The restored container's `/var/lib/minerva` holds exactly the current version, listed as root.
- A new image is left to the unit tests. With the digest covering the image, a record from another image is never restored.
- **Perf.** Sandbox-ready time of the cold start after the window, for one 200 MB file and for 500 files of 50 MiB in all: three samples each on the head. The baselines are reused rather than measured again: 21,359 ms for the 500 files on `main` (chunk 20's probe, 2026-10-19) and the spike's 32.7 to 34.9 s for 200 MB. The rule stays under 5 s for both. The retire's log line gives the container seconds and bytes of each snapshot.
- The plan's ext4 metric for agent commands does not apply: the folder stays on tmpfs.

## Accepted, not fixed

1. A turn that arrives while its container retires (5 to 30 s after the window, at most `RETIRE_MS`) starts from R2, and no snapshot of that version is taken. If destroying a container that is being snapshotted waits for the snapshot, that turn waits too. The live round measures it.
2. A restore that fails for a transient reason drops a good record. The next cold start hydrates from R2, and the next retire snapshots again.
3. Only a container that reaches its parked deadline retires. A conversation whose last run was cancelled or failed gets no snapshot, and neither does a turn's attachments' version.
4. The copy stays on a restored container's root disk, root's only, taking up to the folder's size of the instance's 8 GB.
5. During the deploy, a deletion fails at `forget` until the conversation's Sandbox runs this version, and Laravel retries it. A Conversation still on the previous version deletes without `forget`, so a record written meanwhile can outlive its conversation. Nothing restores it, since a deleted conversation gets no runs, and its snapshot expires as it would anyway.
6. A restore that never becomes ready waits up to 90 s, as a start does today, before the fallback.
7. A container lost during the seed ends the attempt if the hydrate call itself is lost, as one lost during hydration does today. The next attempt starts from the image.
8. A crash right after a snapshot and before its record leaves a snapshot nothing can reach, which expires in 30 days.

## Review

On 2026-10-19 opencode and a workflow of four reviewers reviewed this design. The reviewers covered races, the snapshot's contents, compatibility and the plan's scope, each on a different model, and each lens had a skeptic that verified its findings against the code. Their confirmed findings changed it:

- **Fencing.** The retire's failure branches and the restore's failure were not fenced, so a late failure could destroy the next run's container. Every outcome now goes through the queue behind the generation check, and the snapshot call is checked synchronously first.
- **The image.** The record took `images.base` at retire, so after an image deploy a parked container from the old image would be snapshotted under the new name. The digest now covers the image at `harden`.
- **The marker.** The restoring flag lived only in memory. It is now the row's `restoring`, which gates admission and survives a restart.
- **The copy.** `cp --preserve=mode` copies ACLs. The copy is now root's tar, which omits extended attributes and ACLs, and the retire refuses modes parking would not leave.
- **The fallback.** Losses and refusals during a restored hydration answered no `restore_failed`. LocalRun now falls back on any failure of a restored container's hydration.
- **The deletion.** Calling `forget` first would leave the container running against a Sandbox on the previous version. The deletion now destroys first.
- **The tests.** A build-wide parked window would break chunk 20's account tests. It is now a per-object fault.
- **The wording.** Attachments, a restore's time and the perf estimate are stated, and the live round now restores across a deploy and over three turns.

Refuted or left as they are:

- A restart during the seed: the hydrate call fails and the next attempt's start destroys the container, as during hydration today. The marker makes it explicit.
- Orphaned snapshots: the owner accepted them on 2026-10-15.
- Missing doc changes: the plan's boxes stay open until done.
- The schema step's columns: the design keeps all of them.
