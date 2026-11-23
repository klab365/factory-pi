import { expect, test } from "bun:test";
import { FactoryProgress } from "../src/pi-progress";

test("builder, correction review and human approval produce readable progress and one evidence-based conclusion", () => {
  const progress = new FactoryProgress("run-35");
  const activity = (stepId: string, name: string, agent: string, visit = 1) =>
    progress.accept({ type: "activity", stepId, name, agent, kind: "agent", visit });
  const complete = (stepId: string, result: Record<string, unknown>) =>
    progress.accept({ type: "step", stepId, status: "completed", result });
  activity("implement", "Implement change", "builder");
  complete("implement", { status: "completed", summary: "Added output.", files: ["src/pi-progress.ts"] });
  activity("review", "Review change", "reviewer");
  expect(complete("review", { status: "changes_requested", feedback: "Add cancellation tests." })).toContain(
    "Corrections requested",
  );
  expect(activity("implement", "Implement change", "builder", 2)).toContain("attempt 2");
  complete("implement", {
    status: "completed",
    summary: "Added output and cancellation tests.",
    checks: ["bun test: passed"],
    files: ["src/pi-progress.ts", "tests/pi-progress.test.ts"],
  });
  activity("review", "Review change", "reviewer", 2);
  complete("review", {
    status: "approved",
    summary: "No findings.",
    prVerification: "bun run check: passed",
  });
  progress.accept({ type: "activity", stepId: "accept", name: "Human approval", kind: "human" });
  const waiting = progress.accept({
    type: "pending-input",
    stepId: "accept",
    prompt: "Approve?",
    choices: ["approved", "rejected"],
  });
  expect(waiting).toContain("Waiting for your response");
  expect(waiting).toContain("Choose: approved, rejected");
  expect(waiting).toContain("/factory resume run-35");
  complete("accept", { status: "approved", summary: "approved" });
  expect(progress.accept({ type: "completed" })).toBeUndefined();
  const summary = progress.summary();
  expect(summary).toContain("pipeline completed");
  expect(summary).toContain("Added output and cancellation tests");
  expect(summary).toContain("bun test: passed");
  expect(summary).toContain("bun run check: passed");
  expect(summary).toContain("Review change: approved");
  expect(summary).toContain("Human approval: approved");
  expect(summary).toContain("tests/pi-progress.test.ts");
  expect(summary).not.toContain("changes_requested");
  expect(progress.progress()).toContain("Add cancellation tests.");
});

test("technical events are silent, replayed results are summarized, and missing evidence is explicit", () => {
  const progress = new FactoryProgress("run");
  for (const type of ["transition", "agent", "output"]) {
    expect(progress.accept({ type, text: "raw output" })).toBeUndefined();
  }
  const event = {
    type: "step",
    stepId: "work",
    status: "completed",
    replayed: true,
    result: { status: "completed", summary: "Saved work" },
  };
  const before = JSON.stringify(event);
  progress.accept(event);
  expect(JSON.stringify(event)).toBe(before);
  expect(progress.summary()).toContain("Saved work");
  expect(progress.summary()).toContain("No separate check results reported");
  expect(progress.summary()).toContain("No file paths reported");
  expect(progress.summary()).toContain("No review or human decision reported");
  expect(
    progress.accept({ type: "step", stepId: "invalid", status: "completed", result: ["bad"] }),
  ).toBeDefined();
});

test("saved results hydrate summary evidence silently without changing current activity", () => {
  const progress = new FactoryProgress("run");
  progress.accept({ type: "activity", stepId: "accept", name: "Approval", kind: "human" });
  const event = {
    type: "saved-result",
    stepId: "review",
    name: "Review",
    kind: "agent",
    agent: "reviewer",
    result: { status: "approved", summary: "Saved review", checks: ["tests passed"], files: ["src/file.ts"] },
  };
  const before = JSON.stringify(event);
  const output = progress.progress();
  expect(progress.accept(event)).toBeUndefined();
  expect(progress.progress()).toBe(output);
  expect(JSON.stringify(event)).toBe(before);
  expect(progress.summary()).toContain("Saved review");
  expect(progress.summary()).toContain("tests passed");
  expect(progress.summary()).toContain("src/file.ts");
  expect(progress.interrupted(new Error("Stopped"), true)).toContain("at Approval");
});

test("failure, cancellation and dismissed human checkpoints explain the next action", () => {
  const progress = new FactoryProgress("run");
  progress.accept({ type: "activity", stepId: "test", name: "Run tests", kind: "shell" });
  expect(progress.interrupted(new Error("exit code 1"), false)).toContain("failed at Run tests");
  expect(progress.interrupted(new Error("exit code 1"), false)).toContain("exit code 1");
  expect(progress.interrupted(new Error("Stopped"), true)).toContain("cancelled at Run tests");
  progress.accept({ type: "pending-input", prompt: "Approve?" });
  const message = progress.interrupted(new Error("Human input cancelled"), false);
  expect(message).toContain("waiting for human input");
  expect(message).toContain("/factory resume run");
});
