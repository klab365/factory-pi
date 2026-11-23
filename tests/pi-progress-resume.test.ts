import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

function fixture(check: (root: string) => void) {
  const root = mkdtempSync(resolve(tmpdir(), "factory-progress-resume-"));
  try {
    mkdirSync(`${root}/.factory/pipelines`, { recursive: true });
    mkdirSync(`${root}/.factory/agents`, { recursive: true });
    for (const agent of ["builder", "reviewer"]) {
      writeFileSync(`${root}/.factory/agents/${agent}.md`, `---\nname: ${agent}\n---\nTest agent.`);
    }
    writeFileSync(
      `${root}/.factory/pipelines/test.yml`,
      `inputs:
  goal: {}
steps:
  - id: build
    name: Build changes
    agent: builder
    task: \${{ inputs.goal }}
  - id: review
    name: Review changes
    agent: reviewer
    task: \${{ inputs.goal }}
    transitions: {approved: accept}
  - id: accept
    name: Human approval
    human:
      prompt: Approve?
      choices: [approved]
`,
    );
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
function run(root: string, ...flags: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, resolve(import.meta.dir, "fixtures/run-progress.ts"), ...flags],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  return {
    code: result.exitCode,
    output: new TextDecoder().decode(result.stdout) + new TextDecoder().decode(result.stderr),
  };
}

test("resuming dismissed human approval retains builder and reviewer evidence without repeating effects", () => {
  fixture((root) => {
    const first = run(root, "--new");
    expect(first.code).toBe(1);
    expect(first.output).toContain("Human input cancelled");
    const visits = readFileSync(`${root}/agent-visits`, "utf8");
    const resumed = run(root, "--approve");
    expect(resumed.code).toBe(0);
    expect(resumed.output).toContain("builder changes: initial");
    expect(resumed.output).toContain("reviewer checks: initial: passed");
    expect(resumed.output).toContain("Review changes: approved");
    expect(resumed.output).toContain("Human approval: approved");
    expect(resumed.output).toContain("builder-initial.ts");
    expect(resumed.output).toContain("reviewer-initial.ts");
    expect(resumed.output).not.toContain("No agent change summary reported");
    expect(readFileSync(`${root}/agent-visits`, "utf8")).toBe(visits);
  });
});

test("resume hydration excludes results from earlier refinement rounds", () => {
  fixture((root) => {
    expect(run(root, "--new", "--approve").code).toBe(0);
    expect(run(root, "--refine", "--fail-review").code).toBe(1);
    const resumed = run(root, "--fail-review");
    expect(resumed.code).toBe(1);
    expect(resumed.output).toContain("builder changes: initial");
    expect(resumed.output).toContain("updated");
    expect(resumed.output).not.toContain("reviewer-initial.ts");
    expect(resumed.output).not.toContain("reviewer checks: initial: passed");
    expect(resumed.output).toContain("No review or human decision reported");
  });
});
