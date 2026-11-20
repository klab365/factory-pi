import { existsSync, readFileSync } from "node:fs";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { parse } from "yaml";
export type RecordValue = Record<string, unknown>;
const root = process.cwd();
export const fail = (message: string): never => {
  throw new Error(message);
};
export const object = (value: unknown, label: string): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be a mapping`);
  return value as RecordValue;
};
export const string = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value.trim()) fail(`${label} must be a non-empty string`);
  return value as string;
};

export function loadYaml(path: string): RecordValue {
  if (!existsSync(path)) fail(`File not found: ${relative(root, path)}`);
  return object(parse(readFileSync(path, "utf8")), relative(root, path));
}
export function factoryFile(folder: string, name: string, extension: string): string {
  const path = resolve(root, ".factory", folder, `${name}.${extension}`);
  const fromFactory = relative(resolve(root, ".factory", folder), path);
  if (isAbsolute(fromFactory) || fromFactory === ".." || fromFactory.startsWith(`..${sep}`)) {
    fail(`Invalid ${folder.slice(0, -1)} name: ${name}`);
  }
  return path;
}

export function collectInputs(
  pipeline: RecordValue,
  args: string[],
  requireValues = true,
): Record<string, string> {
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

  if (!requireValues) return supplied;

  const values: Record<string, string> = {};
  for (const [name, raw] of Object.entries(definitions)) {
    const definition = object(raw, `Input '${name}'`);
    let value = supplied[name] ?? (definition.default === undefined ? undefined : String(definition.default));
    const required = definition.required !== false;
    if (!required && value === undefined) continue;
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
