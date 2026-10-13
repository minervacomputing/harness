# oRPC trial (unit S): findings

Branch `orpc-trial` (off `frontend-cleanup`, throwaway, never merged), 2026-10-13. oRPC **1.15.6**, pinned exactly in both packages (`@orpc/contract`, `@orpc/server`, `@orpc/openapi` in `cloudflare/`; `@orpc/contract`, `@orpc/client`, `@orpc/openapi-client`, `@orpc/tanstack-query` in `frontend/`).

What was built, end to end:

- `cloudflare/src/contracts/http.ts`: the contract (no Cloudflare imports) for `agents.{list,create,get,update,delete}` and `conversations.get`, with declared errors. A trial-only `debug.keys` procedure echoes a body's keys.
- `cloudflare/src/api/orpc.ts`: the handlers through `OpenAPIHandler` (declared methods and paths, plain JSON), mounted in Hono at `/api/workspaces/{ws}/*` after the other API routes. The Hono routes for agents and `GET …/conversations/{id}` were removed.
- `frontend/src/lib/orpc.ts`: `OpenAPILink` and `createTanstackQueryUtils`, used on the agents page, the conversation page, the new-chat page's agent list and the invalidations in `send.ts` and `conversation-list.tsx`.
- `frontend/trial/link-errors.ts` and `frontend/trial/sse-resume.ts`: client experiments in Node with a stubbed `fetch`.

Checked against the local Worker (`pnpm dev:offline`) and the Vite dev server with curl, and in the in-app browser, signed in as the seed user: the agent list, creating an agent, the conversation page, and sending a message (the conversation refetched through the oRPC key). Uploads (3 MB, over the JSON cap) and downloads still work beside the mount.

## Verdict: go, with conditions

The trial shows that oRPC can carry this API, not that the migration is finished. Both gates pass, but neither works with oRPC's defaults. Each needs a small piece of our own code at a documented extension point, about 50 lines, shown below:

- our body reader in place of oRPC's, through an interceptor;
- session and membership checked in the Hono mount, before oRPC reads the body;
- a `fetch` wrapper in the link that keeps an error answer's status when its body cannot be read.

The shape questions have workable answers. The run stream should stay on `EventSource`. The cost is small: +12.4 KB gzip in the frontend today, and a small increase in typecheck time.

The conditions:

1. The three pieces above, each pinned by tests.
2. Every error code the Worker can send is declared, so that `defined` means "our server answered".
3. The integration matrix under A3 passes before hey-api is removed.

They are listed under "Recommended changes to A1–A3".

## Gates

### 1. Our body parsing in place of oRPC's: yes, through an interceptor

oRPC reads the body in `codec.decode`, before any middleware. The fetch adapter's `toStandardBody` calls `JSON.parse` for `application/json` or a missing type, and it also accepts `multipart/form-data`, `application/x-www-form-urlencoded`, `text/plain` and any other type as a file. A handler `interceptor` can replace the lazy `request.body` with our own reader (`orpc.ts` `readBody`). That reader enforces `readBytes`' 2.5 MB cap, declared and streamed; strict UTF-8 with `TextDecoder({fatal: true})`; `parseJson`; and `Content-Type: application/json`, which A1 asks for anyway.

Evidence: the same two bodies were sent through oRPC's default parser (a second handler without the interceptor, mounted for the trial at `/api/default-parser/…`) and through ours. `debug.keys` returns each key as char codes. The first body plants the escaped key `"\\"` (92) in V8's cache for that object shape; the second body's key `"\n"` (10) should come back as 10:

```
body 1 {"probeK":0,"\\":1}   body 2 {"probeK":0,"\n":1}
oRPC's parser:   [[…probeK…],[92]]  then  [[…probeK…],[92]]   <- "\n" read as "\\": V8's bug
parseJson:       [[…probeK…],[92]]  then  [[…probeK…],[10]]   <- correct
```

Size, encoding and type (`POST …/agents`, a member):

| Request | Answer |
|---|---|
| 3 MB with `Content-Length` | 413 `{"detail":"The request is too large."}`, from the router's declared-length check, before oRPC |
| 3 MB chunked, no `Content-Length` | 413 `{"code":"PAYLOAD_TOO_LARGE",…}`, from our streamed cap |
| invalid UTF-8 (`\xff\xfe`) | 400 `Cannot parse request body` |
| `{"name":` | 400 `Cannot parse request body` |
| `application/x-www-form-urlencoded` | 415 from us; oRPC's default parser **accepts** it and decodes it with bracket notation |

Caveat: oRPC's parser must be replaced for every handler, because the default accepts form encodings, which a cross-site HTML form can send. The interceptor is the one place that does this, and a test should pin it (send `\n` after `\\`, and a form body).

### 2. Membership before validation, cookies on every answer: yes

- **Before validation.** Middleware added with `implement(contract).use(mw)` sits before `inputValidationIndex`, so it runs before zod (oRPC's `implementerInternal` and `executeProcedureInternal`).
- **But not before the body.** oRPC decodes (reads and parses) the body before any middleware. The first version of the trial checked membership in middleware. That gave the right answers but the wrong order of work: a non-member's body was read and parsed before the 401. A body that never ends delayed the 401 until it did.

  Measured on the trial's debug route, which still works that way (`frontend/trial/slow-body.mjs`, a JSON body whose last byte comes after 4 s): the non-member's 401 arrived after 4.04 s.
- **Membership in the mount.** The final version checks the session and membership in the Hono mount, from the route's `:workspace` parameter, before `handler.handle`. It passes the member to oRPC in the context. The oRPC middleware then only checks that the input's `workspaceId` is that workspace (it is the same path parameter: path parameters override body and query fields in oRPC's input, `{...data, ...params}`).

  Measured with the same slow body on `POST …/agents`:

  ```
  non-member: status 401, head after 0.02 s     (the body is never read)
  member:     status 201, head after 4.02 s
  ```

  The cost: the workspace check lives in the mount rather than in the contract's middleware, so it covers every procedure under `/api/workspaces/{ws}/` whether or not the procedure asks for it. That is the policy anyway.
- **Body refusals after membership.** Our reader does not throw. It returns a marker object (`{[BODY_REFUSED]: ORPCError}`, a symbol key that survives the merge with the path parameters), and a middleware throws it. Since membership now runs before decoding, the marker only orders the body's refusal (400/413/415) before validation's 422. It stays, so that an unreadable body is never reported as a validation error.

  The order is today's: CSRF and the declared cap (router), session, membership (mount), the body (400/413/415), validation (422), then the handler.
- **Cookies.** The session is read once, lazily, through a function in the context. oRPC 1.x takes only an object as context, not a function; 2.0 adds lazy context. The mount applies `withSessionCookies` to its own 401 and to whatever oRPC answers.

  Observed: a stale session's 3 clearing cookies, on a 401 for both GET and POST. Not observed: a refreshed session's cookie on a success or a domain refusal, because the trial had no easy way to make Better Auth refresh a session. These answers go through the same line of code, which is evidence but not proof.

  If reading the session itself fails, the error goes to Hono's `onError` without cookies, as it does for the Hono routes today.

Evidence:

| Request | Answer |
|---|---|
| member, schema-invalid body `{"name":"","connection_ids":["nope"]}` | 422 `UNPROCESSABLE_CONTENT`, `data.issues` for `name` and `connection_ids[0]` |
| **non-member**, the same body | **401** `UNAUTHORIZED` |
| non-member, `{"name":` (unparseable) | 401 |
| non-member, 3 MB chunked | 401 (not read) |
| member, 3 MB chunked | 413 `PAYLOAD_TOO_LARGE` |
| member, form body | 415 `UNSUPPORTED_MEDIA_TYPE` |
| stale session cookie (signed out elsewhere), invalid body | 401 **with 3 `Set-Cookie`** (`minerva.session_token`, `session_data`, `dont_remember`, `Max-Age=0`), the same as the Hono route `GET …/connections` |
| unknown path: member / non-member | 404 `{detail}` (Hono) / 401 |
| unsafe request without the CSRF token | 403 from the router (the mount is registered as an endpoint, so the CSRF check sees it) |

The rows above were rerun after membership moved into the mount.

Not covered by the trial: a body or query `workspaceId` that disagrees with the path (oRPC's merge gives the path precedence, and the middleware compares the result with the mount's workspace, but no request tested it), percent-encoded paths, and wrong methods.

## Shape

### 3. The conversation read can stay streamed as a handler

`StandardOpenAPICodec.encode` passes a `ReadableStream` output through untouched, and `toFetchBody` returns it before it touches any header. The handler returns `conversationBody(...).body`, today's `streamedJson` built from paged Durable Object reads (1,000 events or 4 MiB a page). Because oRPC hands over the same stream object, the Worker's buffering, backpressure and cancellation are whatever `streamedJson` already does. That is inferred from the code: the trial did not test a large conversation, a slow reader or a cancelled request. What was observed: curl shows `transfer-encoding: chunked` and no `content-length`, and the browser rendered a real conversation (1 run, 8 events).

The browser parses the whole JSON at the end, as hey-api does today. Paging the full snapshot would add round trips without saving browser memory. Paging could save memory only with a different UI that loads runs on demand, and that is out of scope here. Keeping the read outside the contract would lose the typed client for one of the two main reads.

Two pieces of code make this work:

- In the contract, `.output(type<ReadableStream<Uint8Array>, Conversation>((body) => body as unknown as Conversation))`. The server type is the stream and the client type is the parsed conversation. This is an explicit lie at the type level: nothing checks that the streamed JSON matches `Conversation`, now or after A4 renames fields. A test should parse a real response with an independent schema. It also means no response schema in a generated OpenAPI document. The trial did not generate an OpenAPI document at all; whether the `uuid()` transforms and the stream output produce a usable one is unproven.
- In compact output mode oRPC sets no `Content-Type` on a stream, so the mount adds `application/json; charset=utf-8`. The link parses a missing type as JSON anyway. With `outputStructure: 'detailed'` the handler can set the header itself, at the cost of `{status, headers, body}` on the client.

A stream that fails after its first byte reaches the client as a plain `Error("Cannot parse response body…")` with no status. The query retries it, as today.

### 4. Refusals as declared errors; proxies' errors keep their status; the two 503s stay distinct

- **Mapping.** `Refusal` has only `{status, detail}`, so `orpc.ts` maps status to oRPC's common codes (404 `NOT_FOUND`, 403 `FORBIDDEN`, 422 `UNPROCESSABLE_CONTENT`, …) with `message: detail`. The contract declares them, so they arrive with `defined: true`. The revocation 503 has its own code, `RUNS_STILL_STOPPING` (status 503). Validation's 400 `BAD_REQUEST` (with a `ValidationError` cause) is rethrown in a `clientInterceptor` as 422 `UNPROCESSABLE_CONTENT` with `data.issues: [{path, message, code}]` and the message `"<field>: <msg>"`.
- **Wire format** (every error oRPC answers): `{"defined":true,"code":"UNPROCESSABLE_CONTENT","status":422,"message":"Keep at least one agent."}`.
  - **`defined` is set by the server.** It is true only when the code (and status, and `data`) matches the procedure's declared errors (`validateORPCError`). The reader's `BAD_REQUEST`, `PAYLOAD_TOO_LARGE` and `UNSUPPORTED_MEDIA_TYPE` are not declared in the trial and arrive with `defined: false`.
  - **Not every error is oRPC's.** The router's early refusals (the declared 413, CSRF's 403), Hono's 404 for an unknown path, uploads and Better Auth still answer in other shapes. Changing `app.notFound` and `onError` covers only the first two; the rest stay explicit exceptions. On the client it is `ORPCError` (it extends `Error`, so `errorMessage` reads `.message`), with `code`, `status`, `data` and `defined`. `isDefinedError` narrows it to the declared codes.
- **Weakness.** A refusal and a validation failure share `UNPROCESSABLE_CONTENT`, and "keep one agent" and "choose connections" share a code. Typed errors pay off only if `Refusal` carries a code of its own (see A3).
- **Answers from something else** (`trial/link-errors.ts`; `OpenAPILink` decodes a body that is not an oRPC error into `code` from the status, `defined: false`, and `data: {status, headers, body}`):

```
proxy 502 (HTML)                   -> ORPCError code=BAD_GATEWAY status=502 defined=false data.body=Blob
proxy 504 (no body)                -> ORPCError code=GATEWAY_TIMEOUT status=504 defined=false
proxy 503 (text)                   -> ORPCError code=SERVICE_UNAVAILABLE status=503 defined=false data.body="upstream unavailable"
declared 503 RUNS_STILL_STOPPING   -> ORPCError code=RUNS_STILL_STOPPING status=503 defined=true
network failure                    -> TypeError (as today)
200 cut short                      -> Error "Cannot parse response body…" (no status)
502 with a JSON type, broken body  -> Error "Cannot parse response body…" (no status!)
503 whose body breaks mid-stream   -> Error "Cannot parse response body…" (no status!)
our server's undeclared 503        -> ORPCError code=SERVICE_UNAVAILABLE status=503 defined=false, data undefined
```

**The status is lost when an error body cannot be read.** The link reads and parses the body before it looks at the status (`StandardOpenapiLinkCodec.decode`). A proxy's 502 that claims JSON, or a 503 whose connection drops mid-body, arrives as a plain `Error` with no status, the same as a cut-short 200.

A `fetch` wrapper in the link fixes this (tested in `trial/link-errors.ts --keep-status`). It buffers a non-2xx body and passes it on as text if it does not parse, or with no body if it cannot be read. With it, both cases become `ORPCError` `BAD_GATEWAY` 502 and `SERVICE_UNAVAILABLE` 503, with `data.body` set; every other row is unchanged. Error bodies are small, so buffering them costs nothing.

So F2's retry rule can be: retry a network failure, or an `ORPCError` with status 502, 503 or 504 that did not come from our server.

- **"Did not come from our server"** is `'body' in error.data`: the link's marker for an answer that is not oRPC's error JSON. It is better than `!defined`, because our server's undeclared errors are `!defined` too. In the trial, a Durable Object refusal with status 502 or 503 maps to an undeclared code, and the send would retry it. A3 should declare every code the Worker can send; then the two tests agree.
- **A declared 503** (runs still stopping, a server-side "busy" refusal) is never retried.
- **A network failure is a `TypeError` from `fetch`**, but the link also throws `TypeError` for an input of the wrong shape (`[StandardOpenapiLinkCodec] Invalid input shape…`, a programming error). The rule should test `fetch`'s failure in the link's `fetch` wrapper (wrap it in a marked error) rather than test `instanceof TypeError` afterwards.
- **Test it through the real send mutation.** The send is not in the trial's contract, so the trial did not show the retry going through the send mutation with its unchanged `Idempotency-Key` header. A3 must show that, with a test.

A caveat: `defined` is whatever the response body says, and the client trusts it. A proxy will not send oRPC's JSON, so this is acceptable.

## Cost

### 5. Bundle

`vite build`, sum of all JS in `dist/assets`, gzip -9:

| | raw | gzip |
|---|---|---|
| before | 1,262,599 | 398,004 |
| after (oRPC added, hey-api still present for the other routes) | 1,300,561 | 410,422 |
| **difference** | **+37,962** | **+12,418 (+3.1%)** |

Where it comes from: a new `orpc` chunk of 26.0 KB (8.85 KB gzip: client, link, standard-server, the TanStack utilities, the contract), and the zod chunk growing by 26 KB (+6.9 KB gzip). The contract's runtime schemas pull in `ZodNumber`, `ZodBoolean` and `ZodVoid`, which the frontend did not use before; there is one zod copy, thanks to `dedupe`. The browser never validates with these schemas: the link only reads the paths and methods.

For comparison, esbuild of the whole hey-api surface (`sdk.gen` + `react-query.gen` + `client.gen`, react-query external) is 20.7 KB raw and 5.5 KB gzip, against 46.7 KB raw and 14.9 KB gzip for `lib/orpc.ts` with the contract (zod and react-query external). After A3 removes hey-api, the net change should be roughly +7 to +10 KB gzip. That is an estimate from these two numbers, not a measurement of the full contract, and it grows with the contract's zod schemas. The trial did not measure the first route's own bytes (the `orpc` chunk loads with the pages that use it) or the Worker's startup time. Output schemas written as `type<T>()` instead of zod would cost nothing in the bundle, at the price of no response schemas in the OpenAPI document.

Worker side: `OpenAPIHandler` with `implement`, `ORPCError` and `ValidationError`, bundled and minified with esbuild, is 37.8 KB (12.2 KB gzip). That is negligible.

### 6. Event iterators do not replace `EventSource`

Read in `@orpc/standard-server-fetch` `toEventIterator` and `@orpc/client/plugins` `ClientRetryPlugin`, and tested in `trial/sse-resume.ts` with `ClientRetryPlugin` and `retry: 5`:

```
clean close without `done` -> ended normally after 1 request(s); events 1 2            <- no reconnect
connection error mid-stream -> reconnects with last-event-id 2, 4, 6                  <- resumes
first answer 401            -> retried (shouldRetry defaults to true)                 <- EventSource would stop
```

- **A clean end of the body ends the iterator.** `reader.read()` returning `done` is treated as completion. Our relay ends responses on purpose (a slow client, too many 1013 reopens, a lapsed session), and so can proxies. The browser's `EventSource` reconnects in all of these cases; oRPC's client stops silently. Matching it needs a wrapper that reconnects until the run's terminal event arrives, which is `EventSource` written again.
- **The retry count is per call, not per disconnection** (`attemptIndex` never resets), so a long run needs `retry: Infinity`. Without a `shouldRetry`, that also retries 401 and 404 forever.
- **The wire format changes.** oRPC reads only the `message`, `error` and `done` events. Our stream names events by type (`event: status`) and ends with `event: end`. Both would move into `data`.
- `Last-Event-ID` works (the `last-event-id` header from the event's `id`), and so does the server side (`lastEventId` in the handler).

Recommendation: keep `run-stream.ts`'s `EventSource`, outside the contract, with its path and the `RunEvent` union in the contract module.

### 7. Version: 1.x, pinned at 1.15.6

`npm view @orpc/server dist-tags`: `latest` is 1.15.6 (2026-10-12), `beta` is 2.0.0-beta.43 (2026-10-09). 2.0 has not left beta; it ships about once a week. Note that **orpc.dev documents 2.0**: `asyncIteratorObject`, `@orpc/tanstack-query@beta`, lazy `context` functions, and `@standard-server/*` packages. The 1.x documentation is at `v1.orpc.dev`. A3 should start on the newest 1.x, pinned exactly, unless 2.0 has a final release by then. The trial's code touches the same extension points in both (interceptors, `implement().use`, `type`, `OpenAPILink` `fetch`), so a later move should be small. That is a reading of the 2.0 docs, not a tested upgrade.

## Other notes

- **Coexistence with Hono.** Better Auth's `/api/auth/*`, the upload (XHR, raw body over 2.5 MB), downloads (a 302; `OpenAPILink` does not follow redirects in browsers) and the run stream stay Hono routes, registered **before** the oRPC mount. The router's `requestRules` finds "the endpoint" with `matchedRoutes(c).find(route => route.method !== "ALL")`, so:
  - a mount registered as `app.use` or `app.all` (method `ALL`) is invisible to it, and **CSRF would be skipped**;
  - a wildcard registered **before** the upload route would become the upload's "endpoint", and uploads would get the 2.5 MB cap and an early CSRF check.

  The mount is therefore `app.on([methods], '/api/workspaces/:workspace{uuid}/*')`, after the other routes. When oRPC does not match, the mount calls `next()`, and Hono's 404 answers in the old `{detail}` shape. In A3 `app.notFound` should answer in oRPC's error shape.
- **Path parameters.** rou3 has no regular-expression patterns, so a malformed `agentId` is now 422 `agentId: Invalid UUID` rather than 404. A malformed `workspaceId` is still 404, from the mount's UUID pattern.
- **Query keys** are `[['agents','list'], {input: {workspaceId}, type: 'query'}]`. `.key()` takes `PartialDeep<input>` and matches as a prefix. Invalidating "a conversation, its list and its files" reads:

  ```ts
  queryClient.invalidateQueries({ queryKey: orpc.conversations.get.key({ input: { workspaceId, conversationId } }) })
  queryClient.invalidateQueries({ queryKey: orpc.conversations.list.key({ input: { workspaceId } }) })
  queryClient.invalidateQueries({ queryKey: orpc.conversations.files.key({ input: { workspaceId, conversationId } }) }) // every version
  ```

  The agents page now invalidates with `orpc.agents.key()`. Deleting an agent removes `orpc.conversations.get.key()`, in place of `[{ _id: 'getConversation' }]`.
- **TanStack defaults.** `main.tsx`'s query `retry` looked for `{detail}`. It must also stop retrying an `ORPCError` with a status below 500, or every 4xx is asked for three times.
- **Typecheck time** (`--extendedDiagnostics`, warm, one run each): a small increase.

  | | Files | Instantiations | Check time | Total |
  |---|---|---|---|---|
  | frontend before | 1,767 | 472,762 | 1.33 s | 2.10 s |
  | frontend after | 1,998 | 490,071 | 1.37 s | 2.20 s |
  | Worker before | 2,534 | 1,455,651 | 3.93 s | 5.21 s |
  | Worker after | 2,778 | 1,471,501 | 4.11 s | 5.52 s |

  `tsc -b` wall time for the frontend is about 2.7 s both before and after. The Worker's `tsc` checks the contract and its implementation with no explicit annotations: handler inputs, outputs and middleware contexts are all inferred.
- **The contract's home.** The frontend imports `cloudflare/src/contracts/http.ts` through an alias. That file's `zod` and `@orpc/contract` imports resolve to `cloudflare/node_modules`, so the trial needed Vite `resolve.dedupe` and tsconfig `paths` for both. Even so, the frontend program loaded one `.d.mts` from the Worker's copy of `@orpc/contract`; it typechecks only because the two copies are the same version. The contract also drags `contracts/api.ts`, `runs.ts`, `policy.ts`, `common.ts` and `lib/json.ts` into the frontend's program (all type-only). A3 needs a single home: a pnpm workspace with a `contract` package depending on `zod` and `@orpc/contract`, which both packages depend on.
- **Output validation.** With zod output schemas (agents), the server validates every answer, and `z.object` drops fields not in the schema: a guard against leaking fields, at some CPU cost. `type<T>()` skips both.
- **`JsonifiedClient`** is needed for `OpenAPILink` clients (dates and the like arrive as JSON). It does not matter here, since the API sends strings.
- **The CSRF header in the trial** is added in the link's `fetch` override, which also calls the 401 handler. Both disappear or move when A1 drops the token.

### Existing checks on this branch

- Frontend `pnpm check`: lint, format, typecheck and the unit tests (17) pass. knip reports the two `trial/` scripts as unused files.
- Worker `pnpm typecheck`: passes.
- Worker `pnpm test:platform`: **9 failed**, 394 passed, 3 skipped (28 files, 3 failing). All failures are expected:
  - `api.test.ts` (7): they expect `{detail}` and the 422 list, where the trial answers in oRPC's error shape.
  - `chat.test.ts` (2): the same, for the conversation read.
  - `frontend-messages.test.ts`: cannot resolve `@contract`, because the vitest alias for frontend sources lacks it. This is a broken test configuration, not an expected incompatibility. The contract package (A3) removes the alias.

## Recommended changes to A1–A3

**A1**
- Make the CSRF origin check independent of route matching. Today it is skipped for routes Hono sees as middleware, which a mounted oRPC handler is. It should run for every unsafe request under `/api/`, before any body is read, uploads included, as A1 says. Only `/api/auth/*` is exempt, because Better Auth has its own check. Keep the three rules apart: the origin check (everything), the JSON cap and JSON content type (JSON endpoints only; uploads and Better Auth are exempt from both).
- Read every JSON body with one reader that enforces `Content-Type: application/json`, the cap, strict UTF-8 and `parseJson`. A3 plugs that same function into oRPC's interceptor.
- Give `Refusal` a machine-readable `code` next to `status` and `detail` (for example `KEEP_ONE_AGENT`, `CHOOSE_CONNECTIONS`, `CANNOT_CHANGE`, `RUNS_STILL_STOPPING`). This could fall to the backend's cleanup instead. Either way, A3's declared errors then map 1:1 rather than by status.

**A2**
- No change from the trial. When the first message creates its conversation, give its refusals codes too, so the new-chat page's retry rule is the same as the send's.

**A3** (replace the corresponding bullets)
- The contract lives in a workspace package (pnpm workspace, `contract/` with `zod` and `@orpc/contract` as its dependencies), imported by both packages. Do not use a cross-package alias.
- In the Worker:
  - One `OpenAPIHandler`, mounted with `app.on([methods], '/api/*')` after Better Auth's route, the upload, downloads and the run stream.
  - An interceptor that replaces `request.body` with A1's reader, returning a marker on failure.
  - `implement(contract).use(workspaceMatches).use(bodyRefusal)`, with membership in the mount (below), so that today's order holds. The instance admin's role is a further `.use()`, still checked in SQL.
  - The session is read lazily, and the mount adds its cookies to every answer.
  - A `clientInterceptor` turns validation failures into 422 `UNPROCESSABLE_CONTENT` with `data.issues`, and logs anything that is not an `ORPCError`.
  - `app.notFound`, `onError` and the router's early refusals answer in oRPC's error shape. Uploads and Better Auth remain documented exceptions.
  - Session and membership are checked in the mount from the path's workspace, before `handler.handle`. The member goes to oRPC in the context, and a middleware checks that the input's workspace is that one.
  - Every code the Worker can send is declared in a common error map (including `BAD_REQUEST`, `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE` and the refusals' codes), so `defined` means "from our server".
  - The integration matrix, run on every oRPC update:
    - the parser: the escaped key `\n` after `\\`, a form body (415), the streamed cap;
    - the order: a non-member's slow body gets 401 at once, and 401 comes before 400/413/415/422;
    - the session: cookies on success, on a refusal and on a 401;
    - paths: a body or query `workspaceId` that disagrees with the path, UUID spellings, percent-encoded paths, unknown routes and wrong methods;
    - the stream: a large conversation, a slow reader, a cancelled request, and a producer failing mid-body, through the real client;
    - the conversation's JSON parsed with an independent schema.
  - Header-bearing calls (the send's `Idempotency-Key`, the instance setup header) go through the typed client, using the contract's `inputStructure: 'detailed'` or a link header option. The trial did not cover them; A3's first step should.
  - Output validation can fail after a write has succeeded (a 500 for a saved change). For writes, prefer `type<T>()` outputs, or treat a 500 after a write as "may have been saved" when restoring the composer.
- The conversation read (and the run read, `runBody`) stays in the contract as a streamed handler, typed `type<ReadableStream<Uint8Array>, T>(…)`, with the content type set (detailed output or the mount).
- The run stream stays `EventSource` outside the contract. Its path and `RunEvent` go in the contract module.
- In the frontend:
  - One `OpenAPILink` whose `fetch` handles 401.
  - `errorMessage` reads `ORPCError.message` and replaces an undeclared answer's message (`!defined` with `data.body`) by `serverErrorMessage(status)`.
  - Query `retry` stops on an `ORPCError` below 500.
  - The link's `fetch` wrapper keeps an error answer's status (non-2xx bodies buffered; text if not JSON) and marks `fetch`'s own failures.
  - F2's send retry becomes "a marked network failure, or 502/503/504 not from our server (`'body' in data`)".
- Pin the newest 1.x exactly; take 2.0 only once it has a final release. Read `v1.orpc.dev`, not `orpc.dev`, while on 1.x.
- Decide per endpoint between zod output schemas (validated, fields stripped, documented, larger bundle) and `type<T>()` (free, undocumented). A sensible default is zod for small resources and `type` for the streamed reads.
