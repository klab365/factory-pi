import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";

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
