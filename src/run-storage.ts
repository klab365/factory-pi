import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  ROOT_CONVERSATION_ID,
  type ConversationId,
  type Cursor,
  type Storage,
  type Page,
} from "@earendil-works/pi-durable";

// Harness.resume(), submit() and wait() schedule the entire Storage, not just the
// conversation used by the caller. Keep history addressable, but scope BOTH live
// task recovery and queued-input admission before Harness.open can recover tasks.
export async function scopeRunStorage(
  storage: Storage,
  workflow: string,
  selection?: { mode: "new" | "resume" | "refine"; runId?: string },
) {
  const runs = new Map<string, { workflow: string; status: string; conversationId?: ConversationId }>();
  let cursor: Cursor | undefined;
  if (await storage.conversation(ROOT_CONVERSATION_ID, BACKGROUND_CONTEXT))
    do {
      const page = await storage.scanEntries(
        { conversationId: ROOT_CONVERSATION_ID, order: "ascending" },
        500,
        cursor,
        BACKGROUND_CONTEXT,
      );
      for (const entry of page.items) {
        const data = entry.data as Record<string, unknown> | undefined;
        if (entry.kind !== "factory.run" || typeof data?.runId !== "string") continue;
        runs.set(data.runId, {
          ...runs.get(data.runId),
          workflow: String(data.workflow),
          status: String(data.status),
          ...(typeof data.conversationId === "number"
            ? { conversationId: data.conversationId as ConversationId }
            : {}),
        });
      }
      cursor = page.next;
    } while (cursor);
  const runId =
    selection?.runId ??
    (selection?.mode === "new"
      ? undefined
      : [...runs].reverse().find(([, run]) => run.workflow === workflow && run.status === "started")?.[0]) ??
    crypto.randomUUID();
  const saved = runs.get(runId);
  const roots = new Set<ConversationId>();
  if (saved) {
    if (saved.workflow !== workflow) throw new Error("Run not found for this pipeline");
    const id = saved.conversationId ?? ROOT_CONVERSATION_ID;
    roots.add(id);
    // Pre-isolation root runs cannot be safely distinguished if multiple runs
    // still own live work there. Fail closed rather than revive another run.
    if (
      id === ROOT_CONVERSATION_ID &&
      [...runs].some(
        ([otherId, run]) =>
          otherId !== runId &&
          run.status === "started" &&
          (run.conversationId ?? ROOT_CONVERSATION_ID) === ROOT_CONVERSATION_ID,
      )
    )
      throw new Error("Multiple interrupted legacy root runs; cannot safely select their task trees");
    cursor = undefined;
    if (await storage.conversation(id, BACKGROUND_CONTEXT))
      do {
        const page = await storage.scanEntries(
          { conversationId: id, order: "ascending" },
          500,
          cursor,
          BACKGROUND_CONTEXT,
        );
        for (const entry of page.items) {
          const data = entry.data as Record<string, unknown> | undefined;
          if (
            entry.kind === "factory.agent" &&
            data?.runId === runId &&
            typeof data.conversationId === "number"
          )
            roots.add(data.conversationId as ConversationId);
        }
        cursor = page.next;
      } while (cursor);
  }
  async function includes(id: ConversationId): Promise<boolean> {
    if (roots.has(id)) return true;
    const record = await storage.conversation(id, BACKGROUND_CONTEXT);
    return record?.owner ? includes(record.owner.conversationId) : false;
  }
  async function filter<T extends { conversationId: ConversationId }>(page: Page<T, Cursor>) {
    const selected = await Promise.all(page.items.map((item) => includes(item.conversationId)));
    return { ...page, items: page.items.filter((_, index) => selected[index]) };
  }
  const scoped = new Proxy(storage, {
    get(target, property) {
      // Preserve raw cursors even for empty pages; excluded records must not
      // truncate pagination. Exact lookups remain available for saved history.
      if (property === "scanTasks")
        return async (...args: Parameters<Storage["scanTasks"]>) => filter(await target.scanTasks(...args));
      if (property === "scanSubmissions")
        return async (...args: Parameters<Storage["scanSubmissions"]>) =>
          filter(await target.scanSubmissions(...args));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage: scoped, runId, include: (id: ConversationId) => roots.add(id) };
}
