import { expect, test } from "bun:test";
import { humanPrompt, humanResult } from "../src/human";

test("fake UI responses produce transition statuses and structured results", async () => {
  const prompt = humanPrompt({ prompt: "Approve?", choices: ["approved", "rejected"] });
  const ui = { select: async () => "approved" };
  expect(humanResult(prompt, await ui.select())).toEqual({
    status: "approved",
    summary: "approved",
    response: "approved",
  });
  expect(() => humanResult(prompt, undefined)).toThrow("cancelled");
  expect(() => humanResult(prompt, "other")).toThrow("Invalid human choice");
  expect(() => humanPrompt({ prompt: "?", choices: [] })).toThrow();
  expect(humanResult(humanPrompt({ prompt: "Feedback" }), "hello").status).toBe("completed");
});
