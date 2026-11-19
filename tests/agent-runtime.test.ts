import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { createAgentRuntime } from "../src/agent-runtime";

describe("durable agent transitions", () => {
  test("exposes handoff tools only for transitions declared in YAML", () => {
    const root = `${import.meta.dir}/..`;
    const pipeline = parse(readFileSync(`${root}/.factory/pipelines/software-factory.yml`, "utf8"));
    const runtime = createAgentRuntime(root, pipeline);
    const toolNames = (agent: string) => (runtime.agentChange(agent).tools ?? []).map((tool) => tool.name);

    expect(toolNames("builder")).toContain("handoff_builder_to_reviewer");
    expect(toolNames("builder")).not.toContain("handoff_reviewer_to_builder");
    expect(toolNames("reviewer")).toContain("handoff_reviewer_to_builder");
    expect(toolNames("reviewer")).not.toContain("handoff_builder_to_reviewer");
    expect(runtime.agentChange("reviewer").instructions).toContain("approved, changes_requested");
    expect(pipeline.steps[1].transitions).toEqual({ approved: "end", changes_requested: "implement" });
  });
});
