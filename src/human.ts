import { object, string, type RecordValue } from "./pipeline-inputs";

export type HumanPrompt = { prompt: string; choices?: string[] };
export function humanPrompt(raw: unknown): HumanPrompt {
  const value = object(raw, "Human step");
  const prompt = string(value.prompt, "Human prompt");
  if (value.choices === undefined) return { prompt };
  if (!Array.isArray(value.choices) || !value.choices.length)
    throw new Error("Human choices must be a non-empty list");
  const choices = value.choices.map((choice) => string(choice, "Human choice"));
  if (new Set(choices).size !== choices.length) throw new Error("Duplicate human choices");
  return { prompt, choices };
}
export function humanResult(prompt: HumanPrompt, response: unknown): RecordValue {
  if (response === undefined) throw new Error("Human input cancelled or missing; resume to respond");
  const value = string(response, "Human response");
  if (prompt.choices && !prompt.choices.includes(value)) throw new Error("Invalid human choice");
  return { status: prompt.choices ? value : "completed", summary: value, response: value };
}
