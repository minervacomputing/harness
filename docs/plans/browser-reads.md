# Browser reads design: every page opens in Cloudflare's browser

Status: proposed, 2026-10-26, with every owner question answered. Not built, and nothing deployed. Line numbers are at `5d85043` (harness) and at `a6bed42` of `minervacomputing/app` ("the app's" below). Browser Run's behaviour comes from Cloudflare's docs, read 2026-10-25 and 2026-10-26 (each cited with the date its page was last updated), and from the runtime types the build generates (`cloudflare/.cloudflare/types/index.d.ts`, "the types" below). A claim about code with no label was read at the lines cited. One marked (measured) was run on 2026-10-26, one marked (inferred) follows from code or docs that were read, and one marked (guess) rests on platform behaviour no document states. Once built, what stays true moves into ARCHITECTURE.md, docs/connectors.md, docs/data-processing.md and cloudflare/README.md, and this file is deleted.

This design replaces an earlier one that kept Minerva's own fetcher and rendered only pages that came back empty, with Kitesurf and then Chromium. The owner chose on 2026-10-26 to move every page read to Browser Run, Kitesurf only, and to delete the fetcher. Findings of that design's reviews that still apply are folded in.

Review: opencode reviewed this design adversarially on 2026-10-26. The findings that held and can happen in real use are folded in (Amendments after the review).

## Why

- **Some pages arrive empty.** `read_page` fetches a page once and reduces its HTML to text (`cloudflare/src/connectors/web/connector.ts:149-155`). A site that builds its content with scripts sends a shell, and the reducer drops scripts and `<noscript>` (`cloudflare/src/lib/markdown.ts:11-15`), so the model gets a title and almost no text (inferred).
- **The fetcher is code Minerva keeps.** Redirects, decompression, charsets, size and time limits and the platform's refusal are 559 lines in `fetch.ts`, `inflate.ts` and `pako.d.ts`, with the `pako` dependency and their tests. Browser Run does all of it, and returns Markdown.
- **Cloudflare can open the page in one call.** Browser Run's Quick Actions load a page in a browser and return the result, with no session kept between calls (developers.cloudflare.com/browser-run/quick-actions, Oct 10 2026). Its engine Kitesurf is "an ephemeral, fully-isolated, stateless engine designed to exist only for the duration of a task", and is free during its beta (/browser-run/kitesurf, Oct 6 2026).
- **Cloudflare's Markdown for Agents does not fix empty pages.** It converts the HTML a site's server sends, with scripts stripped, and only on sites whose owner turned it on (/fundamentals/reference/markdown-for-agents, Oct 9 2026). Minerva's Accept header lists `text/markdown` beside `text/html` (`cloudflare/src/connectors/web/fetch.ts:35`), and with it Cloudflare's blog and docs answered HTML; only an Accept that prefers `text/markdown` got Markdown (measured).

## The owner's requirements

The owner's requirements, 2026-10-26:

1. Every page the agent opens goes through Browser Run. Minerva's own fetcher is deleted.
2. Kitesurf only. Chromium is not used.
3. Reading stays read-only: the page's scripts do not run, so nothing but GET requests to the granted host is sent, and as little as possible beside the page itself loads.
4. A separate permission, **Open in browser**, runs the page's scripts and returns Markdown or a screenshot.
5. Only https pages are opened.
6. No browser session stays open between calls, and per-site grants keep working as today.

## What this design changes

- **`read_page` opens the page in Kitesurf with scripts off** and returns Browser Run's Markdown. Its input and record keep today's fields.
- **`browse_page` opens it with scripts on** and returns Markdown. **`screenshot_page`** does the same and returns an image the model sees.
- **The Web site kind gains the action `browse`** ("Open in browser"), which requires `read` on the same site. Both new operations need it. A site granted only `read` today is not browsable until someone grants `browse`. A layer that is unrestricted allows every action (`cloudflare/src/gateway/policy.ts:140-142`), so where every layer of a run is unrestricted, `browse` is allowed from the engine's deploy on, before Laravel approves the new entry (owner question 10).
- **The browser reaches only the granted host.** Every request it makes must match the page's own origin on https. A move to another host gives today's `redirect_to` record.
- **http addresses open as https** on the same host (owner question 2). A site without https fails with a message.
- **At most 100 browser calls per run** across the three operations (owner question 3).
- **Screenshots travel as images in the tool result**, a new path from a connector to the model.
- **No setting.** Every build with the `BROWSER` binding reads through it. The dev server offline and the test build have no binding, and their `read_page` reached no page before either.
- **No change to the contract or to Laravel's code.** The catalog's version changes (a new action, two operations and a new site note), so the operator approves Web once on staging and once on production.

**What this does not promise.** Pages behind bot protection or a login stay unreadable, since Browser Run "does not bypass CAPTCHAs, Turnstile challenges, or any other bot protection mechanisms" (crawl endpoint docs, in llms-full.txt), and Kitesurf cannot "negotiate a bot-challenge handshake with real TLS fingerprints" or play video or WebGL (/browser-run/kitesurf). A page whose scripts or data come from another host stays thin, since the browser may not reach that host. Kitesurf trades away "pixel-perfect rendering" (/browser-run/kitesurf), so a screenshot may differ from Chrome's.

## What the code does today

| Claim | What the code does |
|---|---|
| `read_page` fetches only after authorization | `prepare` parses the address and asks for read on the site (`connector.ts:143-147`); `execute` calls `fetcher.get` (`:149`). |
| A move to another host goes back to the model | The fetcher follows a redirect only on the same host and never from https to http, and returns `Moved` otherwise (`fetch.ts:385-399`); the record carries `redirect_to` and `MOVED_NOTE` (`connector.ts:134`, `:150-152`). |
| The record | `url`, `title`, `content_type`, `text`, `offset`, `total_chars`, `next_offset`, on the resource of the host the fetch ended at (`connector.ts:153-174`). |
| Its errors | `SITE_UNREACHABLE`, `PAGE_TOO_LARGE`, `SITE_NOT_PUBLIC`, `UNSUPPORTED_CONTENT`, `PAGE_ERROR` and `SITE_TIMEOUT` (`fetch.ts:93-101`, `:145`, `:360-408`). |
| What it reads | HTML, and JSON, XML, plain text, Markdown and CSV as they are (`fetch.ts:62-63`, `:137-145`), up to 3 MB in 25 s (`:48-51`). |
| Private addresses | `lib/sites.ts` refuses IP literals and special-use names before anything is sent (`cloudflare/src/lib/sites.ts:8-11`). The platform refuses a Worker's request to a private address, and `platformRefusal` recognises it (`cloudflare/src/gateway/http.ts:405-412`). That refusal is measured, not documented (ARCHITECTURE.md, Spike results). |
| Who uses the fetcher | Only the Web connector. `platformRefusal` has no other caller; its test is in `test/unit/http-client.test.ts:341-343`. `pako` is imported only by `inflate.ts`. |
| Who uses the converter | `htmlToText` (`lib/markdown.ts`) also reduces Gmail's HTML parts and Google Calendar's descriptions (`src/connectors/gmail/mime.ts`, `src/connectors/google_calendar/connector.ts`), so it stays. `lib/charset.ts` stays for Gmail. |
| The site kind and its actions | One action, `read` ("Read pages"), and a note the granting person sees (`connector.ts:198-212`). An action may name the action it `requires` on the same resource (`cloudflare/src/gateway/connector.ts:20-21`). |
| Laravel's grant editor | Built from the approved catalog's kinds, actions and `requires` (the app's `resources/js/components/connections/access.ts`; `docs/architecture/connectors.md:19`), so a new action needs no Laravel code. |
| The catalog's version | Hashes each connector's entry: its kinds with their actions and notes, its actions with their `requires`, and each operation's name, title, needs, consent, `mutates` and `offered` (`cloudflare/src/internal/catalog.ts:40-86`), not descriptions or revisions. |
| A connector's result | JSON records only (`ProviderOutput`, `gateway/connector.ts:45-56`). The executor drops a record on a host the policy denies (`visibleResult`, `cloudflare/src/gateway/executor.ts:267-294`). The model reads the `ToolResult`'s JSON as one text part (`render`, `cloudflare/src/conversation/tools.ts:59-62`), and `ToolResult`'s schema is closed (`cloudflare/src/gateway/results.ts:18-33`). |
| Images to the model | Only through `read`, from a file in the folder, at most 2000 pixels a side and `IMAGE_MAX_BYTES` (1.5 MB of base64), since pi keeps a tool's result in one SQLite row (`cloudflare/src/model/provider.ts:146-152`; ARCHITECTURE.md, The harness). pi-ai's tool result content may hold images, and a model that takes text only gets a placeholder (`cloudflare/src/model/policy.ts:44-62`). |
| The deployed model | Staging and production run OpenAI's `gpt-6.1-sol` (their `vars.env`), which the engine treats as taking images (`cloudflare/src/model/route.ts:85`). |
| What Laravel gets of a call | The `tool_call` event: tool, label, arguments and decision, never the result (`contract/src/shapes.ts:77-103`). |
| Laravel's chat and images | Markdown images are never loaded; they show "[image not loaded]" (the app's `resources/js/components/chat/thread.tsx:494-499`). |
| The io | The connector's only network is the call's io (`connector.ts:221-225`). `CallIo.#send` checks `admits()` synchronously before each request (`http.ts:276-283`). A cancel stops the wait (`executor.ts:584-602`). |
| Ports | The executor's context is built per run (`cloudflare/src/conversation/conversation.ts:1347-1369`) from the ports (`cloudflare/src/conversation/ports.ts:128-134`). The Images binding is left out offline (`cloudflare/cloudflare.config.ts:169-171`). The test build's ports reach only `*.fake.invalid` (`cloudflare/src/faults/ports.ts:64-66`, `:209`). |
| The fingerprint | Covers `revision`, not the description (`cloudflare/src/gateway/registry.ts:256-271`). `read_page`'s is pinned (`cloudflare/test/unit/connectors-web.test.ts:105`). A changed fingerprint refuses the tool with `OPERATION_CHANGED` for the rest of a run in progress (`registry.ts:383-388`). |
| Reads repeat | A read replays after a restart up to twice (`REPLAYS_ALLOWED`, `tools.ts:38`), and a continuation with `offset` fetches again. |

## What Browser Run offers

- **The calls.** `env.BROWSER.quickAction("markdown", options)` answers JSON `{success: true, result, meta}` with Markdown in `result` (the types, `:11831-11837`, `:12136-12152`). `quickAction("screenshot", options)` answers the image's bytes with its type, and no `meta` (`:12020-12036`). An error is JSON `{success: false, errors}` with status 400, 422, 429, 500 or 503 (`:11839-11847`). `quickAction` takes no abort signal.
- **`meta`.** `status` and `title` of the rendered page, optional `headers` (the origin's, lowercased), optional `finalUrl` ("URL that served the response, after any redirects the browser followed") and optional `redirectChain`, whose hops carry their `location` header and which leaves out client-side moves (`:11679-11698`).
- **Kitesurf.** `browser: "kitesurf"` on `markdown` and `screenshot` (`:11539-11546`, `:11574-11581`). `snapshot`, which returns Markdown and a screenshot in one call, rejects it (`:11539-11542`).
- **Options shared by every action** (`:11439-11537`): `setJavaScriptEnabled`, `allowRequestPattern` or `rejectRequestPattern` (regular expressions on request URLs), `allowResourceTypes` or `rejectResourceTypes`, `gotoOptions` (`timeout` at most 60 s, `waitUntil`), `bestAttempt`, `actionTimeout`, `userAgent`, `viewport` (default 1920 by 1080), `cacheTTL` (default 5 s). None matches a request's method. The content endpoint's page says "only allow requests that match `allowRequestPattern` or `allowResourceTypes`" (Sep 26 2026), so whether a pattern and a type filter together mean both or either is not documented. Whether Kitesurf honours each option is not documented.
- **Screenshots.** `screenshotOptions` with `type` (`png`, `jpeg`, `webp`), `quality`, `fullPage` and `clip` (`:11555-11573`).
- **Measurement.** `X-Browser-Ms-Used`, set when the status is under 500 (`:12034`). Whether Kitesurf sets it is not stated.
- **Limits and price.** Quick Actions are capped at 30 requests a second per account (/browser-run/limits, Oct 14 2026). Kitesurf "is in beta and available for free, behind per-account limits", with no numbers and no price for after the beta (/browser-run/kitesurf).
- **Where and what is kept.** "Close to the incoming request", with no jurisdiction option (/browser-run/faq, Jul 17 2026). Content is "immediately discarded" after the response, and output is cached 5 s per account unless `cacheTTL` is 0. Browser Run is not in the data localization compatibility table (Oct 15 2026).
- **What a site sees.** Requests from Cloudflare's IP ranges with `cf-brapi-request-id` and Web Bot Auth signature headers; "Requests from Browser Run will always be identified as a bot" (/browser-run/quick-actions/markdown-endpoint, Sep 26 2026).
- **No local simulator.** Without remote mode, `quickAction` fails with "The RPC receiver does not implement the method" (/browser-run/quick-actions).

## Decisions

### Three operations on one site list

| Operation | Needs | Scripts | Returns |
|---|---|---|---|
| `read_page` | `read` | Off | Markdown, today's record |
| `browse_page` | `browse` (requires `read`) | On | Markdown, the same record |
| `screenshot_page` | `browse` | On | A record and one JPEG |

- **One list of sites.** An admin allows reading on many sites and browsing on a few, in the same editor, as Laravel draws it from the catalog. A new action on the existing kind keeps one list, where a second connector would make a second one.
- **`browse` is a read.** Both operations declare no `mutates`. So whatever a page's scripts do, the call skips what guards a write: the write ledger and its deduplication, the pause after an uncertain write, running one at a time, and its settlement (`executor.ts:536-552`, `:601-605`; `cloudflare/src/conversation/tools.ts:98-109`). It runs in parallel with other reads and replays up to twice after a restart. It is not askable under the approvals design either (docs/plans/approvals.md, Askable actions). The `browse` grant on a site accepts all of this for that site (owner question 7). Marking it a write was rejected (Alternatives rejected).
- **Inputs.** `read_page` and `browse_page` keep `read_page`'s input (`url`, `max_chars`, `offset`). `screenshot_page` takes `url` only. `parseUrl` drops the fragment (`cloudflare/src/lib/sites.ts:244`), which an app that routes by `#/path` needs, so `browse_page` and `screenshot_page` send the parsed address with the input's fragment put back. A fragment never reaches a server, and authorization still uses the host.
- **Descriptions.** `browse_page`: "Open a web page in Minerva's browser, which runs its scripts, and read it as text. Use it when read_page returns little text. The page's scripts can act on the site as a visit would." `screenshot_page`: "Open a web page in Minerva's browser, which runs its scripts, and look at it as an image of its first screen."

### Reading with scripts off

- **The call.** `quickAction("markdown", {url, browser: "kitesurf", setJavaScriptEnabled: false, allowRequestPattern, cacheTTL: 0, userAgent: USER_AGENT, gotoOptions: {waitUntil: "domcontentloaded", timeout: 10_000}, actionTimeout: 3_000})`, and the engine stops waiting after 15 s.
- **As little as possible beside the page.** `allowResourceTypes: ["document"]` is added beside the pattern only if P1 shows that both must match; if either is enough, a document on another host would pass. If they combine as either, `rejectResourceTypes` with every type but `document` is tried, and failing that the pattern alone is the filter, with the same host's sub-resources allowed. No filter tells the top-level page from a frame on the same host, since both are documents, so a same-host frame may load in every case (owner question 9).
- **Why scripts off makes it a read.** Without scripts a page cannot send a POST or submit a form by itself. It can still load the same host's resources and follow a meta refresh, both GET requests to that host. One GET of a plain link can still act on sites that act on GET, as today.
- **A browser keeps cookies within one call, scripts or not.** Today's fetch sends no cookies and keeps none between same-host redirects (`fetch.ts:14-16`, `:333-347`), so a sign-in link handled by the server ends on an anonymous page. In the browser, a link that sets a session cookie and redirects on the same host signs it in for that call, and `read_page` returns the account's page. Agents that open links from a user's mail do this in ordinary use. Nothing in Browser Run's options turns cookies off, so this is part of moving reads to a browser (owner question 9), and P1 records it.

### Browsing with scripts on

- **Markdown.** The same call with scripts on, `gotoOptions: {waitUntil: "networkidle2", timeout: 8_000}`, `actionTimeout: 3_000`, `bestAttempt: true` and `rejectResourceTypes: ["image", "media", "font"]` if P2 shows it keeps the pattern in force. The engine stops waiting after 15 s. Cloudflare recommends `networkidle0` or `networkidle2` for single-page apps (/browser-run/faq).
- **The page is a visit.** Its scripts can send any method to its own host, with the cookies the site set during that load. A page that confirms, approves or unsubscribes by submitting itself does so. A sign-in link handled in the page signs the browser in for that render, and the model reads that account's pages. A page that turns its address into a form submission lets the model choose what is posted. Each continuation with `offset` and each replay renders again, so such an action can run more than once. This is what `browse` grants, and its note says so.
- **No state between renders.** Kitesurf is documented as stateless. Every customer renders through one account, so a browser that kept a cookie or a service worker would carry one customer's session into another's render of the same site. P4 confirms it, and Kitesurf is not used if it fails.

### Screenshots reach the model as an image

- **The call.** `quickAction("screenshot", {url, browser: "kitesurf", allowRequestPattern, viewport: {width: 1280, height: 800}, screenshotOptions: {type: "jpeg", quality: 80}, …the waits of browse_page})`, with no resource type rejected, so the host's images show. Only the first screen, not the full page, so its size stays bounded (owner question 6). Images, stylesheets and fonts from another host, such as a CDN, are blocked by the pattern, so many sites' screenshots lack them.
- **Size.** The response is read up to 1,152 KiB, which is `IMAGE_MAX_BYTES` once in base64. A larger one fails with `PAGE_TOO_LARGE`. P4 measures typical sizes.
- **No `meta`.** The engine cannot see the page's status or where it ended. The pattern still keeps the browser on the host. The model sees the page as it rendered, an error page included, and the record says only what was asked: `{url, content_type: "image/jpeg", width: 1280, height: 800}`.
- **The image's path.** `ScopedRecord` gains an optional `image: {mimeType, data}` (base64). `visibleResult` keeps a record's image only with the record, so a denied host drops both. `ToolCallOutcome`'s success gains `images`, outside `ToolResult`, whose schema stays closed. `render` appends one `{type: "image", data, mimeType}` part after the JSON text. pi keeps it in the tool result's row, within `IMAGE_MAX_BYTES`, as `read`'s images are.
- **What else sees it.** Nothing. The `tool_call` event carries no result, the log never holds it, and a script gets the outcome's `result` only (`cloudflare/src/scripts/session.ts:184-188`), so a script's call to `screenshot_page` gives the record without the picture. pi's `outputLimits` bound only the text parts and keep image parts (`boundContent`, pi-durable `dist/harness/tool.js:708-725`).
- **Always a direct tool.** When a run has more gateway tools than fit, only the first are offered directly and the rest only through scripts (`modelTools`, `cloudflare/src/gateway/tools.ts:143-159`), where the image would be lost. `modelTools` therefore puts operations that return images first among the direct ones, from a flag on the operation's declaration that only `screenshot_page` sets.
- **The row.** The record's JSON is under 1 KB and the image at most `IMAGE_MAX_BYTES`, so the tool result's row stays within the bound `read`'s images use.
- **A model that takes no images** gets pi-ai's placeholder, "(tool image omitted: model does not support images)". The operation is offered either way, since `offered` cannot see the model.

### Only the granted host, only https

1. **Authorization first.** `prepare` parses the address and asks for the operation's action on its host, as today. Nothing is sent before it.
2. **https.** An http address is opened as https on the same host. The record's `url` is the https address.
3. **Every request the browser makes must match the page's origin.** `allowRequestPattern` is `^https://`, the host regex-escaped, then `/`. `^data:` and `^blob:` are allowed, since they reach no network themselves. Analytics, CDNs and other hosts' APIs are blocked, and so are another port and `wss:`. P1 and P2 decide which kinds of request this covers; ARCHITECTURE.md lists the kinds measured, and docs/connectors.md claims only those.
4. **A move to another host is shown, not followed.** For Markdown, `meta.finalUrl` is parsed with `parseUrl`. Missing, or not a web address Minerva opens (`about:blank`, a `chrome-error:` page), the call failed. On the same host, it is the record's `url` and the base for relative links. On another host, the record is today's `redirect_to` record with `MOVED_NOTE`. When the pattern stopped the move, `redirect_to` comes from the last hop of `meta.redirectChain` that names another host in its `location`, if P2 shows Browser Run reports a hop it did not follow; otherwise the record has the note "This page moved to another site, which Minerva's browser did not follow." and no `redirect_to`. A move made in the page (a script, a meta refresh) is not in `finalUrl`, and only the pattern stops it.
5. **The record names the page's host,** so the executor checks it against the policy again (`executor.ts:292`).

**Same host, not the run's grants.** A pattern from the run's whole policy would let a page load from every granted host. It needs the policy inside the connector and denies written as lookaheads, while same host is what the grant that authorized this call covers in every case.

### Private addresses

- **Browser Run is the only guard after the host rules.** `lib/sites.ts` still refuses IP literals and special-use names before anything is sent. The Worker's own refusal no longer applies, since the Worker sends no request to the site.
- **Browser Run's own refusal is the guard.** Kitesurf's requests go through a Worker, "SandboxOutbound" (blog.cloudflare.com/kitesurf, Aug 6 2026), so they probably meet the platform's refusal of private addresses (inferred). P3 measures it, over http so that a certificate failure cannot hide the answer, and names the refusal, which becomes `SITE_NOT_PUBLIC`. Kitesurf is not used without it.
- **TLS helps but does not replace it.** Every request goes over TLS to the granted name, so a name an attacker points at someone else's private server meets a certificate for another name and fails, if Browser Run checks certificates, which P3 checks. It does not stop a name whose owner holds a valid certificate and points it at a private address, as split-horizon names do. Only the refusal covers that.

### What the model sees

Today's record and error codes stay, so the model's handling of a failed read does not change.

| Outcome | Result |
|---|---|
| `meta.status` 200 and `finalUrl` on the host | The record, Markdown sliced at `offset` and `max_chars` |
| `finalUrl` or a hop on another host | The `redirect_to` record, or the record with the note when the target is unknown |
| `meta.status` 400 or more | `PAGE_ERROR` "The site answered with HTTP {status}." |
| Another `meta.status` (204, a 3xx) | `PAGE_ERROR` "The site answered with HTTP {status}, which has no page." |
| `meta.headers["content-type"]` neither HTML nor a text type | `UNSUPPORTED_CONTENT` "Minerva cannot read {type} pages yet." |
| Browser Run 429 or 503 | `BROWSER_BUSY` "Minerva's browser is busy. Try again in a minute." |
| Browser Run 422 with code 2012 | `PAGE_ERROR` "Minerva's browser could not turn this page into text." |
| The engine stopped waiting | `SITE_TIMEOUT` "This site took too long to open." |
| The refusal P3 names | `SITE_NOT_PUBLIC`, today's message |
| A response over 8 MB, Markdown over 3 MB, or an image over 1,152 KiB | `PAGE_TOO_LARGE` |
| Anything else: a throw, Browser Run's other 400, 422 or 500, malformed JSON, no usable `finalUrl` | `PAGE_ERROR` "Minerva's browser could not open this page." |
| No binding | `BROWSER_UNAVAILABLE` "Minerva's browser is not available in this build." |
| The run made its 100 browser calls | `LIMIT_REACHED` "This run has opened as many pages as it may." |

For `browse_page` and `screenshot_page`, every failure after the call was sent adds "Its scripts may have run.", since the engine cannot tell how far the browser got. A 422 is usually a timeout or a crashed page (/browser-run/faq), but it is not a site that answered slowly for certain, so only the engine's own wait gives `SITE_TIMEOUT`. Only a `meta.status` of 200 supplies text, so an error page with text takes its status row. The title is `meta.title`; YAML front matter at the head of `result`, if P4 finds it, is removed. `content_type` is `meta.headers["content-type"]`'s media type, or null.

### Size and time

- **Markdown.** The response is read through a capped reader up to 8 MB and parsed with `parseJson` (a source rule forbids `.json()`, `cloudflare/test/unit/sources.test.ts:27`). `result` is at most 3 MB in UTF-8, today's `MAX_BODY`.
- **Time.** Each operation waits up to 15 s, where today's fetch had 25 s, and the wait covers reading the body. The timers sent bound the navigation and the action after it, not a browser's start, the conversion or the answer's delivery, and no overall limit is documented, so a call can outlive the engine's wait in ordinary use. The call then frees its slot, its result is dropped, and Cloudflare finishes the work. P4 records how long calls run; that is an observation, not a maximum.
- **`cacheTTL: 0`,** so a page reflects the site now and no output stays in the account's cache.
- **`userAgent` is `USER_AGENT`,** so a site sees Minerva's name, as today.

### Strict revocation

- **No browser call starts once the run is revoked.** It goes through the call's io, which checks `admits()` synchronously right before it, as `#send` does. The io's own `NotSent` and `ProgrammingError` pass through as they are. Anything `quickAction` itself throws is `PAGE_ERROR`, so none of it reaches the executor's log of unexpected errors (`executor.ts:478`).
- **A render already sent is handed off.** `quickAction` takes no signal, so a cancel only stops the engine waiting, and the result is dropped. The browser goes on loading the authorized host, with scripts on for `browse_page`, until Cloudflare ends it. No document bounds that time; P4 records what it observed. Today's rule, "a request already sent may complete" (ARCHITECTURE.md, Strict revocation), meant one HTTP request; ARCHITECTURE.md says what it means for a render (owner question 5).

### The cap, pricing and the log line

- **100 browser calls per run between restarts.** The run's browser port counts every `quickAction` it sends. Past 100, the three operations fail with `LIMIT_REACHED` and send nothing. The count lives in memory with the run's executor, so a restart or a deploy starts it again and allows 100 more, which a user or a page cannot cause on purpose. It bounds what one run, or a page that injects instructions, can take of Kitesurf's per-account limits, which every customer shares, and of a price Kitesurf may get. A turn has no limit on tool calls otherwise (ARCHITECTURE.md, Permissions).
- **Not charged.** Kitesurf is free in its beta, so nothing enters `chargedMicros`. When it gets a price, a later chunk charges it, which needs Laravel's `CheckUsage` deployed first (the app's `app/Console/Commands/CheckUsage.php:139`).
- **One log line per browser call:** the operation, an outcome from a fixed set (`ok`, `moved`, `site_status`, `busy`, `timeout`, `too_large`, `not_public`, `unsupported`, `failed`, `capped`), `meta.status`, Browser Run's numeric error code, `X-Browser-Ms-Used` or none, and the duration. Never the address, the host, Browser Run's error `message`, `detail` or `path`, or a thrown error's message, since those can quote the address and any token in it (guess).

### The binding and builds without it

- **`BROWSER: bindings.browser({ dev: { remote: true } })`** in `cloudflare.config.ts`, left out offline and in the test build, with a comment like the Images binding's.
- **A port,** `ConversationPorts.browser(context)`, returns null without the binding and otherwise a `quickAction` function that counts against the cap. It is called once per run's executor, so the count is the run's. `ExecutorContext` gains `browser`, `CallIo` gates it, and `ProviderIo` gains `browser: BrowserIo | null`. `settingsIo` has none.
- **The test build returns null,** as its network reaches only `*.fake.invalid`, so a Worker that the token-gated fault driver controls never reaches Browser Run, which reaches the whole web.
- **Mode `development`** (`pnpm exec vite`) has the binding and reads pages on the account's Browser Run, against its shared limits.
- **The deployed probe checks the boundary, not only the binding.** Kitesurf is a beta that can change after Unit 1 measured it, so `/api/probe` gains `browser`, three fixed calls that take nothing from the request: `read_page`'s options on `https://example.com/` (status, text length, whether `finalUrl` and `X-Browser-Ms-Used` came back, duration); and two calls with `html` set to a fixed page whose script writes a marker and sends a `no-cors` `fetch` to `https://example.org/`, writing whether it was blocked, under the pattern for `example.com`. With scripts off the marker must be absent; with scripts on it must be present and the fetch blocked. Without a binding `browser` is `null`. `test:deployed` asserts the three on staging and production, after every deploy and in the monthly check, and asserts `null` on the test instances, whose build has no binding. P4 checks that the canary works on Kitesurf.

### The contract, the catalog and the fingerprints

- **No contract change.** No fact, command or price changes, so Laravel deploys nothing.
- **The catalog.** The site kind's `actions` become `["read", "browse"]`, the connector's actions gain `{id: "browse", label: "Open in browser", requires: "read"}`, and the note becomes: "Search for a domain or paste an address to add it. Pages open in Cloudflare's browser. Agents can send information to the sites they may read, in the addresses they open. Open in browser also runs a page's scripts, which can act on the site, so allow it only on sites you trust. A block on a domain wins over access to a wider one." The note keeps one sentence per risk, since it is all the granting person sees. The detail (sign-in links, repeats, same-host frames, where pages are processed) goes in docs/connectors.md and in the public page about connectors' permissions that the owner plans for the website, which a later change links from the grant editor. The operator runs `minerva:catalog --approve --only=web` once on staging and once on production after the engine's deploy (the app's `docs/architecture/connectors.md:16-19`). Until then Laravel shows the old entry, so nobody can grant `browse`, and `read_page` works.
- **`read_page`'s revision becomes 2.** Its input and record are unchanged, but the address now goes to Cloudflare's browser and http opens as https, a change of meaning the declaration does not show. A run in progress at the deploy loses `read_page` until its next message. `browse_page` and `screenshot_page` start at 1. The pin at `connectors-web.test.ts:105` gains both.

### Where it runs and what Cloudflare sees

- **Every page the agent opens goes to Browser Run:** the address, which can carry whatever the agent put in it, tokens included; the page and its own host's resources; with `browse`, the session a sign-in link sets and the account's pages it shows.
- **Where:** "close to the incoming request", with no location guarantee, so possibly outside the EU, also for an EU workspace's conversation (owner question 1).
- **Kept:** page content is discarded after the response, and `cacheTTL: 0` turns the cache off. How long addresses and request metadata are kept is not documented.

## What is deleted

In Unit 2's commit, with their tests:

- `cloudflare/src/connectors/web/fetch.ts`, `inflate.ts` and `pako.d.ts`, and `pako` from `cloudflare/package.json` and the lockfile. `USER_AGENT` moves to the new `render.ts`.
- `platformRefusal` and its header line in `cloudflare/src/gateway/http.ts` (`:19`, `:405-412`), and its test in `http-client.test.ts`.
- `test/fixtures/connectors/web/fake.ts`, replaced by `fake-browser.ts`, and the fetch cases of `connectors-web.test.ts`.
- The Web connector's mentions in the headers of `lib/markdown.ts` and `lib/charset.ts`, which keep Gmail and Google Calendar.

## Deploy order and rollback

Deploys of staging and production ask the owner first (AGENTS.md, Cloudflare). Laravel's code is not deployed.

1. **Unit 1, the probes,** with the owner's go. If Kitesurf fails P1 to P4, or P5 falls below its mark, the design goes back to the owner before any code. There is no other engine to fall back on.
2. **Units 2 and 3,** two commits: `pnpm check --instance minerva-cf-test`, push `main`, green `main.yml`, then `account.yml` (`gh workflow run account.yml --ref main`) with all of `test:faults` and `test:deployed`, since `cloudflare.config.ts` changes.
3. **`minerva-cf-staging`,** once the owner says so: `pnpm run deploy`, `pnpm test:deployed --instance minerva-cf-staging`, then `minerva:catalog --approve --only=web` on Laravel's staging, then the live checks.
4. **`minerva-cf`,** only after staging's live checks pass and the owner says so (owner question 8): the deploy, then the Web approval on Laravel's production.
5. **A usage notification for Browser Run** on the account, with the owner's go, since it changes the account. It warns when browser hours pass the 10 included a month, so a price for Kitesurf shows within days rather than at the monthly check.

**Rollback** is reverting the commits and deploying, which needs green runs of `main.yml` and `account.yml` on the revert (AGENTS.md, Git). No storage or contract changed. The old engine compiles runs from its own catalog, so `browse_page` and `screenshot_page` are not offered, and a stored `browse` grant becomes a policy key no operation needs (`cloudflare/src/gateway/policy.ts:125`). Laravel shows the approved entry with Open in browser until Web is approved again, and a grant edit that names `browse` is refused meanwhile (`checkChanges`, `cloudflare/src/gateway/grants.ts:118-121`). There is no switch that brings back the plain fetch while Browser Run is down (owner question 4).

## Units

Each unit is for one fresh agent, in this order.

1. **The probes (no code).** The agent runs `cf browser-run quick-action markdown` and `screenshot` with `--browser kitesurf` (cf 1.0.0-beta.13 has both) against the test instance's account, after the owner's go. It creates nothing on the account. Requests that must be seen arriving go to a public request-inspection service chosen at the time, on throwaway paths that carry no data, and pages the probes need are served from a host the agent controls for the probe; nothing about either is committed. Every probe has a positive control: the same call without the pattern, or with scripts on, must show the request arriving, or the probe proves nothing. The agent records the results in this design and in the unit's ARCHITECTURE.md text.
   - **P1, reading with scripts off.** `read_page`'s exact options on a page whose script writes text into the page and sends a same-host and an other-host request, and which has an `<iframe>`, an `<img>`, a stylesheet and a font on another host, a form set to submit itself by POST, `<link rel=preconnect>` and `dns-prefetch`. Pass: no script effect, no POST, nothing arrives at the other host, and the text of the HTML comes back. Then each filter set of Reading with scripts off in turn, with a same-host image and a same-host frame as detectors, to choose the first that loads the least beside the page. Recorded: a same-host link that sets a session cookie and redirects to a page that shows whether the cookie came back.
   - **P2, browsing with scripts on.** `browse_page`'s exact options, then with the pattern alone. A script on the page sends to another host: `fetch` by GET and by POST with `mode: "no-cors"`, an `<img>` and a `<script src>`, `navigator.sendBeacon`, an `<iframe>`, a `WebSocket`, a `fetch` from a dedicated worker, a shared worker, workers built from `blob:` and `data:`, and a service worker registered from the page's host; `<a ping>`, an EventSource, a speculation-rules prefetch, WebRTC with an ICE server whose log can be read, and connection hints to a subdomain whose DNS log can be read. Then the moves: `location.href`, a meta refresh, a form that submits itself by GET and by POST, `window.open`, links and forms with `target=_blank`, and a `url` that answers 302 to another host. The page reports in its own text whether each mechanism ran at all. Pass: none arrives at the other host, every one that ran arrives without the pattern, and a same-host `fetch` reaches. A mechanism that never runs on Kitesurf, even without the pattern, is recorded as unsupported, not as blocked, and docs/connectors.md does not claim it. A connection hint that arrives only as a DNS lookup or a connection is recorded for owner question 7. A kind that arrives is tried again with its type added to `rejectResourceTypes`; if that blocks it, the type joins the options, and otherwise Kitesurf fails. For the 302, `meta.finalUrl` and `meta.redirectChain` are recorded with the pattern (to choose how `redirect_to` is found) and without it. The same moves run once through `screenshot`.
   - **P3, private addresses.** No pattern, through `url`, with scripts off and on, over http so that no certificate failure hides Browser Run's own answer, and over https: the private, loopback, CGNAT, link-local and metadata names and IP literals of the removed account test (`git show c23b43e^:cloudflare/test/account/web-egress.test.ts`, its `PRIVATE` and `OTHER` lists), a name from a public rebinding service whose answers alternate between a public and a private address, run ten times, and a public redirector's 302 to `http://169.254.169.254/` and to a name for 10.0.0.1. Pass: every case ends in a refusal the agent can name (Cloudflare's error 1002, 1003 or 1102 in the page or `meta`, or a Browser Run error that says the address is blocked); a timeout or an unexplained failure is inconclusive, and Kitesurf is not used with one. Then a public service's hosts with an expired, a self-signed and a wrong-name certificate. Pass: each fails.
   - **P4, options, lifetime and state.** Kitesurf honours `setJavaScriptEnabled`, `networkidle2`, `bestAttempt`, `actionTimeout`, `rejectResourceTypes`, `userAgent`, `viewport` and `screenshotOptions`; `cacheTTL: 0` gives two calls, under 5 s apart, on a page that writes `Date.now()` two different texts; the deployed probe's canary works; whether `X-Browser-Ms-Used`, `meta.finalUrl` and `meta.headers` come back; whether `result` starts with front matter; the response's size against `result`'s on a large page; screenshot sizes at 1280 by 800, quality 80, on five busy pages; and Kitesurf's per-account limits as Cloudflare states them, without bursting requests to find them. **How long a call runs:** a page whose script keeps more than two requests open at all times, so `networkidle2` never comes, and sends a beacon every 500 ms, timed to the last beacon, once with the caller waiting and once with the caller stopping early; the answer must show that the wait ran out, or the page went quiet and the case is run again. The same with a page that only loads slowly, and with a screenshot. **State between renders:** a page that sets a cookie, a `localStorage` key and an IndexedDB entry, registers a service worker and caches a resource, and reports in its text that each was set, then several more calls that report what they find, and whether the service worker's beacons go on after its call. Pass for state: the first call shows each was set, nothing set in it is seen in another, and no beacon goes on.
   - **P5, what reading loses or gains.** 40 typical work addresses chosen at the time, or the targets of staging's `web_read_page` calls with the owner's go (not committed). For each, today's fetch and `htmlToText` from the laptop, then `read_page`'s and `browse_page`'s options: outcome, status, content type, text length, and whether three sentences picked from the page as a browser shows it are in the text. The laptop's fetch is not the deployed Worker's, so it approximates today's results. Then fixtures on the probe's host with known content: a page with known sentences, a table and relative links, a page in a charset other than UTF-8, a JSON, a CSV, a plain text, a Markdown and an XML file with exact payloads, a PDF, an image, a 404 and a page over 3 MB. Pass: `read_page` succeeds wherever today's fetch does on at least 36 of the 40 and keeps all three sentences on at least 36 (guess at the marks), the fixtures' sentences and links come back, and each text file's payload comes back exactly, apart from a wrapper the engine can remove. Recorded: how many thin pages `browse_page` fixes, and what the PDF and the image give. Below a mark, the design goes back to the owner (owner question 7).
2. **Reading through the browser (harness).** One commit: `read_page` through the port with scripts off, the binding, the port and its cap, the error table, the log line, the probe, the deletions, the tests and the docs for reading. It runs `pnpm exec vite` (mode `development`, which needs `CLOUDFLARE_API_TOKEN`) and calls its `/api/probe` with the token derived from `.dev.vars`' `MINERVA_SECRET_KEY`, never printed, so the binding's answer is seen before any deploy. Done when `pnpm check --instance minerva-cf-test` passes and it is committed.
3. **Open in browser (harness).** One commit: the `browse` action, `browse_page`, `screenshot_page`, the image's path through `ScopedRecord`, `visibleResult`, `ToolCallOutcome` and `render`, the new note, the tests and the docs for browsing. Done as Unit 2. opencode reviews both diffs, since they change what a site grant lets reach.

## Tests

All run in Node or local workerd, with no account (`vitest.platform.config.ts:30`).

- **A fake browser,** `cloudflare/test/fixtures/connectors/web/fake-browser.ts`. It records each call's action and options, and answers what a test scripts: Markdown with a `meta`, an image, an error status, a throw, a hang, a `finalUrl`, a `redirectChain` or none, an oversized body.
- **`connectors-web.test.ts`, reading:**
  - a granted https page gives today's record with the fake's Markdown, `meta.title` and the content type; a slice at `offset` and `max_chars` as today;
  - the options sent: `markdown`, `kitesurf`, scripts off, the filter set Unit 1 chose, the exact pattern, `cacheTTL: 0`, the user agent and the timeouts;
  - an http address opens as https; an IP literal, `localhost` and a site the policy denies send no call;
  - each row of What the model sees, with the exact code and message;
  - `finalUrl` on another host, or on http, gives `redirect_to`; a hop in `redirectChain` gives it when the call stopped there; missing, `about:blank` and `chrome-error://chromewebdata/` fail; on the same host it is the `url` and the links' base;
  - a response over 8 MB, Markdown over 3 MB, malformed JSON and `success: false`;
  - a hang is cut at the wait, on lowered limits, and the wait covers a body that stalls;
  - the pattern for a host with a hyphen and a punycode label, an address whose query holds another host, and the same host on another port;
  - the cap: after 100 calls in one run, of any operation, the next is `LIMIT_REACHED` with no call, and a run with its own executor starts at 0;
  - the log line: each outcome from the fixed set, and no part of the address when the fake's error `message`, `detail` and `path`, or a thrown message, hold it;
  - no binding gives `BROWSER_UNAVAILABLE`;
  - `NotSent` and `ProgrammingError` from a revoked or closed io pass through.
- **`connectors-web.test.ts`, browsing:** `browse_page` and `screenshot_page` need `browse` and send scripts on; `read` alone refuses them; a screenshot gives the record and one image of the fake's bytes; an image over 1,152 KiB is `PAGE_TOO_LARGE`; the failure messages add the scripts sentence.
- **The image's path:** a screenshot's image is the part after the JSON in `render`'s output; a record that `visibleResult` drops drops its image; a script's call gets the record and no image; a 1.5 MB image reaches the model's context whole.
- **The fingerprints:** the pin at `connectors-web.test.ts:105` gains `browse_page` and `screenshot_page` and changes `read_page`'s.
- **`executor-revocation.test.ts`:** no browser call once the run is revoked, and a cancel during a call drops its result.
- **One platform test,** `test/platform/web-render.test.ts`, with its own ports: the browser port gets the fake, and a run's `read_page` reads through it; a `cancelRun` during the call ends the run.
- **The probe:** `test:deployed` checks `/api/probe`'s `browser` on staging and production (the fixed page's status 200, text and `finalUrl`; the canary's marker absent with scripts off, present with scripts on, and its fetch blocked) and `null` on the test instances. A unit test checks that the probe reads nothing from the request for it.
- **The direct tools:** with more gateway tools than fit, `screenshot_page` is among the direct ones.
- **The fragment:** `browse_page` and `screenshot_page` send `#/invoices/1` with the address, and `read_page` does not.
- **`pnpm startup`** stays within its limit; one dependency, `pako`, is removed and none added.

## Docs to update

- **docs/connectors.md, The Web:** Fetching becomes "Opening pages": every page opens in Cloudflare's browser, https only, the browser reaches only the page's host for the kinds of request Unit 1 measured, Read pages runs no scripts, but a sign-in link handled by the server still signs the browser in for that read, and a frame or image on the same host may load. Open in browser runs the page's scripts, which can act on the site as a visit would, sign in through a link and do so more than once per read. Agents can gains screenshots. Limits: bot-protected pages stay unreadable, a continuation opens the page again and may differ, a run opens at most 100 pages, a screenshot shows only the first screen and reaches only models that take images, and the refusal of private addresses is what P3 measured.
- **docs/data-processing.md:** the "Web fetch and search" row says pages are opened by Cloudflare Browser Run, receiving the address with whatever the agent put in it, the page and its host's resources, and with Open in browser the session a sign-in link sets; location "close to the incoming request", with no guarantee and possibly outside the EU; page content discarded after the response, addresses and request metadata not documented. The Subprocessors' Cloudflare row lists Browser Run.
- **ARCHITECTURE.md:**
  - Spike results, Private addresses: the platform's refusal of the Worker's fetch is replaced by what P3 measured of Browser Run, its certificate checks and the kinds of request the pattern covers. The claim of "adversarial tests ... against the deployed Worker", whose test was removed in `c23b43e`, goes.
  - Connectors: the two actions, why `browse_page` stays a read with safe replay while it can act on a site, and any connection hint P2 let through.
  - Strict revocation: a call already sent, or one the engine stopped waiting for, is browser activity handed off to Cloudflare, bounded by Cloudflare rather than by the engine, with what P4 observed.
  - Budgets: Browser Run's time is not charged, and the cap of 100 calls per run.
  - The harness: images reach the model through `read` and through `screenshot_page`'s result.
  - Configuration and Status: the `BROWSER` binding, and that every instance reads through it.
  - Open questions: Browser Run among what has no EU guarantee.
- **cloudflare/README.md:** Local development's table gains a Browser row (offline none; `pnpm exec vite` reaches the account's Browser Run); the test Worker has no browser; a monthly operator check of Kitesurf's status (still in beta, still free, its limits) and the month's browser hours on the dashboard.
- **Code comments:** the header of `connector.ts` points to the new `render.ts`, whose header gives the rules above and cites ARCHITECTURE.md, never this file.

## Live checks

| Check | Where | Who |
|---|---|---|
| P1 to P5 | The test instance's account, through `cf` | The agent |
| `/api/probe`'s `browser` through the binding, before any deploy | `pnpm exec vite` | The agent |
| `pnpm test:deployed --instance minerva-cf-staging` | Staging, after its deploy | The agent |
| A turn through `minerva:turn` reads a granted static page, and the log line shows one call | Staging | The agent, with the owner's go |
| With `browse` granted on a single-page app from P5 in staging's workspace, `browse_page` returns its text and `screenshot_page` an image the model describes | Staging | The agent, with the owner's go |
| A site granted only `read` refuses `browse_page`, and a host the run may not read is refused before any call | Staging | The agent |
| The new note and the Open in browser checkbox on the Web connection's page, after the approval | Laravel's staging | The agent, with the owner's go |
| Within 7 days of the deploy: calls per operation, failures by outcome and the summed browser time (`cf o11y` with the instance's account) | Staging, and production once deployed | The agent, with the owner's go |

## Risks

- **Every read depends on a beta.** Kitesurf has unpublished limits and no price for after its beta. An outage stops all web reading, where the plain fetch did not depend on it. A price or new limits may need charging or a lower cap. The monthly check watches for it, and the deployed probe shows a change at the next `test:deployed`.
- **A Browser Run outage** fails each read after up to 15 s and holds one of the run's 4 slots meanwhile. The model gets `BROWSER_BUSY`, `SITE_TIMEOUT` or `PAGE_ERROR`.
- **Reads get slower.** Kitesurf's HTML extraction has a median of 820 ms (/browser-run/kitesurf), where a plain fetch is usually less (guess); Verify, perf measures it.
- **Some sites may refuse Browser Run** more often than today's fetch, since it is always identified as a bot. P5 measures it on the sample.
- **A cross-host redirect may lose its target.** Moving from `example.com` to `www.example.com` is common. If P2 shows that `redirectChain` does not report a hop the pattern stopped, the model gets the note without `redirect_to` and must guess the address.
- **Open in browser can act on a site,** sign in through a link and repeat an action. Owner question 7 and the note cover it.
- **One customer can use up the shared limits.** Kitesurf's limits are per account, and every customer reads through it. The cap bounds one run, not several: a member who starts many runs on purpose, or many runs that read at once, can make reads fail with `BROWSER_BUSY` for every customer while it lasts, and there is no plain fetch to fall back on. Admission across the account, with a share per organization, was not designed, since pilots join only by invitation (owner question 3).
- **Screenshots of sites that use a CDN look broken,** since the pattern blocks their images, stylesheets and fonts. P4's five busy pages show how often.

## Accepted, not fixed

- **Browser Run ignoring `cacheTTL: 0`** would be a platform misbehaving in a way it is not known to. A page could then be up to 5 s old, from the account's cache.
- **A request or a move of a kind neither P1 nor P2 tests** getting past the pattern needs a channel no reviewer or probe named. Another host would then receive what the granted page holds.
- **The account's 30 Quick Actions a second** are shared by every customer. Reaching it needs about 8 runs reading at the same moment, which is unlikely at pilot scale; those reads get `BROWSER_BUSY` for that second.

## Owner questions

1. **Processing outside the EU.** Every page the agent opens now goes to Browser Run, with no location guarantee, for every customer. Default: acceptable, and docs/data-processing.md says so. **Answered 2026-10-26:** as the default.
2. **http addresses.** Opened as https on the same host, so an http-only site cannot be read. Default: as proposed. The alternative, opening http, has no TLS to keep a private address from answering for the name. **Answered 2026-10-26:** as the default.
3. **The cap, and the shared limits.** 100 browser calls per run between restarts, across the three operations. It does not stop several runs from using up Kitesurf's per-account limits for every customer. Default: 100, revisited with Kitesurf's stated limits from P4, and no admission across the account while pilots join by invitation. **Answered 2026-10-26:** as the default.
4. **No switch.** With the fetcher deleted, there is nothing to fall back to while Browser Run is down, and a rollback is a revert with its CI runs. Default: accepted. **Answered 2026-10-26:** as the default.
5. **Revocation and a call in flight.** A call already sent goes on at Cloudflare after a cancel, or after the engine stopped waiting, for as long as Cloudflare lets it; no document bounds it, and P4 records what it observed. Default: acceptable, and ARCHITECTURE.md's Strict revocation says so. **Answered 2026-10-26:** as the default.
6. **Screenshots.** The first screen at 1280 by 800 as a JPEG, not the full page, and the model's only way to see a page. Default: as proposed. **Answered 2026-10-26:** as the default.
7. **What Open in browser grants, and Unit 1's marks.** A page's scripts can act on the site, sign the browser in and repeat an action, outside the write ledger, its deduplication and its pauses, in parallel, with replays, and with no approval per call. Kitesurf is used only if it passes P1 to P4, and reading moves only if P5 passes. Default: accepted for the `browse` grant; a connection hint that sends no request is accepted and recorded; any other failure comes back to the owner. **Answered 2026-10-26:** as the default. `browse_page` and `screenshot_page` stay reads.
8. **Kitesurf in production during its beta.** Default: staging first, production only after staging's live checks, when the owner says so. **Answered 2026-10-26:** as the default.
9. **What Read pages still does in a browser.** With scripts off, the browser still keeps cookies within one call, so a sign-in link handled by the server signs it in and `read_page` returns the account's page, where today's fetch ended on an anonymous one. A frame or an image on the same host may also load beside the page. Both are GET requests to the granted host. Default: accepted. docs/connectors.md and the planned public page about connectors' permissions say that a sign-in link signs Minerva's browser in; the site note stays short. **Answered 2026-10-26:** as the default.
10. **Open in browser for unrestricted layers.** A layer that is unrestricted allows every action, so where every layer of a run is, `browse` is allowed from the deploy on, as any new action of an existing connector would be. Default: accepted. **Answered 2026-10-26:** as the default.

## Alternatives rejected

- **Keeping the fetcher and rendering only empty pages** (the earlier design). It kept two paths, a guess at when a page is empty, a Chromium fallback and a seven-row table of notes. The owner chose one path.
- **Chromium as a fallback.** It doubles the engines, the timers and the probes, costs browser time, and runs a page's scripts a second time after Kitesurf.
- **Markdown for Agents.** It runs no scripts and works only on sites that turned it on (Why).
- **`content` with Minerva's converter.** It keeps the Web connector's own conversion, which this design removes. Cloudflare's Markdown keeps image links, which Laravel's chat never loads, and was longer on the one page measured: 18,091 characters against 13,549 (measured).
- **`snapshot`,** Markdown and a screenshot in one call. It rejects Kitesurf.
- **`json`, `links`, `pdf` and raw `content` as tools.** `json` runs a second model, Workers AI's Llama 3.3 70B by default, billed outside the allowance (/browser-run/quick-actions/json-endpoint, Oct 12 2026). The Markdown keeps links, and raw HTML fills the model's context.
- **A full-page screenshot.** Its size has no bound, while the model gets at most `IMAGE_MAX_BYTES`.
- **Saving screenshots into the folder** for `read` to open. The connector would need the folder, and the user's folder would fill with screenshots.
- **A second connector for the browser.** It would give the admin a second list of the same sites.
- **Rendering http pages.** Without TLS, a name that resolves privately for the browser would reach the private address.
- **A browser session with request interception,** to allow scripts but only GET. It is not a Quick Action, adds a dependency and startup CPU, and hostname guardrails do not work with Kitesurf (/browser-run/features/guardrails, Sep 26 2026).
- **Marking `browse_page` as a write.** It would run reads one at a time, put them through the write ledger and stop replays, for the few pages whose scripts act.
- **A setting that turns reading through the browser off.** With the fetcher deleted, off would mean no reading at all, which the emergency stop and a rollback already give.

## Amendments after the review

Each line is one change made from an opencode finding of 2026-10-26 that held, checked against the code at `5d85043`.

- A layer that is unrestricted allows `browse` from the deploy on, before Laravel's approval (policy.ts:140-142). What this design changes says so, and owner question 10 asks.
- No filter tells the top-level page from a same-host frame, so requirement 3 is "nothing but GET to the granted host, and as little as possible beside the page". P1's detectors gain a same-host frame, and owner question 9 asks.
- TLS does not stop a name whose owner holds a valid certificate and points it at a private address. Browser Run's own refusal is the guard, and P3 runs over http so a certificate failure cannot hide it.
- A browser keeps cookies within one call even with scripts off, so a server-side sign-in link signs `read_page` in. Reading with scripts off, the site note, P1 and owner question 9 say so.
- `browse` skips every guard of a write, not only the ledger. Three operations on one site list and owner question 7 name each.
- The timers sent do not bound a whole call, so a call can outlive the engine's wait in ordinary use. Size and time and Strict revocation say so, the claim of a bound is gone, and the line under Accepted, not fixed is removed. `read_page` gains `actionTimeout`.
- P4's page that never goes quiet keeps more than two requests open, since `networkidle2` allows two, and the case checks that the wait ran out. P2 records mechanisms that never run on Kitesurf as unsupported. P4's state case checks that the first call set each item, and its cache case spaces calls under 5 s.
- The deployed probe also runs a canary for scripts off, scripts on and the pattern, on staging and production after every deploy and monthly, and asserts `null` on the test instances, which have no binding.
- `parseUrl` drops the fragment, so `browse_page` and `screenshot_page` put it back for apps that route by `#/path`.
- Past `MODEL_TOOLS_MAX`, a tool reached only through scripts loses its image, so `modelTools` puts `screenshot_page` among the direct tools.
- The cap is per run between restarts, and the wording says so. Risks and owner question 3 name the shared limits that several runs can use up, and Deploy order adds a usage notification for Browser Run.
- P5 checks that known sentences, links and exact payloads come back, not only lengths, and notes that the laptop's fetch only approximates the Worker's.
- A 422 with code 2012 is a failed conversion and other 422s are failures, not timeouts; only the engine's wait gives `SITE_TIMEOUT`. Every failure after a call was sent says the scripts may have run.

Dropped: that the image tests run where the 2 MB row limit is not enforced. The record's JSON is under 1 KB and the image at most `IMAGE_MAX_BYTES`, the bound `read`'s images already use in the same row, so the arithmetic holds without an account test. opencode confirmed that pi's `boundContent` keeps image parts, which replaced a guess here.

## Verification

This design was checked against the harness at `5d85043` by opening each file and line it cites. Since `61a9b15`, where the earlier design was checked, the Web connector, the fetcher, `http.ts`, the executor and `config.ts` are unchanged; `conversation.ts`, `ports.ts` and `faults/ports.ts` changed with fast starts, and their lines here are current. The app was checked at `a6bed42` for `thread.tsx`, `access.ts` and `docs/architecture/connectors.md`. The Accept header and the converter comparison were run from the laptop on 2026-10-26 against `blog.cloudflare.com` and `developers.cloudflare.com`. Nothing was run against an account and nothing was deployed.

# Build checklist

## Unit 2: reading through the browser

**Depends on.** Unit 1 passed by Kitesurf, and P5 at its marks or the owner's go below them.

**Files.**

- [ ] Create `cloudflare/src/connectors/web/render.ts`: the options, the pattern, the capped reads, the `finalUrl` and `redirectChain` checks, the error table and the log line.
- [ ] Edit `cloudflare/src/connectors/web/connector.ts`: `read_page` through the port, revision 2, the description, the header.
- [ ] Delete `fetch.ts`, `inflate.ts`, `pako.d.ts` and `pako`; delete `platformRefusal` from `gateway/http.ts`.
- [ ] Edit `cloudflare/src/gateway/http.ts`: `BrowserIo`, `ProviderIo.browser`, `CallIo`'s gated `browser`, `settingsIo` without one.
- [ ] Edit `cloudflare/src/gateway/executor.ts`: `ExecutorContext.browser`, passed to `CallIo`.
- [ ] Edit `cloudflare/src/conversation/ports.ts` and `conversation.ts`: the `browser` port, its cap and its wiring.
- [ ] Edit `cloudflare/src/faults/ports.ts`: `browser: () => null`.
- [ ] Edit `cloudflare/cloudflare.config.ts`: the binding.
- [ ] Edit `cloudflare/src/http/probe.ts` and `cloudflare/test/account/deployed.test.ts`: the probe's fixed page.
- [ ] Create `cloudflare/test/fixtures/connectors/web/fake-browser.ts` and `cloudflare/test/platform/web-render.test.ts`; delete `fake.ts`.
- [ ] Edit `connectors-web.test.ts`, `http-client.test.ts` and `executor-revocation.test.ts`.
- [ ] Edit ARCHITECTURE.md, docs/connectors.md, docs/data-processing.md and cloudflare/README.md for reading.

**Build.**

- [ ] Every read is one Kitesurf `markdown` call with scripts off and the filter set Unit 1 chose; nothing is sent before authorization.
- [ ] Every browser request matches the page's https origin; a move to another host gives `redirect_to` or the note; only a `meta.status` of 200 supplies text.
- [ ] At most 100 browser calls per run.
- [ ] The call is gated by `admits()`, the io's own errors pass through, anything `quickAction` throws is `PAGE_ERROR`, and a cancel drops its result.
- [ ] One log line per call, without the address or any error text.
- [ ] No contract change.

**You see.**

- [ ] On staging, a turn that reads a granted page answers from its text, as today.

**Verify, unit.** Tests alone are not sufficient verification. A unit is verified only when its unit, live and perf boxes are all checked.

- [ ] The reading cases in Tests pass in `pnpm test:unit` and `pnpm test:platform`.
- [ ] `pnpm check --instance minerva-cf-test` passes.

**Verify, live.**

- [ ] P1 to P5 recorded.
- [ ] `/api/probe`'s call through the binding in mode `development`, before the commit.
- [ ] Staging's reading checks in Live checks pass, and `account.yml` is green on the commit.

**Verify, perf.**

- [ ] Metric. `read_page`'s duration on P5's sample on staging, from the log lines. Rule. Median under 3 s, p95 under 10 s. Over fails.
- [ ] Metric. `pnpm startup`. Rule. Within its limit, as on `main`.

**Review.**

- [ ] opencode reviewed the diff.

## Unit 3: Open in browser

**Depends on.** Unit 2 committed.

**Files.**

- [ ] Edit `cloudflare/src/connectors/web/connector.ts` and `render.ts`: the `browse` action, `browse_page`, `screenshot_page`, the fragment and the note.
- [ ] Edit `cloudflare/src/gateway/connector.ts`, `executor.ts`, `results.ts` and `cloudflare/src/conversation/tools.ts`: the image on `ScopedRecord`, `visibleResult`, `ToolCallOutcome` and `render`.
- [ ] Edit `cloudflare/src/gateway/tools.ts`: `modelTools` puts operations that return images among the direct tools.
- [ ] Edit `connectors-web.test.ts` and the tests of the image's path.
- [ ] Edit ARCHITECTURE.md and docs/connectors.md for browsing.
- [ ] Delete this design and move what stays true (Docs to update).

**Build.**

- [ ] `browse_page` and `screenshot_page` need `browse`, which requires `read`, and run scripts on with the pattern.
- [ ] A screenshot is one JPEG of 1280 by 800, at most 1,152 KiB, after the JSON in the model's result, and nowhere else.
- [ ] The catalog shows the new action, operations and note; the fingerprints pin all three operations.

**You see.**

- [ ] On staging, with `browse` granted on a single-page app, a turn reads it and describes its screenshot, where `read_page` returns little text.

**Verify, unit.**

- [ ] The browsing and image cases in Tests pass.
- [ ] `pnpm check --instance minerva-cf-test` passes.

**Verify, live.**

- [ ] Staging's browsing checks and the Laravel checks in Live checks pass, and `account.yml` is green on the commit.

**Verify, perf.**

- [ ] Metric. `browse_page`'s and `screenshot_page`'s durations on P5's single-page apps on staging, from the log lines. Rule. Median under 6 s. Over fails.

**Review.**

- [ ] opencode reviewed the diff.
