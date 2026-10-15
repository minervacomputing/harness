# Files from a turn

## Sub-features

- A tool call in the sandbox writes a file into the conversation's folder; the Files panel lists it with its size; its link downloads it.
- Uploading files with a message (the paperclip, `Attach files`) is not driven yet.

## How to get to it (user POV)

In a conversation, the agent writes a file; Files at the top right opens the panel; the file's link (`<name> <size> B`) downloads it.

## Driving it with journey.ts

`node .claude/skills/verify/scripts/journey.ts files`. It sends a fake-model script whose first turn runs `bash` to write `verify.txt` with a timestamped line and whose second says `Wrote verify.txt.`, requires the run `completed`, opens Files, downloads `verify.txt` into the evidence directory and compares its bytes with what the turn wrote.

## Gotchas

- Needs Docker: the offline Worker gives the sandbox a container only if Docker ran when it started.
- On 2026-10-15 (macOS, OrbStack, `main` at `201a3ee` with a clean tree) this journey failed every time: the Worker logged `SandboxRefused: The sandbox could not be hardened (cgroup)` and the run ended `failed`. Attribute a failure to that only when the Worker's log shows the same line for the run; any other cause is a new finding. Until it is fixed locally, prove sandbox behaviour with `pnpm --dir cloudflare test:docker` or on the test instance.
