"""Seed Notion: the Fernhill wiki pages, the Customer notes database and an empty Scratch page.

    uv run --with httpx python deploy/demo/seed/seed_notion.py [--dry-run]

Needs SEED_NOTION_TOKEN (an internal integration's secret, ntn_…) in .env.demo, and a page named
"Fernhill Wiki" shared with that integration (page menu → Connections → add the integration). Set
SEED_NOTION_PARENT_ID to that page's id if the search cannot find it.

Everything is created under Fernhill Wiki. Re-running skips pages and the database by title and database
rows by name. Pages that exist are not updated: delete one in Notion to recreate it.
"""

import time

import _common as c
import story

API = "https://api.notion.com/v1"
# Pinned to a version whose /v1/databases endpoints create and query databases directly. The Minerva
# connector reads with a newer version; pages and databases made here read the same with either.
NOTION_VERSION = "2022-06-28"
STATUS_COLORS = {"Active": "green", "At risk": "red", "Onboarding": "blue"}
PLAN_NAMES = {"starter": "Starter", "pro": "Pro", "annual_pro": "Annual Pro"}
PLAN_COLORS = {"Starter": "gray", "Pro": "purple", "Annual Pro": "orange"}
BILLING_NAMES = {"card": "Card", "invoice": "Invoice (bank transfer)"}


class NotionError(Exception):
    def __init__(self, status: int, body: dict) -> None:
        super().__init__(f"HTTP {status} {body.get('code', '')}: {body.get('message', '')}")
        self.code = body.get("code", "")


class Notion:
    def __init__(self, token: str) -> None:
        import httpx

        self.http = httpx.Client(
            base_url=API,
            headers={"Authorization": f"Bearer {token}", "Notion-Version": NOTION_VERSION},
            timeout=30,
        )

    def request(self, method: str, path: str, body: dict | None = None, **params: object) -> dict:
        for _ in range(5):
            response = self.http.request(method, path, json=body, params=params or None)
            if response.status_code == 429:  # about 3 requests a second on average
                time.sleep(float(response.headers.get("Retry-After", "1")))
                continue
            data = response.json()
            if response.status_code >= 400:
                raise NotionError(response.status_code, data)
            return data
        raise NotionError(429, {"message": "rate limited"})

    def children(self, block_id: str) -> list[dict]:
        results, cursor = [], None
        while True:
            params = {"page_size": 100, **({"start_cursor": cursor} if cursor else {})}
            page = self.request("GET", f"/blocks/{block_id}/children", **params)
            results += page["results"]
            if not page.get("has_more"):
                return results
            cursor = page["next_cursor"]


def text(content: str) -> list[dict]:
    return [{"type": "text", "text": {"content": content}}]


def block(kind: str, value: object) -> dict:
    """One of story.NOTION_PAGES' small block tuples as a Notion block object."""
    simple = {"h2": "heading_2", "h3": "heading_3", "p": "paragraph", "bullet": "bulleted_list_item"}
    if kind in simple:
        t = simple[kind]
        return {"object": "block", "type": t, t: {"rich_text": text(str(value))}}
    if kind in ("todo", "todo_done"):
        return {
            "object": "block",
            "type": "to_do",
            "to_do": {"rich_text": text(str(value)), "checked": kind == "todo_done"},
        }
    if kind == "callout":
        return {
            "object": "block",
            "type": "callout",
            "callout": {
                "rich_text": text(str(value)),
                "icon": {"type": "emoji", "emoji": "💡"},
                "color": "gray_background",
            },
        }
    if kind == "divider":
        return {"object": "block", "type": "divider", "divider": {}}
    if kind == "table":
        rows = value  # first row is the header
        return {
            "object": "block",
            "type": "table",
            "table": {
                "table_width": len(rows[0]),
                "has_column_header": True,
                "has_row_header": False,
                "children": [
                    {
                        "object": "block",
                        "type": "table_row",
                        "table_row": {"cells": [text(cell) for cell in row]},
                    }
                    for row in rows
                ],
            },
        }
    raise ValueError(f"unknown block kind {kind!r}")


def child_titles(notion: Notion, page_id: str) -> dict[str, str]:
    """Titles of child pages and databases directly under a page -> their ids."""
    found = {}
    for b in notion.children(page_id):
        if b["type"] == "child_page":
            found[b["child_page"]["title"]] = b["id"]
        elif b["type"] == "child_database":
            found[b["child_database"]["title"]] = b["id"]
    return found


def find_parent(notion: Notion) -> str:
    override = c.env("SEED_NOTION_PARENT_ID", required=False)
    if override:
        return override
    results = notion.request(
        "POST",
        "/search",
        {
            "query": story.NOTION_PARENT_TITLE,
            "filter": {"property": "object", "value": "page"},
            "page_size": 20,
        },
    )["results"]
    matches = []
    for page in results:
        title_prop = next((p for p in page.get("properties", {}).values() if p.get("type") == "title"), None)
        title = "".join(t["plain_text"] for t in (title_prop or {}).get("title", []))
        if (
            title.strip() == story.NOTION_PARENT_TITLE
            and not page.get("archived")
            and not page.get("in_trash")
        ):
            matches.append(page["id"])
    if not matches:
        c.die(
            f"no page named {story.NOTION_PARENT_TITLE!r} is shared with the integration. Share it "
            "(page menu → Connections) or set SEED_NOTION_PARENT_ID."
        )
    if len(matches) > 1:
        c.die(f"{len(matches)} pages are named {story.NOTION_PARENT_TITLE!r}; set SEED_NOTION_PARENT_ID")
    return matches[0]


def create_page(notion: Notion, parent_id: str, title: str, emoji: str, blocks: list[dict]) -> str:
    body = {
        "parent": {"type": "page_id", "page_id": parent_id},
        "icon": {"type": "emoji", "emoji": emoji},
        "properties": {"title": {"title": text(title)}},
        "children": blocks[:100],
    }
    try:
        page = notion.request("POST", "/pages", body)
    except NotionError as e:
        if e.code != "validation_error" or "icon" not in str(e):
            raise
        body.pop("icon")  # an emoji Notion does not accept
        page = notion.request("POST", "/pages", body)
    for start in range(100, len(blocks), 100):
        notion.request("PATCH", f"/blocks/{page['id']}/children", {"children": blocks[start : start + 100]})
    return page["id"]


def database_schema() -> dict:
    def select(names: list[str], colors: dict[str, str]) -> dict:
        return {"select": {"options": [{"name": n, "color": colors.get(n, "default")} for n in names]}}

    return {
        "Name": {"title": {}},
        "Status": select(list(STATUS_COLORS), STATUS_COLORS),
        "Plan": select(list(PLAN_COLORS), PLAN_COLORS),
        "Billing": select(list(BILLING_NAMES.values()), {}),
        "Sites": {"number": {"format": "number"}},
        "MRR": {"number": {"format": "pound"}},
        "Contact": {"rich_text": {}},
        "Email": {"email": {}},
        "Phone": {"phone_number": {}},
        "Location": {"rich_text": {}},
        "Customer since": {"date": {}},
        "Notes": {"rich_text": {}},
    }


def row_properties(cust: story.Customer) -> dict:
    return {
        "Name": {"title": text(cust.name)},
        "Status": {"select": {"name": cust.status}},
        "Plan": {"select": {"name": PLAN_NAMES[cust.plan]}},
        "Billing": {"select": {"name": BILLING_NAMES[cust.billing]}},
        "Sites": {"number": cust.sites},
        "MRR": {"number": cust.mrr_gbp},
        "Contact": {"rich_text": text(cust.contact)},
        "Email": {"email": cust.email},
        "Phone": {"phone_number": cust.phone},
        "Location": {"rich_text": text(f"{cust.address}, {cust.city} {cust.postcode}")},
        "Customer since": {"date": {"start": cust.since}},
        "Notes": {"rich_text": text(cust.notes[:2000])},
    }


def row_blocks(cust: story.Customer) -> list[dict]:
    return [
        block("h3", "Notes"),
        *[block("p", para) for para in cust.notes.split("\n\n") if para.strip()],
        block("h3", "Contact"),
        block("bullet", f"{cust.contact}, {cust.email}, {cust.phone}"),
    ]


def main() -> None:
    args = c.parser(__doc__.splitlines()[0]).parse_args()
    c.load_env()
    out = c.Out(args.dry_run)
    if args.dry_run:
        dry_run(out)
        out.done()
        return

    notion = Notion(c.env("SEED_NOTION_TOKEN"))
    parent = find_parent(notion)
    print(f"Notion parent page {story.NOTION_PARENT_TITLE!r} found.")
    existing = child_titles(notion, parent)

    out.section("Pages")
    for title, emoji, blocks in story.NOTION_PAGES:
        if title in existing:
            out.exists("page", title)
            continue
        create_page(notion, parent, title, emoji, [block(kind, value) for kind, value in blocks])
        out.create("page", title, f"{len(blocks)} blocks")

    out.section("Database")
    db_id = existing.get(story.NOTION_CUSTOMERS_DB)
    if db_id:
        out.exists("database", story.NOTION_CUSTOMERS_DB)
    else:
        db = notion.request(
            "POST",
            "/databases",
            {
                "parent": {"type": "page_id", "page_id": parent},
                "icon": {"type": "emoji", "emoji": "🍽️"},
                "title": text(story.NOTION_CUSTOMERS_DB),
                "is_inline": False,
                "properties": database_schema(),
            },
        )
        db_id = db["id"]
        out.create("database", story.NOTION_CUSTOMERS_DB, f"{len(database_schema())} properties")
    for cust in story.CUSTOMERS:
        found = notion.request(
            "POST",
            f"/databases/{db_id}/query",
            {"filter": {"property": "Name", "title": {"equals": cust.name}}},
        )["results"]
        if found:
            out.exists("customer row", cust.name)
            continue
        notion.request(
            "POST",
            "/pages",
            {
                "parent": {"database_id": db_id},
                "properties": row_properties(cust),
                "children": row_blocks(cust),
            },
        )
        out.create("customer row", cust.name, f"{cust.status}, {PLAN_NAMES[cust.plan]}")

    out.section("Scratch")
    if story.NOTION_SCRATCH_TITLE in existing:
        out.exists("page", story.NOTION_SCRATCH_TITLE)
    else:
        intro = [
            block("p", "Drafts by people and the AI assistant. Move anything worth keeping into the wiki.")
        ]
        create_page(notion, parent, story.NOTION_SCRATCH_TITLE, "📝", intro)
        out.create("page", story.NOTION_SCRATCH_TITLE, "empty apart from one line")

    out.done()


def dry_run(out: c.Out) -> None:
    print(f"Notion, under {story.NOTION_PARENT_TITLE!r} (API version {NOTION_VERSION}). Nothing is sent.")
    out.section("Pages")
    for title, emoji, blocks in story.NOTION_PAGES:
        for kind, value in blocks:
            block(kind, value)  # validates every block offline
        out.create("page", f"{emoji} {title}", f"{len(blocks)} blocks")
    out.section("Database")
    out.create("database", story.NOTION_CUSTOMERS_DB, ", ".join(database_schema()))
    for cust in story.CUSTOMERS:
        row_properties(cust)
        out.create(
            "customer row", cust.name, f"{cust.status}, {PLAN_NAMES[cust.plan]}, £{cust.mrr_gbp:g}/month"
        )
    out.section("Scratch")
    out.create("page", story.NOTION_SCRATCH_TITLE, "empty apart from one line")


if __name__ == "__main__":
    main()
