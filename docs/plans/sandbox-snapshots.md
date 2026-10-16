# Sandbox snapshots: a spike

Status: measured 2026-10-15 on the test instance. Nothing in the engine changed. The spike's lab operations and tests were not committed, and the test instance was deployed again from `main` afterwards. opencode reviewed this report against the raw measurements and the code; its findings are folded in (the ext4 path not yet run end to end, what a restored folder can hold that a manifest check misses, deleted data in the image's free blocks, what retiring needs from the Conversation, and some numbers).

**The question.** Can Cloudflare Containers' filesystem snapshots be a cache in front of the per-turn rebuild of the sandbox, with R2 still holding the folder? Today every turn starts a container from the image, hardens it, verifies it and hydrates the folder from R2 (ARCHITECTURE.md: The sandbox lifecycle, Checkpoints). Snapshots are in public beta since 2026-09-30. They take two calls: `ctx.container.snapshotContainer({ name })`, and `ctx.container.start({ containerSnapshot: { id } })` to restore. The engine already runs `durable_object` scheduling, which snapshots require.

**The answer.** Probably yes for the mechanism, not yet for the product.

- **The mechanism works in its parts.** It needs a folder stored in a loop-mounted ext4 image instead of a tmpfs, and a different read-only remount of `/`. A restore answers its first exec as fast as a fresh start, and today's hardening and verification pass on it unchanged. The parts suggest a large folder ready in seconds instead of half a minute, but the whole path (sparse image, restore, changed hardening, ext4 verification, manifest check) was not run end to end.
- **The product questions are open.** A snapshot can't be deleted, and it lives up to 30 days after its last restore. Where it is stored is not documented. It has no price yet.
- **The gains were measured only on large folders**, and each snapshot cost 5–26 s of container time after the turn (once 107 s).

The recommendation is at the end.

## How it was measured

- **The lab.** The test build's sandbox lab (`src/faults/lab.ts`, `src/faults/sandbox.ts`) got four operations for the spike:
  - a snapshot of the running container;
  - a start that restores a given snapshot;
  - a `verify` on its own;
  - a hydration of streamed random files.
- **The runs.** They went through `test/account/lab.ts` on `minerva-cf-test`, instance `standard-1`. Production's own start, hardening and verification ran unchanged.
- **The data.** Folder contents came from `/dev/urandom`, which does not compress. The root file system compresses with zstd (below), so text folders may snapshot smaller. That was not measured.
- **The samples.** Most rows have 2–3 samples, given as ranges; a single number is a single sample.

Two folders, as asked:

- **(a)** 500 files, 50 MiB in all (52.4 MB);
- **(b)** one 200 MiB file (209.7 MB).

## The numbers

Today, from the image and R2:

| Step | (a) 500 files, 50 MB | (b) one 200 MB file |
|---|---|---|
| Start to first exec | 1.4–1.8 s (8.4 s once, cold) | the same |
| Hardening + verification | 0.3–0.5 s | the same |
| Hydration from R2 | 18.3–22.8 s | 32.7–34.9 s |
| Scan after hydration (for comparison, not part of the prepare) | about 0.1 s | 2.9 s |

A snapshot, taken after the turn:

| Folder | Snapshot call | Snapshot size |
|---|---|---|
| None (only a few bytes written) | 5.3–5.5 s | 5 KB |
| (a) on the root layer | 7.6–8.3 s | 52.6 MB |
| (b) on the root layer | 15.4–25.9 s | 209.8 MB |
| (a) in a preallocated 256 MiB ext4 image | 14.3 s mounted; 107 s once unmounted | 261 MB |
| (b) in a preallocated 256 MiB ext4 image | 9.6 s mounted, 8.8 s unmounted | 261 MB |
| (b) in a sparse 256 MiB ext4 image | 13.1–25.3 s | 210 MB |
| After the hardening (`/` read-only, folder on tmpfs) | 6.1 s | 4 KB |

- **The size** reported is what changed against the image. A preallocated image counts whole; a sparse one only as far as it is used.
- **An empty snapshot still takes about 5 s.**
- **The 107 s outlier** was not repeated in any later sample.

A restore, then everything needed before the agent's first command:

| Step | (a) | (b) |
|---|---|---|
| Restore to first exec | 0.55–1.96 s | 0.61–1.79 s |
| Loop mount of the folder's image (with the bind mounts in (b)) | 30–50 ms | 50–102 ms |
| Hardening + verification (as today, on a root-layer folder) | 0.4–0.5 s | 0.3 s |
| Hashing the whole folder (`sha256sum`, as a check against the manifest) | 0.4–0.8 s | 2.0–2.9 s |
| **The parts added up, about** | **1.5–3.5 s, against 20–25 s today** | **3–5 s, against 35–37 s today** |

The sum comes from separate experiments: the hardening row is today's hardening on a root-layer folder, since the changed hardening the ext4 path needs was not built. In these samples a restore was not slower than a fresh start, for folders up to 200 MiB. Two restores of one snapshot both matched its contents.

## What a snapshot keeps

The container's root file system is a btrfs subvolume (`compress=zstd:3`, 8 GB on `standard-1`). Cloudflare's API reference says `snapshotContainer()` captures "the writable root filesystem … not memory, running processes, or separately mounted filesystems". The spike confirmed this:

- **Files written to the root layer are kept.** That includes a folder written to `/workspace` before any mount, and a file in `/etc`. Contents matched on every restore.
- **tmpfs is not kept.** Files written by the agent into today's tmpfs `/workspace` were gone after a restore, and so was a test tmpfs elsewhere. Today's folder therefore can't be cached as it is.
- **The read-only remount is not kept.** A container restored from a snapshot taken with `/` read-only starts with `/` writable.
- **The agent cgroup is not kept.** `/sys/fs/cgroup/agent` is absent after a restore.
- **Processes are not kept**, per Cloudflare's documentation. The spike's process count was not usable as a check: it counted the probe's own shell.
- **Today's hardening and verification passed unchanged after every restore of a container without the ext4 image.** The cgroup is made again, the tmpfs mounts again (hiding a root-layer `/workspace`) and the root is remounted. So a restore must always be hardened again, which is what the design wanted anyway. With the ext4 image restored, today's hardening fails at its last step, as expected (next section).
- **A snapshot can be taken after the hardening.** It worked with `/` read-only and the cgroup in place.
- **`snapshotDirectory` is not available.** workerd's code has it, and the types have `directorySnapshots` among the start options, but `ctx.container.snapshotDirectory` is `undefined` on the account. Only whole-container snapshots exist today.

## The folder in a loop-mounted ext4 image

This keeps the folder's limits and puts its bytes on the root layer, where a snapshot keeps them. The VM's kernel has `ext4` and loop devices, and the image has `mkfs.ext4`, `losetup` and `mount`, so the image needs no change. As root:

- **Creating and mounting** (`truncate` or `fallocate` 256 MiB, `mkfs.ext4 -m 0 -N 10001 -O ^has_journal -E root_owner=1000:1000`, `mount -o loop,nosuid,nodev`) takes 120–200 ms.
- **The size limit holds.** The agent's `dd` stopped with `ENOSPC` at 256 MiB less about 3.3% of overhead (259.5 of 268.4 MB free when empty). The hardening must size the image up by that overhead so the limit is the store's.
- **The entry limit is approximate.** `-N 10001` gave 9,984 inodes, rounded to ext4's groups, so creation stopped at about 9,970 entries. The image must be made with more inodes than the limit; the scan's count stays the authority, as it is today.
- **Contents survive a snapshot and restore**, mounted or unmounted when it was taken.
  - A snapshot taken while mounted came back as an unclean file system ("mounting unchecked fs, running e2fsck is recommended").
  - The folder should be unmounted before the snapshot. This is possible at turn end, after `cgroup.kill`.
- **Today's read-only step fails with the image open.** `mount -o remount,ro /` fails ("mount point is busy"), because the loop device holds a file on `/` open for writing. `/` then stays writable, so this step and its verification must change.
- **A bind mount for the image fixes it.** The image goes in a directory of its own (`/var/lib/minerva`, root's, 0700) that is bind-mounted onto itself before the loop mount, and the last hardening step becomes `mount -o remount,bind,ro /`, which makes only the root mount read-only. Measured:
  - `/` read-only in the mount table;
  - writing `/etc` gives `EROFS`, as today's verification checks;
  - `/home/agent` is not writable;
  - uid 1000 can't list the image's directory;
  - the agent still writes `/workspace`.

  On a restore the same three mounts take 52–102 ms. Today's hardening then failed at `readonly_root` on both restores, since its `remount,ro /` is the step this replaces; the changed hardening was not built.
- **The image should be sparse.** A preallocated image put its whole size into every snapshot (261 MB for a 50 MB folder); a sparse one only what is used.
- **The image keeps deleted data.** Free blocks of an ext4 image still hold files the agent deleted, and a snapshot carries them, so a newer snapshot can hold older contents no manifest names, and restoring and snapshotting again extends their life. A rehash cannot see them. Mounting with `discard` (punching holes in the sparse file) or `fstrim` before the snapshot may free them; untested.

Untested, and needed before building:
- What the tmpfs part of `memory.max` becomes once the folder is on disk: page cache is charged to the cgroup but can be written back.
- Read and write speed of agent commands on the loop device against tmpfs.
- `e2fsck` time, if snapshots are ever taken while mounted.
- Small and compressible folders, a cache's hit rate, and repeated write and delete cycles.

## Limits and pricing

From the Containers docs ([snapshots guide](https://developers.cloudflare.com/containers/guides/snapshots/), [limits](https://developers.cloudflare.com/containers/platform-details/limits/), [Container API](https://developers.cloudflare.com/durable-objects/api/container/), [pricing](https://developers.cloudflare.com/containers/pricing/), changelog of 2026-09-30):

- **Size:** at most 20 GB per snapshot. No limit on their number or total storage is stated.
- **Expiry:** 30 days after creation or the last restore, refreshed by each restore. It can't be set.
- **Image version:** a snapshot is bound to the image it came from. After an image change a new snapshot is needed. What a start from a stale snapshot does was not tested.
- **API:** no list or delete call. The Worker must store the returned `id` itself.
- **Pricing:** not published. The pricing page has no line for snapshots, and the changelog states no price. The container's own time while it snapshots is billed as usual.
- **Status:** public beta, `durable_object` scheduling only. A restored container's `image` reads as the empty string.

## Recommendation

**The shape is promising, but don't build it yet.**

- **The design is a snapshot as a cache, with the R2 folder still the authority.** A restore is just another way to reach the state hydration reaches. It is checked against the version's manifest, hardened and verified like a fresh container, and dropped for the image and R2 on any doubt. Added up from its parts, the gain for large folders is large: 50 MiB in 500 files ready about 18 s sooner, a 200 MiB file about 30 s sooner. Small folders were not measured, but they hydrate quickly today and each snapshot costs 5–26 s of container time after the turn (once 107 s), so the cache would be used only for folders whose hydration is slow. 20 MB or a few hundred files is a guess at the threshold, to be measured.
- **Not before Cloudflare answers three questions:**
  1. **Deletion.** No call deletes a snapshot. A deleted conversation's files would outlive its deletion by up to 30 days (chunk 12a's deletion promises otherwise), and so would the files of any version the cache replaced, and deleted files left in the image's free blocks (above).
  2. **Location.** Where snapshots are stored is not documented. An EU workspace's files must stay in the EU (open question 8 has the same gap for the VM itself).
  3. **Price and beta.** Neither the price nor the beta's terms are known.
- **Cheaper first:** today's R2 streaming into the container is slow. One 200 MB blob hydrated at about 6 MB/s, and a checkpoint of 50 MB took 21–51 s. Measuring where that time goes (the exec's stdin pipe, `tar`, R2's reads) may shorten the cold path without any beta API; by how much is a guess until it is measured. That would also shrink what a snapshot could save.
- **Not warm containers.** Snapshots keep no processes or memory, so they do not answer open question 2; they make a cold start cheaper.

## What the Sandbox would need

If it is built, `hydrate(plan)` keeps its promise ("the folder equals the plan") and the Sandbox may keep it from a snapshot instead of R2. Most changes are inside the Sandbox object; two cross the protocol (2 and 5):

1. **A cache record** in the Sandbox's SQLite, written only once `snapshotContainer` has answered and only for the generation that took it: snapshot id, the image it was taken from (`images.base` then), the folder version, the folder's limits (the image file is sized by them), a version of the hardening and the folder's format, when it was taken and last restored, and failed restores. No list API exists, so this record is the only way back to the snapshot. A deploy that changes the image makes it stale.
2. **`start` learns the version** it will hydrate: the plan's `versionId`, added to `start` or to `SandboxSpec`. With a record for the same image, version and limits, less than 29 days old, it restores; otherwise it starts the image. The port's `start` must then pass `containerSnapshot` without `image` (today's `objectPorts` always adds `image`, and the two together are refused). Every failure of the cached path (no first exec, the hardening, the verification, the folder check) counts against the record and falls back to the image and R2 within the same prepare, so a bad snapshot never fails a turn by itself. Prior art: `agents`' container harness (`agents/dist/harness/container`) keeps the same kind of record, with failure counting and a fallback.
3. **The hardening and verification change for every container,** restored or not:
   - the bind mount of the image's directory;
   - a sparse ext4 image made to the limits, or the restored one mounted;
   - the loop mount at `/workspace` (`nosuid,nodev`);
   - `remount,bind,ro /` instead of `remount,ro /`.

   The verification checks the ext4 mount, its size and inodes, and the writable exception itself: the image directory and file are root's with modes 0700 and 0600, the file is a regular file, the loop device is backed by it, and no path uid 1000 can reach writes to it. Its `/` and `EROFS` checks stand as they are, but alone they do not prove those. The tmpfs share of `memory.max` is reconsidered (Untested, above).
4. **`hydrate` on a restored container** does not write. A restored folder can hold what a rebuild never would: entries the scan skips with a warning (links, special files, bad names), hard links, other owners, extended attributes, other directory modes. So the check, with nothing else admitted, rescans with `rehashAll` and requires exactly the plan's files (path, size, mode, mtime, hash) and directories, no warnings, a link count of 1, uid and gid 1000, and no extended attributes. Any difference destroys the container, drops the record and falls back to the image and R2 (2). A cached folder is never patched.
5. **A new state after the run's last checkpoint:** `retiring`, between `in_use` and `destroying`.
   - The Sandbox's `checkpoint()` uploads files; it never learns which version the Conversation then commits. Retiring needs a fenced call from the Conversation after its commit, naming the committed version, and rules for a run that changed nothing, a cancel, a failed commit, and a repeated call.
   - It is entered only after `cgroup.kill` has left the cgroup empty and no helper or file operation runs (an empty cgroup alone does not prove that nothing holds `/workspace`).
   - It unmounts `/workspace`, snapshots, writes the record, then destroys the container.
   - It runs in the background (`waitUntil`, the alarm owning the destroy) so no turn waits for it, and a failed snapshot only means no record.
   - It has a deadline: past it, or when a start or a deletion arrives, the container is destroyed, and a snapshot that answers after that writes no record (the generation fence of 1).
   - An object restarted while `retiring` destroys the container and writes no record, as it does today for any state it did not verify.
6. **The record is dropped** when the conversation is deleted, when a newer version is snapshotted, and after 29 days. The snapshot itself cannot be dropped (Recommendation, 1).

## Other observations

- **A hung exec can wedge a Sandbox object's lifecycle until it is reset.** One verification exec on a freshly started container never answered. `runRoot` (`src/sandbox/process.ts`) arms its timeout only after `spawn()` resolves, so an exec call that never resolves leaves the object's serial queue stuck; and even after a spawn, its timer only asks for a kill, while it waits for the process's exit and both streams. Every later serialized call (`start`, `destroy`, the alarm's cleanup) waited until the object was reset; `status` answered, since it is not serialized. Two other lab calls also went unanswered for 300 s; their cause was not found. This bug exists today, independent of snapshots.
- **VM uptimes vary widely.** On restored containers, `/proc/uptime` read from 8 s to 16.9 h, so VMs are booted ahead of the container that gets them. Whether a VM ever served another container first is not something a container can see; it bears on "the VM is the boundary" and is worth asking Cloudflare.
