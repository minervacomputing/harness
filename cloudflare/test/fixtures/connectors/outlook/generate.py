"""Writes what today's Python computes for the Outlook connector's port, as vectors.json: mail addresses
(`connectors.addresses`), times (`reads._moment`), and the normalized arguments or validation message of
Outlook's tool inputs. (The IDNA tables mail domains are encoded with are written by the Google generator,
../google/generate.py, and the case folding table by the Xero one, into src/lib/.)

Only connector modules are imported, which load no configuration. Run from cloudflare/:
cd ../backend && uv run python -I ../cloudflare/test/fixtures/connectors/outlook/generate.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
CLOUDFLARE = HERE.parents[3]
BACKEND = CLOUDFLARE.parent / "backend"
sys.path.insert(0, str(BACKEND))

from pydantic import ValidationError  # noqa: E402

from connectors import addresses  # noqa: E402
from connectors.base import OperationError  # noqa: E402
from connectors.outlook import reads, writes  # noqa: E402


def outcome(call):
    try:
        return {"value": call()}
    except OperationError as error:
        return {"error": error.code}
    except ValueError as error:
        return {"error": "ValueError", "message": str(error)}
    except OverflowError:
        return {"error": "OverflowError"}


ADDRESSES = [
    "Ada@Example.COM", " ada.lovelace+notes@mail.example.com ", "o'brien@bücher.de", "Giulia@TrattoriaRossa.example",
    "ada", "ada@", "@example.com", "ada@@example.com", "a@b@example.com", '"ada"@example.com', "ada lovelace@example.com",
    ".ada@example.com", "ada.@example.com", "a..b@example.com", "ada@localhost", "ada@127.0.0.1", "ada@co.uk", "ada@com",
    "ada@example", "ada@site.invalid", "Ada <ada@example.com>", "ädä@example.com", "ada@exa\nmple.com", "a" * 65 + "@example.com",
    "a" * 64 + "@example.com", "ada@xn--bcher-kva.de", "ada@XN--BCHER-KVA.DE", "ada@bücher.de.", "ada@bücher。de", "ada@ＥＸＡＭＰＬＥ.com",
    "ada@例え.jp", "ada@münchen.de", "ada@straße.de", "ada@faß.de", "ada@☃.net", "ada@a_b.com", "ada@-ab.com", "ada@ab-.com",
    "ada@ab--cd.com", "ada@xn--ab.com", "ada@xn--.com", "ada@xn--abc-.com", "ada@a.b.ck", "ada@www.ck", "ada@github.io",
    "ada@x.github.io", "ada@[1.2.3.4]", "ada@1.2.3.4", "ada@::1", "ada@0x7f.1", "ada@127.1", "ada@example.123", "ada@ex%41mple.com",
    "ada@אב.com", "ada@אב1.com", "ada@1א.com", "ada@العربية.com",
    "ada@a‍b.com", "ada@क्‍ष.com", "ada@l·l.com", "ada@a·b.com", "ada@́a.com",
    "ada@a­b.com", "ada@ab️.com", "ada@\U0001f600.com", "ada@ex ample.com", "ada@" + "a" * 63 + ".com",
    "ada@" + "a" * 64 + ".com", "ada@" + ".".join(["abcdefghi"] * 20) + ".com", "%@example.com", "a+b%c'd_e-f@example.com",
    "ada@mail.Example.com", "Ada@例え.テスト", "ada@trattoriarossa.example", "ada@xn--p1ai", "ada@пример.рф", "ADA@ПРИМЕР.РФ",
    "ada@ﬁle.com", "ada@ℌ.com", "ada@ⓐ.com", "ada@a。b.com", "ada@a．b.com", "ada@a｡com",
]  # fmt: skip

IDS = [
    "ada@example.com", "*@example.com", "*@co.uk", "*@*.example.com", "*@Example.com", "Ada@example.com", "*", "unsupported",
    "*@mail.example.com", "giulia@trattoriarossa.example", "*@trattoriarossa.example", "*@example", "ada@xn--bcher-kva.de",
    "*@xn--bcher-kva.de", "ada@bücher.de", "*@github.io", "*@x.github.io", " ada@example.com",
]  # fmt: skip

CHOICES = [
    "Ada@Example.com", "example.com", "@example.com", "*@Example.com", "giulia@trattoriarossa.example", "co.uk", "ada@co.uk",
    "*.example.com", "  Partner.ORG ", "bücher.de", "@", "", "ada@", "*@", "x.github.io",
]  # fmt: skip

MOMENTS = [
    "2026-09-01T02:00:00+02:00", "2026-10-01", "2026-10-01T00:00:00Z", "0001-01-01T00:00:00+01:00", "0001-01-01T00:00:00-01:00",
    "0999-01-01", "2026-10-01T24:00", "2026-10-01T24:00:01", "2026-12-31T24:00", "2026-02-28T24:00:00", "20261001T0900",
    "2026-W40-1", "2026W401", "2026-W40", "2026W40", "2026-W53-1", "2026-W00-1", "2020-W53-7", "2026-W40-8", "2026-W40-1T09:00Z",
    "2026-10-01 09:00:00Z", "2026-10-01T09:00:00.123456789Z", "2026-10-01T09:00:00,5+05:30", "2026-10-01T09", "2026-10-01T9",
    "9999-12-31T23:00-01:00", "9999-12-31T23:00+01:00", "2026-10-01x09:00", "2026-10-01é09:00", "2026-10-01\U0001f600" + "09:00",
    "2026-02-30", "2026-13-01", "2026-00-01", "2026-10-01T09:00:00+00:99", "2026-10-01T09:00+24:00", "2026-10-01T09:00:00+23:59:59.999999",
    "2026-10-01T09:00:00+0530", "2026-10-01T09:00:00+05", "2026-10-01T09:00:00+5", "2026-10-01T09:00:00+053", "2026-10-01T09:00:00-00:00",
    "2026-10-01T09:00:00Z+01:00", "2026-10-01T09:00:00ZZ", "2026-10-01T0900", "2026-10-01T09:0000", "2026-10-01T09:00:60",
    "2026-10-01T25:00", "2026-10-01T09:00:00.", "2026-10-01T09:00:00.12a", "2026-10-01T09:00:00 ", " 2026-10-01", "2026-1001",
    "202610-01", "2026-10-1", "26-10-01", "yesterday", "2026-10-01T09:00:00Z' or true", "2026-10-01T", "2026-10", "2026-10-01T09:00:00.000001-23:59",
    "2026-10-01T09:00:00+01:00:30.5", "2026-10-01T09:00:00+01:00:30", "2026-10-01T09:00:00+010030", "2026-10-01T09:00:00+01:0030",
    "2026-10-01T09:00:00.5Z", "2026-10-01T09:00:00,123Z", "2026-10-01T09:00:00.1234567Z", "2026-10-01T09:00:00Z\n", "2026-10-01\n",
    "１２３４-10-01", "2026-10-01T０9:00", "2026-10-01T09:00:00.000000000000001+00:00", "2026-10-01T090000", "2026-10-01T090000.5",
    "2026-10-01T09:00:00-", "2026-10-01T09:00:00+", "2026-10-01T09-01", "2026-10-01T09+01:00", "2026-10-01T09:00+01",
    "2026-10-01T09:00:00.Z", "2026-10-01T09000012", "2026-10-01T0900001", "2026-00-00T24:00", "2026-02-29T24:00",
    "2026-10-01T24:00+01:00", "2026-10-01T09:00:00+00:00:00.5", "2026-W40-1T09", "2026W40T0900", "2026-W40T09", "2026W401T09",
    "2026W4012", "2026-W4012", "2026-W40-12", "2026-W40-", "2026-W4", "2026-W", "2026W40-1", "2026-10-01T09:00:00+01:00-",
    "2026-10-01T09:00:00-01:00+", "2026-10-01T09:00:00Z.5", "2026-10-01T09:00:00.5.5Z", "2026-10-01T09:00:00:00", "2026-10-01T09.5",
    "2026-10-01T09:00.5", "2026-10-01T09:00:00.000000", "2026-10-01T09:00:00.0000005", "9999-W52-6", "2026-10-01T23:59:59.9999999+23:59",
    "2026-10-01T09:00:00-24:00", "2026-10-01T09:00:00+00:00:00.000001", "2026-10-01T09:00:00+00:00:01", "\ud800026-10-01",
    "2026-10-01\ud80009:00", "2026-10-01\u00a009:00", "2026-10-01T09:00:00+01:00\u00a0",
]  # fmt: skip


def validation_message(error: ValidationError) -> str:
    # connectors/executor.py validation_message, which imports Django.
    problems = [f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]]
    return "Invalid arguments. " + "; ".join(problems)


def validated(model, raw):
    try:
        return {"data": model.model_validate(raw).model_dump(mode="json")}
    except ValidationError as error:
        return {"message": validation_message(error)}
    except (OverflowError, TypeError) as error:
        return {"raises": type(error).__name__}


FOLDER = "INBOXFOLDER0"
MESSAGE = "MSGGRACE0001"
INPUTS = {
    "list_folders": (reads.ListFolders, [
        {}, {"parent": "INBOX"}, {"parent": " inbox "}, {"parent": "Projects"}, {"parent": FOLDER, "limit": 100}, {"limit": 0},
        {"limit": 101}, {"cursor": "x" * 1001}, {"cursor": " c "}, {"parent": None}, {"parent": ""}, {"parent": "a" * 513},
        {"parent": "../me"}, {"parent": "short"}, {"parent": "SentItems"}, {"extra": 1}, {"parent": 5},
    ]),
    "list_messages": (reads.ListMessages, [
        {"folder": FOLDER}, {"folder": "Inbox"}, {"folder": FOLDER, "unread_only": True, "after": "2026-09-01T02:00:00+02:00", "before": "2026-10-01"},
        {"folder": FOLDER, "query": "budget 2026"}, {"folder": FOLDER, "query": "budget", "unread_only": True},
        {"folder": FOLDER, "query": 'budget" OR from:x'}, {"folder": FOLDER, "query": "back\\slash"}, {"folder": FOLDER, "after": "yesterday"},
        {"folder": FOLDER, "after": "2026-09-01T00:00:00Z' or true"}, {"folder": FOLDER, "query": "a\nb"}, {"folder": FOLDER, "query": ""},
        {"folder": FOLDER, "query": "  "}, {"folder": FOLDER, "query": "x" * 201}, {"folder": FOLDER, "after": "2026-10-01", "query": "x"},
        {"folder": FOLDER, "before": "2026-W40-1"}, {"folder": FOLDER, "after": "0001-01-01T00:00:00+01:00"}, {"folder": FOLDER, "limit": 51},
        {"folder": FOLDER, "unread_only": "yes"}, {}, {"folder": "short", "query": 'x"'}, {"folder": FOLDER, "after": "x" * 41},
        {"folder": FOLDER, "after": " 2026-10-01 "}, {"folder": FOLDER, "after": ""}, {"folder": FOLDER, "query": None},
        {"folder": FOLDER, "after": None, "before": None}, {"folder": None}, {"folder": FOLDER, "after": "0001-01-01T00:00:00+01:00"},
    ]),
    "read_message": (reads.ReadMessage, [
        {"message": MESSAGE}, {"message": MESSAGE, "max_chars": 499}, {"message": MESSAGE, "max_chars": 500, "offset": 500},
        {"message": "short"}, {"message": "MSG/GRACE/1"}, {"message": MESSAGE, "offset": -1}, {"message": MESSAGE, "max_chars": 50001},
    ]),
    "send_message": (writes.SendMessage, [
        {"to": ["Grace@Example.com"], "cc": ["ada@partner.org"], "subject": "Plans", "body": "Hi <b>Grace</b>\r\n\tthanks"},
        {"to": ["grace@example.com"], "cc": ["Grace@example.com"], "subject": "x", "body": "x"},
        {"to": [], "subject": "x", "body": "x"}, {"to": ["Grace <grace@example.com>"], "subject": "x", "body": "x"},
        {"to": [f"p{n}@example.com" for n in range(6)], "cc": [f"q{n}@example.com" for n in range(5)], "subject": "x", "body": "x"},
        {"to": [f"p{n}@example.com" for n in range(11)], "subject": "x", "body": "x"},
        {"to": ["grace@example.com"], "subject": "a\r\nBcc: x@evil.org", "body": "x"}, {"to": ["grace@example.com"], "subject": "x", "body": "bell\x07"},
        {"to": ["grace@example.com"], "subject": "x", "body": "x", "from": "ceo@example.com"}, {"to": ["ab"], "subject": "x", "body": "x"},
        {"to": ["grace@example.com"], "subject": "", "body": "x"}, {"to": ["grace@example.com"], "subject": "x", "body": ""},
        {"to": ["grace@example.com"], "subject": "x" * 256, "body": "x"}, {"to": ["grace@example.com", "GRACE@example.com"], "subject": "x", "body": "x"},
        {"to": ["grace@bücher.de"], "bcc": ["x@co.uk"], "subject": "x", "body": "x"}, {"to": "grace@example.com", "subject": "x", "body": "x"},
    ]),
    "reply": (writes.Reply, [
        {"message": MESSAGE, "body": "Thanks"}, {"message": MESSAGE, "body": ""}, {"message": MESSAGE, "body": "a\x00b"}, {"message": "x", "body": "y"},
    ]),
}  # fmt: skip


def main() -> None:
    vectors = {
        "parse": {raw: outcome(lambda raw=raw: addresses.parse(raw)) for raw in ADDRESSES},
        "valid_id": {raw: addresses.valid_id(raw) for raw in [*IDS, *ADDRESSES]},
        "choices": {raw: outcome(lambda raw=raw: addresses.choices(raw)) for raw in CHOICES},
        "moment": {raw: outcome(lambda raw=raw: reads._moment(raw)) for raw in MOMENTS},
        "inputs": {
            tool: [{"args": raw, **validated(model, raw)} for raw in cases] for tool, (model, cases) in INPUTS.items()
        },
        "filters": [
            {"args": raw, "filter": reads._filter(reads.ListMessages.model_validate(raw))}
            for raw in (
                {"folder": FOLDER},
                {"folder": FOLDER, "unread_only": True},
                {"folder": FOLDER, "after": "2026-09-01T02:00:00+02:00"},
                {"folder": FOLDER, "before": "2026-10-01", "unread_only": True},
                {"folder": FOLDER, "after": "2026-09-01", "before": "2026-10-01T12:30:00-02:00"},
            )
        ],
    }
    (HERE / "vectors.json").write_text(json.dumps(vectors, indent=1, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
