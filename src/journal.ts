import { resolve } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, type Conversation, type Cursor, type ConversationId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { scopeRunStorage } from "./run-storage";
import type { createAgentRuntime } from "./agent-runtime";

type RecordValue = Record<string, unknown>;
export type DurableJournal = Awaited<ReturnType<typeof openJournal>>;
export async function openJournal(
  root: string,
  workflowPath: string,
  requestedInputs: () => Record<string, string>,
  runtime: ReturnType<typeof createAgentRuntime>,
  selection?: { mode: "new" | "resume" | "refine"; runId?: string; instruction?: string; requestId?: string },
) {
  const storage = await openNodeJsonlStorage(resolve(root, ".factory/state/durable"), BACKGROUND_CONTEXT);
  let scope: Awaited<ReturnType<typeof scopeRunStorage>>;
  try {
    scope = await scopeRunStorage(storage, workflowPath, selection);
  } catch (error) {
    await storage.close(BACKGROUND_CONTEXT);
    throw error;
  }
  selection = { ...(selection ?? { mode: "new" }), runId: scope.runId };
  const harness = await Harness.open(
    scope.storage,
    {
      models: runtime.models,
      registry: runtime.registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? root }),
    },
    BACKGROUND_CONTEXT,
  );
  try {
    const indexConversation = await harness.root(BACKGROUND_CONTEXT);
    const runs = new Map<
      string,
      {
        status: string;
        workflow: string;
        inputs?: Record<string, string>;
        conversationId?: ConversationId;
        requestId?: string;
      }
    >();
    const completed = new Set<string>();
    const results = new Map<string, RecordValue>();
    const agentIds = new Map<string, ConversationId>();
    let savedCursor: { stepId: string; visit: number; visits: Record<string, number> } | undefined;
    let cursor: Cursor | undefined;
    do {
      const page = await indexConversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        if (!entry.data || typeof entry.data !== "object") continue;
        const data = entry.data as RecordValue;
        if (
          entry.kind === "factory.run" &&
          typeof data.runId === "string" &&
          typeof data.workflow === "string"
        ) {
          runs.set(data.runId, {
            ...runs.get(data.runId),
            ...(typeof data.requestId === "string" ? { requestId: data.requestId } : {}),
            status: String(data.status),
            workflow: data.workflow,
            ...(typeof data.conversationId === "number"
              ? { conversationId: data.conversationId as ConversationId }
              : {}),
            ...(data.inputs && typeof data.inputs === "object"
              ? { inputs: data.inputs as Record<string, string> }
              : {}),
          });
        }
      }
      cursor = page.next;
    } while (cursor);
    const activeRun =
      selection?.mode === "new"
        ? [...runs].find(([id]) => id === selection.runId)
        : selection
          ? [...runs].find(([id, run]) => id === selection.runId && run.workflow === workflowPath)
          : [...runs].reverse().find(([, run]) => run.workflow === workflowPath && run.status === "started");
    if (selection && selection.mode !== "new" && !activeRun)
      throw new Error("Run not found for this pipeline");
    if (
      selection?.mode === "refine" &&
      activeRun?.[1].status !== "completed" &&
      (!selection.requestId || activeRun?.[1].requestId !== selection.requestId)
    )
      throw new Error("Resume the interrupted run before refining");
    let runId = activeRun?.[0];
    let inputs = activeRun?.[1].inputs ?? requestedInputs();
    let round = 1;
    let conversation: Conversation;
    if (!runId) {
      runId = selection?.runId ?? crypto.randomUUID();
      const newRunId = runId;
      // Creation and the run mapping must survive together, even if the process stops here.
      const conversationId = await indexConversation.commit(async (tx) => {
        const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
        await tx.appendEntry(indexConversation.id, {
          kind: "factory.run",
          data: {
            runId: newRunId,
            conversationId: created.id,
            workflow: workflowPath,
            status: "started",
            inputs,
            at: new Date().toISOString(),
          },
        });
        return created.id;
      }, BACKGROUND_CONTEXT);
      scope.include(conversationId);
      const created = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (!created) throw new Error(`New conversation '${conversationId}' is missing`);
      conversation = created;
    } else {
      // Older journals executed in root. Preserve that exact context (and its in-flight
      // handoffs) on resume, but never use root for a newly created run.
      const conversationId = activeRun?.[1].conversationId ?? indexConversation.id;
      if (activeRun?.[1].conversationId === undefined) {
        await appendEvent(indexConversation, "factory.run", {
          runId,
          conversationId,
          workflow: workflowPath,
          status: "started",
          inputs,
        });
      }
      const saved = await harness.conversation(conversationId, BACKGROUND_CONTEXT);
      if (!saved) throw new Error(`Conversation '${conversationId}' for run '${runId}' is missing`);
      conversation = saved;
      console.log("↻ Resuming durable run; using its saved inputs");
    }
    cursor = undefined;
    do {
      const page = await conversation.entries({ order: "ascending" }, 500, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        if (!entry.data || typeof entry.data !== "object") continue;
        const data = entry.data as RecordValue;
        if (data.runId !== runId) continue;
        if (entry.kind === "factory.round" && typeof data.round === "number") {
          round = data.round;
          inputs = data.inputs as Record<string, string>;
          savedCursor = undefined;
        }
        if (entry.kind === "factory.agent") {
          if (typeof data.agentName !== "string" || typeof data.conversationId !== "number") {
            throw new Error(`Invalid agent conversation mapping for run '${runId}'`);
          }
          const existing = agentIds.get(data.agentName);
          if (existing !== undefined && existing !== data.conversationId) {
            throw new Error(`Conflicting conversation mapping for agent '${data.agentName}'`);
          }
          agentIds.set(data.agentName, data.conversationId as ConversationId);
        }
        if (entry.kind === "factory.step" && typeof data.key === "string") {
          if (data.status === "completed") {
            completed.add(data.key);
            if (data.result && typeof data.result === "object" && !Array.isArray(data.result)) {
              results.set(data.key, data.result as RecordValue);
            }
          } else {
            completed.delete(data.key);
            results.delete(data.key);
          }
        }
        if (
          entry.kind === "factory.cursor" &&
          typeof data.stepId === "string" &&
          typeof data.visit === "number" &&
          data.visits &&
          typeof data.visits === "object"
        ) {
          savedCursor = {
            stepId: data.stepId,
            visit: data.visit,
            visits: data.visits as Record<string, number>,
          };
        }
      }
      cursor = page.next;
    } while (cursor);
    if (
      selection?.mode === "refine" &&
      (!selection.requestId || activeRun?.[1].requestId !== selection.requestId)
    ) {
      if (!selection.instruction?.trim()) throw new Error("Refine requires an instruction");
      round++;
      inputs = {
        ...inputs,
        goal: `${inputs.goal ?? ""}\n\nAdditional instruction (round ${round}):\n${selection.instruction}`,
      };
      await conversation.commit(async (tx) => {
        await tx.appendEntry(conversation.id, { kind: "factory.round", data: { runId, round, inputs } });
        await tx.appendEntry(indexConversation.id, {
          kind: "factory.run",
          data: {
            runId,
            conversationId: conversation.id,
            workflow: workflowPath,
            status: "started",
            inputs,
            ...(selection.requestId ? { requestId: selection.requestId } : {}),
          },
        });
      }, BACKGROUND_CONTEXT);
      savedCursor = undefined;
    }
    // Resolve every saved ID before resuming work; never replace missing history.
    const agentConversations = new Map<string, Promise<Conversation>>();
    for (const [agentName, id] of agentIds) {
      const saved = await harness.conversation(id, BACKGROUND_CONTEXT);
      if (!saved)
        throw new Error(`Conversation '${id}' for agent '${agentName}' in run '${runId}' is missing`);
      agentConversations.set(agentName, Promise.resolve(saved));
    }
    const agentRunId = runId;
    function agentConversation(agentName: string): Promise<Conversation> {
      const existing = agentConversations.get(agentName);
      if (existing) return existing;
      // Cache the in-flight creation too, so concurrent first visits cannot create duplicates.
      const pending = (async () => {
        const id = await conversation.commit(async (tx) => {
          const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
          await tx.appendEntry(conversation.id, {
            kind: "factory.agent",
            data: { runId: agentRunId, agentName, conversationId: created.id },
          });
          return created.id;
        }, BACKGROUND_CONTEXT);
        scope.include(id);
        const created = await harness.conversation(id, BACKGROUND_CONTEXT);
        if (!created) throw new Error(`New agent conversation '${id}' is missing`);
        return created;
      })();
      agentConversations.set(agentName, pending);
      void pending.catch(() => {
        if (agentConversations.get(agentName) === pending) agentConversations.delete(agentName);
      });
      return pending;
    }
    return {
      agentConversation,
      async runAgent(agentName: string, task: string, requestId: string) {
        // Before agent isolation, this visit may already have been admitted in the
        // run conversation (including root for legacy runs). Consume that exact
        // submission, and its existing handoff tree, rather than starting it again.
        const previous = await conversation.commit(
          (tx) => tx.submissionByRequest(conversation.id, requestId),
          BACKGROUND_CONTEXT,
        );
        const target = previous ? conversation : await agentConversation(agentName);
        return runtime.runAgent(target, agentName, task, requestId);
      },
      harness,
      indexConversation,
      conversation,
      completed,
      results,
      runId,
      round,
      inputs,
      cursor: savedCursor,
    };
  } catch (error) {
    await harness.close(BACKGROUND_CONTEXT);
    throw error;
  }
}

export async function appendEvent(
  conversation: Conversation,
  kind: string,
  data: RecordValue,
): Promise<void> {
  const submission = await conversation.submit(
    { type: "write", entry: { kind, data: { ...data, at: new Date().toISOString() } } },
    BACKGROUND_CONTEXT,
  );
  await submission.wait(BACKGROUND_CONTEXT);
}
