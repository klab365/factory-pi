import { expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import factory from "../src/pi-extension";
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
