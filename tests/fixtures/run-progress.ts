import { spyOn } from "bun:test";
import { appendFileSync } from "node:fs";
import * as agentRuntime from "../../src/agent-runtime";
import { FactoryProgress } from "../../src/pi-progress";
import { runPipeline } from "../../src/runner";

const flags = Bun.argv.slice(2);
const createRuntime = agentRuntime.createAgentRuntime;
spyOn(agentRuntime, "createAgentRuntime").mockImplementation((...parameters) => {
  const runtime = createRuntime(...parameters);
  runtime.runAgent = async (_conversation, agent, task) => {
    appendFileSync("agent-visits", `${agent}: ${task}\n`);
    if (agent === "reviewer" && flags.includes("--fail-review")) throw new Error("Review interrupted");
    return {
      status: agent === "reviewer" ? "approved" : "completed",
      summary: `${agent} changes: ${task}`,
      checks: [`${agent} checks: ${task}: passed`],
      files: [`${agent}-${task}.ts`],
    };
  };
  return runtime;
});
const progress = new FactoryProgress("progress-run");
try {
  await runPipeline(
    "test",
    flags.includes("--new") ? ["--goal=initial"] : [],
    {
      mode: flags.includes("--new") ? "new" : flags.includes("--refine") ? "refine" : "resume",
      runId: "progress-run",
      ...(flags.includes("--refine") ? { instruction: "updated", requestId: "round-two" } : {}),
    },
    (event) => progress.accept(event),
    async () => (flags.includes("--approve") ? "approved" : undefined),
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
console.log(progress.summary());
