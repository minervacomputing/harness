# Minerva on Cloudflare

The experiment of [docs/plans/cloudflare.md](../docs/plans/cloudflare.md): the same product as Workers, Durable Objects, D1 and R2. This directory is step 1, the scaffold. The frontend stays in `frontend/` and becomes the Worker's static assets.

| Path | What |
|---|---|
| `cloudflare.config.ts` | Worker `minerva-cf`: assets, bindings, settings, secrets, the Durable Object classes |
| `files-worker/` | Worker `minerva-cf-files`, the download origin (a 404 stub until step 5) |
| `migrations/` | D1 `minerva-cf`: accounts and the workspace directory |
| `src/index.ts`, `src/http/` | The router, error shapes, cookies, CSRF, security headers, JSON bodies, `/assets/`, the probe |
| `src/lib/` | JSON (parsing and Python's dumps), Pydantic's strings for zod, Fernet, code point order, text helpers, hashes, ids, SQLite steps |
| `src/contracts/` | The interfaces steps 2 to 6 build against (types only) |
| `src/{workspace,conversation,sandbox,scripts}/` | The Durable Object classes, stubs for now |
| `src/addressing.ts` | The one map from a workspace (id, jurisdiction) to its objects and its bucket |
| `test/` | `unit/`, `platform/`, `account/`, and `fixtures/` with the Python vectors |

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
pnpm test:platform   # the Worker in local workerd: router, Durable Objects with SQLite, D1 with the migrations
pnpm test:account    # the deployed Workers (needs the origins above, ../.env.cloudflare and cf signed in)
```

The platform tests use `@cloudflare/vitest-plugin`, which loads `cloudflare.config.ts` itself (`experimental.newConfig`); remote bindings are off, so they never reach the account. The unit tests compare `lib/` with vectors from today's Python; regenerate them with `cd ../backend && uv run python -I ../cloudflare/test/fixtures/generate.py`. The account tests call the token-gated `/api/probe` (`src/http/probe.ts`), with the token derived from `MINERVA_SECRET_KEY`, and read the Workers' settings with `cf`.

## First deploy

Create the resources once, in this order. `cf deploy` would create a missing database or bucket with default settings (no schema, no lifecycle rule, no jurisdiction), so `pnpm run deploy` first checks that each exists with its settings (`scripts/resources.ts`) and stops otherwise:

```sh
cf d1 create --name minerva-cf --primary-location-hint weur --read-replication-mode disabled
cf r2 buckets create --name minerva-cf-files --location-hint weur
cf r2 buckets create --name minerva-cf-files-eu --cf-r2-jurisdiction eu
cf r2 buckets lifecycle update minerva-cf-files --rules @r2-lifecycle.json --force
cf r2 buckets lifecycle update minerva-cf-files-eu --cf-r2-jurisdiction eu --rules @r2-lifecycle.json --force
cf ai-gateway gateways create --id minerva-cf --collect-logs=false --cache-ttl 0
```

The lifecycle rule deletes `uploads/` objects a day after they were written; a message copies its attachments into the conversation's own blobs first. Then write `../.env.cloudflare.vars` (above) and deploy.

## Deploy

```sh
pnpm run deploy   # builds the frontend, assembles .assets/, checks the resources, applies D1's migrations, deploys minerva-cf, then minerva-cf-files
```

`deploy` checks the resources and applies the migrations in `migrations/` that D1 has not applied yet (`scripts/resources.ts`, which finds the database by name) before any code that needs them is uploaded. It uploads `../.env.cloudflare` as the main Worker's secrets and only `MINERVA_DOWNLOAD_KEY` to the download Worker. Both Workers are on workers.dev without preview URLs. `pnpm deploy` without `run` is pnpm's own command. `cf` keeps caches with the account id in `.cloudflare/`, which the repository's `.gitignore` ignores at any depth.
