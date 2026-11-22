import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { createAgentRuntime, loadAgentDefinition } from "../src/agent-runtime";

describe("durable agent transitions", () => {
  test("loads the repository workflow skills only for their configured agents", () => {
    const root = `${import.meta.dir}/..`;
    const pipeline = parse(readFileSync(`${root}/.factory/pipelines/software-factory.yml`, "utf8"));
    const runtime = createAgentRuntime(root, pipeline);
    const expected = {
      builder: ["typescript-expert", "systematic-debugging", "verification-before-completion"],
      reviewer: ["code-review", "verification-before-completion"],
    };
    for (const [agent, names] of Object.entries(expected)) {
      const definition = loadAgentDefinition(root, agent);
      expect(definition.skills.map((skill) => skill.name)).toEqual(names);
      const instructions = runtime.agentChange(agent).instructions ?? "";
      let previous = -1;
      for (const skill of definition.skills) {
        const position = instructions.indexOf(`## Skill: ${skill.name}\n`);
        expect(position).toBeGreaterThan(previous);
        expect(instructions).toContain(skill.content);
        previous = position;
      }
      expect(instructions.includes("## Skill: systematic-debugging\n")).toBe(agent === "builder");
      expect(instructions.includes("## Skill: typescript-expert\n")).toBe(agent === "builder");
      expect(instructions.includes("## Skill: code-review\n")).toBe(agent === "reviewer");
    }
  });

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
    expect(pipeline.steps[1].transitions).toEqual({ approved: "accept", changes_requested: "implement" });
  });
});

describe("handoff results and replay", () => {
  const root = `${import.meta.dir}/..`;
  const pipeline = parse(readFileSync(`${root}/.factory/pipelines/software-factory.yml`, "utf8"));

  const approved = '<factory-result>{"status":"approved"}</factory-result>';

  function setup(text: string, correction = text, settledStatus = "done") {
    const runtime = createAgentRuntime(root, pipeline);
    const tool = runtime
      .agentChange("builder")
      .tools?.find((tool) => tool.name === "handoff_builder_to_reviewer");
    if (!tool) throw new Error("Missing handoff tool");
    const requests: { requestId: string; content: string }[] = [];
    const submitted = new Set<string>();
    let configurations = 0;
    // An existing owned child is what a replay sees after the creation commit.
    const tx = {
      scanConversations: async () => ({ items: [{ id: "child" }] }),
      createConversation: async () => {
        throw new Error("Replay must reuse the child");
      },
      submissionByRequest: async (_id: string, requestId: string) => submitted.has(requestId),
      entry: async (_type: unknown, answer: string) => ({
        model: [{ content: [{ type: "text", text: answer }] }],
      }),
    };
    const child = {
      id: "child",
      configure: async () => {
        configurations++;
      },
      commit: async (callback: (tx: object) => unknown) => callback(tx),
      submit: async (request: { requestId: string; content: string }) => {
        requests.push(request);
        submitted.add(request.requestId);
        const answer = request.requestId.endsWith(":factory-result-repair") ? correction : text;
        return { wait: async () => ({ status: settledStatus, type: "input", answer }) };
      },
    };
    const api = {
      taskId: "handoff-task",
      commit: async (callback: (tx: object) => unknown) => callback(tx),
      details: async () => {},
      conversation: async () => child,
    } as unknown as Parameters<typeof tool.execute>[1];
    return {
      tool,
      api,
      requests,
      configurations: () => configurations,
      run: () =>
        runtime.runAgent(
          child as unknown as Parameters<typeof runtime.runAgent>[0],
          "reviewer",
          "Review",
          "step-1",
        ),
    };
  }

  test("reuses its owned child and stable submission id on replay", async () => {
    const { tool, api, requests } = setup(approved);
    expect(tool.replay).toBe("safe");
    for (let i = 0; i < 2; i++) {
      await tool.execute({ task: "Review" }, api, BACKGROUND_CONTEXT);
    }
    expect(requests.map(({ requestId }) => requestId)).toEqual([
      "handoff-handoff-task",
      "handoff-handoff-task",
    ]);
  });

  test.each([
    ["No structured result", "did not return"],
    ['<factory-result>{"status":"completed"}</factory-result>', "undeclared status"],
    ['<factory-result>{"status":42}</factory-result>', "invalid factory result"],
    ['<factory-result>{"status":}</factory-result>', "invalid JSON"],
  ])("requests a correction for invalid agent answers: %s", async (text, error) => {
    const { run, requests, configurations } = setup(text, approved);
    for (let i = 0; i < 2; i++) {
      expect(await run()).toEqual({ status: "approved" });
    }
    expect(configurations()).toBe(1);
    expect(requests.map(({ requestId }) => requestId)).toEqual([
      "step-1",
      "step-1:factory-result-repair",
      "step-1",
      "step-1:factory-result-repair",
    ]);
    expect(requests[1].content).toContain(error);
    expect(requests[1].content).toContain("approved, changes_requested");
  });

  test("returns the corrected result from a handoff", async () => {
    const { tool, api, requests } = setup("No structured result", approved);
    const result = await tool.execute({ task: "Review" }, api, BACKGROUND_CONTEXT);
    expect(result).toEqual({ output: [{ type: "text", text: approved }] });
    expect(requests.map(({ requestId }) => requestId)).toEqual([
      "handoff-handoff-task",
      "handoff-handoff-task:factory-result-repair",
    ]);
  });

  test("stops after one correction request with the last validation error", async () => {
    const { run, requests } = setup("No structured result", '<factory-result>{"status":}</factory-result>');
    await expect(run()).rejects.toThrow("invalid JSON in <factory-result> after one correction request");
    expect(requests).toHaveLength(2);
  });

  test("does not ask for a correction when the turn fails", async () => {
    const { run, requests } = setup("No structured result", approved, "failed");
    await expect(run()).rejects.toThrow("did not complete: failed");
    expect(requests).toHaveLength(1);
  });
});
