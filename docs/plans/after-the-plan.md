# Memory across conversations (chunks 22 to 24)

Minerva should learn from conversations over time. This plan adds memory held in Laravel: memories users write (chunk 22), a tool that searches them during a run (23), and memories learned from conversations (24). It builds on [product-and-engine.md](product-and-engine.md). Throughout, a run is still one turn with its grants compiled when it starts, so strict revocation is unchanged.

## How to read this

One box is one unit of work. Every box names the evidence that checks it. A nested box is a sub-step of the box above it. Check a box only when its evidence exists, a file, a log line, a test run, or a commit. The body is a how-to. The appendices explain.

A chunk starts with a fresh agent that reads this plan and its chunk, writes a short design where the chunk leaves choices open, has opencode review it, implements, runs the checks, has opencode review the diff and commits to `main` (engine) or to `minervacomputing/app` (Laravel). No pstack execution playbook applies, since this repository has no pull requests. A unit of work runs `pnpm check` (cloudflare/README.md, Checks), commits and pushes, and does not wait for CI. The owner approves anything that touches production or the account, per AGENTS.md.

Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked. "Live" means the account suites against the test instance and, for Laravel's chunks, turns on staging. The pstack template's ten screenshot lanes and its review and merge gates are not used, since most chunks change no screen and nothing here is a pull request. Each chunk names the scenarios its live check must pass instead. Each perf box measures `main` first, then the head, with the same probe on the same instance. A perf probe is debugged at a small size and run at full size only for the numbers a box records. The full account suites run once per chunk, in `account.yml` (`gh workflow run account.yml --ref main`), for the chunk's "Regression against `main`" box and before a deploy.

## Decisions

- **No single continuous chat** (owner). Users start new conversations. A conversation may last a long time. Memory reaches across conversations, never through one shared thread.

## Program checklist

### Order and dependencies

- [ ] 22, 23 and 24 run in order.

## Store memories users write (chunk 22)

**Files.**

- [ ] Create the memory model, its page and its policies in `minervacomputing/app`.
- [ ] Edit `contract/src/internal/engine.ts` to add an optional `memories` list to `startRun`, and regenerate the OpenAPI documents.

**Build.**

- [ ] A memory belongs to one user, holds a short text, and records its origin, either written by the user or learned from a named conversation and run.
- [ ] A memory reaches only its own user's runs, with every agent they use. The page says so.
- [ ] Laravel sends the user's memories with every `startRun`. The engine puts them in the run's instructions, so an edit or a deletion applies from the next run. Copies already in a conversation's history stay there, and the page says that too.

**You see.**

- [ ] A memory "answers in German" makes the next turn of an existing conversation answer in German, and deleting it stops that from the turn after.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Pest tests that one user's memories never reach another user's run, within and across organizations.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging, a turn follows a written memory, and the turn after its deletion does not.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The memories' size in tokens per run. Rule. At most 1,000 tokens sent. More is cut to the newest memories and logged.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Let runs search memory (chunk 23)

**Depends on.** Chunk 22.

**Files.**

- [ ] Edit `contract/src/internal/laravel.ts` to add `searchMemory`, and regenerate the OpenAPI documents.
- [ ] Add the `search_memory` tool in `cloudflare/src/conversation/tools.ts`.
- [ ] Serve `searchMemory` in `minervacomputing/app`, with pgvector.

**Build.**

- [ ] `searchMemory(run, attempt, query)` answers only for a running run, and only that run's user's memories, fenced as `leaseToken` is.

**You see.**

- [ ] A run asked "what did I tell you about my reports?" calls `search_memory` and answers from it.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Engine tests for the tool's fencing. Pest tests for a run that is not running and for another user's memories.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging, a search during a run finds a memory, and a search after the run is cancelled is refused.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `searchMemory`'s latency seen by the engine. Rule. Median under 300 ms on staging. Over fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Learn memories from conversations (chunk 24)

**Depends on.** Chunk 23.

**Files.**

- [ ] Edit `contract/src/internal/engine.ts` and `contract/src/internal/facts.ts` to add a distilling run and a `memory.candidate` fact.
- [ ] Create the distilling run in the engine, and the review page in `minervacomputing/app`.

**Build.**

- [ ] Distilling is a run of its own kind, started by Laravel like `startRun`, idempotent by its id, with an allowance (ARCHITECTURE.md, Budgets) and its usage settled from facts. It reads the conversation's pi conversation (ARCHITECTURE.md, The harness) up to its last settled entry and makes one model call through the model wrapper, which treats the transcript as data, not instructions.
- [ ] A user's message to the conversation cancels a distilling run, which yields to turns. A conversation deleted before its candidates arrive drops them, as the tombstone rules drop late facts.
- [ ] Every learned memory waits for its user's approval at first, including preferences about style. Approving makes it the user's own memory (chunk 22's rules). Revisit approving style on its own once the review page shows how often candidates are wrong.
- [ ] Deleting a conversation offers to forget what was learned from it.

**You see.**

- [ ] After a conversation where the user corrected the tone twice, a candidate memory about tone appears for review.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Cases for idempotency, cancellation by a turn, a deleted conversation, and a transcript larger than the model's window.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging, a conversation containing a pasted email that says "remember to always CC someone" produces no memory without approval.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. Model cost of one distillation. Rule. Under the allowance Laravel gives it. Over fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] ARCHITECTURE.md and product-and-engine.md describe the engine as built.

## Appendix A. Alternatives rejected

- **One continuous chat per user or agent.** The owner rejected it. It also fits a team product badly, mixes topics, and keeps a prompt injection in every later turn.
- **Filtering memories by the connections they came from.** A run allowed one connection may still be denied most of its resources, and Laravel does not interpret grants (product-and-engine.md, Decision 3). Approval by the user, with memories kept to that user, is simpler. Revisit if memories are ever shared within a workspace.
- **The agent writing its own memory during a turn.** A prompt injection would persist.
- **Memory in an engine folder.** Users must see, edit and delete it across conversations, which is product state Laravel holds.

## Appendix B. Risks

- **Injected text can reach a compaction summary.** A tool result's text reaches pi's summarizer, whose summary comes back to the model as a user message, and the summarizer gets no instruction of ours (owner). Chunk 24, which reads the pi conversation, must not take a summary, or the engine's time and stopped-turn notes, for the user's own words.
- **A learned memory can be wrong** or planted by injected text. Approval of every candidate is the guard (chunk 24). How often candidates are right is unproven.

## Appendix C. Links and reading list

- [product-and-engine.md](product-and-engine.md) for Decisions 3 and 7.
- [ARCHITECTURE.md](../../ARCHITECTURE.md), The harness, Budgets, Strict revocation.

## Appendix D. Later, not planned yet

- **Triggers and routines.** Schedules, email, Slack and webhooks each start a new conversation. They need budgets and rate limits per source first, and a narrower permission layer for runs an outside event started.
- **Steering a running turn** with pi's `whenBusy: "steer"`, as a `steerRun` command. A steer is a second submission to the conversation's pi conversation, and stops never withdraw a submission, so a steer still queued when its run ends would be placed ahead of the next run's own input (pi-durable's `submissions.js`, `inbox.js`). Admission and the start's wait assume each run submits once to an idle session (ARCHITECTURE.md, The harness), so its design must check them again. The same holds for a `write` or any note sent apart from the turn.
- **Reading files without a container** from the Durable Object, for turns that only search or read.
- **Reusing a token for the rest of a turn** instead of one `leaseToken` per call, if measurement on staging shows the calls matter.
- **Skills** proposed from conversations and approved by an admin, through chunk 24's path.
- **The Anthropic system split and 1-hour cache writes**, deferred while no instance runs Anthropic. pi gives every cache breakpoint the same lifetime, so the split is a rewrite in `onPayload` that moves pi's system breakpoint to the end of the text every conversation shares, with a 1-hour lifetime there. pi-ai reports `cacheWrite1h` only for Anthropic, and models.dev has no 1-hour price.
