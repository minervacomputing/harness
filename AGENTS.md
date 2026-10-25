# Agent notes

Operational notes for coding agents working in this repository: Minerva's open harness, the engine that runs agent turns on Cloudflare (`cloudflare/`), and the contract of the internal API between it and Laravel's private app (`contract/`). Self-hosting is not supported. For background, read [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md); for development, testing and deploys in detail, [cloudflare/README.md](cloudflare/README.md). Work in progress is planned in [docs/plans/](docs/plans/): the current plan is [docs/plans/after-the-plan.md](docs/plans/after-the-plan.md), and the decisions it builds on are in [docs/plans/product-and-engine.md](docs/plans/product-and-engine.md).

## Where docs go

Each kind of doc has one home and one lifetime. The code is the source of truth, so a doc says what the code cannot: why it is shaped this way, what was decided against, and what was accepted. Docs describe current behaviour and future plans only, and keep no record of what was built, changed or removed, or when, since git history does.

- `AGENTS.md` (this file): what every session needs, which is the environment, the commands, the settings and the rules. Every session loads it, so keep it short and put detail in the doc it points to.
- [ARCHITECTURE.md](ARCHITECTURE.md): what stays true about the engine and why, its protocols with their decisions, the alternatives they beat and what was accepted unfixed. A change to a protocol updates its section in the same commit.
- [cloudflare/README.md](cloudflare/README.md): how to develop, test and deploy the engine, and the procedures the operator follows by hand.
- `docs/`: one doc per topic that outgrew ARCHITECTURE.md, [connectors.md](docs/connectors.md) and [data-processing.md](docs/data-processing.md).
- `docs/plans/`: the plans, the designs of chunks not yet built, and [contract.md](docs/plans/contract.md), the internal API's design, which stays. Once a chunk is built, move what later chunks inherit into their sections of the plan and what stays true into ARCHITECTURE.md or cloudflare/README.md. Then delete the chunk's design and its section of the plan. Git history keeps it, and `git log --diff-filter=D --name-only -- docs/plans/` lists the deleted designs.
- Laravel's designs are in the app's `docs/architecture/`, one doc per built feature.

A lesson learned while building goes where the next agent meets it. One about how the code must behave becomes a test where it can. Any other goes into the doc that owns its topic, or into this file when every session needs it. There is no file of learnings.

Code never cites a file in `docs/plans/`, because a design goes away. A comment gives its reason itself or cites ARCHITECTURE.md.

## Environment

Prerequisites: Node 24 and pnpm 10 (`pnpm install` at the root installs the whole workspace); Docker only to run the sandbox locally; the `cf` CLI, signed in, only for anything on the account.

Settings are text bindings, parsed by `cloudflare/src/config.ts` when the Worker is built (`cloudflare/cloudflare.config.ts`); secrets are Worker secrets. Where they come from depends on the build:

| Build | Settings | Secrets |
|---|---|---|
| Local dev server (`pnpm dev:offline`) | Defaults for localhost, overridden by the shell's `MINERVA_*` | `cloudflare/.dev.vars`, made on first start (`pnpm secrets:offline`) |
| Platform tests | The shell, else throwaway values in `vitest.platform.config.ts` | `cloudflare/.dev.vars` where it exists, else the same throwaway values |
| A deployed instance | Its `vars.env` only, never the shell | Its `secrets.env`, uploaded by the deploy |

An instance's files live outside the checkout, in `~/.config/minerva/instances/<name>/` (cloudflare/README.md, The instance directory). Ours are `minerva-cf` (production), `minerva-cf-staging` (the engine Laravel's staging calls, built as production is) and `minerva-cf-test` (the test instance, built with fault points); CI's `minerva-cf-ci` keeps its directory only in GitHub's secrets. `.dev.vars`, `secrets.env` and every `.env*` file hold secrets: never print, commit or copy their values. To check a value, report only whether it is set.

**Secrets:** `MINERVA_SECRET_KEY`, `MINERVA_LARAVEL_TOKEN` (optional: the Sanctum token Laravel issues for this engine, declared once set) and `MINERVA_STREAM_KEYS` (optional: the keys of the stream tokens Laravel signs, `id:secret` entries with secrets of 32 bytes or more in URL-safe base64, shared with Laravel; declared once set, and Laravel's run stream `/stream/v1` is off without them). `pnpm secrets --instance <name>` adds `MINERVA_SECRET_KEY` when it is missing, keeps what is set and never prints a value; it also lists `MINERVA_MODEL_API_KEY` and `MINERVA_BRAVE_SEARCH_API_KEY` commented out, which no build declares yet. The engine holds no OAuth client: Laravel registers the connectors' clients.

**Settings** (defaults in `cloudflare/scripts/build-settings.ts`):

| Variable | Default | Notes |
|---|---|---|
| `MINERVA_DEBUG` | `false` (`true` offline) | Where local workerd has no jurisdictions, an EU object is named `eu:<name>` instead (`src/addressing.ts`). A deployed build refuses it |
| `MINERVA_MODEL_PROVIDER` | `workers-ai` (`fake` offline) | `workers-ai`, `openai`, `anthropic`; `fake` only in the test build's entry |
| `MINERVA_MODEL_NAME` | `@cf/zai-org/glm-5.3-flash` | |
| `MINERVA_MODEL_API` | `chat` | `responses` for upstreams that have it |
| `MINERVA_MODEL_MAX_OUTPUT_TOKENS` | `8192` | |
| `MINERVA_MODEL_REASONING_EFFORT`, `MINERVA_MODEL_REASONING_SUMMARY` | empty | |
| `MINERVA_RUN_TIMEOUT_SECONDS` | empty (none) | A deadline per turn |
| `MINERVA_FILES_*` | 256 MB and 10,000 entries per folder, a run's uploads four times the folder, 50 MB per file, 10 per message | A conversation's folder, also the size of the sandbox's `/workspace` |
| `MINERVA_ENVIRONMENT`, `MINERVA_ACCESS_ISSUER`, `MINERVA_ACCESS_AUDIENCE`, `MINERVA_ACCESS_CLIENTS` | empty (the internal API is off; the test build turns it on with a fake Laravel) | All four or none: the environment Laravel's commands must name, and the Access application (`https://<team>.cloudflareaccess.com`, its audience tag, the service tokens' client ids, comma separated) whose assertion `/internal/` checks. Account identifiers: only in an instance's `vars.env` |
| `MINERVA_LARAVEL_URL` | empty | Laravel's origin, https when deployed, for the engine's requests and facts, and the only origin CORS lets read `/stream/v1` |
| `MINERVA_GITHUB_APP_SLUG` | empty | The GitHub App's URL name (`github.com/apps/<slug>`): lowercase letters, digits and hyphens. A GitHub connection links to installing the App on more repositories; no link while it is empty |

`MINERVA_MODEL_GATEWAY` is not a setting: every build sets it to the instance's name. Nor is `MINERVA_MODEL_PRICES`: the deploy reads the route's prices from models.dev (`cloudflare/scripts/model-prices.ts`) and refuses to deploy without them; the fake model's are in the test build's code.

## Starting the app

No Cloudflare account is needed:

```sh
pnpm --dir cloudflare dev:offline   # the Worker on http://127.0.0.1:8787: the fake model, local D1 and R2, the sandbox if Docker runs
```

It runs the test build's entry, so the fake Notes connector and the token-gated driver at `/api/faults/` are there; the internal API answers only when the shell sets its four settings. Local state is in `cloudflare/.cloudflare/state`. In the desktop app, `.claude/launch.json` has it as `cf-offline`.

**Port in use:** if the Worker cannot bind its port, another copy is running. Stop it rather than starting a second one.

## Git

This project does not use pull requests. Commit directly to `main` (or merge a short-lived branch into it) and push `main`.

`main` is the engine. A push to `main` that changes the engine (`cloudflare/`, `contract/`, `.github/workflows/`, `package.json`, `pnpm-lock.yaml` or `pnpm-workspace.yaml`) runs `.github/workflows/main.yml`: the contract's types and OpenAPI documents, the engine's types and unit tests (job `check`) and its platform tests (job `platform`). The account suites against the CI-only test instance `minerva-cf-ci` run in `.github/workflows/account.yml`, nightly when the engine changed that day and by hand (`gh workflow run account.yml`), not on every push (cloudflare/README.md, CI's test instance). Production and staging deploy only from a commit whose engine has green runs of `main.yml` and `account.yml`, which `pnpm run deploy` checks itself (`cloudflare/scripts/ci-gate.ts`), so a commit outside the engine's paths, such as one to `docs/` or `AGENTS.md`, needs no new run. `minerva-cf-test` is the test instance that `pnpm check` and the account suites deploy. When the workflow fails, read which job and step failed. Its logs are public: never add a step that prints a secret, an account identifier or an origin.

The public demo is shut down, and the website asks for early access instead. The `demo` branch keeps the demo's copy of the Django stack. Never merge `main` into `demo`, and do not deploy it.

**This repository is public** (`github.com/minervacomputing/harness`). Everything you commit is published, history included. Never commit:

- secrets (they belong in an instance's directory, `cloudflare/.dev.vars`, or `.env*` files, all outside the repository or gitignored);
- personal data: real people's email addresses, phone numbers, or names other than the author credit in the README;
- server details: IP addresses, provider hostnames, SSH users;
- account identifiers: cloud project IDs, OAuth client IDs, Stripe account IDs, Apple team and key IDs, Cloudflare account, zone and tunnel IDs, workers.dev subdomains, and the test instance's origins.

Use reserved `.example` domains and placeholders in docs, tests and seed data. Notes for the operator that need real identifiers, such as prompts for browser agents, stay outside the repository (or in `deploy/demo/private/`, which stays gitignored). Check the staged diff for these before every commit.

## Cloudflare

Use Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/) (npm package `cf`, a dev dependency of `cloudflare/`), not Wrangler. Find commands with `cf cli search "<task>"` and preview API changes with `--dry-run`. A destructive command without `--force` in a non-interactive shell prints `Aborted.` and still exits 0, so read the output or check the resource.

- The engine's own scripts (`pnpm run deploy`, `deploy:test`, `scripts/reset.ts`, the account suites) pin the instance's account and check its identity before they change anything; use them rather than `cf` by hand.
- The test instance (`pnpm run deploy:test`, `pnpm test:faults`) is for the account suites a change needs (cloudflare/README.md, The test Worker).
- **Ask first** before deploying or resetting production or staging (staging holds Laravel's staging conversations and is never reset), creating or deleting resources on the account, and any change to tunnels, Access policies or DNS.

## Second opinions with opencode

Use opencode as a read-only subagent for code review, adversarial review, or critiques of plans. Always use the `plan` agent (it does not edit files) with `--auto` (no permission prompts):

```sh
git diff | opencode run --agent plan --auto "Adversarially review this diff for bugs and security issues."
opencode run --agent plan --auto -f plan.md "Critique this plan: what is wrong, risky, or missing?"
```

- Input can be piped on stdin or attached with `-f`.
- Add `-c` to ask a follow-up in the same session.
- Its output is advice. Verify each finding before acting on it, and fix only those that can happen (below).
- Run `git status` afterwards. The `plan` agent should not change anything, but `--auto` approves any shell command that is not explicitly denied.

## Fix only the review findings that can happen

Reviews report more than is worth fixing. opencode, review subagents, and adversarial or multi-model passes all find races and failures that need improbable timing. Fix a finding only if it can happen in real use. Real use means ordinary traffic, retries, deploys and restarts, a user who clicks twice, and someone who repeats a request to make it happen on purpose. Leave the rest unfixed, and add no test for them. They include:

- a race between two events that must land within milliseconds of each other;
- a crash, a reset or a deploy at one exact instruction;
- a clock, a platform service or a database misbehaving in a way it is not known to;
- two or more unlikely failures at once.

A fix for one of these adds code to read, a test to keep and another review to pass, and no user notices it. Record each finding you leave under "Accepted, not fixed" in the design or plan you work from, in one line that says why it is unlikely and what happens if it occurs. A reviewer still reports such a finding, marked improbable, so that it is recorded. Wrong docs and a flaky test that has actually failed are still fixed.

For example, a review found that the start's bound can reset a run that has just submitted. That needs an orphan to end within milliseconds of the 30 s bound and an alarm to run inside one storage sync, and the run still completes in its next attempt. It is recorded under "Accepted, not fixed" in ARCHITECTURE.md, The harness.

## Checks

In `cloudflare/`:

```sh
pnpm check           # what a unit of work runs before its commit (cloudflare/README.md, Checks)
pnpm typecheck       # cf's generated types, then tsc for the Worker and the Node scripts
pnpm test:unit       # Vitest in Node: lib/, the executor, policy, connectors, the objects' logic, rules on the sources
pnpm test:platform   # the Worker in local workerd: Durable Objects, D1, R2, the internal API, the protocols' fault tests
pnpm test:docker     # the Sandbox against the real image (needs Docker and `pnpm sandbox:image`)
pnpm startup         # the Worker's startup CPU, which Cloudflare limits
```

`pnpm check --instance minerva-cf-test` runs what the workflow runs, `pnpm typecheck` and `pnpm openapi:check` in `contract/` included, then deploys the test build and runs the account test files the unit changed. The suites on the account (`test:deployed`, `test:faults`, `test:cm`) and which ones a change needs are in cloudflare/README.md; CI runs all but `test:cm` on its own instance nightly and on demand, and the full suites run there once per chunk, for its regression box and before a deploy (docs/plans/after-the-plan.md, How to read this).

## TypeScript and the contract

`contract/` and `cloudflare/` typecheck with TypeScript 7 (`tsc` is the native compiler). It has no stable compiler API (7.0 ships only `typescript/unstable/*`): the one test that parses TypeScript (`cloudflare/test/unit/sources.test.ts`) imports TypeScript 6's API from `@typescript/typescript6`. Editors need TypeScript 7's language server (VS Code: the `TypeScriptTeam.native-preview` extension) or their own bundled TypeScript.

The internal API between Laravel and the engine is `contract/src/internal/` ([docs/plans/contract.md](docs/plans/contract.md)), declared once with oRPC (method, path, input, output and errors) and implemented by the Worker in `cloudflare/src/internal/`, so a change to a command changes the contract and its procedure in one commit. It also regenerates the OpenAPI documents (`pnpm --dir contract openapi`, committed; CI fails when they are stale), which Laravel keeps copies of. Laravel and the engine deploy apart, so `v1` changes only additively, and a new kind of fact or a newly required input is deployed to the receiving side first.
