# Agent notes

Operational notes for coding agents working in this repository: Minerva's open harness, the engine that runs agent turns on Cloudflare (`cloudflare/`), with the React app it serves (`frontend/`) and the API contract they share (`contract/`). Self-hosting is not supported. For background, read [README.md](README.md) and [ARCHITECTURE.md](ARCHITECTURE.md); for development, testing and deploys in detail, [cloudflare/README.md](cloudflare/README.md). Work in progress is planned in [docs/plans/](docs/plans/), the current one in [docs/plans/product-and-engine.md](docs/plans/product-and-engine.md).

## Environment

Prerequisites: Node 24 and pnpm 10 (`pnpm install` at the root installs the whole workspace); Docker only to run the sandbox locally; the `cf` CLI, signed in, only for anything on the account.

Settings are text bindings, parsed by `cloudflare/src/config.ts` when the Worker is built (`cloudflare/cloudflare.config.ts`); secrets are Worker secrets. Where they come from depends on the build:

| Build | Settings | Secrets |
|---|---|---|
| Local dev server (`pnpm dev:offline`) | Defaults for localhost, overridden by the shell's `MINERVA_*` | `cloudflare/.dev.vars`, made on first start (`pnpm secrets:offline`) |
| Platform tests | The shell, else throwaway values in `vitest.platform.config.ts` | The same throwaway values |
| A deployed instance | Its `vars.env` only, never the shell | Its `secrets.env`, uploaded by the deploy |

An instance's files live outside the checkout, in `~/.config/minerva/instances/<name>/` (cloudflare/README.md, The instance directory). Ours are `minerva-cf` (production) and `minerva-cf-test` (the test instance, built with fault points). `.dev.vars`, `secrets.env` and every `.env*` file hold secrets: never print, commit or copy their values. To check a value, report only whether it is set.

**Secrets:** `MINERVA_SECRET_KEY`, `MINERVA_ENCRYPTION_KEYS` (`id:secret` entries, comma separated; the first encrypts), `MINERVA_DOWNLOAD_KEY`, `MINERVA_SETUP_KEY` (claims an instance's first admin, once), `MINERVA_LARAVEL_TOKEN` (optional: the Sanctum token Laravel issues for this engine, declared once set), `MINERVA_STREAM_KEYS` (optional: the keys of the stream tokens Laravel signs, `id:secret` entries with secrets of 32 bytes or more in URL-safe base64, shared with Laravel; declared once set, and Laravel's run stream `/stream/v1` is off without them), and connector clients, `MINERVA_<APP>_CLIENT_ID` and `_SECRET` (an unset pair hides that app's connectors; Todoist registers its own client; setup per app in [docs/connectors.md](docs/connectors.md)). `pnpm secrets --instance <name>` writes fresh ones and never prints them.

**Settings** (defaults in `cloudflare.config.ts`):

| Variable | Default | Notes |
|---|---|---|
| `MINERVA_SITE_URL`, `MINERVA_DOWNLOAD_ORIGIN` | `http://localhost:5173`, `http://localhost:8788` | A deployed build needs its own workers.dev origins, https |
| `MINERVA_DEBUG` | `false` (`true` offline) | Emails go to the log; the seed route exists. A deployed build refuses it |
| `MINERVA_MODEL_PROVIDER` | `workers-ai` (`fake` offline) | `workers-ai`, `openai`, `anthropic`; `fake` only in the test build's entry |
| `MINERVA_MODEL_NAME` | `@cf/zai-org/glm-5.3-flash` | |
| `MINERVA_MODEL_API` | `chat` | `responses` for upstreams that have it |
| `MINERVA_MODEL_MAX_OUTPUT_TOKENS` | `8192` | |
| `MINERVA_MODEL_REASONING_EFFORT`, `MINERVA_MODEL_REASONING_SUMMARY` | empty | |
| `MINERVA_SIGNUP_OPEN` | `true` | An instance admin can override it |
| `MINERVA_EMAIL_FROM` | `Minerva <noreply@localhost>` | The sender the `EMAIL` binding accepts |
| `MINERVA_RUN_TIMEOUT_SECONDS` | empty (none) | A deadline per turn |
| `MINERVA_FILES_*` | 256 MB and 10,000 entries per folder, 50 MB per file, 10 per message | A conversation's folder, also the size of the sandbox's `/workspace` |
| `MINERVA_ENVIRONMENT`, `MINERVA_ACCESS_ISSUER`, `MINERVA_ACCESS_AUDIENCE`, `MINERVA_ACCESS_CLIENTS` | empty (the internal API is off) | All four or none: the environment Laravel's commands must name, and the Access application (`https://<team>.cloudflareaccess.com`, its audience tag, the service tokens' client ids, comma separated) whose assertion `/internal/` checks. Account identifiers: only in an instance's `vars.env` |
| `MINERVA_LARAVEL_URL` | empty | Laravel's origin, https when deployed, for the engine's requests and facts, and the only origin CORS lets read `/stream/v1` |

`MINERVA_MODEL_GATEWAY` is not a setting: every build sets it to the instance's name.

## Starting the app

No Cloudflare account is needed:

```sh
pnpm --dir cloudflare dev:offline   # the Worker on http://127.0.0.1:8787: the fake model, local D1 and R2, the sandbox if Docker runs
pnpm --dir frontend dev             # the app on http://localhost:5173, which proxies /api to the Worker
pnpm --dir cloudflare run seed      # with both running: ada@example.com and grace@example.com, password `password`
```

Open <http://localhost:5173>. Seeding creates or resets the two accounts (password, verified email, two-factor removed) and signs out their sessions; the route exists only with `MINERVA_DEBUG`. Emails (sign-in and verification codes) are printed in the Worker's output. Local state is in `cloudflare/.cloudflare/state`. In the desktop app, `.claude/launch.json` has both servers (`cf-offline`, `cf-frontend`).

**Port in use:** if the Worker or Vite cannot bind its port, another copy is running. Stop it rather than starting a second one.

## Git

This project does not use pull requests. Commit directly to `main` (or merge a short-lived branch into it) and push `main`.

`main` is the engine. Every push to `main` runs `.github/workflows/main.yml`: the frontend's check, the contract's and the engine's types, the engine's unit tests (job `check`) and its platform tests (job `platform`); then, when the push changed `cloudflare/`, `contract/`, `frontend/`, the workflows or the package files, the account suites against the CI-only test instance `minerva-cf-ci` (job `account`; cloudflare/README.md, CI's test instance). Production and `minerva-cf-test` are deployed by hand. When the workflow fails, read which job and step failed. Its logs are public: never add a step that prints a secret, an account identifier or an origin.

The public demo runs from the `demo` branch, which keeps its own copy of the Django stack, frozen until the hosted product replaces it. Never merge `main` into `demo`, and do not copy changes from `main` to `demo`. A fix the demo itself needs is committed on `demo` only, and the demo is deployed only from `demo`.

**This repository is public** (`github.com/minervacomputing/harness`). Everything you commit is published, history included. Never commit:

- secrets (they belong in an instance's directory, `cloudflare/.dev.vars`, or `.env*` files, all outside the repository or gitignored);
- personal data: real people's email addresses, phone numbers, or names other than the author credit in the README;
- server details: IP addresses, provider hostnames, SSH users;
- account identifiers: cloud project IDs, OAuth client IDs, Stripe account IDs, Apple team and key IDs, Cloudflare account, zone and tunnel IDs, workers.dev subdomains, and the test instance's origins.

Use reserved `.example` domains and placeholders in docs, tests and seed data. Notes for the operator that need real identifiers, such as prompts for browser agents, stay outside the repository (or in `deploy/demo/private/`, which stays gitignored). Check the staged diff for these before every commit.

## Cloudflare

Use Cloudflare's [`cf` CLI](https://developers.cloudflare.com/cf/) (npm package `cf`, a dev dependency of `cloudflare/`), not Wrangler. Find commands with `cf cli search "<task>"` and preview API changes with `--dry-run`. A destructive command without `--force` in a non-interactive shell prints `Aborted.` and still exits 0, so read the output or check the resource.

- The engine's own scripts (`pnpm run deploy`, `deploy:test`, `scripts/reset.ts`, the account suites) pin the instance's account and check its identity before they change anything; use them rather than `cf` by hand.
- The test instance (`pnpm run deploy:test`, `pnpm test:faults`, `pnpm test:browser`) is for the account suites a change needs (cloudflare/README.md, The test Worker).
- **Ask first** before deploying or resetting production, creating or deleting resources on the account, and any change to tunnels, Access policies or DNS. The demo sits behind a tunnel.

## Second opinions with opencode

Use opencode as a read-only subagent for code review, adversarial review, or critiques of plans. Always use the `plan` agent (it does not edit files) with `--auto` (no permission prompts):

```sh
git diff | opencode run --agent plan --auto "Adversarially review this diff for bugs and security issues."
opencode run --agent plan --auto -f plan.md "Critique this plan: what is wrong, risky, or missing?"
```

- Input can be piped on stdin or attached with `-f`.
- Add `-c` to ask a follow-up in the same session.
- Its output is advice. Verify each finding before acting on it.
- Run `git status` afterwards. The `plan` agent should not change anything, but `--auto` approves any shell command that is not explicitly denied.

## Checks

In `cloudflare/`:

```sh
pnpm typecheck       # cf's generated types, then tsc for the Worker, the Node scripts and the download Worker
pnpm test:unit       # Vitest in Node: lib/, the executor, policy, connectors, the objects' logic, rules on the sources
pnpm test:platform   # the Worker in local workerd: Durable Objects, D1, R2, the protocols' fault tests, the frontend's client
pnpm test:docker     # the Sandbox against the real image (needs Docker and `pnpm sandbox:image`)
pnpm startup         # the Worker's startup CPU, which Cloudflare limits
```

`pnpm check` in `frontend/`, and `pnpm typecheck` and `pnpm openapi:check` in `contract/`, complete what the workflow runs. The suites on the account (`test:deployed`, `test:faults`, `test:browser`, `test:cm`) and which ones a change needs are in cloudflare/README.md; CI runs all but `test:cm` on its own instance after a push, so run them by hand on `minerva-cf-test` when a change needs them before it is pushed.

## Frontend

In `frontend/`:

```sh
pnpm check    # oxlint (with type-aware rules), oxfmt --check, tsc, knip (unused files, exports, dependencies) and the unit tests; run before every commit
pnpm format   # oxfmt writes the formatting
pnpm test     # the unit tests alone (vitest)
```

Types and lint:

- The workspace (`frontend/`, `contract/`, `cloudflare/`) typechecks with TypeScript 7 (`tsc` is the native compiler). It has no stable compiler API (7.0 ships only `typescript/unstable/*`): the one test that parses TypeScript (`cloudflare/test/unit/sources.test.ts`) imports TypeScript 6's API from `@typescript/typescript6`. Editors need TypeScript 7's language server (VS Code: the `TypeScriptTeam.native-preview` extension) or their own bundled TypeScript.
- oxlint's type-aware rules run through `oxlint-tsgolint`, whose version follows TypeScript's (7.0.2003 is for 7.0.2): update the two together. The rules are in `frontend/.oxlintrc.json`: promises must be awaited, returned or marked `void` (and only where nothing can reject), no `any` flows on, and a type assertion that narrows needs a disable comment saying why it holds, as at the server's answers that nothing validates.

The API's endpoints are declared once in `contract/` (oRPC: method, path, input, output and errors). The Worker implements them in `cloudflare/src/api/` and the frontend calls them through `lib/orpc.ts`, so a change to an endpoint changes the contract, its procedure and its callers in one commit.

The internal API between Laravel and the engine is `contract/src/internal/` ([docs/plans/contract.md](docs/plans/contract.md)). A change to it also regenerates its OpenAPI documents (`pnpm --dir contract openapi`, committed; CI fails when they are stale), which Laravel keeps copies of. Until chunk 8 of the product plan runs a turn between deployed sides, `v1` changes freely; after that, only additively, and a new kind of fact or a newly required input is deployed to the receiving side first.

Tests:

- Unit tests are `src/**/*.test.ts` on pure modules: plain inputs and outputs, inline data, Node without a DOM.
- No component tests (`*.test.tsx`, Testing Library, jsdom), no module mocks (`vi.mock`), and no parameters or injection that exist only for a test. The linter enforces the first two.
- The client's integration tests run against the Worker in `cloudflare/test/platform/frontend-*.test.ts` (`pnpm test:platform` in `cloudflare/`).
- An export that only those integration tests use says so with `@public` in its doc comment, so knip leaves it.
- What users see is checked by the browser walk, `cloudflare/test/account/browser.test.ts`, against the deployed test Worker.
