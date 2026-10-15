# The engine

Minerva's engine on Workers, Durable Objects, D1, R2 and Containers: the protocols, the sandbox and files, code mode, the web API, the 20 connectors and the deploy scripts. Its design is in [ARCHITECTURE.md](../ARCHITECTURE.md); this file is how to develop, test and deploy it. The frontend stays in `frontend/` and becomes the Worker's static assets.

| Path | What |
|---|---|
| `cloudflare.config.ts` | The app Worker (production's `minerva-cf`, and in mode `faults` the test instance's `minerva-cf-test`): assets, bindings, settings, secrets, the Durable Object classes |
| `files-worker/` | The download Worker `<name>-files` (production's `minerva-cf-files`, the test instance's `minerva-cf-test-files`), the download origin: checks a signed link and streams the object from R2 (`src/files/download.ts`); the web API's routes issue the links |
| `reset-worker/` | The quiesced instance `scripts/reset.ts` deploys while it resets an instance's data: 503 for every request, no binding, every Durable Object class retired (below) |
| `scripts/` | An instance's names, directory and origins (`instance.ts`, `instance-files.ts`, `instances.ts`, `origins.ts`, below), its identity on the account (`identity.ts`, `account.ts`), deploy (`deploy.ts`, with `resources.ts`, `schema-check.ts`, `bundle.ts`, `builds.ts`), reset (`reset.ts`), secrets (`secrets.ts`), the account suites' runner (`suite.ts`), the frontend's assets (`assets.ts`), offline development |
| `migrations/` | D1 `<name>`: accounts, the workspace directory, and the instance's identity row |
| `src/index.ts`, `src/http/` | The router, error shapes, CSRF by origin, security headers, the JSON body reader, `/assets/`, the probe |
| `../contract/` | The API's contract (oRPC and zod): each endpoint's method, path, input, output and errors. `src/api/orpc.ts` serves it under `/api/` after the routes not moved yet, and the frontend's client is derived from it. Its `src/internal/` is the internal API between Laravel and the engine, with its OpenAPI documents in `openapi/` (`pnpm openapi` writes them) and the fact delivery scenarios in `scenarios/` ([docs/plans/contract.md](../docs/plans/contract.md)) |
| `src/internal/` | The internal API's mount under `/internal/` (`mount.ts`): the Access assertion checked again (`access.ts`), the commands (`procedures.ts`), the catalog (`catalog.ts`) |
| `src/laravel/` | The engine's client of Laravel's half of the internal API (`client.ts`); `test/platform/fake-laravel.ts` is the fake Laravel the platform tests route it to |
| `src/lib/` | JSON parsing (`parseJson`, which the runtime's key bug needs), canonical JSON (RFC 8785) for hashes, AES-GCM encryption at rest, zod records without prototype keys, text, dates, HTML, hosts and addresses, hashes, ids, the SQL interface every object's logic runs on (`sql.ts`) and its schema steps |
| `src/workspace/` | The Workspace Durable Object: connections and credentials with refresh, layers, grants, agents, the run registry, the revocation outbox, uploads, deletion (`core.ts` over `lib/sql.ts`; `workspace.ts` is the object) |
| `src/conversation/` | The Conversation Durable Object: messages, runs, attempts and the gate, events and the stream's WebSocket, history replay, the run's tools, PiHarness, the local tools and their checkpoint barrier (`local.ts`, `local-run.ts`); `ports.ts` wires the Workspace, the executor, the ledger and the model |
| `src/gateway/` | The permission pipeline: policy, grants, the connector contract and registry, run-start tool lists, the executor, provider HTTP, the write ledger and page tokens, strict validation, results |
| `src/model/` | The model wrapper: the pi-ai provider `minerva/default`, request policy, stream tap, routes to Workers AI or AI Gateway, the deterministic fake |
| `src/connectors/` | The 20 connectors and the registry the Workspace and the executor share |
| `src/files/` | Folders and versions: manifests, `FolderStore` over the Conversation's SQLite, names and limits, attachments, uploads, signed download links and the download origin's handler |
| `src/sandbox/` | The Sandbox Durable Object (`core.ts` behind ports): the container's lifecycle and hardening, the command wrapper, the folder's hydration, scan and checkpoints (`tar` and `find` in the container, streamed to and from R2), and the `ExecutionEnv` pi's tools run on (`env.ts`) |
| `container/` | The sandbox image: `Dockerfile`, the Python requirements and the probe (`minerva/`) |
| `src/scripts/` | Code mode: `run_script` in the `minerva` extension, the Scripts Durable Object that loads each script as a Dynamic Worker, the guest's prelude, the conversation's side of a script (wall clock, caps, the reset after every script) |
| `src/faults/` | The test build only: a fake connector and its provider object, fault points, the account tests' driver, and the sandbox lab (`lab.ts`, `sandbox.ts`: production's Sandbox object with fault seams, behind the driver) (below) |
| `src/addressing.ts` | The one map from a workspace (id, jurisdiction) to its objects and its bucket |
| `src/shared/` | The types every object and the Worker share: ids, the verified caller, the attempt fence and refusals (`rpc.ts`), and the JSON API's shapes from the frontend's generated types (`api.ts`). Every other type lives with the module that owns it |
| `test/` | `unit/`, `platform/` (with the end-to-end fault tests, `protocols.test.ts`, and `frontend-auth.test.ts`, which runs the frontend's auth client, `frontend/src/lib/auth.ts`, against the Worker), `account/` (`deployed.test.ts` for any instance as deployed; `faults.test.ts`, `resets.test.ts`, `sandbox.test.ts`, `sandbox-faults.test.ts` and `turns.test.ts` for the test Worker, with their clients `driver.ts` and `lab.ts`; `scripts.test.ts` for the code mode lab), `docker/` (the Sandbox against the real image), and `fixtures/` with shared test suites and provider fakes |

## Names

An instance is a name, and `scripts/instance.ts` derives every resource name from it (`namesOf`). The Worker configs, the scripts and the account suites take their names from that one module, and a unit test (`test/unit/sources.test.ts`) fails if any other file names one of ours. A name uses lowercase letters, digits and single hyphens, starts with a letter, does not end with a hyphen, has at most 54 characters (so `<name>-files-eu` stays within the 63 of a Worker or a bucket), does not end in `-files`, `-files-eu`, `-sandbox` or `-cm` (or the instance `acme-files` would own the download Worker of `acme`), and is not `default` (the id of the AI Gateway Cloudflare creates by itself, with logging on).

| Resource | Name | Production | Test instance |
|---|---|---|---|
| App Worker, D1 database, AI Gateway | `<name>` | `minerva-cf` | `minerva-cf-test` |
| Download Worker | `<name>-files` | `minerva-cf-files` | `minerva-cf-test-files` |
| Buckets | `<name>-files`, `<name>-files-eu` (EU jurisdiction) | `minerva-cf-files`, `minerva-cf-files-eu` | `minerva-cf-test-files`, `minerva-cf-test-files-eu` |
| Container application | `<name>-sandbox`, matched exactly by `scripts/reset.ts` | `minerva-cf-sandbox` | `minerva-cf-test-sandbox` |
| Code mode's lab (test instances only) | `<name>-cm` | | `minerva-cf-test-cm` |

`MINERVA_MODEL_GATEWAY` is not a setting: every build sets it to the instance's name, and a vars file that sets it stops the build. The modes that reach no account use fixed local names, which no instance may take: `minerva-dev` for the dev server (`offline`) and `minerva-local` for the platform tests (`test`) and for any other mode (`standalone`, which `pnpm build` and `pnpm startup` build in, and `cf workers types`, which has none); the local Docker image is `minerva-sandbox:local`. A build in these modes needs no instance and carries no instance's names, so it cannot be deployed as one: the deploy scripts build again for the instance and check the bundle's name (`scripts/bundle.ts`).

## The instance directory

An instance's operator files live outside the checkout, one directory per instance, so that every checkout and worktree deploys the same instance with the same keys:

```
~/.config/minerva/instances/<name>/   mode 700; $XDG_CONFIG_HOME (absolute) replaces ~/.config, MINERVA_INSTANCES_DIR (absolute) the whole path
  instance.json   {"name": "<name>", "test": false, "account": "<account id>"}
  secrets.env     the Workers' secrets (pnpm secrets --instance <name>)
  vars.env        a deployed build's settings (Setup, below)
  deployed.json   the app's last deploy, for a later --files-only (Deploy, below)
  cm.env          code mode's lab: its driver token (test instances only)
  cm.vars.env     code mode's lab: its origin
  lock            held by a command that writes here or changes the instance's account
```

```sh
pnpm instances create <name> [--test]   # the directory and its instance.json; --test makes a test instance (the test build, mode faults)
pnpm instances list                     # each instance's name and kind
```

The instances directory, each instance's directory and every file in it are their owner's alone (700 and 600), and none is a symbolic link (a link higher up, such as a linked `~/.config`, is allowed); `instance.json` must name its own directory, with `test` a boolean and `account` a Cloudflare account id. Anything else stops every command, a listing included, so a malformed instance never drops out and leaves another as the only one. When the instances directory is inside a git checkout (CI keeps one in a temporary `MINERVA_INSTANCES_DIR`), links resolved, that checkout must ignore it. The scripts replace a file atomically (a temporary file beside it, renamed into place) and only while holding the instance's lock. Nothing read there is printed. Back the directory up: losing `MINERVA_ENCRYPTION_KEYS` loses every stored credential.

**The account.** The first deploy (or reset) of an instance records its account in `instance.json` before it changes anything: the account in `CLOUDFLARE_ACCOUNT_ID`, or else the only one `cf` reaches. From then on every `cf` command for the instance goes to that account: `CLOUDFLARE_ACCOUNT_ID`, if set, must be the same, and `cf` must reach it. The account suites, `scripts/resources.ts`, `scripts/schema-check.ts` and `scripts/identity.ts` pin it too, and stop on an instance with no account recorded; `resources.ts` run by hand also takes the deploy's locks before applying migrations.

**Choosing the instance.** The scripts that change an account take `--instance <name>`, and a production instance is never chosen by default: `pnpm run deploy`, `deploy:files`, `reset.ts --production` and `pnpm test:deployed` need its name. The test instance's commands (`deploy:test`, `deploy:cm`, `test:faults`, `test:browser`, `test:cm`, `secrets:test`, `reset.ts --test`) use the only test instance when none is named; with none, or several, they stop and list the names, and they refuse a production instance. `MINERVA_INSTANCE` names the instance for commands that take no flag of ours (`cf build`, vite, vitest); the scripts set it for everything they run. `--instance` comes first, then `MINERVA_INSTANCE`, then the only test instance; a flag that disagrees with `MINERVA_INSTANCE` stops the command, and so does a mode that disagrees with the instance's kind (`cf build --mode faults` for a production instance, `--mode production` for a test one). `pnpm run <script> --instance <name>` passes the flag to the script.

Ours are `minerva-cf` (production) and `minerva-cf-test` (test). Their files once lived at the repository root (`../.env.cloudflare*`); while any such file remains there, every command that chooses an instance stops and prints the `mv` that moves each into its instance's directory.

## Setup

Node 24, pnpm 10 and the `cf` CLI, signed in (`cf auth login`).

```sh
pnpm install   # the repository's pnpm workspace: this Worker, ../frontend and ../contract, one lockfile at the root
pnpm instances create <name>      # the instance's directory (The instance directory, above)
pnpm secrets --instance <name>    # writes its secrets.env (mode 600) with fresh secrets; never prints them
```

To develop without an account, skip `cf auth login`, the instance and the secrets: see Local development.

Settings are text bindings, checked by `src/config.ts`'s parser when the Worker is built (see `cloudflare.config.ts`). Development and the tests read them from the environment. A deployed build (mode `production` or `faults`) reads its instance's `vars.env` and nothing else, so a shell's `MINERVA_*` never reach a deploy; the file must exist and `MINERVA_DEBUG` must be off. It cannot set `MINERVA_MODEL_GATEWAY` (Names, above). Only workers.dev is configured, so the two origins must be the instance's own Workers there, on one subdomain, which the build checks (`scripts/origins.ts`); the deploy and the account suites then compare that subdomain with the account's own, as the account's Workers show it (`scripts/account.ts`), so a vars file copied from another instance or another account stops them. For an instance `<name>`:

```sh
MINERVA_SITE_URL=https://<name>.<subdomain>.workers.dev
MINERVA_DOWNLOAD_ORIGIN=https://<name>-files.<subdomain>.workers.dev
```

The account's subdomain is read from its Workers, so an account with no Worker yet cannot be checked: the deploy stops until one is deployed there.

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
| D1, R2, Durable Objects | Local simulations under `.cloudflare/state`, in a database and buckets named `minerva-dev…` | The account's |
| Sandbox | The container when Docker runs (the first start builds the image from `container/`); otherwise the Sandbox object has no container, a warning says so at start, and a tool that needs it fails (`This Worker has no container.`) | `<name>-sandbox` |
| Images | No Images binding: `read` gives the model only images already within its limits and refuses larger ones | The Images binding, which shrinks larger ones (`src/conversation/images.ts`) |
| Settings | `src/config.ts` defaults for localhost, which the shell's `MINERVA_*` override | The instance's `vars.env` only |

Mode `offline` exists only for this server: `vite.config.ts` marks the process (`MINERVA_DEV_OFFLINE`) when it serves, and `cloudflare.config.ts` refuses the mode without the mark, so `cf build`, `cf deploy` and `vite build` in it stop with an error. Nothing in `src/` reads the mark.

Vite's dev server loads the Worker's sources itself, so the `workerSources()` plugin in `vite.config.ts` lets it serve everything under `src/` (the Cloudflare plugin's deny list for the files `cloudflare.config.ts` imports otherwise stops the Worker from loading `src/config.ts`). `pnpm exec vite` without `--mode offline` is the earlier mode (`development`): it uses the account's Workers AI and AI Gateway as remote bindings and needs `CLOUDFLARE_API_TOKEN`. Everything else is local under the local name, `minerva-local`, but its model turns go through a test instance's AI Gateway: the one `MINERVA_INSTANCE` names, or else the only test instance (The instance directory, above). It refuses a production instance, and the shell's `MINERVA_MODEL_GATEWAY` is ignored.

## Checks

```sh
pnpm typecheck       # generates cf's types, then tsc for the Worker, Node scripts and download Worker
pnpm test:unit       # Vitest in Node, no Docker: lib/, the executor, policy, connectors against scripted provider answers, the objects' logic over SQLite, rules on the sources
pnpm test:docker     # the Sandbox against the real image in a local container (needs Docker and the image `pnpm sandbox:image` builds; skips without them)
pnpm test:platform   # the Worker in local workerd: router, Durable Objects with SQLite, D1, the protocols' fault tests
pnpm test:deployed --instance <name>   # an instance's deployed Workers (needs its vars.env and secrets.env, its account recorded and cf signed in)
pnpm test:browser    # the browser walk on the test Worker (needs Chrome; below)
pnpm test:faults     # the account's fault tests, memory-limit resets, sandbox lab and end-to-end turns, against the test Worker (below)
pnpm test:cm         # code mode's fault rows on the account, against its lab Worker; not part of test:faults, nor of CI (below)
pnpm startup         # builds src/index.ts and measures its startup CPU locally, in a few seconds (Startup, below)
```

The account suites run through `scripts/suite.ts`, which chooses the instance (`--instance <name>`, or the only test instance for the test instance's suites), pins its account, and passes both to vitest (`MINERVA_INSTANCE`, `CLOUDFLARE_ACCOUNT_ID`); other arguments go to vitest. Each suite reads that instance's `vars.env` and `secrets.env` itself, never the shell's settings.

The platform tests use `@cloudflare/vitest-plugin`, which loads `cloudflare.config.ts` itself (`experimental.newConfig`) in mode `test`, which builds the test Worker's entry (`src/faults/index.ts`) under a local name of its own (`minerva-local`, never an instance's, and only under vitest): the same Worker with the fake Notes connector, its provider object and the fault points. Remote bindings are off, so they never reach the account. `test/platform/protocols.test.ts` runs the real Workspace and Conversation objects, the executor with its ledger in the Conversation's SQLite, leases and refreshes against the fake provider, and the fake model, and injects the faults of the Start and revocation, Attempts, Writes and Refresh rows of ARCHITECTURE.md's Testing table (`ctx.abort()` at named points, with or without syncing first, lost answers, held steps). The account tests call the token-gated `/api/probe` (`src/http/probe.ts`), with the token derived from `MINERVA_SECRET_KEY`, and read the Workers' settings with `cf`.

### Startup

Cloudflare refuses to deploy a version whose global scope (everything a module does when it is loaded, before any request) takes more than its startup limit, 1 second on Cloudflare's machines (`10021 Script startup exceeded CPU time limit`); nothing checks it before the upload. Locally, `cf workers check --prebuilt` imports the built Worker's entry in a local workerd (no request reaches the Worker) and reports the CPU of that startup (`activeTimeMs`) without reaching the account, and writes a CPU profile to open in Chrome's DevTools. Its numbers are not Cloudflare's: builds that measured about 160 ms on a recent Mac were refused, one of 158 ms passed. `scripts/startup.ts` takes the best of three such measures and fails above 110 ms (200 ms on GitHub's runners, whose speeds differ: one build measured 85 and 143 ms on two of them; CI deploys only its test instance, and a build Cloudflare would refuse still fails at the upload); `pnpm startup` builds production's entry first, and `pnpm run deploy` runs it on the build it is about to upload (the test build too). Production measured about 55 ms and the test build about 72 ms when this was written.

What keeps startup small is that nothing heavy runs at module scope:

- the connectors (`src/connectors/catalog.ts`: their operations, zod schemas and clients) are imported on first use by `connectorRegistry()`, in a chunk of their own; nothing the entries import statically may import them, which a unit test checks;
- the API router (`src/http/router.ts`, with Better Auth and the contract's procedures) is imported by `src/index.ts` on the first request that needs it;
- formatters and other objects that are costly to build (`Intl.NumberFormat`) are made on first use;
- `@modelcontextprotocol/client`, which the `agents` package's `Agent` class brings in, would build every MCP wire schema at startup in workerd; a patch (`patches/`) leaves that to first use, which never comes, since the Worker does not use MCP.

To see where startup goes, open the profile, or attribute it by module: the bundle in `.cloudflare/output/v0/workers/default/bundle/` marks each source module with `//#region <path>`.

## First deploy

Create the resources once, in this order. `cf deploy` would create a missing database or bucket with default settings (no schema, no lifecycle rule, no jurisdiction), so `pnpm run deploy` first checks that each exists with its settings (`scripts/resources.ts`) and stops otherwise:

```sh
cf d1 create --name minerva-cf --primary-location-hint weur --read-replication-mode disabled
cf r2 buckets create --name minerva-cf-files --location-hint weur
cf r2 buckets create --name minerva-cf-files-eu --cf-r2-jurisdiction eu
cf r2 buckets lifecycle update minerva-cf-files --rules @r2-lifecycle.json --force
cf r2 buckets lifecycle update minerva-cf-files-eu --cf-r2-jurisdiction eu --rules @r2-lifecycle.json --force
cf ai-gateway gateways create --id minerva-cf --collect-logs=false --authentication --cache-ttl 0 --cache-invalidate-on-update=false --rate-limiting-interval 0 --rate-limiting-limit 0 --rate-limiting-technique fixed
```

The lifecycle rules delete `uploads/` objects a day after they were written (a message copies its attachments into the conversation's own blobs first) and `static/` objects 30 days after. `static/` is where the Worker keeps the earlier builds' hashed frontend files, so a page opened before a deploy still finds its chunks; a bucket created before that rule existed needs the `lifecycle update` command above run again (`pnpm run deploy` stops while either rule is missing from either bucket). Then write the instance's `vars.env` (Setup, above) and deploy.

## Deploy

```sh
pnpm run deploy --instance <name>   # builds the frontend, then scripts/deploy.ts: <name>, then <name>-files
```

`scripts/deploy.ts` runs alone: it takes the checkout's lock (`.cloudflare/operations.lock`, shared with `scripts/reset.ts`, since both build into the same `.cloudflare/output/` directories) and then the instance's (its directory's `lock`, which stops two checkouts from changing one instance at once), always in that order; a lock left by a run killed outright is never taken over, and the message says which file to remove. It sends every `cf` command to the instance's account (The instance directory, above), put in the environment of every command (a `.env` file setting a `CLOUDFLARE_` variable where `cf` runs stops it instead, since `cf` would read it there). It does everything that can fail locally before anything on the account changes, with one exception: between steps 1 and 2, it makes sure the account's container registry holds the sandbox's image of `container/` as it is, pushing it only when it is missing (The sandbox image, below). The registry is the account's, shared by its instances and addressed by content, so a push changes no instance. In order:

1. checks the secrets (`scripts/secrets.ts check`: present, the encryption keys in a format the Worker reads, a setup key long enough to claim setup);
2. builds the app (`cf build`), checks that the bundle has none of the test build's code (`scripts/bundle.ts`), and measures its startup CPU locally, stopping above the threshold in `scripts/startup.ts` (Startup, below);
3. builds the download origin (`files-worker/`) and checks it against the app's build (`scripts/builds.ts`): its name, exactly the app's buckets, every bucket the instance's own, the app's `MINERVA_DOWNLOAD_ORIGIN`, and `MINERVA_DOWNLOAD_KEY` as its only secret. A test build that would reach production's Workers or buckets, or the other way round, stops here;
4. reads the account, changing nothing: both origins must be on the account's workers.dev subdomain (Setup, above), and the instance on the account must be the one its directory describes (`scripts/identity.ts`, Identity on the account, below). Once that check has passed, it writes the identity row when it is missing: the first change on the account;
5. checks the resources and applies the migrations in `migrations/` that D1 has not applied yet (`scripts/resources.ts`, which finds the database by name). Migrations are additive, so the running version keeps working;
6. reads the deployed database's schema with `cf d1 query` (SELECT statements only) and compares it with what `migrations/` builds on an empty SQLite database (`scripts/schema-check.ts`, `scripts/schema.ts`): tables, columns (type, NOT NULL, default, primary key), UNIQUE and FOREIGN KEY constraints, indexes, views, triggers, and the list of applied migrations. A table, column, constraint or index that is missing, one no migration made, or a column of another shape stops the deploy (exit 1) with the list of differences; a database it cannot read exits 2. CHECK clauses and collations inside a `CREATE TABLE` are not listed by SQLite and are not compared;
7. uploads the app's build with the instance's `secrets.env` as its secrets, then the download origin's with only `MINERVA_DOWNLOAD_KEY`, written to an owner-only file in a fresh temporary directory that is removed whether the upload succeeds, fails or is interrupted. Each build is uploaded only if it is still the one made and checked in steps 2 and 3 (a digest of its output, taken right after the build), the secrets file only if it is unchanged since step 1, and a build naming another account (`accountId`) stops the deploy. The secrets' values are hidden from everything printed, like the account's ids and the workers.dev subdomain. After the app's upload, the deploy records its version and a digest of its link key in the instance's `deployed.json`, for a later `--files-only`; a `deployed.json` that does not parse stops the deploy.

Both Workers are on workers.dev without preview URLs. `pnpm deploy` without `run` is pnpm's own command. `cf` keeps caches with the account id in `.cloudflare/`, which the repository's `.gitignore` ignores at any depth. `cf deploy` creates a missing database or bucket with default settings when it resolves the bindings. `--no-provision` turns that off, but it also skips the resolution of D1's name to its id, which `cloudflare.config.ts` relies on (it names the database, not its id), so the deploy keeps it on and step 5 checks the resources right before.

### The sandbox image

The sandbox's image is addressed by what `container/` holds (`scripts/image.ts`), not built by `cf build`: `cf` would push a new digest whenever Docker has no cache of its last build, as on every CI runner, and each new digest rolls the container application out to a new image, after which starts stall for minutes. Its tag is `minerva-sandbox:<24 hex>`, a SHA-256 of every entry in `container/` (the whole Docker build context: each path, a file's content and whether it is executable, empty directories too; not the other permission bits, which follow the umask of whoever checked out; a symbolic link stops the deploy). A full deploy asks the account's registry for that tag with five-minute pull credentials (`cf containers registries credentials generate`, whose output is never printed). When the registry has it, the deploy logs `Sandbox image … already exists remotely, skipping the build`; otherwise it builds `container/` for linux/amd64 with `docker build`, checks that `container/` did not change meanwhile, and pushes it with `cf containers push` (unless another deploy pushed the tag in the meantime). It then passes `minerva-sandbox:<tag>@sha256:<digest>` to the build in `MINERVA_SANDBOX_IMAGE`, which `cloudflare.config.ts` gives the container application as `images.base.reference`; `cf deploy` adds the registry and the account and prepares that digest-pinned image, and the application's image is unchanged when `container/` is. The deploy stops if the build does not use that reference. A reset's build and `--files-only`, which upload no image, still build `container/Dockerfile` locally.

The tag covers the inputs, not the bytes: the base images are pinned by digest, but `apt-get` installs current packages, so two builds of one tag can differ, and an image is only rebuilt when `container/` changes. To pick up Debian's updates, change `container/` (bump the base image's digest in the `Dockerfile`). Instances on one account share the repository `minerva-sandbox`; nothing deletes its tags. Two deploys on different machines that build the same new tag at once both push it and the later digest wins the tag; each runs the digest it read, so the next deploy rolls out once more.

**A partial deploy.** The app is uploaded before the download origin, so a failure in between leaves a new app with the previous download origin. They share only the link key and the origin, so links keep working unless one of those changed. Finish with `pnpm run deploy:files --instance <name>` (`node scripts/deploy.ts --test --files-only` for the test instance), with the same secrets file: it builds and checks both again, checks the origins and the identity (writing nothing), checks the resources without applying migrations, checks that the app as deployed (its version serving all traffic) has the local build's buckets and `MINERVA_DOWNLOAD_ORIGIN` and is the version this checkout recorded, with the same link key (which cannot be read back from the account), and uploads the download origin alone. Otherwise it stops: deploy both. A failed app upload leaves the previous version serving with the new migrations applied, which it tolerates since they are additive; deploy again once fixed. Rolling back to an earlier version (`cf workers versions`) is possible for code and settings, but not across a change of the Durable Object classes: a class created, renamed or retired through `exports` changes the namespaces, and an earlier version cannot bring back a retired namespace or its storage (after a reset, below, the earlier versions point at namespaces that no longer exist).

## Identity on the account

An instance's directory says its name and whether it is a test instance; D1 says it too, in `instance_identity` (`migrations/0009_instance_identity.sql`): one row, its name and kind. Every deploy, the lab's included, and every reset, dry runs included, checks before it changes anything that the two agree (`scripts/identity.ts`), so a directory pointed at another instance's resources, or a test instance's at production's, stops there:

```sh
node scripts/identity.ts --instance <name>   # read-only: what the account says the instance is (--test for the only test instance)
```

1. It looks for the table and reads the row, with SELECT statements only. A missing or empty table is no row; a row that disagrees with `instance.json` stops.
2. Without a row, it reads the live app: the bindings of its one version serving all traffic. The test build binds `FAULT_PROVIDER` and `FAULT_MAILBOX` as Durable Objects and has no `EMAIL`; the production build has `EMAIL` and neither. The other kind's build, any other shape, or an app not served by one version stops.
3. With no row and no app it recognises (no Worker yet, or the quiesced Worker of a reset), it passes only if D1 has no tables: a fresh instance, or one whose reset has finished.

Every `cf` call that fails stops it; none counts as "absent". Once it has passed, a deploy and a reset with `--yes` write the table (the migration's own `CREATE TABLE IF NOT EXISTS`, before the migrations run) and the row when the row is missing, as their first change, and read it back. So a first deploy whose migrations fail, or a reset that stops after quiescing (where the live bindings no longer tell: the quiesced Worker binds nothing of its own, and keeps only the app's secrets, which every version inherits), finds the row when run again. A reset deletes D1 last, after the objects and the buckets, so the row goes only once the instance holds nothing. An instance deployed before the table existed gets its row from its next deploy, once its live bindings show its kind.

## The test Worker

The test instance's `minerva-cf-test` is the same code built from `src/faults/index.ts` (`cf build --mode faults`), which adds what the account's fault tests need and production must not have: the fake Notes connector (`src/faults/connector.ts`), its provider as a Durable Object per workspace (`FaultProvider`, which rotates refresh tokens and records every request), fault plans kept in each object's own SQLite and fired at named points of the Conversation's and the Workspace's ports and of the attempt gate (`ctx.abort()`, a memory-limit reset, either one without syncing first, a lost answer, a held step; `src/faults/plan.ts`, `ports.ts`), and a driver at `POST /api/faults/<op>` that answers only with `X-Minerva-Faults-Token: <token>`, derived from the test Worker's own `MINERVA_SECRET_KEY` (a name Workers Logs blank) (`src/faults/routes.ts`, `token.ts`). Its network reaches only the fake provider. The production entry reaches nothing of `src/faults/` or the fake model (`src/model/fake.ts`): a unit test walks its imports, `scripts/bundle.ts` checks the built bundle, and every build but the test build's refuses `MINERVA_MODEL_PROVIDER=fake`. The test build refuses `MINERVA_DEBUG` too. It uses the fake model unless a conversation's plan asks for Workers AI. It also carries the sandbox: its own container application `minerva-cf-test-sandbox` (the image of `container/`, built and pushed by `deploy:test` in about 75 s) behind the same Sandbox object as production's, and the lab at `POST /api/faults/sandbox/<op>` (`src/faults/lab.ts`), which runs that object with seams for the Sandbox fault rows (each hardening step failing, cgroup admission failing, a lost `destroy()`, a restart with a container running) and holds no state of its own: the tests' client `test/account/lab.ts` keeps each sandbox's fence between calls. No other Worker or container application is needed for the sandbox tests.

It is an instance made with `pnpm instances create minerva-cf-test --test` and keeps everything of its own: secrets in its `secrets.env` (`pnpm secrets:test`), settings in its `vars.env` (`MINERVA_SITE_URL=https://minerva-cf-test.<subdomain>.workers.dev`, `MINERVA_DOWNLOAD_ORIGIN=https://minerva-cf-test-files.<subdomain>.workers.dev`, its download origin's, `MINERVA_MODEL_PROVIDER=fake`, `MINERVA_MODEL_NAME=@cf/zai-org/glm-5.3-flash`; the gateway is derived), and resources created once:

```sh
cf d1 create --name minerva-cf-test --primary-location-hint weur --read-replication-mode disabled
cf r2 buckets create --name minerva-cf-test-files --location-hint weur
cf r2 buckets create --name minerva-cf-test-files-eu --cf-r2-jurisdiction eu
cf r2 buckets lifecycle update minerva-cf-test-files --rules @r2-lifecycle.json --force
cf r2 buckets lifecycle update minerva-cf-test-files-eu --cf-r2-jurisdiction eu --rules @r2-lifecycle.json --force
cf ai-gateway gateways create --id minerva-cf-test --collect-logs=false --authentication --cache-ttl 0 --cache-invalidate-on-update=false --rate-limiting-interval 0 --rate-limiting-limit 0 --rate-limiting-technique fixed
```

```sh
pnpm run deploy:test   # scripts/deploy.ts --test: the only test instance (or --instance <name>); builds mode faults (checking the bundle has the fault code), deploys minerva-cf-test, then minerva-cf-test-files
pnpm test:faults       # about 3 minutes: two groups, one after the other:
                       #   first, at once, each file's tests at once:
                       #     faults.test.ts         the fault rows, the local tools in the real Conversation and its container
                       #     sandbox.test.ts        the lab's main container: hardening, pi's conformance suite, the probe, commands, a folder through R2
                       #     sandbox-faults.test.ts the folder's limits and the Sandbox's fault rows, a sandbox each
                       #     turns.test.ts          two end-to-end turns, fake model and Workers AI (skipped, with a message, if the model does not call the tools)
                       #   then alone: resets.test.ts, the memory-limit resets, one at a time (a reset takes every object of its isolate)
```

Before the first group, `test/account/warm.ts` waits until the deployed image starts containers promptly: a deploy that pushes a new image only starts its rollout, and starts in the minutes after it may wait unplaced (a deploy pushes one when `container/` changed: The sandbox image, above). It prepares four sandboxes at once until all four start within 30 s, and fails the suites if a wave still does not after 12 minutes. Files run alone or together with `pnpm test:faults test/account/sandbox.test.ts test/account/sandbox-faults.test.ts`. Each file's afterAll first checks that nothing ran in the 45 s after each run the attempts' cap ended (so a test picked alone with `-t` is still checked), then stops what its tests left running and waits until their containers are destroyed. Most of the time left is waiting the platform out: a 75 s tool across PiHarness's heartbeats, those 45 s, the owed destroy's 30 s alarm, and Workers AI. `MINERVA_SBX_TIMINGS=<file>` makes the sandbox tests measure too (two more prepares, exec and file operation latency, a folder of 50 MB in 500 files instead of 5 MiB in 50) and write their timings as JSON; `MINERVA_TURN_TIMINGS=<file>` does the same for the turns. `pnpm test:faults` does not run code mode's rows (`scripts.test.ts`); they need the lab Worker below.

Which suites a change needs, added up over what it touches (`deploy:test` first whenever `container/` or anything the Worker builds from changed):

| A change to | Run |
|---|---|
| `container/`, `src/sandbox/`, `src/faults/lab.ts` or `src/faults/sandbox.ts` | `sandbox.test.ts`, `sandbox-faults.test.ts`, `faults.test.ts`, `turns.test.ts` |
| `src/conversation/`, `src/workspace/`, `src/files/`, `src/connectors/`, `src/model/`, the rest of `src/faults/` | `faults.test.ts`, `resets.test.ts`, `turns.test.ts` |
| `src/scripts/` | `turns.test.ts`, and `pnpm test:cm` |
| `src/accounts/`, `src/http/`, `src/api/`, `../contract/`, `../frontend/` | the browser walk (below); none of these |
| `cloudflare.config.ts`, `scripts/`, dependencies, the compatibility date, or before deploying production | all of `pnpm test:faults` and the browser walk |

It sends no email: the test build has no Email Sending binding, and its emails go to a `FaultMailbox` object (`src/faults/mailbox.ts`, the newest 500) that the driver reads and empties (`emails`, `emails-clear`). `test/account/browser.test.ts`, run by `pnpm test:browser` after `deploy:test` (about 100 s), drives the frontend the test Worker serves in headless Google Chrome (`playwright-core`, `channel: "chrome"`): sign-up with the emailed code and the setup key, the first-run setup claimed on `/setup`, the instance admin page, sign-in by password, with TOTP and by emailed code, a password reset, an agent, the fake Notes connection, a chat turn with the fake model that writes a file, its download through the app's redirect to `minerva-cf-test-files` (which must then refuse the link unsigned, with its signature or a signed field changed, and expired), a Workers AI turn and sign-out, failing on console errors, uncaught exceptions, failed requests and unexpected statuses. The driver stands in for the fake provider's consent page (`provider-authorize`) and deletes an earlier walk's setup claim first (`setup-reopen`, keeping its admins), so every walk claims the setup through the page. Every account suite checks first that its origins are its instance's own (`scripts/origins.ts`: an https origin `<name>.<subdomain>.workers.dev`, or `<name>-files.<subdomain>.workers.dev` for the download origin, on the same subdomain, and `test/account/client.ts`, `ownOrigins`: that subdomain the account's own) and stops otherwise. The walk fails, rather than skip, without Chrome or the test Worker's settings; `MINERVA_BROWSER_SHOTS=<dir>` keeps a screenshot of every page with its fields masked, and of a failure with what the page showed and its last requests.

Its download origin is `minerva-cf-test-files`, the same `files-worker/` built in mode `faults` (`files-worker/cloudflare.config.ts`): its own name, the test Worker's two buckets, `MINERVA_DOWNLOAD_ORIGIN` from the test instance's `vars.env` (the same file as the test app's, so the app signs links for it) and only `MINERVA_DOWNLOAD_KEY` of its `secrets.env`. The config builds that mode only for a test instance, and `scripts/deploy.ts` checks the built output against the test app's build before either is uploaded (Deploy, above).

Keep it deployed. Never deploy the test build as `minerva-cf`, and never write its origin into tracked files.

### CI's test instance

GitHub Actions runs the account suites on every push to `main` that changes `cloudflare/`, `contract/`, `frontend/`, the workflows or the workspace's package files, and on every manual run (job `account` in `.github/workflows/main.yml`, after `check` and `platform`): `deploy:test`, `test:deployed`, `test:faults` and the browser walk, against a test instance of its own, `minerva-cf-ci`, so that a CI run never overwrites a build someone is testing on `minerva-cf-test`. Runs queue one at a time, and a push that `main` has already moved past is skipped. The design, the token's permissions and the setup are in [docs/plans/ci-account-suites.md](../docs/plans/ci-account-suites.md).

The instance's directory exists only in the secrets of the repository's `ci-instance` environment, which only `main` can read: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `MINERVA_CI_SECRETS_ENV` (its `secrets.env`) and `MINERVA_CI_VARS_ENV` (its `vars.env`). Each run makes the directory afresh with `scripts/ci-instance.ts`, which first registers every value a log could show with GitHub's `::add-mask::` (`scripts/masks.ts`): the account id, the secrets, the fault driver's token, the origins and the workers.dev subdomain. The repository is public, and so are its Actions logs; nothing is uploaded as an artifact. Keeping no copy of the directory on a machine leaves `minerva-cf-test` the only test instance there, so the manual commands still choose it by default.

The suites keep what they made (workspaces, conversations, published files, the browser walk's accounts). Reset the instance when it grows, or to replace its secrets, from a temporary directory, while no run is queued or running:

```sh
dir=$(mktemp -d)
export MINERVA_INSTANCES_DIR=$dir CLOUDFLARE_ACCOUNT_ID=<account id>
pnpm instances create minerva-cf-ci --test
pnpm secrets --instance minerva-cf-ci          # fresh secrets
# write $dir/minerva-cf-ci/vars.env: as the test instance's, with minerva-cf-ci's two origins
pnpm assets
node scripts/reset.ts --instance minerva-cf-ci --test --yes
gh secret set MINERVA_CI_SECRETS_ENV --env ci-instance < "$dir/minerva-cf-ci/secrets.env"
rm -rf "$dir"; unset MINERVA_INSTANCES_DIR CLOUDFLARE_ACCOUNT_ID
gh workflow run main.yml --ref main            # deploys it from empty
```

The token expires a year after it was made; the job then stops at `cf auth whoami`. Code mode's lab (`test:cm`) is not run by CI.

## Resetting an instance

An instance whose data is worth nothing, such as after a change of a stored format, is emptied with `scripts/reset.ts`. It cannot be undone. Without `--yes` it changes nothing and lists what a reset would delete:

```sh
pnpm assets
node scripts/reset.ts --test           # what a reset of the test instance (the only one, or --instance <name>) deletes: objects per class, per bucket and prefix, rows per table
node scripts/reset.ts --test --yes     # the reset
pnpm run deploy:test                   # migrations from empty, every class provisioned afresh, the app
node scripts/schema-check.ts --test    # must pass
```

`--instance <name> --production` does the same for a production instance, which needs both (then `pnpm run deploy --instance <name>`); the flag must be the instance's kind, both in `instance.json` and on the account (Identity on the account, above: the identity check is the first thing it reads there, and with `--yes` it records the row when it is missing), and an instance in use is never reset. Every name comes from the app's build, never from a pattern, and each must be the instance's own (`<name>`, `<name>-files`, `<name>-files-eu`). It takes the same locks and pins the same account as a deploy (Deploy, above). Before changing anything the script checks that the Worker, its database and its buckets exist on that account, that the Worker has no Durable Object namespace of a class its build does not export, that every container application linked to its namespaces is one its build names (`<name>-sandbox`, matched exactly), and that no bucket has a setting its recreation would lose (CORS, domains, notifications, locks, a lifecycle rule not exactly as in `r2-lifecycle.json`); it runs the schema check read-only (drift, exit 1, is expected; any other answer stops the reset); and it prints no identifier. It deploys the quiesced build only if it is still the one it checked. Then, in this order:

1. **Quiesce, and delete the Durable Objects.** It deploys `reset-worker/` as the instance's Worker: it answers 503 to every request, has no binding of its own (the Worker keeps its secrets, which every version inherits), and lists every class of the app's build as an `exports` tombstone (`exports.durableObject({ state: "deleted" })`, the supported way to delete a class declared through `exports`: [Durable Objects migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)). Cloudflare then deletes each class's namespace with all of its objects' storage and alarms, wherever the objects are located, EU included; `cf deploy` prints the reconciliation (`Deleted: Conversation, …`). The script waits until the Worker has no namespace left and its container applications run no instance, then deletes those applications (`<name>-sandbox`): they stay linked to the retired Sandbox namespace, and the next deploy cannot move them to the new one (`cf` stops with "could not finish applying its Durable Object-managed Container application settings"), and creates them again from the image already in the registry.
2. **Empty and recreate the buckets.** Each bucket, its jurisdiction explicit, is listed and deleted in pages of up to 1,000 keys until a listing is empty (`static/` included). The empty bucket is then deleted, which R2 refuses while a multipart upload is in progress (the app creates none; `cf` cannot list or abort them, the S3 API can), and created again with its jurisdiction, location and storage class, and `r2-lifecycle.json`; the script checks afterwards that its rules are exactly the file's and that it is empty.
3. **Recreate the database.** D1 is deleted and created again empty, with its location (or jurisdiction) and replication mode. This comes last: D1 holds the identity row, which a reset that stopped earlier finds when run again.

The instance answers 503 until the next deploy applies the migrations to the empty database and provisions every class as a new namespace. Its earlier Worker versions point at namespaces that no longer exist, so none can be rolled back to (Deploy, above). A reset that stops leaves what it did done and says where it stopped; run it again (after creating a missing bucket or database with the First deploy commands, if it says so).

## Code mode's lab

`minerva-cf-test-cm` (`<name>-cm` of the test instance, `test/account/scripts-worker/`) is a Worker of its own for code mode's account tests (`test/account/scripts.test.ts`): production's Scripts object and conversation-side runner (`src/scripts/`) behind `Lab`, a stand-in conversation with the run's queue and fake tools, plus variants of the Scripts object that load guests through an awaited loopback entrypoint or never reset themselves, so the tests can show what ends a guest that ignores its stop. It holds no data and no secret but its driver token, and is deployed only while its tests run:

```sh
pnpm run deploy:cm   # scripts/deploy.ts --lab: deploys minerva-cf-test-cm with the test instance's cm.env (CM_TOKEN="…"), with its locks and account, after checking the identity and the lab's origin
pnpm test:cm         # the lab's origin in its cm.vars.env (CM_ORIGIN=https://minerva-cf-test-cm.<subdomain>.workers.dev, on the account's subdomain)
cf workers delete minerva-cf-test-cm --force   # afterwards; read the output, since an aborted delete exits 0
```

Never write the lab's origin or token into tracked files.

The lab's conversation is a stand-in, so `run_script` in the real Conversation on the account is exercised by `test/account/turns.test.ts` on the test Worker.
