import { expect, test } from "bun:test";
import type {
  EntryRenderer,
  ExtensionAPI,
  Theme,
  ToolDefinition,
  ToolRenderContext,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
import factory from "../src/pi-extension";
import { FactoryProgress } from "../src/pi-progress";

function renderers() {
  let timeline: EntryRenderer<Record<string, unknown>> | undefined;
  let tool: ToolDefinition | undefined;
  factory({
    registerEntryRenderer: (_name: string, renderer: typeof timeline) => {
      timeline = renderer;
    },
    registerTool: (definition: ToolDefinition) => {
      tool = definition;
    },
    registerCommand: () => {},
    on: () => {},
  } as unknown as ExtensionAPI);
  if (!timeline || !tool?.renderResult || !tool.renderCall) throw new Error("Renderers not registered");
  return { timeline, result: tool.renderResult, call: tool.renderCall };
}

// These renderers deliberately do not use theme or tool context.
const theme = {} as Theme;
const context = {} as ToolRenderContext;
const hints = { keyText: () => "", keyHint: () => "" };

test("collapsed timeline returns no component, so Pi adds no per-event spacer", () => {
  const { timeline } = renderers();
  for (const type of ["run", "agent", "output", "transition", "step", "completed"]) {
    const entry = {
      id: type,
      parentId: null,
      timestamp: "2026-01-01T00:00:00Z",
      type: "custom" as const,
      customType: "factory.timeline",
      data: { type, text: "\n\nInternal detail\n\n" },
    };
    expect(timeline(entry, { expanded: false, ...hints }, theme)).toBeUndefined();
    const expanded = timeline(entry, { expanded: true, ...hints }, theme);
    expect(expanded?.render(40).map((line) => line.trim())).toEqual([`Factory · ${type}`, "Internal detail"]);
  }
});

test.each([32, 80])("builder → reviewer → human output is compact at width %s", (width) => {
  const { result, call } = renderers();
  const progress = new FactoryProgress("run-42");
  const messages: string[] = [];
  const accept = (event: Record<string, unknown>) => {
    const message = progress.accept(event);
    if (message) messages.push(message);
  };
  accept({ type: "run", pipeline: "build" });
  for (const [stepId, agent, status, summary] of [
    ["Build", "builder", "completed", "\nImplemented change.\n\nTests added.\n"],
    ["Review", "reviewer", "approved", "\nNo findings.\n"],
    ["Approval", "", "approved", "approved"],
  ]) {
    accept({ type: "activity", stepId, agent, kind: agent ? "agent" : "human" });
    if (!agent) {
      accept({ type: "pending-input", prompt: "\nApprove?\n\n", choices: ["approved", "rejected"] });
      expect(progress.progress()).toContain("Respond in the Pi dialog");
    }
    accept({
      type: "step",
      stepId,
      status: "completed",
      result: {
        status,
        summary,
        ...(agent ? { checks: ["bun test: passed"], files: ["src/change.ts"] } : {}),
      },
    });
  }
  const output = (text: string) =>
    result(
      { content: [{ type: "text", text }], details: {} },
      { expanded: false, isPartial: false },
      theme,
      context,
    ).render(width);
  for (const text of [
    progress.progress(),
    progress.summary(),
    progress.interrupted(new Error("\nFailure\n\nDetails\n"), false),
    progress.interrupted(new Error("\n\n"), false),
  ]) {
    const rows = output(text);
    expect(rows.every((line) => line.trim().length > 0)).toBe(true);
    expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
  }
  expect(
    output(progress.summary())
      .map((line) => line.trim())
      .join(" "),
  ).toContain("pipeline completed");
  expect(progress.summary()).toContain("Approval: approved");
  expect(progress.summary()).toContain("Next: /factory refine run-42");
  expect(progress.interrupted(new Error("failure"), false)).toContain("/factory resume run-42");
  expect(
    call({ runId: "long-internal-id", requestId: "internal-request" }, theme, context)
      .render(width)
      .map((line) => line.trim()),
  ).toEqual(["Factory run"]);
  // Compare against the former double-newline layout, at the same terminal width.
  const oldLayout = new Text(messages.join("\n\n"), 0, 0).render(width);
  expect(output(progress.progress()).length).toBeLessThan(oldLayout.length * 0.8);
});
