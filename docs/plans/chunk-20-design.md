# Chunk 20: park the sandbox between turns (design)

The plan's section is after-the-plan.md, "Park the sandbox between turns (chunk 20)". This design says how, at the size the owner asked for: a solid build in two code units and one short live round, no long probes.

## What changes for a user

The second of two turns a few minutes apart runs its first command at once: no container start, no hardening, no hydration. A turn that only answers in text, in a conversation with an empty folder, starts no container at all.

## The Sandbox (sandbox/core.ts, store.ts, schema.ts, constants.ts)

**States.** `starting → hardening → verified → in_use → parked → (verified for the next run) … → destroying`. `parked` is a container that belongs to no run. Nothing is admitted to it: every command, file operation, scan, hydration and checkpoint is refused as `not_verified`.

**Incarnations.** An incarnation is one run's use of a container, not the container itself. `acquire` gives the parked container a new incarnation id, so every fence of the run that parked it is stale from then on, and spans stay one per incarnation (`container_spans`' key does not change).

**`park(fence, versionId)`**, in the serial queue, for the attempt's own fence:

1. Refused as stale for any other fence. Answers `{ parked: true }` again for a container this fence already parked with the same version.
2. If any work of the generation is in flight (commands or file operations admitted, a folder step, a kill), the container is destroyed instead: something of the run still runs, and a parked folder must be the one the checkpoint saved.
3. If the last scan of the generation left out anything but symbolic links and special files (an unreadable entry, a name too long or too deep, or more warnings than it lists), the container is destroyed instead. Parking cannot make such a folder equal to the version, and a cold start would not have those entries.
4. The generation is held exclusive, so nothing is admitted, and one root exec runs with `set -eu`. It kills the agent cgroup until it is empty. It deletes every entry in `/workspace` that is neither a regular file nor a directory: symbolic links, FIFOs and sockets, which a checkpoint never keeps. It sets modes as hydration makes them, directories 0755 and files 0755 or 0644 by their owner's execute bit. It exits with its own code when a regular file has more than one link, and the container is destroyed then. It empties `/tmp` and every other place uid 1000 can write outside `/workspace` (measured in the image, `/dev/shm` at least), and recreates `/tmp/home` and `/tmp/matplotlib` as the hardening makes them. A failure or no answer destroys the container.
5. Only then writes `parked` with the version and a lease of `PARKED_MS`, 5 minutes (the owner, 2026-10-19). The run's span closes here, `ended = 'parked'`. An object restarted during the exec still has the row `in_use` for the run, whose end destroys it.

**`acquire(fence, spec, versionId)`**, in the serial queue:

1. Refused for a sealed run and for an older fence, as `start` is.
2. `{ acquired: false }` when nothing is parked, or the container stopped (written `gone`).
3. When the parked version is not `versionId`, or the container was hardened differently from what `spec` asks (below), it is destroyed and the answer is `{ acquired: false }`.
4. The verification runs again. A failure or no answer destroys the container and answers `{ acquired: false }`.
5. Writes `verified` with a new incarnation, the run's fence, the new spec (its deadline) and its lease. The span of the new run opens here. The scan's index carries over, since nothing changed the folder while it was parked.

**Hardened as asked.** At `harden`, the row records `hardening`, the SHA-256 of the hardening exec's argv. That argv holds the script and every limit (folder size and entries, `/tmp`, pids, memory). `acquire` compares it with the argv the new spec would get. So a deploy that changes the hardening script, or a change of the folder's limits, never reuses a container. The verification itself always runs the current code. The image is not stamped. A deploy with a new image rolls running containers over, and the verification still runs at acquire (Accepted, 2).

**Other calls.**

- `seal(runId)` never destroys a parked container. A parked container is the conversation's, not the run's.
- `recover()` keeps a running parked container, with a fresh generation and an empty index. A parked container that stopped is written `gone`.
- The alarm destroys a parked container at its lease ("The parked sandbox was not used for 5 minutes").
- `start()` still destroys whatever runs, a parked container included.
- `status()` reports `parked`.

**Spans and charges.** `spanChange` closes the run's span when its incarnation goes `parked` (`ended = 'parked'`), opens none for a parked row, and opens the next run's span at `acquire`. `containerCharge` treats `parked` as an exact end, like `destroyed`. The time a container sits parked is charged to no run (Accepted, 1).

**Storage, migration 3.** SQLite cannot widen a CHECK in place, so the step rebuilds `sandbox_state` and `container_spans` in one transaction: the same columns and keys, `state` also allowing `'parked'`, `ended` also allowing `'parked'`, and two new nullable columns on `sandbox_state`, `hardening` and `parked_version`. Both versions' code works on the result. The previous version's writes name their columns, so they leave the new columns alone, and its reads treat `parked` as a state it does not know. That means `recover`, `start` and `seal` destroy the container, and `containerCharge` counts a `parked` span as estimated. The `state` column is the only authority on parking: new code reads `parked_version` only while `state = 'parked'`.

## The Conversation (local-run.ts, conversation.ts)

**`destroyRunSandbox(sandbox, whose, reason)`** skips a parked container unless `whose` is null (the deletion). So the run's end (`#afterFinish`) and `#cleanSandbox` never destroy what a run parked, and deleting the conversation does.

**Prepare is acquire, else start.** `LocalRun.#prepare` reads the hydrate plan first, calls `containerStarting()` (container time counts for the budget from here, as today), then `acquire(fence, spec, plan.versionId)`. A call that throws counts as nothing parked: right after a deploy a busy Sandbox can still run the previous version, which has no `acquire`. If it acquires, the folder is the plan's version: no hydration, `#parent = plan.versionId`, and the log says `sandbox acquired: verify N ms`. Otherwise it starts, hardens, verifies and hydrates as today.

**Lazy start.** `#prepareLocal` calls `local.warm()` instead of `prepare()`. `warm` prepares at once when the plan has files or directories, or when the Sandbox's `status()` says `parked`. Otherwise it does nothing, and the first local call prepares behind "Preparing files". `#waitFor` asks for the environment before it reads `local.preparing`, since that call is what starts a lazy preparation. A container already parked is acquired whatever the folder holds.

**Park after the final checkpoint.** In `#settle`, once `#finishLocal(fence)` succeeded and before `#complete`, the Conversation calls `local.park()`. It parks the LocalRun's prepared fence with `#parent`, which is the run's last checkpoint, else the version it hydrated or acquired. That is exactly what `publish` makes the conversation's folder when the run ends, however it ends. A LocalRun that never prepared parks nothing, and a refusal or a failed call is logged and left. The run's end then destroys whatever is still `in_use` for the run, as today.

Every other end destroys the container, as today: a cancel or a failure during the turn, a final checkpoint that failed, an object restarted after pi settled (no LocalRun, so no park), or one restarted between the checkpoint and the park call. What happens after the park does not matter: `#complete` may still fail the run for an empty or oversized answer, and a cancel may land, but `publish` keeps the parked version however the run ends. A Sandbox still on the previous version answers `park` with an error, which is logged, and the run's end destroys the container.

**From 19a.** The previous run's commands cannot reach the next run. `park` refuses while any of them is in flight, kills the cgroup, and after `acquire` every fence of the earlier run is stale.

## Tests

- **Unit, `sandbox-core.test.ts` and `sandbox-spans.test.ts`.**
  - park, then acquire with no start;
  - park refused for a stale fence, and destroying instead while a command is in flight;
  - acquire on a version mismatch, a hardening mismatch, a failed verification, and a stopped container;
  - the idle alarm;
  - a late exec, fs and checkpoint from the parking fence, before and after acquire;
  - `seal` of the parking run before and after the next run acquired;
  - recover with a parked container;
  - the spans and charge of two runs on one container.
- **Unit, `destroyRunSandbox`.** It skips parked for a run id and a predicate, and destroys parked for null.
- **Docker, `sandbox-local.test.ts`.** In the real image, park removes a symbolic link and a FIFO from `/workspace`, keeps regular files and directories, empties `/tmp` (and every other writable place found), kills a `setsid` sleeper, and the acquired container passes its verification and runs a command.
- **Platform.**
  - An attempt on an empty folder makes no Sandbox call until its first local call.
  - One with files prepares at once.
  - A first local call on an empty folder waits and succeeds.
  - Two runs in a row acquire the parked container, and the second never calls `start`.
  - Deleting the conversation destroys the parked container.
- **Account, `turns.test.ts`.** The container is parked after a turn, not destroyed.

## Live and perf, kept short

On minerva-cf-test-19, one round, about ten minutes:

- **Two turns a minute apart, each running a command.** The second's log shows `sandbox acquired` and no start. A symbolic link made in the first is gone in the second.
- **A text-only turn on an empty folder.** No `sandbox ready` line, and no span.
- **Deleting the conversation.** Its Sandbox's status is `none`.
- **Perf.** Sandbox-ready time of the second turn with a folder of 500 files and 50 MiB, `main` once, then the head once. The rule stays under 1 s on the head. The plan's three interleaved rounds are dropped, by the owner's preference for short checks.

## Accepted, not fixed

1. The time a container sits parked (up to 5 minutes of a `standard-1`'s memory) is charged to no run. Charging it to the run that parked it would hold that run's settlement until the next turn or the idle deadline.
2. The image is not stamped on a parked container. A deploy with a new image rolls running containers over. Within the rollout's window a parked container on the old image could be acquired once, and its verification still runs.
3. Extended attributes the agent set on a file stay on a parked folder (tmpfs keeps `user.*` attributes), and a cold start would not have them. Nothing in the image reads them.
4. After a rollback below this chunk, an older version that meets a parked row destroys the container. Only parking is lost.

## Review

opencode reviewed this design on 2026-10-19. Four findings changed it:

- The cleanup ran after `parked` was written, so a restart during it left a container that looked clean. It now runs first.
- Hard links and modes survived parking but not hydration. Modes are now set as hydration sets them, and a hard link destroys the container. A scan that left out more than links and special files destroys it too.
- An `acquire` sent to a Sandbox still on the previous version would have failed the preparation. It now falls back to a start.
- A lazy start missed "Preparing files". `#waitFor` now asks for the environment first.

One needed no change. Parking before `#complete` validates the answer is safe, since the run keeps the parked version however it ends.
