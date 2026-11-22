import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import factory from "../src/pi-extension";

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
    expect(prompts[0]).toContain(`\${{ inputs.goal }}`);
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
