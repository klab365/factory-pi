import re
import subprocess
import sys
from pathlib import Path


ISSUE_URL = re.compile(
    r"https?://([\w.-]+/[\w.-]+/[\w.-]+)/issues/([1-9]\d*)"
    r"(?=$|[\s?#),>\]]|\.(?:\s|$))",
    re.IGNORECASE | re.ASCII,
)
GITHUB_REMOTE = re.compile(
    r"(?:https?://|ssh://(?:[^/@]+@)?|[^/@]+@)([\w.-]+)[:/]([\w.-]+)/([\w.-]+)/?",
    re.ASCII,
)


def command(*args: str, show_output: bool = False) -> str:
    result = subprocess.run(
        args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, encoding="utf-8", errors="replace"
    )
    if result.returncode:
        raise RuntimeError(f"{' '.join(args[:2])} failed ({result.returncode})")
    if show_output:
        sys.stderr.write(result.stdout)
    return result.stdout.strip()


def git(*args: str, show_output: bool = False) -> str:
    return command("git", *args, show_output=show_output)


def issue_links(goal: str, repository: str) -> list[str]:
    refs = dict.fromkeys(
        f"Close #{number}"
        for repo, number in ISSUE_URL.findall(goal)
        if repo.lower() == repository.lower()
    )
    return list(refs)


def publish(goal: str, subject: str, pr_summary: str, pr_verification: str) -> str:
    title, summary, verification = subject.strip(), pr_summary.strip(), pr_verification.strip()
    if not title or len(title) > 72 or "\r" in title or "\n" in title or not summary or not verification:
        raise RuntimeError(
            "Publishing requires a single-line title (max. 72 characters), PR summary, and verification"
        )

    branch = git("branch", "--show-current")
    if not branch:
        raise RuntimeError("Publishing requires a checked-out branch (not a detached HEAD)")
    for marker in ("MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-apply", "rebase-merge", "sequencer"):
        if Path(git("rev-parse", "--git-path", marker)).exists():
            raise RuntimeError("Finish the in-progress Git operation before publishing")

    remote = GITHUB_REMOTE.fullmatch(git("config", "--get", "remote.origin.url"))
    if not remote:
        raise RuntimeError("Publishing requires origin to point to a GitHub repository")
    host, owner, repo_path = remote.groups()
    repo = repo_path.removesuffix(".git")
    repository = f"{host}/{owner}/{repo}"
    base = command(
        "gh", "repo", "view", f"https://{repository}", "--json", "defaultBranchRef",
        "--jq", ".defaultBranchRef.name",
    )
    if not base or branch == base:
        raise RuntimeError("Publishing requires a branch other than the default branch")

    if git("status", "--porcelain"):
        git("add", "-A")
        if git("diff", "--cached", "--name-only"):
            git("commit", "-m", title, show_output=True)
    git("push", "origin", f"HEAD:refs/heads/{branch}", show_output=True)

    # Qualify the head by owner so a similarly named branch in a fork is not reused.
    existing = command(
        "gh", "api", "--hostname", host, "-X", "GET", f"repos/{owner}/{repo}/pulls",
        "-f", f"head={owner}:{branch}", "-f", "state=open", "--jq", ".[].html_url",
    )
    if "\n" in existing:
        raise RuntimeError("Multiple open pull requests for this branch; resolve the ambiguity before resuming")
    if existing:
        return existing

    body = "\n\n".join([f"## Summary\n{summary}", f"## Verification\n{verification}", *issue_links(goal, repository)])
    return command(
        "gh", "pr", "create", "--repo", repository, "--head", branch,
        "--base", base, "--title", title, "--body", body,
    )


def main(args: list[str]) -> int:
    if len(args) != 4:
        print("Usage: publish-pr.py GOAL TITLE SUMMARY VERIFICATION", file=sys.stderr)
        return 1
    try:
        print(publish(*args))
    except (RuntimeError, OSError, ValueError) as error:
        print(error, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
