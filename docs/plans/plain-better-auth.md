# Plan: plain Better Auth

`cloudflare/src/accounts/` wraps Better Auth 1.7.7 in about 1,300 lines of policy of our own: Django's password validators and its common-password list, a scrypt format of our own with rehashing, allauth's rate-limit actions counted in D1, credential stamps on every session with placeholder sessions for the second factor, a TOTP replay guard, an `AsyncLocalStorage` scope that carries what a request learned between Better Auth's hooks, a signed cookie that binds a password to the browser that set it before its address is verified, and allauth's email texts. Most of it reproduces what Django and allauth did. This plan replaces it with Better Auth's defaults and keeps only what Better Auth does not do at all.

Part 2 of the carryover search ([sandbox-sdk.md](sandbox-sdk.md)) is done; this is Part 1.

## Principles

- Use Better Auth as documented: its options, its plugins, its hasher, its limiter, its flows. Code of our own is the exception, and each piece names what Better Auth lacks.
- No feature parity with allauth or Django. There are no users whose behaviour must be kept; existing test accounts may need a password reset.
- Anything our code needs to keep stays small enough to read in one sitting.

## What Better Auth already does

- **Pre-registered accounts.** Someone can register an address they don't own and set a password, waiting for the owner to verify it. `/sign-in/email-otp` handles this: for an unverified user, `revokeUnprovenAccountAccess` deletes every account link and session, then marks the address verified. The owner gets no password, OAuth link or session that someone set up beforehand. `/email-otp/verify-email` does not do this; it keeps the password. That gap is why A1 added the binding cookie.
- **Sign-up with an email code.** With the email-OTP plugin's `disableSignUp` off, `/sign-in/email-otp` creates a verified user the first time an address proves its code. For an unknown address while sign-up is off, `/email-otp/send-verification-otp` answers like it does for a known one and sends nothing, and `/sign-in/email-otp` refuses the code.
- **Passwords.**
  - scrypt (N 16384, r 16, p 1). An unknown address costs one hash.
  - Its verify compares the derived keys as hex strings, not in constant time. That leaks nothing usable: an attacker controls neither the salt nor the derived key.
  - `minPasswordLength`.
  - `revokeSessionsOnPasswordReset`.
  - `revokeOtherSessions` on `/change-password`.
  - `/email-otp/reset-password` creates the credential when the user has none.
  - `setPassword` (server-only) for a user without one.
- **Limits.**
  - Per-IP limiter with `customRules`, stored in D1.
  - Email-OTP `allowedAttempts` per code.
  - Two-factor's own lockout and attempts per challenge.
- **Two-factor.**
  - TOTP and backup codes.
  - Its after-hook replaces a first factor's session with a challenge cookie.
  - Trusted devices: a caller who sends `trustDevice: true` with a second factor gets a signed cookie, and that device skips the second factor for 30 days, even after a password reset. Our client never sends it, but any caller can.

## What stays ours

1. **The route allowlist** (`BROWSER_ROUTES`, `handleAuth`). Every other Better Auth endpoint answers 404. Better Auth's `disabledPaths` is a denylist, so an upgrade that adds an endpoint would open it.
2. **Two-factor after an email code.** Two-factor's hook matches `/sign-in/email`, `/sign-in/username` and `/sign-in/phone-number`, not `/sign-in/email-otp`. The `everyFirstFactor` wrapper (about 10 lines, with its guard that the plugin has exactly one after-hook) sets the matcher to `/sign-in/email` and `/sign-in/email-otp`.
3. **Sign-up open or closed, per request.** `handleAuth` already builds one Better Auth instance per request. For the two code routes it reads `signupAllowed(env, headers)` (the admins' setting, `MINERVA_SIGNUP_OPEN`, or the setup key before setup) and passes it as the email-OTP plugin's `disableSignUp`. Every other route, and server code, builds with sign-up off. `emailAndPassword.disableSignUp` is always on: no user is made from a password.
4. **Setting the first password.** Sign-up sends no password to Better Auth. After the code signs the new user in, the client sends the password from the sign-up form to one route of ours, which calls `auth.api.setPassword` with the request's headers (about 20 lines).
   - Better Auth refuses it when the user already has a password, as with someone who signed up with an address that already had an account; the client then says so.
   - It goes where `/api/me` is when this unit runs: a Hono route today, or the oRPC contract if the frontend's A3d has merged.
   - It lives outside `/api/auth/`, so our CSRF check and JSON reader apply.
   - Better Auth's limiter doesn't run for `auth.api` calls, and `setPassword` hashes before it checks for an existing password. So the route first checks in D1 that the user has no password, and answers 409 without hashing if they do.
   - `sensitiveSessionMiddleware` needs a valid session, not a fresh one.
5. **Provisioning hooks** (`user.create.after`, `session.create.after`), unchanged.
6. **The JSON reader in front of Better Auth** (`readJson`, `plainJson`). It works around a workerd parser bug, not an auth policy.
7. **The per-IP numbers** (`ip-limits.ts`): configuration for `customRules`, trimmed to the routes left. Keep the test that every browser route has a rule.
8. **Better Auth's secret** stays `derive(MINERVA_SECRET_KEY, "better-auth")`. It signs the cookies and encrypts the two-factor secrets and backup codes already stored. Only the derivations for stamps, limits and the email-code HMAC go.
9. **Emails:** two short texts of our own, a sign-in code (also used for sign-up) and a password reset code. Keep the mail transport, `checkMailer` and the test capture.

## What goes

| Our code | Replaced by |
|---|---|
| `passwords.ts` (our scrypt format, `needsRehash`, `HASHING`, Django's four validators, `quickRatio`) and `common-passwords.ts` | Better Auth's hasher and `minPasswordLength: 10` |
| `rate-limits.ts` (allauth's actions per address and per user, the `rate_limits` table) | The per-IP limiter, `allowedAttempts`, two-factor's lockout |
| Credential stamps (`credentialStamp`, `revokeStale`, `sessionTokens`, the rehash's stamp carry-over) | `revokeSessionsOnPasswordReset`; the client sends `revokeOtherSessions: true` on a password change. There is no email change. |
| Placeholder `PENDING` sessions and challenge stamps | Two-factor's own hook |
| `totp.ts` and `totp_steps` (a TOTP code is accepted once) | Nothing: Better Auth accepts a code during its ±1-step window (about 90 s) |
| The binding cookie, `emailVerifying`, the conditional sign-up and password writes (`accountCreating`, `accountUpdating`), `userCreating`, `sessionCreating`, `verificationCreating` ("only the newest code works", codes withheld) | Sign-up by email code: no unverified accounts are made, and the code route revokes anything an unverified account had |
| `scope.ts` (`AsyncLocalStorage`) | Nothing: no hook needs per-request state |
| `/sign-up/email`, `/email-otp/verify-email` and the email-verification options | `/email-otp/send-verification-otp` (type `sign-in`) and `/sign-in/email-otp` |
| The "Account already exists" and "Unknown account" emails, and allauth's texts | The two new texts |
| Stripping the trusted-device cookie | Nothing (see above) |
| `policy.ts` as a class | `BROWSER_ROUTES` moves next to `handleAuth`; nothing else is left of it |

### Accepted trade-offs

The owner chose plain Better Auth over these:

- **No per-account limit on password guesses**, only per IP. A distributed attacker isn't slowed down per account. Two-factor covers it for users who turn it on. A Cloudflare WAF rate-limiting rule on `/api/auth/sign-in/email` is an operations option outside this plan.
- **No per-address limit on code emails**, only per IP. Someone with many IPs can fill an inbox with sign-in codes.
- **Trusted devices** (Better Auth's default, see above): a caller who passed the second factor can have the device skip it for 30 days, and a password reset doesn't end that. Our client doesn't offer it.
- **A TOTP code can be reused** within its window. RFC 6238 says it should not be, but a code observed in that window is also usable by whoever watched it typed.
- **Races** that the stamps closed, such as a session made while a reset runs, can leave that one session alive until it expires or is revoked.
- **A password change in flight can overwrite a reset** ([auth-fixes.md](auth-fixes.md), finding 2). Better Auth's change reads the credential, hashes twice, then writes without a condition, so a change that read before the owner's reset wrote its password can write after it. The owner's reset reports success, and the attacker's password is the one that works, with the attacker's browser still signed in. The attacker needs the current password and a live session, second factor passed, and has to keep changes in flight across the owner's reset. Accepted (owner, 2026-10-13): that attacker can already lock the owner out more simply by putting their own authenticator on the account, which no reset removes; recovery from the authenticator is a reset by email code, then an instance admin removing the user's two-factor and sessions (auth-fixes.md, C3). A fix would replace Better Auth's write with a compare-and-swap hook of our own.
- **Hashes in our old format don't verify.** Migration 0007 deletes those credential rows. Those users sign in with an email code, or reset their password.
- **The deploy is a cutover.** Migrations run before the new code is uploaded, and 0007 drops what the old Worker reads and writes, so auth requests fail for the seconds in between, or until a failed upload is retried. There are no users to keep up; a production deploy is asked for first, as always.
- **The platform tests hash with production parameters** now that `HASHING` is gone. Measure the suite before and after. If it gets much slower, say so; don't add a test-only hook.

## Units

Done in sequence, each by a fresh subagent in the `plain-auth` worktree (branched from `cloudflare`). opencode reviews each diff before its commit. Merge into `cloudflare` after B2.

**B1. The Worker on plain Better Auth.**

- `auth-options.ts`:
  - Default hasher, `minPasswordLength: 10`, `revokeSessionsOnPasswordReset`, `emailAndPassword.disableSignUp: true` and `requireEmailVerification: true`.
  - No `emailVerification` block, no `session.additionalFields`.
  - Email-OTP with `disableSignUp` from `AuthDeps`, `allowedAttempts: 3` and `storeOTP: "encrypted"`, keyed by Better Auth's secret, replacing our HMAC. `"hashed"` would be unsalted SHA-256 of six digits, which anyone with the database reverses at once.
  - `everyFirstFactor` for the two first factors.
  - The policy plugin and the policy's database hooks removed; provisioning hooks kept.
- `auth.ts`: `handleAuth` with the allowlist, the JSON reader and the per-request sign-up flag. `currentSession` is a plain `getSession`, and `policyFor` and `derive` for stamps and limits go.
- `emails.ts`: the two texts.
- The set-password route (see "What stays ours", item 4).
- Delete `passwords.ts`, `common-passwords.ts`, `rate-limits.ts`, `totp.ts`, `scope.ts` and `policy.ts`.
- `seed.ts` keeps its reset; check it still works with Better Auth's hasher.
- Migration `0007_plain_auth.sql`:
  - drop `session.credentialStamp`, `totp_steps` and `rate_limits`;
  - delete `account` rows whose `providerId` is `credential` and whose password starts with `scrypt$`;
  - delete every session: sessions the stamps had made stale would otherwise become valid again;
  - delete every `verification` row: pending codes are stored under our HMAC, and the two-factor challenges carry our stamps.
  - Run `pnpm run auth:schema` and the schema tests to check it.
- Update everything that imports what goes, so the build stays whole:
  - the faults driver (`src/faults/routes.ts` hashes with our scrypt);
  - `test/platform/setup.ts`, `accounts-helpers.ts` and `frontend-instance.test.ts` (they use `cheap-hashing.ts` or `HASHING`);
  - `test/unit/accounts.test.ts`.
  - The shared account helpers sign up the new way.
- **Tests:**
  - Delete `accounts-policy.test.ts` and `cheap-hashing.ts`.
  - Replace them with a flow test covering:
    - sign-up by code while open;
    - closed sign-up: no mail for an unknown address, and the code is refused;
    - the setup key on both code routes before setup, and refused after it;
    - a pre-registered unverified account loses its password when its owner signs in with a code;
    - two-factor after a password and after a code;
    - set-password once, then refused;
    - a reset revokes sessions;
    - a password change with `revokeOtherSessions`;
    - a route outside the allowlist answers 404.
  - Carry over the contract coverage the policy tests had, rewritten for the defaults:
    - code expiry, the third wrong attempt using a code up, single use, a resend;
    - backup-code sign-in;
    - a reset that gives a passwordless account its first password;
    - `/api/me` answering 401 after either first factor until the second is done;
    - set-password refused without a session and cross-site;
    - the migration applied over populated sessions, codes and old hashes.
  - Update `accounts.test.ts`, `accounts-ip-limits.test.ts`, the schema tests, `worker.test.ts`'s table list and `sources.test.ts`'s `HASHING` check.
  - `frontend-auth.test.ts` waits for B2; B1's commit message says it fails until then.
- **Measure:** platform suite time before and after; one sign-in's hash time in local workerd.

**B2. The frontend's sign-up by code.**

- `signup.tsx` keeps one form: email, password and, when sign-up is closed, the setup key. Submitting it requests a sign-in code, with the setup key header when present. `/setup` stays the signed-in page that claims the instance.
- A sign-up continuation holds the address, password and setup key in memory, never in storage, from the form through the code page. Every send and the code sign-in carry the setup key. Without it, a closed instance uses up the right code and then refuses to make the user.
- The code page signs in with `/sign-in/email-otp`. Afterwards the visitor is signed in without a password set, a state of its own; the auth guards must not navigate away before it is handled. From there the client either:
  - follows two-factor's redirect, for an existing account with two-factor; or
  - sets the password through the route above, while it is still in memory. A failure retries the password only, never the code, which is used up. If the account already had a password, it says so and goes on; that isn't a failure.
- If the page was reloaded before then, the password is gone: the user is signed in without one and can set it with "Forgot password".
- `verify-email.tsx` and the `verify-email` step go. Sign-in with an email code stays offered next to the password form; it is how users whose old hash was deleted get back in.
- Password changes send `revokeOtherSessions: true`.
- **Tests:**
  - Rewrite the affected cases in `cloudflare/test/platform/frontend-auth.test.ts`.
  - Update `cloudflare/test/account/browser.test.ts`'s sign-up walk.
  - Cover setup on a closed instance through the real client: sign-up with the key, a resend, the code, and a reload in between.
  - Run the account and fault suites after a `deploy:test`, coordinated with the frontend agent, who also uses the test Worker.

## Coordination

The frontend agent (`.claude/worktrees/frontend-cleanup`) is moving the API to oRPC (A3b next, A3d for `/api/me` and the instance routes). It also owns `docs/plans/frontend-cleanup.md`; this plan doesn't edit it.

- B2 touches `frontend/src/lib/auth.ts`, the sign-up and code pages and `frontend-auth.test.ts`, which F3 rewrote and A3d will touch.
- Merge `cloudflare` into `plain-auth` before B2 and again before merging back.
- Resolve conflicts in their favour where they only moved code.

## Done when

- `cloudflare/src/accounts/` holds no password rules, no rate limiting, no session stamping, no TOTP code and no `AsyncLocalStorage`. Our code around Better Auth is the allowlist, the two-factor matcher, the sign-up flag, set-password, provisioning and the emails.
- Nothing in `accounts/` or its tests mentions allauth or Django.
- Typecheck and the unit, platform and docker suites pass. The account and fault suites pass on the test Worker.
- The sign-up, sign-in (with and without two-factor), reset and setup flows work in the browser walk.
