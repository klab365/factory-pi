import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { parse, stringify } from "yaml";
import { stepMaxVisits } from "../src/pipeline-validation";

const repository = resolve(import.meta.dir, "..");
function runFixture(cwd: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", `${repository}/tests/fixtures/run-pipeline.ts`, ...args],
    {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
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

describe("factory runner", () => {
  test("validates the software-factory pipeline", () => {
    const result = runFixture(repository, "validate", "software-factory");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Pipeline valid: software-factory");
  });

  test("rejects unknown inputs and requires inputs on new runs", () => {
    fixture("inputs:\n  goal: {}\nsteps:\n  - id: work\n    shell: 'true'\n", (root) => {
      expect(runFixture(root, "run", "test", "--unknown=value").output).toContain(
        "Unknown pipeline input: unknown",
      );
      const result = runFixture(root, "run", "test");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("Missing required input 'goal'");
    });
  });

  test.each([
    ["steps:\n  - id: work\n    run: 'true'\n", "removed 'run'; use 'shell' instead"],
    [
      "steps:\n  - id: work\n    shell: {command: 'true', timeout: 0}\n",
      "timeout must be a positive integer",
    ],
    [
      "steps:\n  - id: work\n    shell: {command: 'true', outputs: {result: true}}\n",
      "unknown stream 'result'",
    ],
    ["steps:\n  - id: work\n    shell: 'true'\n    maxVisits: 0\n", "maxVisits must be a positive integer"],
    ["steps:\n  - id: work\n    shell: 'true'\n    agent: builder\n", "exactly one"],
    [
      "steps:\n  - id: work\n    shell: 'touch unwanted'\n    transitions: {completed: missing}\n",
      "unknown step",
    ],
  ])("validates before executing: %s", (pipeline, message) => {
    fixture(pipeline, (root) => {
      for (const command of ["validate", "run"]) {
        const result = runFixture(root, command, "test");
        expect(result.exitCode).toBe(1);
        expect(result.output).toContain(message);
        expect(existsSync(`${root}/unwanted`)).toBe(false);
      }
    });
  });

  test("validates selected skills before any shell step or journal creation", () => {
    fixture(
      "steps:\n  - id: shell\n    shell: touch unwanted\n  - id: build\n    agent: builder\n    task: Build\n",
      (root) => {
        mkdirSync(`${root}/.factory/agents`, { recursive: true });
        writeFileSync(
          `${root}/.factory/agents/builder.md`,
          "---\nname: builder\nskills: [missing]\n---\nImplement\n",
        );
        for (const command of ["validate", "run"]) {
          const result = runFixture(root, command, "test");
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain("cannot load 'missing'");
          expect(existsSync(`${root}/unwanted`)).toBe(false);
          expect(existsSync(`${root}/.factory/state`)).toBe(false);
        }
      },
    );
  });

  test.each([0, -1, 1.5, "2", null])("rejects invalid agent maxVisits: %j", (maxVisits) => {
    fixture(
      stringify({ steps: [{ id: "work", agent: "builder", task: "Implement", maxVisits }] }),
      (root) => {
        mkdirSync(`${root}/.factory/agents`, { recursive: true });
        writeFileSync(`${root}/.factory/agents/builder.md`, "---\nname: builder\n---\nImplement\n");
        for (const command of ["validate", "run"]) {
          const result = runFixture(root, command, "test", "--stub-agents");
          expect(result.exitCode).toBe(1);
          expect(result.output).toContain("maxVisits must be a positive integer");
          expect(existsSync(`${root}/agent-visits`)).toBe(false);
          expect(existsSync(`${root}/.factory/state`)).toBe(false);
        }
      },
    );
  });

  test.each([undefined, 1, 2])("agent visit limit %s is preserved across resume", (maxVisits) => {
    fixture(
      `steps:
  - id: work
    agent: builder
    task: Implement
    ${maxVisits === undefined ? "" : `maxVisits: ${maxVisits}`}
  - id: checkpoint
    maxVisits: 6
    human:
      prompt: Continue?
      choices: [again, done]
    transitions: {again: work, done: end}
`,
      (root) => {
        mkdirSync(`${root}/.factory/agents`, { recursive: true });
        writeFileSync(`${root}/.factory/agents/builder.md`, "---\nname: builder\n---\nImplement\n");
        expect(runFixture(root, "validate", "test").exitCode).toBe(0);
        const first = runFixture(root, "run", "test", "--stub-agents");
        expect(first.exitCode).toBe(1);
        expect(first.output).toContain("Human response required");
        const visits = maxVisits ?? 5;
        for (let visit = 2; visit <= visits; visit++) {
          const next = runFixture(root, "run", "test", "--stub-agents", "--human-response=again");
          expect(next.exitCode).toBe(1);
          expect(next.output).toContain("Another human response is required");
        }
        const final = runFixture(
          root,
          "run",
          "test",
          "--stub-agents",
          `--human-response=${maxVisits === undefined ? "done" : "again"}`,
        );
        if (maxVisits === undefined) {
          expect(final.exitCode).toBe(0);
        } else {
          expect(final.exitCode).toBe(1);
          expect(final.output).toContain(`exceeded maxVisits (${maxVisits})`);
          const retry = runFixture(root, "run", "test", "--stub-agents");
          expect(retry.exitCode).toBe(1);
          expect(retry.output).toContain(`exceeded maxVisits (${maxVisits})`);
        }
        const calls = readFileSync(`${root}/agent-visits`, "utf8").trim().split("\n");
        expect(calls).toHaveLength(visits);
        expect(new Set(calls).size).toBe(visits);
        for (const [index, call] of calls.entries()) {
          expect(call).toEndWith(`-work-${index + 1}`);
        }
      },
    );
  });

  test("agent, shell, and human steps are unbounded by default but keep explicit limits", () => {
    expect(stepMaxVisits({ agent: "builder" }, "build")).toBeUndefined();
    expect(stepMaxVisits({ shell: "true" }, "work")).toBeUndefined();
    expect(stepMaxVisits({ human: {} }, "clarify")).toBeUndefined();
    expect(stepMaxVisits({ human: {}, maxVisits: 3 }, "clarify")).toBe(3);
  });

  test("routes shell outcomes and preserves maxVisits across resume", () => {
    fixture(
      `steps:
  - id: work
    shell: echo visit >> visits
    maxVisits: 2
    transitions: {completed: work}
`,
      (root) => {
        const first = runFixture(root, "run", "test");
        expect(first.exitCode).toBe(1);
        expect(first.output).toContain("exceeded maxVisits (2)");
        const resumed = runFixture(root, "run", "test");
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
    shell: echo saved >> count; printf '%s' \${{ inputs.goal }} > goal
  - id: retry
    shell: 'if [ ! -e retried ]; then touch retried; exit 1; fi; printf "%s" \${{ inputs.goal }} > resumed-goal'
`,
      (root) => {
        const first = runFixture(root, "run", "test", "--goal=original");
        expect(first.exitCode).toBe(1);
        expect(first.output).toContain("exit code 1");
        const resumed = runFixture(root, "run", "test");
        expect(resumed.exitCode).toBe(0);
        expect(resumed.output).toContain("using its saved inputs");
        expect(readFileSync(`${root}/count`, "utf8")).toBe("saved\n");
        expect(readFileSync(`${root}/goal`, "utf8")).toBe("original");
        expect(readFileSync(`${root}/resumed-goal`, "utf8")).toBe("original");
      },
    );
  });
});

test("a pipeline routes human change requests back to its builder step", () => {
  const pipeline = {
    inputs: { goal: {} },
    steps: [
      {
        id: "build",
        maxVisits: 3,
        shell:
          "printf '%s' " +
          "${{ inputs.goal }}" +
          "; printf '%s' " +
          "${{ steps.human_feedback.response }}" +
          " > builder-task",
        transitions: { completed: "accept" },
      },
      {
        id: "accept",
        human: { prompt: "Approve?", choices: ["approved", "change_requested", "rejected"] },
        transitions: { approved: "publish", change_requested: "human_feedback", rejected: "end" },
      },
      {
        id: "human_feedback",
        human: { prompt: "What should change?" },
        transitions: { completed: "build" },
      },
      {
        id: "publish",
        shell: {
          command: "echo https://example.test/pr/1 >> published; cat published",
          outputs: { stdout: true },
        },
        transitions: { completed: "end" },
      },
    ],
  };
  fixture(stringify(pipeline), (root) => {
    const start = runFixture(root, "run", "test", "--goal=Test the loop");
    expect(start.output).toContain("Human response required");
    const request = runFixture(root, "run", "test", "--human-response=change_requested");
    expect(request.output).toContain("Another human response is required");
    expect(readFileSync(`${root}/builder-task`, "utf8")).not.toContain("Add a regression test");
    const feedback = runFixture(root, "run", "test", "--human-response=Add a regression test");
    expect(feedback.output).toContain("Another human response is required");
    expect(readFileSync(`${root}/builder-task`, "utf8")).toContain("Add a regression test");
    expect(existsSync(`${root}/published`)).toBe(false);
    const approved = runFixture(root, "run", "test", "--human-response=approved");
    expect(approved.exitCode).toBe(0);
    expect(approved.output).toContain("https://example.test/pr/1");
  });
  fixture(stringify(pipeline), (root) => {
    const rejected = runFixture(root, "run", "test", "--goal=Reject", "--human-response=rejected");
    expect(rejected.exitCode).toBe(0);
    expect(existsSync(`${root}/published`)).toBe(false);
  });
});

test("selected shell output is available from the durable result after resume", () => {
  fixture(
    `steps:
  - id: capture
    shell:
      command: printf 'https://example.test/pr/1\\n'
      outputs: {stdout: true}
  - id: retry
    shell: 'if [ ! -e retried ]; then touch retried; exit 1; fi; printf "%s" \${{ steps.capture.stdout }} > url'
`,
    (root) => {
      expect(runFixture(root, "run", "test").exitCode).toBe(1);
      const resumed = runFixture(root, "run", "test");
      expect(resumed.exitCode).toBe(0);
      expect(resumed.output).not.toContain("▶ capture");
      expect(readFileSync(`${root}/url`, "utf8")).toBe("https://example.test/pr/1");
    },
  );
});

test("shell steps configure directory and environment and capture selected streams", () => {
  fixture(
    `inputs: {goal: {}}
steps:
  - id: configured
    shell:
      command: 'printf "%s" "$FACTORY_VALUE"; printf "problem" >&2'
      workingDirectory: subdir
      env: {FACTORY_VALUE: "\${{ inputs.goal }}"}
      outputs: {stdout: true, stderr: true}
  - id: check
    shell: 'printf "%s|%s" \${{ steps.configured.stdout }} \${{ steps.configured.stderr }} > result'
`,
    (root) => {
      mkdirSync(`${root}/subdir`);
      const result = runFixture(root, "run", "test", "--goal=passed");
      expect(result.exitCode).toBe(0);
      expect(readFileSync(`${root}/result`, "utf8")).toBe("passed|problem");
    },
  );
});

test("shell timeout terminates descendant processes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-timeout-"));
  mkdirSync(`${root}/.factory/pipelines`, { recursive: true });
  writeFileSync(
    `${root}/.factory/pipelines/test.yml`,
    `steps:
  - id: timeout
    shell:
      command: 'sleep 0.4; touch should-not-exist'
      timeout: 80
`,
  );
  try {
    const result = runFixture(root, "run", "test");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("timed out after 80 ms");
    await new Promise((done) => setTimeout(done, 500));
    expect(existsSync(`${root}/should-not-exist`)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
    shell: echo published >> effects
`,
    (root) => {
      const pending = runFixture(root, "run", "test");
      expect(pending.exitCode).toBe(1);
      expect(pending.output).toContain("Human response required");
      expect(existsSync(`${root}/effects`)).toBe(false);
      expect(runFixture(root, "run", "test", "--human-response=invalid").exitCode).toBe(1);
      const accepted = runFixture(root, "run", "test", "--human-response=approved");
      expect(accepted.exitCode).toBe(0);
      expect(readFileSync(`${root}/effects`, "utf8")).toBe("published\n");
    },
  );
});

test("typed outputs are restored on resume without repeating producers", () => {
  fixture(
    `steps:
  - id: capture
    shell:
      command: 'echo run >> effects; printf "report.json"'
      outputs: {stdout: true}
    outputs:
      report: {type: artifact, from: result.stdout}
      code: {type: number, from: result.exitCode}
  - id: consume
    shell: 'if [ ! -e retried ]; then touch retried; exit 1; fi; printf "%s:%s" \${{ steps.capture.outputs.report }} \${{ steps.capture.outputs.code }} > result'
`,
    (root) => {
      expect(runFixture(root, "run", "test").exitCode).toBe(1);
      const resumed = runFixture(root, "run", "test");
      expect(resumed.exitCode).toBe(0);
      expect(readFileSync(`${root}/effects`, "utf8")).toBe("run\n");
      expect(readFileSync(`${root}/result`, "utf8")).toBe("report.json:0");
    },
  );
});

test("inserted output and input values are literal data, not new expressions or shell commands", () => {
  fixture(
    stringify({
      inputs: { secret: {}, value: {} },
      steps: [
        {
          id: "produce",
          shell: { command: "cat payload", outputs: { stdout: true } },
          outputs: { value: { type: "string", from: "result.stdout" } },
        },
        {
          id: "consume",
          shell: `printf '%s' \${{ steps.produce.outputs.value }} > received; printf '%s' \${{ inputs.value }} > input-value`,
        },
      ],
    }),
    (root) => {
      const payload = `\${{ inputs.secret }} \${{ steps.produce.stdout }} '; touch unwanted; #`;
      writeFileSync(`${root}/payload`, payload);
      const result = runFixture(root, "run", "test", "--secret=do-not-expand", `--value=${payload}`);
      expect(result.exitCode).toBe(0);
      expect(readFileSync(`${root}/received`, "utf8")).toBe(payload);
      expect(readFileSync(`${root}/input-value`, "utf8")).toBe(payload);
      expect(existsSync(`${root}/unwanted`)).toBe(false);
    },
  );
});

test("selected streams enforce a combined UTF-8 byte limit", () => {
  fixture(
    stringify({
      steps: [
        {
          id: "produce",
          shell: { command: "cat payload", outputs: { stdout: true } },
        },
        { id: "consume", shell: "touch unwanted" },
      ],
    }),
    (root) => {
      writeFileSync(`${root}/payload`, "é".repeat(32769));
      const result = runFixture(root, "run", "test");
      expect(result.exitCode).toBe(1);
      expect(result.output).toContain("exceeds output limit");
      expect(existsSync(`${root}/unwanted`)).toBe(false);
    },
  );
});

test("replays saved typed agent outputs without a model call or remapping", async () => {
  const { BACKGROUND_CONTEXT } = await import("@earendil-works/chord/context");
  const { createAgentRuntime } = await import("../src/agent-runtime");
  const { appendEvent, openJournal } = await import("../src/journal");
  const root = mkdtempSync(resolve(tmpdir(), "factory-output-replay-"));
  let journal: Awaited<ReturnType<typeof openJournal>> | undefined;
  try {
    mkdirSync(`${root}/.factory/pipelines`, { recursive: true });
    mkdirSync(`${root}/.factory/agents`, { recursive: true });
    writeFileSync(`${root}/.factory/agents/producer.md`, "---\nname: producer\n---\nProduce outputs.\n");
    const pipeline = {
      steps: [
        {
          id: "produce",
          agent: "producer",
          task: "This must not run during replay",
          // The saved checkpoint wins even if the mapping was subsequently edited.
          outputs: { value: { type: "string", from: "result.missing" } },
        },
        { id: "consume", shell: `printf '%s' \${{ steps.produce.outputs.value }} > received` },
      ],
    };
    writeFileSync(`${root}/.factory/pipelines/test.yml`, stringify(pipeline));
    journal = await openJournal(root, "pipeline:test", () => ({}), createAgentRuntime(root, pipeline));
    await appendEvent(journal.conversation, "factory.step", {
      runId: journal.runId,
      key: "pipeline:test:test:test:produce:1",
      stepId: "produce",
      visit: 1,
      status: "completed",
      result: { status: "completed", outputs: { value: "original mapped value" } },
    });
    await journal.harness.close(BACKGROUND_CONTEXT);
    const resumed = runFixture(root, "run", "test");
    expect(resumed.exitCode).toBe(0);
    expect(resumed.output).toContain("reusing durable result");
    expect(readFileSync(`${root}/received`, "utf8")).toBe("original mapped value");
  } finally {
    await journal?.harness.close(BACKGROUND_CONTEXT);
    rmSync(root, { recursive: true, force: true });
  }
});

test("refine regenerates round-local outputs and repeated refine requests replay them", () => {
  fixture(
    stringify({
      steps: [
        {
          id: "produce",
          shell: {
            command: 'echo run >> effects; printf "report-%s" "$(wc -l < effects | tr -d \' \')"',
            outputs: { stdout: true },
          },
          outputs: { report: { type: "artifact", from: "result.stdout" } },
        },
        { id: "consume", shell: `printf '%s' \${{ steps.produce.outputs.report }} > received` },
      ],
    }),
    (root) => {
      const session = (request: object) =>
        Bun.spawnSync([process.execPath, `${repository}/src/worker.ts`], {
          cwd: root,
          stdin: Buffer.from(`${JSON.stringify({ pipeline: "test", runId: "outputs", ...request })}\n`),
          stdout: "pipe",
          stderr: "pipe",
        });
      expect(session({ mode: "new" }).exitCode).toBe(0);
      expect(readFileSync(`${root}/received`, "utf8")).toBe("report-1");
      const request = { mode: "refine", instruction: "Regenerate", requestId: "refinement" };
      expect(session(request).exitCode).toBe(0);
      expect(readFileSync(`${root}/received`, "utf8")).toBe("report-2");
      expect(session(request).exitCode).toBe(0);
      expect(readFileSync(`${root}/effects`, "utf8")).toBe("run\nrun\n");
      expect(readFileSync(`${root}/received`, "utf8")).toBe("report-2");
    },
  );
});
