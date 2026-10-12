# Minerva on Cloudflare

The experiment of [docs/plans/cloudflare.md](../docs/plans/cloudflare.md): the same product as Workers, Durable Objects, D1 and R2. This directory holds steps 1 (the scaffold), 2 (the core protocols), 3 (the sandbox and files) and 4 (code mode). The frontend stays in `frontend/` and becomes the Worker's static assets.

| Path | What |
|---|---|
| `cloudflare.config.ts` | Worker `minerva-cf` (and, in mode `faults`, the test Worker `minerva-cf-test`): assets, bindings, settings, secrets, the Durable Object classes |
| `files-worker/` | Worker `minerva-cf-files`, the download origin: checks a signed link and streams the object from R2 (`src/files/download.ts`); the routes that issue links are step 5 |
| `migrations/` | D1 `minerva-cf`: accounts and the workspace directory |
| `src/index.ts`, `src/http/` | The router, error shapes, cookies, CSRF, security headers, JSON bodies, `/assets/`, the probe |
| `src/lib/` | JSON (parsing and Python's dumps), Pydantic's strings for zod, Fernet, code point order, text helpers, hashes, ids, the SQL interface every object's logic runs on (`sql.ts`) and its schema steps |
| `src/contracts/` | The interfaces steps 2 to 6 build against (types only) |
| `src/workspace/` | The Workspace Durable Object: connections and credentials with refresh, layers, grants, agents, the run registry, the revocation outbox, uploads, deletion (`core.ts` over `lib/sql.ts`; `workspace.ts` is the object) |
| `src/conversation/` | The Conversation Durable Object: messages, runs, attempts and the gate, events and the stream's WebSocket, history replay, the run's tools, PiHarness, the local tools and their checkpoint barrier (`local.ts`, `local-run.ts`); `ports.ts` wires the Workspace, the executor, the ledger and the model |
| `src/gateway/` | The permission pipeline: policy, grants, the connector contract and registry, run-start tool lists, the executor, provider HTTP, the write ledger and page tokens, strict validation, results |
| `src/model/` | The model wrapper: the pi-ai provider `minerva/default`, request policy, stream tap, routes to Workers AI or AI Gateway, the deterministic fake |
| `src/connectors/` | The connector registry the Workspace and the executor share (the 20 connectors join in step 6) |
| `src/files/` | Folders and versions: manifests, `FolderStore` over the Conversation's SQLite, names and limits, attachments, uploads, signed download links and the download origin's handler |
| `src/sandbox/` | The Sandbox Durable Object (`core.ts` behind ports): the container's lifecycle and hardening, the command wrapper, `minerva-fs` calls, blob transfer between R2 and the container, and the `ExecutionEnv` pi's tools run on (`env.ts`) |
| `container/` | The sandbox image: `Dockerfile`, the Python requirements, `minerva-fs` and the probe (`minerva/`), their Python tests (`tests/`) |
| `src/scripts/` | Code mode: `run_script` in the `minerva` extension, the Scripts Durable Object that loads each script as a Dynamic Worker, the guest's prelude, the conversation's side of a script (wall clock, caps, the reset after every script) |
| `src/faults/` | The test build only: a fake connector and its provider object, fault points, the account tests' driver, and the sandbox lab (`lab.ts`, `sandbox.ts`: production's Sandbox object with fault seams, behind the driver) (below) |
| `src/addressing.ts` | The one map from a workspace (id, jurisdiction) to its objects and its bucket |
| `test/` | `unit/`, `platform/` (with the end-to-end fault tests, `protocols.test.ts`, and `frontend-auth.test.ts`, which runs the frontend's auth client, `frontend/src/lib/auth.ts`, against the Worker), `account/` (`deployed.test.ts` for `minerva-cf`; `faults.test.ts`, `sandbox.test.ts` and `turns.test.ts` for the test Worker; `scripts.test.ts` for the code mode lab), and `fixtures/` with the Python vectors |

## Setup

Node 24, pnpm 10 and the `cf` CLI, signed in (`cf auth login`).

```sh
pnpm install
pnpm --dir ../frontend install
pnpm secrets   # writes ../.env.cloudflare (mode 600) with fresh secrets; never prints them
```

To develop without an account, skip `cf auth login` and the secrets: see Local development.

Settings are text bindings, checked by `src/config.ts`'s parser when the Worker is built (see `cloudflare.config.ts`). Development and the tests read them from the environment. A production build reads `../.env.cloudflare.vars` and nothing else, so a shell's `MINERVA_*` (the Django app uses the same names) never reach a deploy; the file is gitignored because it names the deployed origins, both must be https, and `MINERVA_DEBUG` must be off:

```sh
MINERVA_SITE_URL=https://minerva-cf.<subdomain>.workers.dev
MINERVA_DOWNLOAD_ORIGIN=https://minerva-cf-files.<subdomain>.workers.dev
```

## Local development

No account, token or `cf auth login` is needed:

```sh
pnpm dev:offline                # the Worker on http://127.0.0.1:8787 (Ctrl-C stops it)
pnpm --dir ../frontend dev      # the pages on http://localhost:5173, which proxies /api to the Worker
```

`dev:offline` (`scripts/dev-offline.ts`) makes `.dev.vars` with fresh secrets if there are none (gitignored; `pnpm secrets:offline` does only that), creates `.assets/` if the frontend was never built (the frontend's own dev server serves the pages), applies the migrations to the local D1 database in `.cloudflare/state`, and starts `vite --mode offline`. It drops `CLOUDFLARE_API_TOKEN` from the environment, so nothing in it can reach an account.

What mode `offline` is, against a deployed Worker:

| | Local (`offline`) | Deployed |
|---|---|---|
| Model | The deterministic fake model (`MINERVA_MODEL_PROVIDER=fake`), no Workers AI or AI Gateway binding, no remote bindings | Workers AI or the AI Gateway |
| Entry | The test build's (`src/faults/`): the fake Notes connector and the token-gated `/api/faults/` driver | `src/index.ts`, which reaches nothing of it |
| Email | Written to the dev server's log (`MINERVA_DEBUG=true`): a sign-in code or verification link is in the terminal | The Email Sending binding |
| D1, R2, Durable Objects | Local simulations under `.cloudflare/state`, in a database and buckets named `minerva-cf-dev…` | The account's |
| Sandbox | The container when Docker runs (the first start builds the image from `container/`); otherwise the Sandbox object has no container, a warning says so at start, and a tool that needs it fails (`This Worker has no container.`) | `minerva-cf-sandbox` |
| Settings | `src/config.ts` defaults for localhost, which the shell's `MINERVA_*` override | `../.env.cloudflare.vars` only |

Mode `offline` exists only for this server: `vite.config.ts` marks the process (`MINERVA_DEV_OFFLINE`) when it serves, and `cloudflare.config.ts` refuses the mode without the mark, so `cf build`, `cf deploy` and `vite build` in it stop with an error. Nothing in `src/` reads the mark.

Vite's dev server loads the Worker's sources itself, so the `workerSources()` plugin in `vite.config.ts` lets it serve everything under `src/` (the Cloudflare plugin's deny list for the files `cloudflare.config.ts` imports otherwise stops the Worker from loading `src/config.ts`). `pnpm exec vite` without `--mode offline` is the earlier mode: it uses the account's Workers AI and AI Gateway as remote bindings and needs `CLOUDFLARE_API_TOKEN`.

## Checks

```sh
pnpm typecheck       # generates cf's types, then tsc for the Worker, Node scripts and download Worker
pnpm test:unit       # Vitest in Node: lib/, http/, settings, the contracts' types, rules on the sources; the sandbox's Docker-backed tests use the image `pnpm sandbox:image` builds
pnpm test:platform   # the Worker in local workerd: router, Durable Objects with SQLite, D1, the protocols' fault tests
pnpm test:account    # the deployed Workers (needs the origins above, ../.env.cloudflare and cf signed in)
pnpm test:faults     # the account's fault tests, sandbox lab and end-to-end turns, against the test Worker (below)
pnpm test:cm         # code mode's fault rows on the account, against its lab Worker; not part of test:faults (below)
```

The platform tests use `@cloudflare/vitest-plugin`, which loads `cloudflare.config.ts` itself (`experimental.newConfig`) in mode `test`, which builds the test Worker's entry (`src/faults/index.ts`) under local names of its own (`minerva-cf-local`, never production's, and only under vitest): the same Worker with the fake Notes connector, its provider object and the fault points. Remote bindings are off, so they never reach the account. `test/platform/protocols.test.ts` runs the real Workspace and Conversation objects, the executor with its ledger in the Conversation's SQLite, leases and refreshes against the fake provider, and the fake model, and injects the faults of the plan's Start and revocation, Attempts, Writes and Refresh rows (`ctx.abort()` at named points, with or without syncing first, lost answers, held steps). The unit tests compare `lib/` with vectors from today's Python; regenerate them with `cd ../backend && uv run python -I ../cloudflare/test/fixtures/generate.py`. The account tests call the token-gated `/api/probe` (`src/http/probe.ts`), with the token derived from `MINERVA_SECRET_KEY`, and read the Workers' settings with `cf`.

## First deploy

Create the resources once, in this order. `cf deploy` would create a missing database or bucket with default settings (no schema, no lifecycle rule, no jurisdiction), so `pnpm run deploy` first checks that each exists with its settings (`scripts/resources.ts`) and stops otherwise:

```sh
cf d1 create --name minerva-cf --primary-location-hint weur --read-replication-mode disabled
cf r2 buckets create --name minerva-cf-files --location-hint weur
cf r2 buckets create --name minerva-cf-files-eu --cf-r2-jurisdiction eu
cf r2 buckets lifecycle update minerva-cf-files --rules @r2-lifecycle.json --force
cf r2 buckets lifecycle update minerva-cf-files-eu --cf-r2-jurisdiction eu --rules @r2-lifecycle.json --force
cf ai-gateway gateways create --id minerva-cf --collect-logs=false --cache-ttl 0 --cache-invalidate-on-update=false --rate-limiting-interval 0 --rate-limiting-limit 0 --rate-limiting-technique fixed
```

The lifecycle rules delete `uploads/` objects a day after they were written (a message copies its attachments into the conversation's own blobs first) and `static/` objects 30 days after. `static/` is where the Worker keeps the earlier builds' hashed frontend files, so a page opened before a deploy still finds its chunks; a bucket created before that rule existed needs the `lifecycle update` command above run again (`pnpm run deploy` warns when the rule is missing). Then write `../.env.cloudflare.vars` (above) and deploy.

## Deploy

```sh
pnpm run deploy   # builds the frontend, assembles .assets/, checks the resources, applies D1's migrations, checks D1's schema, deploys minerva-cf, then minerva-cf-files
```

`deploy` checks the resources and applies the migrations in `migrations/` that D1 has not applied yet (`scripts/resources.ts`, which finds the database by name) before any code that needs them is uploaded. Then `scripts/schema-check.ts` reads the deployed database's schema with `cf d1 query` (SELECT statements only) and compares it with what `migrations/` builds on an empty SQLite database: tables, columns (type, NOT NULL, default, primary key), UNIQUE and FOREIGN KEY constraints, indexes, views, triggers, and the list of applied migrations (`scripts/schema.ts`). A table, column, constraint or index that is missing, one no migration made, or a column of another shape stops the deploy with the list of differences; CHECK clauses and collations inside a `CREATE TABLE` are not listed by SQLite and are not compared. It builds first and checks that the bundle has none of the test build's code (`scripts/bundle.ts`), then uploads that build. It uploads `../.env.cloudflare` as the main Worker's secrets and only `MINERVA_DOWNLOAD_KEY` to the download Worker. Both Workers are on workers.dev without preview URLs. `pnpm deploy` without `run` is pnpm's own command. `cf` keeps caches with the account id in `.cloudflare/`, which the repository's `.gitignore` ignores at any depth.

## The test Worker

`minerva-cf-test` is the same code built from `src/faults/index.ts` (`cf build --mode faults`), which adds what the account's fault tests need and production must not have: the fake Notes connector (`src/faults/connector.ts`), its provider as a Durable Object per workspace (`FaultProvider`, which rotates refresh tokens and records every request), fault plans kept in each object's own SQLite and fired at named points of the Conversation's and the Workspace's ports and of the attempt gate (`ctx.abort()`, a memory-limit reset, either one without syncing first, a lost answer, a held step; `src/faults/plan.ts`, `ports.ts`), and a driver at `POST /api/faults/<op>` that answers only with `X-Minerva-Faults: <token>`, derived from the test Worker's own `MINERVA_SECRET_KEY` (`src/faults/routes.ts`, `token.ts`). Its network reaches only the fake provider. The production entry reaches nothing of `src/faults/` or the fake model (`src/model/fake.ts`): a unit test walks its imports, `scripts/bundle.ts` checks the built bundle, and every build but the test build's refuses `MINERVA_MODEL_PROVIDER=fake`. The test build refuses `MINERVA_DEBUG` too. It uses the fake model unless a conversation's plan asks for Workers AI. It also carries the sandbox: its own container application `minerva-cf-test-sandbox` (the image of `container/`, built and pushed by `deploy:test` in about 75 s) behind the same Sandbox object as production's, and the lab at `POST /api/faults/sandbox/<op>` (`src/faults/lab.ts`), which runs that object with seams for the Sandbox fault rows (each hardening step failing, cgroup admission failing, a lost `destroy()`, a restart with a container running) and holds no state of its own: `test/account/sandbox.test.ts` keeps each sandbox's fence between calls. No other Worker or container application is needed for the sandbox tests.

It keeps everything of its own: secrets in `../.env.cloudflare-test` (`pnpm secrets:test`), settings in `../.env.cloudflare-test.vars` (gitignored, as it names the origin: `MINERVA_SITE_URL=https://minerva-cf-test.<subdomain>.workers.dev`, `MINERVA_DOWNLOAD_ORIGIN` an https origin, `MINERVA_MODEL_PROVIDER=fake`, `MINERVA_MODEL_NAME=@cf/zai-org/glm-5.3-flash`, `MINERVA_MODEL_GATEWAY=minerva-cf-test`), and resources created once:

```sh
cf d1 create --name minerva-cf-test --primary-location-hint weur --read-replication-mode disabled
cf r2 buckets create --name minerva-cf-test-files --location-hint weur
cf r2 buckets create --name minerva-cf-test-files-eu --cf-r2-jurisdiction eu
cf r2 buckets lifecycle update minerva-cf-test-files --rules @r2-lifecycle.json --force
cf r2 buckets lifecycle update minerva-cf-test-files-eu --cf-r2-jurisdiction eu --rules @r2-lifecycle.json --force
cf ai-gateway gateways create --id minerva-cf-test --collect-logs=false --cache-ttl 0 --cache-invalidate-on-update=false --rate-limiting-interval 0 --rate-limiting-limit 0 --rate-limiting-technique fixed
```

```sh
pnpm run deploy:test   # checks its resources, builds mode faults, checks the bundle has the fault code, deploys minerva-cf-test
pnpm test:faults       # about 10 minutes, one file at a time (a memory-limit reset takes every object of its isolate):
                       #   faults.test.ts   the fault rows, the local tools in the real Conversation and its container
                       #   sandbox.test.ts  the lab: probe, pi's conformance suite, hardening and Sandbox rows, timings
                       #   turns.test.ts    two end-to-end turns, fake model and Workers AI (skipped, with a message, if the model does not call the tools)
```

`MINERVA_SBX_TIMINGS=<file>` and `MINERVA_TURN_TIMINGS=<file>` make the sandbox and turn tests write their timings as JSON. `pnpm test:faults` does not run code mode's rows (`scripts.test.ts`); they need the lab Worker below.

It sends no email: the test build has no Email Sending binding, and its emails go to a `FaultMailbox` object (`src/faults/mailbox.ts`, the newest 500) that the driver reads and empties (`emails`, `emails-clear`). `test/account/browser.test.ts`, run by `pnpm test:account` after `deploy:test` (about 90 s), drives the frontend the test Worker serves in headless Google Chrome (`playwright-core`, `channel: "chrome"`): sign-up with the emailed code, the first-run setup, sign-in by password, with TOTP and by emailed code, a password reset, an agent, the fake Notes connection, a chat turn with the fake model that writes a file, its download, a Workers AI turn and sign-out, failing on console errors, uncaught exceptions, failed requests and unexpected statuses. The driver stands in for the fake provider's consent page (`provider-authorize`) and for the download origin (`download`, files-worker's handler over the test Worker's buckets). It is skipped without Chrome or the test Worker's settings; `MINERVA_BROWSER_SHOTS=<dir>` keeps a screenshot of each step, and of a failure with what the page showed and its last requests.

Keep it deployed for later steps. Never deploy the test build as `minerva-cf`, and never write its origin into tracked files.

## Code mode's lab

`minerva-cf-cm` (`test/account/scripts-worker/`) is a Worker of its own for code mode's account tests (`test/account/scripts.test.ts`): production's Scripts object and conversation-side runner (`src/scripts/`) behind `Lab`, a stand-in conversation with the run's queue and fake tools, plus variants of the Scripts object that load guests through an awaited loopback entrypoint or never reset themselves, so the tests can show what ends a guest that ignores its stop. It holds no data and no secret but its driver token, and is deployed only while its tests run:

```sh
pnpm run deploy:cm   # deploys minerva-cf-cm with ../.env.cloudflare-cm (CM_TOKEN="…", gitignored, mode 600)
pnpm test:cm         # the lab's origin in ../.env.cloudflare-cm.vars (CM_ORIGIN=https://minerva-cf-cm.<subdomain>.workers.dev); MINERVA_ENV_DIR names another directory for both files
cf workers delete minerva-cf-cm --force   # afterwards; read the output, since an aborted delete exits 0
```

Never write the lab's origin or token into tracked files.

The lab's conversation is a stand-in, so `run_script` in the real Conversation on the account is exercised by `test/account/turns.test.ts` on the test Worker.
