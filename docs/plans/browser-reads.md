# Browser reads design: every page opens in Kitesurf

Status: proposed 2026-10-26, with the owner's requirements of that day. Not built, and nothing deployed. Line numbers are at `dfc7d0f` (harness, whose engine is unchanged since `5d85043`) and at `a6bed42` of `minervacomputing/app` ("the app's" below). Browser Run's behaviour comes from Cloudflare's docs, read 2026-10-25 and 2026-10-26 (each cited with the date its page was last updated), from the runtime types the build generates (`cloudflare/.cloudflare/types/index.d.ts`, "the types" below) and from probes. A claim about code with no label was read at the lines cited. One marked (documented) is in Cloudflare's docs or the types, one marked (measured) was run, one marked (inferred) follows from code or docs that were read, and one marked (guess) rests on behaviour nothing states. Once built, what stays true moves into ARCHITECTURE.md, docs/connectors.md, docs/data-processing.md and cloudflare/README.md, and this file is deleted.

An earlier version of this design read pages with scripts off and added a second permission to run them. Kitesurf cannot turn scripts off (Evidence so far), and the owner chose on 2026-10-26 to let every page's scripts run under one permission.

## Why

- **Some pages arrive empty.** `read_page` fetches a page once and reduces its HTML to text (`cloudflare/src/connectors/web/connector.ts:149-155`). A site that builds its content with scripts sends a shell, and the reducer drops scripts and `<noscript>` (`cloudflare/src/lib/markdown.ts:11-15`), so the model gets a title and almost no text (inferred).
- **The model cannot see a page.** Nothing returns a picture of a page, so a layout, a chart or a page whose text is in images is lost.
- **The fetcher is code Minerva keeps.** Redirects, decompression, charsets, size and time limits and the platform's refusal are 559 lines in `fetch.ts`, `inflate.ts` and `pako.d.ts`, with the `pako` dependency and their tests. Browser Run loads the page and returns Markdown.
- **Cloudflare opens a page in one call.** Browser Run's Quick Actions load a page in a browser and return the result, with no session kept between calls (developers.cloudflare.com/browser-run/quick-actions, Oct 10 2026, documented). Its engine Kitesurf is "an ephemeral, fully-isolated, stateless engine designed to exist only for the duration of a task", free during its beta (/browser-run/kitesurf, Oct 6 2026, documented).

## The owner's requirements

The owner's requirements, 2026-10-26:

1. Every page the agent opens goes through Kitesurf. Minerva's fetcher is deleted, with no plain fetch and no fallback for thin pages. Chromium is not used.
2. Only Browser Run's `markdown` and `screenshot` Quick Actions. No browser sessions, no clicking or typing, no automation framework.
3. The page's scripts run. No mode without scripts, no interception that allows only GET, no classifier of safe requests. A page may send any method within the permitted network boundary.
4. Opening pages in the browser is an explicit permission, allowed for chosen sites or for all sites in Minerva's existing permission system. Without it the page is refused, never read another way.
5. The permission is to visit and render a page, not a promise that the visit changes nothing. Docs say what scripts, sign-in links, redirects, retries and repeated renders can do on the site. Nothing calls it read-only.
6. Authorization before any browser call, deny precedence, https only, isolation between calls and the same-host boundary all stay. A page referring to another host does not open that host.
7. Screenshots reach the model as images, within the existing limits on image size and storage.
8. Curated site lists ("General reference", "Developer resources") are later work, and when built they only fill in grants.
9. An organization's admin can allow browser access on chosen sites only, such as Wikipedia, and members cannot go beyond it.

## What this design changes

- **`read_page` opens the page in Kitesurf with its scripts running** and returns Browser Run's Markdown. Its input and record keep today's fields.
- **`screenshot_page`**, a new operation, opens the page the same way and returns a short record and one JPEG the model sees.
- **The Web site kind's one action becomes `browse`**, labelled "Open in browser", replacing `read` ("Read pages"). Both operations need it.
- **Web gets a tenant per site, its registrable domain**, so an organization's connection policy can offer Web on a list of domains (Allowed apps, the app's `docs/architecture/connection-policies.md`), which members' grants cannot pass.
- **Web search is removed.** No deployed build has its key, and its need on the account has no tenant (The organization's site list).
- **The browser loads only the page's host**, over https. What a page loads from another host is blocked, but a redirect or the page itself can move the browser to another host, so information can reach the allowed sites and wherever they redirect (owner question 14). A page that ends on another host gives today's `redirect_to` record, its content withheld.
- **http addresses open as https** on the same host.
- **At most 100 browser calls per run.**
- **Screenshots travel as images in the tool result**, a new path from a connector to the model.
- **No setting.** Every build with the `BROWSER` binding reads through it. The dev server offline and the test build have none, and their `read_page` reached no page before either.
- **No contract change.** The catalog's version changes, so the operator approves Web once on staging and once on production. Laravel gains how a typed domain is written for Web's list (Unit 4).

**What this does not promise.** Pages behind bot protection or a login stay unreadable, since Browser Run "does not bypass CAPTCHAs, Turnstile challenges, or any other bot protection mechanisms" (crawl endpoint docs, in llms-full.txt, documented). Kitesurf cannot "negotiate a bot-challenge handshake with real TLS fingerprints" or play video or WebGL, and trades away "pixel-perfect rendering" (/browser-run/kitesurf, documented). A page whose scripts, styles or data come from another host stays thin or looks broken (Only the page's host, only https).

## What a visit can do

This is what the permission grants, and what docs/connectors.md, the public Web page and the site note say in their own words:

- **The page's scripts run.** They can send any request, POST included, to the page's own host, with the cookies the site set during that visit. A page that confirms, approves, unsubscribes or submits a form when it loads does so.
- **A sign-in link signs the browser in** for that visit, whether the server or a script handles it, and the model reads that account's pages (measured, Evidence so far).
- **Redirects are followed, to any host.** A redirect, a script or a form can move the browser to another host, which then receives the address or the form's fields (measured). When `finalUrl` names another host, the engine withholds that page and returns `redirect_to`. A move made by the page's own script or form does not show in `finalUrl`, so that page comes back as the allowed host's (measured).
- **A visit can happen more than once.** Each continuation with `offset` and each screenshot opens the page again, the engine replays a read up to twice after a restart (`REPLAYS_ALLOWED`, `cloudflare/src/conversation/tools.ts:38`), and the model may call again. Whether Browser Run retries a navigation itself is not documented.
- **The site sees Cloudflare, not the user.** Requests come from Cloudflare's addresses, carry Web Bot Auth signatures and are "always ... identified as a bot" (/browser-run/quick-actions/markdown-endpoint, Sep 26 2026, documented), with Minerva's user agent on the page and a desktop Chrome user agent on some frame requests (measured).
- **The address carries whatever the agent puts in it** to the site, as today.

## What the code does today

| Claim | What the code does |
|---|---|
| `read_page` fetches only after authorization | `prepare` parses the address and asks for `read` on the site (`connector.ts:143-147`); `execute` calls `fetcher.get` (`:149`). |
| A move to another host goes back to the model | The fetcher follows a redirect only on the same host and never from https to http, and returns `Moved` otherwise (`fetch.ts:385-399`); the record carries `redirect_to` and `MOVED_NOTE` (`connector.ts:134`, `:150-152`). |
| The record | `url`, `title`, `content_type`, `text`, `offset`, `total_chars`, `next_offset`, on the resource of the host the fetch ended at (`connector.ts:153-174`). |
| Its errors | `SITE_UNREACHABLE`, `PAGE_TOO_LARGE`, `SITE_NOT_PUBLIC`, `UNSUPPORTED_CONTENT`, `PAGE_ERROR` and `SITE_TIMEOUT` (`fetch.ts:93-101`, `:145`, `:360-408`). |
| What it reads | HTML, and JSON, XML, plain text, Markdown and CSV as they are (`fetch.ts:62-63`, `:137-145`), up to 3 MB in 25 s (`:48-51`). |
| Private addresses | `lib/sites.ts` refuses IP literals and special-use names before anything is sent (`cloudflare/src/lib/sites.ts:8-11`). The platform refuses a Worker's request to a private address, and `platformRefusal` recognises it (`cloudflare/src/gateway/http.ts:405-412`), measured rather than documented (ARCHITECTURE.md, Spike results). |
| Who uses the fetcher | Only the Web connector. `platformRefusal` has no other caller; its test is in `test/unit/http-client.test.ts:341-343`. `pako` is imported only by `inflate.ts`. |
| Who uses the converter | `htmlToText` (`lib/markdown.ts`) also reduces Gmail's HTML parts and Google Calendar's descriptions, so it stays. `lib/charset.ts` stays for Gmail. |
| The Web connector | Kinds `account` (action `search`) and `site` (action `read`, wildcard, hierarchical); tenancy `unknown`; `search` offered only with a Brave key (`connector.ts:194-225`). |
| Policy | ceiling ∩ user ∩ agent, a deny in any layer wins, and an unrestricted layer passes every action its denies do not block (`cloudflare/src/gateway/policy.ts:24-29`, `:140-142`, `:181-184`). A user layer that is missing allows nothing; only the operator makes one unrestricted (the app's `docs/architecture/grants.md`, 11a). |
| A grant naming an unknown action | Compiles into the policy as a key no operation needs (`grants.ts` `enforceable` checks only the kind). A grant edit naming one is refused (`checkChanges`, `cloudflare/src/gateway/grants.ts:118-121`). |
| Connection policies | Per connector, offered or not, and for a tenancy of `account` or `resource` a list of tenants or any (`cloudflare/src/gateway/tenancy.ts:20-39`). Under a list, every resource a call touches must name a listed tenant (`inTenants`, `:42-44`; `executor.ts:651`, `:671`), records of other tenants are dropped (`executor.ts:292`), and a grant edit allowing a resource of another tenant is refused with `TENANT_NOT_ALLOWED`, `*` excepted (`cloudflare/src/internal/connections.ts:175-205`). A connector with a tenant per resource whose resource names none is a connector bug (`shapeProblem`, `executor.ts:253`). Laravel's Allowed apps gives a list only to a tenancy of `account` or `resource`, and Web has none today (the app's `connection-policies.md`, 16). |
| A connector's result | JSON records only (`ProviderOutput`, `gateway/connector.ts:45-56`). The executor drops a record on a host the policy denies (`visibleResult`, `executor.ts:267-294`). The model reads the `ToolResult`'s JSON as one text part (`render`, `conversation/tools.ts:59-62`), and `ToolResult`'s schema is closed (`gateway/results.ts:18-33`). |
| Images to the model | Only through `read`, from a file in the folder, at most 2000 pixels a side and `IMAGE_MAX_BYTES` (1.5 MB of base64), since pi keeps a tool's result in one SQLite row and a row holds at most 2 MB (`cloudflare/src/model/provider.ts:146-152`). A model that takes text only gets pi-ai's placeholder (`cloudflare/src/model/policy.ts:44-62`). |
| What Laravel gets of a call | The `tool_call` event: tool, label, arguments and decision, never the result (`contract/src/shapes.ts:77-103`). |
| The io | The connector's only network is the call's io (`connector.ts:221-225`). `CallIo.#send` checks `admits()` synchronously before each request (`http.ts:276-283`). A cancel stops the wait (`executor.ts:584-602`). |
| The fingerprint | Covers `revision` and the connector's tenancy, not the description (`cloudflare/src/gateway/registry.ts:256-271`; ARCHITECTURE.md, Permissions). `read_page`'s is pinned (`cloudflare/test/unit/connectors-web.test.ts:105`). A changed fingerprint refuses the tool with `OPERATION_CHANGED` for the rest of a run in progress (`registry.ts:383-388`). |
| Grants stored now | Production's Laravel has no `connections`, `layers` or `connection_policies` tables. Staging has 2 Web connections, one layer with one Web site grant (an allow of `read` on `*`), no denies, no unrestricted user layer, and one connection policy, which lists Web (measured 2026-10-26, counts only). |

## What Browser Run offers

- **The calls.** `env.BROWSER.quickAction("markdown", options)` answers JSON `{success: true, result, meta}` with Markdown in `result`; `quickAction("screenshot", options)` answers the image's bytes, with no `meta`. An error is JSON `{success: false, errors}` with status 400, 422, 429, 500 or 503. `quickAction` takes no abort signal (the types, `:11831-11847`, `:12020-12036`, `:12136-12152`, documented).
- **`meta`.** `status` and `title` of the rendered page, optional `headers` (the origin's, lowercased), optional `finalUrl` ("URL that served the response, after any redirects the browser followed") and optional `redirectChain`, whose hops carry their headers and which leaves out client-side moves (`:11679-11698`, documented).
- **Options shared by every action** (`:11439-11537`, documented): `allowRequestPattern` or `rejectRequestPattern` (lists of regular expressions on request URLs), `allowResourceTypes` or `rejectResourceTypes`, `gotoOptions` (`timeout` at most 60 s, `waitUntil`), `bestAttempt`, `actionTimeout`, `userAgent`, `viewport` (default 1920 by 1080), `cacheTTL` (default 5 s), `browser: "kitesurf"`. None matches a request's method. Whether Kitesurf honours each option is not documented.
- **Screenshots.** `screenshotOptions` with `type` (`png`, `jpeg`, `webp`), `quality`, `fullPage` and `clip` (`:11555-11573`, documented).
- **Limits and price.** Quick Actions are capped at 30 requests a second per account on Workers Paid (/browser-run/limits, Oct 14 2026, documented). Kitesurf "is in beta and available for free, behind per-account limits", with no numbers and no price for after the beta (/browser-run/kitesurf, documented).
- **Where and what is kept.** "Close to the incoming request", with no jurisdiction option (/browser-run/faq, Jul 17 2026). Content is "immediately discarded" after the response, and output is cached 5 s per account unless `cacheTTL` is 0 (documented). Browser Run is not in the data localization compatibility table (Oct 15 2026).
- **No local simulator.** Without remote mode, `quickAction` fails with "The RPC receiver does not implement the method" (/browser-run/quick-actions, documented).

## Evidence so far

Run on 2026-10-26 against the test instance's account: 35 Kitesurf calls over the REST endpoints that `cf browser-run quick-action` calls (where `browser=kitesurf` and `cacheTTL=0` are query parameters), one at a time and at least 3 s apart, on throwaway pages of two public request-inspection services. Each result below is one run unless it says otherwise, so it is evidence, not proof.

- **Scripts always run on Kitesurf.** `setJavaScriptEnabled: false` answers HTTP 500, code 2000, "not yet implemented by kitesurf". With every option set Kitesurf accepts, a page's inline script ran, rewrote a paragraph, sent a same-host `fetch` and submitted a form by POST to the page's host (measured).
- **The pattern held with scripts running.** With `allowRequestPattern` on the page's host, an iframe, an image, a stylesheet, a font and a no-cors `fetch` aimed at another host never arrived; a control without the pattern received all five (measured).
- **A pattern and a type filter must both match.** With the pattern and `allowResourceTypes: ["document"]` an iframe on another host was blocked; with the type filter alone it arrived (measured).
- **Same-host frames load,** and the frame was fetched twice per call, once with `USER_AGENT` and once with a desktop Chrome user agent. The page, its sub-resources, the `fetch` and the POST carried `USER_AGENT` (measured).
- **Cookies last for a call.** A same-host address that answered 302 with `Set-Cookie` led to an account page whose request carried the cookie, and the Markdown was the account page's (measured).
- **Redirects.** A same-host 302 gave `meta.finalUrl` at the target and a `redirectChain` of one hop with `url`, `status` 302 and its `headers`, `location` among them (measured). A cross-host redirect was not measured.
- **A page's CSP is honoured for scripts.** Under `script-src 'none'` no script ran and the external one was not requested, though frames loaded despite `frame-src 'none'` (measured).
- **Connection hints.** `preconnect` and `dns-prefetch` to names under another host caused no DNS lookup of those names, the control included (measured).
- **What comes back.** Every successful call returned `X-Browser-Ms-Used` (301 to 1,465 ms on these pages, 1,234 ms for the screenshot); the 500 returned none. Each call took 0.6 to 2.2 s from the laptop. Every `markdown` call returned `meta.status`, `meta.title`, `meta.headers` and `meta.finalUrl`, and `result` starts with YAML front matter holding the title, as `---\ntitle: "Example Domain"\n---` (measured).
- **Options accepted** with Kitesurf, each alone on `https://example.com/`: both request patterns, both type filters, `gotoOptions` with `timeout` and each `waitUntil`, `actionTimeout`, `bestAttempt`, `userAgent`, `viewport`, `cookies`, and `screenshot` with JPEG at quality 80 (measured). Accepted is not honoured: only the pattern, both type filters and `userAgent` were seen at work. `networkidle2` used about 900 ms of browser time where `domcontentloaded` used about 360 ms (measured), which suggests it waits (inferred).
- **Screenshot size.** `https://example.com/` at 1280 by 800, JPEG quality 80, was 63,256 bytes (measured, one page).
- **`snapshot` accepts Kitesurf over REST** (measured), though the types say it does not. Requirement 2 leaves it unused.
- **Markdown for Agents does not help.** It converts the HTML a site's server sends, scripts stripped, on sites that turned it on (/fundamentals/reference/markdown-for-agents, Oct 9 2026, documented), and Cloudflare's own blog and docs answered HTML to today's Accept header (measured).
- **Cloudflare's Markdown against Minerva's converter.** On the one page compared, 18,091 characters against 13,549, with image links kept (measured).

**C2 and C3, run on 2026-10-26** against a throwaway fixture of two workers.dev hosts on the test instance's account (deleted the same day), with `read_page`'s and `screenshot_page`'s exact options, one run each:

- **Sub-resources to another host were blocked.** With the pattern, a stylesheet, a `<script src>`, an iframe, XHR, `fetch` by GET and by POST, an EventSource and a WebSocket aimed at the other host never arrived. In the control without the pattern, all eight did. The same mechanisms on the page's own host arrived in both runs, POST included (measured).
- **Navigations to another host were not blocked.** With the pattern, a script setting `location.href`, a form submitted by GET, a form submitted by POST (its field in the body) and a script's click on a `target=_blank` link each reached the other host, and the Markdown returned was the other host's page. `meta.finalUrl` still named the first host in every one of these. The screenshot with the pattern also reached the other host through the `_blank` link (measured).
- **A 302 to another host was followed with the pattern,** and `meta.finalUrl` and `meta.redirectChain` named the other host. A 302 from https to http on the same host was followed too, and `finalUrl` was the http address (measured).
- **A meta refresh did not navigate,** with the pattern or without (measured).
- **No request arrived on either host** for `sendBeacon`, dedicated, shared and service workers, `<a ping>`, a speculation-rules prefetch or `window.open`, in the control too. The page's own report was lost when the `_blank` link replaced its text, so whether these ran is not known (inconclusive).
- **User agents.** The same-host frame was fetched twice again, once with a desktop Chrome user agent. The WebSocket request carried no user agent (measured).

**Results that contradict a decision.** Only the page's host, only https: the pattern does not hold the browser to the host. A page can move the browser to any host, by script, by a form that posts its fields, by a link or by a redirect, and the call returns that host's page under the first host's authorization, with `finalUrl` naming the first host for every move made in the page. A redirect can also leave https. Requirement 6 does not hold on Kitesurf with these options. The owner accepted this on 2026-10-26 (owner question 14): the engine withholds a page `finalUrl` places on another host, and the docs and the site note say information can reach the allowed sites and wherever they redirect.

**C4 is not run.** Minerva sends no probe requests at private or cloud-metadata addresses through Cloudflare's service. Whether Browser Run refuses them is a question for Cloudflare, and until it answers, `lib/sites.ts`' own refusal of IP literals and special-use names is the only guard Minerva can show.

**C4 and C7, run on 2026-10-26** with `read_page`'s exact options, one run each:

- **Invalid certificates are refused.** badssl.com's expired, self-signed and wrong-host certificates each gave `success: true` with `meta.status` 526 and Cloudflare's "Invalid SSL certificate" page; badssl.com itself gave 200 (measured).
- **Text files come back inside a fence.** CSV, plain text, Markdown and XML came back as their exact bytes between a line of three backticks and a closing one. JSON came back as the text of Chrome's JSON viewer followed by the same fence around the exact payload (measured).
- **HTML.** A page in ISO-8859-1 was decoded correctly. A page with known sentences, a table and a relative link kept all three sentences, the table as a Markdown table and the link made absolute (measured).
- **Other files.** A PDF gave an empty `result` and no content type in `meta.headers`. A PNG gave `![]()` with `image/png`. A 404 gave `meta.status` 404 and the page's text. A 204 gave `meta.status` 200 and an empty `result`. A 3.2 MB page gave 3,224,039 characters after 11 s (measured).

**C5, C6 and C8 are not run.** Live probing of Cloudflare's service stopped after C4 and C7. Isolation between calls rests on Cloudflare's statement that Kitesurf is "ephemeral, fully-isolated, stateless" (documented, not measured), `cacheTTL: 0` on its documentation, and how long a render runs after the caller stops is unknown. The binding (C1) is checked in Unit 2 with one call to `https://example.com/`.

## Decisions

### Two operations on one action

| Operation | Needs | Returns |
|---|---|---|
| `read_page` (revision 2) | `browse` on the site | Markdown, today's record or a `redirect_to` record |
| `screenshot_page` (revision 1) | `browse` on the site | A short record and one JPEG |

- **`browse` replaces `read`.** The site kind's `actions` become `["browse"]`, and the connector's actions `[{id: "browse", label: "Open in browser"}]`. A new id rather than a new label on `read`: every `read` grant was given while the public Web page said "Scripts do not run" and "Agents cannot sign in", and reusing the id would turn each into a visit nobody chose (owner question 9).
- **Allowed per site or for all sites** with today's grants: an exact host, `*.domain` (the domain and everything under it), or `*`, which the editor shows as "All sites" (the app's `grants.md`, 11a). A deny on a domain wins over an allow on a wider one, in any layer.
- **Both declare `outputAction: "browse"`.** The default is `read` (`gateway/connector.ts:374-376`), which no Web kind has once `browse` replaces it, and the registry refuses an operation whose output action applies to none of its kinds (measured: `web.read_page: "read" applies to none of its kinds.`).
- **Both stay reads.** Neither declares `mutates`, so they skip what guards a write: the write ledger and its deduplication, the pause after an uncertain write, running one at a time, and settlement (`executor.ts:536-552`, `:601-605`; `conversation/tools.ts:98-109`). They run in parallel with other reads, replay up to twice after a restart, and are not askable under docs/plans/approvals.md. The grant accepts this for the site (owner question 7). Marking them writes was rejected (Alternatives rejected).
- **Inputs.** `read_page` keeps `url`, `max_chars` and `offset`. `screenshot_page` takes `url` only. `parseUrl` drops the fragment (`lib/sites.ts:244`), which an app that routes by `#/path` needs, so both send the parsed address with the input's fragment put back. A fragment never reaches a server, and authorization still uses the host.
- **Descriptions.** `read_page`: "Open a web page in Minerva's browser, which runs its scripts, and read it as text. Only https pages on sites you may open. A page that moves to another site returns redirect_to instead of content. Long pages are cut at max_chars; continue with offset set to the returned next_offset, which opens the page again." `screenshot_page`: "Open a web page in Minerva's browser and look at an image of its first screen. Only https pages on sites you may open."
- **The name `read_page` stays.** It says what the model gets, and keeps the tool's name in transcripts and Laravel's tool labels. The permission's label and note are where a person learns what a visit does.

### The organization's site list

- **Web's tenancy becomes `{kind: "resource", label: "domain"}`.** A site resource's tenant is its registrable domain (`registrable`, `lib/sites.ts:86-92`): `en.wikipedia.org`, `wikipedia.org` and `*.wikipedia.org` are all in `wikipedia.org`. The tenancy's `tenants(client, kind, ids)` is pure: a grant id's host, without `*.`, mapped by `registrable`. Discovery items and every record name their tenant. A host that is a public suffix itself, such as `co.uk`, has no registrable domain, and `parseUrl` and `validId` accept it (measured), so Web refuses it itself: `prepare` fails with `INVALID_URL` "This address has no domain Minerva can match." before anything is sent, discovery leaves it out, and `describe` names no such id, so a grant edit for it is invalid.
- **The policy then limits Web as it limits GitHub's owners.** An admin on Allowed apps offers Web to any domain, to a list, or not at all. Under a list, a call on a site of another domain fails with `POLICY_DENIED`, "Your organization does not allow this domain.", before anything is sent, a member's grant edit allowing a site outside the list is refused (`TENANT_NOT_ALLOWED`, which Laravel words "Your organization does not allow the domain of {site}."), and a member who grants All sites gets the list's domains. No layer, unrestricted included, passes the list, because it is checked apart from the grants (`executor.ts:671`, `:686-687`).
- **Members still choose within it.** The policy is a limit, as for every connector: a member's own layer, restricted until they choose, decides which of the allowed sites their agents open. Allowing on the member's behalf was not built (Alternatives rejected).
- **A domain, not a host.** The list cannot hold `en.wikipedia.org` alone. A member can narrow to it in their own grants. Later presets ("General reference") are lists of domains an admin adds to this list, or sites a member adds to their grants; neither is another way to authorize.
- **Policies stored now keep their meaning.** Web's entry has `tenants: null` today, since its tenancy was unknown, and null stays "any domain". Staging's one policy lists Web that way.
- **Laravel writes a typed domain as the engine does** (the app's `connection-policies.md`, 18): lowercase ASCII after IDNA, without a scheme, path, port or `*.`, reduced to its registrable domain, and refused at its place when it has none ("This is not a domain Minerva can match. Add its registrable domain, such as wikipedia.org."). That needs the Public Suffix List in Laravel; Unit 4 chooses the package, an established one per the app's AGENTS.md, and its tests take cases from `lib/sites.ts`'s.

### Search is removed

`search` needs the account resource, which has no tenant, so under Web's new tenancy every search would be a connector bug (`shapeProblem`). No deployed build has the Brave key, so it is offered nowhere (`connector.ts:214-216`). It is deleted with `search.ts`, the account kind, `offered`, `MINERVA_BRAVE_SEARCH_API_KEY` in `pnpm secrets` and AGENTS.md, and its tests. Search can come back as its own connector, which also lets an admin offer it apart from sites, since its queries go to Brave rather than to the sites (owner question 12).

### Existing grants

- **A `read` grant is not converted** (owner question 9). Once the engine deploys, a `read` key compiles into the policy and no operation needs it, so a restricted layer opens no page until someone grants Open in browser. An unrestricted layer allows `browse` from the deploy on, as it allows every action (owner question 10).
- **No migration code.** Production has no grant tables, and staging holds one `read` grant and no denies (What the code does today). The operator removes staging's grant before Web's approval there, so Laravel's editor never shows an action the approved entry lacks. A deny on `read` would need converting to `browse` before the deploy; none exists, and the operator writes denies by hand only.

### The calls

- **`read_page`:** `quickAction("markdown", {url, browser: "kitesurf", allowRequestPattern, rejectResourceTypes: ["image", "media", "font"], cacheTTL: 0, userAgent: USER_AGENT, gotoOptions: {waitUntil: "networkidle2", timeout: 8_000}, actionTimeout: 3_000, bestAttempt: true})`. Images, media and fonts add requests to the site and no text. Cloudflare recommends `networkidle0` or `networkidle2` for single-page apps (/browser-run/faq).
- **`screenshot_page`:** `quickAction("screenshot", {url, browser: "kitesurf", allowRequestPattern, cacheTTL: 0, userAgent: USER_AGENT, viewport: {width: 1280, height: 800}, screenshotOptions: {type: "jpeg", quality: 80}, gotoOptions, actionTimeout, bestAttempt})`, with the waits of `read_page` and no type rejected, so the host's images show. Only the first screen, so its size stays bounded (owner question 6).
- **`cacheTTL: 0`** keeps the account's 5 s cache off. Every customer renders through one account, so a cached answer could hand one customer's signed-in page to another's request for the same address.
- **The engine waits 15 s per call**, reading the body included, where today's fetch had 25 s. The timers sent bound the navigation and the action after it, not a browser's start, the conversion or the delivery, and no overall limit is documented, so a call can outlive the engine's wait (Strict revocation).

### Only the page's host, only https

1. **Authorization first.** `prepare` parses the address and asks for `browse` on its host, and the executor checks the grants and the organization's list before `execute` sends anything.
2. **https.** An http address opens as https on the same host (owner question 2). The record's `url` is the https address. A site without https fails with `PAGE_ERROR`.
3. **What the page loads must come from its host.** `allowRequestPattern` is `["^https://" + escaped host + "/", "^blob:https://" + escaped host + "/", "^data:"]`. A stylesheet, a script, a frame, XHR, `fetch`, an EventSource or a WebSocket aimed at another host is blocked (measured, C2). docs/connectors.md claims only these kinds.
4. **Moves are not stopped, so a page from another host is withheld.** A redirect, a script setting the address, a form or a link opening a new tab takes the browser to any host, with the pattern on (measured, C2 and C3), and that host receives the address or the form's fields. `meta.finalUrl` is parsed with `parseUrl`. Missing, or not an address Minerva opens (`about:blank`, a `chrome-error:` page), the call failed. On the same host over https it is the record's `url` and the base for relative links. On another host, or on http, the record is today's `redirect_to` record with `MOVED_NOTE` and no text, so the model opens the new address only with its own permission. A move made by the page's own script or form is not in `finalUrl`, which still names the page's host, so its page comes back as that host's; the engine cannot tell.
5. **The record names the page's host and its tenant,** so the executor checks it against the policy and the list again (`executor.ts:292`).

**Where information can go.** Information the agent puts in an address reaches the allowed site, and wherever that site's redirects or scripts send the browser. A site that redirects to an address taken from its own query string forwards it anywhere. The site note, docs/connectors.md and the public Web page say so (owner question 14).

**Same host, not the run's grants.** A pattern built from the whole policy would let a page load from every granted host. It needs the policy inside the connector and denies written as lookaheads, while the same host is what authorized the call in every case.

**What the same host costs.** Pages built on the server keep their text, since it is in the HTML: Wikipedia's articles, most docs sites, Stack Overflow's questions, GitHub's issues (inferred). An app that loads its scripts from a CDN (`cdn.example.net`, CloudFront, unpkg) or its data from `api.example.com` stays as empty as today's fetcher leaves it, and a `*.example.com` grant does not change that, since the page on `www` still cannot load `static.example.com`. Screenshots of sites that take styles, images or fonts from another host come out unstyled. A move from `example.com` to `www.example.com` goes back to the model. How many pages this leaves thin is not measured.

### Private addresses

- **`lib/sites.ts` still refuses IP literals and special-use names** before anything is sent.
- **After that, what the browser may reach is Cloudflare's to decide.** Kitesurf's requests leave through a Worker, "SandboxOutbound" (blog.cloudflare.com/kitesurf, Aug 6 2026), so they probably meet the platform's refusal of private addresses (inferred). Minerva does not test it (Evidence so far, C4) and asks Cloudflare instead. Any Browser Run customer can already point the service at any address, and a move a page makes is not stopped either, so this boundary is Cloudflare's service, not Minerva's.
- **No `SITE_NOT_PUBLIC`.** Without a refusal Minerva can name, such a failure is `PAGE_ERROR` or the site's status, and the code goes with the fetcher.

### Isolation between calls

Kitesurf is documented as ephemeral and stateless. Every customer renders through one account, so a cookie, storage entry, service worker or cache kept between renders would carry one customer's session into another's visit of the same site. This design relies on that statement (documented, not measured, Evidence so far) and on `cacheTTL: 0`.

### Screenshots reach the model as an image

- **Size.** The response is read up to 1,152 KiB, which is `IMAGE_MAX_BYTES` once in base64; a larger one fails with `PAGE_TOO_LARGE`. 1280 by 800 is within 2000 pixels a side.
- **No `meta`.** The engine cannot see the page's status or where it ended. The model sees the page as it rendered, an error page included. A redirect, a script or a form that moves the browser to another host gives a picture of that host's page, labelled with the address the agent asked for, since nothing tells the engine the page moved. This follows from owner question 14: moves are not stopped, and only `read_page` has a `finalUrl` to withhold by. The record is `{url, content_type: "image/jpeg", width: 1280, height: 800}`.
- **The image's path.** `ScopedRecord` gains an optional `image: {mimeType, data}` (base64). `visibleResult` keeps it only with its record, so a denied host or domain drops both. `ToolCallOutcome`'s success gains `images`, outside `ToolResult`, whose schema stays closed. `render` appends one `{type: "image", data, mimeType}` part after the JSON text. pi keeps it in the tool result's row, within `IMAGE_MAX_BYTES`, as `read`'s images are, and pi's `outputLimits` bound only text parts (`boundContent`, pi-durable `dist/harness/tool.js:708-725`).
- **What else sees it.** Nothing. The `tool_call` event carries no result, the log never holds it, and a script gets the outcome's `result` only (`cloudflare/src/scripts/session.ts:184-188`), so a script's call gives the record without the picture.
- **Always a direct tool.** Past `MODEL_TOOLS_MAX`, the tools that do not fit are callable only from scripts (`modelTools`, `cloudflare/src/gateway/tools.ts:143-159`), where the image would be lost, so `modelTools` puts operations that return images first among the direct ones, from a flag on the declaration that only `screenshot_page` sets.
- **A model that takes no images** gets pi-ai's placeholder, "(tool image omitted: model does not support images)". Staging and production run a model the engine treats as taking images (`cloudflare/src/model/route.ts:85`).

### What the model sees

Today's record and error codes stay, so the model's handling of a failed read does not change.

| Outcome | Result |
|---|---|
| `meta.status` 200 and `finalUrl` on the host | The record, Markdown sliced at `offset` and `max_chars` |
| `finalUrl` or a hop on another host | The `redirect_to` record, or the record with the note when the target is unknown |
| `meta.status` 526 | `PAGE_ERROR` "This site's certificate is not valid." |
| `meta.status` 400 or more | `PAGE_ERROR` "The site answered with HTTP {status}." |
| Another `meta.status` (204, a 3xx) | `PAGE_ERROR` "The site answered with HTTP {status}, which has no page." |
| `meta.headers["content-type"]` neither HTML nor a text type, or missing with an empty `result` (a PDF) | `UNSUPPORTED_CONTENT` "Minerva cannot read {type} pages yet.", or "this kind of file" without a type |
| Browser Run 429 or 503 | `BROWSER_BUSY` "Minerva's browser is busy. Try again in a minute." |
| Browser Run 422 with code 2012 | `PAGE_ERROR` "Minerva's browser could not turn this page into text." |
| The engine stopped waiting | `SITE_TIMEOUT` "This site took too long to open." |
| A response over 8 MB, Markdown over 3 MB, or an image over 1,152 KiB | `PAGE_TOO_LARGE` |
| Anything else: a throw, another 400, 422 or 500, malformed JSON, no usable `finalUrl` | `PAGE_ERROR` "Minerva's browser could not open this page." |
| No binding | `BROWSER_UNAVAILABLE` "Minerva's browser is not available in this build." |
| The run made its 100 browser calls | `LIMIT_REACHED` "This run has opened as many pages as it may." |
| No `browse` on the site | `POLICY_DENIED`, the executor's refusal, nothing sent |
| A domain the organization's list leaves out | `POLICY_DENIED` "Your organization does not allow this domain.", nothing sent |

`BROWSER_BUSY` and `BROWSER_UNAVAILABLE` join `ConnectorErrorCode` (`gateway/connector.ts:237`); `LIMIT_REACHED` is a core code a connector may raise already. No code reaches the contract or Laravel. Every failure after the call was sent adds "Its scripts may have run.", since the engine cannot tell how far the browser got. Only the engine's own wait gives `SITE_TIMEOUT`. Only a `meta.status` of 200 supplies text, so an error page with text takes its status row. The title is `meta.title`, and the front matter at the head of `result` is removed. `content_type` is `meta.headers["content-type"]`'s media type, or null. For JSON, CSV, plain text, Markdown and XML (by content type), the text is the content of the last fence in `result`, which held the exact payload in C7; without a fence, `result` as it came.

### Size and time

- **The response** is read through a capped reader up to 8 MB and parsed with `parseJson` (a source rule forbids `.json()`, `cloudflare/test/unit/sources.test.ts:27`). `result` is at most 3 MB in UTF-8, today's `MAX_BODY`.
- **`userAgent` is `USER_AGENT`,** so a site sees Minerva's name on the page, though not on every frame request (Evidence so far).

### Strict revocation and cancellation

- **No browser call starts once the run is revoked.** It goes through the call's io, which checks `admits()` synchronously right before it, as `#send` does. The io's own `NotSent` and `ProgrammingError` pass through. Anything `quickAction` itself throws is `PAGE_ERROR`, so none of it reaches the executor's log of unexpected errors (`executor.ts:478`).
- **A render already sent is handed off.** `quickAction` takes no signal, so a cancel or the 15 s wait only stops the engine waiting, and the result is dropped. The browser goes on loading the page's host, scripts running, until Cloudflare ends it. No document bounds that time, and it was not measured. ARCHITECTURE.md's Strict revocation says what "a request already sent may complete" means for a render (owner question 5).

### The cap, pricing and the log line

- **100 browser calls per run between restarts,** across both operations (owner question 3). The run's browser port counts every `quickAction` it sends; past 100 both fail with `LIMIT_REACHED` and send nothing. The count lives in memory with the run's executor, so a restart or a deploy allows 100 more, which a user or a page cannot cause on purpose. It bounds what one run, or a page that injects instructions, takes of Kitesurf's per-account limits, which every customer shares.
- **Not charged.** Kitesurf is free in its beta, so nothing enters `chargedMicros`. A price needs a later change, with Laravel's `CheckUsage` deployed first (the app's `app/Console/Commands/CheckUsage.php:139`).
- **One log line per browser call:** the operation, an outcome from a fixed set (`ok`, `moved`, `site_status`, `busy`, `timeout`, `too_large`, `not_public`, `unsupported`, `failed`, `capped`), `meta.status`, Browser Run's numeric error code, `X-Browser-Ms-Used` or none, and the duration. Never the address, the host, the domain, Browser Run's error `message`, `detail` or `path`, or a thrown error's message, since those can quote the address and any token in it (guess).

### The binding and builds without it

- **`BROWSER: bindings.browser({ dev: { remote: true } })`** in `cloudflare.config.ts`, left out offline and in the test build, with a comment like the Images binding's (`cloudflare.config.ts:169-171`).
- **A port,** `ConversationPorts.browser(context)`, returns null without the binding and otherwise a `quickAction` function that counts against the cap, called once per run's executor. `ExecutorContext` gains `browser`, `CallIo` gates it, and `ProviderIo` gains `browser: BrowserIo | null`. `settingsIo` has none.
- **The test build returns null,** since its network reaches only `*.fake.invalid` (`cloudflare/src/faults/ports.ts:64-66`, `:209`) and a Worker that the token-gated fault driver controls must never reach Browser Run.
- **Mode `development`** (`pnpm exec vite`) has the binding and opens pages on the account's Browser Run.
- **The deployed probe checks the boundary, not only the binding.** Kitesurf is a beta that can change after Unit 1, so `/api/probe` gains `browser`: two fixed calls that take nothing from the request. One opens `https://example.com/` with `read_page`'s options (status, text length, whether `finalUrl` and `X-Browser-Ms-Used` came back, duration). The other renders, with `html` set and the pattern for `example.com`, a fixed page whose script writes a marker and sends two no-cors `fetch` calls, one to `https://example.com/` and one to `https://example.org/`, writing whether each settled or was blocked. The marker must be present, the fetch to `example.com` must settle, which shows scripts ran and the pattern lets the page's host through, and the fetch to `example.org` must be blocked. Without a binding `browser` is `null`. `test:deployed` asserts both on staging and production after every deploy and in the monthly check, and `null` on the test instances.

### The contract, the catalog and the fingerprints

- **No contract change.** No command, fact or price changes. Tenants are strings within the contract's bounds already.
- **The catalog.** Web's kinds become one, `site`, with `actions: ["browse"]`; its actions `[{id: "browse", label: "Open in browser"}]`; its tenancy `resource` with label `domain`. The note: "Search for a domain or paste an address to add it. Open in browser loads pages in Cloudflare's browser and runs their scripts, which can act on the site as a visit would, such as following a sign-in link. Agents can also send information in the addresses they open, to these sites and to wherever they redirect, so allow only sites you trust. A block on a domain wins over access to a wider one." The detail goes in docs/connectors.md and the public Web page, which the editor links (the app's `resources/js/components/connections/access.ts`, `DOCS_PAGES`). The operator runs `minerva:catalog --approve --only=web` once on staging and once on production after the engine's deploy. Until then Laravel shows the old entry, nobody can grant `browse`, and no restricted layer opens a page.
- **Fingerprints.** `read_page`'s revision becomes 2 and `screenshot_page` starts at 1. The tenancy changes every Web fingerprint, so a run in progress at the deploy loses the Web tools until its next message. The pin at `connectors-web.test.ts:105` gains `screenshot_page`.

### Where it runs and what Cloudflare sees

- **Every page the agent opens goes to Browser Run:** the address, with whatever the agent put in it, tokens included; the page and its own host's resources; the session a sign-in link sets and the account pages it shows; and the screenshot.
- **Where:** "close to the incoming request", with no location guarantee, so possibly outside the EU, also for an EU workspace's conversation (owner question 1).
- **Kept:** page content is discarded after the response and `cacheTTL: 0` turns the cache off (documented). How long addresses and request metadata are kept is not documented. A screenshot stays in the conversation's engine storage, in the tool result's row, as `read`'s images do.

## What is deleted

In Unit 2's commit, with their tests:

- `cloudflare/src/connectors/web/fetch.ts`, `inflate.ts`, `pako.d.ts` and `search.ts`, and `pako` from `cloudflare/package.json` and the lockfile. `USER_AGENT` moves to the new `render.ts`.
- `platformRefusal` and its header line in `cloudflare/src/gateway/http.ts` (`:19`, `:405-412`), and its test in `http-client.test.ts`.
- Web's account kind, `search`, `offered`, `WebOptions` and `MINERVA_BRAVE_SEARCH_API_KEY` (in `pnpm secrets`, AGENTS.md and the docs).
- `test/fixtures/connectors/web/fake.ts`, replaced by `fake-browser.ts`, and the fetch and search cases of `connectors-web.test.ts`.
- The Web connector's mentions in the headers of `lib/markdown.ts` and `lib/charset.ts`, which keep Gmail and Google Calendar.

## Unit 1: the checks

No engine code. The owner approved on 2026-10-26 a throwaway fixture Worker on the test instance's account and the checks below. The fixture lives in the scratchpad, not the repository, and is deleted after the unit; nothing about its hosts is committed. It serves probe pages on one host and records every request that reaches a second host, which the checks read back. Calls go to Browser Run's REST endpoints with cf's sign-in, one at a time and at least 3 s apart, and every check has a positive control (the same call without the pattern, or the same mechanism aimed at the page's own host) that must show the request arriving, or the check proves nothing. A mechanism that never runs on Kitesurf, even in the control, is recorded as unsupported, not blocked, and docs claim nothing for it.

- **C2, the boundary with scripts running.** `read_page`'s exact options, then `screenshot_page`'s. A page on the first host sends to the second: `fetch` by GET and by POST (no-cors), `navigator.sendBeacon`, a `WebSocket`, an EventSource, an `<a ping>` clicked by script, a `<script src>`, a dedicated worker's `fetch`, a shared worker, workers built from `blob:` and `data:`, a service worker registered on the first host that fetches the second, WebRTC with an ICE server on the second host, and a speculation-rules prefetch. Then the moves: `location.href`, a meta refresh, a form that submits itself by GET and by POST, `window.open`, links and forms with `target=_blank`. The page reports in its text which mechanisms ran. Pass: nothing reaches the second host, every mechanism that ran reaches it in the control, and a same-host `fetch` and POST arrive. A kind that gets through is tried with its type in `rejectResourceTypes`; if that blocks it, the type joins the options, and otherwise Kitesurf fails.
- **C3, redirects.** A `url` that answers 302 to the second host, with the pattern and without: `meta.finalUrl`, `meta.redirectChain` and the status, to decide how `redirect_to` is found. A 302 from https to http on the same host.
- **C4, certificates.** badssl.com's expired, self-signed and wrong-host test certificates. Pass: each fails. No call is aimed at a private or metadata address (Evidence so far).
- **C5, C6 and C8 are not run** (Evidence so far): isolation between calls and the cache rest on Cloudflare's documentation, and a render's lifetime after the caller stops is unknown.
- **C7, content.** Fixtures with exact payloads: JSON, CSV, plain text, Markdown and XML; a page in a charset other than UTF-8; a page with known sentences, a table and relative links; a PDF, an image, a 404, a 204 and a page over 3 MB. Recorded: what `result`, `meta.status` and `meta.headers["content-type"]` hold for each. Pass: the sentences and links come back, and each text payload comes back exactly or inside a wrapper the engine can remove.
- **C1, the binding,** runs in Unit 2, since it needs the Worker: `/api/probe` in mode `development` before the commit, with the same options as over REST.

The unit records each result in Evidence so far, with its label, and anything that contradicts a decision here goes back to the owner before Unit 2.

## Deploy order and rollback

Deploys of staging and production ask the owner first (AGENTS.md, Cloudflare); so does pushing the app's `main`, which deploys Laravel's staging, and publishing the docs site.

1. **Unit 1, the checks.**
2. **Units 2 and 3,** two commits: `pnpm check --instance minerva-cf-test`, push `main`, green `main.yml`, then `account.yml` (`gh workflow run account.yml --ref main`) with all of `test:faults` and `test:deployed`, since `cloudflare.config.ts` changes.
3. **Unit 4** committed in the app, pushed with the owner's go, which deploys Laravel's staging. Allowed apps then offers a list for Web only after the approval in step 4, since it reads the approved entry.
4. **`minerva-cf-staging`,** with the owner's go: `pnpm run deploy`, `pnpm test:deployed --instance minerva-cf-staging`, staging's one `read` grant removed, `minerva:catalog --approve --only=web` on Laravel's staging, then the live checks.
5. **Unit 5,** the public Web page, published with the owner's go once staging's live checks pass.
6. **`minerva-cf`,** with the owner's go after staging's live checks (owner question 8): the deploy, then the Web approval on Laravel's production.
7. **A usage notification for Browser Run** on the account, with the owner's go, so a price for Kitesurf shows within days rather than at the monthly check.

**Rollback** is reverting the commits and deploying, which needs green runs of `main.yml` and `account.yml` on the revert (AGENTS.md, Git). No storage or contract changed. The old engine's catalog has `read` and no tenancy for Web, so stored `browse` grants become keys no operation needs, nobody can read pages until `read` is granted again, and a list on Web's policy entry refuses Web entirely (`admission`'s `unknown` case). There is no switch back to the plain fetch while Browser Run is down (owner question 4).

## Units

Each unit is for one fresh agent, in this order.

1. **The checks.** As above.
2. **Reading through the browser (harness).** One commit: `read_page` through the port, the `browse` action, Web's tenancy, search and the fetcher deleted, the binding, the port and its cap, the error table, the log line, the probe, the tests, and the docs for reading and the site list. It runs C1 in `pnpm exec vite` (mode `development`, which needs `CLOUDFLARE_API_TOKEN`) through `/api/probe` with the token derived from `.dev.vars`' `MINERVA_SECRET_KEY`, never printed. Done when `pnpm check --instance minerva-cf-test` passes and it is committed.
3. **Screenshots (harness).** One commit: `screenshot_page`, the image's path through `ScopedRecord`, `visibleResult`, `ToolCallOutcome` and `render`, `modelTools`' order, the tests and the docs. Done as Unit 2. opencode reviews both diffs, since they change what a site grant lets reach.
4. **Web's site list (app).** One commit: how a typed Web domain is written and refused, its tests, Allowed apps' words for a domain list, and the app's `connection-policies.md` (16 and 18) and `connectors.md` (Built-in services, which says Web searches). Committed, pushed only with the owner's go.
5. **The public Web page (landing-page).** `docs/src/content/docs/connectors/web.md`: the permission, the organization's list, What a visit can do, the same-host rule and its cost, screenshots, and the limits. Its "How pages are opened" and "What agents cannot do" are false once this ships.

## Tests

All run in Node or local workerd, with no account (`vitest.platform.config.ts:30`).

- **A fake browser,** `cloudflare/test/fixtures/connectors/web/fake-browser.ts`. It records each call's action and options, and answers what a test scripts: Markdown with a `meta`, an image, an error status, a throw, a hang, a `finalUrl`, a `redirectChain` or none, an oversized body.
- **`connectors-web.test.ts`, reading:**
  - a granted https page gives today's record with the fake's Markdown, `meta.title` and the content type, front matter removed; a slice at `offset` and `max_chars` as today;
  - the options sent: `markdown`, `kitesurf`, the exact pattern list, the rejected types, `cacheTTL: 0`, the user agent and the timeouts;
  - an http address opens as https; the fragment is sent; an IP literal, `localhost` and a site the policy denies send no call;
  - each row of What the model sees, with the exact code and message, and the scripts sentence after a call was sent;
  - `finalUrl` on another host or on http gives `redirect_to` and no text; missing, `about:blank` and `chrome-error://chromewebdata/` fail; on the same host it is the `url` and the links' base;
  - a response over 8 MB, Markdown over 3 MB, malformed JSON and `success: false`;
  - a hang is cut at the wait, on lowered limits, and the wait covers a body that stalls;
  - the pattern for a host with a hyphen and a punycode label, an address whose query holds another host, and the same host on another port;
  - the cap: after 100 calls in one run, of either operation, the next is `LIMIT_REACHED` with no call, and a run with its own executor starts at 0;
  - the log line: each outcome from the fixed set, and no part of the address when the fake's error `message`, `detail` and `path`, or a thrown message, hold it;
  - no binding gives `BROWSER_UNAVAILABLE`; `NotSent` and `ProgrammingError` from a revoked or closed io pass through.
- **`test/platform/internal-connections.test.ts`:** the account's name (`:143`) and the `search` edit (`:238-247`) go with the account kind; the site edit (`:250-269`) grants `browse`, `read` becomes invalid with `search`; the list case (`:339-340`) becomes a list that Web accepts by domain, with a site outside it refused.
- **The site list:** each resource and record names its registrable domain as tenant; `tenants` maps `en.wikipedia.org`, `*.wikipedia.org` and `wikipedia.org` to `wikipedia.org`; under a list without the domain a call is `POLICY_DENIED` with the domain's message and sends nothing, and an edit allowing such a site is `TENANT_NOT_ALLOWED`, while `*` is allowed; under a list with it the call is sent; an unrestricted layer does not pass the list; `https://co.uk/` is `INVALID_URL` with no call, discovery of `co.uk` is empty, and a grant edit for `co.uk` is invalid.
- **Grants:** `read` alone refuses both operations; `browse` allows them; a deny on `browse` on a domain wins over an allow on `*`.
- **Screenshots:** `screenshot_page` needs `browse`; it gives the record and one image of the fake's bytes; an image over 1,152 KiB is `PAGE_TOO_LARGE`; the image is the part after the JSON in `render`'s output; a record that `visibleResult` drops drops its image; a script's call gets the record and no image; a 1.5 MB image reaches the model's context whole; with more gateway tools than fit, `screenshot_page` is among the direct ones.
- **The fingerprints:** the pin at `connectors-web.test.ts:105` gains `screenshot_page` and changes `read_page`'s.
- **`executor-revocation.test.ts`:** no browser call once the run is revoked, and a cancel during a call drops its result.
- **One platform test,** `test/platform/web-render.test.ts`, with its own ports: the browser port gets the fake, and a run's `read_page` reads through it, under a policy with a domain list; a `cancelRun` during the call ends the run.
- **The probe:** `test:deployed` checks `/api/probe`'s `browser` on staging and production and `null` on the test instances. A unit test checks that the probe reads nothing from the request for it.
- **`pnpm startup`** stays within its limit; `pako` is removed and nothing added.
- **The app (Unit 4):** typed domains written as the engine writes them (case, IDNA, `*.`, a scheme, a path, a subdomain reduced), a public suffix and an IP refused with the message, and a policy saved with a Web list sent in a start.

## Docs to update

- **docs/connectors.md, The Web:** Fetching becomes "Opening pages": every page opens in Cloudflare's browser with its scripts running, https only, the browser reaches only the page's host for the kinds of request C2 measured, and What a visit can do. The organization's list by domain. Agents can gains screenshots. Search goes. Limits: bot-protected pages stay unreadable, a page whose code or data comes from another host stays thin, a continuation opens the page again and may differ, a run opens at most 100 pages, a screenshot shows only the first screen and reaches only models that take images, information can reach the allowed sites and wherever they redirect, and past Minerva's refusal of numeric addresses and local names, what the browser may reach is Cloudflare's service to decide.
- **docs/data-processing.md:** the "Web fetch and search" row becomes Web pages opened by Cloudflare Browser Run, receiving the address with whatever the agent put in it, the page and its host's resources, the session a sign-in link sets, and screenshots; location "close to the incoming request", with no guarantee and possibly outside the EU; page content discarded after the response, addresses and request metadata not documented; screenshots kept in the conversation's engine storage. Brave Search goes. The Subprocessors' Cloudflare row lists Browser Run.
- **ARCHITECTURE.md:** Spike results, Private addresses, becomes Minerva's own refusal before sending, Cloudflare's service deciding after it (untested by Minerva), the certificate checks C4 measured, the kinds of request the pattern blocks and the moves it does not; the claim of "adversarial tests ... against the deployed Worker", whose test was removed in `c23b43e`, goes. Connectors: `browse`, why both operations stay reads while they can act on a site, Web's tenant per domain. Tenancy: the Web is a tenant per resource. Strict revocation: a render already sent, or one the engine stopped waiting for, is handed off to Cloudflare, with no bound known. Budgets: Browser Run is not charged, and the cap of 100 calls per run. The harness: images reach the model through `read` and through `screenshot_page`. Configuration and Status: the `BROWSER` binding. Open questions: Browser Run among what has no EU guarantee.
- **cloudflare/README.md:** Local development's table gains a Browser row (offline none; `pnpm exec vite` reaches the account's Browser Run); the test Worker has no browser; a monthly operator check of Kitesurf's status (still in beta, still free, its limits) and the month's browser hours.
- **AGENTS.md:** `MINERVA_BRAVE_SEARCH_API_KEY` goes from Secrets.
- **README.md:** the Web connector reads pages in Cloudflare's browser and takes screenshots.
- **Code comments:** the header of `connector.ts` points to the new `render.ts`, whose header gives the rules above and cites ARCHITECTURE.md, never this file.

## Live checks

| Check | Where | Who |
|---|---|---|
| C2, C3, C4 and C7 (done) | The test instance's account, through Browser Run's REST endpoints | The agent |
| C1, `/api/probe`'s `browser` through the binding, before the commit | `pnpm exec vite` | The agent |
| `pnpm test:deployed --instance minerva-cf-staging` | Staging, after its deploy | The agent |
| A turn through `minerva:turn` opens a granted static page, and the log line shows one call | Staging | The agent, with the owner's go |
| A turn opens a page built by scripts on its own host, and `screenshot_page` gives an image the model describes | Staging | The agent, with the owner's go |
| Without `browse` on a site, both are refused and nothing is sent; a host the run may not open is refused | Staging | The agent |
| With the "Shared" team's policy offering Web on `wikipedia.org` only, a turn opens a Wikipedia article, is refused another domain, and a grant edit allowing another domain is refused | Laravel's staging and the engine | The agent, with the owner's go |
| The new note, the Open in browser checkbox and Web's domain list on Allowed apps, after the approval | Laravel's staging | The agent, with the owner's go |
| Within 7 days: calls per operation, failures by outcome and summed browser time (`cf o11y` with the instance's account) | Staging, and production once deployed | The agent, with the owner's go |

## Risks

- **Every read depends on a beta.** Kitesurf has unpublished limits and no price for after its beta. An outage stops all web reading. The monthly check and the deployed probe watch for change.
- **A Browser Run outage** fails each read after up to 15 s and holds one of the run's 4 slots meanwhile. The model gets `BROWSER_BUSY`, `SITE_TIMEOUT` or `PAGE_ERROR`.
- **Reads get slower.** Kitesurf's HTML extraction has a median of 820 ms (/browser-run/kitesurf, documented), and the probes took 0.6 to 2.2 s from the laptop (measured), where a plain fetch is usually less (guess).
- **Some sites refuse Browser Run** more often than today's fetch, since it is always identified as a bot.
- **Redirects on allowed sites reach other hosts.** A site that forwards to an address from its query string sends what the agent put there anywhere. Accepted (owner question 14), and the note says so.
- **A visit can act on a site,** sign in through a link and repeat an action. The note, docs/connectors.md and the public page say so.
- **One customer can use up the shared limits.** Kitesurf's limits are per account. The cap bounds one run, not several, and there is no admission across the account while pilots join by invitation (owner question 3).
- **Screenshots of sites that use a CDN look broken,** since the pattern blocks their styles, images and fonts.
- **A list by domain is coarse.** An admin cannot allow one subdomain alone at the organization's level; a member can in their grants.

## Accepted, not fixed

- **Browser Run ignoring `cacheTTL: 0`** would be a platform misbehaving in a way it is not known to. A page could then be up to 5 s old, from the account's cache.
- **A move made by the page's own script or form** is not in `finalUrl`, so its page comes back labelled as the allowed host's. The page's host chose to send the browser there, and could show the same text itself.
- **A screenshot of a page that moved** shows the other host's page under the address asked for, since a screenshot has no `meta`. The allowed host sent the browser there, the model sees only a picture, and what the other host received is what the owner accepted for moves (owner question 14).
- **A request of a kind C2 does not test** getting past the pattern needs a channel no reviewer or check named. Another host would then receive what the page holds.
- **The account's 30 Quick Actions a second** are shared by every customer. Reaching it needs about 8 runs opening pages at the same moment, unlikely at pilot scale; those calls get `BROWSER_BUSY` for that second.

## Owner questions

1. **Processing outside the EU.** Every page the agent opens goes to Browser Run, with no location guarantee. **Answered 2026-10-26:** acceptable, and docs/data-processing.md says so.
2. **http addresses.** Opened as https on the same host, so an http-only site cannot be read. **Answered 2026-10-26:** as proposed.
3. **The cap, and the shared limits.** 100 browser calls per run between restarts, and no admission across the account while pilots join by invitation. **Answered 2026-10-26:** as proposed, revisited when Kitesurf states its limits.
4. **No switch.** Nothing to fall back to while Browser Run is down; a rollback is a revert with its CI runs. **Answered 2026-10-26:** accepted.
5. **Revocation and a call in flight.** A render already sent goes on at Cloudflare after a cancel for as long as Cloudflare lets it. **Answered 2026-10-26:** acceptable, and ARCHITECTURE.md's Strict revocation says so.
6. **Screenshots.** The first screen at 1280 by 800 as a JPEG, not the full page. **Answered 2026-10-26:** as proposed.
7. **What Open in browser grants.** A page's scripts can act on the site, sign the browser in and repeat an action, outside the write ledger and its pauses, in parallel, with replays, and with no approval per call. **Answered 2026-10-26:** accepted; both operations stay reads.
8. **Kitesurf in production during its beta.** **Answered 2026-10-26:** staging first, production only after staging's live checks, when the owner says so.
9. **Existing `read` grants.** **Answered 2026-10-26:** removed, not converted, after a read-only count on staging and production.
10. **Unrestricted layers.** A layer that is unrestricted allows `browse` from the deploy on, as it allows any new action. **Answered 2026-10-26:** accepted.
11. **Who limits browser access.** **Answered 2026-10-26:** an admin allows chosen sites, such as Wikipedia, and members cannot go beyond them. Designed as Web's domain list on Allowed apps (The organization's site list).
12. **Removing search.** Under a tenant per domain, search's need on the account has no tenant, and no build has its key. Default: deleted, to come back as its own connector.
13. **A list by domain.** The organization's list holds registrable domains, and members narrow within them. Default: as proposed.
14. **The same-host rule and moves.** Kitesurf's pattern blocks what a page loads from another host, not a redirect or a move the page makes (C2, C3), and `finalUrl` hides the page's own moves. **Answered 2026-10-26:** accepted. The engine withholds a page `finalUrl` places on another host or on http, and the docs and the site note say information can reach the allowed sites and wherever they redirect.

## Alternatives rejected

- **Reading with scripts off** (the earlier version). Kitesurf refuses `setJavaScriptEnabled: false` (Evidence so far), and the owner chose to let scripts run.
- **Keeping the fetcher for pages that need no scripts.** Two paths, a guess at which page needs which, and a fallback the owner ruled out.
- **Chromium.** It doubles the engines, timers and checks, and the owner ruled it out.
- **Relabelling `read`.** It would turn every existing grant into a visit nobody chose.
- **A second permission beside `read`.** With the fetcher deleted, `read` alone would open nothing.
- **An admin-only switch for browser access, apart from connection policies.** A second place to limit the same connector; the policy's list already binds every member's connection.
- **A policy that also grants.** Allowing the list's sites in every member's layer would make the policy authorize, where today it only limits; presets can fill a member's grants instead.
- **Keeping search with a tenant on the account.** No tenant fits a search provider, and exempting the account from tenant lists would change what a list means for every connector.
- **A pattern from the run's grants, or from the organization's list.** It would let a page load from every allowed host, and denies become lookaheads.
- **`content` with Minerva's converter.** It keeps the conversion this design removes, and Cloudflare's Markdown was longer on the one page measured.
- **`snapshot`, `json`, `links`, `pdf` and raw `content` as tools.** Requirement 2. `json` also runs a second model billed outside the allowance (/browser-run/quick-actions/json-endpoint, Oct 12 2026).
- **A full-page screenshot.** Its size has no bound, while the model gets at most `IMAGE_MAX_BYTES`.
- **Saving screenshots into the folder** for `read` to open. The connector would need the folder, and the user's folder would fill with screenshots.
- **Rendering http pages.** Without TLS, a name that resolves privately for the browser would reach the private address.
- **A browser session with request interception.** Not a Quick Action (requirement 2), and hostname guardrails do not work with Kitesurf (/browser-run/features/guardrails, Sep 26 2026).
- **Marking the operations writes.** It would run every page read one at a time, through the write ledger, with no replays, for the few pages whose scripts act.
- **A setting that turns the browser off.** With the fetcher deleted, off means no reading, which the emergency stop and a rollback already give.
