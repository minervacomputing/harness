# Chat

## Sub-features

- New chat: the first message creates a conversation and its first run, and the page moves to `/w/<id>/chat/<conversation id>`.
- The run streams its reply; the transcript survives a reload; the sidebar lists the conversation under Today.
- Stop, attachments and deleting a conversation are not driven yet.

## How to get to it (user POV)

New chat in the sidebar, type in the composer (`Message your agent, or drop files here`), press Send. `?agent=<id>` picks an agent other than the default.

## Driving it with journey.ts

`node .claude/skills/verify/scripts/journey.ts chat`. It sends a fake-model script whose only turn is the text `Verified at <time>.`, waits for that text, polls `GET /api/workspaces/<id>/conversations/<id>` until the run is no longer queued, provisioning or running, requires `completed`, then reloads and finds the reply again.

## Gotchas

- A 500 on `POST …/conversations` means the Worker could not reach the Workspace or Conversation object; the Worker's log has the stack. Two causes seen on 2026-10-15: `TypeError: Cannot read properties of undefined (reading 'then')` after a dependency upgrade (`pi-durable` 1.1.0 to 1.2.0) left Vite's dependency cache stale, fixed by stopping the Worker, deleting `cloudflare/node_modules/.vite` and starting again; and `The workspace is not initialized.` on an old local state, which an empty state (Launch) fixed, cause not established.
- A failed run shows `The agent could not finish this run. Try again.`; the journey fails at once and logs the run's `errorMessage`. The Worker's log has the cause.
