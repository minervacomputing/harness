"""Seed Linear: labels, the project "Q4 Growth", a current cycle and the backlog for team TAB.

    uv run --with httpx python deploy/demo/seed/seed_linear.py [--dry-run]

Needs SEED_LINEAR_API_KEY (a personal API key from Settings → Account → Security & access) in .env.demo.
The team with key TAB must exist. Re-running skips labels and projects by name and issues by title.

The double-charge bug is deliberately not created: the demo agent files it.
"""

import time
from datetime import datetime, timedelta

import _common as c
import story

API = "https://api.linear.app/graphql"
STATE_TYPES = {
    "Backlog": "backlog",
    "Todo": "unstarted",
    "In Progress": "started",
    "In Review": "started",
    "Done": "completed",
}
# Allowed estimate values per team setting; story estimates are rounded up to the nearest allowed value.
ESTIMATES = {
    "exponential": [1, 2, 4, 8, 16],
    "fibonacci": [1, 2, 3, 5, 8],
    "linear": [1, 2, 3, 4, 5],
    "tShirt": [1, 2, 3, 5, 8],
}


class LinearError(Exception):
    pass


class Linear:
    def __init__(self, key: str) -> None:
        import httpx

        # Personal API keys go in the Authorization header as-is (no "Bearer").
        self.http = httpx.Client(
            headers={"Authorization": key, "Content-Type": "application/json"}, timeout=30
        )

    def __call__(self, query: str, **variables: object) -> dict:
        response = self.http.post(API, json={"query": query, "variables": variables})
        try:
            body = response.json()
        except ValueError:
            raise LinearError(f"HTTP {response.status_code}") from None
        if body.get("errors"):
            raise LinearError("; ".join(e.get("message", "?") for e in body["errors"]))
        if response.status_code >= 400:
            raise LinearError(f"HTTP {response.status_code}")
        return body["data"]


TEAM_QUERY = """
query Team($key: String!) {
  teams(filter: { key: { eq: $key } }) {
    nodes {
      id name key cyclesEnabled issueEstimationType
      activeCycle { id number }
      cycles(first: 20) { nodes { id number startsAt endsAt isActive isFuture } }
      states { nodes { id name type position } }
    }
  }
}"""


def estimate_for(points: int, kind: str) -> int | None:
    allowed = ESTIMATES.get(kind)
    if not allowed:
        return None
    return next((v for v in allowed if v >= points), allowed[-1])


def pick_state(states: list[dict], name: str) -> dict:
    by_name = [s for s in states if s["name"].lower() == name.lower()]
    if by_name:
        return by_name[0]
    by_type = sorted((s for s in states if s["type"] == STATE_TYPES[name]), key=lambda s: s["position"])
    if not by_type:
        c.die(f"team TAB has no workflow state named {name!r} or of type {STATE_TYPES[name]!r}")
    return by_type[0]


def pick_cycle(team: dict) -> dict | None:
    if team.get("activeCycle"):
        return team["activeCycle"]
    cycles = team["cycles"]["nodes"]
    active = [cy for cy in cycles if cy.get("isActive")]
    future = sorted((cy for cy in cycles if cy.get("isFuture")), key=lambda cy: cy["startsAt"])
    return (active or future or [None])[0]


def main() -> None:
    args = c.parser(__doc__.splitlines()[0]).parse_args()
    c.load_env()
    out = c.Out(args.dry_run)
    if args.dry_run:
        dry_run(out)
        out.done()
        return

    gql = Linear(c.env("SEED_LINEAR_API_KEY"))
    teams = gql(TEAM_QUERY, key=story.LINEAR_TEAM_KEY)["teams"]["nodes"]
    if not teams:
        c.die(f"no Linear team with key {story.LINEAR_TEAM_KEY}; create it first (name Tably, key TAB)")
    team = teams[0]
    print(f"Linear team {team['name']} ({team['key']}).")

    out.section("Cycles")
    if team["cyclesEnabled"]:
        out.exists("cycles", "enabled")
    else:
        enable_cycles(gql, team["id"])
        out.create("cycles", "enabled", "2-week cycles starting Mondays")
    cycle = pick_cycle(team)
    for _ in range(5):  # Linear creates the cycles shortly after they are enabled
        if cycle:
            break
        time.sleep(2)
        team = gql(TEAM_QUERY, key=story.LINEAR_TEAM_KEY)["teams"]["nodes"][0]
        cycle = pick_cycle(team)
    if cycle:
        out.note(f"sprint issues go into cycle {cycle['number']}")
    else:
        out.note("no current cycle found; issues are created without one")

    out.section("Labels")
    labels = ensure_labels(gql, team["id"], out)

    out.section("Project")
    project_id = ensure_project(gql, team["id"], out)

    out.section("Issues")
    existing = existing_issue_titles(gql, team["id"])
    states = team["states"]["nodes"]
    estimate_kind = team["issueEstimationType"]
    if estimate_kind not in ESTIMATES:
        out.note(f"team estimates are {estimate_kind!r}; issues are created without estimates")
    for issue in story.LINEAR_ISSUES:
        if issue.title in existing:
            out.exists("issue", f"{existing[issue.title]} {issue.title}")
            continue
        state = pick_state(states, issue.state)
        data = {
            "teamId": team["id"],
            "title": issue.title,
            "description": issue.description,
            "priority": issue.priority,
            "stateId": state["id"],
            "labelIds": [labels[name] for name in issue.labels],
        }
        if issue.in_project:
            data["projectId"] = project_id
        if issue.in_cycle and cycle:
            data["cycleId"] = cycle["id"]
        estimate = estimate_for(issue.estimate, estimate_kind)
        if estimate is not None:
            data["estimate"] = estimate
        identifier = create_issue(gql, data)
        where = ", ".join(
            x for x in ("cycle" if "cycleId" in data else "", "Q4 Growth" if issue.in_project else "") if x
        )
        out.create(
            "issue",
            f"{identifier} {issue.title}",
            f"{state['name']}, P{issue.priority}" + (f", {where}" if where else ""),
        )

    out.done()


def enable_cycles(gql: Linear, team_id: str) -> None:
    today = datetime.now(story.LONDON).date()
    monday = today - timedelta(days=today.weekday())
    settings = {
        "cyclesEnabled": True,
        "cycleDuration": 2,  # weeks
        "cycleStartDay": 1,  # Monday (0 is Sunday)
        "upcomingCycleCount": 2,
        "cycleEnabledStartDate": f"{monday.isoformat()}T00:00:00.000Z",
    }
    mutation = (
        "mutation($id: String!, $input: TeamUpdateInput!) { teamUpdate(id: $id, input: $input) { success } }"
    )
    try:
        gql(mutation, id=team_id, input=settings)
    except LinearError:
        settings.pop("cycleEnabledStartDate")  # let Linear choose the first cycle's start
        gql(mutation, id=team_id, input=settings)


def ensure_labels(gql: Linear, team_id: str, out: c.Out) -> dict[str, str]:
    """Return label name -> id, reusing workspace labels or TAB labels of the same name (any case)."""
    nodes = gql("{ issueLabels(first: 250) { nodes { id name team { id } } } }")["issueLabels"]["nodes"]
    usable = {n["name"].lower(): n["id"] for n in nodes if n["team"] is None or n["team"]["id"] == team_id}
    result: dict[str, str] = {}
    for name, color in story.LINEAR_LABELS:
        if name.lower() in usable:
            result[name] = usable[name.lower()]
            out.exists("label", name)
            continue
        data = gql(
            "mutation($input: IssueLabelCreateInput!) { issueLabelCreate(input: $input) { success issueLabel { id } } }",
            input={"name": name, "color": color, "teamId": team_id},
        )
        result[name] = data["issueLabelCreate"]["issueLabel"]["id"]
        out.create("label", name, color)
    return result


def ensure_project(gql: Linear, team_id: str, out: c.Out) -> str:
    p = story.LINEAR_PROJECT
    found = gql(
        "query($name: String!) { projects(filter: { name: { eq: $name } }) { nodes { id name } } }",
        name=p["name"],
    )["projects"]["nodes"]
    if found:
        out.exists("project", p["name"])
        return found[0]["id"]
    today = datetime.now(story.LONDON).date()
    data = {
        "name": p["name"],
        "teamIds": [team_id],
        "description": p["description"],
        "content": p["content"],
        "startDate": (today - timedelta(days=p["start_days_ago"])).isoformat(),
        "targetDate": (today + timedelta(days=p["target_days_ahead"])).isoformat(),
    }
    status = started_project_status(gql)
    if status:
        data["statusId"] = status
    created = gql(
        "mutation($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id } } }",
        input=data,
    )
    out.create("project", p["name"], f"{data['startDate']} to {data['targetDate']}")
    return created["projectCreate"]["project"]["id"]


def started_project_status(gql: Linear) -> str | None:
    """The workspace's 'In Progress' project status, so the project does not show as planned."""
    try:
        nodes = gql("{ projectStatuses { nodes { id name type } } }")["projectStatuses"]["nodes"]
    except LinearError:
        return None
    started = [n for n in nodes if n["type"] == "started"]
    return started[0]["id"] if started else None


def existing_issue_titles(gql: Linear, team_id: str) -> dict[str, str]:
    titles: dict[str, str] = {}
    after = None
    while True:
        page = gql(
            """query($id: String!, $after: String) {
                 team(id: $id) { issues(first: 100, after: $after, includeArchived: true) {
                   nodes { title identifier } pageInfo { hasNextPage endCursor } } } }""",
            id=team_id,
            after=after,
        )["team"]["issues"]
        titles.update({n["title"]: n["identifier"] for n in page["nodes"]})
        if not page["pageInfo"]["hasNextPage"]:
            return titles
        after = page["pageInfo"]["endCursor"]


def create_issue(gql: Linear, data: dict) -> str:
    mutation = (
        "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { identifier } } }"
    )
    try:
        return gql(mutation, input=data)["issueCreate"]["issue"]["identifier"]
    except LinearError:
        if "estimate" not in data:
            raise
        data = {k: v for k, v in data.items() if k != "estimate"}  # an estimate the team's scale rejects
        return gql(mutation, input=data)["issueCreate"]["issue"]["identifier"]


def dry_run(out: c.Out) -> None:
    print(f"Linear team {story.LINEAR_TEAM_KEY}. Nothing is sent.")
    out.section("Cycles")
    out.note("enables 2-week cycles (Mondays) if the team has none; sprint issues go into the current cycle")
    out.section("Labels")
    for name, color in story.LINEAR_LABELS:
        out.create("label", name, color)
    out.section("Project")
    p = story.LINEAR_PROJECT
    out.create("project", p["name"], p["description"])
    out.section("Issues")
    for i, issue in enumerate(story.LINEAR_ISSUES, 1):
        where = ", ".join(
            x for x in ("cycle" if issue.in_cycle else "", "Q4 Growth" if issue.in_project else "") if x
        )
        detail = f"{issue.state}, P{issue.priority}, {issue.estimate} pts, {', '.join(issue.labels)}"
        out.create("issue", f"TAB-{i} {issue.title}", detail + (f"; {where}" if where else ""))


if __name__ == "__main__":
    main()
