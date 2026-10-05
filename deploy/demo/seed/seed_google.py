"""Seed Google: Alex's Gmail inbox (inserted, never sent) and calendar week.

    uv run --with httpx python deploy/demo/seed/seed_google.py [--dry-run] [--demo-day YYYY-MM-DD] [--only gmail|calendar]

Uses Minerva's Google OAuth client (MINERVA_GOOGLE_CLIENT_ID / MINERVA_GOOGLE_CLIENT_SECRET in .env.demo).
Add http://localhost:8765/ to that client's authorised redirect URIs first. A browser window opens: sign
in as the demo Gmail account (SEED_GOOGLE_LOGIN_HINT pre-fills it) and allow every requested permission.

Scopes: gmail.insert (put messages in the mailbox without sending), gmail.readonly (find messages from an
earlier run, and read the account's address), calendar.events (create and move the week's events).

Emails are dated relative to now, and the plot emails arrive minutes to hours before the run: run this
last, the evening before or the morning of the demo. Calendar events are placed around --demo-day
(default: the next weekday). Re-running skips emails by Message-ID and moves existing events to the new
week instead of duplicating them.
"""

import base64
import email.policy
import email.utils
import secrets
import urllib.parse
from datetime import date, datetime, time, timedelta
from email.message import EmailMessage

import _common as c
import story

AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN = "https://oauth2.googleapis.com/token"
GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me"
CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary"
SCOPES = [
    "https://www.googleapis.com/auth/gmail.insert",
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.events",
]
MESSAGE_ID_DOMAIN = f"seed.{story.DOMAIN}"


def message_id(key: str) -> str:
    return f"<{key}.{story.SEED_TAG}@{MESSAGE_ID_DOMAIN}>"


def sent_at(e: story.Email, now: datetime) -> datetime:
    if e.minutes_ago is not None:
        return now - timedelta(minutes=e.minutes_ago)
    days_ago, hhmm = e.day
    hour, minute = map(int, hhmm.split(":"))
    when = datetime.combine(now.date() - timedelta(days=days_ago), time(hour, minute), story.LONDON)
    return min(when, now - timedelta(minutes=5))  # never in the future


def address(value: str) -> str:
    return email.utils.parseaddr(value)[1]


def build_message(e: story.Email, ctx: dict[str, str], when: datetime) -> EmailMessage:
    msg = EmailMessage()
    msg["From"] = story.fill(e.sender, **ctx)
    msg["To"] = story.fill(e.to, **ctx)
    if e.cc:
        msg["Cc"] = story.fill(e.cc, **ctx)
    if e.reply_to:
        msg["Reply-To"] = story.fill(e.reply_to, **ctx)
    msg["Subject"] = story.fill(e.subject, **ctx)
    msg["Date"] = email.utils.format_datetime(when)
    msg["Message-ID"] = message_id(e.key)
    if e.thread:
        msg["In-Reply-To"] = message_id(e.thread)
        msg["References"] = message_id(e.thread)
    if e.list_unsubscribe:
        domain = address(msg["From"]).rpartition("@")[2]
        msg["List-Unsubscribe"] = f"<mailto:unsubscribe@{domain}>, <https://{domain}/unsubscribe>"
    msg.set_content(story.fill(e.body, **ctx))
    if e.html:
        msg.add_alternative(story.fill(e.html, **ctx), subtype="html")
    return msg


def labels_for(e: story.Email) -> list[str]:
    if e.from_alex:
        return ["SENT"]
    return ["INBOX", "UNREAD"] if e.unread else ["INBOX"]


def event_body(ev: story.Event, demo_day: date, ctx: dict[str, str]) -> dict:
    if ev.weekly_standup:
        day = demo_day - timedelta(days=demo_day.weekday())  # Monday of the demo week
    else:
        day = story.add_business_days(demo_day, ev.day)
    hour, minute = map(int, ev.start.split(":"))
    start = datetime.combine(day, time(hour, minute))
    end = start + timedelta(minutes=ev.minutes)
    body = {
        "summary": story.fill(ev.title, **ctx),
        "description": story.fill(ev.description, **ctx),
        "location": ev.location,
        "start": {"dateTime": start.isoformat(), "timeZone": "Europe/London"},
        "end": {"dateTime": end.isoformat(), "timeZone": "Europe/London"},
        "attendees": [{"email": a} for a in ev.attendees],
        "extendedProperties": {"private": {"seedKey": ev.key, "seedTag": story.SEED_TAG}},
        "reminders": {"useDefault": True},
    }
    if ev.weekly_standup:
        body["recurrence"] = ["RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=10"]
    return body


def authorize() -> str:
    import httpx

    client_id = c.env("MINERVA_GOOGLE_CLIENT_ID")
    client_secret = c.env("MINERVA_GOOGLE_CLIENT_SECRET")
    verifier, challenge = c.pkce_pair()
    state = secrets.token_urlsafe(24)
    params = {
        "client_id": client_id,
        "redirect_uri": c.REDIRECT_URI,
        "response_type": "code",
        "scope": " ".join(SCOPES),
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "access_type": "online",
        "prompt": "consent",
    }
    hint = c.env("SEED_GOOGLE_LOGIN_HINT", required=False)
    if hint:
        params["login_hint"] = hint
    code = c.authorize_in_browser(f"{AUTHORIZE}?{urllib.parse.urlencode(params)}", state)
    response = httpx.post(
        TOKEN,
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": c.REDIRECT_URI,
            "client_id": client_id,
            "client_secret": client_secret,
            "code_verifier": verifier,
        },
        timeout=30,
    )
    token = response.json()
    if response.status_code != 200:
        c.die(f"token exchange failed: {token.get('error')} {token.get('error_description', '')}".strip())
    missing = set(SCOPES) - set(token.get("scope", "").split())
    if missing:
        c.die(f"consent did not include {', '.join(sorted(missing))}; run again and tick every permission")
    return token["access_token"]


def main() -> None:
    p = c.parser(__doc__.splitlines()[0])
    p.add_argument("--demo-day", type=date.fromisoformat, help="the demo date (default: the next weekday)")
    p.add_argument("--only", choices=["gmail", "calendar"], help="seed only one of the two")
    args = p.parse_args()
    c.load_env()
    out = c.Out(args.dry_run)
    now = datetime.now(story.LONDON).replace(second=0, microsecond=0)
    demo_day = args.demo_day or story.default_demo_day(now.date())
    if demo_day.weekday() >= 5:
        c.die(f"{demo_day} is a weekend; pick a weekday for --demo-day")

    if args.dry_run:
        ctx = story.context("alex@demo-account.example", demo_day, now)
        print(
            f"Google, demo day {ctx['demo_date']}. Alex's real address is read from the account. Nothing is sent."
        )
        if args.only != "calendar":
            dry_run_gmail(out, ctx, now)
        if args.only != "gmail":
            dry_run_calendar(out, ctx, demo_day)
        out.done()
        return

    import httpx

    http = httpx.Client(headers={"Authorization": f"Bearer {authorize()}"}, timeout=30)

    def call(method: str, url: str, **kwargs: object) -> dict:
        response = http.request(method, url, **kwargs)
        if response.status_code >= 400:
            error = response.json().get("error", {}) if response.content else {}
            c.die(
                f"{method} {url.split('?')[0]} failed: HTTP {response.status_code} {error.get('message', '')}"
            )
        return response.json() if response.content else {}

    alex = call("GET", f"{GMAIL}/profile")["emailAddress"]
    ctx = story.context(alex, demo_day, now)
    print(f"Signed in as the demo account. Demo day {ctx['demo_date']}.")

    if args.only != "calendar":
        out.section("Gmail (inserted into the mailbox; nothing is sent)")
        threads: dict[str, str] = {}
        for e in sorted(story.EMAILS, key=lambda e: sent_at(e, now)):
            found = call(
                "GET",
                f"{GMAIL}/messages",
                params={"q": f"rfc822msgid:{message_id(e.key)[1:-1]}", "includeSpamTrash": "true"},
            ).get("messages", [])
            if found:
                threads[e.key] = found[0]["threadId"]
                out.exists("email", story.fill(e.subject, **ctx))
                continue
            when = sent_at(e, now)
            raw = base64.urlsafe_b64encode(
                build_message(e, ctx, when).as_bytes(policy=email.policy.SMTP)
            ).decode()
            body = {"raw": raw, "labelIds": labels_for(e)}
            if e.thread in threads:
                body["threadId"] = threads[e.thread]
            inserted = call(
                "POST", f"{GMAIL}/messages", params={"internalDateSource": "dateHeader"}, json=body
            )
            threads[e.key] = inserted["threadId"]
            out.create(
                "email", story.fill(e.subject, **ctx), f"{when:%a %d %b %H:%M}, {', '.join(labels_for(e))}"
            )

    if args.only != "gmail":
        out.section("Calendar (primary, Europe/London; no invitations are sent)")
        for ev in story.EVENTS:
            body = event_body(ev, demo_day, ctx)
            found = call(
                "GET",
                f"{CALENDAR}/events",
                params={"privateExtendedProperty": f"seedKey={ev.key}", "showDeleted": "false"},
            ).get("items", [])
            when = body["start"]["dateTime"].replace("T", " ")[:16]
            if found:
                call(
                    "PATCH", f"{CALENDAR}/events/{found[0]['id']}", params={"sendUpdates": "none"}, json=body
                )
                out.exists("event", body["summary"], f"moved to {when}")
                continue
            call("POST", f"{CALENDAR}/events", params={"sendUpdates": "none"}, json=body)
            out.create("event", body["summary"], when + (", weekdays x10" if ev.weekly_standup else ""))

    out.done()


def dry_run_gmail(out: c.Out, ctx: dict[str, str], now: datetime) -> None:
    out.section("Gmail (inserted into the mailbox; nothing is sent)")
    for e in sorted(story.EMAILS, key=lambda e: sent_at(e, now)):
        when = sent_at(e, now)
        msg = build_message(e, ctx, when)
        msg.as_bytes(policy=email.policy.SMTP)  # checks the message serialises
        thread = f", reply in thread {e.thread}" if e.thread else ""
        out.create(
            "email",
            msg["Subject"],
            f"{when:%a %d %b %H:%M}, from {address(msg['From'])}, {', '.join(labels_for(e))}{thread}",
        )


def dry_run_calendar(out: c.Out, ctx: dict[str, str], demo_day: date) -> None:
    out.section("Calendar (primary, Europe/London; no invitations are sent)")
    for ev in story.EVENTS:
        body = event_body(ev, demo_day, ctx)
        when = datetime.fromisoformat(body["start"]["dateTime"])
        out.create(
            "event",
            body["summary"],
            f"{when:%a %d %b %H:%M}" + (", weekdays x10" if ev.weekly_standup else ""),
        )


if __name__ == "__main__":
    main()
