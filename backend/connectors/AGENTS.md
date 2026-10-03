# Writing a connector

A connector turns one provider's API into tools, and the permission executor authorizes every call to them. Read `base.py` (the contract) and `http.py` (provider HTTP and write accounting) first. Their docstrings and comments are the reference; this guide does not repeat them. The reasons are in [ARCHITECTURE_DECISIONS.md, D8](../../ARCHITECTURE_DECISIONS.md#d8-connectors-and-the-permission-executor).

## The contract in brief

- **Connector.** A `Connector` subclass sets the ClassVars `slug`, `name`, `kinds`, `actions`, `auth` and `operations`. It implements `client(secret)` (a provider client with `aclose()`, owned by one request), `account`, `discover` (one page of resources to choose from) and `describe` (names of given ids; unseen ones left out).
- **Kinds.** `ResourceKind(id, label, actions, wildcard, hierarchical, note, listed)`:
  - `wildcard` lets one grant (`*`) cover every resource of the kind, including new ones.
  - `hierarchical` means resources carry their ancestors, and a grant covers what is inside.
  - `note` is shown where users choose access.
  - `listed=False` makes the settings page search instead of list.
  - `ACCOUNT_KIND` (`"account"`) is the connection itself. Its one resource id is the connection id (`binding.account()`).
- **Actions.** `ActionSpec(id, label, requires)`. `requires` names an action that must also be allowed on the same resource (create requires read).
- **Operations.** `Operation(name, title, description, input_model, prepare, needs, ...)`:
  - `needs`: every (kind, action) pair the operation can need.
  - `output_action`: the action each returned record must allow on its own resource (default `read`).
  - `consent`: sets of provider scopes, any one granted in full; the first is the one requested.
  - `revision`: bump it when the meaning changes in a way the declaration does not show.
  - `mutates`: the operation writes.
  - `paginated`: the input has a `cursor` field and the output a `next_cursor`.
- **A call.** Input models subclass `OperationInput`, which forbids extra fields, is strict, and strips whitespace. `prepare(binding, data)` works out what the call touches and returns `Prepared(requirements, execute)`. `execute()` returns `ProviderOutput(records, next_cursor, incomplete)`, each record a `ScopedRecord(resource, data)`.
- **Need vs Enumerate.** `Need(resource, action)` names one concrete resource. `Enumerate(kind, action)` is a listing: it passes if some resource of the kind could be allowed, and its records are filtered afterwards. Writes never enumerate.
- **Binding.** `binding.client` is the provider client. `binding.resource(kind, id, within=..., partial=...)` builds a resource on this connection: ancestors nearest first, and `partial` when the chain is incomplete.
- **Errors.** Raise `OperationError(code, message)`: only its message reaches the model or the UI. Any other exception is logged, and the model sees a generic failure. `denied()` is the policy refusal (`POLICY_DENIED`), also used for what Minerva will not reveal.
- **Auth.** There are three kinds:
  - `OAuth2`: `app`, endpoints, base `scopes`, `scope_separator`, `registration_url` (dynamic client registration), `authorize_params`, `login_hint`, `client_auth` (`post` or `basic`), `json_body` and `pkce`. `app` names the operator's client (`MINERVA_<APP>_CLIENT_ID`/`_SECRET`), and connectors may share one.
  - `ApiKey(label)`.
  - `Builtin()` for a service the instance runs itself.
- **Optional hooks.** `offered(op)` withholds operations this instance cannot serve, such as when an operator key is missing. `manage_link()` gives a (label, URL) where the user manages what the provider lets Minerva reach.

## What is enforced for you

`registry.validate` checks the declaration on first use:

- Slugs, operation names and OAuth app names are lowercase words joined by underscores. Kind and action ids are not checked.
- `<slug>99_<operation>` must fit in 64 characters.
- Slugs, kinds, operations and tool names are unique.
- Every operation declares needs, on its own kinds, with actions those kinds list.
- `output_action` applies to some needed kind.
- `consent` needs `OAuth2`.
- Paginated input has a `cursor`.
- OAuth endpoints use HTTPS, and `authorize_params` cannot replace protocol parameters.
- The account kind is neither wildcard nor hierarchical.

`registry.fingerprint` defines what a tool means, and runs snapshot it. It covers the input schema, needs, output action, consent, `mutates`, `paginated`, requirement chains, the needed kinds' flags, and `revision`. Operation descriptions are not part of it, but field descriptions are, through the input schema. A tool whose fingerprint changed fails in running runs with `OPERATION_CHANGED`.

`executor.py` checks each call, in order:

1. It validates the input strictly (`INVALID_ARGUMENTS`), checks consent (`CONSENT_REQUIRED`), then runs `prepare`.
2. It rejects the call as a connector bug (`CONNECTOR_ERROR`) if:
   - there are no requirements;
   - a need is on another connection or on `*`;
   - an account need does not use the connection id;
   - ancestry is malformed: on a flat kind, with `*` or duplicates, or more than 64 ancestors;
   - a pair is not in `needs`, or a declared need is not covered;
   - a write enumerates, or names no concrete resource.
3. It drops records on another connection, of a kind outside `needs`, malformed, or whose kind lacks `output_action`. It then drops the records the policy does not allow.
4. Writes run one at a time per run. A run has a write quota, and identical arguments are deduplicated. The outcome is judged from the write attempt that `http.py` records, not from the connector's return value. An unknown outcome pauses later writes (`WRITE_UNCERTAIN`).
5. Provider cursors become run-bound tokens. A token is valid only with the same other arguments.

`ProviderHTTP` (in `http.py`) maps provider responses to owned errors:

- It allows one mutating request, only from the `execute()` of a mutating operation, and only with time left.
- It never follows redirects. Use `redirects=True` to judge one yourself.
- A read sent with POST passes `mutating=False`, or uses `bounded(method="POST")`.
- `classify` names errors the status does not. `judge` decides a write's effect when the status cannot, for providers that answer failures with 200.
- `bounded` and `download` stream reads up to a byte limit.
- `parsed` validates JSON into a model.
- `unexpected()` is the error for anything malformed.

## Conventions

- **Resolve before authorizing.** `prepare()` turns names, links and aliases into the id the provider lists, so a deny cannot be bypassed under another spelling.
- **Refuse unseen resources like ungranted ones.** Map `NOT_FOUND` and `PROVIDER_FORBIDDEN` to `denied()`, so a refusal does not reveal whether something exists (Todoist's `get_task`). If the resource is only known after a lookup, fetch it in `prepare()`; the agent receives it only if allowed.
- **Re-check hierarchical resources.** Resolve ancestry again just before reading or writing, and refuse what moved (`FILE_MOVED`, `PAGE_MOVED`, `ISSUE_MOVED`, `TEAM_MOVED`, `MAIL_MOVED`). Ancestry that cannot be completed is `partial`, never guessed.
- **Records name the resource the provider used.** For example, a created task carries the project Todoist actually put it in.
- **Hide other objects in text.** Text read from the provider must not reveal objects the agent may not read (titles in links, mentions, quoted content). Text written must not mention, notify, embed or link beyond the grant. See `notion/markdown.py`, `linear/markdown.py` and `slack/mrkdwn.py`.
- **Shared text helpers.** Use `text.py`:
  - the field validators `no_controls`, `no_controls_or_del` and `single_line`;
  - `decoded`, which undoes encodings before an address is checked;
  - `truncate`, for long fields, which are then flagged as `<field>_truncated`.
- **Limits.**
  - Large reads have byte limits (`bounded`, `download`).
  - Discovery and name lookups stop at a cap with `PROVIDER_LIMIT`.
  - Cursors that fail validation are refused with `INVALID_CURSOR`.
- **Descriptions.**
  - Paginated operations end with "To get the next page, repeat the call with identical arguments plus the returned next_cursor."
  - Writes say that their number per run is limited.
- **Testability.** Clients take a `transport` argument so tests can pass an `httpx.MockTransport`.
- **Layout and design notes.** Provider-specific design notes go in the module docstrings; D8 indexes them. Large connectors split into:
  - `connector.py`, which assembles the connector;
  - `reads.py` and `writes.py`, which hold the operations;
  - a shared module (`pages`, `teams`, `mailbox`);
  - `client.py`.

## Adding a connector

1. `backend/connectors/<slug>/`: `client.py` and `connector.py`, split further as above.
2. `registry._declared()`: import the connector and list it.
3. `backend/minerva/config.py`: add `<app>_client_id: str | None` and `<app>_client_secret: SecretStr | None`, with a one-line comment. `oauth_client(app)` reads them by name. Without them, the connector is not offered, unless it has `registration_url`. An operator key follows `brave_search_api_key`.
4. `.env.example`, and the environment table in the root `AGENTS.md`.
5. `README.md`: add a `## <Provider>` section covering:
   - where to register the app;
   - the callback URL, `{site_url}/api/oauth/<slug>/callback`;
   - the permissions or scopes to give;
   - what users then choose in Minerva.
6. `CURRENT_STATE.md`: a "What works" bullet in §1, and a row in the §4 table (kind and resource id, actions, notes).
7. `ARCHITECTURE_DECISIONS.md` D8: add the connector to the index of provider notes.
8. `backend/tests/test_<slug>.py`:
   - Serve a fake provider through `httpx.MockTransport` (like `FakeTodoist` in `conftest.py`) and patch it into `client()`.
   - Run calls through the `Executor` with the shared helpers rather than copying another connector test's setup: the `connector_run` fixture (connection, grants, claimed run) and `token_endpoint` fixture (OAuth token requests) in `conftest.py`, and `ceiling`, `refusal`, `replace_grants` and `FLOW` in `tests/connector_runs.py`.
   - Contract behaviour belongs in `test_contract.py`, using the test-only connectors in `fakes.py`.
9. Frontend: nothing per connector; the settings page and tool cards render from the API. Run `make api-types` only if an API schema changed.

## Which connector to read

| Shape | Read |
|---|---|
| The smallest whole connector, flat kind, dynamic client registration | `todoist` |
| Provider consent per operation, a shared OAuth app | `google_calendar`, `google/__init__.py` |
| Hierarchical kind with ancestry resolved and re-checked | `google_drive`, `notion`, `linear` (teams), `outlook` (folders) |
| Flat kind keyed by an id resolved from a name | `github`, `slack` |
| A redirect judged by hand (`redirects=True`) | `github` (renamed repositories) |
| Several kinds in one operation | `outlook` (reply: folder and recipients) |
| Account-level action (`ACCOUNT_KIND`) | `web` (search) |
| GraphQL: reads via `bounded` POST, writes judged from the body | `linear` |
| Failures answered with HTTP 200 (`judge`, `classify`) | `linear`, `slack` |
| Errors named from the response body (`classify`) | `outlook` |
| Built-in service, `offered()` | `web` |
| Unlisted kind (`listed=False`) | `web` (sites), `outlook` (recipients) |
| `manage_link()` | `github` |
| API key auth | `KeyedConnector` in `backend/tests/fakes.py` (no production connector yet) |
| Split into `reads`/`writes` and a shared module | `notion`, `linear`, `outlook` |
