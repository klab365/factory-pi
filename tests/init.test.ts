import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { initProject, setupPrompt } from "../src/init";
import { loadAgentDefinition } from "../src/agent-runtime";
import factory from "../src/pi-extension";
import { validatePipeline } from "../src/pipeline-validation";

test("Pi init and validate operate on the target project without creating a run", async () => {
  const target = mkdtempSync(resolve(tmpdir(), "factory-target-"));
  type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
  let command: Command | undefined;
  const notices: [string, string][] = [];
  const prompts: string[] = [];
  factory({
    sendUserMessage: (message: string) => prompts.push(message),
    registerTool() {},
    registerEntryRenderer() {},
    registerCommand(_name: string, definition: Command) {
      command = definition;
    },
    on() {},
  } as unknown as ExtensionAPI);
  if (!command) throw new Error("Factory command missing");
  const ctx = {
    model: { provider: "test", id: "setup-model" },
    cwd: target,
    hasUI: true,
    waitForIdle: async () => {},
    ui: {
      notify: (message: string, level: string) => notices.push([message, level]),
      select: async (_title: string, choices: string[]) => choices[0],
    },
  } as unknown as Parameters<Command["handler"]>[1];
  try {
    await command.handler("init", { ...ctx, model: undefined });
    expect(notices.at(-1)).toEqual(["Error: Select a model with /model before /factory init", "error"]);
    expect(prompts).toHaveLength(0);
    expect(existsSync(resolve(target, ".factory"))).toBe(false);
    await command.handler("init", ctx);
    expect(notices.at(-1)).toEqual([
      `Factory initialized in ${target}; project setup requested in Pi`,
      "info",
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("model test/setup-model");
    expect(prompts[0]).toContain("Ask one focused question at a time and wait for my answer");
    expect(prompts[0]).toContain("human approval step");
    expect(prompts[0]).toContain("Do not add commit/push steps or run the pipeline");
    expect(readFileSync(resolve(target, ".factory/.gitignore"), "utf8")).toBe("state/\n");
    const pipeline = resolve(target, ".factory/pipelines/hello.yml");
    const custom = 'steps:\n  - id: work\n    shell: "touch marker"\n';
    writeFileSync(pipeline, custom);
    await command.handler("init", ctx);
    expect(readFileSync(pipeline, "utf8")).toBe(custom);
    expect(prompts).toHaveLength(2);
    await command.handler("validate", ctx);
    expect(notices.at(-1)).toEqual(["Pipeline valid: hello", "info"]);
    writeFileSync(pipeline, "steps: []\n");
    await command.handler("validate hello", ctx);
    expect(notices.at(-1)?.[0]).toContain("non-empty steps array");
    expect(notices.at(-1)?.[1]).toBe("error");
    await command.handler("init", ctx);
    expect(notices.at(-1)?.[1]).toBe("error");
    expect(prompts).toHaveLength(2);
    await command.handler("init", { ...ctx, model: undefined });
    expect(notices.at(-1)).toEqual(["Error: Select a model with /model before /factory init", "error"]);
    expect(prompts).toHaveLength(2);
    expect(existsSync(resolve(target, "marker"))).toBe(false);
    expect(existsSync(resolve(target, ".factory/state"))).toBe(false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});

test("setup interviews before proposing evidence-based agents and editing approved configuration", () => {
  const prompt = setupPrompt({ provider: "test", id: "setup-model" });
  for (const guidance of [
    "Interview me first (grill-me style)",
    "Ask one focused question at a time and wait for my answer",
    "Challenge unclear assumptions",
    "Skip questions already answered",
    'Let me say "you decide"',
    "multiple specialist agents and independent review",
    "Use Plan → Builder → Verify-guard → independent Review → Human approval → Publisher as the default",
    "Treat that standard code-change pipeline as a starting point, not a constraint",
    "Derive the design from my answers, project evidence,",
    "Read that documentation before generating files",
    "Ask for my approval before editing",
    "revise the plan and ask again",
    "After approval, create the agreed project-appropriate",
    "If we choose independent review",
    "correctness, regressions, and missing tests without",
    "route findings for correction and re-review",
    "whether independent review is useful",
    "valid pipeline syntax, agent definitions, and transitions",
    "<factory-result>",
  ]) {
    expect(prompt).toContain(guidance);
  }
  expect(prompt).not.toContain("agent: builder");
  expect(prompt).not.toContain("agent: reviewer");
});

test("an agreed code-review workflow validates with distinct agents and correction routing", () => {
  const target = mkdtempSync(resolve(tmpdir(), "factory-review-setup-"));
  try {
    initProject(target);
    // One possible outcome of the interview, not a template prescribed by init.
    const example = `name: Project workflow
inputs:
  goal:
    description: What should change?
    required: true
steps:
  - id: implement
    agent: builder
    maxVisits: 3
    task: |-
      Implement and check: \${{ inputs.goal }}
      Prior review feedback: \${{ steps.review.feedback }}
    transitions:
      completed: review
  - id: review
    agent: reviewer
    maxVisits: 3
    task: Review without modifying files; return approved or changes_requested with feedback.
    transitions:
      approved: accept
      changes_requested: implement
  - id: accept
    human:
      prompt: 'Approve the reviewed change? \${{ steps.review.summary }}'
      choices: [approved, rejected]
    transitions:
      approved: end
      rejected: end
`;
    writeFileSync(resolve(target, ".factory/pipelines/feature.yml"), example);
    for (const [name, tools, instructions] of [
      ["builder", "[read, bash, edit, write]", "Implement and check. Return completed."],
      ["reviewer", "[read, bash]", "Review without modifying files. Return approved or changes_requested."],
    ]) {
      writeFileSync(
        resolve(target, `.factory/agents/${name}.md`),
        `---\nname: ${name}\ndescription: Project ${name}\nmodel: test/setup-model\ntools: ${tools}\n---\n${instructions}\nEnd with a <factory-result> JSON block with status, summary, and feedback.\n`,
      );
      expect(loadAgentDefinition(target, String(name)).model).toBe("test/setup-model");
    }
    const pipeline = validatePipeline(target, "feature");
    expect(pipeline.inputs).toEqual({ goal: { description: "What should change?", required: true } });
    expect(pipeline.steps).toEqual([
      expect.objectContaining({
        id: "implement",
        agent: "builder",
        maxVisits: 3,
        task: expect.stringContaining(`\${{ steps.review.feedback }}`),
        transitions: { completed: "review" },
      }),
      expect.objectContaining({
        id: "review",
        agent: "reviewer",
        maxVisits: 3,
        transitions: { approved: "accept", changes_requested: "implement" },
      }),
      expect.objectContaining({
        id: "accept",
        human: {
          prompt: expect.stringContaining(`\${{ steps.review.summary }}`),
          choices: ["approved", "rejected"],
        },
        transitions: { approved: "end", rejected: "end" },
      }),
    ]);
    expect(loadAgentDefinition(target, "reviewer").tools).toEqual(["read", "bash"]);
    expect(existsSync(resolve(target, ".factory/state"))).toBe(false);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
