# Plan: email through the operator's zone

Status: design, 2026-10-14; nothing is built. This is unit 3 of [self-hosting-and-cloud.md](self-hosting-and-cloud.md), Part 1. It follows unit 2 ([instance-names.md](instance-names.md)) and keeps its conventions: the checkout's lock before the instance's, atomic owner-only writes, symbolic links refused, `--instance` to choose, and every failed `cf` call stops the command. opencode reviewed a first draft, and its findings are folded in. Setup (unit 4) creates the sending subdomain and reuses the check below.

## Why

A production instance sends its sign-in and reset codes through the `EMAIL` binding (Email Sending), and only from `MINERVA_EMAIL_FROM`'s address (`cloudflare.config.ts`, `allowedSenderAddresses`). The operator's own sign-up waits for such a code before it can claim the instance.

Today nothing checks the sender. A vars file without `MINERVA_EMAIL_FROM` deploys with the default `noreply@localhost`. A sender that is not a verified sending subdomain on the account deploys too. Either way, the failure shows only when someone tries to sign in.

The check below covers the sender's syntax and its Email Sending and DNS configuration. It does not test delivery.

## Decisions

### The zone and how it is recorded

- **The zone is recorded in `instance.json`**, as `"zone": "example.com"`, beside the account. It is where the instance lives on Cloudflare, not a setting of the build; `vars.env` holds only what the Worker reads.
- **It is the zone's name, not its id.** The check looks the name up in the instance's account each time.
- **The name's syntax.** Lowercase ASCII, with no trailing dot. At least two labels, each of letters, digits and inner hyphens and at most 63 characters, and at most 253 characters in all. An internationalised name is written in its `xn--` form.
- **Only a production instance has a zone.** `parseInstance` refuses a zone on a test instance.
- **`pnpm instances zone <name> <zone>` records it**, as a new subcommand of `scripts/instances.ts`:
  1. It takes the instance's lock.
  2. It chooses the account as `pinAccount` does: the recorded one, else `CLOUDFLARE_ACCOUNT_ID`, else the only one cf reaches. `pinAccount` gets an option to choose without recording.
  3. It checks the zone on that account (The check, step 2). A zone that fails records nothing, not even the account.
  4. It writes the account, if it is new, and the zone together. A new `recordPlacement` in `instance-files.ts` rereads `instance.json` from disk under the lock and stops if its account changed meanwhile, so no write starts from a snapshot taken before pinning.
- **Writes keep the zone.** `recordAccount` builds its JSON from the file as reread, not from the `Instance` it was given, so it keeps the zone. Today `pinAccount` discards the `Instance` that `recordAccount` returns. That is harmless while nothing else is stored there, but not once a zone is.
- **Replacing and listing.** A second run replaces the zone and prints the old and the new name. `pnpm instances list` adds "no zone recorded yet" for a production instance without one.
- **Existing instances.** `minerva-cf` has no zone. Its next deploy stops with the message below, which gives the command. Nothing guesses the zone from the sender.

### The sender's syntax

A new module, `src/accounts/mailbox.ts`, holds `parseFrom` (moved from `emails.ts`, which imports it) and `senderAddress(from)`. It imports nothing, so `src/config.ts` can use it: today `emails.ts` imports `config.ts`, and a call the other way would be a cycle.

`senderAddress` accepts `Name <mailbox>` or a bare mailbox, read by `parseFrom` exactly as the Worker reads it. It returns `{ name, address, domain }` or a problem.

- **The mailbox is a deliberately small subset.**
  - Its local part is an ASCII dot-atom: RFC 5322 atext, with no leading, trailing or doubled dot. That excludes spaces, commas and double quotes, so quoted local parts are refused.
  - The local part is at most 64 characters, and the address at most 254.
  - The domain follows the zone-name rules, compared lowercased.
  - Non-ASCII is refused anywhere in the mailbox.
- **The display name is kept as `parseFrom` gives it**, non-ASCII included. The Worker passes `{ name, email }` to the binding unchanged (`emails.ts`), so this unit does not narrow it.
- **The whole value.** It must be non-empty, and must have no control characters (a quoted dotenv value can hold a newline).
- **Nothing sent changes.** Only the comparisons lowercase the domain.

### The build refuses a bad sender

`checkBuild` (`src/config.ts`), which the real config already calls, takes the value as written in `vars.env`, before the defaults apply. For a deployed production build, a missing value, or one `senderAddress` refuses, stops the build: "`MINERVA_EMAIL_FROM` is not set in `<vars.env>`: a production instance sends its sign-in codes from it, from a sending subdomain of its zone (cloudflare/README.md, Email)." Test builds and the local modes keep the `localhost` default.

`deploy.ts --files-only` builds the app too, so a bad sender stops it as well. That is accepted: the repair is the same vars file.

### What counts as verified

The sending row's `enabled`, `preview_enabled` and `drop_suppressed_recipients` must be booleans, and `dns status` must answer a `status` string and an `errors` array.

- **Pass:** `enabled` is true, `preview_enabled` and `drop_suppressed_recipients` are false, `status` is `"ready"` and `errors` is empty.
- **Not ready** (exit 1), when `status` is anything but `ready`, or `errors` is not empty.
  - With errors listed, the check prints the records to repair, each error's `code` and record name. A missing record will not appear by waiting.
  - `ready` with errors is refused too. Only dashboard wording counts an unlocked record as fine, which is not firm enough to deploy on.
  - With no errors and a status other than `ready`, it prints the status as Cloudflare gave it, and says the records may still be propagating. An unfamiliar status is not presented as certainly pending.
- **Unsupported answer** (exit 2), when a field the check uses is missing or has another type. The message says so rather than guess.
- **Previews off.** Since 2026-07-02, Cloudflare turns message previews on for new sending domains, and keeps the body of each sent message (our codes) for about seven days. A row with `preview_enabled` true is refused, with the command that turns it off: `cf email-sending subdomains update <id> --zone <zone> --preview-enabled=false --drop-suppressed-recipients=false`. `create` takes only a name, so setup (unit 4) runs that `update` right after `create`, before anything is sent.
- **Suppressed recipients.** A row with `drop_suppressed_recipients` true is refused, with the same command. `sendEmail` awaits `env.EMAIL.send` (`src/accounts/emails.ts`). With dropping off, a send to a suppressed address rejects, and the request fails visibly. With dropping on, the code would vanish silently.

### Which domains count

- **The zone.** The sender's domain must equal the zone's name, or end in `.` plus it.
- **The sending row.** The zone's `subdomains list` must have exactly one row whose `name`, lowercased, is that domain.
- **Wildcard rows** (`*.<zone>`) are intentionally unsupported, though Email Sending can send under them. The check looks only in the recorded zone and resolves no DNS.
- **The apex is allowed:** `preview` accepts the zone's own name. Its records then go on `cf-bounce.<apex>` and `_dmarc.<apex>`, so the README recommends a subdomain such as `notify.<zone>`.

### No override

When the API is down, the deploy stops, as it does when the identity check cannot read D1.

## The check

Two modules, like `account.ts` beside `identity.ts`:

- **`scripts/sender.ts` does no work at import.** It holds:
  - the pure judges of cf's answers, `zoneVerdict` and `sendingVerdict`;
  - `checkSender(instance, account, from)`, which makes the cf calls through `run.ts` and throws `NotReady` (exit 1) or `Unsupported` (exit 2). A failed call throws `CommandFailed` (exit 2).

  It never pins: callers pass the account they pinned.
- **`scripts/email.ts` is the thin, read-only CLI**:

  ```sh
  node scripts/email.ts --instance <name>   # 0 verified; 1 not ready, or not this zone's; 2 could not run, or an unsupported answer
  ```

  It chooses the instance, pins the account without recording one (`record: false`), and reads the sender from `instanceVars`. The deploy passes the account it already pinned, and the sender from the checked app build (`app.env.MINERVA_EMAIL_FROM.value`), as the origins check does.

`checkSender` runs these steps in order:

1. **The sender.** `senderAddress(from)` must succeed.
2. **The zone.** It must be recorded: "`<name>` has no zone recorded: its sign-in codes go out through Email Sending, from a sending subdomain of a zone on its account. Record it with `pnpm instances zone <name> <zone>`."
   - `cf zones list --name <zone> --account-id <account> --per-page 50` answers an array.
   - Exactly one zone must have that `name`, the account as `account.id`, `status` `"active"`, `type` `"full"` (DNS on Cloudflare), and an `id` of 32 hexadecimal characters.
   - Otherwise: "The zone `<zone>` is not an active zone on `<name>`'s account with its DNS on Cloudflare (`<what differs>`)."
   - The id is hidden from all output. Every later call passes `--zone <id>`, so cf never resolves the name itself.
3. **In the zone.** If the sender's domain is not the zone or below it: "`MINERVA_EMAIL_FROM`'s domain `<domain>` is not in the zone `<zone>`."
4. **The sending row.** `cf email-sending subdomains list --zone <id>` answers an array of objects. Each object has:
   - `id` and `tag` (equal today);
   - `name`, `enabled`, `preview_enabled`, `drop_suppressed_recipients`;
   - `return_path_domain` (`cf-bounce.<name>`), `dkim_selector`, `created`, `modified`.

   The check uses `id`, the documented `<subdomain-id>`, which must be a non-empty string. Its refusals:
   - no row for the domain: "`<domain>` is not a sending subdomain of `<zone>`: create it (cloudflare/README.md, Email)";
   - two rows for it;
   - the row disabled: "Sending from `<domain>` is disabled";
   - previews on, or suppressed recipients dropped: the `update` command above.
5. **Its DNS.** `cf email-sending subdomains dns status <id> --zone <id>` answers `{records, errors, status}`. The messages follow the verdict above.
   - Each record is `{name, content, type, ttl, priority?}`.
   - Each error is `{code, missing?}`, with codes such as `mx.missing`, `spf.missing` and `dkim.missing`.
   - With errors listed: "`<domain>`'s DNS records need repair (`<code> <record name>`, …): compare them with `cf email-sending subdomains dns status`, and fix them." The fix command, `cf email-sending subdomains dns fix`, is not run by this unit.
   - Without errors: "`<domain>` is not ready: Cloudflare says `<status>`. DNS changes can take minutes, at most a day: check with `cf email-sending subdomains dns status`, and deploy again once it is ready."

**In the deploy**, step 4 reads the account in this order, visible in `deploy.ts`:

1. `checkOnAccount` (the origins);
2. `checkSender`;
3. `checkIdentity`, whose `--record` makes the deploy's first write.

The step's title becomes "its origins, its sender and its identity". It skips `checkSender` for a test instance ("The test build sends no email: no sender to check."), for `--files-only`, whose app is not uploaded although it is built, and for `--lab`. The local modes have no instance, and `offline` and the platform tests write emails to the log, as before.

## The README

`cloudflare/README.md` gets a section, Email, between Setup and First deploy, which points to it. It says:

- the instance needs a zone in its account with its DNS on Cloudflare;
- it sends from a sending subdomain of that zone;
- Email Sending is in beta, with quotas per account;
- message previews must stay off, because they would keep the codes;
- suppressed recipients must not be dropped, so that a code that cannot be delivered fails visibly.

Raw `cf` commands go to whichever account the shell chooses. So the section starts with `export CLOUDFLARE_ACCOUNT_ID=<the account in instance.json>`, which can be left out when cf reaches only one account. The commands use placeholders only:

```sh
pnpm instances zone <name> example.com
cf email-sending subdomains preview --name notify.example.com --zone example.com   # read-only: the records it would add, and conflicts
cf email-sending subdomains create --name notify.example.com --zone example.com    # MX, SPF and DKIM on cf-bounce.notify…, DMARC on _dmarc.notify…
cf email-sending subdomains list --zone example.com                                # the new row's id
cf email-sending subdomains update <id> --zone example.com --preview-enabled=false --drop-suppressed-recipients=false   # before anything is sent
cf email-sending subdomains dns status <id> --zone example.com                     # wait for "status": "ready" and no errors
```

Then: set `MINERVA_EMAIL_FROM=Minerva <noreply@notify.example.com>` in `vars.env`, run `node scripts/email.ts --instance <name>`, and deploy. The section ends with the apex advice. Deploy's step 4 and the `instance.json` line in The instance directory gain the zone.

## Tests

The unit tests run on plain inputs, with no account, no module mocks, and no injection used only by tests.

- **`test/unit/email-zone.test.ts`**
  - `senderAddress`:
    - accepts: the name and bare forms, a non-ASCII display name, an uppercase domain, the apex, `xn--` labels, atext such as `+` and `'`, and both length limits exactly;
    - refuses: empty, `localhost`, one label, a trailing dot, a label too long, a leading or trailing hyphen, two `@`, no local part, a leading, trailing or doubled dot, a quoted local part, a space or a comma, non-ASCII in the local part or the domain, a newline, and a local part or address one character too long.
  - `zoneVerdict`, on recorded answers to `zones list` with placeholder ids:
    - passes one active, full zone;
    - stops on: none, two, another account, `pending`, `partial`, a different name, a malformed id, and a non-array answer, which is unsupported.
  - `sendingVerdict`, on recorded answers to `subdomains list` and `dns status`:
    - passes `ready` with no errors;
    - not ready, with repair advice: `ready` with errors, and another status with `mx.missing`;
    - not ready, with propagation advice: an unfamiliar status with no errors, printed as given;
    - refused: no row, two rows, a wildcard row only, `enabled` false, `preview_enabled` true, `drop_suppressed_recipients` true, the apex with and without a row, a domain outside the zone;
    - unsupported: a missing status, a non-boolean `enabled` or `drop_suppressed_recipients`, a missing `id`, `errors` not an array, a row that is not an object.
- **`instance-directory.test.ts`.** A zone is parsed and validated, and refused on a test instance. `recordAccount` and `recordPlacement` keep what the file on disk holds. `recordPlacement` stops when the account on disk changed.
- **`config.test.ts`.** `checkBuild` refuses a missing sender (the default's case) and a malformed one in a deployed production build. A test build and a local build accept both.

## Verification

1. **Production's settings.** Production's row has previews on. Turning them off (with `--drop-suppressed-recipients=false`, which it already has) changes Email Sending settings, so the implementing agent asks the owner first. Then:
   - `pnpm instances zone minerva-cf <our zone>`;
   - `node scripts/email.ts --instance minerva-cf`, which must refuse while previews are on, and exit 0 once they are off.
2. **The refusals**, read-only, against a scratch production instance `email-try` that has only a directory: `pnpm instances create`, then `pnpm instances zone` with our zone. With its `vars.env` set to each sender below in turn, `scripts/email.ts --instance email-try` must refuse with the matching message:
   - none;
   - an address on `example.com`;
   - an address on an unknown subdomain of our zone;
   - an address at our apex, which has no row.

   `pnpm instances zone email-try example.com` must then refuse, and leave `email-try`'s `instance.json` (account and zone) unchanged.
3. **A refused zone records no account.** Make a second fresh scratch instance, `email-try-2`, with no account recorded. `pnpm instances zone email-try-2 example.com` must refuse and leave its `instance.json` without an account.
4. **The order in the deploy.** Give `email-try` secrets (`pnpm secrets --instance email-try`) and origins on our workers.dev subdomain. Set a sender that passes `senderAddress` but has no sending row, such as an address on `example.com`. Then `pnpm run deploy --instance email-try` must:
   - pass the builds and the origins;
   - stop at the sender, before the identity step;
   - leave nothing on the account, checked read-only: `cf workers scripts search --name email-try` and `cf d1 list` show no `email-try` Worker or database, so no identity row could have been written.

   Then remove both scratch directories.
5. **The skips.** On the test instance, `pnpm run deploy:test`, `node scripts/deploy.ts --test --files-only` and `pnpm run deploy:cm` each print that the sender check is skipped. They make no `cf email-sending` call, since the skip returns before `checkSender` runs. Then the test instance's suites pass.
6. **A deploy of production.** Production has no users besides its owner. `pnpm run deploy --instance minerva-cf` must print the sender check passing before the identity check. Then run `pnpm test:deployed --instance minerva-cf`.
7. **Delivery, by the owner.** The owner requests a sign-in code on production and confirms that it arrives. Agents do not use the owner's mailbox.

A real pending answer can only be seen by creating a sending subdomain, so unit 4 sees it first. If its shape differs from what is recorded here, unit 4 corrects `sendingVerdict`.

## Size

About 300 lines of code and 200 of tests: `mailbox.ts`, `sender.ts` and `email.ts`, the zone field, subcommand and `recordPlacement`, `pinAccount`'s option to choose without recording, `checkBuild`, the deploy's step, and the README section. One fresh agent builds it. opencode reviews the diff, and it is committed on `cloudflare`. Then the status lines are updated: in this file, and in self-hosting-and-cloud.md (unit 3, and Where things stand).

## Not in this unit

- Creating the subdomain, `preview`'s conflict check, and waiting for `ready` (unit 4).
- Email at volume (Part 2).
- Custom domains for the origins (instance-names.md, open question 1).
