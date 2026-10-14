# Plan: instances by name

Status: plan, 2026-10-13; sub-units 2a (derived names), 2b (the instance directory) and 2c (identity on the account) are done, 2026-10-14. Only production's identity deploy is left (Verification, 4), which waits for the user. 2c's verification: `deploy:test` wrote the test row and the test suites passed, the reset's dry run reported the identity and `--production` stopped it, and `minerva-cf-try` was deployed, passed `test:deployed`, was reset, deployed again and reset again, then deleted. Its first deploy stopped at the upload (a transient Cloudflare error) after writing the row, and the next run found the row. It also showed that the quiesced Worker keeps the app's secrets, which the check now reads as quiesced, and that the edge's `JSON.parse` no longer has the escaped-key bug. This is unit 2 of [self-hosting-and-cloud.md](self-hosting-and-cloud.md), Part 1. It starts after frontend cleanup A3 is committed, because A3 also changes `test/account/browser.test.ts`. opencode reviewed a first draft, and its findings are folded in.

## Why

Every deploy, reset and account test names our two instances. `minerva-cf` and `minerva-cf-test` appear as literals in:

- the three Worker configs (`cloudflare.config.ts`, `files-worker/`, `reset-worker/`);
- six scripts: `deploy`, `resources`, `schema-check`, `bundle`, `reset` and `secrets`;
- the account suites, the lab's config and its `deploy:cm` script;
- unit and platform fixtures.

Their operator files have fixed paths:

- `.env.cloudflare`, `.env.cloudflare.vars`, the matching `-test` pair, and `.env.cloudflare-cm*`, all at the repository root;
- `cloudflare/.cloudflare/deployed.json` in the checkout.

So deploying under any other name means editing code, and one checkout can hold only one production and one test instance. A worktree deploys only after those files are copied into it.

After this unit, an instance is a name plus a directory that belongs to its operator, and no code names ours. Setup (unit 4) will create the resources and the directory in one command. This unit makes everything else work for any name.

## What an instance is

- **A name, fixed for the instance's life.** The app Worker holds the Durable Object namespaces, so a Worker under a new name starts with no data.
  - It uses lowercase letters, digits and single hyphens, starts with a letter and does not end with a hyphen.
  - It is at most 54 characters, so the longest derived name (`<name>-files-eu`) stays within the 63-character limit for Workers and buckets. AI Gateway ids allow 64.
  - It does not end in a suffix the derivation uses (`-files`, `-files-eu`, `-sandbox`, `-cm`). Otherwise an instance `acme-files` would collide with the download Worker of an instance `acme`.
  - It is not `default`. AI Gateway creates a gateway with that id by itself, with logging on.
- **Whether it is a test instance.** A test instance runs the test build (`src/faults/`, mode `faults`); every other instance runs the production build. This is recorded in the instance's directory and in its D1 database (see Identity on the account below), and is never inferred from the name.
- **An account.** It is recorded by the first command that pins an account for the instance, before that command changes anything.

Each name is derived from the instance's name by one function:

| Resource | Name | Ours |
|---|---|---|
| App Worker, D1 database, AI Gateway | `<name>` | unchanged |
| Download Worker | `<name>-files` | production's unchanged; the test instance's `minerva-cf-files-test` becomes `minerva-cf-test-files` |
| Buckets | `<name>-files`, `<name>-files-eu` (EU jurisdiction) | unchanged |
| Container application | `<name>-sandbox`, matched exactly | unchanged |
| Code mode's lab (test instances only) | `<name>-cm` | `minerva-cf-cm` becomes `minerva-cf-test-cm` |

Our instances keep every resource that holds data. Two Workers get new names:

- The test instance's download Worker serves R2 through bindings and holds nothing. Download links signed for its old origin stop working, which is acceptable for the test instance.
- The lab exists only while its tests run.

`MINERVA_MODEL_GATEWAY` stops being a setting. The build sets it to the instance's name and refuses a vars file that sets it. This prevents a configuration mistake; it does not limit what the account's AI binding can reach.

Every mode other than `production` and `faults` reaches no account and needs no instance: `offline` for the dev server, `test` for the platform tests, and cf's default mode for `pnpm build` and `cf workers types`. These modes use fixed local names, `minerva-dev` and `minerva-local`, so typechecking never asks for an instance and no code names one of ours. The dev server's local D1 keeps `OFFLINE_D1_ID`, but its local Durable Objects and buckets start fresh under the new names. The local Docker tag `minerva-cf-sandbox:local` becomes `minerva-sandbox:local`.

## The instance directory

Operator state moves out of the checkout, into one directory per instance:

```
~/.config/minerva/instances/<name>/   ($XDG_CONFIG_HOME is honoured; MINERVA_INSTANCES_DIR replaces the whole path)
  instance.json   {"name": "…", "test": false, "account": "…"}
  secrets.env     was ../.env.cloudflare, ../.env.cloudflare-test
  vars.env        was ../.env.cloudflare.vars, ../.env.cloudflare-test.vars
  deployed.json   was this instance's entry in cloudflare/.cloudflare/deployed.json
  cm.env          the lab's token, test instances only; was ../.env.cloudflare-cm
  cm.vars.env     the lab's origin; was ../.env.cloudflare-cm.vars
  lock            held by any command that writes here or changes the instance's account
```

**Why outside the checkout:**

- The state belongs to the instance, not to one copy of the code. Every worktree and every checkout of a newer release deploys the same instance with the same keys; an upgrade (unit 6) is a checkout of a newer tag.
- The lock in the directory stops two checkouts on one machine from changing one instance at once. Nothing serializes other machines or CI: unit 9 runs account jobs one at a time on its own.
- A directory inside the repository would have to be copied into every worktree, and would be lost with a deleted checkout. Losing `MINERVA_ENCRYPTION_KEYS` loses every stored credential, so the guide (unit 8) tells operators to back the directory up.
- CI (unit 9) writes an instance directory from its secrets into a temporary `MINERVA_INSTANCES_DIR`. If that path is inside a checkout, it must be ignored by git, or every command stops.

**How it is read and written:**

- The directory is mode 700 and its files 600, owned by the user. Symbolic links are refused at every level (checked with `lstat`, unlike `secrets.ts`'s `statSync` today).
- `instance.json` must name its own directory, with `test` a boolean and the account an account id. A malformed instance stops the listing, rather than vanishing from it and leaving a different instance as the only one.
- Writes go to a temporary file in the same directory and are then renamed into place. A `deployed.json` that does not parse stops the command; today it reads as empty.
- Generating secrets takes the instance's lock too.
- Nothing in the directory is printed. The account id and the workers.dev subdomain are hidden, as they are today.

Two things stay in the checkout because they belong to it: `cloudflare/.dev.vars` (the dev server's settings) and the checkout's lock on `.cloudflare/output/`. A command takes the checkout's lock first, then the instance's.

## Choosing the instance

- **Account-changing scripts take `--instance <name>`.** A production instance is never chosen by default. `pnpm run deploy`, `deploy:files` and `reset.ts` on a production instance need its name, so a script run from an old release or an experimental branch cannot reach production by accident.
- **A test instance has a default.** `pnpm run deploy:test`, `test:faults`, `test:cm` and the browser walk use the only test instance when no name is given. With none, or several, the command stops and lists the names.
- **`MINERVA_INSTANCE` is for commands that take no flags of ours:** `cf build`, vite and vitest. The scripts set it for every command they run.
  - Order of precedence: `--instance`, then `MINERVA_INSTANCE`, then the only test instance (test commands only). A flag that disagrees with `MINERVA_INSTANCE` stops the command.
  - Mode and kind must agree, so a build in mode `faults` for a production instance stops.
- **The scripts are the only supported way to change an account.** Running `cf deploy` by hand skips the checks, as it does today. A `--prebuilt` upload reads the build output and never reads the config again, so `MINERVA_INSTANCE` cannot retarget an earlier build.
- **One module, `scripts/instance.ts`, resolves an instance:** its directory, `instance.json`, the derived names and the checks above. The configs, the scripts and the account suites all use it, and nothing else builds a name. The configs are type-checked with the Worker's types, so the module reaches Node's modules the same way they do (`process.getBuiltinModule`).

## Identity on the account

The literals give two kinds of safety today. Both stay, now keyed on the instance.

- **The build.**
  - `scripts/bundle.ts` checks that the build is the instance's (`<name>`) and that it contains the test build's code exactly when the instance is a test instance.
  - `filesBuildProblems` (`scripts/builds.ts`) checks that the download origin is `<name>-files`, over exactly `<name>-files` and `<name>-files-eu`.
  - `ownContainer` matches `<name>-sandbox` exactly, instead of any `<name>-<word>`.
- **The kind, recorded in D1.**
  - A migration adds `instance_identity`, one row holding the name and whether the instance is a test instance. Its `CREATE TABLE IF NOT EXISTS` lets the deploy create the table before the migrations run.
  - Once the identity check below has passed, the first write of a deploy or a reset is that table and its row, when they are missing. Only then do the migrations or the quiescing run. A first deploy whose migrations fail, or a reset that stops after quiescing, therefore still has the row on the next run, even where the live bindings are gone.
  - A reset deletes D1 last (after the objects and the buckets). A deleted database is the only way to lose the row, and by then the instance holds nothing.
- **The identity check.** Every deploy and every reset, a dry run included, checks the instance's identity before anything on the account changes, which means before the migrations. Every failed `cf` call stops the check; none counts as "absent".
  1. It looks for `instance_identity` in `sqlite_master` and, if the table is there, reads its row, both with read-only queries. A missing table counts as no row, not as a failure. A row that disagrees with `instance.json` stops the command.
  2. Without the row, it reads the live app's bindings from its one version serving all traffic, as `liveApp` does today. A test build binds both `FAULT_PROVIDER` and `FAULT_MAILBOX` as Durable Objects and has no `EMAIL`; a production build has `EMAIL` and neither of those. Any other shape is unknown, and an unknown shape, or the other kind, stops the command.
  3. With no row and no recognisable app (no Worker yet, or the quiesced Worker of a reset), the check passes only if D1 has no tables: a fresh instance, or one whose reset has finished.
- **Resetting a production instance** needs both `--instance <name>` and `--production`, and the flag must agree with the identity. `--test` is checked the same way. Today the reset only checks that the Worker's namespaces are classes its build exports, and that cannot tell a test instance from production.
- **The account.**
  - `pinAccount` pins the account in `instance.json`. If `CLOUDFLARE_ACCOUNT_ID` is set, it must be the same account.
  - Before the account is recorded, it pins as it does today (the environment's account, or the only one `cf` reaches) and writes the account down before changing anything.
  - The account suites pin it too; today their `cf` calls go to whichever account `cf` reaches.
- **The origins.** Only workers.dev is configured today. So the build checks that a deployed build's origins are its own Workers there, on one subdomain:
  - `MINERVA_SITE_URL` must be `https://<name>.<subdomain>.workers.dev`;
  - `MINERVA_DOWNLOAD_ORIGIN` must be `https://<name>-files.<subdomain>.workers.dev`.

  The deploy and the account suites then compare that subdomain with the account's own. A vars file copied from another instance, or from another account, therefore stops the command. The lab's origin is checked the same way, as `<name>-cm`. Today the lab accepts any https origin.
- **Leftover files.** While any `.env.cloudflare*` file remains at the repository root, every script stops and prints the command that moves it, so no one edits a file that is no longer read. This check is removed at the merge into `main` (unit 10).

## The account suites

`pnpm test:account` today runs both `deployed.test.ts`, which probes production, and the browser walk, which needs the test instance. One selection cannot serve both, so the two split:

- **The browser walk** joins the test-instance suites. It refuses a production instance.
- **`deployed.test.ts`** becomes `pnpm test:deployed --instance <name>` (with `MINERVA_INSTANCE` under vitest), for any instance, and needs the name.
- **`test/account/client.ts`** stops loading `.env.cloudflare.vars` into `process.env` when it is imported. Each suite reads its own instance's parsed settings and secrets, and an origin in the shell's environment no longer overrides them.
- **The lab** is deployed through the scripts (`deploy:cm` goes through `deploy.ts --lab`, with the pin and the locks), from the test instance's `cm.env`. `MINERVA_ENV_DIR` goes.

## Sub-units

One fresh agent works on each sub-unit, in order. Every commit leaves `deploy:test` and the account suites working, since the other sessions deploy the test instance from the main checkout. Each sub-unit ends with its tests passing, an opencode review of the diff, a commit on `cloudflare`, and README updated for what changed.

1. **2a. Derived names.** `scripts/instance.ts` gets the names and their validation, and is still chosen by today's flags (`--test` means `minerva-cf-test`; otherwise `minerva-cf`) and today's files.
   - The configs, scripts and suites take their names from it, including `run.ts`'s messages and `package.json`'s scripts.
   - `MINERVA_MODEL_GATEWAY` is derived, and the local modes and the Docker tag are renamed.
   - The test download Worker and the lab move to their new names. Our test vars file's `MINERVA_DOWNLOAD_ORIGIN` and the lab's `CM_ORIGIN` change to match, and `MINERVA_MODEL_GATEWAY` is removed from both vars files.
   - Unit and platform fixtures use `acme`.
   - Then, on the account: `deploy:test`, `test:faults`, the browser walk, `deploy:cm` and `test:cm`, and `cf workers delete` of `minerva-cf-files-test` and `minerva-cf-cm`, reading the output, since an aborted delete still exits 0.
2. **2b. The instance directory.** The directory with its rules, choosing an instance, both locks, `deployed.json`, and recording and pinning the account.
   - Every reader of the operator files moves to the directory in the same commit: the configs, `secrets.ts`, `deploy.ts`, `reset.ts`, the account suites (now split) and the lab's deploy.
   - Our files move into `minerva-cf/` and `minerva-cf-test/`. The agent moves them by hand, keeping their modes, and splits `deployed.json`'s entries per instance. The steps go in the commit message.
   - The leftover-files check.
   - Today's mapping from `--test` to our names goes. A unit test then searches the code (`src/`, `scripts/`, `test/`, the configs, `package.json`) for `minerva-cf` and finds nothing.
   - Tests use `acme` and cover:
     - every rejected name and every rejected directory: a symlink, a wrong mode, a name that doesn't match, a malformed file;
     - choosing an instance with zero, one and two test instances, with no default for production, and with a flag and `MINERVA_INSTANCE` that disagree;
     - a mode that disagrees with the kind;
     - a vars file that sets the gateway;
     - origins that belong to another instance.
   - Then the same account runs as in 2a.
   - As built: `pnpm build` and `pnpm startup` build in mode `standalone` (vite reserves `local`) under the local name, with no instance, and no instance may take a local name. Online `pnpm exec vite` (mode `development`) stays local but sends model turns through a test instance's gateway (`MINERVA_INSTANCE`, or the only test instance). `reset.ts` already requires `--test` or `--production` to match `instance.json`'s kind; 2c adds the agreement with the identity row. The account suites run through `scripts/suite.ts` (vitest takes no flag of ours) and pin the recorded account without recording one.
3. **2c. Identity on the account.**
   - The `instance_identity` migration, and the identity check in the deploy (before the migrations) and in the reset (before the dry run's listing).
   - The reset's flags.
   - Comparing the origins' subdomain with the account's.
   - `test/unit/deploy-checks.test.ts` and `schema-check.test.ts` rewritten around `acme`, with the identity check's cases: a row, no table, no row with each binding shape, an unknown shape, a quiesced Worker with tables, a quiesced Worker without tables, and a failed `cf` call. Interruptions are covered too: a first deploy that stops after writing the row, and a reset that stops after quiescing.
   - Correct the comment in `deploy.ts` (and the README's matching sentence) that says `cf deploy`'s creation of missing resources cannot be turned off. `--no-provision` exists, but it also skips the D1 name-to-id resolution the config relies on.
   - Then the verification below.

## Verification (end of 2c)

1. **The test instance.** `deploy:test` writes the test instance's identity row. Then run the test instance's suites.
2. **A reset dry run.** `node scripts/reset.ts --test` without `--yes` reports the identity and lists only the test instance's resources. Run with `--production`, it stops.
3. **A third name.** Create a production instance `minerva-cf-try`, with its resources made by the README's commands. Then:
   - deploy it;
   - check it with `pnpm test:deployed --instance minerva-cf-try`;
   - reset it with `--production --yes`;
   - delete its resources and its directory.

   This shows that a name that is not ours works for the production build, without touching production.
4. **Production waits for the user.** Its names do not change, so its next deploy changes no resource. That deploy records its account and writes its identity row, after the live-bindings path recognises it as a production build. As with any deploy of production, ask the user first.

## Not in this unit

- Creating resources (`pnpm run setup`, unit 4), the email domain (unit 3) and release records (unit 6). Unit 6 adds its history beside `instance_identity`.
- **A secrets file that no longer matches the deployed instance.** Suppose a directory's `MINERVA_ENCRYPTION_KEYS` lost the key the instance encrypts with. A deploy from it would make every stored credential unreadable. The check needs the instance to say which key ids it holds, or a key-check value kept in D1. It belongs with setup and upgrades (units 4 and 6).

## Open questions

1. **Custom domains** for the app and the download origin: hostnames as settings, and routes in the two configs, instead of workers.dev only. The origins check would then accept the instance's own custom hostnames.
