#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { parse } from "yaml";
import { createAgentRuntime, loadAgentDefinition } from "./agent-runtime";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type Conversation, type Cursor } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";

type RecordValue = Record<string, unknown>;
const root = process.cwd();
const fail = (message: string): never => {
  throw new Error(message);
};
const object = (value: unknown, label: string): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a mapping`);
  return value as RecordValue;
};
const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value as string;
};

function loadYaml(path: string): RecordValue {
  if (!existsSync(path)) fail(`File not found: ${relative(root, path)}`);
  return object(parse(readFileSync(path, "utf8")), relative(root, path));
}
function factoryFile(folder: string, name: string, extension: string): string {
  const path = resolve(root, ".factory", folder, `${name}.${extension}`);
  const fromFactory = relative(resolve(root, ".factory", folder), path);
  if (isAbsolute(fromFactory) || fromFactory === ".." || fromFactory.startsWith(`..${sep}`)) {
    fail(`Invalid ${folder.slice(0, -1)} name: ${name}`);
  }
  return path;
}

type DurableJournal = Awaited<ReturnType<typeof openJournal>>;
async function openJournal(
  workflowPath: string,
  requestedInputs: Record<string, string>,
  runtime: ReturnType<typeof createAgentRuntime>,
) {
  const storage = await openNodeJsonlStorage(resolve(root, ".factory/state/durable"), BACKGROUND_CONTEXT);
  const harness = await Harness.open(
    storage,
    {
      models: runtime.models,
      registry: runtime.registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? root }),
    },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const runs = new Map<string, { status: string; workflow: string; inputs?: Record<string, string> }>();
  const completed = new Set<string>();
  const results = new Map<string, RecordValue>();
  let savedCursor: { stepId: string; visit: number; visits: Record<string, number> } | undefined;
  let cursor: Cursor | undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (!entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as RecordValue;
      if (
        entry.kind === "factory.run" &&
        typeof data.runId === "string" &&
        typeof data.workflow === "string"
      ) {
        runs.set(data.runId, {
          status: String(data.status),
          workflow: data.workflow,
          ...(data.inputs && typeof data.inputs === "object"
            ? { inputs: data.inputs as Record<string, string> }
            : {}),
        });
      }
    }
    cursor = page.next;
  } while (cursor);
  const activeRun = [...runs]
    .reverse()
    .find(([, run]) => run.workflow === workflowPath && run.status === "started");
  let runId = activeRun?.[0];
  const inputs = activeRun?.[1].inputs ?? requestedInputs;
  if (!runId) {
    runId = crypto.randomUUID();
    await appendEvent(conversation, "factory.run", {
      runId,
      workflow: workflowPath,
      status: "started",
      inputs,
    });
  } else {
    console.log("↻ Resuming durable run; using its saved inputs");
  }
  cursor = undefined;
  do {
    const page = await conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
    for (const entry of page.items) {
      if (!entry.data || typeof entry.data !== "object") continue;
      const data = entry.data as RecordValue;
      if (data.runId !== runId) continue;
      if (entry.kind === "factory.step" && typeof data.key === "string") {
        if (data.status === "completed") {
          completed.add(data.key);
          if (data.result && typeof data.result === "object" && !Array.isArray(data.result)) {
            results.set(data.key, data.result as RecordValue);
          }
        } else {
          completed.delete(data.key);
          results.delete(data.key);
        }
      }
      if (
        entry.kind === "factory.cursor" &&
        typeof data.stepId === "string" &&
        typeof data.visit === "number" &&
        data.visits &&
        typeof data.visits === "object"
      ) {
        savedCursor = {
          stepId: data.stepId,
          visit: data.visit,
          visits: data.visits as Record<string, number>,
        };
      }
    }
    cursor = page.next;
  } while (cursor);
  return { harness, conversation, completed, results, runId, inputs, cursor: savedCursor };
}

async function appendEvent(conversation: Conversation, kind: string, data: RecordValue): Promise<void> {
  const submission = await conversation.submit(
    { type: "write", entry: { kind, data: { ...data, at: new Date().toISOString() } } },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
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
  if (status === "completed") {
    journal.completed.add(key);
    if (result) journal.results.set(key, result);
  } else {
    journal.completed.delete(key);
    journal.results.delete(key);
  }
}

async function runCommand(command: string, label: string): Promise<void> {
  console.log(`\n▶ ${label}: ${command}`);
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) fail(`Step '${label}' failed with exit code ${code}`);
}

type PipelineCursor = { stepId: string; visit: number; visits: Record<string, number> };

async function saveCursor(journal: DurableJournal, cursor: PipelineCursor): Promise<void> {
  await appendEvent(journal.conversation, "factory.cursor", { runId: journal.runId, ...cursor });
  journal.cursor = cursor;
}

async function executePipeline(
  name: string,
  workflowPath: string,
  jobName: string,
  journal: DurableJournal,
  inputs: Record<string, string>,
  runtime: ReturnType<typeof createAgentRuntime>,
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
    const key: string = `${workflowPath}:${jobName}:${name}:${stepId}:${visit}`;
    const stepResults = new Map<string, RecordValue>();
    for (const [priorStep, priorVisit] of Object.entries(active.visits)) {
      const priorKey = `${workflowPath}:${jobName}:${name}:${priorStep}:${priorVisit}`;
      const priorResult = journal.results.get(priorKey);
      if (priorResult) stepResults.set(priorStep, priorResult);
    }
    let result: RecordValue | undefined = journal.completed.has(key) ? journal.results.get(key) : undefined;
    if (result) {
      console.log(`↷ ${label} (visit ${visit}): reusing durable result`);
    } else {
      await recordStep(journal, key, stepId, visit, "started");
      try {
        if (typeof step.run === "string") {
          await runCommand(interpolate(step.run, inputs, true, stepResults), label);
          result = { status: "completed", summary: "Command completed" };
        } else if (typeof step.agent === "string") {
          const task = interpolate(string(step.task, `Step '${label}' task`), inputs, false, stepResults);
          console.log(`\n▶ ${label} (${step.agent}, visit ${visit})`);
          const requestId = `factory-${journal.runId}-${stepId}-${visit}`;
          result = await runtime.runAgent(journal.conversation, step.agent, task, requestId);
        } else {
          throw new Error(`Step '${label}' must define either 'run' or 'agent'`);
        }
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

function collectInputs(pipeline: RecordValue, args: string[]): Record<string, string> {
  const definitions = pipeline.inputs === undefined ? {} : object(pipeline.inputs, "Pipeline inputs");
  const supplied: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) fail(`Unexpected argument: ${arg}`);
    const equals = arg.indexOf("=");
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    const value = equals >= 0 ? arg.slice(equals + 1) : args[++i];
    if (value === undefined) fail(`Missing value for --${key}`);
    if (!(key in definitions)) fail(`Unknown pipeline input: ${key}`);
    supplied[key] = value;
  }

  const values: Record<string, string> = {};
  for (const [name, raw] of Object.entries(definitions)) {
    const definition = object(raw, `Input '${name}'`);
    let value = supplied[name] ?? (definition.default === undefined ? undefined : String(definition.default));
    const required = definition.required !== false;
    const choices = Array.isArray(definition.options) ? definition.options.map(String) : undefined;
    while (value === undefined || (required && !value.trim())) {
      if (!process.stdin.isTTY) fail(`Missing required input '${name}'. Pass --${name}=<value>`);
      const description = typeof definition.description === "string" ? ` (${definition.description})` : "";
      const choiceText = choices ? ` [${choices.join(", ")}]` : "";
      value = prompt(`${name}${description}${choiceText}: `) ?? "";
    }
    if (value !== undefined && value !== "") {
      if (choices && !choices.includes(value)) fail(`Input '${name}' must be one of: ${choices.join(", ")}`);
      values[name] = value;
    }
  }
  return values;
}

function interpolate(
  template: string,
  inputs: Record<string, string>,
  quoteForShell: boolean,
  stepResults: Map<string, RecordValue> = new Map(),
): string {
  return template
    .replace(/\$\{\{\s*inputs\.([\w-]+)\s*\}\}/g, (_match, key: string) => {
      const value = inputs[key];
      if (value === undefined) fail(`No value provided for input '${key}'`);
      return quoteForShell ? shellQuote(value) : value;
    })
    .replace(/\$\{\{\s*steps\.([\w-]+)\.([\w-]+)\s*\}\}/g, (_match, stepId: string, field: string) => {
      const value = stepResults.get(stepId)?.[field];
      return typeof value === "string" ? value : "";
    });
}

async function runPipeline(name: string, args: string[]): Promise<void> {
  const pipeline = loadYaml(factoryFile("pipelines", name, "yml"));
  const requestedInputs = collectInputs(pipeline, args);
  const runtime = createAgentRuntime(root, pipeline);
  const workflowPath = `pipeline:${name}`;
  const journal = await openJournal(workflowPath, requestedInputs, runtime);
  const inputs = journal.inputs;
  journal.harness.resume();
  try {
    console.log(`━━ Pipeline: ${name} ━━`);
    await executePipeline(name, workflowPath, name, journal, inputs, runtime);
    console.log("\n✓ Factory pipeline completed");
    await appendEvent(journal.conversation, "factory.run", {
      runId: journal.runId,
      workflow: workflowPath,
      status: "completed",
    });
  } finally {
    await journal.harness.close(BACKGROUND_CONTEXT);
  }
}

function validatePipeline(name: string): void {
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
    if (typeof step.run === "string") continue;
    if (typeof step.agent === "string") {
      loadAgentDefinition(root, step.agent);
      string(step.task, `Pipeline '${name}' step ${index + 1} task`);
    } else fail(`Pipeline '${name}' step ${index + 1} needs 'run' or 'agent'`);
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
  console.log(`✓ Pipeline valid: ${name}`);
}

const [command, target, ...args] = Bun.argv.slice(2);
try {
  if (command === "validate" && target) validatePipeline(target);
  else if (command === "run" && target) await runPipeline(target, args);
  else {
    console.error("Usage: factory run <pipeline-name> [--input <value>] | factory validate <pipeline-name>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`\n✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
