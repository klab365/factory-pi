import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { parse, stringify } from "yaml";

const repository = resolve(import.meta.dir, "..");
function runCli(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync([process.execPath, "run", `${repository}/src/cli.ts`, ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  };
}

function fixture(pipeline: string, check: (root: string) => void) {
  const root = mkdtempSync(resolve(tmpdir(), "factory-cli-"));
  mkdirSync(`${root}/.factory/pipelines`, { recursive: true });
  writeFileSync(`${root}/.factory/pipelines/test.yml`, pipeline);
  try {
    check(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("factory CLI", () => {
  test("validates the software-factory pipeline", () => {
    const result = runCli(repository, "validate", "software-factory");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Pipeline valid: software-factory");
  });

  test("rejects unknown inputs and requires inputs on new runs", () => {
    fixture("inputs:\n  goal: {}\nsteps:\n  - id: work\n    run: 'true'\n", (root) => {
      expect(runCli(root, "run", "test", "--unknown=value").output).toContain(
        "Unknown pipeline input: unknown",
      );
      const result = runCli(root, "run", "test");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Missing required input 'goal'");
    });
  });

  test.each([
    ["steps:\n  - id: work\n    run: 'true'\n    maxVisits: 0\n", "maxVisits must be a positive integer"],
    ["steps:\n  - id: work\n    run: 'true'\n    agent: builder\n", "exactly one"],
    [
      "steps:\n  - id: work\n    run: 'touch unwanted'\n    transitions: {completed: missing}\n",
      "unknown step",
    ],
  ])("validates before executing: %s", (pipeline, message) => {
    fixture(pipeline, (root) => {
      for (const command of ["validate", "run"]) {
        const result = runCli(root, command, "test");
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(message);
        expect(existsSync(`${root}/unwanted`)).toBe(false);
      }
    });
  });

  test("validates selected skills before any shell step or journal creation", () => {
    fixture(
      "steps:\n  - id: shell\n    run: touch unwanted\n  - id: build\n    agent: builder\n    task: Build\n",
      (root) => {
        mkdirSync(`${root}/.factory/agents`, { recursive: true });
        writeFileSync(
          `${root}/.factory/agents/builder.md`,
          "---\nname: builder\nskills: [missing]\n---\nImplement\n",
        );
        for (const command of ["validate", "run"]) {
          const result = runCli(root, command, "test");
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain("cannot load 'missing'");
          expect(existsSync(`${root}/unwanted`)).toBe(false);
          expect(existsSync(`${root}/.factory/state`)).toBe(false);
        }
      },
    );
  });

  test("routes shell outcomes and preserves maxVisits across resume", () => {
    fixture(
      `steps:
  - id: work
    run: echo visit >> visits
    maxVisits: 2
    transitions: {completed: work}
`,
      (root) => {
        const first = runCli(root, "run", "test");
        expect(first.exitCode).toBe(1);
        expect(first.output).toContain("exceeded maxVisits (2)");
        const resumed = runCli(root, "run", "test");
        expect(resumed.exitCode).toBe(1);
        expect(resumed.output).toContain("reusing durable result");
        expect(resumed.output).toContain("exceeded maxVisits (2)");
        expect(readFileSync(`${root}/visits`, "utf8")).toBe("visit\nvisit\n");
      },
    );
  });

  test("resumes with saved inputs and skips completed steps", () => {
    fixture(
      `inputs:
  goal: {}
  optional: {required: false}
steps:
  - id: first
    run: echo saved >> count; printf '%s' \${{ inputs.goal }} > goal
  - id: retry
    run: 'if [ ! -e retried ]; then touch retried; exit 1; fi; printf "%s" \${{ inputs.goal }} > resumed-goal'
`,
      (root) => {
        const first = runCli(root, "run", "test", "--goal=original");
        expect(first.exitCode).toBe(1);
        expect(first.output).toContain("exit code 1");
        const resumed = runCli(root, "run", "test");
        expect(resumed.exitCode).toBe(0);
        expect(resumed.output).toContain("using its saved inputs");
        expect(readFileSync(`${root}/count`, "utf8")).toBe("saved\n");
        expect(readFileSync(`${root}/goal`, "utf8")).toBe("original");
        expect(readFileSync(`${root}/resumed-goal`, "utf8")).toBe("original");
      },
    );
  });
});

test("software-factory sends requested human changes to the next builder visit", () => {
  const pipeline = parse(readFileSync(`${repository}/.factory/pipelines/software-factory.yml`, "utf8"));
  const [builder, reviewer, accept, feedback, publish] = pipeline.steps;
  // Keep the real task template and human transitions, but avoid model calls and pushes.
  pipeline.steps = [
    {
      id: builder.id,
      maxVisits: builder.maxVisits,
      transitions: builder.transitions,
      run: `cat > builder-task <<'FACTORY_TASK'\n${builder.task}\nFACTORY_TASK`,
    },
    {
      id: reviewer.id,
      maxVisits: reviewer.maxVisits,
      transitions: { completed: reviewer.transitions.approved },
      run: "true",
    },
    accept,
    feedback,
    { ...publish, run: "echo https://example.test/pr/1 >> published; cat published" },
  ];
  fixture(stringify(pipeline), (root) => {
    const start = runCli(root, "run", "test", "--goal=Test the loop");
    expect(start.output).toContain("Human response required");
    const request = runCli(root, "run", "test", "--human-response=change_requested");
    expect(request.output).toContain("Another human response is required");
    expect(readFileSync(`${root}/builder-task`, "utf8")).not.toContain("Add a regression test");
    const feedback = runCli(root, "run", "test", "--human-response=Add a regression test");
    expect(feedback.output).toContain("Another human response is required");
    expect(readFileSync(`${root}/builder-task`, "utf8")).toContain("Add a regression test");
    expect(existsSync(`${root}/published`)).toBe(false);
    const approved = runCli(root, "run", "test", "--human-response=approved");
    expect(approved.exitCode).toBe(0);
    expect(approved.output).toContain("https://example.test/pr/1");
    expect(readFileSync(`${root}/published`, "utf8")).toBe("https://example.test/pr/1\n");
  });
  fixture(stringify(pipeline), (root) => {
    const rejected = runCli(root, "run", "test", "--goal=Reject", "--human-response=rejected");
    expect(rejected.exitCode).toBe(0);
    expect(existsSync(`${root}/published`)).toBe(false);
  });
});

test("opt-in shell output is available from the durable result after resume", () => {
  fixture(
    `steps:
  - id: capture
    run: printf 'https://example.test/pr/1\\n'
    captureOutput: true
  - id: retry
    run: 'if [ ! -e retried ]; then touch retried; exit 1; fi; printf "%s" \${{ steps.capture.output }} > url'
`,
    (root) => {
      expect(runCli(root, "run", "test").exitCode).toBe(1);
      const resumed = runCli(root, "run", "test");
      expect(resumed.exitCode).toBe(0);
      expect(resumed.output).not.toContain("▶ capture");
      expect(readFileSync(`${root}/url`, "utf8")).toBe("https://example.test/pr/1");
    },
  );
});

test("human checkpoint resumes and does not repeat downstream side effects", () => {
  fixture(
    `steps:
  - id: approve
    human:
      prompt: Approve?
      choices: [approved, rejected]
    transitions: {approved: publish, rejected: end}
  - id: publish
    run: echo published >> effects
`,
    (root) => {
      const pending = runCli(root, "run", "test");
      expect(pending.exitCode).toBe(1);
      expect(pending.output).toContain("Human response required");
      expect(existsSync(`${root}/effects`)).toBe(false);
      expect(runCli(root, "run", "test", "--human-response=invalid").exitCode).toBe(1);
      const accepted = runCli(root, "run", "test", "--human-response=approved");
      expect(accepted.exitCode).toBe(0);
      expect(readFileSync(`${root}/effects`, "utf8")).toBe("published\n");
    },
  );
});
