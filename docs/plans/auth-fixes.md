# Plan: auth fixes after plain Better Auth

opencode reviewed the merge of [plain-better-auth.md](plain-better-auth.md) into `frontend-cleanup` (f1adb15) and listed four problems in the Worker's auth. This plan checks each against Better Auth 1.7.7's source and the Worker, says who could use it, and fixes what is worth fixing. Paths under `better-auth/` are in `node_modules/better-auth/dist/`.

**How the races were reproduced.** The reproductions were throwaway platform tests that printed what happened; none are kept as tests. Local workerd runs every request in one isolate, and scrypt blocks that isolate, so two requests sent at once never interleaved. For the races, a test gave one request a D1 binding that, after a chosen statement, waits until the test lets it go. This shows that an interleaving is possible. It does not show how often it happens when deployed.

**Two facts the findings rely on:**

- Better Auth's D1 adapter has no interactive transactions. A multi-row operation runs as separate statements, even where Better Auth wraps it in a transaction.
- The locks Better Auth holds while consuming a code belong to one Better Auth instance, and we build one per request (auth.ts).

## Findings

### 1. A pending second-factor challenge survives a password reset

**Verified, reproduced.**

- A first factor for a user with two-factor leaves a challenge (`better-auth/plugins/two-factor/index.mjs:290-304`):
  - a `verification` row `2fa-<random>` whose value is the user's id, valid for 10 minutes;
  - and a counter row `2fa-attempts-…`.
- Completing the challenge checks only that the row and the user exist (`verify-two-factor.mjs:19-31`).
- A reset by email code updates the password, calls `onPasswordReset` and deletes the user's sessions. It leaves `verification` alone (`better-auth/plugins/email-otp/routes.mjs:590-600`). A password change also leaves it (`better-auth/api/routes/update-user.mjs:165-183`).
- Reproduced: sign in with the password, reset the password, then send the TOTP code. That makes a session, and `/api/me` answers 200.

**Impact.** The attacker needs the old password and a second factor, and has to start signing in before the owner resets. The second factor is a TOTP code or a backup code; after an email code, it is the mailbox and a second factor. If they finish within the challenge's 10 minutes, they get a session that lasts two weeks and is extended while used, so the reset doesn't end their access. With that session they can't change the password or turn off two-factor: both ask for the password, which they no longer know.

**Trade-off?** No. "Races" accepts a session made *while* a reset runs, a window as long as the reset's few statements. This window is 10 minutes.

**Fix.** When a password is reset or changed, delete the user's pending challenges:

```sql
DELETE FROM verification WHERE identifier LIKE '2fa-%' AND value = ?
```

- **What it matches.** Only challenge rows match:
  - Counter rows hold a number, not a user id.
  - Trusted-device rows are `trust-device-…`, and they stay, as their trade-off accepts.
  - Identifiers are stored as they are: no `verification.storeIdentifier` is set.
- **Resets.** The statement goes in Better Auth's own `emailAndPassword.onPasswordReset`. Both reset routes call it after writing the password and before revoking sessions; the browser reaches only `/email-otp/reset-password`.
- **Password changes.** Better Auth has no callback for a change, so a `hooks.after` (`createAuthMiddleware`) runs the statement for `/change-password`:
  - only when the endpoint succeeded: Better Auth also runs after-hooks when the endpoint failed, so the hook skips when `isAPIError(ctx.context.returned)`, and a wrong current password ends nothing;
  - for the user in `ctx.context.session`;
  - with or without `revokeOtherSessions`, since the old password stops working either way.
- **One dependency.** Both call `passwordReplaced(userId)`, a new entry in `AuthDeps`, so auth-options.ts still imports nothing that needs the runtime.
  - Implemented in auth.ts.
  - Stubbed where `AuthDeps` is built without a runtime: `scripts/auth-schema.ts`, `test/unit/accounts.test.ts` and the schema test.
- **If the statement fails.** It is not caught. The reset answers 500 with the password already written and the sessions not yet revoked. The owner sees an error and resets again. A reset that swallowed the error would report success and leave challenges valid. For a change, the hook runs after the change's own writes: it answers 500 with the password changed.
- **A change that fails halfway** answers an error and ends no challenges. That happens when its password write succeeds and its new session doesn't. The guarantee covers successful changes only.
- **What it guarantees.** It removes every challenge stored when the statement runs. Two cases stay open, as accepted races:
  - a first-factor sign-in already past its password check can still store a challenge afterwards;
  - a completion that has already consumed its challenge can still make a session.
- **Frontend.** No change. A challenge that is gone answers `INVALID_TWO_FACTOR_COOKIE`, which the client shows as "Your sign-in timed out. Sign in again."

**Tests**, in `accounts-flows.test.ts` under "resets and changes end sessions":

- **A reset.**
  - Challenges are open for two users: the target, after an email code, and someone else, after a password.
  - After the target's reset, a backup code is refused for the target with `INVALID_TWO_FACTOR_COOKIE`, and `/api/me` answers 401.
  - The other user's challenge still completes.
  - The target signs in again with the new password and TOTP.
- **A change.**
  - A challenge is open. A change with a wrong current password leaves its row in place.
  - A change without `revokeOtherSessions` succeeds, and then the challenge's TOTP code is refused.

### 2. A password change in flight can overwrite a reset

**Verified, reproduced, not fixed: the owner should confirm this as a trade-off.**

- `changePassword` reads the credential (`update-user.mjs:165`).
- It hashes the new password and verifies the current one against what it read: two scrypt runs (`:167-171`).
- It writes by row id, with no condition (`:172`).

Reproduced, with the change held after it read the credential:

- A reset by code completes, then the change completes.
- The reset's password is refused and the change's works.
- The changing browser keeps a session: `revokeOtherSessions` made it a new one after the reset had deleted the others.

Two smaller points:

- **Not atomic.** In both the change and the reset, the password write and the session revocation are separate statements. A crash between them leaves the old sessions alive. Repeating the action closes that.
- **`revokeOtherSessions` is optional.** Only a caller with a session and the current password can leave it off, and our client always sends it.

**Impact.**

- The attacker needs the current password and a live session, with any second factor already passed.
- They keep change requests in flight, each changing the password and signing the owner out. One must be between its read and its write when the owner's reset writes. That window is at least two hashes and grows with any delay in D1.
- The per-IP limit (10 per 10 s) slows this from one address, not from many.
- The result: the owner's reset reports success, but the attacker's password is the one that works.

**Why no fix is proposed.**

- **A reset can't guarantee recovery from this attacker anyway.** With the password and a session, they can put their own authenticator on the account:
  - `/two-factor/disable` asks only for the password;
  - so does `/two-factor/enable`, which refuses only while a verified authenticator is on.

  A reset never touches two-factor. After a reset, the owner signs in with the new password or an email code and meets the attacker's second factor. Closing the race doesn't change that (open question 1).
- **The fix isn't small.**
  - It would be a database hook (`account.update.before`, for `/change-password`). The hook does the write itself, as a compare-and-swap on the stored hash, and skips Better Auth's write.
  - When the swap finds the hash changed, the hook must throw. Returning `false` only skips the write, and `changePassword` would go on to revoke sessions and make a new one.
  - The hook doesn't see the hash Better Auth read. It would re-read the hash and re-verify the current password against it (a third scrypt), or carry the hash over from a before-hook through per-request state, which plain auth removed.
- **What the owner is asked to accept.** This goes beyond the accepted "Races" trade-off, which names a surviving session. Here an attacker who controls the account keeps their own password while the owner's reset reports success. A concession of its own, not made harmless by the two-factor route above.

### 3. A resend leaves the older code stored, and a wrong guess can bring a code back

**Verified, reproduced, partly fixed.**

- **A resend adds a row** next to the old one. `verification.identifier` has a plain index, not a unique one (migration 0003), so `resolveOTP`'s insert succeeds (`email-otp/routes.mjs:42-53`). Two rows for the address were stored.
- **A check consumes the newest row, then deletes the rest** in a separate statement (`better-auth/db/internal-adapter.mjs:815-850`). Any request that reaches the consume in between, even with a wrong code, can leave an older row exposed to another request.
  - Reproduced: the newer code's check was held after its consume; the older code signed in, then the newer did too.
  - The holder of an intercepted older code can do the same: send any wrong code to the address and the old code at once. A resend therefore doesn't reliably cancel a code the owner thinks is leaked. This applies to reset codes as well.
- **A wrong guess deletes the code and writes it back** with one more attempt (`email-otp/routes.mjs:773-779`). A resend that lands between the two leaves the old code as the newest row, and the code just emailed is refused.
  - Reproduced: the guess was held before its write; the newer code was refused and the older one signed in.

**Impact.**

- The intercepted-code case needs a code that was sent to the owner, and it has to land between two statements of another request. A miss deletes the old row, so each intercepted code gets about one try.
- Guessing gains nothing: each row still takes three wrong attempts, and every row is a code that was sent.
- Reviving a code makes the newest code fail. A guesser can already do that by guessing wrong three times.

Small, but a single index closes most of it.

**Fix (hardening).** Make `verification.identifier` unique. Better Auth keeps one row per identifier with this index wherever we use it:

- **Sending a code.** When the insert of a new code fails, `resolveOTP` deletes the old row and inserts again (`email-otp/routes.mjs:46-53`).
- **Two-factor.** Challenges and trusted devices use random names. The attempt counter is consumed before it is written again, and that write's errors are ignored.
- **Not reachable.** The writers that insert without that fallback are not routes we expose: `createVerificationOTP` (server only), email change, two-factor by email. A route added to the allowlist later needs this check.

With one stored code per address:

- **A resend replaces the code.** Once it has completed, no check can reach the older code. That closes the intercepted-code case and the case where both codes are accepted.
- **A collision fails instead of reviving a code.** A wrong guess whose write-back collides with a completed resend is refused, so the resent code stands. The guess answers 500 instead of 400. The same goes for the second of two concurrent resends, whose code is then not sent.
- **Still open: a revived code.** Better Auth consumes the row by id, then deletes by identifier in a separate statement.
  - A resend inserted between those two statements is deleted, and the guess writes the old code back.
  - The resent code fails, and the owner asks for another.
  - Closing this needs a change in Better Auth's consume, not an index.

Tried with the index in place: both reproductions above then refuse the older code, and the schema tests and Better Auth's schema check pass.

Migration `0008_verification_identifier.sql`:

- deletes all but the newest row of each identifier: the latest `createdAt`, and on a tie the greater id, since ids are UUIDv7;
- drops `verification_identifier_idx`;
- creates it again as a unique index.

**Considered.** Email-OTP's `resendStrategy: "reuse"` resends the stored code instead of making a new one. It narrows the races but doesn't close them, and it lets resends keep one code alive with no end.

**Tests:**

- `accounts-flows.test.ts` "email codes":
  - The existing resend test, extended: after a resend, the address has one stored code, and the older code is refused.
  - The intercepted-code race, made deterministic:
    - A wrong guess is held after its consume, through a D1 binding that waits at that statement (the reproduction's binding, kept as a test helper).
    - The older code is refused, both for sign-in and for a password reset.
- `accounts-schema.test.ts`:
  - a second row with the same identifier is refused;
  - 0008 over duplicate rows keeps the newest (including a tie on `createdAt`) and leaves other identifiers alone.

### 4. `password.set` over a credential row without a password

**Verified in Better Auth; nothing reaches it.**

- **The gap.** `setPassword` updates a credential row whose `password` is NULL, with no condition (`update-user.mjs:213-215`). For such a row, two concurrent setters would both succeed: our pre-check (`hasPassword`, `cloudflare/src/api/accounts.ts:46-49`) passes, and so does the unique index `account_one_credential`.
- **Nothing writes such a row:**
  - The Better Auth routes we expose always store a hash: `setPassword`'s insert and the email-code reset.
  - Migration 0003 copied `passwords.hash`, which is `NOT NULL`.
  - Seed always hashes.
  - The admin plugin's `createUser` is behind the allowlist.

Even with such a row, the two requests need the user's session. **No fix.**

## Already accepted

opencode also listed these; each matches a trade-off in [plain-better-auth.md](plain-better-auth.md):

| opencode's point | Trade-off | Checked |
|---|---|---|
| Trusted devices survive a reset | Trusted devices | The trust cookie is checked against a `trust-device-…` row, which no reset deletes (`two-factor/index.mjs:252-273`); C1 leaves them |
| No per-account limit on guesses | No per-account limit on password guesses; none per address on code emails | Limits are per IP (`ip-limits.ts`), `allowedAttempts` per code, and two-factor's lockout |
| A TOTP code works more than once in its window | A TOTP code can be reused | |
| Weaker password rules, lower scrypt cost | "What goes": Better Auth's hasher and `minPasswordLength: 10` | |
| Session races the stamps closed | Races | |

**The code page's "Try again"** can't fix a password the server refuses for length. Not worth a change:

- The sign-up form checks the same limits before it sends anything: 10 to 128 characters (`frontend/src/components/form.tsx:11`), and Better Auth's default maximum is 128. Only a client that skipped the form gets this refusal.
- The page also offers "Continue without a password", and "Forgot password" sets one.

## Units

In order, each with its tests, the checks, and an opencode review of its diff. No frontend or contract change.

- **C1. Pending challenges end with the password** (finding 1):
  - `onPasswordReset` and the `/change-password` after-hook in `auth-options.ts`;
  - `passwordReplaced` in `AuthDeps`, and its stubs;
  - the `DELETE` in `auth.ts`;
  - the tests.
- **C2. One stored code per address** (finding 3, hardening): migration 0008 and its tests.

## Open questions for the owner

1. **Recovering a taken-over account.** Someone with the password and a session can put their own authenticator on the account, and no reset undoes it. Should an instance admin be able to remove a user's two-factor? Better Auth's admin plugin has no route for it, so it would be one of ours. It would not undo an overwritten password (finding 2), only let a reset work again afterwards.
2. **Finding 2 as a trade-off.** An in-flight password change can overwrite a reset. Accept it as described, or fix it with the compare-and-swap hook?

Neither blocks C1 or C2.
