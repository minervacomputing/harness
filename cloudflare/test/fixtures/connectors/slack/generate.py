"""Writes vectors.json: what today's Slack connector computes, for src/connectors/slack/'s tests.

The functions are the backend's own (connectors/slack/), which import pydantic, httpx and permissions/policy.py
only, so no configuration (and no .env) is loaded. Python's own behaviour the port reproduces is recorded
too: `datetime.fromisoformat` and `timestamp()`, `datetime.fromtimestamp`, `urlsplit` and its hostname,
`str.casefold`, and Pydantic's lax parsing of Slack's answers.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/slack/generate.py
"""

import json
import sys
import unicodedata
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

from pydantic import ValidationError  # noqa: E402

from connectors.slack import client, connector, mrkdwn  # noqa: E402

MOMENTS = [
    "2024-10-01T10:50:00Z",
    "2024-10-01T12:00:00+02:00",
    "2026-10-01T09:00:00Z",
    "2026-10-01",
    "20261001",
    "2026-10-01T09",
    "2026-10-01T09:00",
    "2026-10-01 09:00:00",
    "2026-10-01T09:00:00.5Z",
    "2026-10-01T09:00:00,123456789Z",
    "2026-10-01T09:00:00.1234567+01:30",
    "2026-10-01T09:00:00.123+01:00",
    "2026-10-01T09:00:00,5",
    "2026-W40",
    "2026W40",
    "2026-W40-4",
    "2026W404",
    "2026W40-4",
    "2026-W404",
    "2026-W53",
    "2020-W53-7",
    "2026-W00",
    "2026-W40-0",
    "2026-W40-8",
    "2026-10-01T24:00",
    "2026-10-01T24:00:01",
    "2026-12-31T24:00:00Z",
    "2026-02-28T24:00",
    "9999-12-31T24:00",
    "9999-12-31T23:59:59.999999",
    "0001-01-01T00:00:00+01:00",
    "0001-01-01",
    "9999-12-31T23:59:59.999999-23:59",
    "2026-10-01T09:00:00+24:00",
    "2026-10-01T09:00:00+23:59:59.999999",
    "2026-10-01T09:00:00-00:00",
    "2026-10-01T09:00:00+00:00:00.000001",
    "2026-10-01T09:00+0130",
    "2026-10-01T09:00+01",
    "2026-10-01T09:00+1",
    "2026-10-01T09:00+013",
    "2026-10-01T09:00+013000",
    "2026-10-01T09:00+013000.5",
    "2026-10-01T09:00:00+01:00:30",
    "2026-10-01T09:00:00+01:75",
    "2026-10-01T09:00:00+99:00",
    "2026-10-01T09:00:00Z+01:00",
    "2026-10-01T09:00:00+01:00Z",
    "2026-10-01T09:00:00-01:00+02:00",
    "2026-10-01T09:00:00z",
    "2026-10-01t09:00:00Z",
    "2026-10-01\u00e909:00",
    "2026-10-01\u300009:00",
    "2026-10-01\U0001f60009:00",
    "2026-1001",
    "202610-01",
    "2026-10-1",
    "2026-02-30",
    "2024-02-29",
    "2026-13-01",
    "2026-00-10",
    "2026-10-00",
    "2026-10-01T25:00",
    "2026-10-01T09:60",
    "2026-10-01T09:00:60",
    "2026-10-01T09:00:00.",
    "2026-10-01T09:00:00.Z",
    "2026-10-01T09:00:00.5x",
    "2026-10-01T0900",
    "2026-10-01T090000",
    "2026-10-01T090000.5",
    "2026-10-01T09:0000",
    "2026-10-01T0900:00",
    "2026-10-01T9:00",
    "2026-10-01T09:0",
    "+2026-10-01",
    "\uff12\uff10\uff12\uff16-10-01",
    "\u0662\u0660\u0662\u0666-10-01",
    "2026-10-01T09:00:00 ",
    "2026-10-01T09:00:00-",
    "2026-10-01T09:00:00+",
    "2026-10-01T09:00:00+0",
    "2026-10-01T09:00:00+012",
    "1969-12-31T23:59:59.999999Z",
    "1970-01-01T00:00:00Z",
    "1970-01-01T00:00:00.000001Z",
    "1900-01-01T00:00:00Z",
    "2300-01-01T00:00:00.000001Z",
    "8000-06-15T12:34:56.789012Z",
    "1600-01-01T00:00:00.000001Z",
    "0001-01-01T00:00:00.000001Z",
    "9999-12-31T23:59:59.999999+14:00",
    "T09:00",
    "2026",
    "2026-10",
    "2026-10-01T",
    "2026-10-01TT09:00",
    "2026-10-01T09:00:00.000000000000000001Z",
    "2026-10-01T09:00:00.999999999Z",
    "2026-10-01T23:59:59.9999999Z",
    "2026-10-01T09:00:00+01:00.5",
    "2026-10-01T09:00:00+0100.5",
    "2026-10-01T09:00:00+010000.123456789",
    "2026-10-01T09:00:00-23:59:59.999999",
    "2026-10-01X09:00",
    "2026-10-01T09:00:00Zjunk",
    "2026-10-01T09-00",
    "abcdefg",
    "2026-10-01T09:00:00\u00b2",
    # Where the C module the backend runs differs from _pydatetime.py.
    "2026-10-01T09:00:00x+01:00",
    "2026-10-01T09x+01:00",
    "2026-10-01T09 +01",
    "2026-10-01T09:00:00:+01",
    "2026-10-01T09:00:00xZ",
    "2026-10-01T09:00:00.1234567xZ",
    "2026-10-01T09:00:00.1234567x+01:00",
    "2026-10-01T09:00:00.12x+01",
    "2026-10-01T09:00:00.Z",
    "2026-10-01T09:00:00,Z",
    "2026-10-01T09:00.Z",
    "2026-10-01T09\u00e9+01",
    "2026-10-01\u20ac09:00",
    "2026-10-01\u00e9",
    "2026-10-01T09:00\x00",
    "2026-10-01T09:00Z\x00",
    "2026-00-00T24:00",
    "2026-10-00T24:00",
    "2026-W40-412:00",
    "2026W4012:00",
    "2026W40112:00",
    "2026-10-01T0900001",
    "2026-10-01T090000x",
    "2026-W40-",
    "2026-W4",
    "20261001T",
    "2026-10-01 ",
]

TIMES = [
    "1727780000.000100",
    "1727790000.000001",
    "1727780100.000200",
    "1727780000.000000",
    "1727780000.999999",
    "1727780000.500000",
    "000000000.000000",
    "123456789.123456",
    "9999999999.999999",
    "9999999999.999995",
    "4102444800.000001",
    "2147483647.999999",
    "\u0661\u0667\u0662\u0667\u0667\u0668\u0660\u0660\u0660\u0660.\u0660\u0660\u0660\u0661\u0660\u0660",
    "17277800000.000100",
    "1727780000.00010",
    "1727780000",
    "",
]

CHANNEL_NAMES = [
    "#General",
    "general",
    "C0GENERAL1",
    "c0general1",
    "G0PRIVATE1",
    "D0DIRECT01",
    "#C0GENERAL1",
    "C01234567",
    "C0123456",
    "C" + "A" * 20,
    "C" + "A" * 21,
    "#",
    "##general",
    "a.b",
    "general channel",
    "<#C0GENERAL1>",
    "#\u0130stanbul",
    "#\u0391\u03a3",
    "\u1e9e",
    "x" * 80,
    "x" * 81,
    "#" + "x" * 80,
    "gen\u00a0eral",
    "gen\x85eral",
    "gen\x1ceral",
    "gen\ufefferal",
    "gen\u200beral",
    "gen\teral",
    "#\u00dcn\u00efc\u00f6d\u00e9",
    "\U0001f989",
    "\U0001f989" * 80,
    "\U0001f989" * 81,
    "general&co",
    "a@b",
    "a,b",
    "a|b",
    "a<b",
    "a>b",
    "under_score-dash",
    "\u212a",
    "K\u0131",
]

TS = [
    "1727780000.000100",
    "172778000.000100",
    "17277800000.000100",
    "1727780000.00010",
    "1727780000.0001000",
    "1727780000",
    "\u0661\u0667\u0662\u0667\u0667\u0668\u0660\u0660\u0660\u0660.\u0660\u0660\u0660\u0661\u0660\u0660",
    "\uff11\uff17\uff12\uff17\uff17\uff18\uff10\uff10\uff10\uff10.\uff10\uff10\uff10\uff11\uff10\uff10",
    "1727780000,000100",
    "1727780000.000100x",
    "x1727780000.000100",
]

SECRET = "SECRET plans"
PRIVATE = "C0PRIVATE1"

REDACTED = [
    f"<#{PRIVATE}|{SECRET}> <https://acme.slack.com/archives/{PRIVATE}/p1|{SECRET}> "
    f"<https://acme%2Eslack.com/x|{SECRET}> <https://acme.slack-gov.com/archives/{PRIVATE}/p1|{SECRET}> "
    f"<slack://channel?team=T0ACME&id={PRIVATE}|{SECRET}> "
    "<https://example.com|docs> <@U0ADA|ada> <#C0GENERAL1>",
    "<!channel|everyone> <!here> <@U0ADA|ada> <#C1|x>",
    "<https://SLACK.COM/x|label> <https://files.slack-files.com/f|file> <https://slack-files-gov.com/f|gov>",
    "<https://\u017flack.com/x|long s> <https://slac\u212a.com/x|kelvin> <https://slack-f\u0131les.com/x|dotless>",
    "<https://slack-f\u0130les.com/x|dotted> <https://notslack.example/x|not> <https://slack.com.example.com/x|sub>",
    "<https://acme.slack.com\n/x|newline> <https://acme.slack.com./x|dot> <https://slack.co/x|co>",
    "<http://[::1]/|v6> <http://[::1/|open> <http://::1]/|close> <http://[1.2.3.4]/|v4> <http://[v1.x]/|future>",
    "<http://[fe80::1%25eth0]/|zone> <http://[vz.x]/|badfuture> <http://x[::1]/|before> <http://[::1]x/|after>",
    "<http://\u2100.example/|nfkc> <http://\u2488.example/|nfkc dot> <http://ex\u00e4mple.com/|umlaut>",
    "<mailto:ada@example.com|mail> <ftp://example.com|ftp> <example.com|bare> <//example.com/x|relative>",
    "<https://user:pw@acme.slack.com/x|userinfo> <https://slack.com@example.com/x|at> <https://example.com:443/x|port>",
    "<https://example.com/?q=slack.com|query> <https://example.com/#slack%2Ecom|fragment> <https://example.com/slack:/x|path>",
    "<https://example.com|a|b> <a|<b>> <|empty target> <https://example.com|> <<https://example.com|nested>>",
    "no links at all, &amp; &lt;b&gt;",
    "<https://example.com|line\nbreak> <\thttps://slack.com/x|tab> < https://example.com|space>",
    "<SLACK://channel?id=C1|upper scheme> <sl.ack://x|dotted scheme> <1http://slack.com|digit scheme>",
    "<http://[::ffff:1.2.3.4]/|mapped> <http://[1:2:3:4:5:6:7:8]/|full> <http://[1:2:3:4:5:6:7:8:9]/|nine>",
    "<http://[1::2::3]/|two gaps> <http://[:1:2:3:4:5:6:7]/|leading> <http://[1:2:3:4:5:6:7:]/|trailing>",
    "<http://[12345::]/|long hextet> <http://[g::]/|bad hex> <http://[::1%]/|empty zone> <http://[::1%a%b]/|two zones>",
    "<http://[1:2:3:4:5:6:1.2.3.4]/|v4 tail> <http://[::1.2.3.04]/|leading zero> <http://[::256.1.1.1]/|octet>",
    "<http://[" + "0" * 46 + "::]/|too long> <http://[::]/|unspecified> <http://[V1.x]/|upper future>",
]

WRITTEN = [
    "see https://acme.slack.com/archives/C0GENERAL1/p1727780000000100",
    "slack.com/archives/C1",
    "acme.slack%2Ecom/archives",
    "acme.slack&#46;com/archives",
    "acme.slack\uff0ecom/archives",
    "acme.slack\u200b.com",
    "acme.slack\\.com",
    "files.slack-files.com/x",
    "https://acme.slack-gov.com/archives/C0PRIVATE1/p1",
    "slack://channel?team=T0ACME&id=C0PRIVATE1",
    "bell\x07",
    "*Done* & <!channel> <@U0ADA> <https://x|y>\n- next",
    "\u017flack.com",
    "slac\u212a.com",
    "slack-f\u0131les.com",
    "SLACK:/x",
    "slack.co",
    "tab\tand\r\nnewlines",
    "del\x7f",
    "slack%252Ecom",
    "slack%25252Ecom",
    "slack%2525252Ecom",
    "\uff53\uff4c\uff41\uff43\uff4b.com",
    "plain words",
]

URLS = [
    "https://acme.slack.com/x",
    "HTTPS://ACME.Slack.COM/x",
    "slack://channel?id=C1",
    "//example.com/x",
    "example.com",
    "mailto:ada@example.com",
    "http://[::1]:80/",
    "http://[::1/",
    "http://::1]/",
    "http://[1.2.3.4]/",
    "http://[v1.x]/",
    "http://[vz.x]/",
    "http://[fe80::1%eth0]/",
    "http://[fe80::1%ETH0]/",
    "http://x[::1]/",
    "http://[::1]x/",
    "http://[::1]:x/",
    "http://\u2100.example/",
    "http://\u2488.example/",
    "http://ex\u00e4mple.com/",
    "http://EX\u00c4MPLE.com/",
    "http://\u0130.example/",
    "http://\u03a3\u03a3.example/",
    "https://user:pw@Acme.Slack.com:443/x",
    "https://a@b@c.example/",
    "  https://example.com/",
    "\x00\x1fhttps://example.com/",
    "ht\ttp://exa\nmple.com/",
    "1http://example.com/",
    "sl.ack://x",
    "-a://x",
    "://x",
    "http:",
    "http://",
    "http://:80/",
    "http://[]/",
    "http://[:]/",
    "http://[::]/",
    "http://[v1.]/",
    "http://[v.x]/",
    "http://[::ffff:1.2.3.4]/",
    "http://[1:2:3:4:5:6:7:8:9]/",
    "http://[1::2::3]/",
    "http://[12345::]/",
    "http://[::1%]/",
    "http://[::1%a%b]/",
    "http://[1:2:3:4:5:6:1.2.3.4]/",
    "http://[::1.2.3.04]/",
    "http://[::1.2.3]/",
    "http://[" + "0" * 46 + "::]/",
    "http://[1:2:3:4:5:6:7::]/",
    "http://[::2:3:4:5:6:7:8]/",
    "http://[1:2:3:4:5:6:7::8]/",
    "http://[1:2:3:4::5:6:7:8]/",
    "http://[::1/]/",
    "http://[::1]/[x]",
    "http://a]b[c/",
    "http://[a]b[c]/",
    "http://host%41.example/",
    "http://\uff21.example/",
    "http://exa\u00admple.com/",
    "http://x/\u2100",
    "http://x?\u2100",
    "http://\u2100@x/",
]

FOLDED = ["Stra\u00dfe", "\u0391\u03a3\u0391\u03a3", "\u03c3\u03c2", "\ufb01le", "\u13a0\uab70", "\u0130", "K\u212a", "general", "\u1e9e", "\u0149"]

CHANNELS = [
    {"id": "C1"},
    {"id": "C1", "name": "general", "is_channel": True, "is_member": "true", "num_members": "3"},
    {"id": "C1", "is_channel": 1, "is_private": 0.0, "num_members": 3.0},
    {"id": "C1", "is_channel": 2},
    {"id": "C1", "is_channel": "yes", "is_member": "off", "num_members": " 1_000 "},
    {"id": "C1", "is_member": None, "num_members": None},
    {"id": "C1", "is_private": None},
    {"id": "C1", "num_members": 1.5},
    {"id": "C1", "num_members": "1.0"},
    {"id": "C1", "num_members": "1."},
    {"id": "C1", "num_members": True},
    {"id": "C1", "topic": {"value": "t", "creator": "U1"}, "purpose": None},
    {"id": "C1", "topic": {}},
    {"id": "C1", "topic": "plain"},
    {"id": "C1", "topic": {"value": None}},
    {"id": 1},
    {"name": "x"},
    {"id": "C1", "name": None},
    {"id": "C1", "is_channel": "TRUE", "is_group": "N", "is_im": "F", "is_mpim": "0"},
    {"id": "C1", "is_channel": " true"},
    {"id": "C1", "is_channel": ""},
    {"id": "C1", "unknown": {"deep": [1]}},
]

MESSAGES = [
    {"ts": "1"},
    {"ts": "1", "text": None},
    {"ts": 1},
    {"ts": "1", "reply_count": "2", "reactions": [{"name": "x", "count": "3"}, {}], "files": [{"id": "F1", "size": "10"}]},
    {"ts": "1", "edited": {"user": "U1"}, "attachments": [{}, {"a": 1}], "blocks": []},
    {"ts": "1", "edited": [], "attachments": []},
    {"ts": "1", "attachments": [[]]},
    {"ts": "1", "attachments": {}},
    {"ts": "1", "reactions": [{"count": 1.5}]},
    {"ts": "1", "files": [None]},
    {"ts": "1", "user": None, "bot_id": "B1", "username": "bot", "subtype": "bot_message", "type": "message"},
    {"ts": "1", "user": 5},
]

USERS = [
    {"id": "U1"},
    {"id": "U1", "profile": {"display_name": "ada"}, "real_name": "Ada", "name": "a"},
    {"id": "U1", "profile": {}, "real_name": "", "name": "a"},
    {"id": "U1", "profile": {"real_name": "Profile"}, "name": "a"},
    {"id": "U1", "profile": None, "deleted": "yes"},
    {"id": "U1", "profile": "x"},
]

IDENTITIES = [
    {"ok": True, "team_id": "T1", "user_id": "U1"},
    {"team_id": "T1", "user_id": "U1", "team": "Acme", "user": "bot", "is_enterprise_install": "false"},
    {"team_id": "T1"},
    {"team_id": "T1", "user_id": "U1", "team": None},
]

# Text read as an int (`num_members` and the like), pydantic-core's rules.
INT_TEXTS = [
    "3", " 3 ", "+3", "-3", "03", "-03", "+03", "00", "-0", "0", "",
    "1_000", "1__000", "_1", "1_", "-_1", "-1_0", "0_1", "0__1", "0_0_1", "000_1", "0_", "0__", "_",
    "0-1", "00-1", "0_-1", "0-_1", "0-_12", "0-01", "0-0", "0-00", "0-0_1", "0-__1", "0--1", "0+1", "0-",
    "+0-1", "+0-01", "+-1", "-+1", "+_1", "+0_1", "+1_2", "-0-1", "-0__1", "-00_1",
    "1.0", "1.00", "1.", ".0", "1.01", "0.0", "-0.0", "1_000.0", "1.0_0", "0_.0", "0-1.0", "0-01.0", "+0-1.0",
    "0x1", "1e3", "1 0", "0\t-1", "١", "１", " 3 ",
    "9007199254740993", "-9223372036854775809", "1" * 19, "00" + "1" * 20, "1" * 18 + "__1", "1" * 20 + "_",
    "1" * 4300, " " + "1" * 4300 + " ", "1" * 4301, "0" * 4300 + "1", "0" * 10000, "+" + "0" * 4300, "0" * 5000 + "1_000.0",
]


def int_text(text: str) -> dict:
    """What Channel.num_members becomes for this text, as decimal digits, or an error."""
    try:
        value = client.Channel.model_validate({"id": "C1", "num_members": text}).num_members
    except ValidationError:
        return {"in": text, "error": True}
    return {"in": text, "out": str(value)}


POSTED = [{"ok": True}, {"channel": "C1", "ts": "1.2"}, {"channel": 1, "ts": "1.2"}, {"ts": None}, {"ts": 5}]

CODES = sorted(
    client.UNAUTHORIZED | client.RATE_LIMITED | client.FORBIDDEN | client.NOT_FOUND | client.REJECTED
) + ["not_in_channel", "is_archived", "invalid_cursor", "internal_error", "something_new", "", 5, None]


def attempt(function, *args):
    try:
        return {"out": function(*args)}
    except ValueError as error:
        return {"error": str(error)}


def model(cls, value) -> dict:
    try:
        parsed = cls.model_validate(value)
    except ValidationError:
        return {"in": value, "error": True}
    return {"in": value, "out": parsed.model_dump()}


def user(value) -> dict:
    out = model(client.User, value)
    if "error" not in out:
        out["shown"] = client.User.model_validate(value).shown_name
    return out


def split(url: str) -> dict:
    try:
        parts = urlsplit(url)
    except ValueError:
        return {"in": url, "error": True}
    return {"in": url, "scheme": parts.scheme, "netloc": parts.netloc, "hostname": parts.hostname}


def error_for(code) -> list:
    error = client.error_for("Slack", code)
    return [code, error.code, str(error)]


def without_titles(value):
    if isinstance(value, dict):
        return {key: without_titles(item) for key, item in value.items() if key != "title"}
    if isinstance(value, list):
        return [without_titles(item) for item in value]
    return value


def declaration() -> dict:
    """What the connector declares, every string verbatim, and its inputs' JSON Schema without titles."""
    slack = connector.SlackConnector
    auth = slack.auth
    return {
        "slug": slack.slug,
        "name": slack.name,
        "kinds": [
            {
                "id": kind.id,
                "label": kind.label,
                "actions": list(kind.actions),
                "wildcard": kind.wildcard,
                "hierarchical": kind.hierarchical,
                "note": kind.note,
                "listed": kind.listed,
            }
            for kind in slack.kinds
        ],
        "actions": [{"id": action.id, "label": action.label, "requires": action.requires} for action in slack.actions],
        "auth": {
            "type": "oauth2",
            "app": auth.app,
            "authorizeUrl": auth.authorize_url,
            "tokenUrl": auth.token_url,
            "scopes": list(auth.scopes),
            "scopeSeparator": auth.scope_separator,
            "registrationUrl": auth.registration_url,
            "authorizeParams": [list(param) for param in auth.authorize_params],
            "loginHint": auth.login_hint,
            "clientAuth": auth.client_auth,
            "jsonBody": auth.json_body,
            "pkce": auth.pkce,
        },
        "browsable": list(getattr(slack, "browsable", ())),
        "operations": [
            {
                "name": op.name,
                "title": op.title,
                "description": op.description,
                "needs": [list(need) for need in op.needs],
                "outputAction": op.output_action,
                "consent": None if op.consent is None else [sorted(option) for option in op.consent],
                "revision": op.revision,
                "mutates": op.mutates,
                "paginated": op.paginated,
                "input": without_titles(op.input_model.model_json_schema()),
            }
            for op in slack.operations
        ],
    }


TIME = "2024-10-01T10:50:00Z"
INPUTS = {
    "list_channels": [
        {},
        None,
        {"limit": 1},
        {"limit": 0},
        {"limit": 201},
        {"limit": 1.5},
        {"limit": True},
        {"limit": "5"},
        {"cursor": "  p2  "},
        {"cursor": "x" * 501},
        {"cursor": None},
        {"cursor": ""},
        {"extra": 1, "limit": 0, "other": None},
    ],
    "read_channel": [
        {"channel": "#General"},
        {"channel": "  general  "},
        {"channel": "C0GENERAL1", "after": TIME, "before": " 2024-10-01T12:00:00+02:00 "},
        {"channel": "#general", "after": "2024-10-01", "before": None, "cursor": "c", "limit": 100},
        {"channel": "a.b"},
        {"channel": ""},
        {"channel": "#"},
        {"channel": "x" * 82},
        {"channel": 5},
        {"after": "yesterday"},
        {"channel": "#general", "after": ""},
        {"channel": "#general", "after": "x" * 41},
        {"channel": "#general", "limit": 101, "after": "bad", "extra": 1, "other": 2},
        {"channel": "#gen\ud800"},
        {"channel": "#\U0001f989" * 1},
    ],
    "read_thread": [
        {"channel": "#general", "thread": "1727780000.000100"},
        {"channel": "#general", "thread": " 1727780000.000100 ", "limit": 1},
        {"channel": "#general", "thread": "١٧٢٧٧٨٠٠٠٠.٠٠٠١٠٠"},
        {"channel": "#general", "thread": "1727780000"},
        {"channel": "#general", "thread": "1" * 21},
        {"channel": "#general"},
        {"thread": "x", "channel": "a b"},
    ],
    "post_message": [
        {"channel": "#general", "text": "  Hi <!channel> & <@U0ADA>  "},
        {"channel": "#general", "text": "see slack.com"},
        {"channel": "#general", "text": "bell\x07"},
        {"channel": "#general", "text": "   "},
        {"channel": "#general", "text": "x" * 4001},
        {"channel": "#general", "text": "tab\tand\r\nnewline"},
        {"channel": "#general", "text": "\U0001f989" * 4000},
        {"channel": "#general", "text": "\U0001f989" * 4001},
        {"channel": "#general", "text": "x" * 4001 + "\x07"},
        {"channel": "#general", "text": "x\x07 slack.com"},
        {"text": "hi"},
    ],
    "reply": [
        {"channel": "#general", "thread": "1727780050.000300", "text": " ok "},
        {"channel": "#general", "thread": "bad", "text": "slack.com"},
        {"channel": "#general", "thread": "1727780050.000300", "text": "ſlack.com"},
        {"channel": "a.b", "thread": "1727780050.000300", "text": "ok", "broadcast": True},
    ],
}


def validation_message(error: ValidationError) -> str:
    """connectors/executor.py's `validation_message`, which imports more than this script loads."""
    problems = [
        f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]
    ]
    return "Invalid arguments. " + "; ".join(problems)


def validated(name: str, raw) -> dict:
    """What the executor hashes for these arguments (`model_dump()`), or the message it refuses them with."""
    op = next(op for op in connector.SlackConnector.operations if op.name == name)
    try:
        data = op.input_model.model_validate(raw if raw is not None else {})
    except ValidationError as error:
        return {"in": raw, "error": validation_message(error)}
    return {"in": raw, "out": data.model_dump()}


LOWER_WORDS = [
    "General",
    "ΑΣ",
    "ΑΣ Α",
    "ΣΑ",
    "ΑΣ́",
    "İstanbul",
    "ꟋꟌ꟎Ꟛ",
    "ǅKΩ",
    "\U00010400\U0001e900",
]


def lowered() -> list:
    """Every code point `str.lower()` changes, with what it becomes."""
    pairs = []
    for point in range(sys.maxunicode + 1):
        if 0xD800 <= point <= 0xDFFF:
            continue
        char = chr(point)
        if char.lower() != char:
            pairs.append([point, char.lower()])
    return pairs


def decimals() -> list:
    """The ranges of decimal digits (Nd), which `\\d` matches and `float()` reads."""
    ranges: list[list[int]] = []
    for point in range(sys.maxunicode + 1):
        if unicodedata.category(chr(point)) == "Nd":
            if ranges and ranges[-1][1] == point - 1:
                ranges[-1][1] = point
            else:
                ranges.append([point, point])
    return ranges


def casefolds() -> list:
    pairs = []
    for point in range(sys.maxunicode + 1):
        if 0xD800 <= point <= 0xDFFF:
            continue
        char = chr(point)
        if char.casefold() != char.lower():
            pairs.append([point, char.casefold()])
    return pairs


def main() -> None:
    vectors = {
        "unicode": unicodedata.unidata_version,
        "declaration": declaration(),
        "inputs": {name: [validated(name, raw) for raw in cases] for name, cases in INPUTS.items()},
        "moments": [{"in": value, **attempt(connector._moment, value)} for value in MOMENTS],
        "times": [{"in": value, "out": connector._time(value)} for value in TIMES],
        "channel_names": [{"in": value, **attempt(connector._channel_name, value)} for value in CHANNEL_NAMES],
        "ts": [{"in": value, **attempt(connector._ts, value)} for value in TS],
        "redacted": [{"in": value, "out": mrkdwn.redact(value)} for value in REDACTED],
        "written": [{"in": value, **attempt(mrkdwn.check_written, value)} for value in WRITTEN],
        "urls": [split(value) for value in URLS],
        "folded": [{"in": value, "out": value.casefold()} for value in FOLDED],
        "casefold": casefolds(),
        "lowered": lowered(),
        "lower_words": [{"in": word, "out": word.lower(), "folded": word.casefold()} for word in LOWER_WORDS],
        "decimals": decimals(),
        "channels": [model(client.Channel, value) for value in CHANNELS],
        "messages": [model(client.Message, value) for value in MESSAGES],
        "users": [user(value) for value in USERS],
        "identities": [model(client.Identity, value) for value in IDENTITIES],
        "posted": [model(client.Posted, value) for value in POSTED],
        "int_texts": [int_text(text) for text in INT_TEXTS],
        "errors": [error_for(code) for code in CODES],
    }
    (HERE / "vectors.json").write_text(json.dumps(vectors, indent=1, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
