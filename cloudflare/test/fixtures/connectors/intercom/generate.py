"""Writes vectors.json: what today's Intercom connector computes, for the port's tests.

Covers html.parser.HTMLParser's events (the port in src/lib/htmlparser.ts) and the text an
agent is shown (`html.read`), over hand-written cases and a seeded random corpus; `redact`, `written` and
`check_written`; the `updated_after` rule and the timestamp it searches with (datetime.fromisoformat, C
implementation); `iso`; `classify`; the validation of every operation's input (the normalized dump or the
message the model sees); how the response models read ints and bools (Pydantic's lax mode); and the
character classes the expressions rely on (`re`'s `\\s` and `\\w`, IGNORECASE letters) and str.casefold.
The connector modules are pure: nothing that loads Django configuration is imported.

Run from cloudflare/: cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/intercom/generate.py

The committed file keeps a sample of the seeded random groups (HTML_RANDOM, SINCE_RANDOM, SINCE_MUTATED) to stay under
about 500 KB; add `--full` (after the script's path) for the whole set, about 1 MB, for a local run.
"""

import json
import random
import re
import sys
from html.parser import HTMLParser
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[4] / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE.parent))

import httpx  # noqa: E402
from pydantic import ValidationError  # noqa: E402

from connectors.intercom import client, html, inboxes, reads  # noqa: E402
from connectors.intercom.connector import IntercomConnector  # noqa: E402
from vector_size import sample  # noqa: E402

HTML_RANDOM = sample(1500, 250)  # random HTML documents
SINCE_RANDOM = sample(1500, 400)  # random updated_after values
SINCE_MUTATED = sample(1500, 400)  # mutations of the listed updated_after values

SECRET = "SECRET merger"


class Events(HTMLParser):
    """Every event the parser raises, as the port raises them."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.events: list[list] = []

    def handle_starttag(self, tag, attrs):
        self.events.append(["start", tag, [[k, v] for k, v in attrs]])

    def handle_startendtag(self, tag, attrs):
        self.events.append(["startend", tag, [[k, v] for k, v in attrs]])

    def handle_endtag(self, tag):
        self.events.append(["end", tag])

    def handle_data(self, data):
        self.events.append(["data", data])

    def handle_comment(self, data):
        self.events.append(["comment", data])

    def handle_decl(self, decl):
        self.events.append(["decl", decl])

    def handle_pi(self, data):
        self.events.append(["pi", data])

    def unknown_decl(self, data):
        self.events.append(["unknown_decl", data])

    def handle_charref(self, name):
        self.events.append(["charref", name])

    def handle_entityref(self, name):
        self.events.append(["entityref", name])


def events(content: str) -> list:
    parser = Events()
    parser.feed(content)
    parser.close()
    return parser.events


HTML = [
    # test_intercom.py's cases.
    '<a href="https://www.intercom.com/x">a <b>label</b></a> after',
    '<a href="https://example.com" href="https://app.intercom.com">x</a>',
    '<a href="https://intercom-attachments-1.com/f">f</a>',
    "<p>one</p><ul><li>two</li><li>three</li></ul>",
    "<p>see app.intercom.com/a/x</p>",
    f"<p>open</p><script>{SECRET}",
    f"<svg><svg></svg>{SECRET}</svg>shown",
    '<a href="https://example.com">https://example.com</a>',
    *(
        f'<a href="https://{host}/f">{SECRET}</a>'
        for host in (
            "intercomassets.com",
            "static.intercomassets.eu",
            "x.intercomcdn.eu",
            "intercomusercontent.com",
            "intercom-attachments.eu",
        )
    ),
    *(
        f'<a href="{href}">{SECRET}</a>'
        for href in ("/a/inbox/abc123/conversation/101", "conversation/101", "//app.intercom.com/x", "java\tscript:x")
    ),
    f'<a href="mailto:a@example.com">{SECRET}</a>',
    f'<a href="">{SECRET}</a>',
    f"<a href>{SECRET}</a>",
    "<a>plain</a>",
    '<p>Hi, see <a href="https://app.intercom.com/a/inbox/abc123/inbox/conversation/101">'
    + SECRET
    + '</a> and <a href="https://example.com/docs">docs</a></p>'
    '<p><img src="https://downloads.intercomcdn.com/i/1.png"></p>',
    "<p>Checking &amp; <b>logs</b></p>",
    # Links.
    '<a href="https://example.com/?a=1&amp;b=2">q</a>',
    '<a href="https://example.com/?a=1&copy=2">q</a>',
    '<a href="https://example.com/?a=1&copy;=2&notit;x">q</a>',
    '<a href="https://example.com/?a&amp">q</a>',
    '<a href="&#104;ttps://example.com">numeric</a>',
    '<a href="https://ex&#97;mple.com">numeric host</a>',
    "<a href=https://example.com/bare>bare</a>",
    "<a href='https://example.com/single'>single</a>",
    '<A HREF="https://example.com/upper">upper</A>',
    '<a title="t" href="https://example.com">two attrs</a>',
    '<a href="https://example.com" HREF="https://example.com">repeated, case</a>',
    '<a href="https://example.com"></a>',
    '<a href="https://example.com">  </a>',
    '<a href="mailto:a@example.com">a@example.com</a>',
    '<a href="tel:+15550100">call</a>',
    '<a href="HTTPS://EXAMPLE.COM/X">upper scheme</a>',
    '<a href=" https://example.com">leading space</a>',
    '<a href="\x01https://example.com">control</a>',
    '<a href="javascript:alert(1)">js</a>',
    '<a href="data:text/html,x">data</a>',
    '<a href="ftp://example.com">ftp</a>',
    '<a href="https://example.com/intercom.com">path</a>',
    '<a href="https://example.com/?u=app%2Eintercom%2Ecom">encoded</a>',
    '<a href="https://example.com/?u=app&#46;intercom&#46;com">entity</a>',
    '<a href="https://example.com/?u=%2569ntercom.com">double encoded</a>',
    '<a href="https://example.com/\u0131ntercom.com">dotless</a>',
    '<a href="https://example.com/\u0130ntercom.com">dotted</a>',
    '<a href="https://example.com/INTERCOM.IO">upper host</a>',
    '<a href="https://example.com/intercom:x">colon</a>',
    '<a href="https://example.com/inter\ncom.com">newline</a>',
    '<a href="https://example.com/inter\u200bcom.com">zero width</a>',
    '<a href="https://example.com/intercom\uff0ecom">fullwidth dot</a>',
    '<a href="https://example.com/intercom\\.com">backslash</a>',
    '<a href="mai\u0131lto:x@example.com">dotless scheme</a>',
    '<a href="ma\u0131lto:x@example.com">dotless mailto</a>',
    '<a href="http\u017f://example.com">long s</a>',
    '<a href="https://example.com">outer <a href="https://example.org">inner</a> tail</a>',
    '<a href="https://example.com">never closed',
    '<a href="https://example.com">one<a href="https://example.org">two',
    '<a href="https://example.com"/>self closed</a>',
    '<a href="https://example.com">x</a></a>more',
    '<a href="https://example.com"><img src="x">pic</a>',
    '<a href="https://example.com"><p>block</p>label</a>',
    '<a href="https://example.com"><li>item</li></a>',
    '<a href="https://example.com">see intercom.com</a>',
    '<a href="https://example.com">a<br>b</a>',
    '<a href="https://example.com"><script>x</script>s</a>',
    # Hidden elements.
    "<script>a</script>b",
    "<script/>a</script>b",
    "<SCRIPT>a</ScRiPt >b",
    "<script>a</scriptx>b</script>c",
    "<script>a</script",
    "<script>a</script\n>b",
    "<style>p { color: red }</style>shown",
    "<xmp>&amp;<b>x</b></xmp>after",
    "<textarea>&amp;<b>x</b></textarea>after",
    "<title>t &amp; u</title>after",
    "<plaintext><b>x</b>&amp;",
    "<iframe>a<iframe>b</iframe>c</iframe>d",
    "<noscript><p>x</p></noscript>y",
    "<noembed><b>x</b></noembed>y",
    "<noframes>x</noframes>y",
    "<template><p>t</p></template>shown",
    "<head><title>x</title></head><p>body</p>",
    "<object><embed></object>x",
    "<math><mi>x</mi></math>y",
    "<svg><p>inside</p></svg>out",
    "<svg/>after",
    "<svg>never closed",
    # Blocks and lines.
    "<div>a</div><div>b</div>",
    "<h1>Title</h1><p>Text</p>",
    "<table><tr><th>h1</th><th>h2</th></tr><tr><td>a</td><td>b</td></tr></table>",
    "<blockquote>quoted</blockquote>after",
    "<pre>  indented\n    more  </pre>",
    "<ol><li>one<li>two</ol>",
    "<li></li><li>x</li>",
    "a<br>b<br/>c<br />d",
    "<p>a</p>\n\n\n\n<p>b</p>",
    "<p>a\xa0\xa0</p><p>\xa0b</p>",
    "one\r\ntwo\rthree",
    "<p>trailing   </p>  \n  <p>  leading</p>",
    "<p></p><p></p><p>x</p>",
    "\u2028x\u2029y\x85z\x1c",
    # Markup that is not an element.
    "a <!-- comment --> b",
    "a <!--> b",
    "a <!---> b",
    "a <!--x--!> b",
    "a <!-- never closed",
    "a <!-",
    "a <![CDATA[x<b>y</b>]]> b",
    "a <![CDATA[ never",
    "<!DOCTYPE html><p>x</p>",
    "<!doctype",
    "a <?php echo 1 ?> b",
    "a <?x",
    "a <!x> b",
    "a <! b",
    "a </> b",
    "a </ x> b",
    "a </3> b",
    "a </",
    "a <",
    "a <3 b",
    "a < b",
    "1 < 2 > 0",
    "a <b c",
    "a <p",
    '<p class="x" id=y data-z>attrs</p>',
    "<p/>x",
    "<p / >x",
    '<p a="1"b="2">x</p>',
    "<p a='1'b>x</p>",
    '<p "quote">x</p>',
    "<p =x>y</p>",
    "<p\nclass=x>y</p>",
    "<p/class=x>y</p>",
    "<p class=x/>y",
    "<p class=x />y",
    "<br/x>y",
    "<a\thref='https://example.com'\n>tabbed</a>",
    "<a href = 'https://example.com' >spaced</a>",
    # Character references.
    "&amp; &lt; &gt; &quot; &#39; &#x27; &nbsp; &copy &notit; &notin; &#0; &#x110000; &#128; &unknown;",
    "&amp",
    "a &",
    "a &#",
    "a &#x",
    "a &#12",
    "x &amp;&amp;&amp y",
    "&lt;b&gt;not a tag&lt;/b&gt;",
    "&#105;ntercom.com",
    "&#x69;ntercom.com",
    # Text addressing Intercom.
    "see intercom.com and INTERCOM.IO and intercom:x",
    "\u0131ntercom.com \u0130ntercom.com",
    "%69ntercom.com app%2Eintercom%2Ecom",
    "intercom-x.co intercom.c intercom",
    "intercom\u3002com",
    "a\u200bintercom.com",
    "intercom",
    "x" * 50 + "intercom.com",
    "\U0001f600 intercom.com \U0001f600",
    "",
    " ",
    "\n\n",
]

TEXT = [
    "hello",
    "a b",
    "  ",
    "\n",
    "\r\n",
    "\t",
    "\xa0",
    "x\u2028y",
    "\u00e9",
    "\U0001f600",
    "intercom.com",
    "app.intercom.io/x",
    "INTERCOM:",
    "\u0131ntercom.eu",
    "intercom-x.co",
    "%69ntercom.com",
    "intercom",
    "&amp;",
    "&amp",
    "&lt;b&gt;",
    "&#105;ntercom.com",
    "&#x69;",
    "&nbsp;",
    "&notit;",
    "&",
    "&#",
    "&#x",
    "&#12",
    "<",
    ">",
    "a<b",
    "1 < 2",
    "x & y",
    "https://example.com",
    "mailto:a@example.com",
    "www.intercom.com",
    "\x00",
    "\x0c",
    "\x1c",
    "\x85",
    "\ufeff",
    "\r",
    "SECRET",
]
TAGS = [
    "a", "A", "p", "div", "br", "li", "ul", "ol", "img", "script", "SCRIPT", "style", "svg", "math", "td", "th",
    "tr", "table", "b", "i", "span", "h1", "pre", "blockquote", "title", "textarea", "xmp", "iframe", "noscript",
    "template", "head", "object", "embed", "plaintext", "noembed", "noframes", "font", "x-y", "a:b", "Svg",
    "a\u0130", "bloc\u212aquote",
]  # fmt: skip
NAMES = ["href", "HREF", "title", "src", "class", "id", "data-x", "Href"]
VALUES = [
    "https://example.com/docs",
    "https://app.intercom.com/a/inbox/1",
    "/relative",
    "conversation/101",
    "//app.intercom.com/x",
    "java\tscript:x",
    "mailto:a@example.com",
    "tel:+1",
    "HTTPS://EXAMPLE.COM",
    "",
    " https://example.com",
    "https://example.com/?a=1&amp;b=2",
    "https://example.com/?a=1&copy=2",
    "&#104;ttps://example.com",
    "https://intercomcdn.com/x",
    "data:text/html,x",
    "ftp://example.com",
    "https://ex&#97;mple.com",
    "x'y",
    'x"y',
    "a b",
    "a>b",
    "https://example.com/\u0131ntercom.com",
]
ENDS = [
    "</a>", "</A >", "</p>", "</script>", "</ScRiPt>", "</svg>", "</li>", "</td>", "</th>", "</ x>", "</>",
    "</3>", "</a\n>", '</a foo="bar">', "</style>", "</xmp>", "</textarea>", "</title>", "</iframe>", "</div>",
    "</b>", "</template>",
]  # fmt: skip
SPECIALS = [
    "<!-- c -->", "<!--->", "<!-->", "<!--x--!>", "<!--", "<![CDATA[x]]>", "<![CDATA[", "<!DOCTYPE html>",
    "<!doctype", "<?php x?>", "<?x", "<!x>", "<!", "</", "<", "<3", "< b>", "<!-x>", "<!--a-->b-->",
]  # fmt: skip


def attribute(rng: random.Random) -> str:
    name = rng.choice(NAMES)
    value = rng.choice(VALUES)
    style = rng.randrange(5)
    if style == 0:
        return name
    if style == 1:
        return f'{name}="{value}"' if '"' not in value else f"{name}='{value}'"
    if style == 2:
        return f"{name}='{value}'" if "'" not in value else f'{name}="{value}"'
    if style == 3:
        return f"{name}={value}"
    return f'{name} = "{value}"' if '"' not in value else f"{name}='{value}'"


def start_tag(rng: random.Random) -> str:
    tag = rng.choice(TAGS)
    attrs = [attribute(rng) for _ in range(rng.choice([0, 0, 1, 1, 2, 3]))]
    gap = rng.choice([" ", " ", "\n", "\t", "  ", "/"])
    inner = "".join(f"{gap}{a}" for a in attrs)
    close = rng.choice([">", ">", ">", "/>", " />", " >", ""])
    return f"<{tag}{inner}{close}"


def corpus(count: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    cases = []
    for _ in range(count):
        parts = []
        for _ in range(rng.randrange(1, 14)):
            roll = rng.random()
            if roll < 0.35:
                parts.append(rng.choice(TEXT))
            elif roll < 0.65:
                parts.append(start_tag(rng))
            elif roll < 0.88:
                parts.append(rng.choice(ENDS))
            else:
                parts.append(rng.choice(SPECIALS))
        cases.append("".join(parts))
    return cases


REDACT = [
    "see intercom.com now",
    "a\u00a0intercom.com\u00a0b",
    "x\u2028intercom.io\u2028y",
    "x\x1cintercom.io\x1cy",
    "x\x85intercom.io\x85y",
    "x\ufeffintercom.io\ufeffy",
    "Ada (ada@intercom.io)",
    "plain name",
    "INTERCOM: x",
    "intercom",
    "intercom.c",
    "\u0131ntercom.com",
    "intercom%2Ecom",
    "intercom&#46;com",
    "intercom\u2024com",
    "",
    "  spaced  ",
]

WRITTEN = [
    "Looked at <b>logs</b>.\nAll fine.\n\nNext: deploy",
    "Fixed, thanks!",
    "a & b\r\n\r\n\r\nc",
    "quotes \" and ' and > <",
    "one\n \t \nTwo\n\n\n\nthree",
    "  padded  \n\n  ",
    "a\x85\nb",
    "a\n\x1c\nb",
    "line\rbreak",
    "\u2028para\u2029",
    "x",
]

CHECKED = [
    "see https://app.intercom.com/a/inbox/x/conversation/101",
    "APP%2EINTERCOM%2ECOM/x",
    "intercom:x",
    "bell \x07",
    "tab\tand\nnewline\r",
    "\x00",
    "\x7f",
    "plain words",
    "intercom",
    "intercom.c",
    "\u0131ntercom.com",
    "inter\ncom.com",
    "inter\tcom.com",
    "intercom&#46;com",
    "intercom\uff0ecom",
    "www.example.com",
    "mailto:a@example.com",
    "\u200bintercom.io",
]

SINCE = [
    "2026-09-21T15:13:20+00:00",
    "2026-09-21",
    "2026-10-01T09:00:00Z",
    "yesterday",
    "1900-01-01",
    "1999-12-31T23:59:59Z",
    "2000-01-01",
    "2100-12-31T23:59:59Z",
    "2101-01-01",
    "2100-12-31T24:00",
    "2026-02-29",
    "2028-02-29",
    "2026-09-21T24:00:00",
    "2026-09-21T24:00:01",
    "2026-09-21T23:60",
    "2026-09-21T12:00:60",
    "2026-09-21 12:00",
    "2026-09-21x12:00",
    "2026-09-21\u00e912:00",
    "2026-09-21\U0001f60012:00",
    "20260921T120000Z",
    "20260921",
    "2026-W38",
    "2026W38",
    "2026-W38-1",
    "2026W381",
    "2026-W53",
    "2020-W53-7",
    "2026-W00",
    "2026-W38-8",
    "2026-09-21T12",
    "2026-09-21T1200",
    "2026-09-21T12:00:00.5",
    "2026-09-21T12:00:00,123456789",
    "2026-09-21T12:00:00.123456+05:30",
    "2026-09-21T12:00:00-05:30",
    "2026-09-21T12:00+01",
    "2026-09-21T12:00+0130",
    "2026-09-21T12:00+01:30:15",
    "2026-09-21T12:00+01:30:15.5",
    "2026-09-21T12:00+24:00",
    "2026-09-21T12:00+23:59",
    "2026-09-21T12:00+01:75",
    "2026-09-21T12:00Z+01:00",
    "2026-09-21T12:00+01:00Z",
    "2026-09-21T12:00z",
    "2026-09-21T12:00+",
    "2026-09-21T12:00+1",
    "2026-09-21T12:00+013",
    "2026-09-21T12:0",
    "2026-09-21T1:00",
    "2026-09-21T12:00:",
    "2026-09-21T12::00",
    "2026-09-21T12.5",
    "2026-09-21T12:00.5",
    "2026-09-21T",
    "2026-9-21",
    "2026-09-1",
    "2026-0921",
    "202609-21",
    "\uff12\uff10\uff12\uff16-09-21",
    "\u0662\u0660\u0662\u0666-09-21",
    "2026-09-21T12:00:00+00:00:00",
    "2026-09-21T00:00:00-00:00",
    "2000-01-01T00:00:00+01:00",
    "2100-12-31T23:00:00-01:00",
    "2026-09-21T12:00:00.000001Z",
    "2026-09-21T12:00:00.9999999Z",
    "2026-09-21T12:00:00.Z",
    "2026-09-21T12:00:00.",
    "2026-09-21T12:00:00.1.2",
    "2026-09-21T120000.5",
    "2026-09-21T12:0000",
    "2026-09-21T1200:00",
    "2026-09-21T12:00-",
    "2026-09-21T12-01",
    "2026-09-21T-01:00",
    "2026-09-21TZ",
    "2026-09-21T12Z",
    "2026-09-21T12:00:00+0100",
    "2026-09-21T12:00:00+01:00:00.123",
    "2026-09-21T12:00:00+010000.5",
    "2026-09-21T12:00:00 +01:00",
    "0000-01-01",
    "9999-12-31",
    "2026-13-01",
    "2026-00-10",
    "2026-09-31",
    "2026-09-00",
    # Where CPython's C parser differs from its pure-Python one, and from what one would guess.
    "2026-09-21T12:00:00.Z",
    "2026-09-21T12:00:00.+01:00",
    "2026-09-21T12.+05:30",
    "2026-09-21T12:00:00 +01:00",
    "2026-09-21T12:00 +01:00",
    "2026-09-21T12x+01:00",
    "2026-09-21T12é+01:00",
    "0001W44x12é+01:00",
    "2026-09-21T12:00:00.1234567é+01:00",
    "2026-09-21T12:00:00.1234567x+01:00",
    "2026-W38é12",
    "2026W381é12",
    "2026-W38-1é12",
    "2026é09é21",
    "2026-09-21T12:00:00+00:00:00.5",
    "2026-09-21T12:00:00-00:00:00.5",
    "2026-09-21T12:00:00+23:59:60",
    "2026-09-21T12:00:00+99:00",
    "2026-09-21T12:00:00+01:00Z",
    "2026-09-21T12:00:00Z+01:00",
    "2026-09-21T12:00:00+012",
    "2026-09-21T12:00:00+01:00:0",
    "2026-09-21T12:00:00.5+01:00x",
    "2026-W26T030+23",
    "2026-W154",
    "261010305",
    "1999W19:",
    "2000-01-011",
    "2000-07-12T09000560",
    "2026-00-00T24:00",
]


def since_corpus(count: int, seed: int) -> list[str]:
    rng = random.Random(seed)
    digits = "0123456789"
    out = []
    for _ in range(count):
        year = rng.choice(["2026", "2000", "1999", "2100", "2101", "0001", str(rng.randrange(1000, 9999))])
        form = rng.randrange(7)
        month = f"{rng.randrange(0, 14):02d}"
        day = f"{rng.randrange(0, 33):02d}"
        week = f"{rng.randrange(0, 55):02d}"
        weekday = str(rng.randrange(0, 9))
        date = [
            f"{year}-{month}-{day}",
            f"{year}{month}{day}",
            f"{year}-W{week}",
            f"{year}W{week}",
            f"{year}-W{week}-{weekday}",
            f"{year}W{week}{weekday}",
            f"{year}-{month}",
        ][form]
        value = date
        if rng.random() < 0.75:
            value += rng.choice(["T", "T", " ", "t", "x", "\u00e9", "-", "1", "W"])
            hour = f"{rng.choice([0, 9, 12, 23, 24, 25, 99]):02d}"
            minute = f"{rng.choice([0, 30, 59, 60]):02d}"
            second = f"{rng.choice([0, 15, 59, 60]):02d}"
            colon = rng.random() < 0.6
            sep = ":" if colon else ""
            time = rng.choice([hour, f"{hour}{sep}{minute}", f"{hour}{sep}{minute}{sep}{second}"])
            if rng.random() < 0.3:
                time += rng.choice([".", ","]) + "".join(rng.choice(digits) for _ in range(rng.randrange(0, 10)))
            value += time
            if rng.random() < 0.6:
                tz_hour = f"{rng.choice([0, 1, 5, 14, 23, 24, 99]):02d}"
                tz_minute = f"{rng.choice([0, 30, 59, 60, 75]):02d}"
                tz = rng.choice(
                    [
                        "Z",
                        "z",
                        f"+{tz_hour}",
                        f"-{tz_hour}{tz_minute}",
                        f"+{tz_hour}:{tz_minute}",
                        f"-{tz_hour}:{tz_minute}:{second}",
                        f"+{tz_hour}{tz_minute}{second}.{rng.randrange(0, 999999)}",
                        f"+{tz_hour}:{tz_minute}:{second}.{rng.randrange(0, 999999)}",
                        "+",
                        "Z+01:00",
                    ]
                )
                value += tz
        # Mutations.
        for _ in range(rng.choice([0, 0, 0, 1, 2])):
            if not value:
                break
            at = rng.randrange(len(value))
            action = rng.randrange(3)
            if action == 0:
                value = value[:at] + value[at + 1 :]
            elif action == 1:
                value = value[:at] + rng.choice("0123456789-:+TZW.,x ") + value[at:]
            else:
                value = value[:at] + rng.choice("0123456789-:+TZW.,") + value[at + 1 :]
        out.append(value)
    return out


def mutations(seeds: list[str], count: int, seed: int) -> list[str]:
    """Seeds with characters deleted, inserted or replaced, non-ASCII ones among them."""
    rng = random.Random(seed)
    alphabet = "0123456789-:+TZW.,x é\U0001f600zı ٣０t−_"
    out = []
    for _ in range(count):
        chars = list(rng.choice(seeds))
        for _ in range(rng.randrange(1, 5)):
            if not chars:
                break
            at = rng.randrange(len(chars))
            action = rng.randrange(3)
            if action == 0:
                del chars[at]
            elif action == 1:
                chars.insert(at, rng.choice(alphabet))
            else:
                chars[at] = rng.choice(alphabet)
        out.append("".join(chars))
    return out


TIMESTAMPS = [
    None, -1, 0, 1, 1790000000, 1790000100, 253402300799, 253402300800, 10**12, 10**20, 2**63, 951782400,
]  # fmt: skip

CLASSIFIED = [
    (403, b'{"type":"error.list","errors":[{"code":"api_plan_restricted","message":"x"}]}'),
    (403, b'{"errors":[{"code":"forbidden","message":"SECRET"}]}'),
    (403, b"[1]"),
    (403, b"not json"),
    (403, b""),
    (403, b'{"errors":null}'),
    (403, b'{"errors":[]}'),
    (403, b'{"errors":"api_plan_restricted"}'),
    (403, b'{"errors":{"code":"api_plan_restricted"}}'),
    (403, b'{"errors":[1,"x",null,{"code":"api_plan_restricted"}]}'),
    (403, b'{"errors":[{"code":["api_plan_restricted"]}]}'),
    (403, b'{"errors":[{"code":{"a":1}}]}'),
    (403, b'{"errors":5}'),
    (403, b'{"errors":true}'),
    (403, b'{"errors":0}'),
    (403, b'\xef\xbb\xbf{"errors":[{"code":"api_plan_restricted"}]}'),
    (403, b'{"errors":[{"code":"api_plan_restricted"}],"errors":[]}'),
    (404, b"{}"),
    (404, b'{"errors":[{"code":"api_plan_restricted"}]}'),
    (404, b'{"errors":5}'),
    (400, b'{"errors":[{"code":"parameter_invalid"}]}'),
    (401, b"{}"),
    (429, b"{}"),
    (500, b"<html>"),
]

INPUTS = {
    "list_inboxes": [None, {}, {"x": 1}, []],
    "search_conversations": [
        {"inbox": "1"},
        {"inbox": " 1 "},
        {"inbox": "none"},
        {"inbox": "None"},
        {"inbox": "Support"},
        {"inbox": "01"},
        {"inbox": "1" * 20},
        {"inbox": "1" * 21},
        {"inbox": ""},
        {"inbox": 1},
        {},
        {"inbox": "1", "state": "open", "text": " see docs ", "updated_after": " 2026-09-21 ", "limit": 3},
        {"inbox": "1", "state": "pending"},
        {"inbox": "1", "state": None, "text": None, "updated_after": None, "cursor": None},
        {"inbox": "1", "text": "a\tb"},
        {"inbox": "1", "text": "x" * 201},
        {"inbox": "1", "text": ""},
        {"inbox": "1", "text": "?!"},
        {"inbox": "1", "updated_after": "yesterday"},
        {"inbox": "1", "updated_after": "1900-01-01"},
        {"inbox": "1", "updated_after": "2026-09-21T15:13:20+00:00"},
        {"inbox": "1", "updated_after": "x" * 41},
        {"inbox": "1", "limit": 0},
        {"inbox": "1", "limit": 21},
        {"inbox": "1", "limit": "3"},
        {"inbox": "1", "limit": True},
        {"inbox": "1", "cursor": "c" * 1000},
        {"inbox": "1", "cursor": "c" * 1001},
        {"inbox": "1", "cursor": " abc "},
        {"inbox": "1", "other": 1},
        {"inbox": "x", "state": "x", "limit": 99, "extra": True},
    ],
    "get_conversation": [
        {"conversation": "100"},
        {"conversation": " 100 "},
        {"conversation": "0100"},
        {"conversation": "x"},
        {"conversation": "1 OR 1"},
        {"conversation": "1" * 21},
        {"conversation": 100},
        {},
    ],
    "add_note": [
        {"conversation": "100", "text": "Looked at <b>logs</b>.\nAll fine.\n\nNext: deploy"},
        {"conversation": "100", "text": "  x  "},
        {"conversation": "100", "text": ""},
        {"conversation": "100", "text": "x" * 10001},
        {"conversation": "100", "text": "bell \x07"},
        {"conversation": "100", "text": "intercom:x"},
        {"conversation": "x", "text": "intercom:x"},
        {"conversation": "100"},
    ],
    "reply": [
        {"conversation": "100", "text": "Fixed, thanks!"},
        {"conversation": "100", "text": "see https://app.intercom.com/a/inbox/x/conversation/101"},
        {"conversation": "100", "text": "APP%2EINTERCOM%2ECOM/x"},
        {"text": "x"},
    ],
}

LAX_INTS = [
    1, 1.0, 1.5, 100.0, "1", " 1 ", "+1", "-1", "1_000", "1.0", "1.00", "1.50", "0x10", True, False, "abc", -5,
    "1e2", "\uff10", "\u0661", " 12\n", "\t3", "00012", -0.0, "-0", "", " ", "_1", "1__0", "1_", "1.", ".0",
    "1_000.0", "- 1", "+-1", "\u00a012\u00a0", "\u200b1", "\x1c1", None, [], {},
    # pydantic-core strips leading zeros (and underscores among them) before anything else.
    "0_1", "00_1", "0__1", "_01", "0_", "0", "-0_1", "+0__1", "0_0_1", "01_2", "0" * 5000 + "1", "1" * 4301,
    "0_0_0_5", "00", "-00", "0x", "0.0", "00.00", "0_.0", "1_2.0", "-0__5", "+_1", "0-1", " 0__1 ", "0__1.00",
    "0" * 4301, "1" + "0" * 4300, "1" * 4300,
    # Beyond 2^53 (the port refuses them).
    1e20, 10**18, 9.2e18, 2**53, 2**53 + 1, "9007199254740993", -(2**53) - 1,
]  # fmt: skip
LAX_BOOLS = [
    True, False, 1, 0, 1.0, 0.0, 2, "true", "True", "TRUE", "yes", "on", "t", "y", "1", "0", "off", "no", "f", "n",
    " true", "1.0", None, "truee", "", "YES", "Off", -1, 0.5,
]  # fmt: skip


def check(fn, value):
    try:
        return {"ok": fn(value)}
    except ValueError as error:
        return {"error": str(error)}


def since(value: str) -> dict:
    try:
        reads._since(value)
    except ValueError as error:
        return {"value": value, "error": str(error)}
    return {"value": value, "timestamp": reads._timestamp(value)}


def classified(status: int, body: bytes) -> dict:
    out = {"status": status, "hex": body.hex()}
    try:
        named = client.classify("Intercom", httpx.Response(status, content=body))
    except TypeError:
        return out | {"raises": "TypeError"}
    if named is None:
        return out | {"named": None}
    return out | {"named": {"code": named.code, "message": named.message}}


def validation_message(error: ValidationError) -> str:
    """connectors/executor.py's, restated: that module loads Django's models."""
    problems = [
        f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]
    ]
    return "Invalid arguments. " + "; ".join(problems)


def validated(op, raw):
    try:
        data = op.input_model.model_validate(raw if raw is not None else {})
    except ValidationError as error:
        return {"json": json.dumps(raw), "message": validation_message(error)}
    return {"json": json.dumps(raw), "data": data.model_dump()}


class LaxInt(client.Model):
    """The response models' config with one `int | None` field, as `created_at` and `team_assignee_id` are."""

    value: int | None = None


class LaxBool(client.Model):
    """The response models' config with one `bool` field, as `redacted` is."""

    value: bool = False


def lax(model, attribute, value):
    try:
        read = getattr(model.model_validate({attribute: value}), attribute)
    except ValidationError:
        return {"value": value, "refused": True}
    return {"value": value, "ok": read}


def code_points(pattern: str, flags: int = 0) -> list[list[int]]:
    """The code points a one-character pattern matches, as ranges."""
    compiled = re.compile(pattern, flags)
    ranges: list[list[int]] = []
    for point in range(0x110000):
        if 0xD800 <= point <= 0xDFFF:
            continue
        if compiled.fullmatch(chr(point)):
            if ranges and ranges[-1][1] == point - 1:
                ranges[-1][1] = point
            else:
                ranges.append([point, point])
    return ranges


def lines(value, depth: int = 0) -> str:
    """JSON with one vector per line, so a change shows as the vectors it changed."""
    if depth < 2 and isinstance(value, dict):
        pad = " " * (depth + 1)
        items = [f"{pad}{json.dumps(key)}: {lines(item, depth + 1)}" for key, item in value.items()]
        return "{\n" + ",\n".join(items) + "\n" + " " * depth + "}"
    if depth < 3 and isinstance(value, list) and value and isinstance(value[0], dict):
        pad = " " * (depth + 1)
        return "[\n" + ",\n".join(pad + json.dumps(item, ensure_ascii=True) for item in value) + "\n" + " " * depth + "]"
    return json.dumps(value, ensure_ascii=True)


def main() -> None:
    operations = {op.name: op for op in IntercomConnector.operations}
    documents = HTML + corpus(HTML_RANDOM, 7)
    vectors = {
        "html": [{"html": text, "events": events(text), "read": html.read(text)} for text in documents],
        "redact": [{"text": text, "shown": html.redact(text)} for text in REDACT],
        "written": [{"text": text, "html": html.written(text)} for text in WRITTEN],
        "checked": [{"text": text, **check(html.check_written, text)} for text in CHECKED],
        "since": [since(value) for value in dict.fromkeys(SINCE + since_corpus(SINCE_RANDOM, 11) + mutations(SINCE, SINCE_MUTATED, 13))],
        "iso": [{"timestamp": ts, "iso": inboxes.iso(ts)} for ts in TIMESTAMPS],
        "classify": [classified(status, body) for status, body in CLASSIFIED],
        "inputs": {name: [validated(operations[name], raw) for raw in raws] for name, raws in INPUTS.items()},
        "lax": {
            "int": [lax(LaxInt, "value", value) for value in LAX_INTS],
            "bool": [lax(LaxBool, "value", value) for value in LAX_BOOLS],
        },
        "classes": {
            "space": code_points(r"\s"),
            "word": code_points(r"\w"),
            "ignorecase": {
                pattern: [r for r in code_points(pattern, re.IGNORECASE) if r[1] > 0x7F]
                for pattern in ("[a-z]", "[a-z0-9-]", *"intercomhpsal")
            },
        },
    }
    (HERE / "vectors.json").write_text(lines(vectors) + "\n")


if __name__ == "__main__":
    main()
