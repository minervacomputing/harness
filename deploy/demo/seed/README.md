# Demo seed scripts

One-off scripts that fill the demo accounts of the fictional Fernhill Labs (see [STORY.md](STORY.md)). All story data lives in [`story.py`](story.py).

Every script:

- reads settings from the process environment and from `.env.demo` at the repository root (gitignored). It never prints secret values;
- has a `--dry-run` flag that prints everything it would create, with no credentials and no network calls;
- skips what already exists (matched by name, number, title or seed metadata), so it is safe to re-run.

The only extra Python dependency is `httpx`. `seed_github.py` needs the `gh` CLI and `git` instead.

## Before you start

1. **Accounts.** You need:
   - a demo Gmail account (Alex Morgan) with Google Calendar;
   - a Stripe account in **test mode**;
   - the GitHub organisation `fernhill-labs-demo`, with `gh` logged in as a member who can create repositories;
   - a Linear workspace with a team named Tably, key `TAB`;
   - a Notion workspace with a page **Fernhill Wiki**, shared with an internal integration.
2. **Redirect URI.** Add `http://localhost:8765/` to the authorised redirect URIs of Minerva's Google OAuth client. `seed_google.py` listens there during sign-in.
3. **Google consent screen.** If the app is in testing mode, add the demo Gmail account as a test user. `gmail.insert` and `gmail.readonly` are restricted scopes, so expect an "unverified app" warning; continue past it.
4. **`.env.demo`** at the repository root:

```sh
SEED_STRIPE_SECRET_KEY=sk_test_...      # test-mode secret key; anything else is refused
SEED_LINEAR_API_KEY=lin_api_...         # Linear → Settings → Account → Security & access → API keys
SEED_NOTION_TOKEN=ntn_...               # Notion internal integration secret
MINERVA_GOOGLE_CLIENT_ID=...            # the same OAuth client Minerva uses
MINERVA_GOOGLE_CLIENT_SECRET=...

# Optional
SEED_BILLING_MONTH="October 2026"       # label for the double-charge month (default: the current month)
SEED_GOOGLE_LOGIN_HINT=alex@...         # pre-fills the Google account chooser
SEED_NOTION_PARENT_ID=...               # Fernhill Wiki's page id, if search does not find it
```

If you set `SEED_BILLING_MONTH`, keep it set for every script so Stripe and the emails agree.

## Run order

Run each script with `--dry-run` first. Run the commands from the repository root:

```sh
uv run --with httpx python deploy/demo/seed/seed_stripe.py
uv run python deploy/demo/seed/seed_github.py
uv run --with httpx python deploy/demo/seed/seed_linear.py
uv run --with httpx python deploy/demo/seed/seed_notion.py
uv run --with httpx python deploy/demo/seed/seed_google.py      # last: the evening before or the morning of the demo
```

| Script | Creates |
|---|---|
| `seed_stripe.py` | Products and prices (Starter £29, Pro £79, Annual Pro £790). 10 card customers with UK test cards and subscriptions, and The Copper Pot, invoiced for 3 × Pro and paid by bank transfer (its invoice stays open). Trattoria Rossa's two £79 payments for one checkout. Saffron & Salt's open invoice with a declined charge. Juniper & Rye's open £150 onboarding invoice. |
| `seed_github.py` | Private repo `fernhill-labs-demo/tably-widget`, with the code in `tably-widget/` pushed as 4 backdated commits by the team. 10 labels, 11 issues (2 closed) and 2 PRs built from `tably-widget-prs/`. |
| `seed_linear.py` | Enables 2-week cycles if they are off. 7 labels, the project "Q4 Growth", and 12 issues with states, priorities and estimates, some in the current cycle. |
| `seed_notion.py` | Under Fernhill Wiki: About, Refund policy, Pricing, Onboarding checklist and Engineering on-call; the Customer notes database with 11 rows; an empty Scratch page. |
| `seed_google.py` | 16 emails inserted into Gmail (never sent; dated by their Date header, some unread, one thread) and 9 calendar events in Europe/London around the demo day, with no invitations sent. |

`seed_google.py` takes two flags:

- `--demo-day YYYY-MM-DD`: the demo date. The default is the next weekday.
- `--only gmail|calendar`: seed just one of the two.

Re-running it moves existing events to the new week.

## Resetting between rehearsals

The agent's work is not touched by the scripts. Delete it by hand: the Linear double-charge issue, Notion pages under Scratch, Gmail drafts and any calendar events the agent made. The agent cannot refund, but a refund you make yourself in Stripe cannot be undone. To get a fresh duplicate charge, delete the Trattoria Rossa customer in the Stripe dashboard and re-run `seed_stripe.py`.
