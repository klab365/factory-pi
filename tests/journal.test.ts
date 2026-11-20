import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createAgentRuntime } from "../src/agent-runtime";
import { appendEvent, openJournal, type DurableJournal } from "../src/journal";

const repository = resolve(import.meta.dir, "..");
const runtime = createAgentRuntime(repository, {
  steps: [
    { id: "build", agent: "builder", transitions: { completed: "review" } },
    { id: "review", agent: "reviewer", transitions: { approved: "end", changes_requested: "build" } },
  ],
});

async function fixture(check: (open: (workflow?: string) => Promise<DurableJournal>) => Promise<void>) {
  const root = mkdtempSync(resolve(tmpdir(), "factory-journal-"));
  const journals: DurableJournal[] = [];
  try {
    await check(async (workflow = "pipeline:test") => {
      const journal = await openJournal(
        root,
        workflow,
        () => ({ goal: journals.length === 0 ? "original" : "replacement" }),
        runtime,
      );
      journals.push(journal);
      return journal;
    });
  } finally {
    for (const journal of journals) await journal.harness.close(BACKGROUND_CONTEXT);
    rmSync(root, { recursive: true, force: true });
  }
}

// Exercise real durable history and agent reconfiguration without contacting a model provider.
async function turn(journal: DurableJournal, agent: string, text: string) {
  await journal.conversation.configure(runtime.agentChange(agent), BACKGROUND_CONTEXT);
  await journal.conversation.commit(
    (tx) =>
      tx.appendEntry(journal.conversation.id, {
        kind: "test.message",
        model: [{ role: "user", content: text, timestamp: Date.now() }],
      }),
    BACKGROUND_CONTEXT,
  );
}

async function messages(journal: DurableJournal) {
  return (await journal.conversation.context(BACKGROUND_CONTEXT)).messages;
}

async function complete(journal: DurableJournal) {
  await appendEvent(journal.indexConversation, "factory.run", {
    runId: journal.runId,
    conversationId: journal.conversation.id,
    workflow: "pipeline:test",
    status: "completed",
  });
}

describe("per-run durable conversations", () => {
  test("recovers the mapping even before the first step or message is recorded", async () => {
    await fixture(async (open) => {
      const first = await open();
      await first.harness.close(BACKGROUND_CONTEXT);
      const resumed = await open();
      expect(resumed.runId).toBe(first.runId);
      expect(resumed.conversation.id).toBe(first.conversation.id);
      expect(await messages(resumed)).toEqual([]);
    });
  });

  test("preserves the original root conversation for legacy resumes only", async () => {
    await fixture(async (open) => {
      const first = await open();
      await appendEvent(first.indexConversation, "factory.run", {
        runId: "legacy",
        workflow: "pipeline:legacy",
        status: "started",
        inputs: {},
      });
      await first.harness.close(BACKGROUND_CONTEXT);
      const legacy = await open("pipeline:legacy");
      expect(legacy.runId).toBe("legacy");
      expect(legacy.conversation.id).toBe(first.indexConversation.id);
      await turn(legacy, "reviewer", "legacy context");
      await legacy.harness.close(BACKGROUND_CONTEXT);
      const resumedLegacy = await open("pipeline:legacy");
      expect(resumedLegacy.conversation.id).toBe(legacy.conversation.id);
      expect((await messages(resumedLegacy)).map((message) => message.content)).toEqual(["legacy context"]);
      await resumedLegacy.harness.close(BACKGROUND_CONTEXT);
      const independent = await open("pipeline:new");
      expect(independent.conversation.id).not.toBe(legacy.conversation.id);
      expect(await messages(independent)).toEqual([]);
    });
  });

  test("does not silently replace a missing saved conversation", async () => {
    await fixture(async (open) => {
      const first = await open();
      await appendEvent(first.indexConversation, "factory.run", {
        runId: first.runId,
        conversationId: 999999,
        workflow: "pipeline:test",
        status: "started",
        inputs: first.inputs,
      });
      await first.harness.close(BACKGROUND_CONTEXT);
      await expect(open()).rejects.toThrow("for run");
      await expect(open()).rejects.toThrow("is missing");
    });
  });

  test("retains manually written run context but isolates subsequent runs from it and root history", async () => {
    await fixture(async (open) => {
      const first = await open();
      expect(first.conversation.id).not.toBe(first.indexConversation.id);
      await first.indexConversation.commit(
        (tx) =>
          tx.appendEntry(first.indexConversation.id, {
            kind: "test.old-root-message",
            model: [{ role: "user", content: "legacy secret", timestamp: Date.now() }],
          }),
        BACKGROUND_CONTEXT,
      );
      await turn(first, "builder", "builder secret");
      await turn(first, "reviewer", "review feedback");
      expect((await messages(first)).map((message) => message.content)).toEqual([
        "builder secret",
        "review feedback",
      ]);
      await complete(first);
      await first.harness.close(BACKGROUND_CONTEXT);

      const second = await open();
      expect(second.runId).not.toBe(first.runId);
      expect(second.conversation.id).not.toBe(first.conversation.id);
      expect(await messages(second)).toEqual([]);
      expect(second.completed.size).toBe(0);
      expect(second.cursor).toBeUndefined();
      await turn(second, "builder", "independent work");
      expect((await messages(second)).map((message) => message.content)).toEqual(["independent work"]);
    });
  });

  test("reopens the exact conversation with history, saved inputs, results and cursor after restart", async () => {
    await fixture(async (open) => {
      const first = await open();
      await turn(first, "builder", "unfinished run context");
      const result = { status: "completed", summary: "saved builder result" };
      await appendEvent(first.conversation, "factory.step", {
        runId: first.runId,
        key: "build:1",
        status: "completed",
        result,
      });
      const cursor = { stepId: "review", visit: 1, visits: { build: 1, review: 1 } };
      await appendEvent(first.conversation, "factory.cursor", { runId: first.runId, ...cursor });
      await first.harness.close(BACKGROUND_CONTEXT);

      const resumed = await open();
      expect(resumed.runId).toBe(first.runId);
      expect(resumed.conversation.id).toBe(first.conversation.id);
      expect(resumed.inputs).toEqual({ goal: "original" });
      expect(resumed.completed.has("build:1")).toBe(true);
      expect(resumed.results.get("build:1")).toEqual(result);
      expect(resumed.cursor).toEqual(cursor);
      await turn(resumed, "reviewer", "resumed review");
      expect((await messages(resumed)).map((message) => message.content)).toEqual([
        "unfinished run context",
        "resumed review",
      ]);
      const entries = await resumed.indexConversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
      const starts = entries.items.filter((entry) => entry.kind === "factory.run");
      expect(starts).toHaveLength(1);
      expect(starts[0].data).toMatchObject({
        runId: first.runId,
        conversationId: first.conversation.id,
      });
    });
  });

  test("isolates different pipelines while another run is still unfinished", async () => {
    await fixture(async (open) => {
      const first = await open();
      await turn(first, "builder", "private to first pipeline");
      await first.harness.close(BACKGROUND_CONTEXT);
      const other = await open("pipeline:other");
      expect(other.runId).not.toBe(first.runId);
      expect(other.conversation.id).not.toBe(first.conversation.id);
      expect(await messages(other)).toEqual([]);
      await other.harness.close(BACKGROUND_CONTEXT);
      const resumed = await open();
      expect(resumed.conversation.id).toBe(first.conversation.id);
      expect((await messages(resumed)).map((message) => message.content)).toEqual([
        "private to first pipeline",
      ]);
    });
  });
});

describe("per-agent durable conversations", () => {
  test("isolates agents, reuses revisits, and keeps run checkpoints separate", async () => {
    await fixture(async (open) => {
      const journal = await open();
      const [builder, sameBuilder, reviewer] = await Promise.all([
        journal.agentConversation("builder"),
        journal.agentConversation("builder"),
        journal.agentConversation("reviewer"),
      ]);
      expect(sameBuilder.id).toBe(builder.id);
      expect(builder.id).not.toBe(reviewer.id);
      expect(builder.id).not.toBe(journal.conversation.id);
      await turn({ ...journal, conversation: builder }, "builder", "private builder reasoning");
      await turn({ ...journal, conversation: reviewer }, "reviewer", "private reviewer reasoning");
      const revisited = await journal.agentConversation("builder");
      expect((await revisited.context(BACKGROUND_CONTEXT)).messages.map((m) => m.content)).toEqual([
        "private builder reasoning",
      ]);
      expect((await reviewer.context(BACKGROUND_CONTEXT)).messages.map((m) => m.content)).toEqual([
        "private reviewer reasoning",
      ]);
      expect(await messages(journal)).toEqual([]);
      await journal.harness.close(BACKGROUND_CONTEXT);
      const resumed = await open();
      expect((await resumed.agentConversation("builder")).id).toBe(builder.id);
      expect((await resumed.agentConversation("reviewer")).id).toBe(reviewer.id);
      expect(
        (await (await resumed.agentConversation("builder")).context(BACKGROUND_CONTEXT)).messages,
      ).toHaveLength(1);
      await complete(resumed);
      await resumed.harness.close(BACKGROUND_CONTEXT);
      const fresh = await open();
      for (const name of ["builder", "reviewer"]) {
        const agent = await fresh.agentConversation(name);
        expect(agent.id).not.toBe(builder.id);
        expect(agent.id).not.toBe(reviewer.id);
        expect((await agent.context(BACKGROUND_CONTEXT)).messages).toEqual([]);
      }
    });
  });

  test("restores exact agent IDs and history in a separate process", async () => {
    const root = mkdtempSync(resolve(tmpdir(), "factory-agent-restart-"));
    try {
      const journal = await openJournal(root, "pipeline:test", () => ({}), runtime);
      const builder = await journal.agentConversation("builder");
      await turn({ ...journal, conversation: builder }, "builder", "survives process restart");
      await journal.harness.close(BACKGROUND_CONTEXT);
      const script = `
        import { openJournal } from ${JSON.stringify(resolve(repository, "src/journal.ts"))};
        import { createAgentRuntime } from ${JSON.stringify(resolve(repository, "src/agent-runtime.ts"))};
        import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
        const runtime = createAgentRuntime(${JSON.stringify(repository)}, { steps: [] });
        const journal = await openJournal(${JSON.stringify(root)}, "pipeline:test", () => ({}), runtime);
        const agent = await journal.agentConversation("builder");
        console.log(JSON.stringify({ id: agent.id, messages: (await agent.context(BACKGROUND_CONTEXT)).messages }));
        await journal.harness.close(BACKGROUND_CONTEXT);
      `;
      const process = Bun.spawn(["bun", "-e", script], { cwd: repository, stdout: "pipe", stderr: "pipe" });
      const output = await new Response(process.stdout).text();
      const errors = await new Response(process.stderr).text();
      expect(await process.exited, errors).toBe(0);
      const saved = JSON.parse(output.trim().split("\n").at(-1) ?? "");
      expect(saved.id).toBe(builder.id);
      expect(saved.messages.map((m: { content: string }) => m.content)).toEqual(["survives process restart"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("agent creation and mapping roll back together on failure", async () => {
  await fixture(async (open) => {
    const journal = await open();
    const conversations = () =>
      journal.conversation.commit((tx) => tx.scanConversations({}, 500), BACKGROUND_CONTEXT);
    const before = await conversations();
    const original = journal.conversation.commit.bind(journal.conversation);
    const injected = spyOn(journal.conversation, "commit").mockImplementationOnce((callback, context) =>
      original(async (tx) => {
        await callback(tx);
        throw new Error("injected mapping failure");
      }, context),
    );
    try {
      await expect(journal.agentConversation("builder")).rejects.toThrow("injected mapping failure");
    } finally {
      injected.mockRestore();
    }
    expect((await conversations()).items).toEqual(before.items);
    expect(
      (await journal.conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT)).items.filter(
        (entry) => entry.kind === "factory.agent",
      ),
    ).toEqual([]);
    const builder = await journal.agentConversation("builder");
    await journal.harness.close(BACKGROUND_CONTEXT);
    const resumed = await open();
    expect((await resumed.agentConversation("builder")).id).toBe(builder.id);
    const mappings = (
      await resumed.conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT)
    ).items.filter((entry) => entry.kind === "factory.agent");
    expect(mappings).toHaveLength(1);
    expect(mappings[0].data).toMatchObject({
      runId: journal.runId,
      agentName: "builder",
      conversationId: builder.id,
    });
  });
});

test("missing saved agent history is an error, not a fresh conversation", async () => {
  await fixture(async (open) => {
    const journal = await open();
    await appendEvent(journal.conversation, "factory.agent", {
      runId: journal.runId,
      agentName: "builder",
      conversationId: 999999,
    });
    await journal.harness.close(BACKGROUND_CONTEXT);
    await expect(open()).rejects.toThrow("for agent 'builder'");
  });
});

test.each([false, true])(
  "resumes an admitted pre-isolation turn and its handoff tree (root=%s)",
  async (legacyRoot) => {
    // A deterministic stand-in for a model turn paused after a handoff. The task
    // resumes from its persisted child and settles the original input, without a
    // provider call. Neither task nor child may be replaced during migration.
    const { defineTask, defineExtension, AssistantEntry } = await import("@earendil-works/pi-durable");
    type Input = { requestId: string };
    let executions = 0;
    const parent = defineTask<Input, { phase: "finish" }, null>({
      name: `test.legacy-handoff-${legacyRoot}`,
      version: 1,
      initial: () => ({ phase: "finish" }),
      phases: {
        async finish(task, api, context) {
          executions++;
          await api.commit(async (tx) => {
            const input = await tx.submissionByRequest(task.conversationId, task.input.requestId);
            const child = (await tx.scanConversations({ ownerTaskId: task.id }, 1)).items[0];
            if (!input || !child) throw new Error("Original input or handoff was lost");
            const review = await tx.submissionByRequest(child.id, "handoff-review");
            if (review?.status !== "done") throw new Error("Original child result was lost");
            const answer = await tx.appendEntry(AssistantEntry, task.conversationId, {
              model: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "text",
                      text: '<factory-result>{"status":"completed","summary":"original handoff consumed"}</factory-result>',
                    },
                  ],
                  timestamp: Date.now(),
                },
              ],
            });
            tx.settleSubmission(input.id, { status: "done", answer: answer.id });
            return { status: "terminal", outcome: { status: "completed", result: null } };
          }, context);
        },
      },
      async abort(_task, api, context) {
        await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
      },
    });
    runtime.registry.install(defineExtension({ name: `test.legacy-${legacyRoot}`, tasks: [parent] }));
    await fixture(async (open) => {
      const initial = await open();
      let first = initial;
      if (legacyRoot) {
        await appendEvent(initial.indexConversation, "factory.run", {
          runId: "legacy-handoff",
          workflow: "pipeline:legacy",
          status: "started",
          inputs: {},
        });
        await initial.harness.close(BACKGROUND_CONTEXT);
        first = await open("pipeline:legacy");
      }
      const requestId = `factory-${first.runId}-build-1`;
      const saved = await first.conversation.commit(async (tx) => {
        const entry = await tx.appendEntry(first.conversation.id, { kind: "test.original-input" });
        const input = await tx.createSubmission({
          type: "input",
          status: "placed",
          conversationId: first.conversation.id,
          requestId,
          entry: entry.id,
        });
        const taskId = await tx.createTask(parent, { requestId }, { ownership: { kind: "conversation" } });
        const child = await tx.createConversation({ ownership: { kind: "task", taskId } });
        const childEntry = await tx.appendEntry(child.id, { kind: "test.review-input" });
        const childAnswer = await tx.appendEntry(AssistantEntry, child.id, {
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: '<factory-result>{"status":"approved"}</factory-result>' }],
              timestamp: Date.now(),
            },
          ],
        });
        const childInput = await tx.createSubmission({
          type: "input",
          status: "done",
          conversationId: child.id,
          requestId: "handoff-review",
          entry: childEntry.id,
          answer: childAnswer.id,
        });
        return { inputId: input.id, taskId, childId: child.id, childInputId: childInput.id };
      }, BACKGROUND_CONTEXT);
      await first.harness.close(BACKGROUND_CONTEXT);

      const resumed = await open(legacyRoot ? "pipeline:legacy" : "pipeline:test");
      const configure = spyOn(resumed.conversation, "configure");
      try {
        const result = await resumed.runAgent("builder", "same task", requestId);
        expect(result).toEqual({ status: "completed", summary: "original handoff consumed" });
        // Replaying after settlement must consume the same answer too.
        expect(await resumed.runAgent("builder", "same task", requestId)).toEqual(result);
        expect(configure).not.toHaveBeenCalled();
      } finally {
        configure.mockRestore();
      }
      expect(executions).toBe(1);
      const state = await resumed.conversation.commit(
        async (tx) => ({
          input: await tx.submissionByRequest(resumed.conversation.id, requestId),
          children: await tx.scanConversations({ ownerTaskId: saved.taskId }, 500),
          childInput: await tx.submissionByRequest(saved.childId, "handoff-review"),
          conversations: await tx.scanConversations({}, 500),
        }),
        BACKGROUND_CONTEXT,
      );
      expect(state.input?.id).toBe(saved.inputId);
      expect(state.input?.status).toBe("done");
      expect(state.children.items.map((child) => child.id)).toEqual([saved.childId]);
      expect(state.childInput?.id).toBe(saved.childInputId);
      expect(state.conversations.items).toHaveLength(3);
      const entries = await resumed.conversation.entries({}, 500, undefined, BACKGROUND_CONTEXT);
      expect(entries.items.filter((entry) => entry.kind === "factory.agent")).toEqual([]);
      // Subsequent visits use a fresh, isolated agent history, not the old run transcript.
      const fresh = await resumed.agentConversation("builder");
      expect(fresh.id).not.toBe(resumed.conversation.id);
      expect((await fresh.context(BACKGROUND_CONTEXT)).messages).toEqual([]);
    });
  },
);

test("orchestrator routes new visits to their isolated, reusable agent conversations", async () => {
  await fixture(async (open) => {
    const journal = await open();
    const calls: { agent: string; id: number; task: string }[] = [];
    const run = spyOn(runtime, "runAgent").mockImplementation(async (conversation, agent, task) => {
      calls.push({ agent, id: conversation.id, task });
      return { status: "completed", feedback: "structured feedback" };
    });
    try {
      await journal.runAgent("builder", "goal", "build-1");
      const review = await journal.runAgent("reviewer", "review goal", "review-1");
      await journal.runAgent("builder", String(review.feedback), "build-2");
    } finally {
      run.mockRestore();
    }
    expect(calls[0]?.id).toBe(calls[2]?.id);
    expect(calls[0]?.id).not.toBe(calls[1]?.id);
    expect(calls.every((call) => call.id !== journal.conversation.id)).toBe(true);
    expect(calls[2]?.task).toBe("structured feedback");
  });
});
