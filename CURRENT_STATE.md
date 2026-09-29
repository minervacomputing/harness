# Minerva — current state

Updated 2026-09-29. This describes the code in this repository. For the reasons behind it, see [ARCHITECTURE_DECISIONS.md](ARCHITECTURE_DECISIONS.md). For setup, see [README.md](README.md).

## 1. Summary

Minerva runs AI agents that **never hold credentials and never decide their own permissions**. Each agent turn runs in a locked-down container. The container can only call a trusted gateway, which holds the keys and checks every action against permissions the user chose.

This is the first real implementation. It is not a prototype and is built to be extended. It runs locally today and is structured for a cloud alpha.

**What works:**

- Sign up with email verification, sign in with a password or an emailed code, reset a password, and use two-factor authentication with an app and recovery codes.
- A personal workspace for every user, with a default agent.
- Connecting Todoist through OAuth, then choosing per project what agents may do: read tasks and/or create tasks.
- Creating agents with their own instructions and connections.
- Chatting with an agent. The answer streams in live, tool calls appear as cards (done, not allowed, failed), and a run can be stopped.
- Every turn runs in a fresh hardened container, which is removed afterwards.

**Not built yet:** team workspaces, Google or GitHub login, passkeys in the UI, report files and other artifacts, audit records, bring-your-own model key, and cloud deployment files. See [section 8](#8-gaps-and-next-steps).

## 2. Architecture

```text
 Browser (React app)
    │  JSON API + server-sent events, session cookie
    ▼
┌─────────────────── Trusted backend (Django, one codebase) ────────────────────┐
│ web         accounts, workspaces, connections, agents, chat, live updates    │
│ gateway     the only API workers can reach: run spec, MCP tools, model relay │
│ supervisor  claims queued runs, starts/stops sandboxes, deadlines, cleanup   │
└───────┬───────────────────────────────┬───────────────────────────────┬───────┘
        ▼                               ▼                               ▼
   PostgreSQL                 Sandbox container (per turn)      Todoist API, model API
                              worker: DeepSeek Harness          (keys live only here)
                                 │ outbound HTTP only, per-run token
                                 └──────────────► gateway
```

| Zone | Trusted? | Holds |
|---|---|---|
| Browser | The signed-in user | Session cookie only |
| Backend | Yes | Provider and model keys, permissions, all state |
| Worker | **No**, treated as hostile | Its run token, nothing else |

## 3. One chat turn, step by step

1. **Browser → web:** the message is stored, and a run is created with status `queued`. The run stores a snapshot of the effective permissions and the tool list. A database constraint allows one active run per conversation.
2. **Supervisor:** claims the run (`SKIP LOCKED`, at most 4 at once) and issues a run token. It then starts a container whose only environment variables are `GATEWAY_URL`, `RUN_TOKEN`, and `RUN_ID`.
3. **Worker → gateway:** it fetches the run spec with `GET /run` and configures DeepSeek Harness. The agent's model points at the gateway relay and its tools at the gateway's MCP endpoint. Shell, terminal, and subprocess plugins are disabled.
4. **Gateway:**
   - Model calls go to the configured upstream. The relay parses the stream and publishes text deltas as run events every 0.25 s.
   - Tool calls go through the permission executor ([section 4](#4-permissions)).
5. **Worker → gateway:** it posts only `phase`, `completed` (with the final answer), and `failed` events.
6. **End of the run:** the token is revoked when the run reaches any final state, and the supervisor removes the container.
7. **Browser:** follows run events through server-sent events, woken by Postgres `NOTIFY`, and resumes after a reconnect from the last sequence number. Agent text is rendered as Markdown, but images in it are shown as text and never loaded, and a Content Security Policy also blocks remote images. Otherwise, prompt-injected content could send data out through the browser.

Run states: `queued → provisioning → running → completed | failed | cancelled | timed_out`.

Stopping a run revokes its token, so every later call from the worker is rejected. A Todoist write that is already in flight may still complete.

## 4. Permissions

**A grant is: connection + project + actions.** For Todoist the actions are Read and Create, and Create requires Read.

Layers can only narrow, and deny wins:

```text
effective = provider account ∩ workspace ceiling ∩ user layer ∩ agent layer
```

In a personal workspace the ceiling is unrestricted and hidden. The UI edits the user layer under **Connections → Choose access**, and each agent can use only the connections selected for it.

**Strict revocation:** changing access, removing a connection, or changing an agent's connections cancels the affected active runs, so no run continues with outdated permissions.

Every tool call goes through one pipeline:

```text
strict argument validation
  → connector resolves the real project(s) the call touches
  → permission check
  → (writes) reserve one of the run's writes
  → call Todoist
  → drop returned records the run may not see
  → return, with an opaque run-bound page token
```

**Guardrails per run:**

| Limit | Value |
|---|---|
| Task creations | 3 |
| Model calls | 30 |
| Output tokens per call | 8,192 |
| Wall-clock time | 300 s |

- **Identical writes** within a run are deduplicated.
- **Uncertain writes:** if a write's outcome is unknown, for example after a timeout, further writes in that run are paused.
- **Refused writes:** a write the provider refused outright (401, 404, or 429) does not pause further writes.
- **Rejected tokens:** if Todoist rejects a token, the connection is marked **Needs reconnecting**. Reconnecting keeps the user's access choices.

## 5. Sandbox

The `container` provider (Docker or Podman) runs each worker with:

- A read-only root filesystem.
- A 256 MB writable `/workspace` and a 64 MB `/tmp`, which does not allow executables.
- Non-root user 1000, all capabilities dropped, `no-new-privileges`, and no shared IPC.
- 1 GB memory, 1 CPU, and 256 processes.
- The internal `minerva-sandbox` network, whose only exit is a relay to the gateway port. The provider refuses to start if that network is not internal.
- Optional gVisor (`MINERVA_SANDBOX_RUNTIME=runsc`).

`make sandbox-check` runs the conformance probe inside the real image. On 2026-09-29 all 11 checks passed:

- Non-root user.
- Only the run token in the environment.
- Workspace writable, root filesystem read-only.
- Gateway reachable.
- Blocked: IPv4 internet, IPv6 internet, cloud metadata, public DNS, host, and database.

The `local-process` provider exists for development. It has no isolation and refuses to start unless explicitly enabled.

**Known weakness:** workers share one network, so two concurrent workers can reach each other.

## 6. Where state lives

Everything is in PostgreSQL. Tenant tables carry a `workspace` key, and scoped managers filter by the current workspace.

| Table | Contents |
|---|---|
| `User`, `Workspace`, `Membership` | Accounts, personal and team workspaces, roles |
| `Connection`, `OAuthClient` | Encrypted provider credentials (key-versioned); registered OAuth clients |
| `PermissionLayer`, `Grant` | Ceiling, user, and agent layers with allow/deny grants |
| `Agent` | Name, instructions, connections |
| `Conversation`, `Message` | Chat history |
| `Run`, `RunEvent` | Status, permission snapshot, token hash, deadline, usage, sandbox handle; ordered events |
| `RunWrite`, `RunPageToken` | Write deduplication and quota; run-bound page tokens |

Other state:

- **Secrets** live only in `.env` (mode 600, gitignored).
- **Containers:** the supervisor removes sandboxes that no run owns anymore.

## 7. Verification (2026-09-29)

| Check | Result |
|---|---|
| Backend tests (`pytest`), including cross-workspace access; needs Postgres running (`make services`) | 39 pass |
| Ruff lint and format; worker and frontend typechecks; production build | Pass |
| Sandbox conformance | 11/11 |
| End-to-end run in the container with the fake model | Pass: tool call, streamed text, stored answer, usage recorded, container removed |
| Browser walkthrough | Pass: sign-up, email verification, chat streaming, tool-call card, connection status and reconnect prompt, agent create and validation, two-factor setup with re-authentication |
| Two-factor sign-in | Pass, through the API (the browser step was not driven) |

**Not verified yet:**

- A real Todoist account.
- A real model provider.
- Any cloud deployment.

## 8. Gaps and next steps

Roughly in priority order:

1. **Live check:** a real model key and a real Todoist account.
2. **Cloud alpha:**
   - A production backend image with the web, gateway, and supervisor roles.
   - A worker network per run.
   - A deployment target with gVisor or Kata.
   - PlanetScale Postgres.
   - SMTP email.
3. **Report files and artifacts:** the gateway `PUT /artifacts` endpoint and UI.
4. **Audit records:** today, run events are the record of tool decisions.
5. **Teams:** team workspaces, invitations, workspace switcher, ceiling UI, shared connections.
6. **Login options:** Google and GitHub; passkeys in the UI (the backend already supports WebAuthn).
7. **Model keys:** bring-your-own key per workspace, and quotas.

## 9. Technology

| Area | Choice |
|---|---|
| Backend | Python 3.14, Django 6.1, Django Ninja, Pydantic, django-allauth (headless, MFA), MCP SDK 2.2, httpx, psycopg 3, uvicorn |
| Database | PostgreSQL 18 (Compose locally) |
| Worker | Node 24, TypeScript, DeepSeek Harness 0.1.7-rc.2 (SDK client, pi-ai model adapter, MCP client), zod |
| Frontend | React 19, Vite 8, TanStack Router/Query/Form, assistant-ui 0.15, Tailwind 4, Radix, Hey API client generated from OpenAPI |
| Tooling | uv, pnpm, Ruff, pytest, honcho |

TypeScript is pinned to 5.9 in the frontend because the Hey API generator does not run on TypeScript 7.
