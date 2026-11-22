import { humanPrompt, type HumanPrompt } from "./human";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, realpathSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectInputs, object, type RecordValue } from "./pipeline-inputs";

export type Workspace = { repository: string; worktree: string };

// Canonical paths distinguish linked worktrees while normalizing symlinks/subdirectories.
export function workspaceIdentity(cwd: string): Workspace {
  try {
    const git = (arg: string) =>
      execFileSync("git", ["rev-parse", arg], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    return {
      repository: realpathSync(resolve(cwd, git("--git-common-dir"))),
      worktree: realpathSync(git("--show-toplevel")),
    };
  } catch {
    const path = realpathSync(cwd);
    return { repository: path, worktree: path };
  }
}

export type Run = {
  workspace?: Workspace;
  goal?: string;
  createdAt?: string;
  runId: string;
  pipeline: string;
  sessionFile: string;
  status: "started" | "completed";
  pending?: Request;
};
export type Request = {
  mode: "new" | "resume" | "refine";
  runId: string;
  pipeline: string;
  inputs?: Record<string, string>;
  instruction?: string;
  requestId?: string;
};
export type PromptUI = {
  editor(title: string, initial?: string): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  select(title: string, options: string[]): Promise<string | undefined>;
};
type FactoryCommand = "init" | "validate" | "run" | "resume" | "refine";

export function parseCommand(args: string): { command: FactoryCommand; target?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const command = parts.shift() ?? "run";
  const usage =
    "Usage: /factory init | validate [pipeline] | run [pipeline] | resume [runId] | refine [runId]";
  switch (command) {
    case "init":
      if (parts.length === 0) return { command };
      break;
    case "validate":
    case "run":
    case "resume":
    case "refine":
      if (parts.length <= 1) return { command, target: parts[0] };
  }
  throw new Error(usage);
}
export async function promptInputs(
  pipeline: RecordValue,
  ui: PromptUI,
): Promise<Record<string, string> | undefined> {
  const definitions = pipeline.inputs === undefined ? {} : object(pipeline.inputs, "Pipeline inputs");
  const supplied: string[] = [];
  for (const [name, raw] of Object.entries(definitions)) {
    const definition = object(raw, `Input '${name}'`);
    const title = `${name}: ${definition.description ?? ""}${definition.required === false ? " (optional)" : ""}`;
    const initial = definition.default === undefined ? "" : String(definition.default);
    const value = Array.isArray(definition.options)
      ? await ui.select(title, definition.options.map(String))
      : name === "goal"
        ? await ui.editor(title, initial)
        : await ui.input(title, initial);
    if (value === undefined) return undefined;
    supplied.push(`--${name}=${value || initial}`);
  }
  // Validate with the same input rules as the worker.
  for (const [name, raw] of Object.entries(definitions)) {
    if (
      object(raw, name).required !== false &&
      !supplied
        .find((s) => s.startsWith(`--${name}=`))
        ?.slice(name.length + 3)
        .trim()
    ) {
      throw new Error(`Missing required input '${name}'`);
    }
  }
  return collectInputs(pipeline, supplied);
}
const catalogPath = (root: string) => resolve(root, ".factory/state/pi-runs.json");
export function readRuns(root: string): Run[] {
  const path = catalogPath(root);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : [];
}
export function saveRun(root: string, run: Run): void {
  const path = catalogPath(root);
  mkdirSync(dirname(path), { recursive: true });
  const runs = readRuns(root).filter((item) => item.runId !== run.runId);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify([...runs, run], null, 2));
  renameSync(temporary, path);
}
export async function chooseRun(
  runs: Run[],
  mode: "resume" | "refine",
  id: string | undefined,
  ui: PromptUI,
  workspace?: Workspace,
): Promise<Run | undefined> {
  const candidates = runs.filter((run) =>
    mode === "resume" ? run.status === "started" : run.status === "completed",
  );
  const matches = (run: Run) =>
    !workspace ||
    (run.workspace?.repository === workspace.repository && run.workspace?.worktree === workspace.worktree);
  if (id) {
    const run = candidates.find((run) => run.runId === id);
    if (!run) throw new Error(`No ${mode === "resume" ? "interrupted" : "completed"} run with ID '${id}'`);
    if (mode === "refine" && run.workspace && !matches(run))
      throw new Error(`Factory run '${id}' belongs to another worktree; open that worktree to refine it`);
    return run;
  }
  const eligible = mode === "refine" ? candidates.filter(matches) : candidates;
  if (!eligible.length) throw new Error(`No ${mode === "resume" ? "interrupted" : "completed"} Factory runs`);
  if (mode === "refine" && eligible.length === 1) return eligible[0];
  const labels = eligible.map(
    (run) =>
      `${run.runId.slice(0, 8)} · ${run.pipeline} · ${run.createdAt ?? "unknown date"} · ${(run.goal ?? "unknown goal").replace(/\s+/g, " ")} · ${run.runId}`,
  );
  const selected = await ui.select(`Factory ${mode}`, labels);
  return eligible[labels.indexOf(selected ?? "")];
}
export async function runChild(
  root: string,
  request: Request,
  onEvent: (event: RecordValue) => void,
  signal?: AbortSignal,
  options: {
    command?: string;
    args?: string[];
    completionGraceMs?: number;
    human?: (prompt: HumanPrompt) => Promise<string | undefined>;
  } = {},
): Promise<void> {
  signal?.throwIfAborted();
  const worker = fileURLToPath(new URL("./worker.ts", import.meta.url));
  const child = spawn(options.command ?? "bun", options.args ?? ["run", worker], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    // A dedicated POSIX process group allows runner-wide cleanup; the worker relays signals to
    // detached shell groups and cleans up their descendants before this group is escalated.
    // Do not pass signal to spawn: its immediate-child abort can settle before cleanup.
    detached: process.platform !== "win32",
  });
  let stopping: Promise<void> | undefined;
  let failure: unknown;
  let completed = false;
  let closed = false;
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") failure ??= error;
      }
    }
    // Also handle spawn/group-creation failures without leaving the runner alive.
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  };
  const stop = () => {
    if (stopping) return;
    kill("SIGTERM");
    stopping = new Promise<void>((done) => {
      setTimeout(() => {
        // The worker uses a separate process group for shell descendants and needs time to clean it up.
        // Still escalate if the leader exited: descendants may ignore TERM and close inherited pipes.
        kill("SIGKILL");
        done();
      }, 1000);
    });
  };
  const abort = () => {
    // A durable terminal event wins over a late Pi cancellation during child cleanup.
    if (completed) return;
    failure ??= signal?.reason ?? new Error("Factory cancelled");
    stop();
  };
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let pending = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  child.stdin.on("error", (error) => {
    failure ??= error;
    stop();
  });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    if (stopping) return;
    pending += chunk;
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      try {
        const event = object(JSON.parse(line), "Factory event");
        if (event.runId !== undefined && event.runId !== request.runId)
          throw new Error(`Factory event runId mismatch: ${event.runId}`);
        if (event.type === "pending-input") {
          if (!options.human) throw new Error("Human input requires interactive Pi");
          const prompt = humanPrompt(event);
          void options
            .human(prompt)
            .then((response) => {
              if (stopping || closed) return;
              if (response === undefined) {
                failure = new Error("Human input cancelled; resume to respond");
                stop();
                return;
              }
              child.stdin.write(`${JSON.stringify({ key: event.key, response })}\n`);
            })
            .catch((error: unknown) => {
              failure = error;
              stop();
            });
        }
        if (event.type === "completed") {
          completed = true;
          completionTimer = setTimeout(() => {
            // The durable result is already committed. Do not leave Pi waiting forever for host cleanup.
            if (!closed) stop();
          }, options.completionGraceMs ?? 1500);
        }
        onEvent({ ...event, runId: request.runId });
      } catch (error) {
        failure = error;
        stop();
      }
      if (stopping) return;
      newline = pending.indexOf("\n");
    }
  });
  try {
    const childClosed = new Promise<number | null>((done) => {
      child.once("error", (error) => {
        failure ??= error;
        stop();
      });
      child.once("close", (code) => {
        closed = true;
        if (completionTimer) clearTimeout(completionTimer);
        done(code);
      });
    });
    child.stdin.write(`${JSON.stringify(request)}\n`);
    const code = await childClosed;
    await stopping;
    if (failure !== undefined) throw failure;
    if (!completed && code !== 0) throw new Error(stderr || `Factory exited ${code}`);
    if (!completed) throw new Error("Factory exited without a completion event");
  } finally {
    if (completionTimer) clearTimeout(completionTimer);
    signal?.removeEventListener("abort", abort);
  }
}
