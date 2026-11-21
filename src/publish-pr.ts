import { existsSync } from "node:fs";

function command(argv: string[], showOutput = false): string {
  const result = Bun.spawnSync(argv, { stdin: "ignore", stdout: "pipe", stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} failed (${result.exitCode})`);
  const output = result.stdout.toString();
  if (showOutput && output) process.stderr.write(output);
  return output.trim();
}

function publish(goal: string): string {
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

  const title = goal.trim().split(/\r?\n/, 1)[0].trim().slice(0, 120) || "Apply reviewed Factory changes";
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
    "Published by Factory after human approval.",
  ]);
}

if (import.meta.main) {
  try {
    console.log(publish(process.argv[2] ?? ""));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
