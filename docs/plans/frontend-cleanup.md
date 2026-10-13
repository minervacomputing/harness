# Plan: cleanup of the frontend

`frontend/` was written against the Django backend and moved to the Cloudflare instance with as few changes as possible: its API client is generated from Django's OpenAPI schema, its sign-in pages still route on allauth's flow names, and its errors, CSRF handling and type names are Ninja's. The Worker in turn imports its API types from the frontend's generated client, so the contract points from the old backend through the frontend into the new one. This plan makes the frontend a plain client of the Worker, with less code and tooling that keeps it that way. It is the frontend's counterpart to [cleanup.md](cleanup.md), which another agent is carrying out in `cloudflare/`.

## Principles

- **Nothing from Django.** No allauth flow names or sentences, no Ninja error shapes, no `csrftoken` double submit, no `*Out`/`*In` type names, no `is_staff`, no schema exported from `backend/`, and no comments that explain the code by what Django did. No stored data or old API shape needs to be kept.
- **The API is one contract.** Each endpoint is declared once with [oRPC](https://orpc.unnoq.com): method, path, input, output and errors. The Worker implements the contract and the frontend's client is derived from it, so the compiler checks both sides and there is no generated code. What oRPC does not carry (Better Auth's routes, uploads, downloads, the run stream) keeps its paths and schemas in the same module.
- **TanStack first, then small helpers.** Retries, search parameters, forms, query keys and page titles use what Query, Router and Form already do, instead of hand-written versions.
- **Tests that pay for themselves.** Pure logic gets plain unit tests with inline data. The client's own guarantees (which step is pending, what a retry reuses, what is never stored) get a few integration tests against the Worker. What users see is checked by the browser walk. No component tests, no module mocks, no tests that only repeat the Worker's API tests through the client, and no injection seams that exist only for a test.
- **Security properties stay.** CSRF protection on every unsafe request, the second factor after every first factor, no open redirects, no setup key or password kept anywhere, and nothing of one account's data shown to the next.
- **Vertical changes.** A change to the API shape updates the route, its type and every caller in one commit, with no compatibility layer.

## Findings (2026-10-13)

| | Size |
|---|---|
| Handwritten TypeScript (`src/` without `api/` and the route tree) | 5,931 lines, and 192 of CSS |
| Generated API client (`src/api/`) and `openapi.json` | 4,581 and 2,825 lines (123 KB and 67 KB) |
| Tests in `frontend/` | none |
| Frontend tests in `cloudflare/test/platform/frontend-*.test.ts` | 1,081 lines, importing frontend source through a vitest alias |
| Browser walk (`cloudflare/test/account/browser.test.ts`) | 757 lines, against the deployed test Worker |
| Lint, formatter | none (`run-stream.ts` has an `eslint-disable` comment for a linter that is not installed) |
| Cold typecheck | 4.3 s |

Problems, roughly by size:

1. **The contract points the wrong way.** `pnpm gen:api` runs `backend/devtools/export_openapi.py`. `cloudflare/src/contracts/api.ts` re-exports `AgentOut`, `MeOut`, … from `frontend/src/api/types.gen.ts`. Routes the schema lacks are called by hand with `client.get<{ 200: … }, unknown, true>` (`lib/instance.ts`, "not in the generated client (its schema comes from the Django app)"). Run events arrive as `data: {[key]: unknown}` and `components/chat/model.ts` casts them, although the Worker already has the `RunEvent` union (`contracts/events.ts`). Two places build query keys from the generator's private key format: `[{ _id: 'getConversation' }]` (agents page) and `resourcesKey` (access editor).
2. **Django and allauth in the auth client.** `lib/auth.ts` (494 lines) keeps allauth's flow ids (`verify_email`, `login_by_code`, `mfa_authenticate`, `password_reset_by_code`), maps Better Auth's codes to allauth's sentences, builds an allauth-shaped error (`{message, code, param}`), wraps every call in a `{data, error}` to `Outcome` converter, and holds the password in memory so that verifying an address can sign in afterwards ("as allauth did"). `lib/http.ts` fetches `/api/csrf` and sends `X-CSRFToken`, and `errorMessage` reads Ninja's `{detail}` and Pydantic's 422 list (`loc`, `msg`). `guards.ts` and the shell check `is_staff`.
3. **Demo code that cannot run here.** The Worker always answers `demo: null` (`cloudflare/src/accounts/routes.ts`), `cloudflare/src/api/demo.ts` keeps only Django's "off" answers, and the public demo lives on the `demo` branch. `lib/demo.ts`, `DemoBanner`, the suggestions on the new-chat page, the visitors' `AllowedList` and 46 `visitor`/`useDemo` references in 11 files are dead on this branch.
4. **Hand-written versions of what TanStack does.** `lib/messages.ts` loops over retries with its own delays, where a mutation's `retry` and `retryDelay` would do. Every `validateSearch` parses `Record<string, unknown>` by hand. `TextField` and `TextAreaField` repeat each other and are wired with `field={field}`, where the form composition API (`createFormHook`) registers them once. The same email check is written out four times, the password length three times. Invalidation after a send names three generated keys one by one.
5. **Sign-out choreography.** `signOut` cancels queries, ends the session, writes "signed out" into the cache, navigates, clears the cache and writes it again, with a module flag (`isSigningOut`) the shell reads and a counter (`lib/session.ts`) that pending sends compare. A full page load to `/login` after the server has ended the session drops all of that state at once.
6. **Duplication.** The new-chat and conversation routes each build the same assistant-ui runtime: the `onNew` handler, the attachment take and restore, the `MessageNotSentError` handling.
7. **Seams that exist only for tests.** `lib/reload.ts` takes injectable storage, clock and reload (`ReloadDeps`) for a 119-line test of a ten-line rule.
8. **A heuristic where the server knows the answer.** `finishedParts` compares whitespace-squashed streamed text with the final message to decide which model call wrote the answer. The `message` event could name that call.
9. **A latent open redirect.** `validateNext` accepts any `next` that starts with `/`, including `//attacker.example`. Router navigation does not leave the origin with it today, but `location.assign` would.
10. **Leftovers.** `describeTool` labels tool events "recorded before the backend sent a label" (the Worker always sends one). Comments cite Django, allauth, Ninja and `permissions.services.MAX_CHANGES`.

Considered and kept:

- **assistant-ui** for the thread and composer, **Radix**, **cva**, **tailwind-merge**: they do real work, and the UI components are the design system's (see the `minerva-design` skill and `/dev/components`).
- **The upload adapter** (`lib/uploads.ts`): XHR because `fetch` reports no upload progress, and its lifecycle (cancel, delete what was never sent, give back what a refused message attached) is behaviour, not ceremony.
- **`lib/theme.ts`** and the inline script in `index.html`: small, and the script must run before first paint.
- **`run-stream.ts`'s `EventSource`**: the browser's reconnect with `Last-Event-ID` is the protocol. TanStack Query's `streamedQuery` could hold the events in the cache, but would not be shorter.
- **TanStack Pacer and TanStack DB**: the upload queue is four lines and the server state fits Query. Not needed.

Considered for the contract (decided 2026-10-13: oRPC):

- **Shared types and a small client of our own.** The least work, and the compiler checks the fields. But nothing ties a URL to its type: `api.get<Agent[]>(…)` is a claim the frontend makes, and a wrong path or a changed response shows only at runtime.
- **OpenAPI from the Worker, with `openapi-ts` as today.** Keeps about 4,500 generated lines and a build step, needs a zod schema for every response, keeps the generator's names and key format, and holds TypeScript at 5 or 6.
- **Hono's RPC client (`hc<AppType>`).** Every route becomes a typed chain. Hono's docs warn that type checking slows as the routes grow, the frontend's typecheck would compile the Worker's route types, and there is no OpenAPI document.
- **ts-rest.** The same idea as oRPC, but no release since June 2025.
- **oRPC.** Everything checked at compile time, inputs validated with zod, typed errors per endpoint, query keys and options for TanStack Query, and an OpenAPI document from the same contract for a desktop client or a public API later. MIT, released weekly, 2.0 in beta.

## Effect

Not in the frontend, for now.

- Its strengths are typed errors, dependency injection through layers, resource safety, retries and structured concurrency. The frontend's asynchronous code is four modules (auth steps, uploads, sending, the run stream), about 750 lines today. After this plan, sending is a mutation option, the auth steps are Better Auth's client with a thin layer, and the run stream is `EventSource`. What remains with real concurrency is the upload adapter.
- Effect's own data layer for React (`AtomHttpApi`, atoms) would take TanStack Query's place rather than sit beside it. Inside `queryFn`s it would be a second way of doing the same thing.
- Effect 4.0 came out at the start of October 2026. `HttpApi`, `HttpApiClient` and the React atoms are in `effect/unstable/*`, which may break in minor releases.
- The argument from the post (dependency injection and test layers instead of module mocks) needs tests that need doubles. The test policy below has pure-function tests, integration tests against the real Worker and a browser walk, none of which need them.

Where Effect could pay is the Worker: its ports are swapped through module-level factories (`PORTS.factory = …` in tests), and it has typed failures and retries throughout. That decision belongs to the backend. The API contract is oRPC's either way.

## Lint, format and types

- **oxlint** with these plugins:
  - `react`: rules of hooks, `exhaustive-deps`, and the compiler-derived `purity`, `refs` and `immutability`;
  - `jsx-a11y`, `typescript`, `promise`, and `import` (for `no-cycle`);
  - a chosen subset of `unicorn`, and `vitest`.
- **Rules that keep unwanted code out**:
  - `vitest/no-restricted-vi-methods`: `mock`, `doMock` and `hoisted`, so there are no module mocks;
  - a local JS plugin rule that reports any `*.test.tsx` file, with vitest's `include` set to `src/**/*.test.ts`. oxlint's JS plugins (ESLint's API) are alpha since March 2026, and the `include` alone enforces this if they misbehave;
  - `no-restricted-imports`: `@testing-library/*`, `jsdom` and `happy-dom` anywhere;
  - `no-restricted-globals`: no `localStorage` or `sessionStorage` outside `lib/`, so storage stays in the few places that need it.
- **oxfmt** (beta, Prettier-compatible) for the frontend's existing style (no semicolons, single quotes, 2 spaces, long lines), with Tailwind class sorting. The first commit only reformats. `cloudflare/` has a different style; one root config is a later decision for both.
- **Type-aware rules and TypeScript 7, as a separate step.** `oxlint-tsgolint` gives `no-floating-promises`, `no-misused-promises` and the rest of typescript-eslint's type-aware set, and `oxlint --type-aware --type-check` can replace `tsc -b`. It needs TypeScript 7's configuration rules; this tsconfig has no `baseUrl`. It waits for A3, because `@hey-api/openapi-ts` wants TypeScript 5 or 6 as a peer and 7.0 has no programmatic API yet. If it does not work, `tsc` stays.
- `pnpm check` runs lint, format check, typecheck and the unit tests. `make lint` and `make test` call it.

## Tests

The frontend's tests should catch a change that breaks what a user does, pin the few pure rules that are easy to get wrong, and hold the client's own security guarantees. They should not prove that the browser renders, or repeat the Worker's API tests through the client.

| Test | Lines | Decision |
|---|---|---|
| `cloudflare/test/platform/frontend-reload.test.ts` | 119 | Delete with `ReloadDeps` (F1). The rule stays in about ten lines: no reload without usable storage, the time written before reloading, a malformed or future time ignored. |
| `cloudflare/test/platform/frontend-messages.test.ts` | 201 | Rewrite for the mutation (F2) as three cases: a lost answer is retried with the same key and is one run, a refusal is not retried, and the retries stop after two. |
| `cloudflare/test/platform/frontend-auth.test.ts` | 499 | Rewrite for the new client (F3). Keep the flows and what the client must guarantee: the same answer for unknown addresses, a pending step's expiry and reload, the second factor after a code or a verification, field errors, a failed sign-out leaving the user signed in, and a handled submit rejection. Drop allauth's sentences and the sign-out choreography. |
| `cloudflare/test/platform/frontend-instance.test.ts` | 262 | Folded into the auth test in A3d: the setup key travels in one header and is never stored, and the instance guard reads the role from the server each time. The rest repeats `instance.test.ts`. |
| `cloudflare/test/account/browser.test.ts` | 757 | Keep, on the deployed test Worker, as the end-to-end test: it also covers the production origin, downloads and Workers AI, which a local run cannot. |
| new `frontend/src/**/*.test.ts` | ~200 | `components/chat/model.ts` (restarts, repeated writes, narration, the answer), `connections/summary.ts`, and the access editor's requires-chain `toggle`. Plain inputs and outputs, no DOM. |

The integration tests stay in `cloudflare/test/platform` for now, because that is where a Worker runs locally. Moving them next to the frontend, or replacing them with a browser walk that runs locally, can come later.

## Units

Status (2026-10-13): F0–F3, S, A1 and A2's `message` event are done and merged into `cloudflare`; the test Worker runs A1 (browser walk and fault suites pass). A2's first-message change moved out (below). A3 went in four units, all done on `frontend-cleanup`: A3a (the contract package, the Worker's mount, the integration matrix, and the agents end to end), A3b (conversations, messages and files), A3c (connectors, connections and access; the OAuth callback stays a redirect outside the contract) and A3d (`/api/me`, the first-run setup and the instance admin, then the deletions). What A3 leaves is its last step, TypeScript 7 and the type-aware lint rules, then A4.

The frontend units (F) touch `frontend/`, the four frontend tests, and for F0 the Makefile and AGENTS.md. They can start now. Work on them in a git worktree off the `cloudflare` branch, because the main checkout holds the other agent's uncommitted work.

The API units (A) change both sides of the HTTP surface, so they wait until the backend agent has finished [cleanup.md](cleanup.md). They go in one agent at a time, in vertical commits. The move to oRPC (A3) comes last: it rewrites every route, so it should move routes that are already clean and a protocol that has stopped changing. Its trial (S) can run before then, because its code is thrown away.

Before each commit: `pnpm check` and `pnpm build` in `frontend/`, the Worker's `test:platform`, and an opencode review of the diff. After an A unit, also the Worker's typecheck and `test:unit`, and the browser walk on the test Worker.

**F0. Tooling.** oxlint with the rules above (without type-aware rules), oxfmt (a format-only commit first), vitest for `*.test.ts` with the first pure tests, `pnpm check`, the Makefile targets, and a short "Frontend" section in AGENTS.md with the test policy. Fix what the linter finds.

**F1. Dead and leftover code.**
- The demo visitor's UI: `lib/demo.ts`, the banner, the suggestions, `AllowedList` and every `visitor` branch.
- `describeTool`.
- `reload.ts`'s injectable seams, with `frontend-reload.test.ts`.
- The Django and allauth comments.
- UI exports nothing uses, checked by hand or with knip.

**F2. TanStack idioms.**
- **Sending is a mutation** whose `mutationFn` throws a typed error carrying the HTTP status. `retry` allows at most two retries, for network failures, 502, 503 and 504 only, after 0.4 s and 1.2 s. The variables hold the request body and the key, made once per send, so every retry sends the same thing. On the new-chat page, creating the conversation stays a mutation of its own without retry, and only the send retries, until A2. `lib/messages.ts` goes; `lib/session.ts` stays until F3, because it stops a delayed retry after sign-out.
- **Search parameters are zod schemas.** `.catch()` drops a malformed value instead of failing the route, as today. The open connections move from `sessionStorage` into an `open` search parameter that holds a list of ids.
- **Forms use `createFormHook`.** `TextField`, `TextAreaField` and `SubmitButton` are registered once. The submit handling keeps today's handled rejection. The zod validators are shared where the rules really are the same: sign-in checks the address only, while sign-up and reset also check the password length.
- **Static page titles become route `head`**, with `HeadContent` rendered in the root route.
- **A `useChatRuntime` hook** serves both chat routes.
- Adds zod to the frontend.

**F3. Auth client.**
- **Errors.** Better Auth's client with `fetchOptions: { throw: true }` replaces the `call` and `Outcome` wrappers. A small normalizer reads `BetterFetchError`'s payload: the field a code belongs to, whether it ends the step, and a network failure. Our own short sentences replace allauth's where Better Auth's message is not right for users.
- **Steps.** Our own names for the pending steps. Anonymous pending steps keep updating the auth state in the cache.
- **Page loads.** Sign-out loads `/login` only after the server has ended the session; a 401 counts as ended, while a network or server failure leaves the user signed in. Becoming signed in loads the next page. A page restored from the back-forward cache asks the server who is signed in again. `signOut`'s choreography, `isSigningOut`, `runAuthStep`'s cache juggling and `lib/session.ts` go.
- **Redirects.** `next` is accepted only if it resolves to this origin, so `//host` and `/\host` are refused.
- Target: `lib/auth.ts` under 250 lines.

**S. oRPC trial (done).** A throwaway branch (`orpc-trial`) moved the agents and the conversation read to oRPC 1.15.6. Both gates pass, but not with oRPC's defaults: our body reader replaces oRPC's through an interceptor, session and membership are checked in the Hono mount before oRPC reads the body, and the link's `fetch` keeps an error answer's status when its body cannot be read. The conversation read stays a streamed handler; the run stream stays `EventSource`. It adds about 12 KB gzip to the frontend. Details and evidence: [orpc-trial-findings.md](orpc-trial-findings.md).

**A1. The HTTP surface without Django.**
- **CSRF without the token.** Every unsafe request that carries the session cookie, uploads included, is checked in Hono before any route reads its body. With an `Origin` header, it must be exactly the site's origin: `null`, sibling and other origins are refused, whatever `Sec-Fetch-Site` says. Without one, it must carry `Sec-Fetch-Site: same-origin`. With neither, it is refused. JSON bodies must say `Content-Type: application/json`. `/api/csrf`, the `csrftoken` cookie and `X-CSRFToken` go, and with them `ensureCsrf` and `csrfToken` in the frontend's interceptor and upload adapter. This is our own check of a few lines, not Hono's `csrf()`, which only looks at form content types. It runs for every unsafe request under `/api/` whatever the route matching says (today a route Hono treats as middleware, as an oRPC mount is, skips it), with only `/api/auth/*` exempt. Tests cover missing, `null`, sibling-origin and hostile origins, every content type, and uploads. Better Auth keeps its own origin check. opencode reviews the unit as a security change. Stating the rule for cookie requests leaves room for bearer tokens, which a desktop client would use; such a request would be exempt only once its token is verified.
- **One JSON reader.** Every JSON body goes through one reader: `Content-Type: application/json` (415 otherwise), the 2.5 MB cap, strict UTF-8 and `parseJson`. A3 plugs the same function into oRPC.
- **Refusals carry a code** next to their status and text (`KEEP_ONE_AGENT`, `RUNS_STILL_STOPPING`, …), so A3's declared errors map one to one instead of by status. If the backend's cleanup does this first, A1 skips it.
- **Roles.** `is_staff` becomes a role on the user.
- **Verification signs in.** Better Auth's `autoSignInAfterVerification` creates the session, so the client no longer holds the password. The Worker's two-factor hook already applies to verification (`FIRST_FACTOR`), so the client handles its answer like any first factor. Tests show a two-factor user still gets the second step, the credential stamps hold, and no second code request voids the first. With the email-OTP plugin's `overrideDefaultEmailVerification` and `sendOnSignIn`, an unverified sign-in gets its code from the server, and the client stops asking for it.
  Superseded (2026-10-13) by [plain-better-auth.md](plain-better-auth.md), merged into this branch with `cloudflare`: sign-up is by email code, so no unverified account is made and nothing verifies an address; the code page then sets the sign-up form's password, and the binding cookie, the stamps and `verify-email` are gone. Where the two plans disagree on sign-up, verification, sign-in or their tests, plain Better Auth's design holds.
- **Leftovers.** The demo stubs (`/api/demo/*`) and Django's 404 texts ("No Agent matches the given query.") go.

**A2. Smaller protocol changes.**
- The `message` event names the model call that wrote the answer, so `finishedParts` drops its comparison.
- A first message creates its conversation in the same request, with the `Idempotency-Key`. The new-chat page then has no create-then-delete on refusal and can retry the whole send. This needs a design first, reviewed like A1: a conversation is created by the Workspace object while start keys live in the Conversation object, so the design says which object owns a first message's key, how a repeated or concurrent send finds the conversation the first one created, what a failure between the two steps leaves, and what a refusal removes. If that is not small, it leaves this plan for the backend's. Moved out (2026-10-13): the design, [first-message.md](first-message.md), is not small (about 200 lines in `cloudflare/src`, both objects' invariants and the start protocol), so it waits for a backend plan. Until then the new-chat page keeps create, send and delete-on-refusal, and A3 declares today's two endpoints.

**A3. The oRPC contract**, on 1.x pinned exactly (2.0 once it is final; read `v1.orpc.dev` meanwhile). The findings' last section has the details; in short:
- **The contract** is a pnpm workspace package (`contract/`, depending on zod and `@orpc/contract`) that both packages import, with no Cloudflare imports. It declares every endpoint: method, path, zod input, output and errors. Names say what things are (`Agent`, `Conversation`, `NewAgent`), not `AgentOut` and `AgentIn`. Outputs are zod schemas for small resources and `type<T>()` for the streamed reads and for writes, so a write that succeeded never answers 500 because its output failed validation. The run events are the `RunEvent` union, so `components/chat/model.ts` drops its casts.
- **The Worker.** One `OpenAPIHandler` mounted under `/api/*` after Better Auth, uploads, downloads and the run stream. The mount reads the session and checks membership from the path before oRPC touches the body, puts the member in the context and adds the session cookies to every answer; a middleware checks that the input's workspace is the path's. The instance admin's role is another middleware, still checked in SQL. An interceptor replaces oRPC's body reader with A1's. Every code the Worker can send is declared in one error map, so `defined` means our server answered; validation failures are 422 with `data.issues`; `notFound`, `onError` and the router's early refusals answer in the same shape. Ninja's `{detail}` and the 422 list go.
- **First step: the integration matrix**, which must pass before hey-api goes and on every oRPC update: the parser (an escaped key after `"\\"`, a form body, the streamed cap), the order (a non-member's slow body gets 401 at once; 401 before 400/413/415/422), cookies on success, refusal and 401, paths (a workspace in the body that disagrees with the path, encoded paths, unknown routes and methods), the streamed reads (large, slow reader, cancelled, failing mid-body) parsed with an independent schema, and calls that carry headers (the send's `Idempotency-Key`, the setup key) through the typed client.
- **What stays outside it**, with its paths and schemas still in the contract package: Better Auth's routes, uploads (XHR for progress), downloads, and the run stream (`EventSource`: oRPC's event iterators stop on a clean end, never reset their retry count and retry 401s).
- **The frontend.** One `OpenAPILink` that takes the instance's URL, so a desktop client could reuse it. Its `fetch` handles 401, keeps an error answer's status and marks `fetch`'s own failures. Queries and mutations use oRPC's TanStack Query utilities; invalidation names resources by their place in the contract, and nothing depends on a generator's key format. Query `retry` stops on an `ORPCError` below 500. The send retries on a marked network failure or a 502/503/504 that did not come from our server. `errorMessage` reads `ORPCError.message` and replaces an undeclared answer's text with a sentence about the server.
- **Deletions.** `src/api/`, `openapi.json`, `openapi-ts.config.ts`, `@hey-api/openapi-ts`, `gen:api`, `make api-types`, `lib/instance.ts`, `cloudflare/src/contracts/api.ts`'s import from the frontend, and `lib/http.ts`'s interceptors.
- **Then** TypeScript 7 and the type-aware lint rules.

**A3, as done (2026-10-13).** Everything above but the last step. Outside a workspace, the mount matches the procedure first (an unknown path is left to the routes after it, so it stays a 404 for anyone), then reads the session and admits by the procedure's place in the contract: the setup's status for anyone, `/api/instance/*` for instance admins (the role read from D1, and again in each change's own statement), everything else for a signed-in user. Refusals come before the body is read, and every answer carries the session cookies. The setup key travels in `X-Minerva-Setup-Key` as the claim's detailed input. Every answer under `/api/` outside Better Auth has the contract's error shape; `refused`, `notFound`, `validationError` and `api/input.ts` went.
- **Merged with plain Better Auth (2026-10-13).** Its first-password route, `POST /api/me/password`, is the contract's `password.set`: the same path, its refusals in the contract's shape (`PASSWORD_ALREADY_SET`, and Better Auth's length rules as a 422 on `password`), the mount's 401 before the body. `frontend-instance.test.ts`'s sign-up with the setup key, as plain Better Auth rewrote it, is in the auth test.
- **Size.** `frontend/src` without tests and the route tree: 6,077 handwritten lines (6,161 before A3a), under the 6,224 target. The built JavaScript is 405,456 B gzip, 7,671 B (1.9%) more than before A3a's 397,785: oRPC's client and the contract's schemas in place of the generated client. The frontend integration tests are 819 lines, from 1,081.
- **Dockerfiles.** `deploy/Dockerfile.frontend` and `deploy/demo/Dockerfile.frontend` build the frontend for the Django stack (`main`'s workflow and the `demo` branch), which this branch's frontend can no longer talk to: it speaks Better Auth and the oRPC contract. They are left as they are. On this branch the frontend ships as the Worker's assets (`cloudflare`'s `assets` script); the Dockerfiles go, or are rewritten, when `main` moves to the instance (Later, below).
- **Leftovers.** The test build's `/api/faults/*` and the download origin (outside `/api/`) still answer `{detail}`, and their tests read it. The Conversation object's internal `notFound` and the RPC `Refusal {code, detail}` are not HTTP answers. The stored run events' snake_case fields (`media_type`, `dirs_added`) are A4's. `uploads.ts`'s `uploadFailure` repeats the server sentence of `lib/http.ts`.

**A4. camelCase run events.** A3 writes the contract in camelCase, each resource's fields changing with its handler and callers, so the API moves once. The work cannot come earlier, because until A3 the frontend's types are generated from Django's schema. The run events are left for this unit because they are stored in the Conversation objects and replayed: it changes the event union, the writers and the stored payloads, which production holds, so it needs a migration or a reset, asked for first.

**Later, outside this plan.** The README screenshots still seed through Django (`make seed-demo`), and `make dev` and `make setup` start the Django stack. They need Worker-based equivalents when `main` moves to the instance.

## Decisions

Decided 2026-10-13:
- **The contract is oRPC** (see Considered for the contract), as the last API unit, if the trial (S) passes its gates.
- **The demo visitor's UI is deleted** on this branch. The `demo` branch keeps its own copy.
- **Sign-in and sign-out are full page loads.**
- **JSON fields are camelCase**, written into the contract in A3, and the stored run events in A4.
- **CSRF is the origin check** specified in A1, after its security review.

## Done when

- Nothing in `frontend/` or in the API refers to Django, allauth, Ninja or the old schema, and nothing in `cloudflare/` imports from `frontend/` except the integration tests.
- The API is one oRPC contract that the Worker implements and the frontend's client is derived from.
- `frontend/src` has no generated client, fewer handwritten lines than after F3 (6,224 without tests, counted after the oxfmt reformat, which added about 530; the first estimate of 4,500 was too optimistic), and passes `pnpm check` with type-aware rules on TypeScript 7.
- The frontend's tests are `src/**/*.test.ts` on pure modules, the rewritten integration tests (about half of today's 1,081 lines), and the browser walk.
