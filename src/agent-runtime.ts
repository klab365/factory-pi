import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, isAbsolute, relative, sep } from "node:path";
import { parse } from "yaml";
import { BACKGROUND_CONTEXT, withAbortSignal, type Context } from "@earendil-works/chord/context";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  AssistantEntry,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
} from "@earendil-works/pi-durable";
import type { AgentChange, Conversation, Extension, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiCredentialStore } from "./pi-credentials";
import { loadSkills, skillInstructions, type SkillDefinition } from "./skills";

type RecordValue = Record<string, unknown>;
class InvalidAgentOutcome extends Error {}
type ReplyChannel = Pick<Conversation, "submit" | "commit">;
export type AgentDefinition = {
  name: string;
  description?: string;
  model?: string;
  thinking?: string;
  tools?: string[];
  skills: SkillDefinition[];
  prompt: string;
};
export type AgentOutcome = RecordValue & { status: string; summary?: string; feedback?: string };
type AgentRuntime = {
  registry: ReturnType<typeof createRegistry>;
  models: ReturnType<typeof builtinModels>;
  agentChange(agentName: string): AgentChange;
  runAgent(
    conversation: Conversation,
    agentName: string,
    task: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<AgentOutcome>;
};
const fail = (message: string): never => {
  throw new Error(message);
};

export function loadAgentDefinition(root: string, name: string): AgentDefinition {
  const path = resolve(root, ".factory", "agents", `${name}.md`);
  const relativePath = relative(resolve(root, ".factory", "agents"), path);
  if (isAbsolute(relativePath) || relativePath === ".." || relativePath.startsWith(`..${sep}`)) {
    fail(`Invalid agent name: ${name}`);
  }
  if (!existsSync(path)) fail(`Agent not found: ${name}`);
  const source = readFileSync(path, "utf8");
  const frontmatter = source.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/);
  if (frontmatter === null) throw new Error(`Agent '${name}' must start with YAML frontmatter`);
  const metadata = parse(frontmatter[1]);
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    fail(`Agent '${name}' frontmatter must be a mapping`);
  }
  const fields = metadata as RecordValue;
  if (fields.name !== name) fail(`Agent '${name}' frontmatter must have name: ${name}`);
  if (fields.model !== undefined && (typeof fields.model !== "string" || !fields.model.includes("/"))) {
    fail(`Agent '${name}' model must use provider/model-id format`);
  }
  if (
    fields.thinking !== undefined &&
    !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(fields.thinking))
  ) {
    fail(`Agent '${name}' has an invalid thinking level`);
  }
  if (
    fields.tools !== undefined &&
    (!Array.isArray(fields.tools) || fields.tools.some((tool) => typeof tool !== "string"))
  ) {
    fail(`Agent '${name}' tools must be a list of names`);
  }
  return {
    name,
    skills: loadSkills(root, name, fields.skills),
    ...(typeof fields.description === "string" ? { description: fields.description } : {}),
    ...(typeof fields.model === "string" ? { model: fields.model } : {}),
    ...(typeof fields.thinking === "string" ? { thinking: fields.thinking } : {}),
    ...(Array.isArray(fields.tools) ? { tools: fields.tools as string[] } : {}),
    prompt: source.slice(frontmatter[0].length).trim(),
  };
}

export function createAgentRuntime(root: string, pipeline: RecordValue): AgentRuntime {
  if (!Array.isArray(pipeline.steps)) fail("Pipeline must define a steps array");
  const steps = pipeline.steps as unknown[];
  const definitions = new Map<string, AgentDefinition>();
  const stepIds = new Set<string>();
  const stepAgents = new Map<string, string>();
  const outcomes = new Map<string, Set<string>>();
  const allowed = new Map<string, Set<string>>();
  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const step = raw as RecordValue;
    if (typeof step.id !== "string") continue;
    stepIds.add(step.id);
    if (typeof step.agent === "string") {
      definitions.set(step.agent, loadAgentDefinition(root, step.agent));
      stepAgents.set(step.id, step.agent);
    }
  }
  for (const raw of steps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const step = raw as RecordValue;
    if (typeof step.id !== "string" || typeof step.agent !== "string") continue;
    const transitions = step.transitions;
    if (transitions === undefined) continue;
    if (!transitions || typeof transitions !== "object" || Array.isArray(transitions)) {
      fail(`Step '${step.id}' transitions must map result statuses to step ids`);
    }
    const source = step.agent;
    const statuses = outcomes.get(source) ?? new Set<string>();
    const targets = allowed.get(source) ?? new Set<string>();
    for (const [status, targetValue] of Object.entries(transitions as RecordValue)) {
      if (typeof targetValue !== "string")
        throw new Error(`Transition '${status}' on '${step.id}' must name a step or 'end'`);
      statuses.add(status);
      if (targetValue === "end") continue;
      if (!stepIds.has(targetValue))
        throw new Error(`Transition '${status}' on '${step.id}' targets unknown step '${targetValue}'`);
      const targetAgent = stepAgents.get(targetValue);
      if (targetAgent && targetAgent !== source) targets.add(targetAgent);
    }
    outcomes.set(source, statuses);
    allowed.set(source, targets);
  }

  const edgeExtensions = new Map<string, Extension>();
  const extensionsFor = (agentName: string): Extension[] => [
    CodingTools,
    ...[...(allowed.get(agentName) ?? [])].flatMap((target) => {
      const extension = edgeExtensions.get(`${agentName}:${target}`);
      return extension ? [extension] : [];
    }),
  ];
  const changeFor = (agentName: string): AgentChange => {
    const agent = definitions.get(agentName);
    if (!agent) throw new Error(`Agent not configured in this pipeline: ${agentName}`);
    const extensions = extensionsFor(agentName);
    const availableTools = extensions.flatMap((extension) => extension.tools ?? []) as ToolRegistration[];
    const handoffTools = availableTools.filter((tool) => tool.name.startsWith("handoff_"));
    const selectedTools = agent.tools
      ? availableTools.filter((tool) => agent.tools?.includes(tool.name) || handoffTools.includes(tool))
      : availableTools;
    const model = agent.model
      ? (() => {
          const separator = agent.model.indexOf("/");
          return separator > 0 && separator < agent.model.length - 1
            ? { provider: agent.model.slice(0, separator), modelId: agent.model.slice(separator + 1) }
            : undefined;
        })()
      : undefined;
    if (agent.model && !model) fail(`Invalid model in agent '${agentName}'`);
    const validStatuses = [...(outcomes.get(agentName) ?? new Set(["completed"]))];
    return {
      ...(model ? { model } : {}),
      ...(agent.thinking ? { thinkingLevel: agent.thinking as AgentChange["thinkingLevel"] } : {}),
      extensions,
      tools: selectedTools,
      modelTools: selectedTools,
      instructions: `${[agent.prompt, skillInstructions(agent.skills)].filter(Boolean).join("\n\n")}\n\nDelegate only through enabled handoff tools; the pipeline controls allowed transitions. End every turn with a <factory-result> JSON block. Its status must be one of: ${validStatuses.join(", ")}. Include a concise summary, and include actionable feedback when requesting changes. Example shape: <factory-result>{"status":"${validStatuses[0]}","summary":"...","feedback":"..."}</factory-result>`,
      cwd: root,
      maxTurns: 80,
    };
  };

  const parseOutcome = (agentName: string, text: string): AgentOutcome => {
    const match = text.match(/<factory-result>\s*([\s\S]*?)\s*<\/factory-result>\s*$/);
    if (!match) throw new InvalidAgentOutcome(`Agent '${agentName}' did not return a <factory-result> block`);
    let result: unknown;
    try {
      result = JSON.parse(match[1]);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      throw new InvalidAgentOutcome(`Agent '${agentName}' returned invalid JSON in <factory-result>`);
    }
    if (
      !result ||
      typeof result !== "object" ||
      Array.isArray(result) ||
      !("status" in result) ||
      typeof result.status !== "string"
    ) {
      throw new InvalidAgentOutcome(
        `Agent '${agentName}' returned an invalid factory result (expected an object with a string status)`,
      );
    }
    if (!(outcomes.get(agentName) ?? new Set(["completed"])).has(result.status)) {
      throw new InvalidAgentOutcome(`Agent '${agentName}' returned an undeclared status`);
    }
    return result as AgentOutcome;
  };

  const readReply = async (
    conversation: ReplyChannel,
    task: string,
    requestId: string,
    context: Context,
    label: string,
  ) => {
    const submission = await conversation.submit({ type: "input", content: task, requestId }, context);
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.type !== "input") {
      throw new Error(`${label} did not complete: ${settled.status}`);
    }
    const answer = await conversation.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    return (
      answer?.model
        ?.flatMap((message) =>
          Array.isArray(message.content)
            ? message.content.flatMap((part) =>
                part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part
                  ? [String(part.text)]
                  : [],
              )
            : [],
        )
        .join("\n") ?? ""
    );
  };

  const requestOutcome = async (
    conversation: ReplyChannel,
    agentName: string,
    task: string,
    requestId: string,
    context: Context,
    label: string,
  ) => {
    const text = await readReply(conversation, task, requestId, context, label);
    try {
      return { text, outcome: parseOutcome(agentName, text) };
    } catch (error) {
      if (!(error instanceof InvalidAgentOutcome)) throw error;
      const statuses = [...(outcomes.get(agentName) ?? new Set(["completed"]))].join(", ");
      const correction = await readReply(
        conversation,
        `Your previous reply could not be accepted: ${error.message}. ` +
          `Do not repeat the task or call tools. Based on your previous work, reply only with a <factory-result>JSON</factory-result> block. ` +
          `Use a JSON object with a string status (${statuses}) and a concise summary. Include actionable feedback when requesting changes.`,
        `${requestId}:factory-result-repair`,
        context,
        `${label} (result correction)`,
      );
      try {
        return { text: correction, outcome: parseOutcome(agentName, correction) };
      } catch (correctionError) {
        if (!(correctionError instanceof InvalidAgentOutcome)) throw correctionError;
        throw new Error(`${correctionError.message} after one correction request`, {
          cause: correctionError,
        });
      }
    }
  };

  for (const [source, targets] of allowed) {
    for (const target of targets) {
      const tool = defineTool({
        name: `handoff_${source}_to_${target}`,
        description: `Durably delegate a task from ${source} to the ${target} agent. The pipeline explicitly allows this transition.`,
        parameters: obj({ task: str(), context: opt(str()) }),
        replay: "safe",
        async execute(args, api, context) {
          const childId = await api.commit(async (tx) => {
            const existing = (await tx.scanConversations({ ownerTaskId: api.taskId }, 1)).items[0];
            if (existing) return existing.id;
            const child = await tx.createConversation({
              ownership: { kind: "task", taskId: api.taskId },
            });
            await configure(tx, child.id, changeFor(target));
            return child.id;
          }, context);
          await api.details({ handoff: `${source} -> ${target}`, conversationId: childId }, context);
          const child = await api.conversation(childId, context);
          if (!child) throw new Error(`Could not open handoff conversation for '${target}'`);
          const { text } = await requestOutcome(
            { submit: child.submit.bind(child), commit: api.commit.bind(api) },
            target,
            `Task from ${source}: ${args.task}\n\nContext:\n${args.context ?? "(none provided)"}`,
            `handoff-${api.taskId}`,
            context,
            `Handoff to '${target}'`,
          );
          return { output: [{ type: "text", text }] };
        },
      });
      edgeExtensions.set(
        `${source}:${target}`,
        defineExtension({
          name: `handoff-${source}-to-${target}`,
          tools: [tool],
        }),
      );
    }
  }

  const registry = createRegistry();
  registry.install(CodingTools);
  for (const extension of edgeExtensions.values()) registry.install(extension);
  const authPath = resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent"), "auth.json");
  const models = builtinModels({ credentials: new PiCredentialStore(authPath) });
  return {
    registry,
    models,
    agentChange: changeFor,
    async runAgent(conversation, agentName, task, requestId, signal) {
      const context = signal ? withAbortSignal(signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
      const previous = await conversation.commit(
        (tx) => tx.submissionByRequest(conversation.id, requestId),
        context,
      );
      // Do not reconfigure an admitted turn: it can still be running, with its
      // original handoff children, or already answered but not checkpointed yet.
      if (!previous) await conversation.configure(changeFor(agentName), context);
      const { outcome } = await requestOutcome(
        conversation,
        agentName,
        task,
        requestId,
        context,
        `Agent '${agentName}'`,
      );
      return outcome;
    },
  };
}
