"""Writes vectors.json: what today's Python computes for the Outlook Calendar connector's port, for its
tool inputs (normalized arguments or the validation message, with the window and the event payload Graph
is sent), its times in UTC, the event times it reports, and its page state.

Only connector modules are imported, which load no configuration. Run from cloudflare/:
cd ../backend && .venv/bin/python -I ../cloudflare/test/fixtures/connectors/outlook_calendar/generate.py
"""

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BACKEND = HERE.parents[3].parent / "backend"
sys.path.insert(0, str(BACKEND))

from pydantic import ValidationError  # noqa: E402

from connectors.base import OperationError  # noqa: E402
from connectors.outlook_calendar import connector as calendar  # noqa: E402
from connectors.outlook_calendar.client import Time  # noqa: E402


def validation_message(error: ValidationError) -> str:
    # connectors/executor.py validation_message, which imports Django.
    problems = [f"{'.'.join(str(p) for p in item['loc']) or 'input'}: {item['msg']}" for item in error.errors()[:5]]
    return "Invalid arguments. " + "; ".join(problems)


CAL = "AAMkCALWORK000"
TIMES = [
    "2026-10-01T00:00:00+02:00", "2026-10-31T00:00:00Z", "2026-10-01T00:00:00.5+02:00", "2026-10-01T00:00:00.75+02:00",
    "2026-10-01", "2026-10-01T09:00:00", "2026-W40-1T09:00:00Z", "2026-10-01T09:00:00+00:99", "9999-12-31T00:00:00Z",
    "0001-01-01T00:00:00Z", "1899-12-31T23:59:59Z", "1900-01-01T00:00:00Z", "2999-12-31T23:59:59.999999Z", "3000-01-01T00:00:00Z",
    "2026-02-30T09:00:00Z", "2026-13-01T09:00:00Z", "2026-00-10T09:00:00Z", "2026-10-00T09:00:00Z", "2026-10-01T24:00:00Z",
    "2026-10-01T24:00:01Z", "2026-10-01T24:30Z", "2026-10-01T25:00:00Z", "2026-10-01T23:60:00Z", "2026-10-01T23:59:60Z",
    "2026-10-01T09:00Z", "2026-10-01T09:00:00.1234567Z", "2026-10-01T09:00:00,5Z", "2026-10-01t09:00:00z", "2026-10-01 09:00:00Z",
    "2026-10-01T09:00:00-23:59", "2026-10-01T09:00:00+24:00", "2026-10-01T09:00:00+23:60", "0000-10-01T09:00:00Z",
    "２０２６-10-01T09:00:00Z", "2026-10-01T09:00:00Ｚ", "2026-10-01T0٩:00:00Z", "2026-10-01T09:00:00Z\n",
    "2026-12-31T24:00:00Z", "2999-12-31T24:00:00Z", "1899-12-31T24:00:00Z", "2026-02-28T24:00:00+05:00", "x" * 41, "",
]  # fmt: skip
DATES = [
    "2026-10-12", "2026-10-14", "1899-12-31", "1900-01-01", "2999-12-31", "3000-01-01", "2026-02-30", "2026-13-01", "0000-01-01",
    "２０２６-10-12", "2026-1-01", "20261012", "2026-10-12 ",
]  # fmt: skip

LIST_EVENTS = [
    {"calendar_id": CAL}, {"calendar_id": "primary"}, {"calendar_id": "Work"}, {"calendar_id": "../me"}, {"calendar_id": "short"},
    {"calendar_id": "AAMk/CAL/WORK"}, {"calendar_id": CAL, "limit": 0}, {"calendar_id": CAL, "limit": 51}, {"calendar_id": CAL, "cursor": "x" * 1001},
    {"calendar_id": CAL, "time_min": "2026-10-02T00:00:00Z", "time_max": "2026-10-01T00:00:00Z"},
    {"calendar_id": CAL, "time_min": "2026-01-01T00:00:00Z", "time_max": "2027-01-03T00:00:00Z"},
    {"calendar_id": CAL, "time_min": "2026-01-01T00:00:00Z", "time_max": "2027-01-02T00:00:00Z"},
    {"calendar_id": CAL, "time_min": "2026-01-01T00:00:00Z", "time_max": "2027-01-02T00:00:00.000001Z"},
    {"calendar_id": CAL, "time_min": "2026-10-01T00:00:00Z", "time_max": "2026-10-01T00:00:00Z"},
    {"calendar_id": CAL, "time_min": "2026-10-01T02:00:00+02:00", "time_max": "2026-10-01T00:00:00.000001Z"},
    {"calendar_id": CAL, "time_min": "2026-10-01T09:00:00+02:00"}, {"calendar_id": CAL, "time_max": "2026-10-31T00:00:00Z"},
    {"calendar_id": CAL, "time_min": "2026-10-01T00:00:00.5+02:00", "time_max": "2026-10-01T00:00:00.75+02:00"},
    {"calendar_id": CAL, "time_min": "1900-01-01T00:00:00+05:00"}, {"calendar_id": CAL, "time_max": "2999-12-31T23:00:00-05:00"},
    {"calendar_id": CAL, "time_min": "2999-12-20T00:00:00Z"}, {"calendar_id": CAL, "time_max": "1900-01-10T00:00:00Z"},
    {"calendar_id": CAL, "time_min": "2026-03-29T01:30:00+01:00", "time_max": "2026-03-29T03:30:00+02:00"},
    *({"calendar_id": CAL, "time_min": value} for value in TIMES),
]  # fmt: skip

EVENT = {"calendar_id": CAL, "subject": "Offsite", "start": "2026-10-12", "end": "2026-10-14", "time_zone": "Europe/Berlin"}
TIMED = {"calendar_id": CAL, "subject": "Focus", "start": "2026-10-05T10:00:00+02:00", "end": "2026-10-05T11:30:00+02:00"}
CREATE_EVENT = [
    EVENT, TIMED, {**TIMED, "body": "Deep work\nNo meetings", "location": "Home"}, {**TIMED, "body": "", "location": ""},
    {**EVENT, "time_zone": None}, {**EVENT, "time_zone": "Europe/Zurich"}, {**EVENT, "time_zone": "Mars/Olympus"}, {**EVENT, "time_zone": "UTC"},
    {**EVENT, "time_zone": "Etc/GMT+12"}, {**EVENT, "time_zone": "US/Eastern"}, {**EVENT, "time_zone": " Europe/Berlin "}, {**EVENT, "time_zone": "x" * 65},
    {**EVENT, "end": "2026-10-12"}, {**EVENT, "end": "2026-10-11"}, {**EVENT, "end": "2026-10-14T00:00:00Z"},
    {**EVENT, "start": "2026-10-12T09:00:00Z", "end": "2026-10-12T10:00:00Z"}, {**EVENT, "subject": "Two\nlines"}, {**EVENT, "subject": ""},
    {**EVENT, "subject": "x" * 256}, {**EVENT, "start": "1899-12-31", "end": "1900-01-01"}, {**EVENT, "start": "2999-12-31", "end": "3000-01-01"},
    {**TIMED, "start": "2026-10-12T09:00:00+24:00", "end": "2026-10-12T10:00:00Z"},
    {**TIMED, "start": "2026-10-12T09:00:00.9Z", "end": "2026-10-12T09:00:00.1Z"}, {**TIMED, "end": TIMED["start"]},
    {**TIMED, "start": "2026-10-12T09:00:00Z", "end": "2026-10-12T09:00:00.000001Z"}, {**TIMED, "start": "2026-10-12T24:00:00Z", "end": "2026-10-13T01:00:00Z"},
    {**TIMED, "body": "bell\x07"}, {**TIMED, "body": "x" * 8001}, {**TIMED, "location": "a\tb"}, {**TIMED, "location": "x" * 501},
    {**TIMED, "start": "2026-02-30T09:00:00Z"}, {**TIMED, "start": "2026-10-12"}, {**EVENT, "start": "2026-02-30"},
    {**EVENT, "start": "２０２６-10-12"}, {"calendar_id": CAL, "subject": "x", "start": "2026-10-12"},
    {**TIMED, "attendees": []}, {**TIMED, "start": "2026-10-05T10:00:00.5+02:00", "end": "2026-10-05T11:30:00.250001+02:00"},
]  # fmt: skip


def validated(model, raw):
    try:
        data = model.model_validate(raw)
    except ValidationError as error:
        return {"message": validation_message(error)}
    out = {"data": data.model_dump(mode="json")}
    if isinstance(data, calendar.ListEvents) and (data.time_min or data.time_max):
        out["window"] = list(data.window())
    if isinstance(data, calendar.CreateEvent):
        out["payload"] = data.payload()
    return out


def outcome(call):
    try:
        return {"value": call()}
    except OperationError as error:
        return {"error": error.code}
    except ValueError as error:
        return {"error": "ValueError", "message": str(error)}


GRAPH_TIMES = [
    ({"dateTime": "2026-10-05T07:00:00.0000000", "timeZone": "UTC"}, False),
    ({"dateTime": "2026-10-06T00:00:00.0000000", "timeZone": "UTC"}, True),
    ({"dateTime": "2026-10-05T07:00:00.0000000", "timeZone": "utc"}, False),
    ({"dateTime": "2026-10-05T07:00:00.0000000", "timeZone": "Pacific Standard Time"}, False),
    ({"dateTime": "2026-10-05T07:00:00.0000000", "timeZone": None}, False),
    ({"dateTime": "2026-10-05T07:00:00.0000000"}, False),
    ({"dateTime": "2026-10-05", "timeZone": "UTC"}, True),
    ({"dateTime": "2026-10-05T07:00", "timeZone": "UTC"}, False),
    ({"dateTime": "", "timeZone": "UTC"}, False),
]
PAGE_STATES = [
    ({"calendar": CAL, "page": "skip:2", "start": "a", "end": "b"}, CAL),
    ({"calendar": CAL, "page": "skip:2", "start": "a", "end": "b"}, "AAMkCALDEFAULT"),
    ({"calendar": CAL, "page": "skip:2", "start": "a", "end": "b", "extra": "x"}, CAL),
    ({"calendar": CAL, "page": 2, "start": "a", "end": "b"}, CAL),
    ([{"calendar": CAL, "page": "skip:2", "start": "a", "end": "b"}], CAL),
    ("skip:2", CAL),
]


def main() -> None:
    vectors = {
        "zones": sorted(calendar.ZONES),
        "list_events": [{"args": raw, **validated(calendar.ListEvents, raw)} for raw in LIST_EVENTS],
        "create_event": [{"args": raw, **validated(calendar.CreateEvent, raw)} for raw in CREATE_EVENT],
        "date_time": {value: outcome(lambda value=value: calendar._date_time(value)) for value in TIMES},
        "date_or_date_time": {value: outcome(lambda value=value: calendar._date_or_date_time(value)) for value in [*DATES, *TIMES]},
        "utc": {
            value: outcome(lambda value=value: calendar._utc(value))
            for value in TIMES
            if calendar.DATE_TIME.match(value) and outcome(lambda value=value: calendar._date_time(value)).get("value")
        },
        "times": [
            {"time": time, "all_day": all_day, "shown": calendar._time(Time.model_validate(time), all_day)}
            for time, all_day in GRAPH_TIMES
        ],
        "page_state": [
            {"cursor": json.dumps(state) if not isinstance(state, str) else state, "calendar": calendar_id,
             **outcome(lambda state=state, calendar_id=calendar_id: calendar._page_state(
                 json.dumps(state) if not isinstance(state, str) else state, calendar_id))}
            for state, calendar_id in PAGE_STATES
        ],  # fmt: skip
    }
    (HERE / "vectors.json").write_text(json.dumps(vectors, indent=1, ensure_ascii=True) + "\n")


if __name__ == "__main__":
    main()
