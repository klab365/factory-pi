import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Local deterministic model adapter: exercises Pi's real agent/tool loop without network access.
export default function testProvider(pi: ExtensionAPI) {
  pi.registerProvider("factory-test", {
    api: "factory-test",
    apiKey: "local-test-only",
    baseUrl: "http://unused.invalid",
    models: [
      {
        id: "local",
        name: "Local Factory test",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = last?.role === "user" ? JSON.stringify(last.content) : "";
      // The kickoff uses JSON-quoted IDs; content may be a text block array.
      const plain =
        last?.role === "user" && Array.isArray(last.content)
          ? last.content
              .filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n")
          : text;
      const match = plain.match(/runId "([^"]+)" and requestId "([^"]+)"/);
      const message: AssistantMessage = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: match
          ? [
              {
                type: "toolCall",
                id: crypto.randomUUID(),
                name: "factory_run",
                arguments: { runId: match[1], requestId: match[2] },
              },
            ]
          : [{ type: "text", text: "Done." }],
        stopReason: match ? "toolUse" : "stop",
        timestamp: Date.now(),
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() => {
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        stream.end();
      });
      return stream;
    },
  });
}
