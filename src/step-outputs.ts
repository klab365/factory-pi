import { isAbsolute, win32 } from "node:path";
import { fail, object, string, type RecordValue } from "./pipeline-inputs";

type OutputType = "string" | "number" | "boolean" | "artifact";
type Output = { type: OutputType; from: string };
const namePattern = /^[\w-]+$/;
export const OUTPUT_LIMIT = 64 * 1024;

export function outputDefinitions(step: RecordValue): Map<string, Output> {
  const definitions = new Map<string, Output>();
  if (step.outputs === undefined) return definitions;
  for (const [name, raw] of Object.entries(object(step.outputs, "Step outputs"))) {
    if (!namePattern.test(name)) fail(`Invalid output name '${name}'`);
    const value = object(raw, `Output '${name}'`);
    if (Object.keys(value).some((key) => key !== "type" && key !== "from"))
      fail(`Output '${name}' has unknown fields`);
    const type = value.type;
    if (type !== "string" && type !== "number" && type !== "boolean" && type !== "artifact")
      throw new Error(`Output '${name}' has invalid type`);
    const from = string(value.from, `Output '${name}' from`);
    if (!/^result\.[\w-]+(?:\.[\w-]+)*$/.test(from)) fail(`Output '${name}' must map from result.<field>`);
    definitions.set(name, { type, from });
  }
  return definitions;
}

export function mapOutputs(step: RecordValue, result: RecordValue): RecordValue {
  const outputs: RecordValue = {};
  for (const [name, definition] of outputDefinitions(step)) {
    let value: unknown = result;
    for (const field of definition.from.split(".").slice(1)) {
      value =
        value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, field)
          ? Reflect.get(value, field)
          : undefined;
    }
    if (value === undefined) fail(`Missing value for output '${name}'`);
    if (definition.type === "artifact") {
      if (
        typeof value !== "string" ||
        !value ||
        isAbsolute(value) ||
        win32.isAbsolute(value) ||
        value.split(/[\\/]/).includes("..") ||
        value.includes("\0")
      )
        fail(`Output '${name}' must be a relative artifact path`);
    } else if (typeof value !== definition.type || (typeof value === "number" && !Number.isFinite(value))) {
      fail(`Output '${name}' must be ${definition.type}`);
    }
    if (Buffer.byteLength(JSON.stringify(value), "utf8") > OUTPUT_LIMIT)
      fail(`Output '${name}' exceeds output limit`);
    Object.defineProperty(outputs, name, { value, enumerable: true, configurable: true, writable: true });
  }
  return outputs;
}

export function validateOutputs(steps: RecordValue[]): void {
  const byId = new Map(steps.map((step) => [String(step.id), step]));
  // A consumer must not be reachable from the entry without completing its producer.
  // This also handles backward edges: the first visit must already have a value.
  const successors = new Map(
    steps.map((step, index) => [
      String(step.id),
      step.transitions === undefined
        ? [String(steps[index + 1]?.id ?? "end")]
        : Object.values(object(step.transitions, "Step transitions")).filter(
            (target): target is string => typeof target === "string",
          ),
    ]),
  );
  const canBypass = (producer: string, consumer: string): boolean => {
    const pending = steps[0] ? [String(steps[0].id)] : [];
    const seen = new Set<string>();
    while (pending.length) {
      const id = pending.pop();
      if (id === undefined || seen.has(id)) continue;
      if (id === consumer) return true;
      if (id === producer) continue;
      seen.add(id);
      pending.push(...(successors.get(id) ?? []));
    }
    return false;
  };
  for (const step of steps) {
    for (const [name, definition] of outputDefinitions(step)) {
      if (step.shell === undefined) continue;
      const shell = typeof step.shell === "string" ? {} : object(step.shell, "Shell");
      const streams = shell.outputs === undefined ? {} : object(shell.outputs, "Shell outputs");
      const field = definition.from.slice(7);
      const type =
        field === "exitCode"
          ? "number"
          : ["stdout", "stderr", "status", "summary"].includes(field)
            ? "string"
            : undefined;
      if (!type || ((field === "stdout" || field === "stderr") && streams[field] !== true))
        fail(`Output '${name}' references unavailable shell result '${field}'`);
      if (definition.type !== type && !(type === "string" && definition.type === "artifact"))
        fail(`Output '${name}' type does not match shell result '${field}'`);
    }
    const scan = (value: unknown): void => {
      if (typeof value === "string") {
        for (const expression of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
          const body = expression[1]?.trim() ?? "";
          if (
            /^steps\.[\w-]+\.outputs(?:[^\w-]|$)/.test(body) &&
            !/^steps\.[\w-]+\.outputs\.[\w-]+$/.test(body)
          )
            fail(`Invalid step output expression '${expression[0]}'`);
        }
        for (const match of value.matchAll(/\$\{\{\s*steps\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}/g)) {
          const source = byId.get(match[1] ?? "");
          if (!source || !outputDefinitions(source).has(match[2] ?? ""))
            throw new Error(`Unknown step output reference '${match[0]}'`);
          if (canBypass(String(source.id), String(step.id)))
            fail(
              `Step output reference '${match[0]}' is not available on every path to '${String(step.id)}'`,
            );
        }
      } else if (Array.isArray(value)) value.forEach(scan);
      else if (value !== null && typeof value === "object") Object.values(value).forEach(scan);
    };
    scan(step);
  }
}
