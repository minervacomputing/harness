# Minerva on Cloudflare

The experiment of [docs/plans/cloudflare.md](../docs/plans/cloudflare.md): the same product as Workers, Durable Objects, D1 and R2. This directory holds steps 1 to 7: the protocols, the sandbox and files, code mode, the web API, the 20 connectors and the deploy scripts. The frontend stays in `frontend/` and becomes the Worker's static assets.

| Path | What |
|---|---|
| `cloudflare.config.ts` | Worker `minerva-cf` (and, in mode `faults`, the test Worker `minerva-cf-test`): assets, bindings, settings, secrets, the Durable Object classes |
| `files-worker/` | Worker `minerva-cf-files` (mode `faults`: `minerva-cf-files-test`), the download origin: checks a signed link and streams the object from R2 (`src/files/download.ts`); the web API's routes issue the links |
| `reset-worker/` | The quiesced instance `scripts/reset.ts` deploys while it resets an instance's data: 503 for every request, no binding, every Durable Object class retired (below) |
| `scripts/` | Deploy (`deploy.ts`, with `resources.ts`, `schema-check.ts`, `bundle.ts`, `builds.ts`), reset (`reset.ts`), secrets (`secrets.ts`), the frontend's assets (`assets.ts`), offline development |
| `migrations/` | D1 `minerva-cf`: accounts and the workspace directory |
| `src/index.ts`, `src/http/` | The router, error shapes, cookies, CSRF, security headers, JSON bodies, `/assets/`, the probe |
| `src/lib/` | JSON parsing (`parseJson`, which the runtime's key bug needs), canonical JSON (RFC 8785) for hashes, AES-GCM encryption at rest, zod records without prototype keys, text, dates, HTML, hosts and addresses, hashes, ids, the SQL interface every object's logic runs on (`sql.ts`) and its schema steps |
| `src/contracts/` | The interfaces steps 2 to 6 build against (types only) |
| `src/workspace/` | The Workspace Durable Object: connections and credentials with refresh, layers, grants, agents, the run registry, the revocation outbox, uploads, deletion (`core.ts` over `lib/sql.ts`; `workspace.ts` is the object) |
| `src/conversation/` | The Conversation Durable Object: messages, runs, attempts and the gate, events and the stream's WebSocket, history replay, the run's tools, PiHarness, the local tools and their checkpoint barrier (`local.ts`, `local-run.ts`); `ports.ts` wires the Workspace, the executor, the ledger and the model |
| `src/gateway/` | The permission pipeline: policy, grants, the connector contract and registry, run-start tool lists, the executor, provider HTTP, the write ledger and page tokens, strict validation, results |
| `src/model/` | The model wrapper: the pi-ai provider `minerva/default`, request policy, stream tap, routes to Workers AI or AI Gateway, the deterministic fake |
| `src/connectors/` | The 20 connectors and the registry the Workspace and the executor share |
| `src/files/` | Folders and versions: manifests, `FolderStore` over the Conversation's SQLite, names and limits, attachments, uploads, signed download links and the download origin's handler |
| `src/sandbox/` | The Sandbox Durable Object (`core.ts` behind ports): the container's lifecycle and hardening, the command wrapper, `minerva-fs` calls, blob transfer between R2 and the container, and the `ExecutionEnv` pi's tools run on (`env.ts`) |
| `container/` | The sandbox image: `Dockerfile`, the Python requirements, `minerva-fs` and the probe (`minerva/`), their Python tests (`tests/`) |
| `src/scripts/` | Code mode: `run_script` in the `minerva` extension, the Scripts Durable Object that loads each script as a Dynamic Worker, the guest's prelude, the conversation's side of a script (wall clock, caps, the reset after every script) |
| `src/faults/` | The test build only: a fake connector and its provider object, fault points, the account tests' driver, and the sandbox lab (`lab.ts`, `sandbox.ts`: production's Sandbox object with fault seams, behind the driver) (below) |
| `src/addressing.ts` | The one map from a workspace (id, jurisdiction) to its objects and its bucket |
| `test/` | `unit/`, `platform/` (with the end-to-end fault tests, `protocols.test.ts`, and `frontend-auth.test.ts`, which runs the frontend's auth client, `frontend/src/lib/auth.ts`, against the Worker), `account/` (`deployed.test.ts` for `minerva-cf`; `faults.test.ts`, `sandbox.test.ts`, `turns.test.ts` and `web-egress.test.ts` for the test Worker; `scripts.test.ts` for the code mode lab), `docker/` (the Sandbox against the real image), and `fixtures/` with shared test suites and provider fakes |

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
pnpm test:unit       # Vitest in Node, no Docker: lib/, the executor, policy, connectors against scripted provider answers, the objects' logic over SQLite, rules on the sources
pnpm test:docker     # the Sandbox against the real image in a local container (needs Docker and the image `pnpm sandbox:image` builds; skips without them)
pnpm test:platform   # the Worker in local workerd: router, Durable Objects with SQLite, D1, the protocols' fault tests
pnpm test:account    # the deployed Workers (needs the origins above, ../.env.cloudflare and cf signed in), and the browser walk on the test Worker (needs its settings and Chrome)
pnpm test:faults     # the account's fault tests, sandbox lab and end-to-end turns, against the test Worker (below)
pnpm test:cm         # code mode's fault rows on the account, against its lab Worker; not part of test:faults (below)
```

The platform tests use `@cloudflare/vitest-plugin`, which loads `cloudflare.config.ts` itself (`experimental.newConfig`) in mode `test`, which builds the test Worker's entry (`src/faults/index.ts`) under local names of its own (`minerva-cf-local`, never production's, and only under vitest): the same Worker with the fake Notes connector, its provider object and the fault points. Remote bindings are off, so they never reach the account. `test/platform/protocols.test.ts` runs the real Workspace and Conversation objects, the executor with its ledger in the Conversation's SQLite, leases and refreshes against the fake provider, and the fake model, and injects the faults of the plan's Start and revocation, Attempts, Writes and Refresh rows (`ctx.abort()` at named points, with or without syncing first, lost answers, held steps). The account tests call the token-gated `/api/probe` (`src/http/probe.ts`), with the token derived from `MINERVA_SECRET_KEY`, and read the Workers' settings with `cf`.

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

The lifecycle rules delete `uploads/` objects a day after they were written (a message copies its attachments into the conversation's own blobs first) and `static/` objects 30 days after. `static/` is where the Worker keeps the earlier builds' hashed frontend files, so a page opened before a deploy still finds its chunks; a bucket created before that rule existed needs the `lifecycle update` command above run again (`pnpm run deploy` stops while either rule is missing from either bucket). Then write `../.env.cloudflare.vars` (above) and deploy.

## Deploy

```sh
pnpm run deploy   # builds the frontend, then scripts/deploy.ts: minerva-cf, then minerva-cf-files
```

`scripts/deploy.ts` runs alone (a lock in `.cloudflare/`, shared with `scripts/reset.ts`, since both build into the same `.cloudflare/output/` directories; a lock left by a run killed outright is never taken over, and the message says which file to remove) and sends every `cf` command to one account: the one in `CLOUDFLARE_ACCOUNT_ID`, or else the only account `cf` reaches, put in the environment of every command (a `.env` file setting a `CLOUDFLARE_` variable where `cf` runs stops it instead, since `cf` would read it there). It does everything that can fail locally before anything on the account changes:

1. checks the secrets (`scripts/secrets.ts check`: present, the encryption keys in a format the Worker reads, a setup key long enough to claim setup);
2. builds the app (`cf build`) and checks that the bundle has none of the test build's code (`scripts/bundle.ts`);
3. builds the download origin (`files-worker/`) and checks it against the app's build (`scripts/builds.ts`): its name, exactly the app's buckets, every bucket the instance's own, the app's `MINERVA_DOWNLOAD_ORIGIN`, and `MINERVA_DOWNLOAD_KEY` as its only secret. A test build that would reach production's Workers or buckets, or the other way round, stops here;
4. checks the resources and applies the migrations in `migrations/` that D1 has not applied yet (`scripts/resources.ts`, which finds the database by name): the first change on the account. Migrations are additive, so the running version keeps working;
5. reads the deployed database's schema with `cf d1 query` (SELECT statements only) and compares it with what `migrations/` builds on an empty SQLite database (`scripts/schema-check.ts`, `scripts/schema.ts`): tables, columns (type, NOT NULL, default, primary key), UNIQUE and FOREIGN KEY constraints, indexes, views, triggers, and the list of applied migrations. A table, column, constraint or index that is missing, one no migration made, or a column of another shape stops the deploy (exit 1) with the list of differences; a database it cannot read exits 2. CHECK clauses and collations inside a `CREATE TABLE` are not listed by SQLite and are not compared;
6. uploads the app's build with `../.env.cloudflare` as its secrets, then the download origin's with only `MINERVA_DOWNLOAD_KEY`, written to an owner-only file in a fresh temporary directory that is removed whether the upload succeeds, fails or is interrupted. Each build is uploaded only if it is still the one made and checked in steps 2 and 3 (a digest of its output, taken right after the build), the secrets file only if it is unchanged since step 1, and a build naming another account (`accountId`) stops the deploy. The secrets' values are hidden from everything printed, like the account's ids and the workers.dev subdomain. After the app's upload, the deploy records its version and a digest of its link key in `.cloudflare/deployed.json` (ignored by git), for a later `--files-only`.

Both Workers are on workers.dev without preview URLs. `pnpm deploy` without `run` is pnpm's own command. `cf` keeps caches with the account id in `.cloudflare/`, which the repository's `.gitignore` ignores at any depth. `cf deploy` creates a missing database or bucket with default settings when it resolves the bindings (this cannot be turned off), which is why step 4 checks them right before.

**A partial deploy.** The app is uploaded before the download origin, so a failure in between leaves a new app with the previous download origin. They share only the link key and the origin, so links keep working unless one of those changed. Finish with `pnpm run deploy:files` (`node scripts/deploy.ts --test --files-only` for the test instance), from the same checkout and secrets file: it builds and checks both again, checks the resources without applying migrations, checks that the app as deployed (its version serving all traffic) has the local build's buckets and `MINERVA_DOWNLOAD_ORIGIN` and is the version this checkout recorded, with the same link key (which cannot be read back from the account), and uploads the download origin alone. Otherwise it stops: deploy both. A failed app upload leaves the previous version serving with the new migrations applied, which it tolerates since they are additive; deploy again once fixed. Rolling back to an earlier version (`cf workers versions`) is possible for code and settings, but not across a change of the Durable Object classes: a class created, renamed or retired through `exports` changes the namespaces, and an earlier version cannot bring back a retired namespace or its storage (after a reset, below, the earlier versions point at namespaces that no longer exist).

## The test Worker

`minerva-cf-test` is the same code built from `src/faults/index.ts` (`cf build --mode faults`), which adds what the account's fault tests need and production must not have: the fake Notes connector (`src/faults/connector.ts`), its provider as a Durable Object per workspace (`FaultProvider`, which rotates refresh tokens and records every request), fault plans kept in each object's own SQLite and fired at named points of the Conversation's and the Workspace's ports and of the attempt gate (`ctx.abort()`, a memory-limit reset, either one without syncing first, a lost answer, a held step; `src/faults/plan.ts`, `ports.ts`), and a driver at `POST /api/faults/<op>` that answers only with `X-Minerva-Faults-Token: <token>`, derived from the test Worker's own `MINERVA_SECRET_KEY` (a name Workers Logs blank) (`src/faults/routes.ts`, `token.ts`). Its network reaches only the fake provider. The production entry reaches nothing of `src/faults/` or the fake model (`src/model/fake.ts`): a unit test walks its imports, `scripts/bundle.ts` checks the built bundle, and every build but the test build's refuses `MINERVA_MODEL_PROVIDER=fake`. The test build refuses `MINERVA_DEBUG` too. It uses the fake model unless a conversation's plan asks for Workers AI. It also carries the sandbox: its own container application `minerva-cf-test-sandbox` (the image of `container/`, built and pushed by `deploy:test` in about 75 s) behind the same Sandbox object as production's, and the lab at `POST /api/faults/sandbox/<op>` (`src/faults/lab.ts`), which runs that object with seams for the Sandbox fault rows (each hardening step failing, cgroup admission failing, a lost `destroy()`, a restart with a container running) and holds no state of its own: `test/account/sandbox.test.ts` keeps each sandbox's fence between calls. No other Worker or container application is needed for the sandbox tests.

It keeps everything of its own: secrets in `../.env.cloudflare-test` (`pnpm secrets:test`), settings in `../.env.cloudflare-test.vars` (gitignored, as it names the origin: `MINERVA_SITE_URL=https://minerva-cf-test.<subdomain>.workers.dev`, `MINERVA_DOWNLOAD_ORIGIN=https://minerva-cf-files-test.<subdomain>.workers.dev`, its download origin's, `MINERVA_MODEL_PROVIDER=fake`, `MINERVA_MODEL_NAME=@cf/zai-org/glm-5.3-flash`, `MINERVA_MODEL_GATEWAY=minerva-cf-test`), and resources created once:

```sh
cf d1 create --name minerva-cf-test --primary-location-hint weur --read-replication-mode disabled
cf r2 buckets create --name minerva-cf-test-files --location-hint weur
cf r2 buckets create --name minerva-cf-test-files-eu --cf-r2-jurisdiction eu
cf r2 buckets lifecycle update minerva-cf-test-files --rules @r2-lifecycle.json --force
cf r2 buckets lifecycle update minerva-cf-test-files-eu --cf-r2-jurisdiction eu --rules @r2-lifecycle.json --force
cf ai-gateway gateways create --id minerva-cf-test --collect-logs=false --cache-ttl 0 --cache-invalidate-on-update=false --rate-limiting-interval 0 --rate-limiting-limit 0 --rate-limiting-technique fixed
```

```sh
pnpm run deploy:test   # scripts/deploy.ts --test: builds mode faults (checking the bundle has the fault code), deploys minerva-cf-test, then minerva-cf-files-test
pnpm test:faults       # about 10 minutes, one file at a time (a memory-limit reset takes every object of its isolate):
                       #   faults.test.ts   the fault rows, the local tools in the real Conversation and its container
                       #   sandbox.test.ts  the lab: probe, pi's conformance suite, hardening and Sandbox rows, timings
                       #   turns.test.ts    two end-to-end turns, fake model and Workers AI (skipped, with a message, if the model does not call the tools)
                       #   web-egress.test.ts  the Web connector's fetch to names for private, mapped and redirected addresses (nip.io, sslip.io, httpbin.org),
                       #                       Accept-Encoding passed through as sent, and more fetches than an invocation's six connections
```

One file runs alone with `pnpm test:faults test/account/web-egress.test.ts` (the account config, `pnpm test:account`, excludes it with the other test-Worker suites). `MINERVA_SBX_TIMINGS=<file>` and `MINERVA_TURN_TIMINGS=<file>` make the sandbox and turn tests write their timings as JSON. `pnpm test:faults` does not run code mode's rows (`scripts.test.ts`); they need the lab Worker below.

It sends no email: the test build has no Email Sending binding, and its emails go to a `FaultMailbox` object (`src/faults/mailbox.ts`, the newest 500) that the driver reads and empties (`emails`, `emails-clear`). `test/account/browser.test.ts`, run by `pnpm test:account test/account/browser.test.ts` after `deploy:test` (about 100 s; plain `pnpm test:account` also runs `deployed.test.ts`, which targets production), drives the frontend the test Worker serves in headless Google Chrome (`playwright-core`, `channel: "chrome"`): sign-up with the emailed code and the setup key, the first-run setup claimed on `/setup`, the instance admin page, sign-in by password, with TOTP and by emailed code, a password reset, an agent, the fake Notes connection, a chat turn with the fake model that writes a file, its download through the app's redirect to `minerva-cf-files-test` (which must then refuse the link unsigned, with its signature or a signed field changed, and expired), a Workers AI turn and sign-out, failing on console errors, uncaught exceptions, failed requests and unexpected statuses. The driver stands in for the fake provider's consent page (`provider-authorize`) and deletes an earlier walk's setup claim first (`setup-reopen`, keeping its admins), so every walk claims the setup through the page. Every account suite checks first that its origins are the test instance's own (`test/account/origins.ts`: an https origin `minerva-cf-test.<subdomain>.workers.dev`, or `minerva-cf-files-test.<subdomain>.workers.dev` for the download origin, on the same subdomain) and stops otherwise. The walk fails, rather than skip, without Chrome or the test Worker's settings; `MINERVA_BROWSER_SHOTS=<dir>` keeps a screenshot of every page with its fields masked, and of a failure with what the page showed and its last requests.

Its download origin is `minerva-cf-files-test`, the same `files-worker/` built in mode `faults` (`files-worker/cloudflare.config.ts`): its own name, the test Worker's two buckets, `MINERVA_DOWNLOAD_ORIGIN` from `../.env.cloudflare-test.vars` (the same file as the test app's, so the app signs links for it) and only `MINERVA_DOWNLOAD_KEY` of `../.env.cloudflare-test`. The config refuses any of production's names in that mode, and `scripts/deploy.ts` checks the built output against the test app's build before either is uploaded (Deploy, above).

Keep it deployed for later steps. Never deploy the test build as `minerva-cf`, and never write its origin into tracked files.

## Resetting an instance

An instance whose data is worth nothing, such as after a change of a stored format, is emptied with `scripts/reset.ts`. It cannot be undone. Without `--yes` it changes nothing and lists what a reset would delete:

```sh
pnpm assets
node scripts/reset.ts --test           # what a reset of minerva-cf-test deletes: objects per class, per bucket and prefix, rows per table
node scripts/reset.ts --test --yes     # the reset
pnpm run deploy:test                   # migrations from empty, every class provisioned afresh, the app
node scripts/schema-check.ts --test    # must pass
```

`--production` does the same for `minerva-cf` (then `pnpm run deploy`); an instance in use is never reset. Every name comes from the app's build, never from a pattern, and each must be the instance's own (`<name>`, `<name>-files`, `<name>-files-eu`). It takes the same lock and pins the same account as a deploy (Deploy, above). Before changing anything the script checks that the Worker, its database and its buckets exist on that account, that the Worker has no Durable Object namespace of a class its build does not export, that every container application linked to its namespaces is one its build names (`<name>-<word>`, matched exactly), and that no bucket has a setting its recreation would lose (CORS, domains, notifications, locks, a lifecycle rule not exactly as in `r2-lifecycle.json`); it runs the schema check read-only (drift, exit 1, is expected; any other answer stops the reset); and it prints no identifier. It deploys the quiesced build only if it is still the one it checked. Then, in this order:

1. **Quiesce, and delete the Durable Objects.** It deploys `reset-worker/` as the instance's Worker: it answers 503 to every request, has no binding, and lists every class of the app's build as an `exports` tombstone (`exports.durableObject({ state: "deleted" })`, the supported way to delete a class declared through `exports`: [Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)). Cloudflare then deletes each class's namespace with all of its objects' storage and alarms, wherever the objects are located, EU included; `cf deploy` prints the reconciliation (`Deleted: Conversation, …`). The script waits until the Worker has no namespace left and its container applications run no instance, then deletes those applications (`<name>-sandbox`): they stay linked to the retired Sandbox namespace, and the next deploy cannot move them to the new one (`cf` stops with "could not finish applying its Durable Object-managed Container application settings"), and creates them again from the image already in the registry.
2. **Empty and recreate the buckets.** Each bucket, its jurisdiction explicit, is listed and deleted in pages of up to 1,000 keys until a listing is empty (`static/` included). The empty bucket is then deleted, which R2 refuses while a multipart upload is in progress (the app creates none; `cf` cannot list or abort them, the S3 API can), and created again with its jurisdiction, location and storage class, and `r2-lifecycle.json`; the script checks afterwards that its rules are exactly the file's and that it is empty.
3. **Recreate the database.** D1 is deleted and created again empty, with its location (or jurisdiction) and replication mode.

The instance answers 503 until the next deploy applies the migrations to the empty database and provisions every class as a new namespace. Its earlier Worker versions point at namespaces that no longer exist, so none can be rolled back to (Deploy, above). A reset that stops leaves what it did done and says where it stopped; run it again (after creating a missing bucket or database with the First deploy commands, if it says so).

## Code mode's lab

`minerva-cf-cm` (`test/account/scripts-worker/`) is a Worker of its own for code mode's account tests (`test/account/scripts.test.ts`): production's Scripts object and conversation-side runner (`src/scripts/`) behind `Lab`, a stand-in conversation with the run's queue and fake tools, plus variants of the Scripts object that load guests through an awaited loopback entrypoint or never reset themselves, so the tests can show what ends a guest that ignores its stop. It holds no data and no secret but its driver token, and is deployed only while its tests run:

```sh
pnpm run deploy:cm   # deploys minerva-cf-cm with ../.env.cloudflare-cm (CM_TOKEN="…", gitignored, mode 600)
pnpm test:cm         # the lab's origin in ../.env.cloudflare-cm.vars (CM_ORIGIN=https://minerva-cf-cm.<subdomain>.workers.dev); MINERVA_ENV_DIR names another directory for both files
cf workers delete minerva-cf-cm --force   # afterwards; read the output, since an aborted delete exits 0
```

Never write the lab's origin or token into tracked files.

The lab's conversation is a stand-in, so `run_script` in the real Conversation on the account is exercised by `test/account/turns.test.ts` on the test Worker.
