# Sign-in

## Sub-features

- Email and password sign-in, landing on the personal workspace at `/w/<workspace id>`.
- Two-factor (`/login/mfa`) and email codes (`/login/code`) exist but are not driven yet; seeded accounts have no two-factor.

## How to get to it (user POV)

Open `http://localhost:5173/login`, type the email and password, press Sign in.

## Driving it with journey.ts

`node .claude/skills/verify/scripts/journey.ts signin`. It fills `Email` and `Password`, presses `Sign in`, waits for `/w/<uuid>`, screenshots the workspace and checks `GET /api/me` answers 200. Every other journey starts with the same sign-in.

## Gotchas

- Seed first: `pnpm --dir cloudflare run seed` creates or resets ada and grace and signs out their sessions.
- The login page's own `/api/me` 401 is expected in the log.
