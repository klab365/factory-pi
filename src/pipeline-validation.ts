import { loadAgentDefinition } from "./agent-runtime";
import { humanPrompt } from "./human";
import { factoryFile, fail, loadYaml, object, string, type RecordValue } from "./pipeline-inputs";
import { validateOutputs } from "./step-outputs";

export type ShellSpec = {
  command: string;
  workingDirectory: string;
  env: Record<string, string>;
  timeout?: number;
  outputs: { stdout: boolean; stderr: boolean };
};

export function shellSpec(raw: unknown, label: string): ShellSpec {
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

// Omitted limits are unbounded for agent, shell, and human steps.
export function stepMaxVisits(step: RecordValue, id: string): number | undefined {
  if (step.maxVisits === undefined) return undefined;
  if (typeof step.maxVisits !== "number" || !Number.isInteger(step.maxVisits) || step.maxVisits < 1) {
    return fail(`Step '${id}' maxVisits must be a positive integer`);
  }
  return step.maxVisits;
}

export function validatePipeline(root: string, name: string): RecordValue {
  const pipeline = loadYaml(factoryFile("pipelines", name, "yml", root));
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
    stepMaxVisits(step, id);
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
  return pipeline;
}
