import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

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

describe("handoff results and replay", () => {
  const root = `${import.meta.dir}/..`;
  const pipeline = parse(readFileSync(`${root}/.factory/pipelines/software-factory.yml`, "utf8"));

  function setup(text: string) {
    const runtime = createAgentRuntime(root, pipeline);
    const tool = runtime
      .agentChange("builder")
      .tools?.find((tool) => tool.name === "handoff_builder_to_reviewer");
    if (!tool) throw new Error("Missing handoff tool");
    const requestIds: string[] = [];
    // An existing owned child is what a replay sees after the creation commit.
    const tx = {
      scanConversations: async () => ({ items: [{ id: "child" }] }),
      createConversation: async () => {
        throw new Error("Replay must reuse the child");
      },
      entry: async () => ({ model: [{ content: [{ type: "text", text }] }] }),
    };
    const api = {
      taskId: "handoff-task",
      commit: async (callback: (tx: object) => unknown) => callback(tx),
      details: async () => {},
      conversation: async () => ({
        submit: async ({ requestId }: { requestId: string }) => {
          requestIds.push(requestId);
          return { wait: async () => ({ status: "done", type: "input", answer: "answer" }) };
        },
      }),
    } as unknown as Parameters<typeof tool.execute>[1];
    return { tool, api, requestIds };
  }

  test("reuses its owned child and stable submission id on replay", async () => {
    const { tool, api, requestIds } = setup('<factory-result>{"status":"approved"}</factory-result>');
    expect(tool.replay).toBe("safe");
    for (let i = 0; i < 2; i++) {
      await tool.execute({ task: "Review" }, api, BACKGROUND_CONTEXT);
    }
    expect(requestIds).toEqual(["handoff-handoff-task", "handoff-handoff-task"]);
  });

  test.each([
    ["No structured result", "did not return"],
    ['<factory-result>{"status":"completed"}</factory-result>', "undeclared status"],
    ['<factory-result>{"status":42}</factory-result>', "invalid factory result"],
  ])("rejects invalid child answers: %s", async (text, error) => {
    const { tool, api } = setup(text);
    await expect(tool.execute({ task: "Review" }, api, BACKGROUND_CONTEXT)).rejects.toThrow(error);
  });
});
