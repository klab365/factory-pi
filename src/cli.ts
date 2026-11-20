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

async function runCommand(command: string, label: string): Promise<void> {
  console.log(`\n▶ ${label}: ${command}`);
  const proc = Bun.spawn(["bash", "-lc", command], {
    cwd: root,
    stdout: eventSink ? "pipe" : "inherit",
    stderr: "inherit",
    stdin: "inherit",
  });
  if (eventSink && proc.stdout) {
    for await (const chunk of proc.stdout) emit("output", { text: new TextDecoder().decode(chunk) });
  }
  const code = await proc.exited;
  if (code !== 0) fail(`Step '${label}' failed with exit code ${code}`);
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
        if (typeof step.run === "string") {
          await runCommand(interpolate(step.run, inputs, true, stepResults), label);
          result = { status: "completed", summary: "Command completed" };
        } else if (typeof step.agent === "string") {
          const task = interpolate(string(step.task, `Step '${label}' task`), inputs, false, stepResults);
          console.log(`\n▶ ${label} (${step.agent}, visit ${visit})`);
          emit("agent", { runId: journal.runId, stepId, agent: step.agent, visit, status: "started" });
          const requestId = `factory-${journal.runId}-${journal.round > 1 ? `round-${journal.round}-` : ""}${stepId}-${visit}`;
          result = await journal.runAgent(step.agent, task, requestId);
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

export async function runPipeline(
  name: string,
  args: string[],
  selection?: { mode: "new" | "resume" | "refine"; runId?: string; instruction?: string; requestId?: string },
  onEvent?: (event: RecordValue) => void,
): Promise<void> {
  eventSink = onEvent;
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
    if ((step.run !== undefined) === (step.agent !== undefined)) {
      fail(`Pipeline step '${id}' must define exactly one of 'run' or 'agent'`);
    }
    if (step.run !== undefined) {
      string(step.run, `Pipeline step '${id}' run`);
    } else if (typeof step.agent === "string") {
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
  if (announce) console.log(`✓ Pipeline valid: ${name}`);
}

if (import.meta.main) {
  const [command, target, ...args] = Bun.argv.slice(2);
  try {
    if (command === "session") {
      const request = JSON.parse(await Bun.stdin.text());
      console.log = (...values) => console.error(...values);
      await runPipeline(
        request.pipeline,
        Object.entries(request.inputs ?? {}).map(([key, value]) => `--${key}=${value}`),
        request,
        (event) => process.stdout.write(`${JSON.stringify(event)}\n`),
      );
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
