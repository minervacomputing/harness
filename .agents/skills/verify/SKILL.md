---
name: verify
description: Drive the engine's own React frontend (frontend/, served with the offline Worker in cloudflare/) in headless Chrome as a seeded user, and keep screenshots and logs as proof. Use to prove a change to the engine's API, runs, agents, chat or files works for a user, on the local offline build with the fake model. The Laravel product has its own verify skill in ../app.
---

# Verify the engine locally

The engine's frontend is the user surface of this repository: sign-in, the workspace's New chat, Agents, Connections, Account and Instance pages, at `http://localhost:5173`, which proxies `/api` to the offline Worker on `:8787`. The product's real interface is the Laravel app in `../app`, which cannot call a local engine (it needs an https engine URL behind Cloudflare Access); prove engine behaviour here, and the app's pages with its own `verify` skill.

The offline build uses the fake model: a message that is JSON `{"fake": {"turns": [...]}}` scripts the turn (`cloudflare/src/model/fake.ts`); any other message gets the reply `Done.`. Each turn is `{"text": "..."}` or `{"tools": [{"name": "bash", "arguments": {"command": "..."}}]}`.

## Launch

From the repository's root. In the desktop app, `preview_start` with `cf-offline` and then `cf-frontend` (`.claude/launch.json`); elsewhere, two background shells:

```sh
pnpm --dir cloudflare dev:offline   # applies local D1 migrations, then the Worker on 127.0.0.1:8787
pnpm --dir frontend dev             # the app on http://localhost:5173
```

Ready means usable: `curl -sf http://127.0.0.1:8787/api/health` answers `{"ok":true}` and then

```sh
pnpm --dir cloudflare run seed      # creates or resets ada@example.com and grace@example.com, password `password`
```

prints `created` or `reset` for both. The first requests after a start can hit a Vite dependency-optimizer reload (`ERR_FILE_NOT_FOUND_IN_OPTIMIZED_DEP_DIR` in the Worker's log); wait a few seconds and retry. If a port is taken, another copy runs: run the doctor, and stop it only if it is yours. One local instance at a time: both ports are fixed by `.claude/launch.json` and the frontend's proxy.

Local state is in `cloudflare/.cloudflare/state`. For an empty one, stop the Worker, move that directory aside (do not delete someone's state), start again and seed.

## Doctor

```sh
.claude/skills/verify/scripts/doctor.sh
```

Read-only. Checks both ports listen from this checkout, `/api/health` directly and through the proxy, `/api/me` answers 401 signed out, `.dev.vars` exists, and whether Docker runs. Run it first, and again whenever something looks off.

## Drive

```sh
node .claude/skills/verify/scripts/journey.ts <signin|agent|chat|files> [origin]
```

Headless Chrome (`playwright-core` from `cloudflare/`, system Chrome) signs in as ada and runs one journey; exit 0 is PASS. The journeys and what each proves are in [features/](features/README.md). To drive by hand instead, use the browser pane on `http://localhost:5173` with the same handles: labels `Email`, `Password`, `Name`, `Instructions`; buttons `Sign in`, `New agent`, `Create agent`, `Send`, `Files`, `Sign out`; the composer's placeholder `Message your agent, or drop files here`; the searchbox `Search apps`. The app's JSON API is under `/api/workspaces/<id>/…` and answers the browser's session cookie.

To add a journey, add an entry to `steps` in `journey.ts` and a feature file; assert the end state a user sees and the API's record of it.

## Evidence

Each run writes `.verify/<time>-<journey>/` at the repository's root (gitignored): numbered screenshots, `journey.log` (each step, the ids it made, every console error and failed request), `result.json`, and any downloaded file. A proof is the journey's PASS line plus that directory. Proof standards: go through the pages as a user does, never through `/api/dev/` or `/api/faults/` routes; capture the action and the resulting state (the journeys screenshot both and read the API's record); check side effects, such as the downloaded file's bytes. The fake model is the only mock, and it stands where a model provider would.

A console error or a failed request (4xx or 5xx) anywhere in the journey fails it, even when the end state was reached; the only exception is the login page's `GET /api/me` 401 before sign-in.

## Cleanup

Stop what you started: `preview_stop` for preview servers, or kill the PIDs of the shells you launched. Never kill by process name: another session may run its own Worker or Docker tests (`minerva-sbx-test-*` containers are the Docker suite's, not yours). The Worker leaves each sandbox's container and its proxy running when it stops: before stopping it, collect the ids your turns used from its log (`containerName = workerd-minerva-dev-Sandbox-<id>`), then `docker rm -f workerd-minerva-dev-Sandbox-<id> workerd-minerva-dev-Sandbox-<id>-proxy` for exactly those. Leave `.verify/` in place: it is the proof.
