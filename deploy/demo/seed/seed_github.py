"""Seed GitHub: the private repository fernhill-labs-demo/tably-widget with code, labels, issues and pull requests.

    uv run python deploy/demo/seed/seed_github.py [--dry-run]

Uses the `gh` CLI, logged in as the operator (`gh auth status`), and `git`. The organisation must exist
already. The code is in tably-widget/ next to this script; each pull request's changes are in
tably-widget-prs/<branch with / as __>/. Commits are authored as the fictional team (.example addresses).

Re-running skips what exists: the code push if the repository has commits, labels are upserted, issues
by title, pull requests by branch.
"""

import json
import os
import shutil
import subprocess
import tempfile
from datetime import datetime, timedelta
from pathlib import Path

import _common as c
import story

REPO = f"{story.GITHUB_ORG}/{story.GITHUB_REPO}"
CODE_DIR = c.SEED_DIR / "tably-widget"
PR_DIR = c.SEED_DIR / "tably-widget-prs"
# Use gh as git's credential helper for these commands only, without changing any git config.
GIT_AUTH = ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential"]


def run(
    *cmd: str, cwd: Path | None = None, env: dict | None = None, check: bool = True
) -> subprocess.CompletedProcess:
    result = subprocess.run(
        cmd, cwd=cwd, env={**os.environ, **(env or {})}, capture_output=True, text=True, check=False
    )
    if check and result.returncode != 0:
        c.die(f"{' '.join(cmd[:3])} … failed:\n{result.stderr.strip() or result.stdout.strip()}")
    return result


def gh_json(*args: str) -> object:
    return json.loads(run("gh", *args).stdout or "null")


def author_env(who: str, days_ago: int) -> dict[str, str]:
    person = story.TEAM_BY_FIRST[who]
    when = (datetime.now(story.LONDON) - timedelta(days=days_ago)).replace(hour=15, minute=12).isoformat()
    return {
        "GIT_AUTHOR_NAME": person.name,
        "GIT_AUTHOR_EMAIL": person.email,
        "GIT_COMMITTER_NAME": person.name,
        "GIT_COMMITTER_EMAIL": person.email,
        "GIT_AUTHOR_DATE": when,
        "GIT_COMMITTER_DATE": when,
    }


def all_code_files() -> set[str]:
    return {str(p.relative_to(CODE_DIR)) for p in CODE_DIR.rglob("*") if p.is_file()}


def check_story_files() -> None:
    listed = {path for _, _, _, paths in story.GITHUB_COMMITS for path in paths}
    missing = listed - all_code_files()
    unlisted = all_code_files() - listed
    if missing or unlisted:
        c.die(
            f"story.GITHUB_COMMITS and tably-widget/ disagree: missing {sorted(missing)}, unlisted {sorted(unlisted)}"
        )
    for pr in story.GITHUB_PRS:
        if not (PR_DIR / pr.overlay).is_dir():
            c.die(f"no changes for {pr.branch} in {PR_DIR / pr.overlay}")


def ctx() -> dict[str, str]:
    return story.context(alex="alex@example.com")


def main() -> None:
    args = c.parser(__doc__.splitlines()[0]).parse_args()
    c.load_env()
    out = c.Out(args.dry_run)
    check_story_files()
    if args.dry_run:
        dry_run(out)
        out.done()
        return

    if shutil.which("gh") is None or shutil.which("git") is None:
        c.die("this script needs the gh CLI and git on PATH")
    run("gh", "auth", "status")
    if run("gh", "api", f"orgs/{story.GITHUB_ORG}", check=False).returncode != 0:
        c.die(f"the organisation {story.GITHUB_ORG} does not exist or the gh user cannot see it")

    out.section(f"Repository {REPO}")
    if run("gh", "api", f"repos/{REPO}", check=False).returncode == 0:
        out.exists("repository", REPO)
    else:
        run(
            "gh",
            "repo",
            "create",
            REPO,
            "--private",
            "--description",
            story.GITHUB_DESCRIPTION,
            "--disable-wiki",
        )
        out.create("repository", REPO, "private")

    has_commits = run("gh", "api", f"repos/{REPO}/commits?per_page=1", check=False).returncode == 0
    if has_commits:
        out.exists("code", "main", "repository already has commits; code not pushed")
    else:
        push_initial_code(out)

    out.section("Labels")
    for name, color, description in story.GITHUB_LABELS:
        run(
            "gh",
            "label",
            "create",
            name,
            "--color",
            color,
            "--description",
            description,
            "--force",
            "-R",
            REPO,
        )
        out.create("label", name, "created or updated")

    out.section("Issues")
    existing = {
        i["title"]: i["number"]
        for i in gh_json(
            "issue", "list", "-R", REPO, "--state", "all", "--limit", "500", "--json", "title,number"
        )
    }
    numbers: dict[str, int] = {}
    for issue in story.GITHUB_ISSUES:
        if issue.title in existing:
            numbers[issue.key] = existing[issue.title]
            out.exists("issue", f"#{existing[issue.title]} {issue.title}")
            continue
        url = run(
            "gh",
            "issue",
            "create",
            "-R",
            REPO,
            "--title",
            issue.title,
            "--body",
            story.fill(issue.body, **ctx()),
            *[arg for label in issue.labels for arg in ("--label", label)],
        ).stdout.strip()
        number = int(url.rstrip("/").rsplit("/", 1)[-1])
        numbers[issue.key] = number
        for comment in issue.comments:
            run("gh", "issue", "comment", str(number), "-R", REPO, "--body", story.fill(comment, **ctx()))
        if issue.closed:
            run("gh", "issue", "close", str(number), "-R", REPO, "--reason", "completed")
        out.create("issue", f"#{number} {issue.title}", "closed" if issue.closed else ", ".join(issue.labels))

    out.section("Pull requests")
    for pr in story.GITHUB_PRS:
        found = gh_json("pr", "list", "-R", REPO, "--head", pr.branch, "--state", "all", "--json", "number")
        if found:
            out.exists("pull request", f"#{found[0]['number']} {pr.title}")
            continue
        push_branch(pr)
        body = pr.body
        for key, number in numbers.items():
            body = body.replace("{issue:" + key + "}", f"#{number}")
        url = run(
            "gh",
            "pr",
            "create",
            "-R",
            REPO,
            "--head",
            pr.branch,
            "--base",
            "main",
            "--title",
            pr.title,
            "--body",
            body,
            *(["--draft"] if pr.draft else []),
        ).stdout.strip()
        out.create("pull request", pr.title, url + (" (draft)" if pr.draft else ""))

    out.done()


def push_initial_code(out: c.Out) -> None:
    url = f"https://github.com/{REPO}.git"
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "repo"
        work.mkdir()
        run("git", "init", "-q", "-b", "main", cwd=work)
        for who, days_ago, message, paths in story.GITHUB_COMMITS:
            for path in paths:
                dest = work / path
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(CODE_DIR / path, dest)
            run("git", "add", "-A", cwd=work)
            run("git", "commit", "-q", "-m", message, cwd=work, env=author_env(who, days_ago))
            out.create("commit", message, story.TEAM_BY_FIRST[who].name)
        run("git", *GIT_AUTH, "push", "-q", url, "main", cwd=work)


def push_branch(pr: story.PullRequest) -> None:
    url = f"https://github.com/{REPO}.git"
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "repo"
        run("git", *GIT_AUTH, "clone", "-q", url, str(work))
        if (
            run(
                "git", "ls-remote", "--exit-code", "--heads", "origin", pr.branch, cwd=work, check=False
            ).returncode
            == 0
        ):
            return  # pushed by an earlier run that stopped before opening the pull request
        run("git", "checkout", "-q", "-b", pr.branch, cwd=work)
        overlay = PR_DIR / pr.overlay
        for src in overlay.rglob("*"):
            if src.is_file():
                dest = work / src.relative_to(overlay)
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, dest)
        run("git", "add", "-A", cwd=work)
        run("git", "commit", "-q", "-m", pr.title, cwd=work, env=author_env(pr.author, 2))
        run("git", *GIT_AUTH, "push", "-q", "origin", pr.branch, cwd=work)


def dry_run(out: c.Out) -> None:
    print(f"GitHub via gh: {REPO} (private). Nothing is sent.")
    out.section("Code")
    for who, days_ago, message, paths in story.GITHUB_COMMITS:
        out.create(
            "commit", message, f"{story.TEAM_BY_FIRST[who].name}, {days_ago} days ago, {len(paths)} files"
        )
    out.section("Labels")
    for name, _, _ in story.GITHUB_LABELS:
        out.create("label", name)
    out.section("Issues")
    for i, issue in enumerate(story.GITHUB_ISSUES, 1):
        state = "closed" if issue.closed else "open"
        out.create("issue", f"#{i} {issue.title}", f"{state}; {', '.join(issue.labels)}")
        print(f"      {c.preview(story.fill(issue.body, **ctx()))}")
    out.section("Pull requests")
    for pr in story.GITHUB_PRS:
        files = sorted(
            str(p.relative_to(PR_DIR / pr.overlay)) for p in (PR_DIR / pr.overlay).rglob("*") if p.is_file()
        )
        out.create(
            "pull request", pr.title, f"{pr.branch}{', draft' if pr.draft else ''}; {', '.join(files)}"
        )


if __name__ == "__main__":
    main()
