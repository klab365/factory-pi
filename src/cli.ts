#!/usr/bin/env bun
import { createAgentRuntime, loadAgentDefinition } from "./agent-runtime";
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
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { humanPrompt, humanResult, type HumanPrompt } from "./human";
import { mapOutputs, validateOutputs, OUTPUT_LIMIT } from "./step-outputs";
const root = process.cwd();
let requestHuman: ((prompt: HumanPrompt, key: string) => Promise<unknown>) | undefined;
async function terminalHuman(prompt: HumanPrompt): Promise<unknown> {
  if (!process.stdin.isTTY)
    throw new Error(
      "Human response required: use an interactive terminal or --human-response=<value> on resume",
    );
  const ui = createInterface({ input: process.stdin, output: process.stderr });
  const controller = new AbortController();
  ui.once("close", () => controller.abort());
  try {
    return await ui.question(
      `${prompt.prompt}${prompt.choices ? ` (${prompt.choices.join(" / ")})` : ""}: `,
      {
        signal: controller.signal,
      },
    );
  } catch (error) {
    if (controller.signal.aborted) return undefined;
    throw error;
  } finally {
    ui.close();
  }
}
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

type ShellSpec = {
  command: string;
  workingDirectory: string;
  env: Record<string, string>;
  timeout?: number;
  outputs: { stdout: boolean; stderr: boolean };
};

function shellSpec(raw: unknown, label: string): ShellSpec {
  if (typeof raw === "string") {
    return { command: raw, workingDirectory: ".", env: {}, outputs: { stdout: false, stderr: false } };
  }
  const value = object(raw, `Step '${label}' shell`);
  const allowed = new Set(["command", "workingDirectory", "env", "timeout", "outputs"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`Step '${label}' shell has unknown field '${key}'`);
  }
  const command = string(value.command, `Step '${label}' shell command`);
  const workingDirectory =
    value.workingDirectory === undefined
      ? "."
      : string(value.workingDirectory, `Step '${label}' shell workingDirectory`);
  const env: Record<string, string> = {};
  if (value.env !== undefined) {
    for (const [key, rawValue] of Object.entries(object(value.env, `Step '${label}' shell env`))) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        fail(`Step '${label}' shell env has invalid variable '${key}'`);
      env[key] = string(rawValue, `Step '${label}' shell env.${key}`);
    }
  }
  let timeout: number | undefined;
  if (value.timeout !== undefined) {
    if (!Number.isInteger(value.timeout) || Number(value.timeout) < 1)
      fail(`Step '${label}' shell timeout must be a positive integer in milliseconds`);
    timeout = Number(value.timeout);
  }
  const outputs = { stdout: false, stderr: false };
  if (value.outputs !== undefined) {
    const selected = object(value.outputs, `Step '${label}' shell outputs`);
    for (const [key, rawSelected] of Object.entries(selected)) {
      if (key !== "stdout" && key !== "stderr")
        fail(`Step '${label}' shell outputs has unknown stream '${key}'`);
      if (typeof rawSelected !== "boolean") fail(`Step '${label}' shell outputs.${key} must be a boolean`);
      if (key === "stdout") {
        if (typeof rawSelected === "boolean") outputs.stdout = rawSelected;
        else fail(`Step '${label}' shell outputs.stdout must be a boolean`);
      } else {
        if (typeof rawSelected === "boolean") outputs.stderr = rawSelected;
        else fail(`Step '${label}' shell outputs.stderr must be a boolean`);
      }
    }
  }
  return { command, workingDirectory, env, ...(timeout === undefined ? {} : { timeout }), outputs };
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
          result = humanResult(
            prompt,
            await (requestHuman ? requestHuman(prompt, key) : terminalHuman(prompt)),
          );
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

export async function runPipeline(
  name: string,
  args: string[],
  selection?: { mode: "new" | "resume" | "refine"; runId?: string; instruction?: string; requestId?: string },
  onEvent?: (event: RecordValue) => void,
): Promise<void> {
  eventSink = onEvent;
  const responseArg = args.find((arg) => arg.startsWith("--human-response="));
  if (responseArg) {
    let consumed = false;
    requestHuman = async () => {
      if (consumed) throw new Error("Another human response is required");
      consumed = true;
      return responseArg.slice("--human-response=".length);
    };
    args = args.filter((arg) => arg !== responseArg);
  }
  const pipeline = loadYaml(factoryFile("pipelines", name, "yml"));
  validatePipeline(name, false);
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
    await executePipeline(name, workflowPath, name, journal, inputs);
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

function validatePipeline(name: string, announce = true): void {
  const pipeline = loadYaml(factoryFile("pipelines", name, "yml"));
  const definitions = pipeline.inputs === undefined ? {} : object(pipeline.inputs, "Pipeline inputs");
  for (const [inputName, raw] of Object.entries(definitions)) {
    const definition = object(raw, `Input '${inputName}'`);
    if (definition.options !== undefined && !Array.isArray(definition.options))
      fail(`Input '${inputName}' options must be a list`);
  }
  if (!Array.isArray(pipeline.steps) || pipeline.steps.length === 0) {
    fail(`Pipeline '${name}' must define a non-empty steps array`);
  }
  const steps = (pipeline.steps as unknown[]).map((raw, index) =>
    object(raw, `Pipeline '${name}' step ${index + 1}`),
  );
  const ids = new Set<string>();
  for (const [index, step] of steps.entries()) {
    const id = string(step.id, `Pipeline '${name}' step ${index + 1} id`);
    if (ids.has(id)) fail(`Pipeline '${name}' has duplicate step id '${id}'`);
    ids.add(id);
    if (step.run !== undefined) fail(`Pipeline step '${id}' uses removed 'run'; use 'shell' instead`);
    if (step.captureOutput !== undefined)
      fail(`Pipeline step '${id}' uses removed 'captureOutput'; select streams with shell.outputs`);
    if ([step.shell, step.agent, step.human].filter((value) => value !== undefined).length !== 1) {
      fail(`Pipeline step '${id}' must define exactly one of 'shell', 'agent', or 'human'`);
    }
    if (step.shell !== undefined) {
      shellSpec(step.shell, id);
    } else if (typeof step.agent === "string") {
      loadAgentDefinition(root, step.agent);
      string(step.task, `Pipeline '${name}' step ${index + 1} task`);
    } else if (step.human !== undefined) humanPrompt(step.human);
    else fail(`Pipeline step '${id}' agent must be a string`);
    if (step.maxVisits !== undefined && (!Number.isInteger(step.maxVisits) || Number(step.maxVisits) < 1)) {
      fail(`Pipeline step '${id}' maxVisits must be a positive integer`);
    }
  }
  for (const step of steps) {
    if (step.transitions === undefined) continue;
    const transitions = object(step.transitions, `Step '${String(step.id)}' transitions`);
    if (Object.keys(transitions).length === 0) fail(`Step '${String(step.id)}' transitions cannot be empty`);
    for (const [status, target] of Object.entries(transitions)) {
      string(status, `Step '${String(step.id)}' transition status`);
      if (typeof target !== "string" || (target !== "end" && !ids.has(target))) {
        fail(`Transition '${status}' on '${String(step.id)}' targets an unknown step or 'end'`);
      }
    }
  }
  validateOutputs(steps);
  if (announce) console.log(`✓ Pipeline valid: ${name}`);
}

if (import.meta.main) {
  const [command, target, ...args] = Bun.argv.slice(2);
  try {
    if (command === "session") {
      const lines = createInterface({ input: process.stdin });
      const iterator = lines[Symbol.asyncIterator]();
      const first = await iterator.next();
      const request = object(JSON.parse(first.value ?? "null"), "Session request");
      requestHuman = async (_prompt, key) => {
        const next = await iterator.next();
        if (next.done) return undefined;
        const response = object(JSON.parse(next.value), "Human response");
        if (response.key !== key) throw new Error("Human response does not match pending input");
        return response.response;
      };
      console.log = (...values) => console.error(...values);
      try {
        await runPipeline(
          string(request.pipeline, "Pipeline"),
          Object.entries(request.inputs ?? {}).map(([key, value]) => `--${key}=${value}`),
          {
            mode: request.mode === "resume" || request.mode === "refine" ? request.mode : "new",
            runId: string(request.runId, "Run ID"),
            ...(typeof request.requestId === "string" ? { requestId: request.requestId } : {}),
            ...(typeof request.instruction === "string" ? { instruction: request.instruction } : {}),
          },
          (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
        );
      } finally {
        lines.close();
      }
    } else if (command === "validate" && target) validatePipeline(target);
    else if (command === "run" && target) await runPipeline(target, args);
    else {
      console.error(
        "Usage: factory run <pipeline-name> [--input <value>] | factory validate <pipeline-name>",
      );
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
