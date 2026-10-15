# Files from a turn

## Sub-features

- A tool call in the sandbox writes a file into the conversation's folder; the tool's row shows its output; the Files panel lists the file with its size; its link downloads it.
- Uploading files with a message (the paperclip, `Attach files`) is not driven yet.

## How to get to it (user POV)

In a conversation, the agent writes a file; clicking the tool's row (its command) shows the output; Files at the top right opens the panel; the file's link (`Download <name>`) downloads it.

## Driving it with journey.ts

`node .claude/skills/verify/scripts/journey.ts files`. It sends a fake-model script whose first turn runs `bash` to write `verify.txt` with a timestamped line and whose second says `Wrote verify.txt.`, requires the run `completed`, expands the tool's row and requires its output to be the line written, then opens Files and requires `verify.txt` at exactly the byte count written. It does not download: see Gotchas.

## Gotchas

- Needs Docker: the offline Worker gives the sandbox a container only if Docker ran when it started.
- Offline has no download origin: the link goes to `/api/…/files/download`, which redirects to `MINERVA_DOWNLOAD_ORIGIN` (`http://localhost:8788` by default), and nothing serves it, since `dev:offline` does not run the download Worker (`files-worker/`). Prove downloads on the test instance (`pnpm test:browser`).
- `SandboxRefused: The sandbox could not be hardened (cgroup)` in the Worker's log was the local container's read-only cgroup namespace, fixed in the hardening script on 2026-10-15; `test/docker/sandbox-local.test.ts` runs a container started as workerd starts one. If it returns, run that test first.
