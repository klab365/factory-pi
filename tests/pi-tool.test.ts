import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import factory from "../src/pi-extension";
import { stringify } from "yaml";
import { readRuns, saveRun, type Run } from "../src/pi-session";

test("Factory tool validates session and pending IDs, streams events, rejects duplicates and preserves cancellation", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-tool-"));
  let tool: ToolDefinition | undefined;
  const entries: unknown[] = [];
  factory({
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
    registerEntryRenderer: () => {},
    registerCommand: () => {},
    on: () => {},
    appendEntry: (_type: string, data: unknown) => entries.push(data),
  } as unknown as ExtensionAPI);
  if (!tool) throw new Error("Tool not registered");
  const registeredTool = tool;
  const ctx = {
    cwd: root,
    sessionManager: { getSessionFile: () => "/native.jsonl" },
    ui: { setStatus: () => {}, notify: () => {} },
  } as unknown as ExtensionToolContext;
  const request = { mode: "new" as const, runId: "run", pipeline: "test", requestId: "request" };
  const run: Run = {
    runId: "run",
    pipeline: "test",
    sessionFile: "/native.jsonl",
    status: "started",
    pending: request,
  };
  const invoke = (
    runId = "run",
    requestId = "request",
    signal?: AbortSignal,
    update?: (value: unknown) => void,
  ) => registeredTool.execute("call", { runId, requestId }, signal, update, ctx);
  try {
    saveRun(root, run);
    await expect(invoke("other")).rejects.toThrow("current Pi session");
    saveRun(root, { ...run, sessionFile: "/other.jsonl" });
    await expect(invoke()).rejects.toThrow("current Pi session");
    saveRun(root, run);
    await expect(invoke("run", "stale")).rejects.toThrow("pending");
    saveRun(root, { ...run, pending: { ...request, runId: "other" } });
    await expect(invoke()).rejects.toThrow("pending");
    saveRun(root, { ...run, pending: undefined });
    await expect(invoke()).rejects.toThrow("pending");
    expect(entries).toHaveLength(0);
    mkdirSync(resolve(root, ".factory/pipelines"), { recursive: true });
    writeFileSync(
      resolve(root, ".factory/pipelines/test.yml"),
      "steps:\n  - id: work\n    shell: sleep 10\n",
    );
    saveRun(root, run);
    const controller = new AbortController();
    const updates: unknown[] = [];
    let started!: () => void;
    const progress = new Promise<void>((done) => {
      started = done;
    });
    const running = invoke("run", "request", controller.signal, (value) => {
      updates.push(value);
      started();
    });
    await progress;
    await expect(invoke()).rejects.toThrow("already active");
    controller.abort(new Error("test cancellation"));
    await expect(running).rejects.toThrow("test cancellation");
    expect(updates.length).toBeGreaterThan(0);
    expect(JSON.stringify(updates)).toContain('"type":"text"');
    expect(JSON.stringify(updates)).toContain('"runId":"run"');
    expect(readRuns(root)[0].pending).toEqual(request);
    expect(readRuns(root)[0].status).toBe("started");
    expect(JSON.stringify(entries)).toContain("interrupted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 15000);

test.each([true, false])(
  "human dialog stays compact with long checkpoint details (choices: %s)",
  async (choices) => {
    const root = mkdtempSync(resolve(tmpdir(), "factory-compact-human-"));
    let tool: ToolDefinition | undefined;
    const entries: unknown[] = [];
    const updates: unknown[] = [];
    const prompt = `Approve the reviewed changes?\n\n${"Review details and verification results.\n".repeat(150)}Last important detail.`;
    const runId = "compact-human";
    factory({
      registerTool: (definition: ToolDefinition) => {
        tool = definition;
      },
      registerEntryRenderer: () => {},
      registerCommand: () => {},
      on: () => {},
      appendEntry: (_type: string, data: unknown) => entries.push(data),
    } as unknown as ExtensionAPI);
    const showDialog = async (title: string) => {
      expect(title.length).toBeLessThan(80);
      expect(title).not.toContain("\n");
      expect(title).toContain("output above");
      // Details must already be available when the dialog takes over the editor.
      expect(JSON.stringify(updates)).toContain("Last important detail.");
      expect(JSON.stringify(entries)).toContain(JSON.stringify(prompt).slice(1, -1));
      return "approved";
    };
    const ctx = {
      cwd: root,
      hasUI: true,
      sessionManager: { getSessionFile: () => "/compact.jsonl" },
      ui: {
        setStatus: () => {},
        notify: () => {},
        select: async (title: string, options: string[]) => {
          expect(options).toEqual(["approved", "rejected"]);
          return showDialog(title);
        },
        input: showDialog,
      },
    } as unknown as ExtensionToolContext;
    try {
      mkdirSync(resolve(root, ".factory/pipelines"), { recursive: true });
      writeFileSync(
        resolve(root, ".factory/pipelines/test.yml"),
        stringify({
          steps: [
            { id: "approve", human: { prompt, ...(choices ? { choices: ["approved", "rejected"] } : {}) } },
          ],
        }),
      );
      saveRun(root, {
        runId,
        pipeline: "test",
        sessionFile: "/compact.jsonl",
        status: "started",
        pending: { mode: "new", runId, pipeline: "test", requestId: "request" },
      });
      if (!tool) throw new Error("Tool not registered");
      const result = await tool.execute(
        "call",
        { runId, requestId: "request" },
        undefined,
        (value) => updates.push(value),
        ctx,
      );
      expect(JSON.stringify(result)).toContain("pipeline completed");
      expect(readRuns(root)[0].status).toBe("completed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
