import { Type } from "typebox";
import { compactOutput, FactoryProgress } from "./pi-progress";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { initProject, listPipelines, setupPrompt } from "./init";
import { validatePipeline } from "./pipeline-validation";
import {
  chooseRun,
  workspaceIdentity,
  parseCommand,
  promptInputs,
  readRuns,
  runChild,
  saveRun,
  type Request,
  type Run,
} from "./pi-session";

export default function factoryExtension(pi: ExtensionAPI) {
  let active: AbortController | undefined;
  let activeRun: Promise<void> | undefined;
  pi.registerEntryRenderer<Record<string, unknown>>("factory.timeline", (entry, options) => {
    // Returning an empty component still makes Pi insert a transcript spacer.
    if (!options.expanded) return undefined;
    const data = entry.data ?? {};
    const result = data.result !== null && typeof data.result === "object" ? data.result : {};
    const heading = ["Factory", data.type, data.agent ?? data.stepId, data.status]
      .filter(Boolean)
      .join(" · ");
    const details = [
      data.text,
      data.error,
      data.instruction,
      "summary" in result ? result.summary : undefined,
      "feedback" in result ? result.feedback : undefined,
    ]
      .filter(Boolean)
      .join("\n");
    return new Text(compactOutput(`${heading}${details ? `\n${details}` : ""}`), 0, 0);
  });
  function dispatch(run: Run) {
    pi.sendUserMessage(
      `Execute the pending Factory request now. Call factory_run with runId ${JSON.stringify(run.runId)} and requestId ${JSON.stringify(run.pending?.requestId)}. Do not execute the pipeline yourself.`,
    );
  }
  pi.registerTool({
    name: "factory_run",
    label: "Factory run",
    description:
      "Execute the pending durable Factory pipeline for this native Pi session. Only use the IDs from the Factory kickoff.",
    parameters: Type.Object({ runId: Type.String(), requestId: Type.String() }),
    renderCall() {
      return new Text("Factory run", 0, 0);
    },
    renderResult(result) {
      return new Text(
        compactOutput(
          result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        ),
        0,
        0,
      );
    },
    async execute(_id, params, signal, onUpdate, ctx) {
      const run = readRuns(ctx.cwd).find((item) => item.runId === params.runId);
      if (!run || run.sessionFile !== ctx.sessionManager.getSessionFile())
        throw new Error("Factory run does not belong to the current Pi session");
      const request = run.pending;
      if (
        !request ||
        request.runId !== run.runId ||
        request.pipeline !== run.pipeline ||
        !request.requestId ||
        request.requestId !== params.requestId
      )
        throw new Error("No matching pending Factory request");
      return execute(ctx, request, run, signal, (message, event) =>
        onUpdate?.({
          content: [{ type: "text", text: message }],
          details: event,
        }),
      );
    },
  });
  async function execute(
    ctx: ExtensionContext,
    request: Request,
    run: Run,
    signal: AbortSignal | undefined,
    update: (message: string, event: Record<string, unknown>) => void,
  ) {
    if (active) throw new Error("A Factory run is already active in this session");
    const progress = new FactoryProgress(run.runId);
    const controller = new AbortController();
    active = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      saveRun(ctx.cwd, { ...run, status: "started", pending: request });
      pi.appendEntry("factory.timeline", {
        type: request.mode,
        runId: run.runId,
        instruction: request.instruction,
      });
      activeRun = runChild(
        ctx.cwd,
        request,
        (event) => {
          if (controller.signal.aborted) return;
          if (event.type === "completed")
            saveRun(ctx.cwd, { ...run, status: "completed", pending: undefined });
          pi.appendEntry("factory.timeline", { ...event, runId: run.runId });
          const message = progress.accept(event);
          if (message) {
            update(progress.progress(), event);
            ctx.ui.setStatus("factory", message.split("\n")[0]);
          }
        },
        controller.signal,
        {
          human: async (prompt) => {
            if (!ctx.hasUI) throw new Error("Human input requires interactive Pi");
            // The complete prompt is in tool progress/history, not the editor-sized
            // dialog title: approval prompts can contain entire review reports.
            return prompt.choices
              ? ctx.ui.select("Factory decision — see output above", prompt.choices)
              : ctx.ui.input("Factory response — see output above");
          },
        },
      );
      await activeRun;
      saveRun(ctx.cwd, { ...run, status: "completed", pending: undefined });
      return {
        content: [{ type: "text" as const, text: progress.summary() }],
        details: { runId: run.runId },
      };
    } catch (error) {
      pi.appendEntry("factory.timeline", { type: "interrupted", runId: run.runId, error: String(error) });
      const message = progress.interrupted(error, controller.signal.aborted);
      if (!controller.signal.aborted) ctx.ui.notify(message, "error");
      throw new Error(message, { cause: error });
    } finally {
      signal?.removeEventListener("abort", abort);
      active = undefined;
      activeRun = undefined;
      ctx.ui.setStatus("factory", undefined);
    }
  }
  pi.on("session_shutdown", async () => {
    active?.abort();
    // Shutdown must wait for group escalation/cleanup before Pi can exit.
    await activeRun?.catch(() => {});
  });
  pi.on("session_before_switch", () => (active ? { cancel: true } : undefined));
  pi.on("session_start", async (_event, ctx) => {
    // Pending requests belong to a run/session, not a shared replacement mailbox.
    const run = readRuns(ctx.cwd).find(
      (item) => item.sessionFile === ctx.sessionManager.getSessionFile() && item.pending,
    );
    if (run?.pending) {
      run.pending.requestId ??= crypto.randomUUID();
      run.status = "started";
      saveRun(ctx.cwd, run);
      dispatch(run);
    }
  });
  pi.registerCommand("factory", {
    description: "Factory init | validate [pipeline] | run [pipeline] | resume [runId] | refine [runId]",
    handler: async (args, ctx) => {
      let replacing = false;
      try {
        if (!ctx.hasUI) throw new Error("Factory commands require interactive Pi");
        if (active) throw new Error("A Factory run is already active");
        const root = ctx.cwd;
        const { command, target } = parseCommand(args);
        await ctx.waitForIdle();
        if (command === "init") {
          if (!ctx.model) throw new Error("Select a model with /model before /factory init");
          for (const name of initProject(root)) validatePipeline(root, name);
          pi.sendUserMessage(setupPrompt(ctx.model));
          ctx.ui.notify(`Factory initialized in ${root}; project setup requested in Pi`, "info");
          return;
        }
        if (command === "run" || command === "validate") {
          const pipelines = listPipelines(root);
          if (!pipelines.length)
            throw new Error("No Factory pipelines. Use /factory init to create a starter.");
          const pipeline = target ?? (await ctx.ui.select("Factory pipeline", pipelines));
          if (!pipeline) return;
          if (!pipelines.includes(pipeline)) throw new Error(`Unknown pipeline '${pipeline}'`);
          const definition = validatePipeline(root, pipeline);
          if (command === "validate") {
            ctx.ui.notify(`Pipeline valid: ${pipeline}`, "info");
            return;
          }
          const inputs = await promptInputs(definition, ctx.ui);
          if (!inputs) return;
          const runId = crypto.randomUUID();
          const request: Request = { mode: "new", runId, pipeline, inputs, requestId: crypto.randomUUID() };
          // setup uses the NEW SessionManager. session_start dispatches in the NEW extension
          // instance; never capture this old pi/context in a replacement callback.
          replacing = true;
          const result = await ctx.newSession({
            setup: async (sm) => {
              sm.appendSessionInfo(`Factory: ${pipeline} · ${runId.slice(0, 8)}`);
              sm.appendCustomEntry("factory.run", { runId, pipeline, inputs });
              // Pi only materializes a session file after a user/assistant message.
              // Persist the actual human request, never synthetic status messages.
              sm.appendMessage({
                role: "user",
                content: [{ type: "text", text: inputs.goal ?? JSON.stringify(inputs) }],
                timestamp: Date.now(),
              });
              const sessionFile = sm.getSessionFile();
              if (!sessionFile) throw new Error("Factory requires persistent Pi sessions");
              const run: Run = {
                runId,
                pipeline,
                sessionFile,
                status: "started",
                pending: request,
                workspace: workspaceIdentity(root),
                goal: inputs.goal,
                createdAt: new Date().toISOString(),
              };
              saveRun(root, run);
            },
          });
          if (result.cancelled) return;
        } else {
          const mode = command;
          const run = await chooseRun(readRuns(ctx.cwd), mode, target, ctx.ui, workspaceIdentity(root));
          if (!run) return;
          const instruction =
            mode === "refine" ? await ctx.ui.editor("Additional Factory instruction") : undefined;
          if (mode === "refine" && !instruction?.trim()) return;
          const request: Request =
            mode === "resume" && run.pending
              ? { ...run.pending, requestId: run.pending.requestId ?? crypto.randomUUID() }
              : {
                  mode,
                  runId: run.runId,
                  pipeline: run.pipeline,
                  instruction,
                  requestId: crypto.randomUUID(),
                };
          if (!existsSync(run.sessionFile)) throw new Error(`Pi session missing: ${run.sessionFile}`);
          if (run.sessionFile === ctx.sessionManager.getSessionFile()) {
            const pendingRun: Run = { ...run, status: "started", pending: request };
            saveRun(root, pendingRun);
            dispatch(pendingRun);
          } else {
            saveRun(root, { ...run, status: "started", pending: request });
            replacing = true;
            const result = await ctx.switchSession(run.sessionFile);
            if (result.cancelled) saveRun(root, run);
          }
        }
      } catch (error) {
        if (replacing) throw error; // the original context may already be stale
        ctx.ui.notify(String(error), "error");
      }
    },
  });
}
