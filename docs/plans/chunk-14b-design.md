# Chunk 14b design: give each run a budget

Status is accepted, as of 2026-10-16: the owner answered the owner questions (Owner questions, below), and chose that model prices are read from models.dev at deploy (The price table). It settles the choices that chunk 14b of [remaining-chunks.md](remaining-chunks.md) leaves open, with the rule the owner chose on 2026-10-16, splits the work into units one fresh agent each can finish, and lists what waits for the owner. Line numbers are at `0c7ffd7` (harness) and `858f785` (`minervacomputing/app`, "the app" below). Units 1 to 3 are implemented; the perf rule could not be judged on the probe (As built (unit 3)).

## The owner's choice: stop when spent

The plan asked for a reservation per call that is a true upper bound, so that a budget is a hard limit. The owner chose otherwise (2026-10-16), and asked to keep 14b simple: **no reservation per call and no per-call bound.** Before each model call, at the call record (14a's admission point), the engine compares what the run has spent so far with its allowance: its settled calls priced from the price table, plus its container and script time so far. If the allowance is used up, the call is refused and the run ends with "This conversation reached its budget." Laravel refuses a start when the organization's settled spend has reached its limit, and passes what is left as the run's allowance.

**What this does not promise.** A budget is not a hard limit. A run can pass its allowance by what is in flight when it crosses it: one model call and the tool calls that call started, and its container's time until the run's end destroys it; and a run whose last call crosses it completes over budget, since no check follows (Overspend, below). An organization can pass its limit by what every run it started before the earlier ones settled can spend (Laravel, The overshoot). The design says so wherever it matters, and the plan's boxes are reworded to match (Changes to remaining-chunks.md).

Rejected for the per-call rule, recorded in Appendix B of remaining-chunks.md:

- A bound from the request's UTF-8 bytes (the plan's recommendation): rejected by the owner.
- The window's worst case per call: a true bound, but about $0.16 a call on production's model (a 1,048,576-token window) and about $2 on staging's, which leaves small allowances useless.
- Counting tokens exactly with the route's tokenizer before each call: only possible where the tokenizer and the server's template are published (Workers AI's GLM), and a provider-side count is a round trip per call.

## What the code does today

| Claim | What the code does |
|---|---|
| The record is the admission point | `host.record` runs before `send` (`model/provider.ts:308`) and calls `recordModelCall` (`conversation/store.ts:648`), which checks the fence, inserts the record and counts the call in one synchronous change through `outside`; chunk-14a-design.md (Decisions) names it as 14b's admission point. Admission adds a check to that change and needs no new round trip. |
| The routes | One per instance, from settings (`model/route.ts:34`); `agent.model` in `StartRun` is only an alias. Production runs the default, Workers AI `@cf/zai-org/glm-5.3-flash` (`scripts/build-settings.ts:15`); staging runs OpenAI `gpt-6.1-sol` over Responses with reasoning effort `medium` (its `vars.env`); `fake` exists only in the test build. Every record names its route (`provider`, `model`). |
| What the catalog publishes | Connectors only (`contract/src/internal/catalog.ts`, `Catalog`). |
| A call settles once, in tokens | `settleModelCall` (`store.ts:680`) writes the reported tokens, a refusal (a 4xx) at zero, or an unmetered call at `reserved_input` and `reserved_output` (`settledTokens`, `:180`): `CONTEXT_WINDOW` (128,000) and the call's cap (`model/policy.ts:20`). The restart rule settles another instance's open records as `lost` (`settleLost`, `:736`). No money anywhere. |
| Scripts | `recordScript` (`store.ts:711`) records `started_at` and `timeout_ms`; `endScript` (`:727`) sets `ended_at`. An index by run exists (`conversation/schema.ts:259`). Each script is a fresh Dynamic Worker (`loader.load`, `scripts/scripts.ts:134`). |
| Container time is known only at the end | The Sandbox keeps spans and answers them to `seal` after the run (`conversation.ts:737`); `containerCharge` (`sandbox/store.ts:207`) charges each to the earlier of its end and its lease plus `HARD_GRACE_MS` (10 minutes). During a run the Conversation knows only when it prepared a container (`LocalRun.#prepare`, `conversation/local-run.ts:107`). |
| A run ends with a code and a message | `RunEnd` (`conversation/events.ts:38`) has `status`, `code` and `message`. `run.finished` carries `status` and `error` (the message), not the code (`contract/src/internal/facts.ts:187`). `folder_limit` (`conversation.ts:1062`) is the precedent for a failure with its own message, ended in the same change that found it. |
| The chat shows a run's error | `Transcript` shows `run.finished`'s `error` (`app/Conversations/Transcript.php:184`), and a refused start's message (`:107`). |
| `Runs::start` reads the organization | It locks the user (shared) and the workspace (`app/Runs/Runs.php:87`, `:88`) and only reads the organization (`:89`). |
| Settlements are stored once, by organization | `run_settlements` is keyed by run, indexed `(organization_id, at)`, and never cascaded (`database/migrations/2026_10_19_100000_create_usage_tables.php:59`, `:81`); `Facts::account` inserts each row once (`app/Runs/Facts.php:251`). |
| Laravel ignores unknown fields | `ContractRequest` ignores an unknown field (`app/Http/Middleware/ContractRequest.php:17`). A new optional field can be written before Laravel reads it; a new fact type cannot. |

## Decisions

### The price table

**The model's prices come from models.dev at deploy (owner, 2026-10-16); the rest is in code.** Money is integer micro-dollars (µ$). Token rates are µ$ per million tokens, time rates µ$ per hour.

```ts
type RoutePrices = { provider: string; model: string; input: number; cachedInput: number; cacheWrite: number; output: number; above?: { inputTokens: number; input: number; cachedInput: number; cacheWrite: number; output: number } };
type PriceTable = { routes: RoutePrices[]; container: { instance: "standard-1"; perHour: number }; script: { perScript: number; perHour: number } };
```

- **The route's prices.** The deploy (`scripts/`, beside `buildSettings`) fetches `https://models.dev/api.json` and reads the configured model under its provider (`workers-ai` is models.dev's `cloudflare-workers-ai`, `openai` is `openai`, `anthropic` is `anthropic`): `cost.input`, `cost.cache_read`, `cost.cache_write` and `cost.output` in dollars per million tokens, and a `tiers` entry of type `context` as `above` (the rates when a call's input passes `size` tokens). A missing `cache_read` or `cache_write` is charged at `input`. The deploy prints the prices it read and refuses to deploy when models.dev cannot be read or the model has no `cost`. The build receives them as a text binding the deploy sets, as it sets `MINERVA_MODEL_GATEWAY`, and `config.ts` parses them; it is not a setting an instance's `vars.env` holds. One source and one code path for every provider; models.dev is MIT-licensed. On 2026-10-16 its values matched Cloudflare's model list for `glm-5.3-flash` and OpenAI's pricing page for `gpt-6.1-sol` exactly.
- **Container and script time** stay in code, `cloudflare/src/budget/prices.ts`, from Cloudflare's pricing pages, since no catalog lists them.

The values are list prices without included allowances, as the owner chose for 14a's cost per turn:

| Item | Price | Source |
|---|---|---|
| Workers AI `glm-5.3-flash` (production) | input $0.15, cached input $0.03, output $0.50 per million tokens; no cache-write rate (charged at input) | models.dev, read 2026-10-16; equal to Cloudflare's model list |
| OpenAI `gpt-6.1-sol` (staging) | input $2.00, cached input $0.10, cache write $2.50, output $10.00 per million; above 272,000 input tokens $4.00, $0.20, $5.00, $15.00 | models.dev, read 2026-10-16; equal to OpenAI's pricing page (standard tier) |
| Container `standard-1` | 74,016 µ$ an hour: ½ vCPU at $0.000020 per vCPU-second (billed on active use, so this is its ceiling), 4 GiB at $0.0000025 per GiB-second, 8 GB at $0.00000007 per GB-second | Cloudflare's Containers pricing |
| Script | 2,000 µ$ a script (a Dynamic Worker is $0.002 per unique Worker a day, and each `load` is unique) and 72,000 µ$ an hour of wall time ($0.02 per million CPU-ms, which wall time bounds) | Cloudflare's Dynamic Workers pricing |
| `fake` (test build only) | 1 µ$ per token in and out, 3,600,000 µ$ an hour for each kind of time | In code, for readable tests; the test build adds it beside the configured route |

**Rules.**

- **Rounding.** Each charge is rounded up once, when it is made, and never again: a call's `ceil((uncached × input + cacheReads × cachedInput + cacheWrites × cacheWrite + output × output) / 1e6)`, with uncached input the reported input less cache reads and writes, and reasoning inside output; a script's `ceil((perScript × 3.6e6 + ms × perHour) / 3.6e6)`; the run's container time once, at `run.settled`. Totals are sums of these. Rounding each category of a call apart would make its charge depend on how a report is split.
- **Every call is priced.** A deployed build refuses to start without its route's prices, as it refuses `MINERVA_DEBUG` (`config.ts`). Each call record keeps the rates and the version it was admitted under, and its settlement charges from those, so a deploy that changes the model or its prices mid-run never leaves a call without a price.
- **Versions.** The table's version is 16 hex of SHA-256 over its canonical JSON, as the catalog's is. A charge is computed when its call or script settles, or, for container time, when the run does, with the table the build has then, and is never recomputed. Each call's fact names its version (`prices`), a script record keeps its own, and `run.settled`'s `prices` is the version that priced its container time. A deploy that changes prices mid-run charges the run's later settlements at the new prices; Laravel stores the amounts, so a later change rewrites nothing.
- **Published.** The catalog gains an optional `prices: {version, table}`, beside its connectors; the catalog's version stays the hash of its connectors alone. Laravel's client drops what it does not map (`app/Engine/EngineClient.php:72`), and in 14b it reads no prices; chunk 16 does when it shows them.

### What a call and a run are charged

- **A reported call:** its tokens at its route's rates (`costMicros`).
- **A refused call (a 4xx):** zero.
- **An unmetered call** (`no_usage`, `stopped`, `failed`, `lost`): the tokens 14a already records for it (`reserved_input`, `reserved_output`) at its route's rates, with no new machinery. On production that is 128,000 input and 8,192 output tokens, 23,296 µ$; the call's real cost is unknown, so this is a charge by rule, as 14a's estimate is.
- **Script time:** `perScript` per script plus its wall time (`ended_at − started_at`, as 14a measures it, from before the script's clock starts to after it answers) at `perHour`.
- **Container time:** 14a's `containerMs` at `perHour`.
- **The run:** `chargedMicros = modelMicros + containerMicros + scriptMicros`, on `run.settled`.

These are Minerva's charging rules, not the providers' invoices: 14a's container and script times are observed lifecycle durations.

### Admission at the call record

**The run's state.** Conversation migration 12 adds to `runs`: `allowance INTEGER` (µ$, NULL when Laravel sent none: such a run is never refused for its budget), `spent INTEGER NOT NULL DEFAULT 0` (settled calls and ended scripts, in µ$) and `container_since INTEGER`; `call_records` and `script_records` gain `cost_micros` and `prices`. `insertRun` stores the allowance from `StartRun`. Records settled before migration 12 have no cost; their runs have no allowance and no money on `run.settled`.

**Spent so far,** read in the admission's change with the run's row that `isCurrent` already reads:

```
spent + Σ open scripts of the run (perScript + (now − started_at) at perHour) + (now − container_since) at the container's perHour
```

- `spent` grows in the changes that settle a call (`settleModelCall`, the restart rule's `lost` included) and end a script (`endScript`, the restart rule's end included). A unit test checks it equals the sum of the run's `cost_micros`, as 14a's test does for its token sums.
- `container_since` is set, if still null, when `LocalRun` asks the Sandbox to start a container (`#prepare`), before `prepareSandbox`. Counting from then to now overcounts: a container's span starts a little later, and a container that died unnoticed is still counted. Overcounting only stops a run sooner. At `run.settled` the spans replace it.
- An open call of the run is not counted: pi makes one model call at a time, and the summary retry is the same record.

**The check.** In `recordModelCall`'s change, after the fence check: if `allowance` is not null and spent so far is at least `allowance`, the run ends with `BUDGET_REACHED` in the same change (as `folder_limit` ends a run), nothing is recorded or counted, and the wrapper ends the call with `RUN_ENDED_TEXT`; the end aborts pi and destroys the container as every end does (`#afterFinish`). Compaction's calls are checked like any other. No other point checks the allowance: scripts, local calls and connector calls are not refused for the budget, and the next model call after them is.

**Overspend.** A run's `chargedMicros` can pass its allowance by:

- the model call in flight when spent crossed the allowance, at its reported cost (at most the model's window and the call's cap; an unmetered one at its 23,296 µ$ on production);
- the tool calls that call asked for, which run before the next check: scripts (each about 4,400 µ$, 2,000 µ$ plus its 120 s clock, a little more for the time before its clock starts and after it answers), local calls and connector calls;
- container time from the last check to the container's destroy at the run's end, and, if a destroy keeps failing, up to its lease plus `HARD_GRACE_MS`, 14a's charging cutoff: a run without a deadline has a lease of an hour past the container's last use, so up to about 70 minutes, 86,000 µ$, past that use;
- everything after the check, when the call that crossed the allowance is the run's last: the run completes over budget, since no check follows.

### The terminal reason

`BUDGET_REACHED: RunEnd = {status: "failed", code: "budget_reached", message: "This conversation reached its budget."}` in `conversation/events.ts`. `run.finished` gains an optional `code`, the run's end code (empty when it completed), which Laravel stores in a new `runs.error_code`, for chunk 16 to link to billing. The chat shows the message with no change, as it shows `folder_limit`'s.

### The contract (all additive)

| Where | Change |
|---|---|
| `StartRun` | Optional `allowance`: an integer of µ$, at least 0 |
| `Catalog` | Optional `prices: {version, table}` |
| `run.usage`, `run.unmetered` | Optional `costMicros` and `prices` |
| `run.settled` | Optional `prices`, `modelMicros`, `containerMicros`, `scriptMicros` and `chargedMicros` |
| `run.finished` | Optional `code` |

No new fact type and no new required input, and Laravel ignores the new fields until it reads them, so **the engine deploys first**: the contract and the engine to `minerva-cf-staging`, then the app, whose deploy starts sending `allowance` and so turns budgets on; production in the same order. A start without `allowance` runs as today. Once the app sends allowances, the engine must not be rolled back to a build without them (Risks).

### Laravel

**The limit.** `organizations.budget_micros`, nullable; null means the default from config (`minerva.budget.limit_micros`, from `MINERVA_BUDGET_LIMIT_MICROS`). `php artisan minerva:budget {organization} {--limit=}` sets it until chunk 16. It has no period: billing brings periods.

**Spend is added from `run.settled`.** `run_settlements` gains `charged_micros` (nullable) and `prices`; `usage_records` gains `cost_micros` and `prices`. The organization's spend is `SUM(run_settlements.charged_micros)` over its rows, which the `(organization_id, at)` index covers. No counter, no release: a settlement row is inserted once (`Facts::account`), live, soft-deleted or gone alike, so spend counts every settled run once and cannot leak. A run the engine never accepted has no settlement and spent nothing.

The engine deploys first, so the app's staging and production acknowledge money-bearing facts before they have the columns: those facts are applied and their money dropped. Each accounting row keeps its fact's canonical text (`fact`), so the app's migration fills `charged_micros`, `cost_micros` and `prices` from it, and so does `php artisan minerva:usage --backfill`, idempotently, for facts applied between the migration and the code that reads them. Rows whose fact has no money (runs settled before the engine's deploy) stay null and count as nothing: they ran with no allowance.

A settlement without `chargedMicros` for a run Laravel gave an allowance can come only from an engine rolled back to a build without budgets. It is stored with `charged_micros` equal to the run's `allowance_micros` while the run row exists, so it fails closed. When the run is gone (its conversation's rows deleted), it is stored null, logged as an error, and `minerva:usage` exits non-zero, so the operator settles it by hand.

**The start.** In `Runs::start`'s transaction, before `register`: read the organization's spend and limit. If spend is at least the limit, throw `ValidationException` with "Your organization has used its budget.", which the composer shows as it shows "Wait for the agent to finish.", and nothing is registered. Otherwise the run's allowance is `limit − spend`, put in the start body as `allowance` and kept on the run (`runs.allowance_micros`).

**No new lock.** A lock that only starts take would order two starts but bound nothing more under this rule: spend changes only when a run settles, so a start that waited for another reads the same spend and gets the same allowance. A settlement that commits between a start's read of spend and its commit makes the start act as if it came first, which is a start the rule allows. A lock that starts and settlements both took would only order those two, and would put the budget row into the facts' transaction, under the conversation's lock. So `Runs::start` takes no new lock, `turn.md`'s lock order does not change, and a settlement only inserts its row as today.

**The overshoot.** What lets an organization pass its limit is runs given what was left before the spend of earlier runs settled. That is not only runs going at once: `run.finished` lets a conversation's next turn start, and `run.settled` follows seconds or minutes later (more while the Sandbox's seal waits, chunk-14a-design.md, Live checks), so successive turns of one conversation can each be given the same remainder. The organization's spend can pass its limit by what every run started before the earlier runs' settlement can spend: each its allowance plus its own overspend. What bounds how many there are is the start rate (the gate's rate limit on starts, remaining-chunks.md, The gate) times how long settlements lag; while facts cannot be delivered, the engine refuses starts once 10,000 are unacknowledged.

If the owner wants an organization's limit nearer a hard one later, the next step is to give a new run what is left after the allowances of the organization's runs still going. That is a reservation, and it needs the lock this design leaves out.

## What 14c and 14d inherit

- No organization lock from 14b, and an organization limit that is not hard (Laravel, The overshoot). 14d's "under the organization's lock from 14b" (remaining-chunks.md, chunk 14d) has no lock to join: if 14d reserves an upload's bytes against the organization's storage, it adds its own row and its place in `turn.md`'s lock order.
- `runs.allowance`, `spent` and the ending of a run with its own code inside the admission's change, for 14d's byte allowance.
- The price table in the catalog, for chunk 16's prices and for showing costs.
- Spend as the sum of `run_settlements.charged_micros`, for 16's meters.

## Units

One fresh agent each, in this order. A unit is done when its checks pass, opencode has reviewed its diff when it is large or risky, and it is committed to `main` of its repository. Engine checks: `pnpm typecheck`, `pnpm test:unit` and `pnpm test:platform` in `cloudflare/`, and `pnpm typecheck` and `pnpm openapi:check` in `contract/` when it changes. App checks: `composer test`, `pnpm run check`, `pnpm run types:check`, `pnpm test`.

1. **Contract (harness).** The fields of the contract table; `pnpm --dir contract openapi`; `docs/plans/contract.md`'s fact list. The engine writes none of them yet.
2. **Prices and charges (harness).** The deploy's read of models.dev and the binding it sets (a unit test parses a saved excerpt of `api.json`, including a `context` tier and a model without `cache_write`; no test reaches the network); `src/budget/prices.ts` (container and script time, the table's version, the build's refusal, the catalog's `prices`); the rates and version on each call record; migration 12 whole; `cost_micros`, `prices` and `spent` written with each call's settlement and each script's end; `costMicros` and `prices` on `run.usage` and `run.unmetered`; the money fields of `run.settled`. Unit tests: rounding once per charge (two 1 ms scripts are charged 2 × 2,001 µ$), a reported, refused and unmetered call each charged by rule, a priceless route refused at build, `spent` equal to the records' sums after every change, a run with calls under two price versions. Platform test: `run.settled`'s `chargedMicros` equals its calls', scripts' and container's charges.
3. **Admission and the budget's end (harness).** `allowance` from `StartRun`; `container_since`; the check in `recordModelCall`; `BUDGET_REACHED` and `run.finished`'s `code`. Unit tests: admission under, at and over the allowance; a refused admission ends the run once and records nothing; open scripts (with `perScript`) and `container_since` counted; no allowance admits everything. Platform test: a run with a small allowance on the fake route, whose script asks for several calls, ends `failed`, `budget_reached`, with the message, at the first call after spent reached it; another whose crossing call is its last completes, over budget. A case in `test/account/faults.test.ts` doing the first on `minerva-cf-test`; the fake Laravel sends a large allowance with every other start; `pnpm run deploy:test`, `pnpm test:faults`; the perf runs below.
4. **Budgets (app).** `composer contract:sync`; one migration (`organizations.budget_micros`, `runs.allowance_micros`, `runs.error_code`, `cost_micros` and `prices` on `usage_records`, `charged_micros` and `prices` on `run_settlements`); `minerva:budget`; the check and the allowance in `Runs::start`; the new columns from facts, with the fail-closed rule; the backfill from each row's `fact`, in the migration and as `minerva:usage --backfill`; `minerva:usage` also checks each run's `chargedMicros` against its calls' `costMicros` plus its container and script charges; `turn.md` (Tables, a Budgets section). Pest tests: a start at or over the limit is refused with its message and registers nothing; a start under it sends `limit − spend`; spend counts a settlement once, also for a soft-deleted and a gone conversation; a settlement without `chargedMicros` counts at the allowance; two starts in different workspaces of one organization, run concurrently against Postgres in separate processes with committed fixtures, are both admitted with the same allowance (the documented overshoot), and a third after both settled past the limit is refused; a settlement committed between a start's read of spend and its commit leaves the start registered with the earlier remainder; the backfill fills a row applied without money from its `fact`.
5. **Docs (harness).** ARCHITECTURE.md (Model: admission; Facts: the money fields), credentials-and-facts.md, remaining-chunks.md's 14b boxes with their evidence.

Units 1 to 3 deploy to `minerva-cf-staging` before unit 4 reaches the app's staging. Nothing changes on staging until the app sends `allowance`.

## Live checks

| Check | Where | Who |
|---|---|---|
| `test:faults` with a large allowance, and the small-allowance case | `minerva-cf-test` | The agent |
| The perf runs | `minerva-cf-test` | The agent |
| Deploy the engine to `minerva-cf-staging` | The account | The agent, after asking the owner (AGENTS.md asks first for staging) |
| Push the app; CI deploys its staging | The app's staging | The agent |
| `minerva:budget` sets an organization's limit just above its spend, so the allowance is below one turn's cost; a `minerva:turn` with a script stops with "This conversation reached its budget."; after its `run.settled`, the organization's spend grew by the run's `chargedMicros`, and the next start is refused with its message | The app's staging | The agent, once the owner says go; it spends cents of OpenAI and container time |
| Production: the engine, then the app | The account, Laravel Cloud | The owner |

## Perf probe and rule

**Metric.** The admission check's added time per model call (remaining-chunks.md, chunk 14b): a read of the run's row it already reads, a sum over the run's open scripts by an index, a comparison, and nothing written unless the run ends. No round trip and no second durable write.

**How it is measured.** 14a's probe (M2, `host.begin` to the request's first answer) on `minerva-cf-test`, unit 3's parent commit and unit 3 interleaved twice, each a fresh deploy, with a large allowance so every call is checked and none refused; the probe reports p95 beside the median. **Rule:** head's p95 minus the baseline's under 5 ms in both pairs. 14a found the probe's runs of the same code to differ by up to 13 ms at the median, so if a pair's baselines differ by more than 5 ms at p95, the agent stops and asks the owner (owner question 4) rather than calling it a pass.

**As built (unit 3).** Admission is in `recordModelCall`'s change, after the fence check, as designed, with one addition from opencode's review of the diff: a run with an allowance first settles what a gone instance left open (`settleLost`, the restart rule), since an attempt pi resumes can reach its first call before the object's recovery has charged the previous instance's lost call. `container_since` is set through `outside` before `LocalRun.#prepare` asks for a container. `test:faults` passed on `minerva-cf-test` (34 tests, the small-allowance case among them), with the driver giving every other start an allowance of 10^12 µ$.

The perf runs, 2026-10-16, each on a fresh `pnpm run deploy:test` of `minerva-cf-test`, baseline `ce1449e` (unit 2) and head (unit 3), every turn of the head's probe given 10^12 µ$; M2 over 100 samples each:

| Run | Median (ms) | p95 (ms) |
|---|---|---|
| Baseline 1 | 37 | 113.05 |
| Head 1 | 51 | 148 |
| Baseline 2 | 45 | 134 |
| Head 2 | 50 | 136 |

Head minus baseline at p95 is +34.95 ms in the first pair and +2 ms in the second; the two baselines of the same code differ by 20.95 ms at p95, more than 5 ms, so by the rule the probe cannot judge the check, and the runs are reported to the owner rather than called a pass. Each turn's second call (the first measured) is the slow one in every run, its median 108 to 143 ms against 37 to 53 ms for calls 3 to 6: it runs while the attempt's container is being prepared, so the p95 of 100 samples, of which 20 are such calls, measures that overlap rather than the calls. Over calls 3 to 6 alone, p95 is 47.2, 56.05, 53.65 and 55.1 ms. As owner question 4 allows when the probe is too noisy, a benchmark in Node (node:sqlite, the store's own code, 3,600 calls each after a warm-up) timed `recordModelCall` at a median of 25.6 µs and a p95 of 35.7 µs for a run without an allowance, and 35.7 µs and 43.8 µs with one: the check adds about 10 µs a call. The samples are kept outside the repository.

**The rule is met by the measure the owner accepted for this case** (Owner questions, 4: when the probe's baselines are too noisy to resolve 5 ms, a benchmark of the check's change in Node). `recordModelCall` over node:sqlite, 3,600 calls after a warm-up: median 25.6 µs and p95 35.7 µs without an allowance, 35.7 µs and 43.8 µs with one. The check adds about 10 µs a call at the median and 8 µs at p95, under the 5 ms rule by more than two orders of magnitude.

## Risks

- **A budget is not a hard limit** (Overspend). The overspend per run is bounded by what is in flight; per organization, by the runs going at once.
- **Engine-first deploys drop money** until the app reads it, which the backfill recovers from the stored facts.
- **Unmetered calls are charged by rule.** 23,296 µ$ on production may be far above or below what the provider billed.
- **A rollback of the engine** to a build without budgets, while the app sends allowances, lets runs spend without a check; their settlements then count at their allowance. Roll back the app first.
- **`container_since` overcounts** a container that died unnoticed, which can stop a run early. The settlement uses the spans.
- **Lifetime limits** block an organization once spent until the operator raises it, by design until chunk 16.
- **Spend is a sum.** It reads every settlement of the organization at each start; at 14b's volumes that is cheap. Chunk 16 can keep a rolled-up total if it is not.

## Owner questions

Answered by the owner on 2026-10-16.

1. **The prices.** List prices with no included allowances. The model's are read from models.dev at deploy for every provider (The price table); container and script time are in code from Cloudflare's pricing pages. The proposal had been a table in code, confirmed by the owner against each provider's page.
2. **The default limit.** Accepted: $5 (5,000,000 µ$) per organization for its lifetime, from config, changed with `minerva:budget`. A run is given everything left.
3. **A cap per run.** Accepted: none (a run gets what is left). The alternative, `min(what is left, a cap)`, stays available if an organization's overshoot matters.
4. **The perf rule's measure.** Accepted: 14a's probe at p95 measures the admission's added time; if the baselines are too noisy to resolve 5 ms, a benchmark of the check's change in Node instead.

## Changes to remaining-chunks.md

This commit rewords chunk 14b's boxes to the owner's rule: the reservation decision is checked with the rule, the Laravel box loses the reservation and the lock, the engine box checks spent instead of reserving, container and script time are counted so far, release becomes spend added from `run.settled`, the Laravel race test expects both starts admitted, the staging check expects spend added instead of a release, and Appendix A and B record the decision and the rejected alternatives. Chunk 14d's mention of 14b's organization lock is left for 14d (What 14c and 14d inherit).

## Amendments after opencode's review

opencode (`plan` agent) reviewed the first draft, which reserved each call at a bound from its request's bytes, on 2026-10-16, before the owner's choice. Each finding was checked in the code. Most were about reservations and fell away with them.

1. **Rounding per category could pass the reservation (accepted).** Its example: 19 uncached and 1 cached input token charged 1 µ$ more than 20 tokens reserved. With no reservations it no longer breaks a bound, but charges must not depend on how a report is split: a call is rounded up once (The price table, Rules).
2. **The GLM template's `tojson` expands nested argument values, and calibration is evidence, not proof (accepted, moot).** Both were against the byte bound, which the owner rejected.
3. **Container windows needed identified grants, the first lease, and every Sandbox step (accepted, moot).** The windows are gone; container time is counted from `container_since`, which can only overcount.
4. **Script time clamped to its clock bounds the charge, not the consumption (accepted).** Script and container charges are stated as Minerva's charging rules (What a call and a run are charged); the clamp is dropped.
5. **Pinning a price table without pinning the route (accepted).** Prices are no longer pinned per run: each call record keeps the rates and version it was admitted under and is charged from them, and every fact names the version.
6. **A settlement without money fails open (accepted).** Laravel counts it at the run's allowance and reports it (Laravel, Spend).
7. **Facts can precede the acceptance, and gone runs had no release path (moot).** Nothing depends on the acceptance's order or releases a reservation now: spend is a sum of settlement rows.
8. **The lock order was not proved globally (moot).** 14b adds no lock.
9. **Asking before deploying staging (accepted).** AGENTS.md asks first before deploying staging; the live checks say so. (14a's amendment 18 read it otherwise.)
10. **The perf rule's substitute needs the owner (accepted).** Owner question 4.
11. **Crash-boundary, upgrade and concurrency tests (partly accepted).** The admission is one change with the fence check, so it adds no crash boundary to 14a's; a run started without `allowance` (as every run before the app's deploy) is never refused, tested in unit 3; `reserved_input` keeps its meaning. The concurrency test is unit 4's.


A second review, of this design after the owner's choice, on 2026-10-16:

12. **An organization's overshoot is not bounded by runs going at once (accepted).** `run.finished` lets the next turn start before `run.settled`, so successive turns can each be given the same remainder. The overshoot is restated by runs started before earlier runs settled (Laravel, The overshoot).
13. **"A lock would bound nothing more" was too broad (accepted).** A lock shared with settlements would order a start against a settlement; without it the start acts as if it came first, which the rule allows. The text says so, and unit 4 tests that interleaving.
14. **Engine-first deploys drop money in the app (accepted).** The app backfills its money columns from each row's stored fact (Laravel, Spend).
15. **The rollback fallback had no allowance for a gone run (accepted).** It is stored null, logged and reported by `minerva:usage` for the operator.
16. **Script rounding conflicted with `spent` (accepted).** Each script is rounded once at its end, and the open-script term includes `perScript`.
17. **The script and container overspend figures were not established (accepted).** A script's recorded time includes time before its clock starts and after it answers; a container's lease is an hour past its last use, not past the last check. Both are restated.
18. **A run's prices can mix versions (accepted).** Call facts and script records keep their own version; `run.settled`'s names the container's.
19. **A crossing last call completes over budget (accepted).** Stated in the owner's rule and Overspend, and unit 3 tests both cases.
20. **The citation that `recordModelCall`'s comment names 14b was wrong (accepted).** It is chunk-14a-design.md that names it.
21. **`test:faults` must pass with a large allowance (accepted).** The fake Laravel sends one with every other start.
22. **Unit 2 used money columns that unit 3 migrated (accepted).** Migration 12 moves whole into unit 2.
23. **The app discards the catalog's prices (accepted, no change).** 14b does not read them; the catalog's version stays the connectors' hash.

## Verification

This document was checked against the code at the commits above, by reading each file and line cited. Cloudflare's model list, models.dev's `api.json`, OpenAI's pricing page and Cloudflare's Containers and Dynamic Workers pricing were read on 2026-10-16.
