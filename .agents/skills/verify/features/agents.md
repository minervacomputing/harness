# Agents

## Sub-features

- Create an agent (name, instructions); edit it (its connections' checkboxes); the workspace's default agent.
- Archive and delete are not driven yet.

## How to get to it (user POV)

Agents in the sidebar (`/w/<id>/agents`), then New agent, fill Name and Instructions, Create agent. Edit is the button on the agent's list item.

## Driving it with journey.ts

`node .claude/skills/verify/scripts/journey.ts agent`. It creates `Verify agent <time>`, waits for the name in the list, screenshots the form and the list, and checks `GET /api/workspaces/<id>/agents` lists it.

## Gotchas

- Names carry the run's timestamp, so repeated runs add agents rather than collide; an empty state (Launch) starts clean.
