# Approvals design: ask first, then run

Status: proposed, 2026-10-25. Not built, and nothing deployed. Line numbers are at `73d6a18` (harness, whose code is the same as at `61a9b15`) and at `c3e4052` of `minervacomputing/app` ("the app's" below). A claim about code with no label was read at the lines cited. One marked (inferred) follows from code that was read, and one marked (guess) rests on behaviour no code or document states. It assumes [fast-starts.md](fast-starts.md) is built first, as the owner's order has it, so where both touch the start the line numbers here will move. It builds on [product-and-engine.md](product-and-engine.md): Laravel decides and stores, the engine runs and records, and a run is one turn with its grants compiled at its start. Once built, what stays true moves into ARCHITECTURE.md, cloudflare/README.md, docs/connectors.md, docs/data-processing.md, docs/plans/contract.md and the app's `docs/architecture/`, and this file is deleted.

Review: opencode and three adversarial reviewers, one each for security, protocol and product, reviewed the draft on 2026-10-25. Each finding was checked against the code. The findings that hold and can happen in real use are folded into the sections below. The improbable ones are under Accepted, not fixed, and the wrong ones under Dropped in review. Where an improbable finding's fix was only the correct statement of a rule this plan has to state anyway, at no cost in code, the rule was corrected instead: an ask only narrows, approvals reopen only on a tombstone, and the new fact has a row for every target.

## Why

- **"Send mail, but ask me first" cannot be said.** A grant allows or denies (`contract/src/internal/engine.ts:27`). An admin who wants a person to confirm each send can only deny sending.
- **Later work needs it.** A tier of vendors' MCP servers where writes ask, routines and inbound email that start runs nobody watches, and API-key connections all need a third answer between yes and no (What later work inherits).
- **The reference shows the shape works.** bdots (at `ce94160`, read, never run) has allow, ask or block per action class. An ask stops the call with a card, and the answer starts a continuation turn. A push goes out when a turn waits, a reminder after 4 hours, and the card closes after 24 (`src/agents/bot-agent.ts:158-161`, `:2664-2674`, `:2770-2777`). In background turns ask becomes block (`:988-998`).
- **Its weak spots are what not to copy.** Every app tool is one class. Read-only comes from the server's own hint or a verb in the tool's name. Any later turn closes a waiting card (inferred in the earlier study).

## What the code does today

### The engine

| Claim | What the code does |
|---|---|
| Two effects on the wire and in the snapshot | `GrantInput.effect` is `allow` or `deny`, and `name` is for display only (`contract/src/internal/engine.ts:20-28`). A snapshot layer holds `allows` and `denies` (`cloudflare/src/gateway/policy.ts:15-21`), and `Layer.build` splits rows by effect (`:120-128`). |
| Deny wins, with no rule by specificity | Any layer that blocks denies the call, else every layer must pass (`policy.ts:179-182`). `blocks` matches `*`, the id or an ancestor, and a `partial` chain is blocked by any exact deny for the action (`:135-138`). `passes` is true for an unrestricted layer or a matching allow (`:140-142`). The call checks the action's whole `requires` chain (`:189-193`). |
| Unenforceable rows | Denies always apply. An allow counts only for a declared kind, and `*` only on a wildcard kind, "so a hand-edited row cannot widen access" (`cloudflare/src/gateway/grants.ts:71-80`). A missing layer is unrestricted for the ceiling and the agent and restricted for the user (`:41`). |
| Snapshots fail closed | `fromJson` throws on a layer without `restricted`, `allows` or `denies` (`policy.ts:164-168`, `:239-249`). `COMPILER_VERSION` is `3` and must rise when a snapshot allows something new (`cloudflare/src/gateway/tools.ts:62-66`). The acceptance names it (`engine.ts:113-115`). |
| The editor plans allows only | `checkGrantEdit` plans changes of `{kind, id, actions}`, edits only this connection's allow rows and writes `effect: 'allow'` (`cloudflare/src/internal/connections.ts:217-271`). `checkChanges` checks kinds and actions (`grants.ts:105-124`). zod's objects strip unknown keys, so an older engine drops a field it does not know (`docs/plans/contract.md`, Versions). |
| Only operations say they write | A catalog action is `{id, label, requires}` (`contract/src/internal/catalog.ts:62`). Operations carry `mutates` (`:65-73`). |
| A call's order | The known-write check comes before the lease (`cloudflare/src/gateway/executor.ts:541-550`), then the lease (`:576`), consent (`:594-596`), `prepare` (`:597`), `#authorize` (`:599`), the fence check (`:600`) and the claim (`:707`). `#authorize` decides after its loop, the grants before the tenants (`:645-688`). A write cannot enumerate (`:675`). |
| A write's records are filtered by its own action | `visibleResult` keeps a record only when `policy.permits(resource, terms.outputAction)` holds (`executor.ts:292`). For a write, `outputAction` is the write action, as Gmail's `send` (`cloudflare/src/connectors/gmail/writes.ts:89`). `permits` has two callers, that filter and `#authorize` (`:670`). `permitsAny` picks the tools offered (`tools.ts:110`) and checks enumerations (`executor.ts:676`). |
| The write key is per run and names an alias | `writeKey` hashes the tool name and the validated fields (`cloudflare/src/gateway/ledger.ts:99-107`). Aliases number the user's usable connections at each start, `todoist`, `todoist2` (`tools.ts:85-87`, `:96-110`), so a connection that errors or goes renumbers the rest. |
| The ledger's pause and its forgetting | A write the provider refused is deleted so it can be tried again. An uncertain one pauses every later write in the run for good (`ledger.ts:1-8`, `:174-176`, `:191`, `:220`). The settlement appends `run.write`, with `afterCancel`, in its own transaction (`cloudflare/src/conversation/store.ts:1331-1335`). |
| After a cancel, a call shows no row | Once the run is not active, the executor returns no event (`executor.ts:466-473`), and `#invoke` records no `tool_call` (`conversation.ts:1393-1403`). A write already sent still goes on and settles (`executor.ts:585-588`). |
| `#invoke` stops waiting at the run's end | Its signal joins pi's abort with the run's end (`conversation.ts:1387-1390`), and the executor's answer is cut by it (`executor.ts:463`), while a sent write settles under `waitUntil`. |
| A write makes its round sequential | Writes register `sequential` and `unsafe`, reads `parallel` and `safe` (`cloudflare/src/conversation/tools.ts:97-104`). One sequential call makes the whole round sequential (`cloudflare/node_modules/@earendil-works/pi-durable/dist/harness/generation.js:457-458`). |
| Scripts call connector tools | `run_script` can call every connector tool of the run (`cloudflare/src/scripts/tool.ts:1-4`), through `#invoke` with `drop` (`conversation.ts:1266-1273`). |
| No early end fits | pi's `terminate` ends a run only when every call of the round asks for it (`generation.js:503-505`). An empty answer fails the run `worker_failed` (`conversation.ts:956-961`). |
| An outcome is recorded before the model hears it | `#invoke` records the call's `tool_call` event outside pi's transactions before the caller gets the outcome (`conversation.ts:1376-1437`). The model sees a failure's message with `isError` (`conversation/tools.ts:59-62`). `DENIAL_CODES` decide what the chat shows as refused (`cloudflare/src/gateway/results.ts:73`). |
| A refused row has no link to anything | `run.tool_call`'s refused branch has no `write` (`contract/src/internal/facts.ts:55-66`; `results.ts:135-136`). Its arguments are cut to 2,000 characters (`facts.ts:38`, `:50`). `code` is a free string (`:65`). `run.finished.status` has four values (`:206`). |
| Write inputs reach 1 MiB | Google Drive's and OneDrive's create take up to 1 MiB of content (`connectors/google_drive/connector.ts:48`, `:268-273`; `connectors/onedrive/connector.ts:57`). Confluence takes a 50,000-character body (`connectors/confluence/writes.ts:17`). A Durable Object row holds up to 2 MB (`ledger.ts:79`), and a fact page 4 MiB (`conversation/facts.ts:16`). |
| Names come from the connector | `describe` names resources from their ids (`cloudflare/src/gateway/connector.ts:203`), as the grant editor uses it (`connections.ts:163`). A `Resource` has no name (`policy.ts:35-43`). Gmail's reply goes to the original's Reply-To or From, not to a field (`gmail/writes.ts:119-124`, `:190-195`). |
| Web reads carry data out | "Opening an address sends whatever is in it to that site" (`connectors/web/connector.ts:4-6`). |
| A start needs text | `EMPTY_MESSAGE` for no text and no attachment (`cloudflare/src/internal/start.ts:48-50`). Another run active or prepared is `CONVERSATION_BUSY` (`conversation.ts:533`). |
| The start section | `startAttempt` and the settle (`conversation.ts:584-585`), the tools installed (`:587`), the note after a stopped turn and the one submit (`:617-621`). Tool calls are admitted only from a placed submission (`cloudflare/src/conversation/pi-work.ts:99`, ARCHITECTURE.md, The harness, Admission by run). |
| A run that never submitted is quoted | `#turnNote` quotes the prompt of each earlier run pi never received, under "[The user sent a message that was stopped before you saw it. It said:]" and "Do not act on it" (`conversation.ts:629-640`; `conversation/history.ts:146`, `:169-183`). |
| The gate skips the write sweep on `none` | `#gate` returns before marking a dead instance's dispatched writes uncertain when it decides `none` (`conversation.ts:735`, `:743`). It decides `none` for a run with no submission (`cloudflare/src/conversation/gate.ts:27`, `:57-66`). |
| A run's records | `RUN_RECORDS` lists what retention deletes with a run (`store.ts:177-187`), 30 days after it ended (`conversation/retention.ts:17`). |

### Laravel

| Claim | What the code does |
|---|---|
| Grants are stored raw | One `layers` row per workspace, level and subject, with `grants` as jsonb of `GrantInput` (the app's `database/migrations/2026_10_14_140000_create_runs_tables.php:60-75`). Laravel never evaluates a grant (the app's `docs/architecture/grants.md:20`). |
| Display folds everything but allow into "denied" | `Access::view` keeps allow rows and reports `denied` when other rows exist (the app's `app/Connections/Access.php:62-81`). `withinContract` accepts only `allow` and `deny` (`:384-391`). `kept` accepts an answer only if every row that is not an allow on this connection comes back as sent (`:341-356`). |
| An unrestricted layer takes no grant edit | `Access::edit` refuses every change while the target layer is unrestricted (the app's `Access.php:187-192`). The ceiling and the agent layer start unrestricted (`app/Connections/Target.php:60-64`). The ceiling is edited by admins and only on shared connections (`:73-80`). Restricting it blocks members' personal connections except where it allows them, which the pages never do (the app's `docs/architecture/grants.md`, The agent layer and the ceiling). |
| The controller passes three keys | `AccessController::update` validates `changes.*` as `array:kind,id,actions` and rebuilds each change from those three (the app's `app/Http/Controllers/AccessController.php:56-73`). |
| The approved catalog entry is pinned | Laravel reads a connector only from the entry the operator approved (the app's `app/Models/ApprovedConnector.php:12-15`), and `Catalogs::approve` stores a changed entry only on approval (`app/Connections/Catalogs.php:86-99`). The mapped `Connector`'s actions are `{id, label, requires}` (`app/Engine/Catalog/Connector.php:13`), so a new key is dropped on the way to the editor. |
| Consent counts allows | `Consent::allowed` unions allow rows' actions to decide the OAuth scopes (the app's `app/Connections/Consent.php:82-90`). |
| The editor is binary | One checkbox per action (the app's `resources/js/components/connections/access-editor.tsx:484-565`), and `toggle` follows `requires` (the app's `resources/js/components/connections/access.ts:53-82`). |
| Every edit cancels the constrained runs | Expansions are not told apart from reductions (the app's `docs/architecture/grants.md:21`; `app/Runs/Revocations.php:251`). |
| A conversation is its user's alone | `Openable::constrain` filters on `conversations.user_id` (the app's `app/Conversations/Openable.php:25-37`). No admin surface shows another member's chat. |
| A start is a typed message | `Runs::start` takes the message's content (the app's `app/Runs/Runs.php:73`). One active run per conversation (`:118`, index `runs_one_active` in the migration above). History is empty once a run completed (`:335-337`). Starts are throttled (`routes/web.php:58`, `:60`). |
| Facts apply by target | `applyFact` documents each type's effect for Live, Deleted, Lost and Gone targets, and throws on a type it does not apply (the app's `app/Runs/Facts.php:200-239`). The facts route validates against the contract copy, so an unknown fact type is a 422, and an unknown field is ignored (the app's `docs/architecture/turn.md:184`, `:208`). |
| The chat walks user messages | The transcript shows four fact types and at most 200 events a run, plus its end (the app's `app/Conversations/Transcript.php:30-33`, `:138-152`), on pages of 40 user messages (`:27`). `buildMessages` attaches each user message's run (the app's `resources/js/components/chat/model.ts:246`). A tool call renders in `ToolCall` (the app's `resources/js/components/chat/thread.tsx:475`). The page reloads its props every 2 s while a run starts and every second for 10 s after it ends (the app's `docs/architecture/conversations.md`, steps 1 and 6). |
| Leases | A run is lent to while it is active and has no cancel (the app's `app/Models/Run.php:85-88`). A start that carried a policy is lent to only once its engine's compiler enforces it (the app's `app/Runs/Leases.php:73-84`). |
| "Approval" is taken | The app already uses it for the operator's connector approvals (`app/Models/ApprovedConnector.php`) and Microsoft's administrator approval (`app/Connections/AdminConsent.php`). |
| Notifications and audit | Two mail notifications exist, `InvitationMail` and `BillingReport` (the app's `app/Notifications/`), and no database notifications table. `audit_events` holds ids, counts, revisions and catalog descriptors such as a connection's provider and kind, never content (the app's `docs/architecture/retention.md`, The audit log). `minerva:turn` starts a run as any member by email (the app's `app/Console/Commands/RunTurn.php:20-56`). |

## Decisions

Each question the plan had to settle, with its answer. The sections below give the detail.

| Question | Decision | Why |
|---|---|---|
| Where ask sits in the layers | Per layer, deny, then ask, then allow. Across the layers and the `requires` chain the worst wins. So deny beats ask, ask beats allow, and a ceiling or agent ask binds everyone under it. An ask only narrows: it never lets a restricted layer pass. | The same intersection as today, with one more rank. A hand-edited ask row cannot widen access, as no other row can (`grants.ts:71-73`). |
| A specific allow under a broader ask in one layer | The nearest grant decides between ask and allow (owner question 1). Denies keep no specificity. | "Colleagues allowed, everyone else asks first" is the common rule for mail, and strictest-wins cannot say it. |
| Reads or writes | Ask applies only to actions no reading operation needs. Today that is every write action of every connector and never `read`, so the web connector's reads never ask (owner question 9). | A read changes nothing to confirm, and reads that enumerate decide which tools are offered. |
| Where an admin's ask reaches | Through the ceiling on shared connections, and through an agent's layer on that agent's connections. An ask may sit on an unrestricted ceiling or agent layer without restricting it. A member's personal connection asks only where the member's or the agent's layer asks (owner question 10). | Restricting the ceiling would block members' personal connections. An ask only narrows, so it needs no restriction. |
| Scope of an approval | The exact held call: its connection, operation, fingerprint, validated fields, and every resource and action its `prepare` named. A standing change is a grant edit (owner question 3). | The write key names a tool alias, which can name another connection in a later run. |
| Who approves, and where | The run's user, on the conversation's page, also for a ceiling's or an agent's ask. The editors say so. No approve link in mail (owner question 2). | A conversation is its user's alone. An admin approver would see a member's chat. |
| Which runs can hold a call | Only a run whose start Laravel marks `attended`. Without it, an ask is refused `APPROVAL_UNAVAILABLE` and holds nothing. | It fails closed: a later start that nobody watches gets no holds by omission, and the engine never holds a call for an app that cannot show its card. |
| What the model sees | `APPROVAL_REQUIRED` while waiting, which tells it to point the user at the card's buttons. The next run's input then says what happened to each held call. | The model finishes its turn normally, and learns the outcome from the engine, not from the user's words. |
| The rest of the turn | Reads go on. Later asking writes are held too, up to 10. The first write that does not ask is refused `APPROVAL_PENDING`, and so is every write after it. A run whose writes are paused by an uncertain write holds nothing. Scripted calls follow the same rules. | Nothing runs out of the model's order, or after a write whose outcome is unknown. |
| Restarts, deploys, attempts | The hold is a row in the conversation's SQLite, written before the model hears of it, and each approved call's outcome is stored on it, in the write's own settlement when it reached the ledger. A repeat answers from it. The held run's attempts are unchanged. | The same rule as the write ledger. A section that runs again computes the same note. |
| A held run that did not complete | Its holds stay answerable however it ended: stopped, failed, timed out or cancelled by a revocation. | The user acts on the card on purpose, and the continuation compiles the current grants anyway. |
| Approve after revocation, removal, a changed tool, expiry | The continuation compiles the current grants. A missing tool, a changed fingerprint, a different set of resources, or a deny each become a line of the note and a reason on the card, and the call does not run. An ask over the same resources is covered by the approval. Laravel refuses an expired card. | Laravel never evaluates grants, so the engine checks at the continuation's start. The user saw every destination. |
| Double clicks, two tabs | Laravel locks the run's approvals in the start's transaction. The engine uses each hold once, in the start's final write. | Both sides refuse a second use on their own. |
| Expiry and reminders | Laravel: 7 days from the hold until notifications exist, then 24 hours with a reminder at 4 (owner question 6). The engine keeps no clock for holds. | Without a push, a 24-hour card made on a Friday expires unseen. |
| The continuation | `startRun` with `approval: {run, decisions}` and a message Laravel writes. The engine carries out each approved call itself, before the submit. | The model never sends the call again. |
| The one-time grant | No grant. The continuation's snapshot holds the decided calls, and each runs once through a pass that the start's final write consumes. | A grant the model could use would let it change the arguments or loop. |
| A new message | It closes the waiting cards, in the write that commits its prompt (owner question 5). | The open holds then always belong to the conversation's latest run. |
| Notifications | Not needed to ship. The conversation list's marker, the tab's title and a dot on the phone's menu button are in this plan. Mail, push and the reminder come with "Notify when a run ends or waits" (owner question 7). | The card arrives in a chat its user usually watches. |
| Rollback | Once chunk 2 runs on an instance, its engine is never rolled back below it. Reverting the app's chunk 5 turns every ask into `APPROVAL_UNAVAILABLE`. | Chunk 2 reads asks and fails closed, so no older reader ever sees one. |

## Data shapes

### Grants and the policy

- **`GrantInput.effect`** gains `ask` (`contract/src/internal/engine.ts:27`). An ask row allows its actions, with the user's confirmation.
- **`LayerSnapshot`** gains `asks: GrantKey[]`. `fromJson` reads a missing `asks` as empty, so snapshots stored before the deploy keep working. Every other key stays required.
- **The compile.** An ask row always compiles to ask keys, as a deny row always applies. Where `enforceable` would admit an allow (`gateway/grants.ts:74-80`), it also compiles to allow keys, which is how an ask row passes a restricted layer. An ask on an action that is not askable compiles as a deny.
- **The effect of one layer**, for one action on one resource:
  1. deny when a deny matches, as today, the `partial` rule included;
  2. otherwise, when the layer passes (it is unrestricted, or an allow key matches), the nearest grant among its allow and ask keys decides: the resource itself, then its ancestors nearest first, then `*`. At one resource an ask beats an allow. With neither matching, an unrestricted layer allows;
  3. otherwise deny. So an ask the connector cannot enforce asks in an unrestricted layer and denies in a restricted one;
  4. a `partial` chain asks, instead of taking an allow from `*` or from an unrestricted layer, when the layer holds an exact ask for the kind and action, as an exact deny blocks such a chain.
- **The call's effect** is the worst over the layers, the `requires` chain and every requirement `prepare` returns. A new `effect()` gives `deny`, `ask` or `allow` and the layers that asked, and `#authorize` uses it. `permits` stays boolean, true for ask or allow, and only decides which records a result shows, so an approved send's records come back. `permitsAny`, which picks the tools offered, counts ask as allow. A string effect is never tested for truth: TypeScript would not catch `'deny'` passing.
- **`COMPILER_VERSION`** becomes `4`.
- **Askable actions.** An action is askable when no operation without `mutates` needs it, directly or through `requires`. A connector therefore cannot mark askable an action a read needs. Run against today's catalog on 2026-10-25, this gives every write action and never `read`. Gmail's `send` and `draft`, Slack's `post` and `reply`, Stripe's `refund` and `credit` and Xero's two drafts are askable; Sentry's and the web connector's actions are not. `checkChanges` applies the rule from chunk 2. The catalog's `CatalogAction` gains an optional `askable` only in chunk 4 (Contract, facts and deploy order).
- **`checkGrantEdit`'s `changes[]`** gains an optional `ask`, a subset of `actions`. `checkChanges` refuses an ask on an action that is not askable. The engine edits this connection's allow and ask rows, and plans ask rows for the asked actions and allow rows for the rest. Deny rows still pass through untouched.

### Holds, in the engine

- **`run_holds`**, one of a run's records (`conversation/store.ts:177-187`), so retention deletes it with the run. One row per held call:
  - run, position (1 to 10) and write key, unique per run;
  - the user, connection, provider, operation, fingerprint and label (`Gmail: Send mail`);
  - the validated fields as canonical JSON, at most 1.5 MiB, which holds the largest valid input of every askable operation unless its text is mostly characters JSON escapes. A larger call is refused `APPROVAL_TOO_LARGE`;
  - `requirements`: every resource and action `prepare` named, each with its effect (ask or allow), the layers that asked, and the provider's name for it from the connector's `describe`, or the id alone when `describe` fails or leaves it out;
  - the created time, and the state: `open`, `used` by a run, or `closed` by a run;
  - for a used hold, the write key it was carried out under and its outcome: `ran` (with its result cut to 4,000 characters), `failed` (with the message), `not_run` (with the reason) or `unknown`.
- **`runs.writes_closed`**, set when a write was refused `APPROVAL_PENDING`, so a restart keeps the order. **`runs.attended`**, from the start.
- **Two run-state ports** beside `dispatchWrite` (`cloudflare/src/gateway/run-state.ts:21-38`; `conversation/ports.ts:259-265`), synchronous and answered after `outside`'s wait, as it is:
  - `heldCall(run, key)`: the hold for this key, if any;
  - `holdCall(fence, hold)`: inserts the hold and appends its `run.held_call` fact in one write, in the same synchronous stretch as the fence check. It refuses `WRITE_UNCERTAIN` with the ledger's paused message while the run's writes are paused (`gateway/ledger.ts:174-176`, `:191`). It refuses `APPROVAL_PENDING` when the run's writes are closed, and when the run already holds 10 calls, which closes them.
- **`dispatchWrite`** refuses `APPROVAL_PENDING` while the run holds a call, and closes its writes in the same stretch. This is the ledger's existing pause with a second reason (`gateway/ledger.ts:1-8`).
- **`WriteNote`** gains an optional `approved: {run, position}`. The settlement's transaction (`store.ts:1331-1335`) then records the hold's outcome beside `run.write`, so a write that settles after a cancel, or that the gate marks uncertain after a restart, still sets it.

### The start's inputs

- **`startRun.attended?: true`.** Laravel sends it on every start a person made: a message, a continuation, `minerva:turn`. The engine stores it on the run. Without it, an ask answers `APPROVAL_UNAVAILABLE` and holds nothing.
- **`startRun.approval?: {run, decisions: [{position, approve}]}`.** It names the held run and decides every open hold of it, each once. The message is Laravel's ("Approved.", "Declined.", "Approved 2, declined 1."), so `EMPTY_MESSAGE` is unchanged.
- **Two refusals**, stored as the start's answer like the others before the preparation:
  - `APPROVAL_UNKNOWN`: a run this conversation does not hold, a hold of another user or of a run that was not attended, or not exactly the run's open holds;
  - `APPROVAL_DECIDED`: a hold already used or closed.
- **The snapshot** gains `attended`, `approval` (the decided holds copied whole, so its digest covers them and the held run's prune cannot reach them) and `closed` (the holds this start closed, for the note).

### Facts

- **`run.held_call`**, a new fact: the position, tool, label, connection, operation, `requirements` with the kinds' and actions' labels and the providers' names, the fields' JSON whole as a string, and `write`, the keyed hash `run.write` already uses. It is appended in the hold's own write.
- **`run.tool_call`**: the refused branch gains an optional `write` for `APPROVAL_REQUIRED`, the same hash as the hold's, so the chat ties each row to its card. Both branches gain an optional `approved: {run, position}` on a call the continuation carried out or refused.
- **`run.write`** gains an optional `approved: {run, position}`, from the `WriteNote`.
- **Codes, not enum values.** A held call's `tool_call` event and fact are `denied` with the code `APPROVAL_REQUIRED`. `APPROVAL_PENDING`, `APPROVAL_TOO_LARGE`, `APPROVAL_UNAVAILABLE` and `APPROVAL_STALE` are `denied` too (`gateway/results.ts:73`). `decision` keeps its three values and `code` is a free string, so Laravel's contract copy and today's pages read them.

### Laravel's tables

- **`call_approvals`**, one row per held call, named so it is not confused with the app's connector approvals:
  - id, conversation (cascade), held run (cascade), position, unique per run;
  - user (null on account deletion), connection id (no foreign key that could refuse the insert), tool, label, `requirements` (jsonb), arguments (text), `write`;
  - state: `waiting`, `approved`, `declined` or `closed`, with a CHECK, and the run that closed it;
  - created time (the fact's), decision time, and the continuation run;
  - outcome, from the continuation's facts: `done`, `failed`, `uncertain` or `not_done`, with its message.
- **Derived, not stored.** A waiting row past its expiry reads Expired, and so does a closed row that was closed after its expiry.
- **It joins** every table that holds a conversation's data, the purge and `ForeignKeysTest` (the app's `docs/architecture/retention.md`, Every table that holds a conversation's data).
- **A continuation's message** is a user message whose run is a continuation in `call_approvals`. The transcript's page count, search and the conversation's title skip it.

## The flow

1. **Hold.** The executor runs as today through the lease, consent and `prepare` (`gateway/executor.ts:576-599`). `#authorize` decides after its loop: deny first, then the tenants, then ask. On ask, the executor names the requirements with `describe`, one provider read on the call's own client, then calls `holdCall`. Only after that write does the model get its answer, as a refusal recorded through `#invoke` like any other, with the hold's `write` (`conversation.ts:1393-1430`). Nothing is claimed in the ledger. A call from `run_script` is held the same way, and a script that catches the refusal and writes again is refused `APPROVAL_PENDING`.
2. **Repeat.** Beside the known-write check (`executor.ts:541-550`), before the lease, a call whose key is held answers `APPROVAL_REQUIRED` again with no new hold, and any write after the run's writes closed answers `APPROVAL_PENDING`. This also covers pi repeating an unsafe call cut by a restart.
3. **The held run ends** as any run does, usually with the model's own message, `completed`. Run statuses, the history gate and the stream are unchanged. Its holds stay open however it ended.
4. **Card.** Laravel applies `run.held_call` as a waiting approval. Facts arrive in order, so it is there before the run's `run.finished`. Its buttons stay disabled until the run has ended.
5. **Decision.** The user picks Approve or Decline for each call on the card. One POST to `w/{workspace}/c/{conversation}/approvals`, behind `throttle:starts`, carries every decision of the held run.
   - Inside `Runs::start`'s transaction, Laravel locks the run's approvals and does nothing unless each is waiting, unexpired and the user's. A double click or a second tab changes nothing.
   - It records the decisions and their audit events, writes the message, and registers the continuation, `attended`, through every check a start passes: admission, seats, budget, an unshared agent, start limits, one active run, storage. A refusal there rolls all of it back, and the card says why.
   - An engine refusal, or a cancel the engine acknowledges `tombstoned` for any reason (`start_expired`, a revocation, the emergency stop), puts the approvals back to waiting. The card says "Not sent: <reason>" and offers Approve again. While fast-starts' `held` prop names the continuation, the card's buttons are disabled. A cancel acknowledged `cancelled` or `ended` means the engine took the start: the decisions stand, and the outcome comes from the facts.
   - `APPROVAL_UNKNOWN` and `APPROVAL_DECIDED` close the approvals instead and log an error, since Laravel's state then disagrees with the engine's.
6. **Acceptance.** The engine checks the approval with the refusals before the preparation, and again in the start's final write, which stores the run and its acceptance. That write marks the holds used by the new run, so each is used once. The same run id gets its stored answer. Any other run naming them gets `APPROVAL_DECIDED`. A start without an approval closes the open holds in the write that commits its prompt: the copy's commit (fast-starts.md), or the acceptance when it has no files. A message that ends before its copy commits, which Laravel shows as Not sent, therefore leaves the holds open, and Laravel reopens their cards by the same rule that fails the message. Until then the conversation is busy, so no approval can race it.
7. **Carry out.** In the start section, after the settle and the fence check and before the note and the submit (`conversation.ts:585-621`), the engine takes each approved hold in order, under the phase "Using tools". A hold that already has an outcome is skipped, so a section that runs again after a restart computes the same note.
   - No tool in the new snapshot for its connection and operation: "not available any more", recorded as an `APPROVAL_STALE` row with `approved`.
   - A different fingerprint: "changed since the user approved it", recorded the same way.
   - Otherwise the call goes through `#invoke` under the run's fence (`conversation.ts:1376`), not through `ToolHost.current`, whose admission needs a placed submission. It uses the continuation's declaration for that connection and operation, so the write key, the label and the row carry the continuation's alias. The hold stores that key first. The call is leased, prepared, checked against the new grants and recorded like any call, with `approved` on its `tool_call` and on its `WriteNote`.
   - The hold is its pass. The call runs only when `prepare` names the same resources and actions the hold stored, and none of them is denied. A different list is "changed". An ask over the same list passes, since the user saw every destination. A deny is `POLICY_DENIED`.
   - An approved call that does not succeed stops the approved calls after it, whose outcome is `not_run`.
   - `#invoke` stops waiting at the run's end (`conversation.ts:1387-1390`), so a Stop during a slow write frees the section while the write settles. Its settlement still records the outcome on the hold and on `run.write`.
8. **The note.** Each outcome becomes a line before the prompt, beside the note after a stopped turn (`conversation/history.ts`, `turnNote`), with results cut to 4,000 characters. When the held run did not complete, its end note comes first, then "The user has since answered the actions you asked to approve:" and the lines. For an earlier run that never submitted, `#turnNote` reads its holds' outcomes, and the holds it closed, instead of quoting its "Approved." as an unseen message. A used hold with no outcome is answered from the ledger's record of its stored key: applied is ran, uncertain or still dispatched is unknown, and none is did not run. Then the section submits once.

### What the model reads

- `APPROVAL_REQUIRED`: "Minerva asked the user to approve this. It has not run. Do not call it again or try another way. Finish your turn by saying what waits for approval. The user approves or declines it with the buttons Minerva shows in the chat, so do not ask them to reply yes or no. The outcome comes in the next turn."
- `APPROVAL_PENDING`: "An earlier action waits for the user's approval. Make no more changes in this turn."
- `APPROVAL_TOO_LARGE`: "This action is too large to show the user for approval. Split it into smaller ones."
- `APPROVAL_UNAVAILABLE`: "This needs the user's approval, which nobody can give in this run. Do not retry. Say what you would do."
- The note's lines:
  - "[You asked to Gmail: Send mail. The user approved it, and it ran: …]"
  - "[You asked to Gmail: Send mail. The user approved it, but it failed: …. The approved actions after it did not run.]"
  - "[The user declined Gmail: Send mail. It did not run. Do not try it again unless they ask.]"
  - "[Gmail: Send mail, which you asked for, was not approved and did not run.]" for a closed hold;
  - one line each for not available, changed, approved but not run because the turn was stopped first, and an unknown outcome ("Check before trying again.").

### The gate change

When `#gate` decides `none` today, it returns before marking a dead instance's dispatched writes uncertain (`conversation.ts:735`, `:743`). That was harmless while no write could happen before a run's submission. The carry-out writes before it, so the gate marks the acting run's dispatched writes uncertain whatever it decides. A new instance can never settle them.

## Failure cases

- **A restart before the model hears of the hold.** The hold is stored first. pi answers the cut call as interrupted, the model may call again, and the repeat answers `APPROVAL_REQUIRED` with no second hold or fact.
- **A crash during an approved write.** The run has not submitted, so the gate decides `none`, marks the write uncertain, which records the hold's outcome as unknown, and the watch starts the section again (`conversation.ts:772`). The section skips the decided hold, and the note says the outcome is unknown.
- **A Stop during the carry-out.** The sent write settles, and its settlement records the hold's outcome and `run.write` with `approved`, so the card reads by it. The next run's note says what ran, rather than quoting "Approved.".
- **Replay.** A hold is used once, in the start's final write. pi never holds a pass, and if the model asks for the approved call again in the continuation, the ledger answers it from the record (`ledger.ts:99-107`), since the call was keyed under the continuation's alias.
- **Revocation and removal.** Grant edits cancel only active runs (the app's `app/Runs/Revocations.php:251`), and a held run usually has ended. So the check that matters is the continuation compiling the current grants. A cancel while the continuation runs is strict revocation as today: the executor checks before each request.
- **A deploy that changes the tool.** Its fingerprint differs, and the note and the card say it changed.
- **An expired card.** Laravel refuses the POST, "This approval expired." The engine's holds stay open until the next accepted start closes them.
- **Laravel sends a call it invented.** It cannot: the engine runs only calls its own run held, under the user that run had.

## Contract, facts and deploy order

The contract gains `effect: 'ask'`, `changes[].ask`, `CatalogAction.askable`, `startRun.attended`, `startRun.approval` with its two refusals, the five tool codes, `run.held_call`, `write` and `approved` on `run.tool_call`, and `approved` on `run.write`, and the OpenAPI documents are regenerated. contract.md's Versions lists a new optional input, a new output field and a new kind of fact, but not a new value of an enum the receiver validates. This plan adds that line: "A new value of an enum the receiver validates: the receiving side first."

| Change | Kind | Deployed first |
|---|---|---|
| `run.held_call` | A new kind of fact | Laravel (chunk 1) |
| `write` and `approved` on `run.tool_call`, `approved` on `run.write` | New optional output fields | Either. Laravel reads them from chunk 1 |
| `effect: 'ask'` in `startRun` and `checkGrantEdit`'s layer | A new enum value the engine validates | The engine (chunk 2): an older zod enum refuses it |
| `changes[].ask` | A new optional input | The engine (chunk 2): an older engine strips it and plans allow rows, which would widen access |
| `effect: 'ask'` in `checkGrantEdit`'s answer | A new enum value Laravel validates | Laravel (chunk 1's `withinContract`) |
| `startRun.attended`, `startRun.approval` and its refusals | New optional inputs | The engine (chunks 3 and 4): an older one strips them |
| `CatalogAction.askable` | A new optional output field | The engine (chunk 4). Laravel reads it from chunk 5 |

Deploys of the engine's staging and production, and the app's production, ask the owner first (AGENTS.md, Cloudflare).

1. **Chunk 1, Laravel.** The contract commit lands in the harness, then the app syncs it and deploys to staging. Harmless, since no engine sends the fact yet.
2. **Chunk 2, the engine, on its own,** to the test instance and then, with the owner's go, to staging and production. No layer can ask yet, so it changes nothing users see. From then on, an instance's engine is never rolled back below chunk 2, a rule cloudflare/README.md's rollback paragraph gains beside the two it has.
3. **Chunks 3 and 4, the engine,** to the test instance, then with the owner's go to staging and production. They hold nothing until Laravel sends `attended`.
4. **Chunk 5, Laravel,** pushed to the app's `main` once staging's engine runs chunk 4, then deployed to staging. The app's production deploys `main`'s head, so it may get chunk 5 at any time after that.
5. **The catalog.** On each environment, once its engine runs chunk 4, the operator runs `minerva:catalog` and approves the changed entries, which gained `askable`. Until then no approved entry says askable, so the editor offers no Ask first, no ask row can be written, and no card can appear. This step is the gate, so an app ahead of its engine is safe.

### Rollback

1. Chunk 5 is reverted in the app. No new card can be answered and no ask can be written. Laravel stops sending `attended`, so every ask answers `APPROVAL_UNAVAILABLE`. Ask rows stay, and chunk 1 still reads them.
2. The engine is rolled back, if at all, no further than chunk 2, and below chunk 4 only after step 1.

No command rewrites ask rows, and no emergency stop is needed: every engine from chunk 2 on reads an ask and fails closed.

## Laravel's side

### The data and the start

- **Facts.** `applyFact`'s table gains rows:

  | Fact | Live | Deleted | Lost | Gone |
  |---|---|---|---|---|
  | `run.held_call` | Inserts the approval if absent, so a replay never resets a decided row | Nothing | Nothing | Nothing |
  | `run.tool_call` with `approved` | The approval's outcome, unless a `run.write` set it | Nothing more | Nothing more | Nothing |
  | `run.write` with `approved` | `write_records` as today, and the approval's outcome | `write_records` | `write_records` | `write_records` |

- **Starts.** `Runs::start` gains an optional approval, and every start a person makes sends `attended`. With an approval, it locks and checks the run's approvals as in step 5 of the flow. Without one, it closes the conversation's waiting approvals in the same transaction, naming the new run. Those go back to waiting when that start is refused, its cancel is acknowledged `tombstoned`, or it ends before its copy commits (`Facts::finished`, fast-starts.md, The copy's failure in the registry). A continuation's message gets no retry payload and no Send again.
- **Grants.** `withinContract` accepts `ask`, in what Laravel sends and in what `checkGrantEdit` answers. `Access::view` returns each grant's effect instead of folding asks into `denied`. `Access::kept` treats ask rows on this connection as the engine's to plan. `Consent::allowed` counts ask rows, since an ask needs the same scopes as an allow. `AccessController::update` validates and passes `ask`. `Access::edit` admits ask rows, and allow rows below an ask, on an unrestricted layer. `App\Engine\Catalog\Connector`'s actions gain `askable`, and the third state is offered only where the approved entry says askable.
- **Audit.** `AuditAction` gains `call_approval.approved` and `call_approval.declined`, one event per call. Each holds the approval's id, the run, the continuation, `write`, the provider, the operation and the asked action ids, such as `gmail`, `send_message` and `send`. Never the arguments, the recipients, the names or the label (the app's `docs/architecture/retention.md`, The audit log). A grant edit to ask is audited as any grant edit is.
- **`minerva:turn`** gains `--approve` and `--decline`, so the agent can drive staging's live checks through Laravel. Its decisions are audited with the console as the actor, and turn.md says the options are for staging checks.
- **Routes.** The POST above, and `GET w/{workspace}/c/{conversation}/approvals/{approval}` for a call's whole fields, behind the transcript's locks and `throttle:resources`.

### What the user sees

- **The card**, in the held call's place in the thread (the app's `resources/js/components/chat/thread.tsx:475`).
  - While the run streams, the held call shows as a row, "Asks for your approval when the agent finishes", from its `APPROVAL_REQUIRED` event. Once the run ends and the page reloads its props, the first row with the hold's `write` becomes the card, and a later row with it reads "asked again". A card whose row the transcript's 200-event cap hides shows at the run's end.
  - Per call: its label; then every destination, from the stored requirements, external ones first, each with the provider's name beside its id and the ones that asked marked: to, cc and bcc, a reply's resolved recipients, the channel, the customer and the amount; then every field. A long field shows its start and its full length, with Show all, which loads it from the route above. Bidirectional and zero-width characters are shown visibly.
  - Why it asks: "You asked to approve this first", "Your organization asks first", or "This agent asks first". Change access, which opens the editor at that connection, shows only when the user's own layer asked.
  - Decisions: Approve or Decline on each call marks a choice, and Continue sends once every call has one. Decline all is always there. Approve all, labelled with the count, shows only when every held call goes to the same destinations. "Asked 3 h ago", "Expires in 6 days".
  - Once answered: Done, Failed, Outcome unknown (check the provider), Not done with its reason ("Gmail is no longer connected", "this action changed since you approved it", "stopped before it ran"), Running, Declined, Expired, or Dismissed (closed by a new message).
  - Props carry each field cut to 2,000 characters, with its length, waiting cards and answered ones alike, so a conversation's reloads stay small.
- **The summary above the composer**, while any card of the conversation waits: how many actions wait, their labels and destinations, Approve all where it applies, Decline all, and Review, which scrolls to the card. Beside it: "Sending a message dismisses the waiting approval."
- **The decision line.** The continuation's message shows as a line, not a bubble ("You approved Gmail: Send mail."), then the carried call's row and the answer.
- **Waiting elsewhere.** The conversation list marks a conversation with a waiting card "Waiting for you". The tab's title starts "(1) Waiting" while a card waits. Below `md`, the top bar's menu button shows a dot while any conversation waits (the app's `docs/architecture/shell.md`, The shell).
- **The editor.**
  - An askable action gets Off, Ask first and Allowed in a restricted layer. On an unrestricted ceiling or agent layer it gets "As members allow" and Ask first, and a narrower row under an ask may pick "No need to ask", an allow row. A read action keeps its checkbox.
  - Under a parent or `*` that allows or asks, a row may pick Allowed or Ask first, but not Off, since the editor writes no denies.
  - Setting a parent or `*` to Ask first lists the narrower allows that will not ask, with "Ask for these too".
  - `toggle` counts Ask first as on for `requires` (the app's `access.ts:53-82`), so asking to send turns on reading.
  - The ceiling's and an agent's Ask first say: "Each member confirms their own agent's calls in the chat. Nobody else is asked." Members see "Your organization asks first", which they cannot change in their layer.

## Tests

### The engine

- **Unit** (`cloudflare/test/unit/`):
  - `policy.test.ts`: each effect, ancestors, the nearest rule, `partial` chains, a ceiling ask over a user allow, a deny over an ask, an unenforceable ask in a restricted layer (deny) and an unrestricted one (ask), `permits` true under an ask, `permitsAny` with asks, an old snapshot without `asks`, and the seed-7 reference model with asks added;
  - `grants.test.ts`: the compile of ask rows, unenforceable ask rows, a non-askable ask as a deny, and `checkChanges`;
  - `tools.test.ts` (tools offered under ask, the pinned layer order) and `internal-catalog.test.ts` (`askable` derived);
  - `executor-calls.test.ts`: a hold claims nothing and leases once; its requirements and names; a repeat makes no new hold and no lease; the eleventh hold; a non-asking write after a hold closes writes; reads go on; a too-large call; a deny beats an ask; the tenant check before ask; an uncertain write then an asking write holds nothing; without `attended`, `APPROVAL_UNAVAILABLE`; a scripted held call, then a scripted write answering `APPROVAL_PENDING`; an approved send's records come back;
  - `executor-faults.test.ts` and `ledger-writes.test.ts`: `dispatchWrite` refusing while the run holds a call; a settlement with `approved` recording the hold's outcome, after a cancel too;
  - `internal-start.test.ts`: the approval's validation, both refusals, `attended`, the digest;
  - `conversation-gate.test.ts`: dispatched writes marked uncertain on `none`;
  - `conversation-history.test.ts`: the note's lines, after a held run that did not complete, and for an earlier continuation that never submitted;
  - `facts.test.ts` and `conversation-tools.test.ts`: `run.held_call` whole, the refused row's `write`, the codes rendered as `denied`.
- **Platform** (`cloudflare/test/platform/`):
  - `protocols.test.ts`: a run with holds completes; holds after a Stop, an empty answer that fails the run and a revocation stay answerable; approve carries a call out once; decline; mixed; a failure stops the rest; a plain start closes the holds and its note says so; a plain start that ends before its copy commits leaves them open; a revocation, a removed connection that renumbers the held one, a changed fingerprint, and a target that moved to an allowed resource between hold and approval, after which nothing runs; a Stop during the carry-out, after which the next note says what ran; the same continuation sent twice; another run naming used holds;
  - `internal-runs.test.ts`, `internal-connections.test.ts` (`checkGrantEdit` with `ask`), `faults-laravel.test.ts` (the fake Laravel applies the new fact) and `retention.test.ts` (holds go with the run's records).
- **Fault points** (`cloudflare/src/faults/ports.ts`): `approval:held`, after the hold's write and before the model hears; `approval:carried`, after each approved call settles and before the next one or the submit. With them, `provider:write:applied` (`abort`, `lose`) during the carry-out: the provider has one write, or the note says the outcome is unknown.
- **Account** (`cloudflare/test/account/faults.test.ts`, `turns.test.ts`): the Notes connector's `save_note` under ask, held, approved and declined, on the test instance. `turns.test.ts` gains a Workers AI turn, and with `MINERVA_LIVE_ROUTE` one on the instance's own route: under a Notes ask layer, the held run makes exactly one hold, no other write, and its answer neither claims the note was saved nor asks for a typed yes. ARCHITECTURE.md's Testing table gains a row.

### Laravel

- **Pest, Feature:** `Runs/FactsTest` (the scenario, and `run.held_call` for each target), `Conversations/ChatTest` (props, the card, a card past the event cap, continuation messages skipped by paging), a new `Runs/CallApprovalsTest` (approve, decline, mixed, an incomplete set, expired, another user's card is a 404, a refused and a tombstoned continuation back to waiting, one acknowledged `cancelled` keeping its decisions, `APPROVAL_DECIDED` closing, a new message closing and reopening on its refusal or a copy failure, held runs that were cancelled, failed or timed out), `Connections/ConsentTest`, `AccessTest` (an ask saved through the controller on an unrestricted ceiling) and `LayersTest`, `Audit/AuditLogTest` (the descriptors, the console actor), `Organizations/IsolationTest` (the new routes), `ForeignKeysTest` and the purge, and the catalog mapping test with `askable`.
- **Pest, Concurrency:** two processes approving the same run start one run (beside `tests/Concurrency/RunLocksTest.php`).
- **Vitest:** `model.test.ts` (the card's place, its states and the decision line), `access.test.ts` (`toggle` with Ask first).
- **The verify skill:** no engine runs locally, so its chat journey gets a seeded conversation whose facts hold a waiting card, and a stand-in engine that answers the continuation's `startRun`, as `scripts/catalog-engine.ts` answers the catalog.

## Docs to update once built

- **ARCHITECTURE.md:** Permissions (the formula, the three effects, the pipeline, the Writes bullet), Starting a run (`attended`, the approval and its use in the final write, holds closed at the copy's commit), Strict revocation (a held run has ended; the continuation compiles), The harness (the approval note beside the note after a stopped turn, and in Admission by run that the start section's carry-out is the one caller of the executor outside `admitTool`, relying on the fence), Attempts and recovery (the gate), Writes (holds, the second pause, outcomes on the hold), Facts, Testing. Whatever this plan leaves under Accepted, not fixed moves into the matching section's own list.
- **cloudflare/README.md:** the rollback floor at chunk 2, and the catalog approval after chunk 4's deploy.
- **docs/connectors.md,** Permissions: the third state, which actions are askable, and that asks do not limit what an agent can carry out through sites it may read.
- **docs/data-processing.md:** a held call's fields in the Conversation object's `run_holds` and in Laravel's `call_approvals`.
- **docs/plans/contract.md:** `startRun`, `checkGrantEdit`, the facts table, the catalog, and the enum line in Versions.
- **docs/plans/after-the-plan.md,** Appendix D: what later work inherits, below.
- **Code comments:** `gateway/policy.ts:1-3` and `:23-28`, and the pipeline at `gateway/executor.ts:1-7` and `:114-128`.
- **The app's `docs/architecture/`:** `grants.md` (the third effect, the editor, unrestricted layers, consent), `conversations.md` (the card, the summary, props, the markers), `turn.md` (the fact in the apply table, the continuation's start, `minerva:turn`'s options), `connectors.md` (the catalog step), `retention.md` (the table and the audit actions), and a new `call-approvals.md`.

## What later work inherits

- **Notifications** ("Notify when a run ends or waits"). A push and a mail that open the conversation, never one that approves, the 4-hour reminder, and the 24-hour expiry, all read from `call_approvals`.
- **Routines and inbound email.** Their starts carry no `attended`, so an ask answers `APPROVAL_UNAVAILABLE` and holds nothing. after-the-plan.md's Appendix D has them start conversations of their own, so they never close a user's cards. A start in a user's conversation would need an input that leaves the open holds alone, and the approval checks would then have to accept open holds of a run older than the latest.
- **Vendors' MCP tools.** A tool is an operation and its pinned schema hash is its fingerprint. A tool can ask when Minerva's own classification says it writes, never because of `readOnlyHint` or its name. A tool Minerva has not classified counts as a write and starts on Ask first.
- **API-key connections** reuse grants and holds unchanged.
- **Approval by someone else** (owner question 2). Each hold records the layers that asked, so a later rule can require another approver for a ceiling's ask without changing the hold's shape.
- **A live browser, later.** Its hand-off is a hold like any other, carried out by the engine, never replayed.

## Risks

- **The model may not stop** at `APPROVAL_REQUIRED`, or may claim it sent the mail. Later writes are refused, and the card shows what is true. How often it happens on production's model is unknown, so `turns.test.ts` checks the held run's answer on Workers AI and on the instance's route, nightly.
- **Asks are not an exfiltration control.** A run whose mail is held can still read any site it may read, with data in the address (`connectors/web/connector.ts:4-6`), and search sends its query to the search provider. The sites list is that control (owner question 9).
- **Approval fatigue.** A user who approves every card stops reading them. Nothing defaults to Ask first (owner question 8), so asks are where someone chose them. Approve all is offered only over calls with the same destinations.
- **Injected text on the card.** The fields came from the model, which may have read an injected page. The card shows the destinations the engine itself resolved first, with the provider's names, and shows invisible characters.
- **Fact delivery lag.** The card appears once the fact reaches Laravel and the page reloads. Facts usually arrive within seconds (inferred).

## Accepted, not fixed

- **An approved call's `prepare` runs again** in the continuation, one more provider read, and `describe` adds one at the hold.
- **A `prepare` that crashes the object every time loops the start,** since the gate counts no attempt before a submission. It needs a deterministic crash. Stop ends it, and so does the run's deadline when one is set.
- **The model learns that a card expired** only at the next message. Nothing ran.
- **A restart between an approved call refused before the ledger and its outcome's write** runs that call again, since no outcome was stored. It needs a reset in the milliseconds between them. Nothing was written the first time, and the card shows a second refused row.
- **A rollback while a continuation's start is in flight** lets an older engine strip `approval` and run a plain turn on "Approved.". It needs a rollback within that start's seconds, after chunk 5 was reverted. Nothing is carried out, and the card reads Not done.
- **Validating the stored fields again must give them back unchanged.** Today's transforms normalize (`gmail/writes.ts:37-43`), so they do. A later transform that does not, deployed without changing the fingerprint, would run something other than what the card showed.
- **Laravel alone enforces expiry.** A Laravel bug that skips the check lets a call held up to 30 days ago run, until retention prunes the held run.
- **The approve controls have no anti-framing header.** Session cookies are `SameSite=lax` (the app's `config/session.php:202`), so a cross-site frame is signed out. It needs a same-site attacker or that setting changed, and then one click in a frame approves a call.
- **Laravel does not check that `checkGrantEdit`'s answer kept each ask it sent.** It needs Laravel's chunk 5 against an engine below chunk 2, which the deploy order and the rollback floor rule out. An older engine would strip `ask` and plan allow rows, widening that edit.

## Dropped in review

- **A slow approved write holds the start's lane after a Stop.** `#invoke`'s wait already ends at the run's end (`conversation.ts:1387-1390`; `executor.ts:463`), and the write settles under `waitUntil`.
- **Drop `write` from `run.held_call`.** It ties the held run's rows to their card. The continuation's write is tied by `approved` instead.
- **Laravel derives askability from the approved entry's operations.** Laravel never evaluates grants (the app's `docs/architecture/grants.md:20`), and the engine's `checkChanges` would still have to agree, so the engine's `askable` is read instead.

## Owner questions

1. **A specific allow under a broader ask, in one layer.** With the nearest rule, "allow firm.example, ask first for everyone" lets colleagues through and asks for the rest. Strictest-wins, as denies work, would ask for colleagues too, and that rule could not be said. A ceiling's or agent's ask is never lifted either way. The nearest rule's cost: specific allows written earlier silently skip a later Ask first on their parent, which the editor lists when the ask is set. Default: the nearest rule.
2. **May an admin approve members' calls**, as a four-eyes rule? It needs a new surface and shows the member's chat to the admin. Without it, a ceiling's Ask first slows the model down but is confirmed by the member it covers. A yes would also make an ask that another layer adds over an approved call need its own approver, which the layers each hold records allow. Answer before chunk 5 is built. Default: no, and the ceiling's and agents' editors say who confirms.
3. **"Always allow this" on the card**, writing the user's own allow? It cannot lift a ceiling's or agent's ask, so it would sometimes do nothing visible. Default: no, Change access opens the editor.
4. **Does an answer of declines only start a continuation,** at one model call, so the model can finish the task another way? Default: yes.
5. **Does a new message dismiss waiting cards?** The reference's study listed "cards that any later turn can close" as a thing not to copy. Here only the user's own message closes them, the summary above the composer says so beside its buttons, and runs nobody watches never close one. Its cost: a user who types "yes" instead of clicking dismisses the card, and gets another model turn, another card and another click. The model is told not to ask for a typed yes. The alternative locks the composer until each card is answered. Default: a new message dismisses them.
6. **10 held calls per run, and 7 days to answer** until notifications exist, then 24 hours with a reminder at 4? Default: yes.
7. **Notifications.** The reference's study ordered "Notify when a run ends or waits" right after this plan, and the reference pushes the moment a turn waits. This plan works without it, with the list's marker, the tab's title and the phone's menu dot, and a 7-day expiry. Default: ship this first, and mail, push and the reminder next.
8. **The editor's default** when a user turns on a write action. Default: Allowed, as today, with Ask first one click away.
9. **Web reads while a call waits.** A held run can still read allowed sites, with data in the address. Count web `read` as askable as an exception, refuse every web call once a run holds one, or say in docs/connectors.md that the sites list is the control. Default: the last.
10. **An admin's ask on members' personal connections.** The ceiling covers shared connections, and restricting it blocks personal ones. A rule per app ("every Gmail asks first to send") would need a new kind of ceiling row. Default: not in this plan, and later if pilots ask.

## How this design was chosen

Two readers mapped the engine and the app. Two designs followed: a minimal one, and one built around what the user sees. A merge took the second as its base: several holds per run, an approved call's pass limited to what the user saw, non-askable asks compiled as denies and a new message closing the cards. It took from the first the message Laravel writes, expiry in Laravel only, two refusal codes and `APPROVAL_UNAVAILABLE`. Checked against the code, the draft then changed the merge in five places: the nearest rule; `APPROVAL_PENDING` through `dispatchWrite`, the ledger's existing pause; the carry-out through `#invoke` under the fence, since `ToolHost.current` admits only calls from a placed submission; the held call's `tool_call` kept as `denied` with a new code; and the table named `call_approvals`. The review then made holds depend on an attended start, stored every requirement for the card and the pass, stored outcomes on the holds, moved the closing of holds to the copy's commit, and replaced the rollback command with a floor.

## Alternatives rejected

- **The model calls again under a one-time grant on its write key** (the starting sketch). The key names an alias that can mean another connection in a later run. The model may change the arguments, loop on new asks or never call. It costs a model call, and the ledger dedupes only within a run.
- **Ending the run at the first ask.** pi's `terminate` needs every call of the round (`generation.js:503-505`). `#complete` fails an empty answer (`conversation.ts:956-961`). An end from the engine would give the next run the "stopped" note.
- **One hold per run, refusing every later call.** Three emails would take three cards and three continuations.
- **A cap of 3 holds per operation.** Three mails to three people is the common case, and the per-call choice with Approve all only over the same destinations already makes each one read.
- **Closing the holds of a run that did not complete.** The user acts on the card on purpose, and the continuation checks the current grants anyway.
- **A `waiting` run status.** It changes Laravel's `RunStatus`, its CHECK, the stream and `history()`.
- **Laravel sending the call's fields back in `startRun`.** The engine would then run whatever Laravel sends under the user's grants.
- **Ask on reads.** Enumerating reads decide which tools are offered, and a read has nothing to confirm.
- **Expiry in the engine.** Laravel decides, and retention already bounds a hold.
- **A rollback command that turns asks into denies, behind the emergency stop.** The floor at chunk 2 makes every engine that might run read an ask safely.
- **A loop guard like the reference's.** A repeat of a held call makes no new hold, and other loops are outside this plan.

## Verification

- The citations above were read at the heads named in the status line.
- The askable rule was run on today's catalog on 2026-10-25, with a script outside the repository that imports `cloudflare/src/connectors/catalog.ts`. Every write action came out askable, and no `read`. opencode ran it again and got the same answer.
- The merge cited `generation.js:436` and `:482` for the round's sequential rule and for `terminate`. Both are at `:457-458` and `:503-505`.

---

# Build checklist

## How to read this

As in [after-the-plan.md](after-the-plan.md): one box is one unit of work, and a box is checked only when its evidence exists. A chunk starts with a fresh agent that reads this plan and its chunk, writes a short design where the chunk leaves a choice open, has opencode review it, implements, runs the checks, has opencode review the diff, and commits to `main` (engine) or to `minervacomputing/app` (Laravel). An engine chunk runs `pnpm check --instance minerva-cf-test` and changes ARCHITECTURE.md's sections in its own commit. An app chunk runs `composer test`, `pnpm run check`, `pnpm run types:check` and `pnpm test`. The owner approves every deploy to staging's engine and to production.

Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked. Each perf box measures `main` first, then the head, with the same probe on the same instance.

## Program checklist

- [ ] fast-starts.md is built (chunk 4 places its work after the copy, and closes holds in the copy's commit).
- [ ] Chunk 1 runs on an environment's app before chunk 5 does.
- [ ] Chunks 2, 3 and 4 run in order, and chunk 2 runs on production's engine on its own before chunks 3 and 4 reach it.
- [ ] Chunk 5 starts once staging's engine runs chunk 4.
- [ ] On each environment, the operator approves the changed catalog entries only once its engine runs chunk 4.

## Laravel reads held calls and asks (chunk 1)

**Depends on.** Nothing.

**Files.**

- [ ] Edit `contract/src/internal/facts.ts` (`run.held_call`, `write` and `approved` on `run.tool_call`, `approved` on `run.write`) and `contract/scenarios/facts.json`, regenerate the OpenAPI documents, and make the fake Laravel apply the fact (`cloudflare/src/faults/laravel.ts`). One harness commit.
- [ ] In the app: `composer contract:sync`, the `call_approvals` migration and model, `app/Runs/Facts.php`, `app/Connections/Access.php`, `app/Connections/Consent.php`, the labels of the five codes in `resources/js/components/chat/model.ts`, the purge.

**Build.**

- [ ] `run.held_call` becomes a waiting approval, inserted if absent, for a Live target only.
- [ ] `approved` on `run.write` and on `run.tool_call` sets the approval's outcome, the write's first.
- [ ] The five new codes have labels. No card yet, since nothing can hold a call before chunk 5.
- [ ] `withinContract` (both ways), `view`, `kept` and `Consent::allowed` read ask rows, so a revert of chunk 5 still reads them.

**You see.**

- [ ] A conversation seeded with a held call's facts stores its approval and shows the refused row with its label. An access page with a seeded ask row loads and saves.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Pest: `FactsTest` with the scenario and each target, `ConsentTest` and `AccessTest` with ask rows, `ForeignKeysTest`, the purge. Vitest: `model.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging after the deploy, `minerva:turn` completes a turn as before.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] None: the chunk adds one branch to the facts' apply and no query to a page. The diff shows it.

**Review.**

- [ ] opencode reviewed the design and the diff.

## The third effect (chunk 2)

**Depends on.** Nothing.

**Files.**

- [ ] Edit `contract/src/internal/engine.ts` (`effect: 'ask'`, `changes[].ask`), regenerate the OpenAPI documents, and add the enum line to docs/plans/contract.md's Versions.
- [ ] Edit `cloudflare/src/gateway/policy.ts`, `grants.ts`, `tools.ts` (`COMPILER_VERSION` 4), `executor.ts` and `results.ts`, and `cloudflare/src/internal/connections.ts`.
- [ ] Add the floor at chunk 2 to cloudflare/README.md's rollback paragraph.

**Build.**

- [ ] The layer's effect and the call's effect as in Data shapes, with `asks` in the snapshot and a missing `asks` read as empty.
- [ ] `effect()` for `#authorize`, and `permits` boolean, true for ask or allow.
- [ ] An ask row always asks and passes where an allow would be enforceable. A non-askable ask compiles as a deny.
- [ ] The askable rule in `checkChanges`, and `checkGrantEdit` planning ask subsets.
- [ ] Every ask answers `APPROVAL_UNAVAILABLE` in this chunk, the answer unattended runs keep.

**You see.**

- [ ] On the test instance, under a user layer that asks on the Notes connector's create, `save_note` answers `APPROVAL_UNAVAILABLE`, `list_notes` works, and the turn completes.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] `policy.test.ts` with the seed-7 model and the unenforceable asks, `grants.test.ts`, `tools.test.ts`, `executor-calls.test.ts`, and platform `internal-connections.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] `pnpm check --instance minerva-cf-test` passes with an account turn under an ask layer, and a `checkGrantEdit` with `ask` on `read` is refused. Then, with the owner's go, staging's and production's engines run this chunk on its own.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. `startSnapshot`'s time for 20 connections of 500 grants each, half of them asks. Rule. Within 10% of `main`'s, and `pnpm startup` unchanged. Over fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Holds (chunk 3)

**Depends on.** Chunk 2.

**Files.**

- [ ] Edit `contract/src/internal/engine.ts` (`startRun.attended`) and regenerate the OpenAPI documents.
- [ ] Edit `cloudflare/src/internal/start.ts` (`attended` into the snapshot), `cloudflare/src/conversation/schema.ts` (`run_holds`, `runs.writes_closed`, `runs.attended`), `store.ts` (`RUN_RECORDS`), `cloudflare/src/gateway/run-state.ts`, `cloudflare/src/conversation/ports.ts`, `gateway/ledger.ts`, `gateway/executor.ts`, `gateway/results.ts`, and `cloudflare/src/faults/ports.ts` (`approval:held`).

**Build.**

- [ ] `holdCall` and `heldCall` as in Data shapes, the hold and its fact in one write before the model hears, refused while the run's writes are paused.
- [ ] The requirements with their effects, the layers that asked, and the names from `describe`.
- [ ] The repeat and the closed writes answered before the lease. `dispatchWrite` refuses while the run holds a call. Scripted calls take the same path.
- [ ] The answers' texts, the refused row's `write`, `APPROVAL_TOO_LARGE` over 1.5 MiB, and `APPROVAL_UNAVAILABLE` without `attended`.

**You see.**

- [ ] On the test instance, an attended turn asked to save two notes under ask completes with an answer that names both as waiting. The fake Laravel holds two `run.held_call` facts with the full fields, and the fake provider holds no note. The same turn without `attended` holds nothing.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] `executor-calls.test.ts`, `executor-faults.test.ts`, `ledger-writes.test.ts`, `facts.test.ts`, `conversation-tools.test.ts`; platform `protocols.test.ts` (a run with holds completes; holds outlive a Stop, a failed run and a revocation; a reset at `approval:held` leaves one hold and one fact), `faults-laravel.test.ts`, `retention.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] The account suites `faults.test.ts` and `turns.test.ts` pass on the test instance with the hold cases. The Workers AI row runs five times, and its pass rate is recorded in the commit.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] None: a hold is one write and one `describe` read inside a turn that takes seconds. Chunk 5 measures what the user waits for.

**Review.**

- [ ] opencode reviewed the design and the diff.

## The continuation (chunk 4)

**Depends on.** Chunk 3, and fast-starts.md built.

**Files.**

- [ ] Edit `contract/src/internal/engine.ts` (`startRun.approval`, `APPROVAL_UNKNOWN`, `APPROVAL_DECIDED`) and `contract/src/internal/catalog.ts` (`askable`), and regenerate the OpenAPI documents.
- [ ] Edit `cloudflare/src/internal/start.ts`, `gateway/tools.ts` (`approval` and `closed` on the snapshot), `gateway/ledger.ts` (`approved` on the note), `conversation/store.ts` (the outcome in the settlement), `conversation/conversation.ts` (the acceptance's checks, the holds closed at the copy's commit, the carry-out, the gate), `conversation/history.ts` (the note), `conversation/facts.ts` (`approved`), the catalog's procedure, and `faults/ports.ts` (`approval:carried`).

**Build.**

- [ ] The approval checked before the preparation and in the final write, which uses the holds. A start without an approval closes them in the copy's commit.
- [ ] The carry-out through `#invoke` under the fence, in order, under the continuation's alias, with the stored requirements as its pass, skipping holds that have an outcome, before the note and the submit.
- [ ] Each outcome stored on its hold, in the settlement when the call reached the ledger.
- [ ] The note, also for an earlier run that never submitted.
- [ ] The gate marks the acting run's dispatched writes uncertain whatever it decides.

**You see.**

- [ ] On the test instance, approving one of two held notes saves exactly that note, and the answer says so. Declining both saves none. A plain message after a hold saves none, and the answer says neither was approved. A Stop during the approved save leaves the note saved, and the next turn's answer knows it.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] `internal-start.test.ts`, `ledger-writes.test.ts`, `conversation-gate.test.ts`, `conversation-history.test.ts`, and platform `protocols.test.ts` with every case in Tests, with `approval:carried` and `provider:write:applied` (`abort`, `lose`).

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] The account suites pass with approve, decline, a repeated continuation and a revocation between hold and approval. Then, with the owner's go, staging's engine runs the chunk, and then production's.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The time from the continuation's acceptance to the approved `save_note` settling, median of 10, on the test instance. Rule. Under 2 s. Over fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Answering and editing (chunk 5)

**Depends on.** Chunk 4 on staging's engine.

**Files.**

- [ ] In the app: `routes/web.php`, a controller for the approvals' POST and GET, `app/Runs/Runs.php` (the approval, `attended`, closing and reopening), `app/Runs/Facts.php` (reopening on a copy failure), `app/Enums/AuditAction.php`, `app/Console/Commands/RunTurn.php`, `app/Http/Controllers/AccessController.php`, `app/Connections/Access.php` (`edit` on unrestricted layers, `view`'s effects), `app/Engine/Catalog/Connector.php` and its mapping test, the `resources/js` types, `resources/js/components/chat/` (the card, the summary above the composer, the decision line, the tab's title), the conversation list and the top bar's dot, `resources/js/components/connections/access-editor.tsx` and `access.ts`, search and the title skipping continuation messages, and the app's `docs/architecture/` docs named above.

**Build.**

- [ ] The POST, inside `Runs::start`'s transaction, with every start's checks, `attended`, the decisions and their audit events.
- [ ] Waiting approvals closed by a plain message, and reopened when a start is refused, tombstoned, or ends before its copy commits. A continuation that is not sent goes back to waiting with Approve again.
- [ ] The card's states and choices, the summary, and the markers.
- [ ] The editor's third state in every layer, unrestricted ones included, only for actions the approved entry marks askable, with the narrower allows listed and the copy on who confirms.
- [ ] `minerva:turn --approve` and `--decline`, audited as the console.

**You see.**

- [ ] On staging, after the operator approves the changed catalog entries, with Gmail's Send on Ask first and a mailbox the operator owns (kept outside the repository): the card shows the message and its recipients with their names. Approve sends it once. Decline, or a new message, leaves it unsent. An admin's Ask first on an unrestricted ceiling of a shared connection asks a member whose own layer allows, and the card says the organization asks.

**Verify, unit.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Pest: `CallApprovalsTest`, `LayersTest`, `AccessTest`, `AuditLogTest`, `IsolationTest`, `ChatTest`, the catalog mapping test, and the concurrency test. Vitest: the card and `access.test.ts`.

**Verify, live.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] On staging through `minerva:turn`: approve, decline, approve after the grant was changed to Off (the note says it was not allowed), and two approve POSTs at once start one run. The held run's answer says the mail waits, rather than claiming it was sent or asking for a typed yes.

**Verify, perf.** Tests alone are not sufficient verification. A chunk is verified only when its unit, live, and perf boxes are all checked.

- [ ] Metric. The time from Approve to the approved call's Done row on the page, on staging, median of 10. Rule. Under 5 s. Over fails.
- [ ] Metric. The transcript props' bytes for a conversation with 20 answered cards whose fields are 1 MiB each. Rule. Within 100 KiB of the same conversation without them. Over fails.

**Review.**

- [ ] opencode reviewed the design and the diff.

## Close the program

- [ ] Every box above is checked with its evidence.
- [ ] The docs in Docs to update once built describe what was built, and after-the-plan.md's Appendix D holds what later work inherits.
- [ ] This file is deleted.
