import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  parseCommand,
  promptInputs,
  chooseRun,
  saveRun,
  readRuns,
  runChild,
  type PromptUI,
  type Request,
  type Run,
  workspaceIdentity,
} from "../src/pi-session";

const ui: PromptUI = {
  editor: async () => "first line\nsecond line",
  input: async () => "value",
  select: async (_title, choices) => choices[0],
};
test("parses commands without mandatory flags and rejects extra arguments", () => {
  expect(parseCommand("")).toEqual({ command: "run", target: undefined });
  expect(parseCommand("run software-factory")).toEqual({ command: "run", target: "software-factory" });
  expect(parseCommand("resume abc")).toEqual({ command: "resume", target: "abc" });
  expect(parseCommand("refine").command).toBe("refine");
  expect(() => parseCommand("run a b")).toThrow("Usage");
});
test("prompts goal in multiline editor; respects options, defaults, cancellation and required values", async () => {
  expect(
    await promptInputs(
      { inputs: { goal: {}, choice: { options: ["a", "b"] }, optional: { required: false } } },
      ui,
    ),
  ).toEqual({ goal: "first line\nsecond line", choice: "a", optional: "value" });
  expect(
    await promptInputs({ inputs: { goal: {} } }, { ...ui, editor: async () => undefined }),
  ).toBeUndefined();
  await expect(promptInputs({ inputs: { goal: {} } }, { ...ui, editor: async () => "" })).rejects.toThrow(
    "Missing required",
  );
  expect(
    await promptInputs({ inputs: { field: { default: "default" } } }, { ...ui, input: async () => "" }),
  ).toEqual({ field: "default" });
});
test("selects only eligible runs and preserves runId to Pi session mappings", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-pi-map-"));
  try {
    saveRun(root, { runId: "a", pipeline: "test", sessionFile: "/a.jsonl", status: "started" });
    saveRun(root, { runId: "b", pipeline: "test", sessionFile: "/b.jsonl", status: "completed" });
    expect((await chooseRun(readRuns(root), "resume", undefined, ui))?.sessionFile).toBe("/a.jsonl");
    expect((await chooseRun(readRuns(root), "refine", "b", ui))?.sessionFile).toBe("/b.jsonl");
    await expect(chooseRun(readRuns(root), "resume", "b", ui)).rejects.toThrow("No interrupted");
    await expect(chooseRun([], "resume", undefined, ui)).rejects.toThrow("No interrupted");
    expect(
      await chooseRun(readRuns(root), "resume", undefined, { ...ui, select: async () => undefined }),
    ).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("child protocol reuses CLI: new runs independent, resume skips work, refine adds a durable round", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-pi-child-"));
  mkdirSync(resolve(root, ".factory/pipelines"), { recursive: true });
  writeFileSync(
    resolve(root, ".factory/pipelines/test.yml"),
    `inputs:\n  goal: {}\nsteps:\n  - id: work\n    shell: echo \${{ inputs.goal }} >> output\n`,
  );
  const events: Record<string, unknown>[] = [];
  const run = (request: Request) => runChild(root, request, (event) => events.push(event));
  try {
    await run({ mode: "new", runId: "first", pipeline: "test", inputs: { goal: "one\ntwo" } });
    await run({ mode: "resume", runId: "first", pipeline: "test" });
    expect(readFileSync(resolve(root, "output"), "utf8")).toBe("one\ntwo\n");
    await run({
      mode: "refine",
      runId: "first",
      pipeline: "test",
      instruction: "more",
      requestId: "round-two",
    });
    await run({
      mode: "refine",
      runId: "first",
      pipeline: "test",
      instruction: "more",
      requestId: "round-two",
    });
    expect(readFileSync(resolve(root, "output"), "utf8").match(/more/g)?.length).toBe(1);
    await run({ mode: "new", runId: "second", pipeline: "test", inputs: { goal: "independent" } });
    expect(events.filter((event) => event.type === "run").map((event) => [event.runId, event.round])).toEqual(
      [
        ["first", 1],
        ["first", 1],
        ["first", 2],
        ["first", 2],
        ["second", 1],
      ],
    );
    expect(events.some((event) => event.type === "step" && event.status === "completed")).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fake Pi UI can cancel and resume a durable human checkpoint without repeating effects", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-pi-human-"));
  try {
    mkdirSync(resolve(root, ".factory/pipelines"), { recursive: true });
    writeFileSync(
      resolve(root, ".factory/pipelines/test.yml"),
      `steps:
  - id: prepare
    shell: echo prepared >> effects
  - id: feedback
    human:
      prompt: What should change?
  - id: apply
    shell: printf '%s\\n' \${{ steps.feedback.response }} >> effects
`,
    );
    const pending: unknown[] = [];
    const response = "Don't expand $(echo injected)";
    let prompts = 0;
    const run = (mode: Request["mode"]) =>
      runChild(
        root,
        { mode, runId: "human", pipeline: "test" },
        (event) => {
          if (event.type === "pending-input") pending.push(event.key);
        },
        undefined,
        {
          human: async (prompt) => {
            expect(prompt.prompt).toBe("What should change?");
            return ++prompts === 1 ? undefined : response;
          },
        },
      );
    await expect(run("new")).rejects.toThrow("Human input cancelled");
    expect(readFileSync(resolve(root, "effects"), "utf8")).toBe("prepared\n");
    await run("resume");
    await run("resume");
    expect(pending).toEqual([expect.any(String), pending[0]]);
    expect(readFileSync(resolve(root, "effects"), "utf8")).toBe(`prepared\n${response}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a durable completion settles even if the runner hangs during shutdown", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-pi-terminal-"));
  const controller = new AbortController();
  const events: Record<string, unknown>[] = [];
  try {
    await expect(
      runChild(
        root,
        { mode: "new", runId: "terminal", pipeline: "test" },
        (event) => {
          events.push(event);
          // Cancellation arriving after the durable terminal event must not undo success.
          controller.abort(new Error("late cancellation"));
        },
        controller.signal,
        {
          command: process.execPath,
          args: [
            "-e",
            'console.log(JSON.stringify({type:"completed",runId:"terminal"})); setInterval(()=>{},1000)',
          ],
          completionGraceMs: 25,
        },
      ),
    ).resolves.toBeUndefined();
    expect(events).toEqual([{ type: "completed", runId: "terminal" }]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 10000);

const delay = (milliseconds: number) => new Promise((done) => setTimeout(done, milliseconds));
async function waitUntil(check: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting for child process");
    await delay(20);
  }
}
function alive(pid: number): boolean {
  const result = Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)]);
  const state = new TextDecoder().decode(result.stdout).trim();
  // An orphan may briefly be a zombie awaiting init's reaper; it cannot execute code.
  return result.exitCode === 0 && state !== "" && !state.startsWith("Z");
}

test.skipIf(process.platform === "win32").each(["abort", "event error"])(
  "terminates runner and TERM-resistant shell descendant on %s before settling",
  async (mode) => {
    const root = mkdtempSync(resolve(tmpdir(), "factory-pi-cancel-"));
    mkdirSync(resolve(root, ".factory/pipelines"), { recursive: true });
    writeFileSync(
      resolve(root, "descendant.ts"),
      `
      import { writeFileSync, closeSync } from "node:fs";
      process.on("SIGTERM", () => {});
      writeFileSync("ready", String(process.pid));
      console.log("READY");
      // Do not keep the runner's pipes open: its close event alone is not proof
      // that every member of the process group has terminated.
      closeSync(1); closeSync(2);
      setTimeout(() => writeFileSync("post-abort", "unexpected side effect"), 1200);
      setInterval(() => {}, 1000);
    `,
    );
    writeFileSync(
      resolve(root, ".factory/pipelines/test.yml"),
      `
steps:
  - id: wait
    shell: |
      echo "$PPID" > runner.pid
      echo "$$" > shell.pid
      bun descendant.ts &
      wait
`,
    );
    const controller = new AbortController();
    const eventError = new Error("renderer failed");
    const running = runChild(
      root,
      { mode: "new", runId: "cancel", pipeline: "test" },
      (event) => {
        if (mode === "event error" && event.type === "output" && String(event.text).includes("READY"))
          throw eventError;
      },
      controller.signal,
    ).then(
      () => undefined,
      (error) => error,
    );
    const pids: number[] = [];
    try {
      await waitUntil(() => existsSync(resolve(root, "ready")));
      for (const file of ["runner.pid", "shell.pid", "ready"])
        pids.push(Number(readFileSync(resolve(root, file), "utf8")));
      if (mode === "abort") {
        expect(alive(pids[0])).toBe(true);
        expect(alive(pids[2])).toBe(true);
        controller.abort(new Error("cancelled by test"));
      }
      const error = await running;
      expect(error).toBeInstanceOf(Error);
      if (mode === "event error") expect(error).toBe(eventError);
      else expect(error.message).toBe("cancelled by test");
      // No survivor may run alongside a subsequent resume.
      expect(pids.filter(alive)).toEqual([]);
      await delay(1300);
      expect(existsSync(resolve(root, "post-abort"))).toBe(false);
    } finally {
      controller.abort();
      for (const file of ["runner.pid", "shell.pid", "ready"]) {
        if (existsSync(resolve(root, file))) {
          const pid = Number(readFileSync(resolve(root, file), "utf8"));
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      }
      await running;
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);

test("does not spawn a runner for an already aborted signal", async () => {
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  await expect(
    runChild("/nonexistent", { mode: "new", runId: "cancel", pipeline: "test" }, () => {}, controller.signal),
  ).rejects.toThrow("already cancelled");
});

test("refine scopes shared catalogs, directly selects one run and allows explicit legacy IDs", async () => {
  const workspace = { repository: "/repo", worktree: "/repo/main" };
  const local: Run = {
    runId: "local",
    pipeline: "test",
    sessionFile: "/local",
    status: "completed",
    workspace,
    goal: "my goal",
    createdAt: "2026-01-01T00:00:00Z",
  };
  const foreign: Run = { ...local, runId: "foreign", workspace: { ...workspace, worktree: "/repo/other" } };
  const legacy: Run = { ...local, runId: "legacy", workspace: undefined };
  const interrupted: Run = { ...local, runId: "interrupted", status: "started" };
  const noPicker = {
    ...ui,
    select: async () => {
      throw new Error("unexpected picker");
    },
  };
  expect(
    await chooseRun([foreign, legacy, interrupted, local], "refine", undefined, noPicker, workspace),
  ).toEqual(local);
  await expect(chooseRun([foreign, legacy], "refine", undefined, noPicker, workspace)).rejects.toThrow(
    "No completed",
  );
  await expect(chooseRun([foreign], "refine", "foreign", ui, workspace)).rejects.toThrow("another worktree");
  expect(await chooseRun([legacy], "refine", "legacy", ui, workspace)).toEqual(legacy);
  const second = { ...local, runId: "second", goal: "second goal" };
  let labels: string[] = [];
  const picker = {
    ...ui,
    select: async (_title: string, choices: string[]) => {
      labels = choices;
      return choices[1];
    },
  };
  expect(await chooseRun([foreign, legacy, local, second], "refine", undefined, picker, workspace)).toEqual(
    second,
  );
  expect(labels).toHaveLength(2);
  expect(labels[0]).toContain("my goal");
  expect(labels[0]).toContain("test");
  expect(labels[0]).toContain("2026-01-01");
  expect(
    await chooseRun(
      [local, second],
      "refine",
      undefined,
      { ...ui, select: async () => undefined },
      workspace,
    ),
  ).toBeUndefined();
});

test("workspace identity canonicalizes non-git directories", () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-workspace-"));
  try {
    expect(workspaceIdentity(root)).toEqual({ repository: realpathSync(root), worktree: realpathSync(root) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("linked git worktrees share repository identity but not worktree identity", () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-git-workspaces-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  try {
    git("init");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-m",
      "fixture",
    );
    git("worktree", "add", "--detach", resolve(root, "linked"));
    mkdirSync(resolve(root, "subdir"));
    const main = workspaceIdentity(root);
    const linked = workspaceIdentity(resolve(root, "linked"));
    expect(linked.repository).toBe(main.repository);
    expect(linked.worktree).not.toBe(main.worktree);
    expect(workspaceIdentity(resolve(root, "subdir"))).toEqual(main);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
