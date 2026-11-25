import { createInterface } from "node:readline/promises";
import { object, string } from "./pipeline-inputs";
import type { HumanHandler } from "./runner";

function diagnostic(stage: string): void {
  process.stdout.write(`${JSON.stringify({ type: "diagnostic", stage })}\n`);
}

try {
  diagnostic("worker:started");
  const lines = createInterface({ input: process.stdin });
  const iterator = lines[Symbol.asyncIterator]();
  const first = await iterator.next();
  diagnostic(first.done ? "worker:request-eof" : "worker:request-read");
  const request = object(JSON.parse(first.value ?? "null"), "Session request");
  diagnostic("worker:request-parsed");
  const requestHuman: HumanHandler = async (_prompt, key) => {
    const next = await iterator.next();
    if (next.done) return undefined;
    const response = object(JSON.parse(next.value), "Human response");
    if (response.key !== key) throw new Error("Human response does not match pending input");
    return response.response;
  };
  console.log = (...values) => console.error(...values);
  try {
    diagnostic("worker:runner-import-started");
    const { runPipeline } = await import("./runner");
    diagnostic("worker:runner-import-completed");
    diagnostic("worker:run-pipeline-started");
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
      requestHuman,
    );
    diagnostic("worker:run-pipeline-completed");
  } finally {
    lines.close();
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
