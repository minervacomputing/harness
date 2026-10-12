"""Writes vectors.json: what today's Python computes for Teams' port (src/connectors/teams/):

- `read`: the text `html.read` makes of message bodies (hand-written edge cases, the cases of test_teams.py and
  mutations of them), with the mentions each is read with;
- `redact`, `to_teams`, `check_written`, `written`: Teams addresses in any encoding, and the text agents write;
- `letters`: for each character of each address of the Teams pattern, every code point `re.IGNORECASE` lets stand in for it;
- the normalized arguments or validation message of the tool inputs.

Only connector modules are imported, which load no configuration. Run from backend/:
uv run python -I ../cloudflare/test/fixtures/connectors/teams/generate.py

The committed file keeps a sample of the fuzz groups (MUTATED, SEQUENCES, JUNKED) to stay under about 500 KB; add
`--full` (after the script's path) for the whole set, about 1.5 MB, for a local run.
"""

import json
import random
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[3].parent / "backend"
sys.path.insert(0, str(BACKEND))
sys.path.insert(0, str(HERE.parent))

from vector_size import compact, sample  # noqa: E402

from pydantic import ValidationError  # noqa: E402

from connectors.teams import connector as teams  # noqa: E402
from connectors.teams import html  # noqa: E402
from connectors.teams.client import Mention  # noqa: E402

random.seed(20261013)

MUTATED = sample(2500, 250)  # mutations of the seed bodies
SEQUENCES = sample(1500, 150)  # random runs of the vocabulary
JUNKED = sample(600, 100)  # addresses with a character slipped in

SECRET = "SECRET merger"
U = "\U00000041"  # placeholder so that this file never needs a lower-case \u escape

# ---------------------------------------------------------------------------------------------------------------
# Message bodies.

ADA = {"user": {"id": "u", "displayName": "Ada"}}
CHANNEL = {"conversation": {"id": "19:x@thread.tacv2", "displayName": SECRET}}
TAG = {"tag": {"id": "t", "displayName": "Oncall"}}
APP = {"application": {"id": "a", "displayName": "Bot"}}

MENTION_SETS: list[list[dict]] = [
    [],
    [{"id": 0, "mentioned": ADA}],
    [{"id": 0, "mentioned": ADA}, {"id": 1, "mentioned": CHANNEL}, {"id": 2, "mentioned": TAG}],
    [{"id": 0, "mentioned": {"user": {"id": "u"}}}, {"id": 0, "mentioned": {"conversation": {"id": "19:x@thread.tacv2"}}}],
    [{"id": 0, "mentioned": {}}],
    [{"id": 0, "mentioned": None}],
    [{"id": 0}],
    [{"id": None, "mentioned": ADA}],
    [{"id": 0, "mentioned": APP}, {"id": 1, "mentioned": ADA}, {"id": 2, "mentioned": TAG}, {"id": 3, "mentioned": ADA}],
    [{"id": 7, "mentioned": ADA}, {"id": -1, "mentioned": ADA}, {"id": 10, "mentioned": TAG}, {"id": 1, "mentioned": CHANNEL}],
    [{"id": 0, "mentioned": {"user": None, "conversation": None, "tag": None, "application": None}}],
    [{"id": 0, "mentioned": {"user": {"id": "u"}, "conversation": {"id": "c"}}}],
    [{"id": 1, "mentioned": ADA}, {"id": "1", "mentioned": CHANNEL}],
    [{"id": True, "mentioned": ADA}, {"id": " 2 ", "mentioned": TAG}],
]

CASES: list[tuple[str | None, str | None, int]] = []


def case(content: str | None, kind: str | None = "html", mentions: int = 0) -> None:
    CASES.append((content, kind, mentions))


FULL = (
    '<div><p>Hi <at id="0">Ada</at> and <at id="2">Oncall</at>, see <at id="1">' + SECRET + "</at>.</p>"
    f'<p><a href="https://teams.microsoft.com/l/channel/19%3ax/{SECRET}">{SECRET}</a> '
    f'<a href="https://teams%2Emicrosoft.com/x">{SECRET}</a> <a href="https://example.com/a">docs</a> '
    '<a href="https://example.com/b">https://example.com/b</a></p>'
    '<blockquote itemtype="http://schema.skype.com/Reply" itemid="1101"><strong>Bob</strong>'
    f"<blockquote>{SECRET}</blockquote></blockquote>"
    '<ul><li>one</li><li>two&nbsp;&amp; three</li></ul><img src="x"> <emoji alt="\U0001f600">:)</emoji>'
    f'<attachment id="a1">{SECRET}</attachment><script>{SECRET}</script>'
    "<p>a<br>b</p><p>&lt;b&gt;</p></div>"
)


def python_tests() -> None:
    case(FULL, "html", 2)
    case("  plain <b>text</b> ", "text")
    case(None)
    case("")
    case("   ")
    case("<p></p>")
    nested = f'<a href="https://teams.microsoft.com/x"><a href="https://example.com">{SECRET}</a>{SECRET}</a> after'
    case(nested)
    case(f'before <at id="9">{SECRET}')
    case(f'<at id="0">x</at><at id="0"><at>{SECRET}</at></at>', "html", 4)
    case(f'start <blockquote itemid="5">{SECRET}<p>{SECRET}')
    case('<a href="https://example.com">open')
    case(f'<at id="0" id="1">{SECRET}</at>', "html", 1)
    case(f'<a href="https://example.com" href="https://teams.microsoft.com/x">{SECRET}</a>')
    case(f"<p>said</p><blockquote>{SECRET}</blockquote>")
    case(f'<at id="0">{SECRET}</at>', "html", 3)
    for opened in ("<blockquote/>", '<at id="9"/>', '<a href="https://teams.microsoft.com/x"/>', "<script/>"):
        case(f"{opened}{SECRET}</x> after", "html", 1)
    case('a <emoji alt="\U0001f600"/> b<br/>c')
    for href in ("https://teams.micro&#10;soft.com/l/x", "ms&#9;teams:/l/x", "https://teams%2Emicro%0Dsoft.com/x"):
        case(f'<a href="{href}">{SECRET}</a>')
    for address in (
        "https://teams.microsoft.com/l/channel/x",
        "teams%2Emicrosoft%2Ecom/x",
        "https://teams.microsoftonline.cn/l/x",
        "https://dod.teams.microsoft.us/l/x",
        "msteams://x",
    ):
        case(f"<p>see {address}, ok</p>")
        case(f"see {address}", "text")


def tag_cases() -> None:
    for tag in ("p", "div", "h1", "h6", "tr", "pre", "ul", "ol", "table", "li", "td", "th", "span", "b", "i", "em", "strong", "code", "u", "s",
                "sup", "sub", "font", "section", "article", "header", "footer", "nav", "br", "hr", "img", "input", "emoji", "at", "a",
                "blockquote", "attachment", "script", "style", "head", "title", "template", "textarea", "xmp", "noscript", "iframe",
                "object", "svg", "math", "details", "summary", "dl", "dt", "dd", "caption", "thead", "tbody", "tfoot", "col", "colgroup",
                "P", "DIV", "Blockquote", "SCRIPT", "At", "A", "EMOJI", "Br", "BR", "LI", "x-custom", "a:b", "x.y", "_x", "-x", "1x"):
        case(f"before<{tag}>inside</{tag}>after")
        case(f"before<{tag}>inside after")
        case(f"before<{tag}/>inside after")
        case(f"before<{tag} />inside</{tag}>after")
        case(f"before</{tag}>inside after")
        case(f'before<{tag} id="0" alt="x" href="https://example.com">inside</{tag}>after', "html", 1)
        case(f"<p>before<{tag}>one<{tag}>two</{tag}>three</{tag}>four</p>")
    case("<table><tr><td>a</td><td>b</td></tr><tr><th>c</th><th>d</th></tr></table>")
    case("<table><tr><td>a<td>b<tr><td>c</table>")
    case("<ul><li>one<li>two<ul><li>nested</li></ul></ul>")
    case("<ol><li>one</li></ol>text<li>stray</li>")
    case("<li><li><li>x")
    case("<p>one</p><p>two</p><p></p><p></p><p>three</p>")
    case("a<br><br><br><br>b")
    case("<p>a</p>\n\n\n<p>b</p>")
    case("a\n\n\n\n\nb")
    case("line  \nline two   \n  indent")
    case("\xa0\xa0lead&nbsp;trail&nbsp;")
    case("<p>\xa0</p><p>x</p>")
    case("tab\tbetween")
    case("<td>a</td><td>b</td>")
    case("<h1>Title</h1>text<h2>Sub</h2>")
    case("<div><div><div>deep</div></div></div>")
    case("<pre>  keep\n  spacing  </pre>")
    case("<img>")
    case("<img/><img /><img src=x>")
    case("<hr>x<hr/>y")
    case("<p>x<br/>y<br />z</br>w</p>")
    case("</br>x")
    case("</p>x")


def attribute_cases() -> None:
    for html_ in (
        '<a href="https://example.com">label</a>',
        "<a href='https://example.com'>label</a>",
        "<a href=https://example.com>label</a>",
        '<a href = "https://example.com" >label</a>',
        '<a HREF="https://example.com">label</a>',
        '<a Href="https://example.com">label</a>',
        '<a href="https://example.com" href="https://example.com">label</a>',
        '<a href="https://example.com" HREF="https://teams.microsoft.com/x">label</a>',
        '<a href="">label</a>',
        "<a href>label</a>",
        "<a href=''>label</a>",
        "<a>label</a>",
        '<a name="x">label</a>',
        '<a href="https://example.com">https://example.com</a>',
        '<a href="https://example.com">https://example.com </a>',
        '<a href="https://example.com"> https://example.com</a>',
        '<a href="https://example.com">  </a>',
        '<a href="https://example.com"></a>',
        '<a href=""></a>',
        '<a href="https://example.com"><b>bold</b> label</a>',
        '<a href="https://example.com">one <a href="https://example.org">two</a> three</a>',
        '<a href="https://example.com">one <a href="https://teams.microsoft.com/x">two</a> three</a> four',
        '<a href="https://example.com">one<br>two</a>',
        '<a href="https://example.com"><p>para</p></a>',
        '<a href="https://example.com&amp;x=1">label</a>',
        '<a href="https://example.com?a=1&b=2">label</a>',
        '<a href="https://example.com?a=1&amp;b=2">https://example.com?a=1&b=2</a>',
        '<a href="&#104;ttps://example.com">label</a>',
        '<a href="https://example.com/&#x00e9;">label</a>',
        '<a href="https://example.com/\xe9">\xe9</a>',
        '<a href="https://example.com/ a b">label</a>',
        '<a href="https://example.com/\ta\nb">label</a>',
        '<a href="javascript:alert(1)">label</a>',
        '<a href="mailto:ada@example.com">ada@example.com</a>',
        '<a href="https://TEAMS.MICROSOFT.COM/x">label</a>',
        '<a href="  https://teams.microsoft.com/x">label</a>',
        '<a href="https://teams.microsoft.com">label</a>',
        '<a href="https://notteams.microsoft.com/x">label</a>',
        '<a href="https://teams.microsoft.com.evil.example/x">label</a>',
        '<a href="https://teams.live.com/x">label</a>',
        '<a href="https://teams.cloud.microsoft/x">label</a>',
        '<a href="https://teams.office.com/x">label</a>',
        '<a href="https://teams.microsoft.us/x">label</a>',
        '<a href="msteams:/l/x">label</a>',
        '<a href="MSTEAMS:/l/x">label</a>',
        '<a href="msteams%3A/l/x">label</a>',
        '<a href="https://example.com/?u=https%3A%2F%2Fteams.microsoft.com%2Fx">label</a>',
        '<a href="https://example.com/?u=https%253A%252F%252Fteams.microsoft.com%252Fx">label</a>',
        '<a href="https://example.com/?u=teams%25252Emicrosoft.com">label</a>',
        '<a href="https://example.com/?u=teams%2525252Emicrosoft.com">label</a>',
        '<a href="https://teams%2emicrosoft%2ecom/x">label</a>',
        '<a href="https://teams\U0000ff0emicrosoft\U0000ff0ecom/x">label</a>'.replace("\U0000ff0e", "\U0000ff0e"),
        '<a href="https://teams\U00003002microsoft\U00003002com/x">label</a>',
        '<a href="https://teams\U0000ff61microsoft\U0000ff61com/x">label</a>',
        '<a href="https://\U0000ff54\U0000ff45\U0000ff41\U0000ff4d\U0000ff53.microsoft.com/x">label</a>',
        '<a href="https://te\U0000200bams.microsoft.com/x">label</a>',
        '<a href="https://te\U000000adams.microsoft.com/x">label</a>',
        '<a href="https://te\U0000feffams.microsoft.com/x">label</a>',
        '<a href="https://teams.microsoft.com\\x">label</a>',
        '<a href="https:\\\\teams.micro\\soft.com\\x">label</a>',
        '<a href="https://te&#97;ms.microsoft.com/x">label</a>',
        '<a href="https://te&amp;#97;ms.microsoft.com/x">label</a>',
        '<a href="https://te&amp;amp;#97;ms.microsoft.com/x">label</a>',
        '<a href="https://te&#x61ms.microsoft.com/x">label</a>',
        '<a href="https://te&#X61;ms.microsoft.com/x">label</a>',
        '<a href="https://teams&period;microsoft&period;com/x">label</a>',
        '<a href="https://teams&NewLine;.microsoft.com/x">label</a>',
        '<a href="https://\U0000212a.microsoft.com/x">label</a>',
        '<a href="https://\U0000017f.microsoft.com/x">label</a>',
        '<a href="https://teams.m\U00000131crosoft.com/x">label</a>',
        '<a href="https://teams.m\U00000130crosoft.com/x">label</a>',
        '<a href="https://teams.m\U0000ff49crosoft.com/x">label</a>',
        '<a href="https://T\U00000045AMS.microsoft.com/x">label</a>',
        '<at id="0">Ada</at>',
        '<at id="0" >Ada</at>',
        "<at id='0'>Ada</at>",
        "<at id=0>Ada</at>",
        '<at ID="0">Ada</at>',
        '<at id="0" id="0">Ada</at>',
        '<at id="0" Id="0">Ada</at>',
        '<at id=" 0">Ada</at>',
        '<at id="0 ">Ada</at>',
        '<at id="00">Ada</at>',
        '<at id="">Ada</at>',
        "<at id>Ada</at>",
        "<at>Ada</at>",
        '<at id="1">Ada</at>',
        '<at id="2">Oncall</at>',
        '<at id="&#48;">Ada</at>',
        '<at id="\U00000660">Ada</at>',
        '<at id="0">Ada <b>bold</b> <at id="1">inner</at> more</at> after',
        '<at id="0"></at>after',
        '<at id="0"/>after</at>end',
        '<at id="0"><at id="0">two</at>three</at>four',
        '<at id="0"><at id="1">two</at>three</at>four',
        '<emoji alt="x">y</emoji>',
        "<emoji alt='x'>y</emoji>",
        "<emoji alt=x>y</emoji>",
        '<emoji alt="">y</emoji>',
        "<emoji alt>y</emoji>",
        "<emoji>y</emoji>",
        '<emoji alt="a" alt="b">y</emoji>',
        '<emoji alt="&lt;b&gt;">y</emoji>',
        '<emoji alt="\U0001f600" id="1f600" title="grinning">\U0001f600</emoji>',
        '<emoji alt="x"/>after',
        '<emoji alt="x" />after',
        '<emoji/>after',
        '<emoji alt="a"><emoji alt="b"></emoji></emoji>',
        '<emoji alt="a"/><emoji alt="b"/>',
        '<emoji alt="https://teams.microsoft.com/x">y</emoji>',
        '<emoji alt="teams.microsoft.com">y</emoji>',
        '<blockquote>q</blockquote>after',
        '<blockquote></blockquote>after',
        '<blockquote/>after',
        'before<blockquote>q</blockquote>after',
        'before<br><blockquote>q</blockquote><br>after',
        '<p>before</p><blockquote>q</blockquote><p>after</p>',
        '<blockquote><blockquote>q</blockquote></blockquote>',
        '<blockquote>a</blockquote><blockquote>b</blockquote>',
        '<blockquote>unclosed <b>x',
        '<blockquote>a</blockquote></blockquote>after',
        '<script>x</script>after',
        '<script>if (a < b) { document.write("</p>"); }</script>after',
        '<script>x</SCRIPT>after',
        '<script>x</script  >after',
        '<script>x</script foo>after',
        '<script>x<!--</script>-->after',
        '<script><!-- <script> --></script>after',
        '<style>p { color: red }</style>after',
        '<style>p::before { content: "</p>" }</style>after',
        '<title>t</title>after',
        '<head><title>t</title></head>after',
        '<template><p>x</p></template>after',
        '<attachment id="1">x</attachment>after',
        '<attachment id="1"/>after',
        '<attachment id="1">x<attachment id="2">y</attachment>z</attachment>after',
        '<textarea><p>x</p></textarea>after',
        '<xmp><p>x</p></xmp>after',
        '<noscript><p>x</p></noscript>after',
        '<iframe><p>x</p></iframe>after',
        '<plaintext><p>x</p>',
    ):
        case(html_, "html", 2)


def parser_cases() -> None:
    for text in (
        "a < b",
        "a <",
        "a <b",
        "a <b ",
        "a <b c",
        "a <b c=",
        'a <b c="',
        'a <b c="d',
        'a <b c="d"',
        "a <b c='d",
        "a </",
        "a </b",
        "a </b ",
        "a </ b>",
        "a </>b",
        "a <>b",
        "a < >b",
        "a <1>b",
        "a <!",
        "a <!-",
        "a <!--",
        "a <!-- b",
        "a <!-- b -->c",
        "a <!-- b --!>c",
        "a <!---->c",
        "a <!--->c",
        "a <!-- -- -->c",
        "a <!-- <p> -->c",
        "a <!-- b -- >c",
        "a <![CDATA[b]]>c",
        "a <![CDATA[b",
        "a <![if x]>b<![endif]>c",
        "a <!DOCTYPE html>b",
        "a <!doctype html>b",
        "a <!DOCTYPE>b",
        "a <!x>b",
        "a <!x y>b",
        "a <?php echo 1; ?>b",
        "a <?xml version='1.0'?>b",
        "a <? b",
        "a <?b>c",
        "a <?b?>c",
        "a <%= b %>c",
        "a <p<b>c",
        "a <p\x00>b",
        "a <p\nclass='x'\n>b</p>",
        "a <p\tclass='x'>b</p>",
        "a <p/ class='x'>b</p>",
        "a <p class='x'/>b",
        "a <p class='x' />b",
        "a <p class=x/>b",
        "a <p class=x />b",
        'a <p class="x"y="z">b</p>',
        'a <p class="x"/y="z">b</p>',
        "a <p =x>b</p>",
        "a <p 'x'>b</p>",
        'a <p "x">b</p>',
        "a <p x y z>b</p>",
        "a <p x=1 y=2 z=3>b</p>",
        "a <p x=1 x=2>b</p>",
        "a <p x='1' X='2'>b</p>",
        "a <p x='a>b'>c</p>",
        "a <p x=\"a'b\">c</p>",
        "a <p x='a\"b'>c</p>",
        "a <p x=a'b>c</p>",
        "a <p x=a\"b>c</p>",
        "a <p x=&amp;>b</p>",
        "a <p x='&amp;'>b</p>",
        "a <p x='&amp'>b</p>",
        "a <p x='&bogus;'>b</p>",
        "a <p x='&#65;&#x42;'>b</p>",
        "a <p\U000000a0x>b</p>".replace("\U000000a0", "\U000000a0"),
        "a <p\x0cx>b</p>",
        "a <p\rx>b</p>",
        "a <\U000000e9>b</\U000000e9>",
        "a <x\U000000e9>b</x\U000000e9>",
        "a <\U0001f600>b",
        "a <p>b</p\n>c",
        "a <p>b</p x>c",
        "a <p>b</p x='y'>c",
        "a <p>b</p/>c",
        "a <p>b</ p>c",
        "a &amp b",
        "a &amp; b",
        "a &AMP; b",
        "a &Amp; b",
        "a &lt b",
        "a &lt; b &gt; c",
        "a &quot;b&quot; &apos;c&apos;",
        "a &nbsp;b&nbsp c",
        "a &copy; &copy b &COPY c",
        "a &notit; b",
        "a &not; b &notin; c &notinx; d",
        "a &#65; &#x41; &#X41; &#65 &#x41 b",
        "a &#0; b",
        "a &#128; b &#x80; c &#150; d",
        "a &#xD800; b &#xDFFF; c &#x110000; d &#1114111; e",
        "a &#x1F600; &#128512; b",
        "a &#; &#x; &#xZ; &# b",
        "a &#9999999999; b",
        "a &#65;&#66 c",
        "a &#1; &#2; &#31; &#127; &#159; b",
        "a &#13; &#10; &#9; b",
        "a &bogus; b",
        "a & b",
        "a &",
        "a &a",
        "a &amp",
        "a &amp;amp; b",
        "a &lt;b&gt; c",
        "a &LT; &GT; b",
        "a &Aacute; &aacute; &Aacutex; b",
        "a &fjlig; &NotEqualTilde; &ThickSpace; b",
        "a &zwj; &zwnj; &shy; b",
        "a &#x200B; &#xAD; &#xFEFF; b",
        "a \x00 b",
        "a \x01 b",
        "a \x0b b",
        "a \x1b b",
        "a \x7f b",
        "a \x85 b",
        "a \U00002028 b".replace("\U00002028", "\U00002028"),
        "a \U00002029 b",
        "a \U0000feff b",
        "a \U0000fffe b",
        "a \U0000ffff b",
        "a \ud800 b".encode("utf-16", "surrogatepass").decode("utf-16", "replace"),
        "a \r\n b",
        "a \r b",
        "a \n\r b",
        "<p>a\r\n\r\n\r\nb</p>",
        "<p>a</p>\r\n<p>b</p>",
        "a\x0bb\x0cc",
        "a\xa0\xa0b",
        "a \U00002003 b \U00002009",
        "\U0000feffbom",
        "<p>\U0001f600</p>",
    ):
        case(text)
        case(text, "text")


def link_cases() -> None:
    for html_ in (
        'a <a href="https://example.com">b</a> c',
        'a <a href="https://example.com">b <b>c</b></a> d',
        'a <a href="https://example.com">https://example.com</a> d',
        'a <a href="https://example.com/">https://example.com</a> d',
        'a <a href="https://example.com">https://example.com/more</a> d',
        'a <a href="https://example.com">b</a><a href="https://example.org">c</a> d',
        'a <a href="https://example.com">b<a href="https://example.org">c</a>d</a> e',
        'a <a href="https://example.com">b<a href="https://example.org">c d',
        'a <a href="https://example.com">b<a href="https://example.org">c</a>',
        'a <a href="https://example.com">b</a></a> c',
        'a <a href="https://example.com">b</a> <a href="https://example.com">',
        '<a href="https://example.com"><br></a>',
        '<a href="https://example.com"><p>one</p><p>two</p></a>',
        '<a href="https://example.com"><blockquote>q</blockquote>label</a>',
        '<a href="https://example.com"><at id="0">Ada</at></a>',
        '<a href="https://example.com"><at id="1">Ada</at> label</a>',
        '<a href="https://example.com"><img src="x"></a>',
        '<a href="https://example.com"><emoji alt="x">y</emoji></a>',
        '<a href="https://example.com"><li>item</li></a>',
        '<a href="https://example.com">a\nb</a>',
        '<a href="https://example.com">a   </a>',
        '<a href="https://example.com">\xa0</a>',
        '<a href="https://example.com">label</a>   after   ',
        '<a href="https://example.com/teams.microsoft.com">label</a>',
        '<a href="https://example.com">teams.microsoft.com</a>',
        '<a href="https://example.com">see teams.microsoft.com/l/x ok</a>',
        '<a href="https://example.com">msteams:x</a>',
        '<a href="https://example.com">label</a> then teams.live.com/x and more',
        '<a href="https://example.com/ teams.microsoft.com">label</a>',
        '<a href="https://example.com/x">label</a> and https://example.com/x?teams%2Emicrosoft.com',
        'visit teams.microsoft.com now',
        'visit TEAMS.MICROSOFT.COM now',
        'visit teams.microsoft.comx now',
        'visit xteams.microsoft.com now',
        'visit teams.microsoft.co now',
        'visit teams.microsoft.com.evil.example now',
        'visit (teams.microsoft.com/l/x), now',
        'visit <teams.microsoft.com/l/x> now',
        'visit "teams.microsoft.com/l/x" now',
        'visit [x](teams.microsoft.com/l/x) now',
        'visit www.teams.microsoft.com now',
        'visit teams.microsoft.com\ttabs\tmore',
        'visit teams.mic\nrosoft.com now',
        'visit teams.mic\trosoft.com now',
        'visit teams.mic\rrosoft.com now',
        'visit te\nams.microsoft.com now',
        'visit t\ne\na\nm\ns\n.\nmicrosoft.com now',
        'visit teams. microsoft.com now',
        'visit teams .microsoft.com now',
        'visit teams.microsoft.com\U000000a0now'.replace("\U000000a0", "\U000000a0"),
        'visit msteams: now',
        'visit msteams:// now',
        'visit MsTeams:x now',
        'visit msteams x now',
        'visit ms teams: now',
        'visit xmsteams:y now',
        'visit teams\U0000ff0emicrosoft\U0000ff0ecom now',
        'visit teams\U00003002microsoft\U00003002com now',
        'visit teams\U0000ff61microsoft\U0000ff61com now',
        'visit \U0000ff34\U0000ff25\U0000ff21\U0000ff2d\U0000ff33\U0000ff0e\U0000ff2d\U0000ff29\U0000ff23\U0000ff32\U0000ff2f\U0000ff33\U0000ff2f\U0000ff26\U0000ff34\U0000ff0e\U0000ff23\U0000ff2f\U0000ff2d now',
        'visit teams.microsoft.com/\U0000d7ff now'.encode("utf-16", "surrogatepass").decode("utf-16", "replace"),
        'visit teams&#46;microsoft&#46;com now',
        'visit teams&#x2E;microsoft&#x2E;com now',
        'visit teams&amp;#46;microsoft&amp;#46;com now',
        'visit teams%2Emicrosoft%2Ecom now',
        'visit teams%252Emicrosoft%252Ecom now',
        'visit teams%25252Emicrosoft%25252Ecom now',
        'visit teams%2525252Emicrosoft%2525252Ecom now',
        'visit teams%2emicrosoft%2ecom now',
        'visit %74eams.microsoft.com now',
        'visit %74%65%61%6d%73.microsoft.com now',
        'visit %zzteams.microsoft.com now',
        'visit %teams.microsoft.com now',
        'visit teams.microsoft.com%00 now',
        'visit teams.microsoft.com%ff now',
        'visit teams.microsoft.com%c3%a9 now',
        'visit te\U0000200bams.microsoft.com now',
        'visit te\U0000200cams.microsoft.com now',
        'visit te\U0000200dams.microsoft.com now',
        'visit te\U000000adams.microsoft.com now',
        'visit te\U00002060ams.microsoft.com now',
        'visit te\U0000feffams.microsoft.com now',
        'visit te\U0000202eams.microsoft.com now',
        'visit te\U000e0041ams.microsoft.com now',
        'visit te\\ams.microsoft.com now',
        'visit teams\\.microsoft\\.com now',
        'visit teams.microsoft\U0000ff0ecom now',
        'visit teams.microsoft.c\U0000ff4fm now',
        'visit teams.microsoft.\U0001d41c\U0001d428\U0001d426 now',
        'visit \U0001d42d\U0001d41e\U0001d41a\U0001d426\U0001d42c.microsoft.com now',
        'visit teams.\U0000212bicrosoft.com now'.replace("\U0000212b", "\U0000212b"),
        'visit teams.microsoft.com\U00002028now'.replace("\U00002028", "\U00002028"),
        'visit teams.\U0000212aicrosoft.com now',
        'visit teams.mi\U0000212arosoft.com now',
        'visit \U0000017feams.microsoft.com now',
        'visit teams.microsoft.com\U0000017f now',
        'visit TEAM\U0000017f.microsoft.com now',
        'visit teams.m\U00000130crosoft.com now',
        'visit teams.m\U00000131crosoft.com now',
        'visit teams.m\U00000049crosoft.com now',
        'visit teams.m\U00000069crosoft.com now',
        'visit teams.microsoft.us now',
        'visit teams.microsoft.US now',
        'visit teams.live.com now',
        'visit teams.cloud.microsoft now',
        'visit teams.office.com now',
        'visit teams.microsoftonline.cn now',
        'visit teams.microsoftonline.com now',
        'visit teams.microsoftonline.CN now',
        'visit dod.teams.microsoft.us now',
        'visit gov.teams.microsoft.us now',
        'visit teams.microsoft now',
        'visit teams.microsoft. com now',
        'visit teams.microsoft.org now',
        'visit teams.microsoftonline.net now',
        'visit teams.cloud.microsoft.evil now',
        'visit teams.cloud.micro now',
        'visit teams.live.co now',
        'visit teams.office.co now',
    ):
        case(html_)
        case(html_, "text")


def structure_cases() -> None:
    case(FULL.replace("<div>", "<div>" * 50).replace("</div>", "</div>" * 50), "html", 2)
    case("<p>" * 5000 + "deep" + "</p>" * 5000)
    case("<b>" * 3000 + "deep")
    case("<blockquote>" * 2000 + SECRET)
    case('<a href="https://example.com">' * 500 + "label" + "</a>" * 500)
    case('<a href="https://example.com">' * 500 + "label")
    case("<at>" * 500 + SECRET)
    case("<script>" * 500 + SECRET)
    case(("<li>item" + "\n") * 2000)
    case(("<p>item</p>") * 2000)
    case("<br>" * 5000)
    case("x" * 100_000)
    case("<p>" + "word " * 20_000 + "</p>")
    case("&amp;" * 20_000)
    case("<" * 5000)
    case("<a " * 5000)
    case('<a href="' + "x" * 100_000 + '">y</a>')
    case("<" + "x" * 100_000 + ">y")
    case("<!--" * 3000)
    case("<![CDATA[" * 3000)
    case("a" * 50_000 + "<")
    case("<p>" + "\n" * 100 + "x</p>")
    case("<ul>" + "<li>" * 200 + "x</ul>")
    case("<table>" + "<tr><td>a</td><td>b</td></tr>" * 500 + "</table>")


def fuzz_cases() -> None:
    vocabulary = [
        "<", ">", "</", "/>", "<p>", "</p>", "<br>", "<br/>", "<div>", "</div>", "<li>", "</li>", "<ul>", "</ul>", "<td>", "</td>", "<tr>", "</tr>",
        "<at id=\"0\">", "<at id=\"1\">", "<at id=\"2\">", "<at>", "</at>", "<at/>", "<a href=\"https://example.com\">", "<a href=\"https://teams.microsoft.com/x\">",
        "<a href='x'>", "<a href=x>", "<a>", "</a>", "<a/>", "<blockquote>", "</blockquote>", "<blockquote/>", "<emoji alt=\"x\">", "</emoji>", "<emoji/>",
        "<script>", "</script>", "<style>", "</style>", "<attachment id=\"1\">", "</attachment>", "<img src=\"x\">", "<title>", "</title>", "<head>", "</head>",
        "<template>", "</template>", "<!--", "-->", "<![CDATA[", "]]>", "<!DOCTYPE x>", "<?x?>", "<!", "<?", " ", "\n", "\r\n", "\t", "\xa0", "&nbsp;", "&amp;",
        "&lt;", "&gt;", "&quot;", "&#65;", "&#x41;", "&#0;", "&#xD800;", "&bogus;", "&", "&#", ";", "\"", "'", "=", " id=", " href=", " alt=", " id=\"0\"",
        " href=\"teams.microsoft.com\"", "teams.microsoft.com", "msteams:", "teams%2Emicrosoft%2Ecom", "TEAMS.LIVE.COM", "https://example.com", "word", "x y z",
        "\U0001f600", "\x00", "\x01", "\U0000feff", "\U0000200b", "\U000000ad", "\U0000ff0e", "\U00003002", "\\", "%2E", "%", "%zz", "/", "!", "?",
    ]  # fmt: skip
    seeds = [
        FULL,
        'Hi <at id="0">Ada</at>, see <a href="https://example.com/a">docs</a> <blockquote itemid="1"><b>Bob</b>quote</blockquote> done',
        '<p>one</p><ul><li>a</li><li>b &amp; c</li></ul><table><tr><td>x</td><td>y</td></tr></table><p>two<br>three</p>',
        '<a href="https://teams.microsoft.com/l/x">label</a> <at id="1">c</at> <emoji alt="\U0001f600">:)</emoji> <script>s</script> after',
        'see teams.microsoft.com/l/x and msteams://y and https%3A%2F%2Fteams%2Emicrosoft%2Ecom/z ok',
        '<div><div><blockquote><at id="2">t</at><a href=x>y</a></blockquote></div>tail<attachment id="9">z</attachment></div>',
    ]

    def mutate(text: str) -> str:
        for _ in range(random.randint(1, 4)):
            at = random.randint(0, len(text))
            kind = random.random()
            if kind < 0.5:
                text = text[:at] + random.choice(vocabulary) + text[at:]
            elif kind < 0.7:
                text = text[:at] + text[at + random.randint(1, 8) :]
            elif kind < 0.85:
                text = text[:at] + random.choice(vocabulary) + text[at + random.randint(1, 3) :]
            else:
                end = min(len(text), at + random.randint(1, 30))
                text = text[:end] + text[at:end] + text[end:]
        return text

    for n in range(MUTATED):
        text = mutate(seeds[n % len(seeds)])
        case(text, "html" if n % 40 else "text", random.randrange(len(MENTION_SETS)))
    # Random sequences of the vocabulary.
    for _ in range(SEQUENCES):
        case("".join(random.choice(vocabulary) for _ in range(random.randint(1, 25))), "html", random.randrange(len(MENTION_SETS)))
    for kind in ("HTML", "Html", "text", "TEXT", "Text", " text", "text ", "plain", "", None, "html ", "tEXT"):
        case("  <b>x</b> &amp; teams.microsoft.com ", kind)
        case(None, kind)
        case("", kind)


def mentions_of(items: list[dict]) -> list[Mention]:
    return [Mention.model_validate(item) for item in items]


def read_outcome(content: str | None, kind: str | None, index: int) -> dict:
    try:
        return {"text": html.read(content, kind, mentions_of(MENTION_SETS[index]))}
    except RecursionError:
        return {"raises": "RecursionError"}


# ---------------------------------------------------------------------------------------------------------------
# Addresses and written text.

ADDRESSES = [
    "teams.microsoft.com", "TEAMS.MICROSOFT.COM", "Teams.Microsoft.Com", "teams.microsoft.us", "teams.live.com", "teams.cloud.microsoft", "teams.microsoftonline.cn",
    "teams.office.com", "msteams:", "MSTEAMS:", "msteams://x", "teams.microsoft.org", "teams.microsoftonline.com", "teams.microsoft", "teams.microsof",
    "eams.microsoft.com", "xteams.microsoft.com", "teams.microsoft.comx", "teams.microsoft.com.evil.example", "teams microsoft com", "teams-microsoft.com",
    "teams_microsoft.com", "teamsXmicrosoft.com", "teams.microsoft\\.com", "teams\\.microsoft.com", "msteams", "msteams;", "ms-teams:", "msteam:", "msteams",
    "teams%2Emicrosoft%2Ecom", "teams%2emicrosoft%2ecom", "teams%252Emicrosoft%252Ecom", "teams%25252Emicrosoft%25252Ecom", "teams%2525252Emicrosoft%2525252Ecom",
    "%74eams.microsoft.com", "%54EAMS.microsoft.com", "teams.microsoft.%63om", "teams.microsoft.c%6fm", "msteams%3A", "msteams%3a//x", "msteams%253A",
    "teams&#46;microsoft&#46;com", "teams&#x2E;microsoft&#x2E;com", "teams&period;microsoft&period;com", "teams&amp;#46;microsoft&amp;#46;com", "te&#97;ms.microsoft.com",
    "teams&NewLine;.microsoft.com", "teams.microsoft.com&nbsp;x", "mste&#97;ms:", "&#109;steams:",
    "teams\U0000ff0emicrosoft\U0000ff0ecom", "teams\U00003002microsoft\U00003002com", "teams\U0000ff61microsoft\U0000ff61com", "teams\U0000ff0emicrosoft.com",
    "\U0000ff54\U0000ff45\U0000ff41\U0000ff4d\U0000ff53.microsoft.com", "\U0001d42d\U0001d41e\U0001d41a\U0001d426\U0001d42c.microsoft.com", "teams.microsoft.\U0001d41c\U0001d428\U0001d426",
    "te\U0000200bams.microsoft.com", "te\U0000200cams.microsoft.com", "te\U0000200dams.microsoft.com", "te\U000000adams.microsoft.com", "te\U00002060ams.microsoft.com",
    "te\U0000feffams.microsoft.com", "te\U0000202eams.microsoft.com", "te\U000e0041ams.microsoft.com", "te\U000000a0ams.microsoft.com", "te\U00002028ams.microsoft.com",
    "te\tams.microsoft.com", "te\nams.microsoft.com", "te\rams.microsoft.com", "te\r\nams.microsoft.com", "te\x0bams.microsoft.com", "te\x0cams.microsoft.com",
    "te ams.microsoft.com", "te\x00ams.microsoft.com", "te\x7fams.microsoft.com", "te\U00000085ams.microsoft.com", "te\\ams.microsoft.com",
    "te%09ams.microsoft.com", "te%0Aams.microsoft.com", "te%0dams.microsoft.com", "te&#9;ams.microsoft.com", "te&#10;ams.microsoft.com", "te&Tab;ams.microsoft.com",
    "te%0009ams.microsoft.com", "te%2509ams.microsoft.com",
    "\U0000212aams.microsoft.com", "teams.\U0000212aicrosoft.com", "teams.mi\U0000212arosoft.com", "\U0000017feams.microsoft.com", "TEAM\U0000017f.microsoft.com",
    "teams.m\U00000130crosoft.com", "teams.m\U00000131crosoft.com", "teams.m\U00000049crosoft.com", "teams.m\U0000ff49crosoft.com", "teams.m\U00000069crosoft.com",
    "teams.m\U00002170crosoft.com", "teams.m\U00002148crosoft.com", "teams.m\U0001d422crosoft.com", "\U0000fb06eams.microsoft.com", "\U0000fb05eams.microsoft.com",
    "te\U0000fb06.microsoft.com", "teams.microsoft\U00002024com", "teams.microsoft\U0000fe52com", "teams.microsoft\U00002025com", "teams.micro\U0000fb06.com",
    "\U0000212b", "\U00002126", "mi\U0001d4e2rosoft", "teams.microsoft.c\U0000ff4fm", "teams.microsoft.\U000024d2om", "teams.microsoft.\U000033c7m",
    "teams.microsoft.com\U0000ff0f", "teams.microsoft.com/l/channel/19%3aabc@thread.tacv2", "https://teams.microsoft.com/l/channel/x", "https://dod.teams.microsoft.us/l/x",
    "https://teams.microsoftonline.cn/l/x", "https://TEAMS.LIVE.COM/x", "http://teams.microsoft.com", "//teams.microsoft.com", "teams.microsoft.com:443/x",
    "user@teams.microsoft.com", "https://user:pw@teams.microsoft.com/x", "?u=teams.microsoft.com", "#teams.microsoft.com", "x.y/teams.microsoft.com",
    "example.com", "https://example.com/a?b=c", "plain", "", " ", "see", "ms", "teams", "microsoft", "com", ".", ":", "msteams:x:y", "teamsmsteams:",
    "t.e.a.m.s", "teams.microsoft.com\U00000300", "teams.microsoft.com\U0000200b", "\U0001f600teams.microsoft.com\U0001f600", "caf\U000000e9",
    "%", "%%", "%2", "%2E", "%zz", "%e0%a4%a", "%ff%fe", "&", "&#", "&#x;", "&#9999999999;", "&bogus;", "&amp", "&amp;amp;amp;amp;", "%2525252525252E",
    "teams.microsoft.com" * 100, "x" * 10000 + "teams.microsoft.com", "teams.microsoft.com" + "x" * 10000, "%25" * 100 + "2E",
]  # fmt: skip

SENTENCES = [
    "see {a} ok", "see {a}, ok", "see ({a}) ok", "{a}", "x{a}", "{a}x", "a {a} b {a} c", "line one\n{a}\nline three", "{a}\t{a}", "a\xa0{a}\xa0b", "  {a}  ",
    "a {a}\r\nb", "a  {a}  b", "(a){a}(b)", "a\U00002003{a}\U00002003b".replace("\U00002003", "\U00002003"),
]


def redact_cases() -> list[str]:
    cases = list(ADDRESSES)
    for sentence in SENTENCES:
        for address in ADDRESSES[:40:3]:
            cases.append(sentence.format(a=address))
    cases += [
        "see teams.microsoft.com and plain words and msteams: here",
        "a  b   c",
        "a\nb\n\nc",
        "\xa0",
        "a\U00002028b".replace("\U00002028", "\U00002028"),
        "\U00002029",
        "a\x1cb\x1dc\x1ed\x1fe",
        "a\x85b",
        "a\x0bb\x0cc",
        "a\U0000feffb",
        "\U0000feff teams.microsoft.com".replace("\U0000feff", "\U0000feff"),
        "x\U0000200bteams.microsoft.com",
        "word\U0000200bword teams.microsoft.com",
        "\U0000180e x",
        "a\U0000180eb",
        "a\U00001680b",
        "a\U0000205fb",
        "a\U00003000b",
        "a\U0000202fb",
        "a\U0000200ab",
        "a\U00002007b",
        "a\U0000001fb",
        "a\U0000001cb",
        "a\U0000007fb",
        "a\U00000085b",
        "a\U000000a0b",
    ]
    for _ in range(JUNKED):
        base = random.choice(ADDRESSES[:140])
        at = random.randint(0, len(base))
        junk = random.choice(["\t", "\n", "\r", " ", "%", "\\", "\U0000200b", "&", "#", ";", "\U000000ad", "x", "%25", "%0a", "&#10;", "\U0000ff0e", "."])
        cases.append(random.choice(SENTENCES).format(a=base[:at] + junk + base[at:]))
    return cases


WRITTEN = [
    "hello", "", " ", "a & b", "<b>bold</b>", '<at id="0">x</at>', "'single' \"double\"", "line one\nline two", "line one\r\nline two", "line one\rline two",
    "a\n\nb", "a\r\n\r\nb", "\n", "\r\n", "\r", "tab\tchar", "\x00", "\x01", "\x07", "\x08", "\x0b", "\x0c", "\x0e", "\x1f", "\x7f", "\x80", "\x85", "\xa0",
    "\U0000200b", "\U00002028", "\U0001f600", "caf\U000000e9", "&amp;", "&lt;", "&#65;", "&", ";", "x" * 4000, "x" * 4001, "<" * 4000,
    "see https://teams.microsoft.com/l/channel/x", "see https%3A%2F%2Fteams%2Emicrosoft%2Ecom/x", "open msteams://x", "TEAMS.LIVE.COM/x", "bell \x07",
    "ok https://example.com/x", "teams", "microsoft", "teams.microsoft", "te ams.microsoft.com", "te\nams.microsoft.com", "te\tams.microsoft.com",
    "te\rams.microsoft.com", "teams.\nmicrosoft.com", "tea\r\nms.microsoft.com", "t\te\na\rm\ts.microsoft.com", "teams.microsoft.com\x07",
    "teams&#46;microsoft&#46;com", "teams&amp;#46;microsoft&amp;#46;com", "TEAMS.OFFICE.COM", "teams.cloud.microsoft", "MSTEAMS:", "teams\U0000ff0emicrosoft\U0000ff0ecom",
    "\U0000ff54eams.microsoft.com", "te\U0000200bams.microsoft.com", "te\U000000adams.microsoft.com", "\U0000212aams", "ms\U0000212aams:", "msteams%3A",
]  # fmt: skip


def check_outcome(text: str) -> dict:
    try:
        return {"value": html.check_written(text)}
    except ValueError as error:
        return {"error": str(error)}


# ---------------------------------------------------------------------------------------------------------------
# The letters Teams addresses are matched with: what re.IGNORECASE makes of each.

BASES = ["teams.microsoft.com", "teams.live.com", "teams.cloud.microsoft", "teams.microsoftonline.cn", "teams.office.com", "msteams:"]


def letters() -> list[dict]:
    """For each character of each address: the code points that can stand in for it, found by the pattern itself."""
    found: list[dict] = []
    for base in BASES:
        for at in range(len(base)):
            points = [
                cp
                for cp in range(0x30000)
                if not 0xD800 <= cp <= 0xDFFF and html._TEAMS.search(base[:at] + chr(cp) + base[at + 1 :]) is not None
            ]
            found.append({"base": base, "at": at, "points": points})
    return found


# ---------------------------------------------------------------------------------------------------------------
# Tool inputs.

ENG = "aaaaaaaa-0000-0000-0000-000000000001"
GENERAL = "19:general0001@thread.tacv2"


def validation_message(error: ValidationError) -> str:
    # connectors/executor.py validation_message, which imports Django.
    problems = [f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]]
    return "Invalid arguments. " + "; ".join(problems)


def pack(value):
    """A long run of one character is stored as a recipe: {"$repeat": [character, count]}."""
    if isinstance(value, str) and len(value) > 1000 and len(set(value)) == 1:
        return {"$repeat": [value[0], len(value)]}
    if isinstance(value, dict):
        return {key: pack(item) for key, item in value.items()}
    return value


def validated(model, raw):
    try:
        return {"data": pack(model.model_validate(raw).model_dump(mode="json"))}
    except ValidationError as error:
        return {"message": validation_message(error)}
    except (OverflowError, TypeError) as error:
        return {"raises": type(error).__name__}


TEAM_IDS = [
    ENG, ENG.upper(), " " + ENG + " ", "AAAAAAAA-0000-0000-0000-000000000001", ENG[:-1], ENG + "0", ENG.replace("-", ""), ENG.replace("a", "g"), "", "eng", None, 5, ENG + "\n",
    "aaaaaaaa-0000-0000-0000-00000000000\U00000661", "\U0000ff41aaaaaaa-0000-0000-0000-000000000001", ENG.replace("0", "\U00000660", 1), "AAAAAAAA-0000-0000-0000-00000000000A",
    "\U0000212aaaaaaa-0000-0000-0000-000000000001", "aaaaaaaa-0000-0000-0000-000000000001".upper().replace("A", "\U00000410", 1), "a" * 36, "-" * 36, " " * 36,
]  # fmt: skip
CHANNEL_IDS = [
    GENERAL, " " + GENERAL, GENERAL + "\n", GENERAL.upper(), GENERAL.replace("general", "GENERAL"), "19:x@thread.tacv2", "19:@thread.tacv2", "19:" + "a" * 200 + "@thread.tacv2",
    "19:" + "a" * 201 + "@thread.tacv2", "19:a@thread.", "19:a@thread.x", "19:a@thread." + "x" * 20, "19:a@thread." + "x" * 21, "19:a@thread.TACV2", "19:a@thread.tac_v2",
    "19:a b@thread.tacv2", "19:a\U000000e9@thread.tacv2".replace("\U000000e9", "\U000000e9"), "19:a@thread.tacv2x", "18:a@thread.tacv2", "General", "", None, 5, "x" * 240, "x" * 241,
    "19:a.b_c=d+e-f@thread.skype", "19:a@thread.v2", "19:A@thread.tacv2", "19:a%40thread.tacv2", "19:a@Thread.tacv2", "19:a@thread.\U00000661",
]  # fmt: skip
MESSAGE_IDS = [
    "1001", " 1001 ", "0", "00", "1" * 20, "1" * 21, "", "abc", "-1", "+1", "1.5", "1e3", "1 2", "1_0", "\U00000661\U00000662", "\U0000ff11", "1001\n", "1\U000000b2", None, 1001, 1.5, True,
    "\U00000661" * 20, "\U00000661" * 21, "0x10", " ", "\U00000661\U00000662\U00000663",
]  # fmt: skip
TEXTS = [
    "hello", " hello ", "", " ", "x" * 4000, "x" * 4001, "\U0001f600" * 4000, "\U0001f600" * 4001, "a\nb", "a\tb", "a\x00b", "a\x07b", "a\x7fb", "a\x1bb", "a\rb", "a\x0bb",
    "see teams.microsoft.com/x", "see TEAMS.LIVE.COM/x", "msteams://x", "bell \x07", "<b>x</b>", None, 5, ["x"],
]  # fmt: skip
LIMITS = [None, 1, 20, 50, 0, 51, -1, "5", 5.5, True, "x", [], {}]
CURSORS = [None, "", "t:abc", "x" * 1000, "x" * 1001, " t:abc ", "t:", "\U000000e9", 5, {}, "t:" + "a" * 990]


def inputs() -> dict:
    out: dict[str, list] = {
        "list_teams": [{}, {"x": 1}, []],
        "list_channels": [{}, {"team_id": None}, *({"team_id": t} for t in TEAM_IDS), {"team_id": ENG, "x": 1}, {"x": 1}],
        "read_channel": [],
        "read_thread": [],
        "post_message": [],
        "reply": [],
    }
    for team in (ENG, ENG.upper(), "bad", None):
        for channel in (GENERAL, "bad", None):
            out["read_channel"].append({"team_id": team, "channel_id": channel})
    for team in TEAM_IDS:
        out["read_channel"].append({"team_id": team, "channel_id": GENERAL})
        out["read_thread"].append({"team_id": team, "channel_id": GENERAL, "message_id": "1001"})
        out["post_message"].append({"team_id": team, "channel_id": GENERAL, "text": "hello"})
        out["reply"].append({"team_id": team, "channel_id": GENERAL, "message_id": "1001", "text": "hello"})
    for channel in CHANNEL_IDS:
        out["read_channel"].append({"team_id": ENG, "channel_id": channel})
        out["read_thread"].append({"team_id": ENG, "channel_id": channel, "message_id": "1001"})
        out["post_message"].append({"team_id": ENG, "channel_id": channel, "text": "hello"})
        out["reply"].append({"team_id": ENG, "channel_id": channel, "message_id": "1001", "text": "hello"})
    for limit in LIMITS:
        out["read_channel"].append({"team_id": ENG, "channel_id": GENERAL, "limit": limit})
        out["read_thread"].append({"team_id": ENG, "channel_id": GENERAL, "message_id": "1001", "limit": limit})
    for cursor in CURSORS:
        out["read_channel"].append({"team_id": ENG, "channel_id": GENERAL, "cursor": cursor})
        out["read_thread"].append({"team_id": ENG, "channel_id": GENERAL, "message_id": "1001", "cursor": cursor})
    for message in MESSAGE_IDS:
        out["read_thread"].append({"team_id": ENG, "channel_id": GENERAL, "message_id": message})
        out["reply"].append({"team_id": ENG, "channel_id": GENERAL, "message_id": message, "text": "hello"})
    for text in TEXTS:
        out["post_message"].append({"team_id": ENG, "channel_id": GENERAL, "text": text})
        out["reply"].append({"team_id": ENG, "channel_id": GENERAL, "message_id": "1001", "text": text})
    for text in WRITTEN:
        out["post_message"].append({"team_id": ENG, "channel_id": GENERAL, "text": text})
    out["read_channel"] += [{}, {"team_id": ENG}, {"channel_id": GENERAL}, {"team_id": ENG, "channel_id": GENERAL, "extra": 1}]
    out["read_thread"] += [{}, {"team_id": ENG, "channel_id": GENERAL}, {"team_id": ENG, "channel_id": GENERAL, "message_id": "1", "extra": 1}]
    out["post_message"] += [{}, {"team_id": ENG, "channel_id": GENERAL}, {"team_id": ENG, "channel_id": GENERAL, "text": "x", "extra": 1}]
    out["reply"] += [{}, {"team_id": ENG, "channel_id": GENERAL, "text": "x"}, {"team_id": ENG, "channel_id": GENERAL, "message_id": "1", "text": "x", "extra": 1}]
    models = {
        "list_teams": teams.ListTeams,
        "list_channels": teams.ListChannels,
        "read_channel": teams.ReadChannel,
        "read_thread": teams.ReadThread,
        "post_message": teams.PostMessage,
        "reply": teams.Reply,
    }
    return {tool: [{"args": pack(raw), **validated(models[tool], raw)} for raw in cases] for tool, cases in out.items()}


def main() -> None:
    python_tests()
    tag_cases()
    attribute_cases()
    parser_cases()
    link_cases()
    structure_cases()
    fuzz_cases()
    redactions = redact_cases()
    vectors = {
        "mention_sets": MENTION_SETS,
        "read": [{"content": pack(content), "type": kind, "mentions": index, **read_outcome(content, kind, index)} for content, kind, index in CASES],
        "redact": [{"text": text, "value": html.redact(text), "teams": html._to_teams(text)} for text in redactions],
        "check_written": [{"text": pack(text), **check_outcome(text)} for text in [*WRITTEN, *ADDRESSES]],
        "written": [{"text": pack(text), "value": html.written(text)} for text in WRITTEN],
        "letters": letters(),
        "inputs": inputs(),
    }
    (HERE / "vectors.json").write_text(json.dumps(compact(vectors), ensure_ascii=True, separators=(",", ":")) + "\n")


if __name__ == "__main__":
    main()
