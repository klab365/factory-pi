import { shellSpec, validatePipeline, type ShellSpec } from "./pipeline-validation";
import { createAgentRuntime } from "./agent-runtime";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { openJournal, appendEvent, type DurableJournal } from "./journal";

import {
  type RecordValue,
  fail,
  object,
  string,
  loadYaml,
  factoryFile,
  collectInputs,
} from "./pipeline-inputs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { humanPrompt, humanResult, type HumanPrompt } from "./human";
import { mapOutputs, OUTPUT_LIMIT } from "./step-outputs";
const root = process.cwd();
let eventSink: ((event: RecordValue) => void) | undefined;
function emit(type: string, data: RecordValue) {
  eventSink?.({ type, ...data });
}

async function recordStep(
  journal: DurableJournal,
  key: string,
  stepId: string,
  visit: number,
  status: "started" | "completed" | "failed",
  result?: RecordValue,
): Promise<void> {
  await appendEvent(journal.conversation, "factory.step", {
    runId: journal.runId,
    key,
    stepId,
    visit,
    status,
    ...(result === undefined ? {} : { result }),
  });
  emit("step", { runId: journal.runId, stepId, visit, status, result });
  if (status === "completed") {
    journal.completed.add(key);
    if (result) journal.results.set(key, result);
  } else {
    journal.completed.delete(key);
    journal.results.delete(key);
  }
}

async function runCommand(spec: ShellSpec, label: string): Promise<RecordValue> {
  const command = spec.command;
  console.log(`\n▶ ${label}: ${command}`);
  const child = spawn("bash", ["-lc", command], {
    cwd: resolve(root, spec.workingDirectory),
    env: { ...process.env, ...spec.env },
    stdio: ["inherit", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let stdout = "";
  let stderr = "";
  let outputOverflow = false;
  let timedOut = false;
  let stopping = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  let killPromise: Promise<void> | undefined;
  const kill = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32" && child.pid) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch (error) {
        // A fast command may already have exited when buffered output overflows.
        // Some platforms deny signaling the now-empty group; fall back to the child.
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code !== "ESRCH" && code !== "EPERM") throw error;
      }
    }
    child.kill(signal);
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill("SIGTERM");
    killPromise = new Promise<void>((done) => {
      killTimer = setTimeout(() => {
        try {
          kill("SIGKILL");
        } finally {
          done();
        }
      }, 300);
    });
  };
  const onSignal = () => stop();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let capturedBytes = 0;
  const consume = (stream: NodeJS.ReadableStream, kind: "stdout" | "stderr") => {
    const decoder = new TextDecoder();
    const accept = (text: string) => {
      if (spec.outputs[kind] && !outputOverflow) {
        capturedBytes += Buffer.byteLength(text, "utf8");
        if (capturedBytes > OUTPUT_LIMIT) {
          outputOverflow = true;
          stdout = "";
          stderr = "";
          stop();
        } else if (kind === "stdout") stdout += text;
        else stderr += text;
      }
      if (eventSink) emit("output", { stream: kind, text });
      else (kind === "stdout" ? process.stdout : process.stderr).write(text);
    };
    stream.on("data", (chunk: Buffer) => accept(decoder.decode(chunk, { stream: true })));
    stream.on("end", () => accept(decoder.decode()));
  };
  consume(child.stdout, "stdout");
  consume(child.stderr, "stderr");
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  if (spec.timeout !== undefined) {
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      stop();
    }, spec.timeout);
  }
  try {
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    await killPromise;
    if (outputOverflow) fail(`Step '${label}' exceeds output limit`);
    if (timedOut) fail(`Step '${label}' timed out after ${spec.timeout} ms`);
    if (stopping) fail(`Step '${label}' was cancelled`);
    if (code !== 0) fail(`Step '${label}' failed with exit code ${code}`);
    return {
      status: "completed",
      summary: "Command completed",
      exitCode: code,
      ...(spec.outputs.stdout ? { stdout: stdout.trimEnd() } : {}),
      ...(spec.outputs.stderr ? { stderr: stderr.trimEnd() } : {}),
    };
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    if (killTimer) clearTimeout(killTimer);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

type PipelineCursor = { stepId: string; visit: number; visits: Record<string, number> };

async function saveCursor(journal: DurableJournal, cursor: PipelineCursor): Promise<void> {
  await appendEvent(journal.conversation, "factory.cursor", { runId: journal.runId, ...cursor });
  journal.cursor = cursor;
  emit("transition", { runId: journal.runId, ...cursor });
}

async function executePipeline(
  name: string,
  workflowPath: string,
  jobName: string,
  journal: DurableJournal,
  inputs: Record<string, string>,
  requestHuman: HumanHandler,
): Promise<void> {
  const pipeline = loadYaml(factoryFile("pipelines", name, "yml"));
  if (!Array.isArray(pipeline.steps)) fail(`Pipeline '${name}' must define a steps array`);
  const steps = (pipeline.steps as unknown[]).map((raw, index) =>
    object(raw, `Pipeline '${name}' step ${index + 1}`),
  );
  const stepById = new Map(steps.map((step) => [String(step.id), step]));
  const orderedIds = steps.map((step) => String(step.id));
  let current: PipelineCursor = journal.cursor ?? {
    stepId: orderedIds[0] ?? "",
    visit: 1,
    visits: orderedIds[0] ? { [orderedIds[0]]: 1 } : {},
  };
  if (!current.stepId) return;
  if (!journal.cursor) await saveCursor(journal, current);

  while (true) {
    const active = current;
    const stepCandidate = stepById.get(active.stepId);
    if (!stepCandidate) throw new Error(`Cursor references unknown step '${active.stepId}'`);
    const step = stepCandidate;
    const stepId: string = active.stepId;
    const visit: number = active.visit;
    const label = typeof step.name === "string" ? step.name : stepId;
    const key: string = `${journal.round > 1 ? `round:${journal.round}:` : ""}${workflowPath}:${jobName}:${name}:${stepId}:${visit}`;
    const stepResults = new Map<string, RecordValue>();
    for (const [priorStep, priorVisit] of Object.entries(active.visits)) {
      const priorKey = `${journal.round > 1 ? `round:${journal.round}:` : ""}${workflowPath}:${jobName}:${name}:${priorStep}:${priorVisit}`;
      const priorResult = journal.results.get(priorKey);
      if (priorResult) stepResults.set(priorStep, priorResult);
    }
    let result: RecordValue | undefined = journal.completed.has(key) ? journal.results.get(key) : undefined;
    if (result) {
      console.log(`↷ ${label} (visit ${visit}): reusing durable result`);
    } else {
      await recordStep(journal, key, stepId, visit, "started");
      try {
        if (step.shell !== undefined) {
          const shell = shellSpec(step.shell, label);
          shell.command = interpolate(shell.command, inputs, true, stepResults);
          shell.workingDirectory = interpolate(shell.workingDirectory, inputs, false, stepResults);
          for (const [key, value] of Object.entries(shell.env)) {
            shell.env[key] = interpolate(value, inputs, false, stepResults);
          }
          result = await runCommand(shell, label);
        } else if (typeof step.agent === "string") {
          const task = interpolate(string(step.task, `Step '${label}' task`), inputs, false, stepResults);
          console.log(`\n▶ ${label} (${step.agent}, visit ${visit})`);
          emit("agent", { runId: journal.runId, stepId, agent: step.agent, visit, status: "started" });
          const requestId = `factory-${journal.runId}-${journal.round > 1 ? `round-${journal.round}-` : ""}${stepId}-${visit}`;
          result = await journal.runAgent(step.agent, task, requestId);
        } else if (step.human !== undefined) {
          const prompt = humanPrompt(step.human);
          prompt.prompt = interpolate(prompt.prompt, inputs, false, stepResults);
          await appendEvent(journal.conversation, "factory.human.pending", {
            runId: journal.runId,
            key,
            ...prompt,
          });
          emit("pending-input", { runId: journal.runId, stepId, key, ...prompt });
          result = humanResult(prompt, await requestHuman(prompt, key));
        } else {
          throw new Error(`Step '${label}' must define 'shell', 'agent', or 'human'`);
        }
        if (step.outputs !== undefined) result = { ...result, outputs: mapOutputs(step, result) };
        await recordStep(journal, key, stepId, visit, "completed", result);
      } catch (error) {
        await recordStep(journal, key, stepId, visit, "failed");
        throw error;
      }
    }
    if (!result || typeof result.status !== "string") {
      throw new Error(`Step '${stepId}' has no durable result status`);
    }

    const transitions =
      step.transitions === undefined ? undefined : object(step.transitions, `Step '${stepId}' transitions`);
    let target: unknown;
    if (transitions) {
      target = transitions[result.status];
      if (target === undefined)
        throw new Error(`Step '${stepId}' has no transition for status '${result.status}'`);
    } else {
      const nextIndex = orderedIds.indexOf(stepId) + 1;
      target = orderedIds[nextIndex] ?? "end";
    }
    if (typeof target !== "string")
      throw new Error(`Transition for status '${result.status}' on '${stepId}' must name a step or 'end'`);
    if (target === "end") break;
    const nextStep = stepById.get(target);
    if (!nextStep) throw new Error(`Transition from '${stepId}' targets unknown step '${target}'`);
    const nextVisit = (active.visits[target] ?? 0) + 1;
    const maxVisits = typeof nextStep.maxVisits === "number" ? nextStep.maxVisits : 1;
    if (!Number.isInteger(maxVisits) || maxVisits < 1)
      throw new Error(`Step '${target}' maxVisits must be a positive integer`);
    if (nextVisit > maxVisits) throw new Error(`Step '${target}' exceeded maxVisits (${maxVisits})`);
    const visits = { ...active.visits, [target]: nextVisit };
    current = { stepId: target, visit: nextVisit, visits };
    await saveCursor(journal, current);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function interpolate(
  template: string,
  inputs: Record<string, string>,
  quoteForShell: boolean,
  stepResults: Map<string, RecordValue> = new Map(),
): string {
  // Match only the original template: inserted values are data, never expressions.
  return template.replace(
    /\$\{\{\s*(?:inputs\.([\w-]+)|steps\.([\w-]+)\.(?:outputs\.([\w-]+)|([\w-]+)))\s*\}\}/g,
    (_match, input: string | undefined, stepId: string, output: string | undefined, field: string) => {
      let value: unknown;
      if (input !== undefined) {
        value = inputs[input];
        if (value === undefined) fail(`No value provided for input '${input}'`);
      } else if (output !== undefined) {
        const outputs = stepResults.get(stepId)?.outputs;
        value =
          outputs && typeof outputs === "object" && !Array.isArray(outputs) && Object.hasOwn(outputs, output)
            ? Reflect.get(outputs, output)
            : undefined;
        if (value === undefined) fail(`No value available for output '${stepId}.${output}'`);
        if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")
          fail(`Invalid saved output '${stepId}.${output}'`);
      } else {
        value = stepResults.get(stepId)?.[field];
        if (typeof value !== "string") return "";
      }
      const text = String(value);
      return quoteForShell ? shellQuote(text) : text;
    },
  );
}

export type HumanHandler = (prompt: HumanPrompt, key: string) => Promise<unknown>;

export async function runPipeline(
  name: string,
  args: string[],
  selection?: { mode: "new" | "resume" | "refine"; runId?: string; instruction?: string; requestId?: string },
  onEvent?: (event: RecordValue) => void,
  requestHuman: HumanHandler = async () => {
    throw new Error("Human response required");
  },
): Promise<void> {
  eventSink = onEvent;
  const pipeline = validatePipeline(root, name);
  collectInputs(pipeline, args, false);
  const runtime = createAgentRuntime(root, pipeline);
  const workflowPath = `pipeline:${name}`;
  const journal = await openJournal(
    root,
    workflowPath,
    () => collectInputs(pipeline, args),
    runtime,
    selection,
  );
  emit("run", { runId: journal.runId, pipeline: name, round: journal.round });
  const inputs = journal.inputs;
  journal.harness.resume();
  try {
    console.log(`━━ Pipeline: ${name} ━━`);
    await executePipeline(name, workflowPath, name, journal, inputs, requestHuman);
    console.log("\n✓ Factory pipeline completed");
    await appendEvent(journal.indexConversation, "factory.run", {
      conversationId: journal.conversation.id,
      runId: journal.runId,
      workflow: workflowPath,
      status: "completed",
      inputs,
    });
    emit("completed", { runId: journal.runId });
  } finally {
    await journal.harness.close(BACKGROUND_CONTEXT);
  }
}
