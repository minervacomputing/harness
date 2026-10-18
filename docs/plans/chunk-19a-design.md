# Chunk 19a design: give pi's work to its run

Status: proposed, 2026-10-18. This design settles the choices that chunk 19a of [after-the-plan.md](after-the-plan.md) leaves open, splits the work into units one fresh agent each can finish, maps every box to its evidence, and lists what waits for the owner. opencode reviewed it twice, and the findings that held are folded in (Amendments after opencode's review). Line numbers are at `abeced2` (harness), pi-durable 1.2.0 and agents 0.28.0 as installed in `cloudflare/node_modules`. pi-durable's files are cited from its `dist/` (for example `harness/submissions.js:126`), and agents' from `dist/harness/pi/index.js` ("PiHarness" below).

## The rule in brief

A run's work in pi is its operation, which is the `run:<id>` submission it sent to its session and the tasks pi made for that submission. A task belongs to the operation when it is in the same session, is not a background task, and has an id above the submission's. The active run's operation owns its work. Everything else pi holds is orphaned.

Four things follow from that one rule. A tool or model call is admitted only for the active run, only while its submission is placed, and a tool call only from a task that belongs to it. The restart gate reads the run's submission first and counts only tasks that belong to it. A stop marks orphaned work, task by task, and never aborts a whole pi conversation. A run's start waits until no orphaned submission or non-background task is live before it configures pi or submits, and a reset ends a wait that does not finish in 30 s.

Chunk 19a still creates one pi session per run, so in 19a every orphan is in another session than the active run's. The rules are written for one session shared by many runs, which chunk 19b brings. Unit tests run them, and the code that applies them, on such a session with pi itself.

## What the code does today

| Claim | What the code does |
|---|---|
| Admission is by session | A tool call finds its run with `store.runBySession(String(session))` (`conversation/conversation.ts:1287`, `conversation/store.ts:556`), and a model call with `runByProviderSession(sessionId)` (`conversation.ts:1410`, `store.ts:560`). The run is then fenced (`isCurrent`). Both lookups assume one run per session. The unique index `runs_session` (`conversation/schema.ts:79`) guarantees it for pi sessions; provider sessions have no index. The test build's fake model attributes its marks the same way (`faults/ports.ts:164`). |
| Tool calls know their task | Each execution gets `api.taskId` and `api.conversationId` (pi-durable `harness/types.d.ts:154`). Minerva reads only the conversation, in `ToolHost.current(session)` (`conversation/tools.ts:45`, `:105`), the script tool (`scripts/tool.ts:50`, `:163`; `scripts/host.ts:32`, `:47`) and the local tools (`conversation.ts:1023`). `current` is synchronous. |
| Model calls do not | pi sends a model call with its conversation's provider session id (`harness/generation.js:125`, `harness/compaction.js:125`), one per pi conversation (`harness/provider.js:4`). The wrapper's `host.begin(sessionId)` is synchronous (`model/provider.ts:83`, called at `:249`); `host.record` is awaited before the upstream is called (`:309`). |
| The gate's reader | `piWork` (`conversation.ts:1555`) reads the run's submission and one task of each live status in the session, any run's and background ones included (`:1560`). `classifyWork` (`conversation/gate.ts:23`) checks live tasks first, so a session with live tasks and no submission of this run counts as `in_progress`. |
| Stopping a run aborts its session | `#stopPi` calls `#abortSession`, which calls `conversation.abort(BG, {background: true})` (`conversation.ts:971`, `:977`). pi marks every live task the conversation reaches, background ones included, in one commit, then waits until they are terminal (`harness/scheduler.js:242`). Callers are a run's end (`#afterFinish`, `:953`), a reconcile (`:892`), deletion (`:407`) and retention's abort of a session (`:266`). |
| PiHarness's own operation abort | `withdraw` aborts a queued submission and, once it is placed, falls back to aborting the whole conversation (PiHarness `:434`, `:440`). Minerva cannot use `harness.abort({operationId})` for this chunk. |
| Cleanup at open | `#stopEnded` (`conversation.ts:707`) runs after `Harness.open` (`:654`) and before the factory returns (`:663`). It marks live tasks and withdraws queued submissions of sessions whose run is not active (`store.sessions()`, `store.ts:565`). `Harness.open` only loads tasks and turns `running` back to `pending`, dispatching nothing (`harness/scheduler.js:130`). PiHarness resumes pi after the factory returns (PiHarness `:529` to `:536`). |
| Nothing waits at a start | `#startLoop` (`conversation.ts:560`) installs the run's tools, creates and claims a session, and submits `run:<id>` (`:596`). A cancelled run is stopped in a deferred step (`#afterFinish`, `:951`), so the next run can be configured and submitted while the previous session still has live tasks. |
| pi's ids ascend in commit order | Entries, tasks and submissions share one id sequence (`session/transaction.js:159`, `:197`, `:220`; `storage/sqlite/storage.js:123`), and commits and reads run in order on the session's line (`session/session.js:154`, `:164`). A run's first generation is made in the commit that places its submission (`harness/submissions.js:191`, `harness/generation.js:554`). Its tool tasks are owned by a generation (`generation.js:214`), and each successor generation is made in a later commit (`generation.js:562`). |
| A busy session takes input as a follow-up | A submission sent while a run is live is queued (`submissions.js:147`, `:157`) and placed into that run at its next boundary (`generation.js:538`), or starts the next run in the commit that ends this one (`generation.js:522`, `:524`). A second run's input sent too early would be answered inside the first run. |
| No background tasks | Minerva sets `compaction.backgroundTokens: 0` (`conversation.ts:153`), so pi starts no background compaction (`generation.js:228`). Blocking and overflow compactions are owned by the generation (`compaction.js:184`). Minerva registers no task kinds of its own. |
| An abort mark is not the end | `pi.abortTask` commits the mark, then waits for the run invocation it saw to end (`harness/scheduler.js:179` to `:209`). It does not wait for the abort handler, so the task can still be live when it resolves. Only `pi.waitForTask` waits for the terminal state. Before resume there is no invocation to wait for. A connector tool returns at once on pi's abort (`tools.ts:112`); a local tool's `execute` goes on to `local:released` after `runGated` (`conversation.ts:1035`). |
| Late results are dropped silently | A call's outcome reaches `#invoke` (`conversation.ts:1317`). After the run ended, the executor answers it with no event, both for a result (`gateway/executor.ts:451`) and for a refusal (`:461`), and `#invoke` appends nothing (`conversation.ts:1337`). Nothing logs it. |
| Direct reads see whole commits | PiHarness's session store queues every statement behind an open pi transaction (PiHarness `:88` to `:99`), so `piWork`'s reads on the factory's storage never see half a commit. |
| Fault points filter by tool and model step only | A `Fault` names a point and a mode, and optionally a tool, a model step and a delta (`faults/plan.ts:25`); a point's `detail` is only logged (`:209`). |
| The perf probe | Each model call is marked at `host.begin` and when its request is answered (`faults/ports.ts:178`, `:225`); `test/account/perf.test.ts` reports M1 and M2 per call. Nothing measures a start to its first model request, and `faultRun`'s select has no `created_at` (`faults/index.ts:226`). A run's `created_at` is written by the start's final transaction, after its compile and its attachments' copy (`conversation.ts:458` to `:506`). |

## Decisions

### The data shape

Three types, in a new file `cloudflare/src/conversation/pi-work.ts`, with the rules as pure functions beside them. `PiWork` moves there from `gate.ts`, which imports it.

```ts
/** A run's operation in pi: the session it claimed, and its `run:<id>` submission once pi has it. */
type Operation = { session: number; submission: { id: number; status: SubmissionStatus } | null };

/** What pi holds live, from one `pi.inspect()`: queued and placed submissions, and live tasks. */
type PiLive = {
	submissions: { id: number; session: number; status: "queued" | "placed" }[];
	tasks: { id: number; session: number; background: boolean; abortRequested: boolean }[];
};

/** What pi holds for a run: no input yet, work in progress, or a settled submission with nothing of its own left. */
type PiWork = "not_submitted" | "in_progress" | "settled";
```

`Operation` is the run's identity in pi, keyed by what Minerva already sends (`operationId: run:<id>`). A run with no session has no operation (`null`). Only the active, acting run's operation owns work. Ended runs need no operation, since their work is orphaned by definition.

The rules:

- `belongs(op, task)` is true when `op` has a submission, `task.session === op.session`, the task is not background, and `task.id > op.submission.id`. It holds whatever the submission's status, so a settled run's last live task still counts as its own.
- `workOf(submission, ownLive)` answers `not_submitted` for no submission, `in_progress` for `queued` or `placed`, and for `done` or `unanswered` answers `in_progress` when `ownLive`, else `settled`. Tasks without a submission of this run never make work in progress.
- `orphans(op, live)` answers the live tasks that do not belong to `op` and are not yet marked, the queued submissions other than `op`'s, and the orphaned tasks and submissions still live, split into background tasks and the rest.
- `admitsTool(op, session, task)` is true when `op`'s submission is `placed`, `session === op.session` and `task > op.submission.id`.
- `admitsModel(op)` is true when `op`'s submission is `placed`.

The id rule rests on three facts in the table. Ids ascend in commit order. Every task of an operation is made in or after the commit that places its submission. And no other operation's task can be made after that commit, because a run submits only once no orphaned non-background task is live (The start's wait), and Minerva makes no background tasks. So the rule is not a guarantee of pi's alone: it holds because the start's wait holds, and unit test U5 runs that wait on a shared session. Another unit test asserts `backgroundTokens` stays 0.

`classifyWork` is deleted once its callers move to `workOf`.

### The gate

The gate keeps its place and its decisions (`decideGate` is unchanged). Only its reader changes.

`piWork(storage, run)` reads the operation first. No session or no `run:<id>` submission is `not_submitted`, whatever else the session holds. A queued or placed submission is `in_progress` without another read. Only for a settled submission does it look for the run's own live tasks, one filtered scan per live status: `scanTasks({conversationId: session, status, background: false, order: "descending"}, 1)` (pi-durable `types.d.ts:592`, `storage/sqlite/storage.js:288`, over the index `tasks_by_conversation`). The newest live non-background task of that status is the only one to check. If its id is not above the submission's, none is, so the read is exact without paging. `onStart` and the start's watch use the same reader, so they agree with the gate.

Two answers change, and both matter for 19b. A run with no submission no longer counts live tasks of an earlier run in its session as its own, so a run that never reached pi gets no attempt for another run's leftovers. A leftover background task no longer counts either. It is orphaned, and the cleanup at open marks it.

### Admission

Admission is by the active run and its operation, never by a session lookup.

**Tool calls.** `ToolHost.current` takes `{ session, task }` from `api.conversationId` and `api.taskId`, and answers a promise. It counts the entry for the test build (`#entered`), reads `store.activeRun()` (indexed by `runs_status`, `schema.ts:78`), refuses unless that run's session is the call's, reads the run's submission from pi's storage, refuses unless `admitsTool`, and then checks the fence synchronously after the last await, as today. The connector tool, the script tool (through `scriptToolHost`) and the local tools await it. A refusal answers `RUN_ENDED_MESSAGE` as today.

**Model calls.** `begin` stays synchronous. It refuses unless the active run's `provider_session` is the call's `sessionId` and its fence is current. The pi check is in `record`, which is already awaited before the upstream is called and before `recordModelCall`. It reads the run's submission and returns `null` (the existing "not recorded, not counted" refusal, `provider.ts:314`) unless `admitsModel`. `model/provider.ts` does not change. pi gives a model call no task id, so the rule for model calls is the operation's state, not the task. It is enough because a session's model calls come only from the generation that holds its live run and the compactions that generation owns, and the start's wait and the cleanup at open leave a session no live generation but the placed operation's.

The two checks are functions in `pi-work.ts`, `admitTool(deps, call)` and `admitModel(deps, fence)`, over three readers: the store's `activeRun` and `isCurrent`, and pi's `submissionByRequest`. `#toolHost` and `#modelHost` call them, so unit tests run the production checks over a real `RunStore` and pi on node:sqlite (U4). Each check adds one indexed read (`submissions_by_request`, pi-durable `storage/sqlite/migrations.js:51`) per call, through the store's queue (What the code does today).

`store.runBySession` and `store.runByProviderSession` are deleted. The test build keeps its own attribution. `#entered` passes the port the session the call names (the pi session for a tool, the provider session for a model call), and `faults/ports.ts` maps it to the newest run that names it, in its own SQL, for both its counts and the fake model's marks. In 19a that is the call's own run, so the tests that assert pi ran nothing for an ended run keep their meaning.

**Logs.** A refused tool admission logs `a tool call from pi session <s> was refused; run <id> acts now` (or `no run acts now`). A late result logs once per call in `#invoke`, when an outcome, with or without an event, reaches it for a run that is no longer active: `run <A>'s call <tool> answered after the run ended; its result is refused (run <B> acts now)`. Neither line carries arguments or results. Both use `#log` at warn level (owner question 4). The second is the "You see" box.

### Stopping and settling

A new class, `PiStops` in `cloudflare/src/conversation/pi-stops.ts`, applies the rule to pi. The Conversation wires it to `harness.pi()`, a reader of the acting run's operation, the bound and its log. It takes no other part of the object, so unit tests run the production code on pi over node:sqlite (U5). It replaces `#stopPi` and `#abortSession`. It never calls `conversation.abort` and never uses PiHarness's `withdraw`.

It keeps marking and settling apart, since pi's calls do, and runs starts one at a time.

**Mark** (`stop(session?)`):

1. Read `pi.inspect()` (on pi's line, pi-durable `harness/harness.js:159`), then the acting run's operation. The order matters. A submission committed between the two reads has no task in the inspection, so its tasks cannot be taken for orphans.
2. In one synchronous stretch, start `pi.abortTask` for every orphaned task not yet marked and `pi.abortSubmission` for every orphaned queued submission. With `session`, only that session's. These promises are not awaited, since an `abortTask` can wait on a running invocation that ignores its signal. Their failures are logged.
3. Read again. A mark's commit enters pi's line when `abortTask` is called, so the next read comes after it and shows the task marked. A generation can hand its run to a successor between a read and its mark (`generation.js:562`); the successor is conversation-owned, so the old one's mark does not reach it. A pass that finds nothing new to mark ends the step.

**Settle** (`settle(which, signal)`). It waits until the orphaned tasks of `which` are terminal and no orphaned submission is unsettled, with `pi.waitForTask` and a read after each wait. `signal` ends the wait early: pi's `waitForTask` takes it in its context and cancels only the wait (pi-durable `harness/types.d.ts:667`). `which` is `foreground` (non-background tasks, for a start) or `all` (for deletion). It waits for tasks marked by any caller, not only its own marks. Orphaned placed submissions need no call, since pi settles them `unanswered` when their generation's abort handler ends the run (`harness/live.js:27`).

**Lane** (`section(fn)`). It runs a start's section, or deletion's, after the previous one ends (The start's wait). A section that throws does not stop the next.

The callers:

| Caller | Steps | At the bound |
|---|---|---|
| A run's end (`#afterFinish`, deferred) | mark | none; the next start settles what is left |
| A reconcile (`#reconcile`) | mark | none |
| Deletion (`deleteInternal`) | lane, mark, settle `all` | logs, resets the object and fails the deletion, which Laravel sends again; the next instance marks everything before pi resumes |
| Retention's abort of a session (`retention.ts:173`) | mark, that session only, as today without waiting | none |
| A start (`#startLoop`) | lane, mark, settle `foreground` | The start's wait |
| The cleanup at open (`#stopEnded`) | mark, one pass, awaiting the marks' commits | none (Cleanup at open) |

Deletion keeps today's promise that pi runs nothing after it answers, and P5 checks that no task is live at its answer. It takes its turn in the lane after ending the run, so a start that was about to submit finishes its section, post-submit mark included, before deletion reads what is live. Without that, a submit committed after deletion's read would make work no one waits for (P7). Retention passes only while no run is active, so its session's work is all orphaned and the marks are what the whole-session abort made, without the code that could abort an active run's work.

A stop marks every orphaned task, not only the ending run's. In 19a the two sets are the same, since the only live work outside the active run's session is the run that just ended and sessions retention has not deleted. One rule for every caller is simpler than a rule per run, and it never touches the active run's work.

### The start's wait

`#startLoop`'s section, from the attempt's start to the submit, runs in `PiStops`'s lane, one run at a time:

1. Start the attempt and its phase, as today.
2. **Wait.** Mark, then settle `foreground`. Background orphans are marked and not waited for, as the plan says. The wait's signal aborts at the section's deadline and at the run's end (its `#controller` signal, which a cancel, a deletion and the deadline abort), so a run that ends while it waits ends its section at once, without configuring anything.
3. Check the fence again, then install the run's tools, create or reuse its session, claim it, prepare its container and submit, as today.
4. **In a `finally` after the submit**, whether it resolved or threw, mark if the run is no longer current, so a run that ended during its own submit leaves nothing live.

The lane is what keeps a late submit from becoming a follow-up. Without it, run A's section can pass its fence check, then await `harness.submit` while A is cancelled and B starts. B's wait would find nothing of A's, and A's input would land after B's. In 19a that leaves a stray generation in A's session that admission refuses; in 19b it would be queued in B's session and answered inside B's run (`generation.js:538`). With the lane, B's section starts after A's ends, A's step 4 marks what A's submit made, and B's wait settles the rest.

**The bound.** A section's deadline is set when it is queued, so it covers the time in the lane and the wait. The bound is `piSettleMs`, 30 s in production (owner question 1). It is a port, so the test build reads a shorter one from the fault plan's config (`pi_settle_ms`), as `runTimeoutMs` does (`faults/ports.ts:229`). Each section has its own timer, cleared in a `finally`, so a section that ended can never fire it. When the deadline passes while the section still waits and its run is still current, the object logs `run <B> could not start: pi's earlier work did not end within 30 s` and resets (`#reset`). A timeout alone would leave the work running, as `within` does (`conversation.ts:1603`), so the reset is what ends it. A reset ends every invocation in memory. The next instance's gate finds B with no submission (`not_submitted`, no attempt counted), its cleanup marks the orphans before pi resumes, their abort handlers run with no invocation to join, and `onStart` starts B's section again. pi's own abort handlers for generations and tool tasks are single commits, so one reset ends the work that held the wait.

**Cost when nothing is left.** The wait costs two `pi.inspect()` reads and one submission read, on pi's line in the same isolate. This is part of what the perf box measures (Perf probe and rule).

### Cleanup at open

`#stopEnded` keeps its place, after `Harness.open` and before the factory returns, so before PiHarness's `pi.resume()`. The plan says "before `Harness.open` resumes the scheduler", but `Harness.open` resumes nothing; this is the last point before anything runs. It now uses `PiStops`'s mark, given the Harness the factory just opened (`harness.pi()` waits for the open) and the acting run's operation read from the factory's storage, instead of `store.sessions()`. It marks and withdraws in one synchronous stretch, as today. It awaits the marks: before resume no invocation exists, so each resolves once its commit is made. It waits for nothing else, since the factory runs under `blockConcurrencyWhile`'s 30 s limit (ARCHITECTURE.md, Attempts and recovery), and it fires no fault point, so a test's hold cannot block the factory.

Against today it also marks orphaned work in the acting run's own session, such as a background task or tasks with ids at or below its submission's. In 19a neither exists.

### After a restart

| Where the object died | What the next instance does |
|---|---|
| A run in progress (submission placed, tasks live) | The gate answers `in_progress` and restarts the run. The cleanup marks nothing of its own. pi resumes its tasks, and admission takes them under the new attempt's fence (placed submission, ids above it). As today. |
| A run cancelled, its stop lost | The gate finds no acting run, or the next run with no submission. The cleanup marks the cancelled run's tasks and withdraws its queued submission before pi resumes. The next run's start settles them, then submits. This is F1. |
| Between a run's claim and its submit | The run has a session and no submission, so the gate answers `not_submitted` and counts no attempt. `onStart` starts its section, which reuses the claimed session, waits, and submits `run:<id>` once (pi deduplicates by request id, `submissions.js:130`). |
| After the submit, before step 4 | The submission is placed, so the gate answers `in_progress` and counts a restart, as today for any reset after a submit. |
| The submission settled while the object was away | `settled` when no live task of its own is left; `onStart` reconciles it, the run ends, and its end marks what is orphaned. |
| A leftover background task | Not counted by the gate; orphaned, so the cleanup marks it. |
| The gate ends the run (inert conversation, deadline, attempt cap) | No acting run, so all of pi's live work is orphaned and marked, as today. |
| During the start's wait, or its reset at the bound | `not_submitted`, no attempt counted; the cleanup marks the orphans; the section runs again. |
| During the cleanup at open | The gate already committed its decision and synced. The next instance runs the gate again, as today when the factory dies after the gate. |

### What 19b and 20 inherit

- 19b submits every run to the conversation's one pi session. Admission, the gate, `PiStops` and the start's wait need no change for it. 19b drops the unique index `runs_session` (`schema.ts:79`) with its new column for the conversation's session.
- 19b must change retention before sessions are shared. Today a run's retention deletes its whole pi session (`pruneRecords` moves a run with a session to the `pi` step, `store.ts:982`; `prunePi` deletes the session, `store.ts:996`, called at `retention.ts:215`), and the orphan-session step deletes a session no run names. With one session per conversation, the first old run's retention would delete the conversation's history. 19b keeps the session as long as the conversation (the Decisions of after-the-plan.md say so) and tests an aged run's retention on a shared session.
- `runs.provider_session` keeps one value per run row. In 19b each row holds the conversation's provider session, so `begin`'s comparison still holds; 19b may drop the column and compare with the conversation's.
- The test build's attribution of `entered` by the newest run that names a session is exact only while sessions are per run. 19b's platform tests attribute by the active run, or by task id, instead.
- 19a's platform and fault tests cannot put two runs on one session, since the unique index forbids it. U5 runs the production `PiStops` on a shared session in Node; 19b's platform tests (twelve runs, a cancel between two) run it in workerd (owner question 3).
- 20 parks the container between runs. The start's wait ends the previous run's pi tasks, not the commands those tasks started in the container. A local tool's command can outlive its task. 20 must stop them before the next run uses the parked container. Settlement would also lose a parked container. `#settleJob` seals the run (`conversation.ts:809`), and `seal` destroys the container while it still belongs to that run (`sandbox/core.ts:675` to `:680`), as `#cleanSandbox` does for ended runs (`conversation.ts:1190`). 20 defines parking against `seal`, the container's spans and recovery's clean-up, and tests a settlement before and after the next run takes the container.

## Units

One fresh agent each, in this order. A unit is done when its checks pass and it is committed to `main`; opencode reviews the diff of units 3 to 5. The checks are `pnpm typecheck`, `pnpm test:unit` and `pnpm test:platform` in `cloudflare/`.

1. **The probe (test build).** `created_at` in `faultRun`'s select (`faults/index.ts:226`) and in `RunInternals`; S, below, in `perf.test.ts`'s summary and `MINERVA_PERF_OUT`; the run's pi tasks (id, kind, status, abort mark) in `RunInternals`, for F1. This commit is the perf baseline: `main`'s engine with the probe. Check: the three, with the platform test that marks each fake-remote call (`test/platform/protocols.test.ts:349`) also asserting the first call's `answered` after the run's `created_at`.
2. **What pi holds, by operation.** `pi-work.ts` with the types and rules above; `piWork` reads the submission first and scans only for a settled one; `gate.ts` imports `PiWork`; `classifyWork` and its cases in `test/unit/conversation-gate.test.ts` are deleted; U1 to U4's rule cases in a new `test/unit/pi-work.test.ts`. Check: the three.
3. **Admission by run.** `ToolHost.current({session, task})` async in `conversation/tools.ts`, `scripts/tool.ts`, `scripts/host.ts` and `#localTool`; `admitTool` and `admitModel` in `pi-work.ts`, called by `#toolHost` and `#modelHost`; `runBySession` and `runByProviderSession` deleted; the `entered` port takes the session, and `faults/ports.ts` attributes it and the fake model's marks itself; the refusal and late-result logs. The fakes in `test/unit/conversation-tools.test.ts`, `test/unit/scripts-tool.test.ts` and `test/platform/facts.test.ts` answer a promise. Tests U4's production checks and host case, and P1. Check: the three.
4. **Stops by the rule.** `PiStops` with mark and settle; `#afterFinish`, `#reconcile`, deletion, retention's abort and `#stopEnded` use it; `#stopPi`, `#abortSession` and `store.sessions()` deleted; the point `pi:stop`, fired only by a run's end's mark, with the run as its detail. Tests U5 (b) to (d), P2 and P5; the existing cancel and inert-conversation tests (`conversation.test.ts:435`, `:874`) pass unchanged. Check: the three.
5. **The start's wait.** `PiStops`'s lane; the section, its deadline and timer, the reset, the post-submit mark; deletion's turn in the lane; the point `pi:wait`, fired when a section starts waiting, with the run as its detail; the `piSettleMs` port and its test-build config. Tests U5 (a), (e), (f) and (g), P3, P4, P6 and P7; F1 in `test/account/faults.test.ts` and its row in that file's header. Check: the three. F1 runs with the live boxes (Live checks).
6. **Docs.** ARCHITECTURE.md: The harness (admission by run, the start's wait), Attempts and recovery (what counts as a restart, Stopping pi), and the `#stopPi` mention in the retention bullet. after-the-plan.md: 19a's boxes, each with its evidence. Check: none beyond reading.

## Tests

Every box of the chunk, with the test that checks it. U are unit tests, P platform tests, F the account fault test.

| Box | Evidence |
|---|---|
| Build: admit by the run's submission | U4; P1 |
| Build: the gate reads the submission first and counts only its tasks | U1, U2 |
| Build: stop with an abort for the operation, never the whole conversation | U3, U5 (b) to (d) and (g); P2, P5, P7; `#abortSession` deleted |
| Build: wait before configuring or submitting; clean up orphans before pi resumes | U5 (a), (e), (f); P3, P4, P6; F1 |
| You see: a cancelled run's late result is logged as refused for the new run | P1 |
| Verify, unit: gate cases for each submission state, a leftover background task, two runs on one session | U1, U2 (`pnpm test:unit`) |
| Verify, unit: a delayed abort overlapping the next run's admission | P2, and U5 (c) on one session (`pnpm test:platform`, `pnpm test:unit`) |
| Verify, live: regression against `main` | `pnpm test:faults` on `minerva-cf-test` at head (Live checks) |
| Verify, live: a kill between a cancel and the next start | F1 |
| Verify, perf: startRun to the first model request | S (Perf probe and rule) |

**U1, the gate's cases** (`workOf`, and `piWork` over pi's own storage on node:sqlite, opened as `test/unit/pi-tables.test.ts` opens it). Alone, `queued` and `placed` are `in_progress`, `done` and `unanswered` are `settled`. `done` with a live task of its own is `in_progress`. No submission with live tasks in the session is `not_submitted`. A leftover background task (made with `conversation.commit((tx) => tx.createTask(..., { ownership: { kind: "conversation" }, background: true }))`, pi-durable `types.d.ts:248`) is not counted, so its run's `done` submission stays `settled`.

**U2, two runs on one session** (readers). One pi session; run A submits `run:A` with a tool that holds, so A's tasks are live. Run B, active with no submission, is `not_submitted`, where today's reader says `in_progress`. Once A's tasks end, B submits `run:B` and is `in_progress`; after B answers, `settled`, with A's settled submission ignored. The ids of A's tasks are all below `run:B`'s.

**U3, orphans** (pure). With B active and not submitted, every task of A is orphaned and live; with B placed, B's tasks belong to B and are never in the answer; a background task in B's session is orphaned and live but not in the foreground set; a queued submission of another request id is withdrawn; a marked task is not marked again. Plus the assertion that `PI_SETTINGS.compaction.backgroundTokens` is 0.

**U4, admission.** The rules: `admitsTool` and `admitsModel` for a placed submission and a task above it (admitted), a task at or below it, a queued and a settled submission, another session and no submission (refused). The production checks, `admitTool` and `admitModel`, over a `RunStore` on node:sqlite (as `test/unit/conversation-admission.test.ts` opens it) and pi on one shared session: a task of A's against B's placed submission is refused; B's own task is admitted; B with no submission, a queued one and a settled one is refused; a cancel committed while the check awaits pi's read is refused by the fence after it. In `conversation-tools.test.ts`, a host that refuses answers `RUN_ENDED_MESSAGE` and invokes nothing.

**U5, `PiStops` on one shared session** (`test/unit/pi-stops.test.ts`, the production class over pi on node:sqlite, with tools and a task kind of the test's own). (a) A's submit is held just before its admission commit while A is cancelled and B's section is queued; B's section starts only after A's ends, finds A's placed submission orphaned, settles it, and B's input is answered in its own run, never as A's follow-up. (b) A generation hands its run over between a mark's read and its marks (a test hook between the two); the next pass marks the successor. (c) A stop started for A is held until B is placed on the same session, then released; it marks nothing of B's, and B answers. (d) A held tool task already marked by an earlier stop is still waited for by deletion's settle, which answers only once it is terminal. (e) A held background invocation that ignores its signal is marked and does not delay B's wait. (f) A section that throws does not stop the next section, and a section's timer never fires after it ended. (g) Deletion's section, queued behind a start held just before its submit commit, runs only after that section's post-submit mark, and its settle answers only once the late submit's work is terminal.

**P1, a late result** (`test/platform/protocols.test.ts`, through the real executor, as the write-in-flight revocation test, `:265`). The provider delays `POST /folders/inbox/notes` 1.5 s and `GET /folders/inbox/notes` 3 s. Run A files a note; once the write reaches the provider, A is cancelled, and run B, which lists the inbox, starts at once. A's write answers while B's read waits. The console spy has `run <A>'s call notes_file_note answered after the run ended; its result is refused (run <B> acts now)`, and no line with the note's title. A has no `tool_call` event; its write is `succeeded` in the ledger; B completes with its one `tool_call`. Fails on `main` (no log).

**P2, a delayed stop overlapping the next run's admission** (`protocols.test.ts`, which runs the test build's points). A hold at `pi:stop`, once. Run A reads the inbox and is cancelled while its read is in flight, so its end's mark is held. Run B starts; its read is admitted and recorded while A's mark is still held. The hold is released. B completes; no task of B's session was ever abort-marked (`pi_tasks.abort_requested`); B has its one `tool_call`. Passes on `main` too, where A's session is not B's; U5 (c) is the same case on one session.

**P3, the wait** (`test/platform/local-tools.test.ts`, whose memory sandbox runs local tools). Run A's `bash` call is held at `local:released`, after `runGated`, where pi's abort does not end it. A is cancelled and run B started at once. While the hold lasts, a `note` at `pi:wait` has fired for B, B makes no model call (its entered count stays 0) and has no submission. The hold is released; A's tool task ends; B completes in attempt 1. Fails on `main`, where B runs while A's task is live.

**P4, the bound** (the same file). As P3 with `pi_settle_ms` at 2,000 and the hold never released. The object resets about 2 s after B's wait began; the next instance marks A's task before pi resumes; B completes, its attempts are `[{ attempt: 1, ended: "completed" }]` with no restart marker, and the log has the bound's line. Fails on `main`.

**P5, deletion waits** (`test/platform/conversation.test.ts:1102`, the deletion test). It reads the live tasks right after `deleteConversation` answers, before its hold is released, and finds none.

**P6, three runs** (`local-tools.test.ts`). As P3, then B is cancelled while it waits, and run C starts. B never submits and its section ends without configuring anything; C waits for A's held task, then completes once the hold is released. C's attempts are `[{ attempt: 1, ended: "completed" }]`.

**P7, deletion behind a held submit** (`protocols.test.ts`, which runs the test build's points). A hold at `loop:created`, which is after the session's creation and before its claim and submit. The conversation is deleted while the start is held, and the hold is released 200 ms later. Deletion answers only after the release; at its answer no pi task is live and no submission is queued or placed.

**F1, a kill between a cancel and the next start** (`test/account/faults.test.ts`, in the container, as the checkpoint crash rows, `:314`). `world({ faults: [{ point: "local:released", mode: "hold", tool: "bash" }, { point: "pi:stop", mode: "abort" }] })`. Run A runs one `bash` command, then answers. Its call is held at `local:released`, after `runGated`, so A's tool task is running and its submission placed whatever the cancel does: neither the run's controller nor pi's abort ends that invocation. Once the hold has fired, Laravel's cancel ends A, and A's end's mark hits `pi:stop`, which syncs, then resets the object before marking anything (the plan's default), so A's live task and placed submission are what the next instance finds. The cancel is sent again until it is answered, as Laravel does; a repeat answers `cancelled` from the stored end. Run B (one read of the inbox, then "Done.") is started at once. Expected: `pi:stop` fired once, as an abort; B completes with attempts `[{ attempt: 1, ended: "completed" }]`; A's tool task and generation are terminal and abort-marked (`RunInternals`' pi tasks); A's entered counts are those at the cancel, `{ model: 1, tool: 1 }`; the container ran A's command once; A has no `tool_call`; the provider got B's one read and nothing else. Had pi resumed A's work before the cleanup marked it, pi would have reported the `bash` call interrupted (an unsafe tool is not run again, pi-durable `harness/tool.js:105` to `:118`) and A's generation would have asked the model again, which the wrapper counts before refusing it. So without the cleanup at open, A's model count and its tasks' abort marks fail. With the cleanup but without admission by run, nothing in 19a fails, since A's session is not B's; that is U4's to show.

What fails on `main` (P1, P3, P4, P6, U1's no-submission case, U2, U5) checks what 19a changes in 19a. What passes on `main` in substance (P2, P5) checks what 19a keeps safe once 19b shares a session. F1 is new with 19a, since `main` has no `pi:stop`.

## Live checks

| Check | Where | Who |
|---|---|---|
| `pnpm run deploy:test` at head, then `pnpm test:faults`: every end-to-end turn passes as on `main`, and F1 passes | `minerva-cf-test` | The coordinator, serialized with chunk 17's session |
| The perf runs below | `minerva-cf-test` | The coordinator |

Nothing deploys to staging or production in this chunk. Production and staging get 19a with the next deploy the owner approves.

## Perf probe and rule

**Metric.** S, per turn, is the first model call's `answered` mark minus the run's `created_at`, both on the object's clock. `answered` is the existing mark taken when the fake-remote request's answer is read (`faults/ports.ts:178`). A request's departure cannot be timed inside the object: its clock moves only when I/O completes, and the output gate holds the request until the writes before it are durable (chunk-14a-design.md, Why the fetch). So S ends at the first answer, as M1 and M2 do, and includes one round trip to a sibling object that is the same on both sides. `created_at` is written by the start's final transaction. So S covers the activation, the attempt's start, the lane and the wait, the session's creation, the submit, pi's first step, the first call's admission (where 19a's model check reads pi), the output gate's wait for every write before the request, and the round trip. It leaves out Laravel's round trip and what the start does before its final transaction (the compile, the attachments' copy), which 19a does not change. Both departures from the plan's wording are owner question 2.

**How it is measured.** The probe's existing run (20 turns of six calls, `perf.test.ts`) adds S for each turn, 20 samples. Every turn starts after the previous one completed, so each S includes a wait that finds nothing, which is the case the rule is about. The calibration of chunk 14a also checks S: with `MINERVA_PERF_CALIBRATE=write`, S must rise by the ballast's write beyond the `cpu` control, as M2 does. The baseline is unit 1's commit, `main`'s engine with the probe. The coordinator runs baseline, head, baseline, head, each after a fresh `pnpm run deploy:test`, and reports S's median and p95 beside M1 and M2.

**Rule.** Head's median S minus the baseline's median S is at most 200 ms in both pairs. More fails. If the two baselines' medians differ by more than 200 ms, the probe cannot judge the rule, and the coordinator asks the owner instead of calling it a pass (owner question 2).

## Risks

- **A wait delays the next turn.** A run started right after a cancel waits for the cancelled run's pi work to end, up to 30 s, then resets once. A tool that ignores pi's abort (a local tool past `runGated`, a script finishing its guest) is the usual cause.
- **A reset at the bound ends what else the instance holds**: a facts delivery, a sweep, the previous run's container destroy. Each is a Lifecycle job or is redone by `#recover`, as after any reset.
- **The id rule rests on pi's id sequence, its follow-up behaviour and the start's wait.** The first two are pi-durable 1.2.0's. A pi-durable upgrade must be checked against `belongs` as it is against `pi-tables.ts`'s statements (ARCHITECTURE.md, Open questions 3). U2 and U5 run on pi itself, so an upgrade that breaks the order fails them.
- **Model admission is by the operation's state, not the call's task.** If pi ever made model calls outside the live run's generation tree, such as a background compaction, admission could not tell whose they are. U3 fails if `backgroundTokens` changes.
- **The test build's attribution is per session.** Correct in 19a; 19b changes it (What 19b and 20 inherit).

## Owner questions

1. **The start's bound.** Recommended: 30 s, then reset the object, after which the start runs again with no attempt counted. The alternative is to end the new run `worker_exited` at the bound, which the user sees as a failed turn caused by an earlier one.
2. **The perf rule's measure.** Recommended: S, from the start's final transaction to the first model call's answer, as its median over 20 turns, baseline and head interleaved twice, 200 ms in both pairs, p95 reported; if the baselines differ by more than 200 ms, the owner decides. The plan names "startRun to the first model request" and 200 ms. S starts later than startRun (after the compile and the attachments' copy, which 19a does not change) and ends at the request's answer rather than its departure, which the object cannot time, as chunk 14a's M1 and M2 do (chunk-14a-design.md, amendment 13).
3. **Shared-session evidence before 19b.** Recommended: U5 runs the production `PiStops` on one shared session in Node in 19a, and 19b's own platform tests run it in workerd. The alternative is a test-build seam in 19a that makes a run reuse the previous run's session, which needs `runs_session` dropped and retention changed a chunk early.
4. **Log level.** Recommended: warn for refused admissions, late results and the bound's reset. They follow every cancel with a tool in flight, so error level would page an operator for normal use.

## Changes to after-the-plan.md

None in this commit. Unit 6 checks 19a's boxes with their evidence and notes there that the cleanup runs before PiHarness resumes pi, since `Harness.open` resumes nothing.

## Amendments after opencode's review

opencode (`plan` agent) reviewed the first draft on 2026-10-18 against `abeced2` and pi-durable 1.2.0. Each finding was checked in the code. It confirmed the draft's claims about PiHarness's `withdraw`, `Harness.open`, pi's id sequence, follow-ups, `backgroundTokens: 0`, the filtered scans and PiHarness's queue.

1. **Deletion did not wait for pi's work to end (accepted).** `abortTask` resolves after its mark and the run invocation it saw, not after the abort handler (`scheduler.js:179` to `:209`); opencode's probe on the installed package found the task still `pending` after it resolved. And the draft skipped tasks already marked, so a task another stop had marked was never waited for. Marking and settling are now separate steps, settle waits with `waitForTask` for every orphaned task whoever marked it, and P5 checks deletion at its answer (Stopping and settling).
2. **The start's wait awaited background marks (accepted).** The draft awaited every mark's promise, and a background invocation that ignores its signal could hold a start for 30 s. Marks are no longer awaited after open; a start settles foreground tasks only; U5 (e) covers it.
3. **The late-result log missed the executor's path (accepted).** After a run ends the real executor answers with no event (`gateway/executor.ts:451`, `:461`), so `appendToolCall` is never called and the draft's log would not fire outside a fake. The log moved to `#invoke`, for any outcome of a run no longer active, and P1 runs through the real executor without logging arguments or results.
4. **Fault plans cannot filter by detail (accepted).** `Fault` filters by tool, step and delta only (`faults/plan.ts:25`, `:185`), so the draft's `detail: "finish"` would have fired at the first stop, possibly a start's. `pi:stop` now fires only at a run's end's mark and `pi:wait` only at a start's wait, and F1 asserts that `pi:stop` fired and that B ran in another instance.
5. **S stopped before the model admission and left the start's earlier work out (accepted).** The draft ended S at `host.begin`, before `host.record`'s pi read. The revision ended it at a `sent` mark before the fetch, which amendment 11 replaced. The metric now says what it leaves out (Perf probe and rule).
6. **The shared-session race was tested only with fixture steps (accepted).** The draft's U2 and U3 checked the readers and the rule, not the code that orders stops and starts. That code is now `PiStops`, which takes only pi and a reader, and U5 runs it on one shared session: a held submit, a handover between read and mark, a late stop after B is placed, deletion after another stop's mark, a held background invocation.
7. **The lane and the bound needed a contract (accepted).** The design now says when a section's deadline starts (when it is queued), that its timer is cleared in a `finally`, that only a section still waiting for a current run resets the object, that a section that throws does not stop the next, that the fence is checked again before configuring, and that the post-submit mark is in a `finally`. P6 (three runs) and U5 (f) test it.
8. **19b's retention would delete the shared session (accepted, for 19b).** `prunePi` deletes a run's whole session (`store.ts:996`, called at `retention.ts:215`). Not 19a's to change, since 19a still has a session per run; it is now in What 19b and 20 inherit.
9. **20's settlement destroys a parked container (accepted, for 20).** `seal` destroys the container while it belongs to the run (`sandbox/core.ts:675`). Added to What 19b and 20 inherit, with recovery's clean-up.

A second review, of the revised design, on 2026-10-18. It found the claims about pi's id order, follow-ups, abort marks and the paused open correct.

10. **Deletion could answer before a submit in flight landed (accepted).** A start held just before its submit commit could commit after deletion read what was live, and its post-submit mark would come after deletion's answer. Today's code has the same gap. Deletion now takes its turn in the lane after ending the run, so it reads only after any start's section, post-submit mark included, ended; U5 (g) and P7 test it.
11. **S missed the output gate's wait (accepted).** A mark taken before the fetch is the time of the last finished I/O, not the departure, and the output gate holds the request after it until the writes before it are durable (chunk-14a-design.md, Why the fetch). S now ends at the first call's existing `answered` mark, a round-trip proxy as M1 and M2 are, which the calibration moves. The start boundary and the proxy are in owner question 2 for the owner's approval.
12. **F1 did not guarantee orphaned work at the kill (accepted).** After a cancel, the controller cuts the read, the connector tool returns, and the generation's next model call is refused, so A's work could end before the deferred mark reached `pi:stop`, and F1 would pass with the cleanup at open removed. F1 now holds A's `bash` call at `local:released`, which neither the controller nor pi's abort ends, and checks A's model count and abort marks, which fail without the cleanup (an unsafe tool is reported interrupted on resume, and the generation would ask the model again).
13. **Admission was not tested in production code on a shared session (accepted).** U4 tested the rules and a host that already refused. The checks are now `admitTool` and `admitModel` in `pi-work.ts`, which the hosts call, and U4 runs them over a `RunStore` and pi on one shared session: a task of A's against B's placed submission, B's submission missing, queued and settled, and a cancel while the check awaits pi's read.
