# Chunk 1b: the account suites from CI

Status: design, 2026-10-14. Part of [product-and-engine.md](product-and-engine.md), chunk 1b. opencode reviewed the first draft; its findings are folded in below, and the ones not taken are under Accepted.

## Decisions (the owner's, 2026-10-14)

- **A CI-only test instance, `minerva-cf-ci`.** CI never deploys or tests `minerva-cf-test`, so a manual run and a CI run cannot overwrite each other's build. The locks in `scripts/run.ts` are files on one machine and protect nothing across machines.
- **No staging engine yet.** Nothing calls one until Laravel's staging does (chunk 3); it is added then. Production stays deployed by hand.
- **The suites run on engine and app changes only:** pushes to `main` that change anything under `cloudflare/`, `contract/`, `frontend/` or `.github/workflows/`, or `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` (`cloudflare/README.md` is under `cloudflare/` and counts), and every manual run (`workflow_dispatch`). Other pushes skip them.
- **The owner creates everything on the account and in GitHub:** the resources, the API token, the environment and its secrets. No value passes through an agent.
- **Code mode's lab (`test:cm`) stays manual.** It deploys a Worker that must be deleted afterwards; run it by hand for `src/scripts/` changes and before deploying production.

## The job

Two jobs added to `.github/workflows/main.yml`; `check` and `platform` stay as they are and unconditional.

**`changes`** runs on every push and manual run and always sets its output `run`: `true` for `workflow_dispatch`; otherwise it fetches full history and runs `git diff -z --name-only --no-renames <before> <sha>` (the two endpoints, deletions and renames out of a path included, paths unquoted whatever their characters) and matches the paths against `ACCOUNT_PATHS`, a workflow-level variable both jobs read. An all-zero or unreachable `before`, or any git error, gives `true`. The output is `true` when a path matches.

**`account`**, `needs: [check, platform, changes]`, `if: needs.changes.outputs.run == 'true'`:

- `environment: ci-instance`, a GitHub environment whose deployment branches are `main` only, holding the secrets. A workflow run on another ref cannot read them.
- `concurrency: { group: account-suites, cancel-in-progress: false, queue: max }`. A suite stopped midway skips its `afterAll` cleanup, so runs queue rather than cancel, and `queue: max` keeps every pending run (by default GitHub keeps one and cancels the others, a manual run included).
- **Freshness.** Queued runs do not start in push order (a newer commit's `check` can finish first), so for a push the job first fetches `main` (no credentials needed in a public repository) and skips the rest when `main` has moved past the commit with changes to the account paths: the run of the newest such commit tests them. Newer commits that change none of them (docs) do not skip it, since their own runs skip the suites. A failure to fetch or compare runs the suites, which at worst deploys an older build until the next run. A manual run tests the commit it was started on.
- `permissions: { contents: read }`, `timeout-minutes: 40`, `ubuntu-24.04` (Docker and Google Chrome preinstalled; the sandbox image is amd64, as the runner is). Checkout pins `github.sha`, without persisted credentials.
- Steps, `working-directory: cloudflare`:
  1. Checkout, pnpm, Node 24, `pnpm install --frozen-lockfile`. No secret is in these steps' environment.
  2. `node scripts/ci-instance.ts` (new), with the four secrets in its environment only, and `MINERVA_INSTANCES_DIR` set in a shell step to `$RUNNER_TEMP/instances` and exported through `$GITHUB_ENV`. It:
     - refuses a `MINERVA_INSTANCES_DIR` that exists, then creates it (700) and the instance with `createInstance(…, "minerva-cf-ci", true)`, `recordAccount` and `writeInstanceFile` (scripts/instance-files.ts: 700 and 600, atomic, no links);
     - before writing anything, prints `::add-mask::` for every value a log could show: the account id; every secret as dotenv parses it and as each line's raw remainder (`hideSecrets`'s two readings, scripts/run.ts); the fault driver's token derived from `MINERVA_SECRET_KEY` (`faultsToken`, src/faults/token.ts), which the suites send and a failure could print; both origins, their hosts and the workers.dev subdomain. Values are escaped for workflow commands (`%`, CR, LF) and nothing else is printed. The mask lines are built by a pure function with a unit test.
  3. `pnpm run deploy:test --instance minerva-cf-ci`: the frontend, the build in mode `faults` and every check of a deploy, the migrations, the sandbox image and both Workers. The first run, on an empty D1, records the identity row.
  4. `pnpm test:deployed --instance minerva-cf-ci`: the deployed instance's headers, EU probes, migrations and preview URLs, which the deploy's own checks do not cover.
  5. `pnpm test:faults --instance minerva-cf-ci`, then `pnpm test:browser --instance minerva-cf-ci`. `MINERVA_BROWSER_SHOTS` stays unset and nothing is uploaded as an artifact: a public repository's artifacts are public.
  6. Always, last: `rm -rf "$MINERVA_INSTANCES_DIR"` (the runner is discarded anyway).
- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are in the environment of steps 3 to 5 only; `MINERVA_INSTANCE=minerva-cf-ci` in the job's. No shell step runs with `set -x`.

## The owner's setup

The instance's directory exists only in GitHub's secrets, which cannot be read back. A copy on the owner's machine would make two test instances there, and the manual commands that pick "the only test instance" (`deploy:test`, `test:faults`, `secrets:test`, …) would then stop and ask for `--instance`. Everything below that needs the directory uses a temporary one under its own `MINERVA_INSTANCES_DIR`.

1. **Resources**, once (cloudflare/README.md, The test Worker, with the CI name), with the owner's own `cf` login, in `cloudflare/`:

   ```sh
   cf d1 create --name minerva-cf-ci --primary-location-hint weur --read-replication-mode disabled
   cf r2 buckets create --name minerva-cf-ci-files --location-hint weur
   cf r2 buckets create --name minerva-cf-ci-files-eu --cf-r2-jurisdiction eu
   cf r2 buckets lifecycle update minerva-cf-ci-files --rules @r2-lifecycle.json --force
   cf r2 buckets lifecycle update minerva-cf-ci-files-eu --cf-r2-jurisdiction eu --rules @r2-lifecycle.json --force
   cf ai-gateway gateways create --id minerva-cf-ci --collect-logs=false --cache-ttl 0 --cache-invalidate-on-update=false --rate-limiting-interval 0 --rate-limiting-limit 0 --rate-limiting-technique fixed
   ```

   The container application `minerva-cf-ci-sandbox` is created by the first deploy.
2. **The API token** (dashboard, My Profile → API Tokens → Create custom token), for the one account, no zone, expiring in a year:
   - Account → Workers Scripts: Edit (deploys, versions, deployments, the workers.dev subdomain)
   - Account → D1: Edit (migrations, the identity row, the schema check)
   - Account → Workers R2 Storage: Read (the buckets' settings and lifecycle rules)
   - Account → AI Gateway: Read (the gateway's settings)
   - Account → Containers: Edit (the image push and the application)
   - Account → Account Settings: Read (so `cf auth whoami` lists the account, which `pinAccount` requires)

   This is the set the scripts' `cf` calls need on paper; the first manual run tests it. A permission missing there fails a step with Cloudflare's 403, and is added to the token and to this list.
3. **The environment and its secrets**, from the repository root:

   ```sh
   gh api -X PUT repos/minervacomputing/harness/environments/ci-instance -F 'deployment_branch_policy[protected_branches]=false' -F 'deployment_branch_policy[custom_branch_policies]=true'
   gh api -X POST repos/minervacomputing/harness/environments/ci-instance/deployment-branch-policies -f name=main -f type=branch
   dir=$(mktemp -d)
   MINERVA_INSTANCES_DIR=$dir pnpm --dir cloudflare instances create minerva-cf-ci --test
   MINERVA_INSTANCES_DIR=$dir pnpm --dir cloudflare secrets --instance minerva-cf-ci
   gh secret set MINERVA_CI_SECRETS_ENV --env ci-instance < "$dir/minerva-cf-ci/secrets.env"
   ```

   Then write `$dir/minerva-cf-ci/vars.env` in an editor (the account's workers.dev subdomain in place of `<subdomain>`):

   ```sh
   MINERVA_SITE_URL=https://minerva-cf-ci.<subdomain>.workers.dev
   MINERVA_DOWNLOAD_ORIGIN=https://minerva-cf-ci-files.<subdomain>.workers.dev
   MINERVA_MODEL_PROVIDER=fake
   MINERVA_MODEL_NAME=@cf/zai-org/glm-5.3-flash
   ```

   ```sh
   gh secret set MINERVA_CI_VARS_ENV --env ci-instance < "$dir/minerva-cf-ci/vars.env"
   rm -rf "$dir"
   gh secret set CLOUDFLARE_API_TOKEN --env ci-instance    # prompts for the token
   gh secret set CLOUDFLARE_ACCOUNT_ID --env ci-instance   # prompts for the account id
   ```
4. **The first run**, by hand: `gh workflow run main.yml --ref main`. It deploys the instance and tests the token.

## Upkeep

- **Data accumulates.** The suites stop what they ran and destroy their containers, but keep their workspaces, conversations, published files (one fault test alone publishes 250 MB a run) and the browser walk's accounts; the buckets' lifecycle rules expire only `uploads/` and `static/`. The owner resets the instance when it grows (monthly is plenty; the R2 dashboard shows its size).
- **Resetting it**, or replacing its secrets: in a quiet moment (no run queued or running, see the Actions tab), with the owner's own `cf` login:

  ```sh
  dir=$(mktemp -d)
  export MINERVA_INSTANCES_DIR=$dir CLOUDFLARE_ACCOUNT_ID=<account id>
  pnpm --dir cloudflare instances create minerva-cf-ci --test
  pnpm --dir cloudflare secrets --instance minerva-cf-ci        # fresh secrets
  # write $dir/minerva-cf-ci/vars.env as in step 3
  pnpm --dir cloudflare assets
  (cd cloudflare && node scripts/reset.ts --instance minerva-cf-ci --test --yes)
  gh secret set MINERVA_CI_SECRETS_ENV --env ci-instance < "$dir/minerva-cf-ci/secrets.env"
  rm -rf "$dir"; unset MINERVA_INSTANCES_DIR
  gh workflow run main.yml --ref main
  ```

  The reset deletes every object, bucket key and table, so the old secrets protect nothing afterwards and new ones are safe to use; the next run deploys from empty.
- **A run killed by its timeout** leaves its containers until their own sleep ends; the next run does not clean them up. A reset does.
- **The token expires in a year**; a run then fails at `cf auth whoami`.

## Accepted

- **The token can change production.** `minerva-cf` is on the same account, and an account-scoped token cannot be limited to some Workers or databases. Only `main`'s workflow can read it (the environment's branch policy), and only the owner pushes to `main`. A separate Cloudflare account for CI would remove this; it is not worth a second account while production holds only the operator's test data, and it should be revisited before production has users.
- **Resource ids in the logs.** `cf deploy` prints the version and container application ids, which nothing hides. They are not account identifiers (AGENTS.md's list) and open nothing without the token.
- **Masking matches exact strings.** A value printed transformed (URL-encoded, split across lines) is not masked. The suites print origins in failure messages as they are, and the browser walk already redacts its URLs (test/account/browser.test.ts).
- **Out-of-order manual runs.** A manual run of an older commit deploys it; the next push's run deploys `main` again.

## Docs

`cloudflare/README.md` (The test Worker, Checks) and `AGENTS.md` (Git, Checks) say that CI runs the account suites against `minerva-cf-ci` and when, that its directory lives only in GitHub, and how to reset it and replace its secrets (Upkeep, above, moved there). `product-and-engine.md` records 1b as built, with the staging engine moved to the chunk where Laravel's staging first calls the engine.
