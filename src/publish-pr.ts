import { existsSync } from "node:fs";

function command(argv: string[], showOutput = false): string {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} failed (${result.exitCode})`);
  const output = result.stdout.toString();
  if (showOutput && output) process.stderr.write(output);
  return output.trim();
}

function issueLinks(goal: string, repository: string): string[] {
  const refs = new Set<string>();
  for (const [, repo, number] of goal.matchAll(
    /https?:\/\/([\w.-]+\/[\w.-]+\/[\w.-]+)\/issues\/([1-9]\d*)(?=$|[\s?#),>\]]|\.(?:\s|$))/gi,
  )) {
    if (repo.toLowerCase() === repository.toLowerCase()) refs.add(`Closes #${number}`);
  }
  return [...refs];
}

function publish(goal: string, subject: string, prSummary: string, prVerification: string): string {
  const title = subject.trim();
  const summary = prSummary.trim();
  const verification = prVerification.trim();
  if (!title || title.length > 72 || /[\r\n]/.test(title) || !summary || !verification) {
    throw new Error(
      "Publishing requires a single-line title (max. 72 characters), PR summary, and verification",
    );
  }

  const git = (...args: string[]) => command(["git", ...args]);
  const branch = git("branch", "--show-current");
  if (!branch) throw new Error("Publishing requires a checked-out branch (not a detached HEAD)");
  for (const marker of [
    "MERGE_HEAD",
    "CHERRY_PICK_HEAD",
    "REVERT_HEAD",
    "rebase-apply",
    "rebase-merge",
    "sequencer",
  ]) {
    if (existsSync(git("rev-parse", "--git-path", marker))) {
      throw new Error("Finish the in-progress Git operation before publishing");
    }
  }

  const origin = git("config", "--get", "remote.origin.url");
  const remote = origin.match(
    /^(?:https?:\/\/|ssh:\/\/(?:[^/@]+@)?|[^/@]+@)([\w.-]+)[:/]([\w.-]+)\/([\w.-]+?)\/?$/,
  );
  if (!remote) throw new Error("Publishing requires origin to point to a GitHub repository");
  const [, host, owner, repoPath] = remote;
  const repo = repoPath.replace(/\.git$/, "");
  const repository = `${host}/${owner}/${repo}`;
  const base = command([
    "gh",
    "repo",
    "view",
    `https://${repository}`,
    "--json",
    "defaultBranchRef",
    "--jq",
    ".defaultBranchRef.name",
  ]);
  if (!base || branch === base) throw new Error("Publishing requires a branch other than the default branch");

  if (git("status", "--porcelain")) {
    git("add", "-A");
    if (git("diff", "--cached", "--name-only")) {
      command(["git", "commit", "-m", title], true);
    }
  }
  command(["git", "push", "origin", `HEAD:refs/heads/${branch}`], true);

  // Qualify the head by owner so a similarly named branch in a fork is not reused.
  const existing = command([
    "gh",
    "api",
    "--hostname",
    host,
    "-X",
    "GET",
    `repos/${owner}/${repo}/pulls`,
    "-f",
    `head=${owner}:${branch}`,
    "-f",
    "state=open",
    "--jq",
    ".[].html_url",
  ]);
  if (existing.includes("\n"))
    throw new Error("Multiple open pull requests for this branch; resolve the ambiguity before resuming");
  if (existing) return existing;
  return command([
    "gh",
    "pr",
    "create",
    "--repo",
    repository,
    "--head",
    branch,
    "--base",
    base,
    "--title",
    title,
    "--body",
    [`## Summary\n${summary}`, ...issueLinks(goal, repository), `## Verification\n${verification}`].join(
      "\n\n",
    ),
  ]);
}

if (import.meta.main) {
  try {
    const [, , goal = "", title = "", summary = "", verification = ""] = process.argv;
    console.log(publish(goal, title, summary, verification));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
