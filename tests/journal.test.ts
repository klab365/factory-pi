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

test("explicit new/resume/refine preserve exact agent conversations and isolate a new run", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-explicit-"));
  let journal: DurableJournal | undefined;
  const open = async (selection: Parameters<typeof openJournal>[4]) => {
    await journal?.harness.close(BACKGROUND_CONTEXT);
    journal = await openJournal(root, "pipeline:test", () => ({ goal: "original" }), runtime, selection);
    return journal;
  };
  try {
    const first = await open({ mode: "new", runId: "first" });
    const builderId = (await first.agentConversation("builder")).id;
    const reviewerId = (await first.agentConversation("reviewer")).id;
    const second = await open({ mode: "new", runId: "second" });
    expect((await second.agentConversation("builder")).id).not.toBe(builderId);
    const resumed = await open({ mode: "resume", runId: "first" });
    expect((await resumed.agentConversation("builder")).id).toBe(builderId);
    await complete(resumed);
    const refined = await open({
      mode: "refine",
      runId: "first",
      instruction: "also tests",
      requestId: "refinement",
    });
    expect(refined.round).toBe(2);
    expect(refined.inputs.goal).toContain("original");
    expect(refined.inputs.goal).toContain("also tests");
    expect(refined.cursor).toBeUndefined();
    expect((await refined.agentConversation("builder")).id).toBe(builderId);
    expect((await refined.agentConversation("reviewer")).id).toBe(reviewerId);
    const retry = await open({
      mode: "refine",
      runId: "first",
      instruction: "also tests",
      requestId: "refinement",
    });
    expect(retry.round).toBe(2);
    const again = await open({ mode: "resume", runId: "first" });
    expect(again.round).toBe(2);
    expect((await again.agentConversation("builder")).id).toBe(builderId);
  } finally {
    await journal?.harness.close(BACKGROUND_CONTEXT);
    rmSync(root, { recursive: true, force: true });
  }
});

test.each([false, true])(
  "a fresh run never recovers another run's in-flight agent/handoff tasks (legacy root=%s)",
  async (legacyRoot) => {
    const { defineTask, defineExtension } = await import("@earendil-works/pi-durable");
    let attempts = 0;
    let finish = false;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const child = defineTask<null, { phase: "work" }, null>({
      name: `test.interrupted-child-${legacyRoot}`,
      version: 1,
      initial: () => ({ phase: "work" }),
      phases: {
        async work(_task, api, context) {
          attempts++;
          started();
          if (!finish)
            await new Promise<void>((_resolve, reject) => {
              api.signal.addEventListener("abort", () => reject(api.signal.reason), { once: true });
            });
          await api.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
        },
      },
      async abort(_task, api, context) {
        await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
      },
    });
    const parent = defineTask<null, { phase: "start" | "finish" }, null>({
      name: `test.interrupted-parent-${legacyRoot}`,
      version: 1,
      initial: () => ({ phase: "start" }),
      phases: {
        async start(task, api, context) {
          await api.commit(async (tx) => {
            const conversation = await tx.createConversation({
              ownership: { kind: "task", taskId: task.id },
            });
            const childId = await tx.createTask(child, null, {
              conversationId: conversation.id,
              ownership: { kind: "conversation" },
            });
            return {
              status: "waiting",
              checkpoint: { phase: "finish" },
              on: [childId],
              policy: "allSettled",
            };
          }, context);
        },
        async finish(_task, api, context) {
          await api.commit(
            () => ({ status: "terminal", outcome: { status: "completed", result: null } }),
            context,
          );
        },
      },
      async abort(_task, api, context) {
        await api.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
      },
    });
    runtime.registry.install(
      defineExtension({ name: `test.interrupted-${legacyRoot}`, tasks: [parent, child] }),
    );
    const root = mkdtempSync(resolve(tmpdir(), "factory-scheduling-"));
    let journal: DurableJournal | undefined;
    try {
      journal = await openJournal(root, "pipeline:test", () => ({}), runtime, {
        mode: "new",
        runId: "first",
      });
      if (legacyRoot) {
        await appendEvent(journal.indexConversation, "factory.run", {
          runId: "legacy",
          workflow: "pipeline:test",
          status: "started",
          inputs: {},
        });
        await journal.harness.close(BACKGROUND_CONTEXT);
        journal = await openJournal(root, "pipeline:test", () => ({}), runtime, {
          mode: "resume",
          runId: "legacy",
        });
      }
      const firstId = journal.runId;
      const runConversationId = journal.conversation.id;
      const agent = legacyRoot ? journal.conversation : await journal.agentConversation("builder");
      await turn({ ...journal, conversation: agent }, "builder", "original agent history");
      const taskId = await agent.commit(
        (tx) => tx.createTask(parent, null, { ownership: { kind: "conversation" } }),
        BACKGROUND_CONTEXT,
      );
      journal.harness.resume();
      await ready;
      // Close interrupts the phase's AbortSignal without terminalizing its durable
      // work. The parent is waiting on a task in a task-owned handoff conversation.
      await journal.harness.close(BACKGROUND_CONTEXT);
      journal = await openJournal(root, "pipeline:test", () => ({}), runtime, {
        mode: "resume",
        runId: firstId,
      });
      // Queue admission must be scoped too, not only recovery of existing tasks.
      // A raw queued write is sufficient to test visibility without any provider.
      const inbox = legacyRoot ? journal.conversation : await journal.agentConversation("builder");
      const queued = await inbox.commit(
        (tx) =>
          tx.createSubmission({
            type: "write",
            status: "queued",
            conversationId: inbox.id,
            requestId: "queued-old-run",
          }),
        BACKGROUND_CONTEXT,
      );
      await journal.harness.close(BACKGROUND_CONTEXT);
      journal = await openJournal(root, "pipeline:test", () => ({}), runtime, {
        mode: "new",
        runId: "second",
      });
      expect((await journal.harness.inspect(BACKGROUND_CONTEXT)).submissions).toEqual([]);
      expect(await journal.harness.submission(queued.id, BACKGROUND_CONTEXT)).toBeDefined();
      journal.harness.resume();
      await appendEvent(journal.conversation, "test.new-run", {}); // submit() also enables scheduling
      await journal.harness.waitForIdle(BACKGROUND_CONTEXT);
      expect(attempts).toBe(1);
      expect((await journal.harness.inspect(BACKGROUND_CONTEXT)).tasks).toEqual([]);
      expect((await journal.harness.getTask(taskId, BACKGROUND_CONTEXT))?.state.status).toBe("waiting");
      await journal.harness.close(BACKGROUND_CONTEXT);
      finish = true;
      journal = await openJournal(root, "pipeline:test", () => ({}), runtime, {
        mode: "resume",
        runId: firstId,
      });
      expect(journal.conversation.id).toBe(runConversationId);
      const restored = legacyRoot ? journal.conversation : await journal.agentConversation("builder");
      expect(restored.id).toBe(agent.id);
      expect((await restored.context(BACKGROUND_CONTEXT)).messages.map((m) => m.content)).toEqual([
        "original agent history",
      ]);
      const result = await journal.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
      expect(result.state.outcome.status).toBe("completed");
      expect(attempts).toBe(2);
      const children = await restored.commit(
        (tx) => tx.scanConversations({ ownerTaskId: taskId }, 500),
        BACKGROUND_CONTEXT,
      );
      expect(children.items).toHaveLength(1);
    } finally {
      finish = true;
      await journal?.harness.close(BACKGROUND_CONTEXT);
      rmSync(root, { recursive: true, force: true });
    }
  },
  10000,
);

test("ambiguous interrupted legacy root runs fail closed instead of scheduling both", async () => {
  await fixture(async (open) => {
    const journal = await open();
    for (const runId of ["legacy-one", "legacy-two"]) {
      await appendEvent(journal.indexConversation, "factory.run", {
        runId,
        workflow: "pipeline:legacy",
        status: "started",
        inputs: {},
      });
    }
    await journal.harness.close(BACKGROUND_CONTEXT);
    await expect(open("pipeline:legacy")).rejects.toThrow("Multiple interrupted legacy root runs");
    // New independent runs must still work even when legacy history is ambiguous.
    const fresh = await open("pipeline:fresh");
    expect(fresh.conversation.id).not.toBe(journal.indexConversation.id);
  });
});
