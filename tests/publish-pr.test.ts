import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const script = resolve(import.meta.dir, "../src/publish-pr.ts");
const url = "https://github.com/example/project/pull/1";

test("publishing commits and pushes once on resume, then updates the same PR", () => {
  const dir = mkdtempSync(resolve(tmpdir(), "factory-publish-"));
  try {
    const root = resolve(dir, "work");
    const remote = resolve(dir, "origin.git");
    const bin = resolve(dir, "bin");
    mkdirSync(root);
    mkdirSync(bin);
    const git = (...args: string[]) => {
      const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    git("init", "-b", "main");
    git("init", "--bare", remote);
    git("config", "user.name", "Factory Test");
    git("config", "user.email", "factory@example.test");
    git("config", "commit.gpgsign", "false");
    git("commit", "--allow-empty", "-m", "Initial commit");
    git("remote", "add", "origin", "https://github.com/example/project.git");
    git("config", `url.${remote}.insteadOf`, "https://github.com/example/project.git");
    writeFileSync(
      resolve(bin, "gh"),
      `#!/bin/sh
case "$1 $2" in
  'repo view') [ "$3" = 'https://github.com/example/project' ] && echo main ;;
  'api --hostname')
    [ "$3 $6 $8" = 'github.com repos/example/project/pulls head=example:feature/test' ] || exit 2
    if [ -f "$PR_STATE" ]; then read -r url < "$PR_STATE"; printf '%s\\n' "$url"; fi ;;
  'pr create')
    [ "$4 $6 $8" = 'github.com/example/project feature/test main' ] || exit 2
    [ "$9" = '--title' ] && [ "\${10}" = 'Scope refine runs to the current worktree' ] && [ "\${11}" = '--body' ] || exit 2
    printf '%s\\n' "\${12}" > "$PR_STATE.body"
    printf '%s\\n' '${url}' >> "$PR_STATE"
    # GitHub created the PR, but the runner did not receive the result.
    exit 1 ;;
  *) exit 2 ;;
esac
`,
      { mode: 0o755 },
    );
    const state = resolve(dir, "pr-state");
    const title = "Scope refine runs to the current worktree";
    const goal = [
      "löse issue: https://github.com/example/project/issues/12",
      "Context: (https://github.com/Example/Project/issues/12).",
      "Compare https://github.com/example/other/issues/99 or https://other.example/example/project/issues/98.",
    ].join("\n");
    const summary = "- Filter the picker by worktree.\n- Keep explicit run IDs working.";
    const verification = "- `mise run check` passed.";
    const run = (subject = title, checks = verification) =>
      Bun.spawnSync([process.execPath, script, goal, subject, summary, checks], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PR_STATE: state },
        stdout: "pipe",
        stderr: "pipe",
      });
    writeFileSync(resolve(root, "change"), "first");
    const onMain = run();
    expect(onMain.exitCode).toBe(1);
    expect(onMain.stderr.toString()).toContain("other than the default branch");
    expect(git("log", "-1", "--format=%s")).toBe("Initial commit");

    git("checkout", "-b", "feature/test");
    for (const invalid of [run(""), run("Title\nSecond line"), run(title, "")]) {
      expect(invalid.exitCode).toBe(1);
      expect(invalid.stderr.toString()).toContain("Publishing requires a single-line title");
    }
    expect(git("status", "--porcelain")).toBe("?? change");
    expect(run().exitCode).toBe(1);
    const firstCommit = git("rev-parse", "HEAD");
    expect(git("log", "-1", "--format=%s")).toBe(title);
    expect(readFileSync(`${state}.body`, "utf8")).toBe(
      `## Summary\n${summary}\n\nCloses #12\n\n## Verification\n${verification}\n`,
    );
    expect(git("--git-dir", remote, "rev-parse", "refs/heads/feature/test")).toBe(firstCommit);
    const resumed = run();
    expect(resumed.exitCode).toBe(0);
    expect(resumed.stdout.toString().trim()).toBe(url);
    expect(git("rev-parse", "HEAD")).toBe(firstCommit);

    writeFileSync(resolve(root, "change"), "second");
    const updated = run();
    expect(updated.exitCode).toBe(0);
    expect(updated.stdout.toString().trim()).toBe(url);
    expect(git("rev-parse", "HEAD^")).toBe(firstCommit);
    expect(git("--git-dir", remote, "rev-parse", "refs/heads/feature/test")).toBe(git("rev-parse", "HEAD"));
    expect(readFileSync(state, "utf8")).toBe(`${url}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
