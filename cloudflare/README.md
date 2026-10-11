# Minerva on Cloudflare

The experiment of [docs/plans/cloudflare.md](../docs/plans/cloudflare.md): the same product as Workers, Durable Objects, D1 and R2. This directory holds steps 1 (the scaffold) and 2 (the core protocols). The frontend stays in `frontend/` and becomes the Worker's static assets.

| Path | What |
|---|---|
| `cloudflare.config.ts` | Worker `minerva-cf` (and, in mode `faults`, the test Worker `minerva-cf-test`): assets, bindings, settings, secrets, the Durable Object classes |
| `files-worker/` | Worker `minerva-cf-files`, the download origin (a 404 stub until step 5) |
| `migrations/` | D1 `minerva-cf`: accounts and the workspace directory |
| `src/index.ts`, `src/http/` | The router, error shapes, cookies, CSRF, security headers, JSON bodies, `/assets/`, the probe |
| `src/lib/` | JSON (parsing and Python's dumps), Pydantic's strings for zod, Fernet, code point order, text helpers, hashes, ids, the SQL interface every object's logic runs on (`sql.ts`) and its schema steps |
| `src/contracts/` | The interfaces steps 2 to 6 build against (types only) |
| `src/workspace/` | The Workspace Durable Object: connections and credentials with refresh, layers, grants, agents, the run registry, the revocation outbox, uploads, deletion (`core.ts` over `lib/sql.ts`; `workspace.ts` is the object) |
| `src/conversation/` | The Conversation Durable Object: messages, runs, attempts and the gate, events and the stream's WebSocket, history replay, the run's tools, PiHarness; `ports.ts` wires the Workspace, the executor, the ledger and the model |
| `src/gateway/` | The permission pipeline: policy, grants, the connector contract and registry, run-start tool lists, the executor, provider HTTP, the write ledger and page tokens, strict validation, results |
| `src/model/` | The model wrapper: the pi-ai provider `minerva/default`, request policy, stream tap, routes to Workers AI or AI Gateway, the deterministic fake |
| `src/connectors/` | The connector registry the Workspace and the executor share (the 20 connectors join in step 6) |
| `src/{sandbox,scripts}/` | The Sandbox and Scripts Durable Objects, stubs until steps 3 and 4 |
| `src/faults/` | The test build only: a fake connector and its provider object, fault points, the account tests' driver (below) |
| `src/addressing.ts` | The one map from a workspace (id, jurisdiction) to its objects and its bucket |
| `test/` | `unit/`, `platform/` (with the end-to-end fault tests, `protocols.test.ts`), `account/`, and `fixtures/` with the Python vectors |

## Setup

Node 24, pnpm 10 and the `cf` CLI, signed in (`cf auth login`).

```sh
pnpm install
pnpm --dir ../frontend install
pnpm secrets   # writes ../.env.cloudflare (mode 600) with fresh secrets; never prints them
```

Settings are text bindings, checked by `src/config.ts`'s parser when the Worker is built (see `cloudflare.config.ts`). Development and the tests read them from the environment. A production build reads `../.env.cloudflare.vars` and nothing else, so a shell's `MINERVA_*` (the Django app uses the same names) never reach a deploy; the file is gitignored because it names the deployed origins, both must be https, and `MINERVA_DEBUG` must be off:

```sh
MINERVA_SITE_URL=https://minerva-cf.<subdomain>.workers.dev
MINERVA_DOWNLOAD_ORIGIN=https://minerva-cf-files.<subdomain>.workers.dev
```

## Checks

```sh
pnpm typecheck       # generates cf's types, then tsc for the Worker, Node scripts and download Worker
pnpm test:unit       # Vitest in Node: lib/, http/, settings, the contracts' types, rules on the sources
pnpm test:platform   # the Worker in local workerd: router, Durable Objects with SQLite, D1, the protocols' fault tests
pnpm test:account    # the deployed Workers (needs the origins above, ../.env.cloudflare and cf signed in)
pnpm test:faults     # the fault tests on the account, against the test Worker (below)
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

The lifecycle rule deletes `uploads/` objects a day after they were written; a message copies its attachments into the conversation's own blobs first. Then write `../.env.cloudflare.vars` (above) and deploy.

## Deploy

```sh
pnpm run deploy   # builds the frontend, assembles .assets/, checks the resources, applies D1's migrations, deploys minerva-cf, then minerva-cf-files
```

`deploy` checks the resources and applies the migrations in `migrations/` that D1 has not applied yet (`scripts/resources.ts`, which finds the database by name) before any code that needs them is uploaded. It builds first and checks that the bundle has none of the test build's code (`scripts/bundle.ts`), then uploads that build. It uploads `../.env.cloudflare` as the main Worker's secrets and only `MINERVA_DOWNLOAD_KEY` to the download Worker. Both Workers are on workers.dev without preview URLs. `pnpm deploy` without `run` is pnpm's own command. `cf` keeps caches with the account id in `.cloudflare/`, which the repository's `.gitignore` ignores at any depth.

## The test Worker

`minerva-cf-test` is the same code built from `src/faults/index.ts` (`cf build --mode faults`), which adds what the account's fault tests need and production must not have: the fake Notes connector (`src/faults/connector.ts`), its provider as a Durable Object per workspace (`FaultProvider`, which rotates refresh tokens and records every request), fault plans kept in each object's own SQLite and fired at named points of the Conversation's and the Workspace's ports and of the attempt gate (`ctx.abort()`, a memory-limit reset, either one without syncing first, a lost answer, a held step; `src/faults/plan.ts`, `ports.ts`), and a driver at `POST /api/faults/<op>` that answers only with `X-Minerva-Faults: <token>`, derived from the test Worker's own `MINERVA_SECRET_KEY` (`src/faults/routes.ts`, `token.ts`). Its network reaches only the fake provider. The production entry reaches nothing of `src/faults/` or the fake model (`src/model/fake.ts`): a unit test walks its imports, `scripts/bundle.ts` checks the built bundle, and every build but the test build's refuses `MINERVA_MODEL_PROVIDER=fake`. The test build refuses `MINERVA_DEBUG` too. It uses the fake model unless a conversation's plan asks for Workers AI.

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
pnpm test:faults       # the account's fault tests (test/account/faults.test.ts), a few minutes: restarts wait for the platform
```

Keep it deployed for later steps. Never deploy the test build as `minerva-cf`, and never write its origin into tracked files.
