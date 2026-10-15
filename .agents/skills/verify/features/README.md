# Feature map: the engine's frontend

One file per user-facing feature, each driven by a journey of `scripts/journey.ts`. A proof covers every entry point a feature file lists, not only the convenient one.

| Feature | File | Journey |
|---|---|---|
| Sign-in | [sign-in.md](sign-in.md) | `signin` |
| Agents | [agents.md](agents.md) | `agent` |
| Chat | [chat.md](chat.md) | `chat` |
| Files from a turn | [files.md](files.md) | `files` |

Not yet mapped: Connections (offline has no fake connector; the test build's Notes is driven by `cloudflare/test/account/browser.test.ts`), Account (password, two-factor, sessions), Instance (admins), setup, sign-up, password reset.
