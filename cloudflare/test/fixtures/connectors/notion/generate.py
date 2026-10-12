"""Writes vectors.json: what today's Notion connector computes, for the TypeScript port's tests.

The pure parts of backend/connectors/notion/ (ids and links, page text redaction, written-text checks,
edit planning, property values and filters, rich text) and its operation inputs (normalized arguments or
the validation message the executor words), over hand-picked cases and seeded random ones. The notion
package imports no Django and no configuration.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/notion/generate.py
"""

import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))

from pydantic import ValidationError  # noqa: E402

from connectors.base import OperationError  # noqa: E402
from connectors.notion import client, markdown, pages, properties, reads, writes  # noqa: E402
from connectors.notion.client import has_titled_mention, text_of  # noqa: E402
from connectors.notion.connector import NotionConnector  # noqa: E402

HEX = "0123456789abcdef"


def validation_message(error: ValidationError) -> str:
    """connectors/executor.py `validation_message`."""
    problems = [f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]]
    return "Invalid arguments. " + "; ".join(problems)


def outcome(fn, *args):
    try:
        return {"ok": fn(*args)}
    except OperationError as error:
        return {"error": {"code": error.code, "message": error.message}}
    except ValueError as error:
        return {"value_error": str(error)}


ID = "0000000000000000000000000000000a"
UPPER = "ABCDEF0123456789ABCDEF0123456789"

CANONICAL = [
    ID,
    ID.upper(),
    "00000000-0000-0000-0000-00000000000a",
    "00000000-0000-0000-0000-00000000000A",
    "000000000000-0000-0000-00000000000a",
    "00000000-00000000-0000-00000000000a",
    "00000000--0000-0000-0000-00000000000a",
    "-00000000-0000-0000-0000-00000000000a",
    "nope",
    "",
    ID + "\n",
    ID + "0",
    "g" + ID[1:],
    "\uff10" * 32,
    "\u0660" * 32,
    UPPER,
]

OBJECT_IDS = [
    ID,
    UPPER,
    f"https://www.notion.so/acme/Plan-{ID}",
    f"https://notion.so/Plan-{ID}?pvs=4",
    f"https://acme.notion.site/{ID}",
    f"https://ACME.Notion.Site/{ID}",
    f"HTTPS://WWW.NOTION.SO/{UPPER}",
    f"https://evil.example/{ID}",
    f"http://www.notion.so/{ID}",
    "https://www.notion.so/x",
    f"https://www.notion.so/{ID}/",
    f"https://www.notion.so/{ID}///",
    f"https://www.notion.so/{ID}#frag",
    f"https://www.notion.so/a/{ID}?q=1#f",
    f"https://www.notion.so/{ID}x",
    f"https://www.notion.so/x{ID}",
    f"https://www.notion.so/{ID[:-1]}",
    f"https://user:pass@www.notion.so/{ID}",
    f"https://evil.example@www.notion.so/{ID}",
    f"https://www.notion.so@evil.example/{ID}",
    f"https://www.notion.so:8080/{ID}",
    f"https://www.notion.so.evil.example/{ID}",
    f"https://notion.site/{ID}",
    f"https://.notion.site/{ID}",
    f"https://evilnotion.site/{ID}",
    f"https://a.b.notion.site/{ID}",
    f"https://[::1]/{ID}",
    f"https://[www.notion.so]/{ID}",
    f"https://a[b]@www.notion.so/{ID}",
    f"https://a[@www.notion.so/{ID}",
    f"https://www.notion.so]/{ID}",
    f"\x01\x02 https://www.notion.so/{ID}",
    f"htt\tps://www.no\ntion.so/{ID}\r",
    f"https:/www.notion.so/{ID}",
    f"https:www.notion.so/{ID}",
    f"//www.notion.so/{ID}",
    f"https://www.notion.so?{ID}",
    f"https://www.notion.so#{ID}",
    f"https://www.notion.so/{ID}%0A",
    f"https://www.\u2100notion.so/{ID}",
    f"https://www.n\u2100otion.so/{ID}",
    f"https://www.no\ufe55tion.so/{ID}",
    f"https://\uff57ww.notion.so/{ID}",
    f"https://WWW.NOT\u0130ON.SO/{ID}",
    f"https://www.notion.so%2f/{ID}",
    f"httpſ://www.notion.so/{ID}",
    f"https://www.notion.so/\u00e9-{ID}",
    f"1https://www.notion.so/{ID}",
    f"h+s://www.notion.so/{ID}",
    f"https://www.notion.so\\{ID}",
    f"https://acme.notion.site:/{ID}",
    f"https://:443@acme.notion.site/{ID}",
    f"https://[v1.notion.site]/{ID}",
    f"https://[V1.NOTION.SITE]:443/{ID}",
    f"https://[v1.notion.site]x/{ID}",
    f"https://x[v1.notion.site]/{ID}",
    f"https://[vz.notion.site]/{ID}",
    f"https://[v1.]/{ID}",
    f"https://[v1.notion.site/{ID}",
    f"https://a[b]@va.notion.site/{ID}",
    f"https://a[b]@va.notion.site:x/{ID}",
    f"https://a[b]@www.notion.so/{ID}",
    f"https://[::1]@acme.notion.site/{ID}",
    f"https://[1.2.3.4]/{ID}",
    f"https://[fe80::1%25eth0]/{ID}",
    f"https://[v1.notion.site\u2028]/{ID}",
    f"https://x%A.NOTION.SITE/{ID}",
    f"https://x%a.notion.site/{ID}",
]

URL = f"https://www.notion.so/Secret-plans-{ID}"

REDACT = [
    "",
    "plain",
    f'<page url="{URL}">Private plans</page>',
    f'<page url="{URL}">Private plans</page> after',
    "<page>Secret\nmore",
    "a <page>Secret\nmore",
    '<mention-page url="u" title="Secret">\nSecret\n</mention-page>',
    'a <mention-page url="u">Secret</mention-page> b',
    '<mention-page url="u"/>',
    '<mention-page url="u" / >',
    "<PAGE url='x'>T</PAGE>",
    '<Page url="x">T</pAGE >',
    '<page url="x">T</page\n>',
    '<page\turl="x">T</page>',
    '<page\x1curl="x">T</page>',
    '<page\x85url="x">T</page>',
    '<page\ufeffurl="x">T</page>',
    '<page\u2028url="x">T</page>',
    "<pages>not a tag</pages>",
    "<page-x>x</page-x>",
    "<mentıon-page url=\"u\">Secret</mention-page> rest",
    "<mention-page url=\"u\">Secret</mentıon-page> rest",
    "<mentİon-page url=\"u\">Secret</mention-page> rest",
    "<mention-page url=\"u\">Secret</menti\u0307on-page> rest",
    "<database url=\"u\">Projects</database><database>Other</database>",
    '<mention-database url="u">D</mention-database>',
    '<mention-data-source url="u">D</mention-data-source>',
    '<mention-agent url="u">A</mention-agent>',
    '<mention-user url="u">Ada</mention-user>',
    '<page xurl="no" url="yes">T</page>',
    '<page data-url="no">T</page>',
    '<page éurl="no">T</page>',
    '<page _url="no">T</page>',
    "<synced_block_reference url='x'>\nleft open",
    "Mine\n<synced_block_reference url='x'>\n```xml\n</synced_block_reference>\n```\nSecret acquisition plan\n</synced_block_reference>\nAfter",
    "a</synced_block_reference>b<synced_block_reference>c",
    "[x](https://acme.notion.site/Secret-deal-" + "a" * 32 + "?pvs=4)",
    "https://www.notion.so/" + UPPER,
    "HTTPS://WWW.NOTION.SO/Title-" + UPPER + "#x",
    "httpſ://www.notion.so/Title-" + ID,
    "https://www.notıon.so/Title-" + ID,
    "https://ſub.notion.site/Title-" + ID,
    "https://\u212aey.notion.site/Title-" + ID,
    "https://www.notion.so/Title-" + ID + "0",
    "https://www.notion.so/Title-" + ID + "g rest",
    "https://www.notion.so/" + ID + ID,
    "(https://www.notion.so/a-" + ID + ")",
    "https://www.notion.so/a b-" + ID,
    "https://www.notion.so/a\u3000-" + ID,
    "https://evil.example/" + ID,
    "https://notion.so.evil.example/" + ID,
    "😀<page url=\"u\">😀</page>😀 https://www.notion.so/😀-" + ID,
    "\ud800<page url=\"u\">x</page>",
]

WRITTEN = [
    "![x](https://evil.example/p.png)",
    '<page url="https://www.notion.so/x">Moved</page>',
    "<DATABASE>x</DATABASE>",
    '<synced_block_reference url="https://www.notion.so/x"></synced_block_reference>',
    '<mention-user url="user://1"/>',
    '<video src="https://evil.example/v.mp4"></video>',
    '<callout icon="x" src="https://evil.example/">hi</callout>',
    '<mention-page url="https://evil.example/x">t</mention-page>',
    "<embed>x</embed>",
    "# Title\n- [link](https://example.com)\n<callout>Note</callout>",
    '<mention-page url="https://www.notion.so/x-0000000000000000000000000000000a"/>',
    "a < b and c > d",
    '<mention-page url="https://acme.notion.site/x"/>',
    '<mention-page url="https://ACME.notion.site/x"/>',
    '<mention-page url="https://www.notion.so/x" extra="1"/>',
    '<mention-page  url="https://www.notion.so/x"  /  >',
    '<mention-page\x1curl="https://www.notion.so/x">',
    '<mention-page\ufeffurl="https://www.notion.so/x">',
    "<mention-page>",
    "<mention-page   >",
    "<mention-page\x85>",
    "<Mention-Page url=\"https://evil.example\">",
    "<mention-database url=\"https://www.notion.so/d\">x</mention-database>",
    "< img src=x>",
    "</ iframe>",
    "<\x1cimg>",
    "<img\u212a>",
    "<lınk-preview>",
    "<LINK-PREVIEW>",
    "<link_preview>",
    "<a href=\"x\">",
    "<a xhref=\"x\">",
    "<a éhref=\"x\">",
    "<a -href=\"x\">",
    "<a HREF = \"x\">",
    "<a hrEF\u2028=\"x\">",
    "<a hrſ=\"x\">",
    "<a ſrc=\"x\">",
    "<a action=x>",
    "<a srcset=x>",
    "<a srcsetx=x>",
    "<a data=x>",
    "<a data-x=x>",
    "<a poster  =x>",
    "<x:y src=x>",
    "<1img>",
    "<é img>",
    "!![![",
    "!\n[",
    "",
    "plain text",
]


def random_markdown(rng: random.Random) -> str:
    hexes = "".join(rng.choice(HEX) for _ in range(32))
    pieces = [
        f'<page url="https://www.notion.so/T-{hexes}">Title</page>',
        "<page>",
        "</page>",
        "<PAGE url='x'/>",
        '<database url="u">Projects</database>',
        '<mention-page url="u">Secret</mention-page>',
        '<mention-page url="https://www.notion.so/x"/>',
        "<Mention-Database>",
        "<synced_block_reference url=\"x\">",
        "</synced_block_reference>",
        f"https://acme.notion.site/Secret-{hexes}",
        f"[link](https://www.notion.so/{hexes}?pvs=4)",
        "![img](https://evil.example/x.png)",
        '<img src="x">',
        "<callout>",
        "</callout>",
        '<callout icon="x" src="y">',
        "```",
        "```py",
        "~~~",
        "`",
        "line",
        "Repeated",
        "Repeated",
        "word",
        "Intro line",
        "\n",
        "\n",
        "\n",
        " ",
        "\t",
        "<",
        ">",
        "!",
        "[",
        "ſ",
        "\u212a",
        "\u0130",
        "\u0131",
        "<mentıon-page>",
        "\x1c",
        "\x85",
        "\u2028",
        "\ufeff",
        "é",
        "😀",
        "\u0662",
        "$&",
        "$1",
    ]
    return "".join(rng.choice(pieces) for _ in range(rng.randint(1, 30)))


def random_page(rng: random.Random) -> str:
    """A page of mostly plain lines, so most random edits get as far as the checks that come late."""
    words = ["Intro", "line", "Repeated", "middle", "End", "word", "x", "a", "b", "`code`", "😀", "é", "$&"]
    special = [
        f'<page url="https://www.notion.so/T-{ID}">Title</page>',
        f"https://acme.notion.site/Secret-{ID}",
        "![img](https://evil.example/x.png)",
        "```",
        "```py",
        "`",
        "<callout>",
        '<img src="x">',
        " ",
        "\x1c",
    ]
    lines = []
    for _ in range(rng.randint(1, 12)):
        line = " ".join(rng.choice(words) for _ in range(rng.randint(1, 4)))
        if rng.random() < 0.15:
            line += rng.choice(special)
        lines.append(line)
    return "\n".join(lines)


def plan_cases(rng: random.Random) -> list:
    cases = []
    home = "\n".join(
        [
            "# Home",
            "Intro line",
            f'<page url="https://www.notion.so/private-{ID}">Private plans</page>',
            f'<database url="https://www.notion.so/projects-{ID}">Projects</database>',
            "Repeated",
            "middle",
            "Repeated",
            "End",
        ]
    )
    fixed = [
        (home, [("Intro", "Opening")]),
        (home, [("Repeated", "x")]),
        (home, [("Repeated\nEnd", "Done\nEnd")]),
        (home, [("Private plans", "x")]),
        (home, [("Projects</database>", "x")]),
        (home, [("</page>", "x")]),
        (home, [("Intro", "Opening"), ("Opening", "Start")]),
        (home, [("Intro", "$& $1 $$")]),
        ("Start\nX[caption](https://evil.example/p.png)\nEnd", [("X", "!")]),
        ("Start\nA\nsrc=https://evil.example/p.png>\nEnd", [("A", "<img")]),
        ('Start\n```xml\n<img src="https://evil.example/p.png">\n```\nEnd', [("```xml", "Code:")]),
        ("Start\nsee `a\nb` here\nEnd", [("see `a", "see a")]),
        ("Start\nText ![i](https://example.com/i.png)\nEnd", [("Text", "Words")]),
        ("Start\n```py\nx = 1\n```\nEnd", [("x = 1", "x = 2")]),
        ("Start\n```py\nx = 1\n```\nEnd", [("End", "Use `x` here")]),
        ("a\nb\na\nb\nc", [("b", "x")]),
        ("a\na\na", [("a", "x")]),
        ("x\na\nb\nx\na\nc", [("a", "y")]),
        ("😀\nab\n😀\nab\nc", [("ab", "x")]),
        ("A\nhttps://www.notion.so/T-" + ID + "\nB", [("A", "x")]),
        ("A https://www.notion.so/T-" + ID + "\nB", [("A", "x")]),
        ("line\r\nline2\u2028x", [("line2", "y")]),
        ("```\n```\nx", [("x", "y")]),
        ("  ```\nx\n  ```", [("x", "```")]),
        ("a\n" * 30 + "b", [("a", "x")]),
        ("<synced_block_reference>x</synced_block_reference>\nOK", [("OK", "y")]),
        ("ok <PAGE>t</PAGE>\nnext", [("ok", "y")]),
        ("ok </page \nnext", [("ok", "y")]),
        ("ok <pagex\nnext", [("ok", "y")]),
        ("first\nsecond", [("first", "<img src=x>")]),
        ("first\nsecond", [("first", "")]),
    ]
    for page, edits in fixed:
        cases.append([page, [list(edit) for edit in edits]])
    for index in range(300):
        page = random_markdown(rng) if index % 3 == 0 else random_page(rng)
        visible = markdown.redact(page)
        edits = []
        for _ in range(rng.choice([1, 1, 1, 2, 3])):
            if visible and rng.random() < 0.85:
                start = rng.randrange(len(visible))
                old = visible[start : start + rng.randint(1, 12)]
            else:
                old = rng.choice(["Repeated", "line", "x", "\n", "word"])
            replacement = rng.choice(["new", "", "`", "```", "!", "two words", "<img", "[x](y)", "$1"])
            edits.append([old, random_markdown(rng) if rng.random() < 0.2 else replacement])
        cases.append([page, edits])
    return cases


SCHEMA = {
    "Name": {"id": "title", "type": "title", "title": {}},
    "Status": {"id": "st", "type": "status", "status": {"options": [{"name": "Todo"}, {"name": "Done"}]}},
    "Tags": {"id": "tg", "type": "multi_select", "multi_select": {"options": [{"name": "a"}, {"name": "b"}, {"name": "1"}]}},
    "Kind": {"id": "kd", "type": "select", "select": {"options": [{"name": "x"}, {"id": "no-name"}, "bad", {"name": 5}]}},
    "Due": {"id": "du", "type": "date", "date": {}},
    "Budget": {"id": "bu", "type": "formula", "formula": {"expression": "secret"}},
    "Owner": {"id": "pp", "type": "people", "people": {}},
    "Related": {"id": "rl", "type": "relation", "relation": {}},
    "Notes": {"id": "nt", "type": "rich_text", "rich_text": {}},
    "Score": {"id": "sc", "type": "number", "number": {}},
    "Done": {"id": "dn", "type": "checkbox", "checkbox": {}},
    "Link": {"id": "ln", "type": "url", "url": {}},
    "Mail": {"id": "ml", "type": "email", "email": {}},
    "Phone": {"id": "ph", "type": "phone_number", "phone_number": {}},
    "Files": {"id": "fl", "type": "files", "files": {}},
    "Roll": {"id": "ro", "type": "rollup", "rollup": {}},
    "Created": {"id": "ct", "type": "created_time", "created_time": {}},
    "constructor": {"id": "cn", "type": "number", "number": {}},
    "__proto__": {"id": "pr", "type": "rich_text", "rich_text": {}},
    "Broken": [],
    "Untyped": {"id": "ut"},
    "BadType": {"id": "bt", "type": 5},
}

WRITES = [
    {"Name": "x", "Status": "Done", "Tags": ["a"], "Due": "2026-10-01"},
    {"Status": "Shipped"},
    {"Tags": ["a", "a"]},
    {"Tags": ["1", 1]},
    {"Tags": [1]},
    {"Tags": "a"},
    {"Tags": ["a"] * 101},
    {"Tags": []},
    {"Due": "tomorrow"},
    {"Due": "2026-10-01T10:00"},
    {"Due": "2026-10-01T10:00:00.123456+02:00"},
    {"Due": "2026-10-01T10:00:00.1234567Z"},
    {"Due": "\u0662\u0660\u0662\u0666-\u0661\u0660-\u0660\u0661"},
    {"Due": "2026-10-01\n"},
    {"Due": {"start": "2026-10-01", "end": "2026-10-02"}},
    {"Due": {"end": "2026-10-02"}},
    {"Due": {"start": "2026-10-01", "time_zone": "UTC"}},
    {"Due": {"start": 5}},
    {"Due": None},
    {"Due": 5},
    {"Owner": ["u1"]},
    {"Related": []},
    {"Budget": 1},
    {"Missing": 1},
    {"Name": 3},
    {"Name": None},
    {"Name": ""},
    {"Name": "😀" * 2000},
    {"Name": "😀" * 2001},
    {"Notes": None},
    {"Notes": ""},
    {"Notes": "x" * 2001},
    {"Score": 1.5},
    {"Score": None},
    {"Score": True},
    {"Score": "1"},
    {"Done": True},
    {"Done": 1},
    {"Link": ""},
    {"Link": None},
    {"Link": "https://example.com"},
    {"Link": 5},
    {"Mail": "a@example.com"},
    {"Phone": "x" * 2001},
    {"Kind": "x"},
    {"Kind": None},
    {"Kind": "no-name"},
    {"Kind": 5},
    {"Status": None},
    {"Files": []},
    {"Created": "x"},
    {"constructor": 1},
    {"__proto__": "x"},
    {"toString": 1},
    {"Broken": 1},
    {"Untyped": 1},
    {"st": "Done"},
    {"bu": 1},
    {"title": "x"},
]

FILTERS = [
    {"and": [{"property": "Status", "status": {"equals": "Done"}}, {"property": "tg"}]},
    [{"timestamp": "created_time", "direction": "descending"}],
    {"property": "Budget", "formula": {"number": {"greater_than": 10}}},
    {"or": [{"property": "bu"}]},
    {"property": "Missing"},
    {"property": 5},
    {"property": None},
    {"property": ["x"]},
    {"property": {"a": 1}},
    [{"property": "Budget", "direction": "ascending"}],
    {"property": "Name", "title": {"contains": "x"}},
    {"property": "title"},
    {"property": "constructor"},
    {"property": "__proto__"},
    {"property": "toString"},
    {"property": "Files"},
    {"property": "Owner"},
    None,
    5,
    "x",
    {},
    [],
    {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"property": "Status"}}}}}}}},
    {"a": {"b": {"c": {"d": {"e": {"f": {"g": {"h": {"property": "Status"}}}}}}}}},
    [[[[[[[[{"property": "Status"}]]]]]]]],
    [[[[[[[[[{"property": "Status"}]]]]]]]]],
]


def nested(depth: int) -> dict:
    value: dict = {"property": "Status"}
    for _ in range(depth):
        value = {"and": [value]}
    return value


PAGE_PROPERTIES = [
    {"X": {"type": []}, "Y": []},
    {"Related": {"type": "relation", "relation": [{"id": "a"}, "b", {"x": 1}], "has_more": True}},
    {"Related": {"type": "relation", "relation": [{"id": "a"}], "has_more": "yes"}},
    {
        "Name": {"type": "title", "title": [{"plain_text": "A"}, {"type": "mention", "plain_text": "Secret", "mention": {"type": "page", "page": {"id": "p1"}}}, "x", {"plain_text": 5}, {}]},
        "Status": {"type": "status", "status": {"name": "Done"}},
        "Sel": {"type": "select", "select": None},
        "Sel2": {"type": "select", "select": {"id": "x"}},
        "Multi": {"type": "multi_select", "multi_select": [{"name": "a"}, "b", {"id": "c"}]},
        "Multi2": {"type": "multi_select", "multi_select": {"name": "a"}},
        "Due": {"type": "date", "date": {"start": "2026-10-01", "extra": 1}},
        "Due2": {"type": "date", "date": "2026"},
        "Id": {"type": "unique_id", "unique_id": {"prefix": "ENG", "number": 5}},
        "Id2": {"type": "unique_id", "unique_id": {"prefix": "", "number": 5}},
        "Id3": {"type": "unique_id", "unique_id": {"prefix": None, "number": None}},
        "Id4": {"type": "unique_id", "unique_id": {"prefix": "X", "number": None}},
        "Id5": {"type": "unique_id", "unique_id": {"prefix": 5, "number": [1, "a", None, True, {"k": 1.5}]}},
        "Id6": {"type": "unique_id", "unique_id": {"prefix": ["x"], "number": 1}},
        "People": {"type": "people", "people": [{"name": "Grace"}, {"id": "u2", "name": ""}, {"id": "u3"}, "x", {"name": 5, "id": 7}]},
        "By": {"type": "created_by", "created_by": {"id": "u1", "name": "Ada"}},
        "By2": {"type": "last_edited_by", "last_edited_by": "x"},
        "Num": {"type": "number", "number": 1.5},
        "Num2": {"type": "number", "number": [1]},
        "Check": {"type": "checkbox", "checkbox": False},
        "Url": {"type": "url", "url": None},
        "Mail": {"type": "email", "email": "a@example.com"},
        "Time": {"type": "created_time", "created_time": "2026-10-01T00:00:00Z"},
        "Edited": {"type": "last_edited_time", "last_edited_time": {"x": 1}},
        "Formula": {"type": "formula", "formula": {"number": 1}},
        "Rollup": {"type": "rollup", "rollup": {}},
        "Files": {"type": "files", "files": []},
        "Text": {"type": "rich_text", "rich_text": "not a list"},
        "Missing": {"type": "rich_text"},
        "Agent": {"type": "rich_text", "rich_text": [{"type": "mention", "mention": {"type": "agent", "agent": {"id": "a1"}}}]},
        "User": {"type": "rich_text", "rich_text": [{"type": "mention", "plain_text": "@Ada", "mention": {"type": "user", "user": {"id": "u1"}}}]},
        "NoTarget": {"type": "rich_text", "rich_text": [{"type": "mention", "mention": {"type": "database", "database": "x"}}]},
    },
    "not a dict",
    [],
]

TEXTS = [
    [{"plain_text": "a"}, {"plain_text": "b"}],
    [{"type": "mention", "plain_text": "T", "mention": {"type": "page", "page": {"id": "p"}}}],
    [{"type": "mention", "plain_text": "T", "mention": {"type": "data_source", "data_source": {"id": 5}}}],
    [{"type": "mention", "plain_text": "T", "mention": {"type": "database"}}],
    [{"type": "mention", "plain_text": "T", "mention": {"type": "date"}}],
    [{"type": "mention", "plain_text": "T", "mention": "x"}],
    [{"type": "text", "plain_text": None}],
    "x",
    None,
    [1, None, "x", {"plain_text": "ok"}],
]


def random_value(rng: random.Random, depth: int = 0):
    choice = rng.randrange(9 if depth < 3 else 6)
    if choice == 0:
        return None
    if choice == 1:
        return rng.choice([True, False])
    if choice == 2:
        return rng.choice([0, 1, -5, 1.5, 2**40])
    if choice in (3, 4, 5):
        return rng.choice(["", "x", "Done", "2026-10-01", "😀", "a", "ENG", "u1"])
    if choice in (6, 7):
        return [random_value(rng, depth + 1) for _ in range(rng.randint(0, 3))]
    keys = ["name", "id", "start", "end", "time_zone", "prefix", "number", "plain_text", "type", "mention", "page"]
    return {rng.choice(keys): random_value(rng, depth + 1) for _ in range(rng.randint(0, 4))}


TYPES = sorted(properties.READABLE | {"formula", "rollup", "files", "button", ""})


def random_properties(rng: random.Random) -> dict:
    out = {}
    for index in range(rng.randint(0, 6)):
        kind = rng.choice(TYPES)
        prop = {"id": f"p{index}", "type": kind, kind: random_value(rng)}
        if rng.random() < 0.2:
            prop["has_more"] = rng.choice([True, False, 1])
        out[f"Prop{index}"] = prop
    return out


# Operation inputs: what the executor validates (OperationInput: strict, extra forbidden, strings stripped).
INPUTS = {
    "search": reads.Search,
    "get_page": reads.PageInput,
    "read_page": reads.ReadPage,
    "get_database": reads.DatabaseInput,
    "query_database": reads.QueryDatabase,
    "list_comments": reads.ListComments,
    "create_page": writes.CreatePage,
    "create_database_row": writes.CreateRow,
    "update_page_properties": writes.UpdateProperties,
    "edit_page": writes.EditPage,
    "append_to_page": writes.AppendToPage,
    "add_comment": writes.AddComment,
}

LINK = f"https://www.notion.so/acme/Plan-{ID}"
CANON = "00000000-0000-0000-0000-00000000000a"

ARGUMENTS = {
    "search": [
        {},
        None,
        {"text": "  launch  "},
        {"text": "a\nb"},
        {"text": "x" * 201},
        {"text": " " + "😀" * 200 + " "},
        {"text": None, "limit": 50, "cursor": " c "},
        {"limit": 0},
        {"limit": 51},
        {"limit": "5"},
        {"limit": True},
        {"cursor": "x" * 1001},
        {"connection_id": "x"},
        [],
        {"text": "\ufeffx\ufeff"},
        {"text": "\x85x\x85"},
        {"text": "\x1cx"},
    ],
    "get_page": [
        {"page_id": ID},
        {"page_id": f"  {LINK}  "},
        {"page_id": UPPER},
        {"page_id": "not an id"},
        {"page_id": "x" * 32},
        {"page_id": "x" * 301},
        {"page_id": f"https://evil.example/{ID}"},
        {"page_id": 5},
        {},
        {"page_id": ID, "extra": 1},
    ],
    "read_page": [
        {"page_id": ID},
        {"page_id": ID, "offset": 2, "max_chars": 4},
        {"page_id": ID, "offset": -1},
        {"page_id": ID, "offset": 10_000_001},
        {"page_id": ID, "max_chars": 0},
        {"page_id": ID, "max_chars": 100_001},
    ],
    "get_database": [{"database_id": LINK}, {"database_id": ""}],
    "query_database": [
        {"database_id": ID},
        {"database_id": ID, "data_source_id": CANON},
        {"database_id": ID, "data_source_id": None},
        {"database_id": ID, "data_source_id": "bad"},
        {"database_id": ID, "filter": {"property": "Status", "status": {"equals": "Done"}}},
        {"database_id": ID, "filter": {" property ": " x ", "and": [{" a ": 1}]}},
        {"database_id": ID, "filter": {"a": "x" * 7990}},
        {"database_id": ID, "filter": {"a": "x" * 7991}},
        {"database_id": ID, "filter": {"a": "\u00e9" * 1300}},
        {"database_id": ID, "filter": {"a": "\u00e9" * 1400}},
        {"database_id": ID, "filter": []},
        {"database_id": ID, "filter": "x"},
        {"database_id": ID, "filter": {}},
        {"database_id": ID, "filter": {"a": "\ud800", "\udc00": [1]}},
        {"database_id": ID, "sorts": [{"property": "Name"}]},
        {"database_id": ID, "sorts": [{"property": "Name"}] * 10},
        {"database_id": ID, "sorts": [{"property": "Name"}] * 11},
        {"database_id": ID, "sorts": [{"a": "x" * 8000}]},
        {"database_id": ID, "sorts": [{"a": "x" * 3990}, {"b": "x" * 3990}]},
        {"database_id": ID, "sorts": [1]},
        {"database_id": ID, "sorts": []},
        {"database_id": ID, "sorts": {"property": "Name"}},
        {"database_id": ID, "limit": 100, "cursor": "c25"},
        {"database_id": ID, "limit": 101},
    ],
    "list_comments": [{"page_id": ID}, {"page_id": ID, "cursor": ""}, {"page_id": ID, "cursor": "  c1  "}],
    "create_page": [
        {"parent_page_id": ID, "title": "Notes", "markdown": "Hello"},
        {"parent_page_id": ID, "title": "  Notes  ", "markdown": "  Hello\n  "},
        {"parent_page_id": ID, "title": "x", "markdown": f'<page url="{LINK}">Home</page>'},
        {"parent_page_id": ID, "title": "bad\ntitle"},
        {"parent_page_id": ID, "title": ""},
        {"parent_page_id": ID, "title": "   "},
        {"parent_page_id": ID, "title": "x" * 2001},
        {"parent_page_id": "not an id", "title": "x"},
        {"parent_page_id": f"https://evil.example/{ID}", "title": "x"},
        {"parent_page_id": ID, "title": "x", "markdown": ""},
        {"parent_page_id": ID, "title": "x", "markdown": "a\x00b"},
        {"parent_page_id": ID, "title": "x", "markdown": "a\tb\r\nc"},
        {"parent_page_id": ID, "title": "x", "markdown": "a\x00 ![x](y)"},
        {"parent_page_id": ID, "title": "x", "markdown": "![x](y) <img src=x>"},
        {"parent_page_id": ID, "title": "x", "markdown": "<img src=x> ![x](y)"},
        {"parent_page_id": ID, "title": "x", "markdown": None},
        {"parent_page_id": "bad", "title": "a\nb", "markdown": "![x](y)", "zz": 1},
        {"parent_page_id": ID, "title": "x", "markdown": "x" * 100_001},
        {"parent_page_id": ID, "title": "a\udc00"},
        {"parent_page_id": "\ud800" * 32, "title": "x", "markdown": "\udfff"},
    ],
    "create_database_row": [
        {"database_id": ID, "properties": {"Name": "Ship", "Status": "Done", "Tags": ["b"]}},
        {"database_id": ID, "properties": {}},
        {"database_id": ID, "properties": {f"p{i}": i for i in range(51)}},
        {"database_id": ID, "properties": {" Name ": " Ship ", "Name": "x"}},
        {"database_id": ID, "properties": {"a": "x" * 7990}},
        {"database_id": ID, "properties": {"a": "x" * 7991}},
        {"database_id": ID, "properties": {"Name": "x"}, "markdown": "![a](https://e.x/p)"},
        {"database_id": ID, "properties": []},
        {"database_id": ID, "properties": {"\ud800": 1, "a\udc00b": "x"}},
        {"database_id": ID, "properties": {"Name": "\ud800"}},
        {"database_id": ID},
    ],
    "update_page_properties": [
        {"page_id": ID, "properties": {"Status": "Done"}},
        {"page_id": ID, "properties": {"__proto__": 1, "constructor": 2}},
    ],
    "edit_page": [
        {"page_id": ID, "edits": [{"old": "Intro", "new": "Opening"}]},
        {"page_id": ID, "edits": [{"old": "  Intro  ", "new": "  Opening  "}]},
        {"page_id": ID, "edits": []},
        {"page_id": ID, "edits": [{"old": "a", "new": "b"}] * 20},
        {"page_id": ID, "edits": [{"old": "a", "new": "b"}] * 21},
        {"page_id": ID, "edits": [{"old": "", "new": "b"}]},
        {"page_id": ID, "edits": [{"old": "a", "new": ""}]},
        {"page_id": ID, "edits": [{"old": "a"}]},
        {"page_id": ID, "edits": [{"old": "a", "new": "b", "x": 1}]},
        {"page_id": ID, "edits": [{"old": "a", "new": "<embed>"}]},
        {"page_id": ID, "edits": [{"old": "a", "new": "a\x00"}]},
        {"page_id": ID, "edits": ["x"]},
        {"page_id": ID, "edits": "x"},
        {"page_id": ID, "edits": [{"old": "x" * 10_001, "new": "b"}]},
        {"page_id": ID, "edits": [{"old": "\ud83d", "new": "x"}]},
        {"page_id": ID, "edits": [{"old": "a", "new": "\udc00"}, {"old": "\ud800", "new": "\ud800"}]},
    ],
    "append_to_page": [
        {"page_id": ID, "markdown": "- [ ] follow up"},
        {"page_id": ID, "markdown": "   "},
        {"page_id": ID, "markdown": '<mention-user url="user://1"/>'},
    ],
    "add_comment": [
        {"page_id": ID, "text": "Looks good"},
        {"page_id": ID, "text": "x" * 2001},
        {"page_id": ID, "text": "<video src=x>"},
        {"page_id": ID, "text": "a\x7fb"},
    ],
}


def packed(value):
    """Long runs of one short string as {"$repeat": [unit, count]}, which the tests unpack."""
    if isinstance(value, str) and len(value) > 200:
        for size in range(1, 4):
            unit = value[:size]
            if unit * (len(value) // size) == value:
                return {"$repeat": [unit, len(value) // size]}
        return value
    if isinstance(value, list):
        return [packed(item) for item in value]
    if isinstance(value, dict):
        return {key: packed(item) for key, item in value.items()}
    return value


def lines_of(name: str, items: list, last: bool) -> list:
    rows = [json.dumps(item) for item in items]
    return [f"{json.dumps(name)}: [", *[f"{row}," for row in rows[:-1]], *rows[-1:], "]" if last else "],"]


def write(vectors: dict) -> None:
    """One case per line, so a change diffs by case."""
    lines = ["{"]
    keys = list(vectors)
    for index, key in enumerate(keys):
        value = vectors[key]
        last = index == len(keys) - 1
        if isinstance(value, list):
            lines.extend(lines_of(key, value, last))
        else:
            lines.append(f"{json.dumps(key)}: {{")
            names = list(value)
            for position, name in enumerate(names):
                lines.extend(lines_of(name, value[name], position == len(names) - 1))
            lines.append("}" if last else "},")
    lines.append("}")
    (HERE / "vectors.json").write_text("\n".join(lines) + "\n")


def validated(model, args):
    try:
        data = model.model_validate(args if args is not None else {})
    except ValidationError as error:
        return {"message": validation_message(error)}
    return {"data": data.model_dump()}


# Notion's responses as client.py's models read them (lax, extra fields ignored): the dump, or null when
# the response is refused as unexpected.
PARENT = {"type": "page_id", "page_id": ID}
MODEL_BASES = {
    "Page": {"object": "page", "id": ID, "parent": PARENT},
    "Database": {"object": "database", "id": ID, "parent": PARENT},
    "DataSource": {"object": "data_source", "id": ID, "parent": {"type": "database_id", "database_id": ID}},
    "Block": {"object": "block", "id": ID, "parent": PARENT},
    "SearchPage": {},
    "PageMarkdown": {"id": ID, "markdown": "text"},
    "Comment": {"id": "c1", "parent": PARENT},
    "CommentPage": {},
    "BotUser": {"id": "b1", "type": "bot"},
}
MODEL_PATCHES = {
    "Page": [
        {},
        {"extra": 1, "url": "https://www.notion.so/x", "in_trash": True, "is_locked": "yes", "created_time": "t", "last_edited_time": None},
        {"in_trash": 1},
        {"in_trash": 1.0},
        {"in_trash": 2},
        {"in_trash": "TRUE"},
        {"in_trash": "off"},
        {"in_trash": " true"},
        {"in_trash": None},
        {"is_locked": "1.0"},
        {"id": 5},
        {"id": None},
        {"object": None},
        {"url": 5},
        {"parent": None},
        {"parent": {}},
        {"parent": {"type": "workspace", "workspace": True}},
        {"parent": {"type": "block_id", "block_id": ID, "page_id": None}},
        {"parent": {"type": "page_id", "page_id": 5}},
        {"parent": []},
        {"properties": {"Name": {"type": "title", "title": [{"plain_text": "T"}]}, "__proto__": {"type": "number"}, "constructor": {}}},
        {"properties": {"a": []}},
        {"properties": []},
        {"properties": None},
        {"properties": {}},
    ],
    "Database": [
        {},
        {"title": [{"plain_text": "Projects"}], "is_inline": "no", "data_sources": [{"id": ID, "name": "Projects", "x": 1}, {"id": ID}]},
        {"title": ["x"]},
        {"title": None},
        {"data_sources": [{"name": "x"}]},
        {"data_sources": [{"id": ID, "name": None}]},
        {"data_sources": None},
        {"data_sources": {}},
        {"url": None, "in_trash": "y"},
    ],
    "DataSource": [
        {},
        {"title": [{"plain_text": "S"}], "properties": {"Status": {"type": "status"}}},
        {"parent": {"type": "database_id"}},
        {"properties": {"x": "y"}},
    ],
    "Block": [{}, {"parent": {"type": "block_id", "block_id": ID}}, {"parent": "x"}],
    "SearchPage": [
        {},
        {"results": [{"object": "page"}, {"x": 1}], "next_cursor": "c1", "has_more": True, "request_status": {"type": "incomplete"}},
        {"results": [1]},
        {"results": None},
        {"request_status": {}},
        {"request_status": None},
        {"request_status": {"type": None}},
        {"has_more": "yes", "next_cursor": None},
        {"next_cursor": 5},
    ],
    "PageMarkdown": [
        {},
        {"truncated": True, "unknown_block_ids": ["a", "b"]},
        {"unknown_block_ids": [1]},
        {"unknown_block_ids": None},
        {"markdown": None},
        {"truncated": "t"},
    ],
    "Comment": [
        {},
        {"discussion_id": "d1", "created_time": "t", "created_by": {"id": "u1", "name": "x"}, "rich_text": [{"plain_text": "x"}]},
        {"created_by": None},
        {"created_by": {}},
        {"rich_text": [None]},
        {"parent": {"type": "block_id", "block_id": ID}},
    ],
    "CommentPage": [
        {},
        {"results": [{"id": "c1", "parent": PARENT}], "has_more": False, "next_cursor": None},
        {"results": [{"id": "c1"}]},
        {"results": [{"id": "c1", "parent": PARENT}, 5]},
    ],
    "BotUser": [
        {},
        {"name": "Minerva", "bot": {"workspace_id": ID, "workspace_name": "Acme", "owner": {}}},
        {"bot": {}},
        {"bot": None},
        {"bot": {"workspace_id": 5}},
        {"type": None},
    ],
}


# `json_size` counts `json.dumps` characters: default separators, ASCII escapes (a pair for an astral
# character), Python's floats. Not here: a float that is integral and below 2**53 ("2.0", "-0.0"), which
# JavaScript reads as the int it equals (lib/json.ts), so it counts two or three characters fewer.
JSON_SIZES = [
    {},
    [],
    {"a": 1},
    [1, 2, 3],
    {"a": [1, {"b": None}], "c": True, "d": False},
    {"é": "😀", " ": "\x00\x1f\x7f"},
    {"a": 1.5, "c": 1e-07, "d": 1e16, "e": 123456789.25, "f": -(2**53) + 1, "g": 2.5e-300},
    [{"property": "Status", "status": {"equals": "Done"}}],
    {"nested": [[[[]]]], "": ""},
    "\"\\",
]


def model_cases() -> list:
    cases = []
    for name, base in MODEL_BASES.items():
        model = getattr(client, name)
        for patch in MODEL_PATCHES[name]:
            value = {**base, **patch}
            try:
                dumped = model.model_validate(value).model_dump()
            except ValidationError:
                dumped = None
            cases.append([name, value, dumped])
    # Not an object at all.
    for name in MODEL_BASES:
        cases.append([name, [], None])
    return cases


def descriptions(schema: dict, value, found: set) -> None:
    """Every field description inside `value`, through the schema's $defs."""
    if isinstance(value, dict):
        if isinstance(value.get("description"), str):
            found.add(value["description"])
        if isinstance(value.get("$ref"), str):
            descriptions(schema, schema["$defs"][value["$ref"].rsplit("/", 1)[-1]], found)
        for key, item in value.items():
            if key != "description":
                descriptions(schema, item, found)
    elif isinstance(value, list):
        for item in value:
            descriptions(schema, item, found)


def declarations() -> dict:
    """What the connector declares, its words included, for the port to match verbatim."""
    connector = NotionConnector()
    auth = connector.auth
    operations = []
    for op in connector.operations:
        schema = op.input_model.model_json_schema()
        fields = {}
        for name, prop in schema["properties"].items():
            found: set = set()
            descriptions(schema, prop, found)
            fields[name] = sorted(found)
        operations.append(
            {
                "name": op.name,
                "title": op.title,
                "description": op.description,
                "needs": [list(need) for need in op.needs],
                "output_action": op.output_action,
                "consent": op.consent,
                "revision": op.revision,
                "mutates": op.mutates,
                "paginated": op.paginated,
                "fields": list(schema["properties"]),
                "required": sorted(schema.get("required", [])),
                "defaults": {name: prop["default"] for name, prop in schema["properties"].items() if "default" in prop},
                "descriptions": fields,
                "offered": connector.offered(op),
            }
        )
    return {
        "connector": [
            {
                "slug": connector.slug,
                "name": connector.name,
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
                    for kind in connector.kinds
                ],
                "actions": [{"id": a.id, "label": a.label, "requires": a.requires} for a in connector.actions],
                "auth": {
                    "app": auth.app,
                    "authorize_url": auth.authorize_url,
                    "token_url": auth.token_url,
                    "scopes": list(auth.scopes),
                    "scope_separator": auth.scope_separator,
                    "registration_url": auth.registration_url,
                    "authorize_params": [list(param) for param in auth.authorize_params],
                    "login_hint": auth.login_hint,
                    "client_auth": auth.client_auth,
                    "json_body": auth.json_body,
                    "pkce": auth.pkce,
                },
                "browsable": sorted(connector.browsable),
                "manage_link": connector.manage_link(),
            }
        ],
        "operations": operations,
    }


def main() -> None:
    rng = random.Random(7)
    vectors = {
        "canonical": [[value, pages.canonical(value)] for value in CANONICAL],
        "object_id": [[value, outcome(pages._object_id, value)] for value in OBJECT_IDS],
        "redact": [[text, markdown.redact(text)] for text in REDACT + [random_markdown(rng) for _ in range(200)]],
        "written": [[text, outcome(markdown.check_written, text)] for text in WRITTEN + [random_markdown(rng) for _ in range(150)]],
        "synced": [[text, markdown.shows_synced_content(text)] for text in REDACT[:5] + ["<synced_block_reference", "<synced_block"]],
        "plan_edits": [[page, edits, outcome(markdown.plan_edits, page, [tuple(edit) for edit in edits])] for page, edits in plan_cases(rng)],
        "readable": [[props, properties.readable(props)] for props in PAGE_PROPERTIES + [SCHEMA] + [random_properties(rng) for _ in range(150)]],
        "schema": [[props, properties.schema(props)] for props in [SCHEMA] + PAGE_PROPERTIES + [random_properties(rng) for _ in range(50)]],
        # The data source's properties that a null stands for in `writable` and `filters`.
        "properties": [SCHEMA],
        "writable": [[None, values, outcome(properties.writable, SCHEMA, values)] for values in WRITES]
        + [
            [{**SCHEMA, "bu": {"id": "zz", "type": "number", "number": {}}}, {"bu": 1}, None],
            [{"Name": {"id": [], "type": "title"}}, {"Name": "x"}, None],
            [{"A": {"id": "B", "type": "number"}, "B": {"id": "A", "type": "number"}}, {"A": 1}, None],
            [{"A": {"id": "A", "type": "number"}}, {"A": 1}, None],
        ],
        "filters": [[None, value, None] for value in FILTERS + [nested(8), nested(9), nested(4)]]
        + [[{"A": {"id": "B", "type": "formula"}, "B": {"id": "A", "type": "number"}}, {"property": "A"}, None]],
        "mentions": [[prop, properties.mentions_hidden(prop)] for prop in list(PAGE_PROPERTIES[3].values()) + [None, "x", {"type": "title"}, {"type": "title", "title": "x"}]],
        "text_of": [[items, text_of(items), has_titled_mention(items)] for items in TEXTS],
        "inputs": {name: [packed([args, validated(INPUTS[name], args)]) for args in cases] for name, cases in ARGUMENTS.items()},
        "models": model_cases(),
        "json_size": [[value, len(json.dumps(value))] for value in JSON_SIZES],
        "declarations": declarations(),
    }
    for case in vectors["writable"]:
        if case[2] is None:
            case[2] = outcome(properties.writable, case[0], case[1])
    for case in vectors["filters"]:
        result = outcome(properties.check_filter, SCHEMA if case[0] is None else case[0], case[1])
        if "ok" in result:
            result["ok"] = sorted(result["ok"])
        case[2] = result
    vectors["writable"] = packed(vectors["writable"])
    write(vectors)


if __name__ == "__main__":
    main()
