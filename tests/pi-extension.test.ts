import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRuns } from "../src/pi-session";

// Real Pi replacement lifecycle and tool turns, with a local no-network model adapter.
test("Pi replacement loads fresh extension, names session and persists context-free timeline", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "factory-pi-integration-"));
  mkdirSync(resolve(root, ".factory/pipelines"), { recursive: true });
  writeFileSync(
    resolve(root, ".factory/pipelines/test.yml"),
    `inputs:\n  goal: {}\nsteps:\n  - id: work\n    shell: echo \${{ inputs.goal }} >> output\n`,
  );
  const extension = resolve(root, "extension.ts");
  writeFileSync(
    extension,
    `
    import factory from ${JSON.stringify(resolve(import.meta.dir, "../src/pi-extension.ts"))};
    import testProvider from ${JSON.stringify(resolve(import.meta.dir, "pi-test-provider.ts"))};
    export default function(pi) {
      testProvider(pi);
      factory({ ...pi, registerCommand(name, options) {
        pi.registerCommand(name, { ...options, handler: (args, ctx) => options.handler(args, {
          ...ctx, hasUI: true, ui: { ...ctx.ui,
            select: async (_title, choices) => choices[0],
            editor: async () => "test goal",
          }
        }) });
      } });
    }
  `,
  );
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
      "--mode",
      "rpc",
      "--offline",
      "--provider",
      "factory-test",
      "--model",
      "local",
      "--no-extensions",
      "-e",
      extension,
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
    ],
    {
      cwd: root,
      env: { ...process.env, PI_CODING_AGENT_DIR: resolve(root, "agent") },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  let output = "";
  const timeout = setTimeout(() => child.kill(), 20000);
  async function command(id: string, message: string) {
    child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
    const start = output.length;
    while (true) {
      const recent = output.slice(start);
      if (recent.includes(`"id":"${id}"`) && recent.includes('"type":"agent_settled"')) break;
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`Pi exited: ${output} ${await new Response(child.stderr).text()}`);
      output += new TextDecoder().decode(chunk.value);
    }
  }
  try {
    await command("run-one", "/factory run test");
    const first = readRuns(root)[0];
    expect(first.status).toBe("completed");
    const entries = readFileSync(first.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      entries.some((entry) => entry.type === "session_info" && entry.name.startsWith("Factory: test")),
    ).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.type === "custom" &&
          entry.customType === "factory.timeline" &&
          entry.data.type === "completed",
      ),
    ).toBe(true);
    expect(entries.some((entry) => entry.type === "custom_message")).toBe(false);
    expect(
      entries.some(
        (entry) =>
          entry.message?.role === "assistant" &&
          entry.message.content.some(
            (part: { type: string; name?: string }) =>
              part.type === "toolCall" && part.name === "factory_run",
          ),
      ),
    ).toBe(true);
    expect(
      entries.some(
        (entry) => entry.message?.role === "toolResult" && entry.message.toolName === "factory_run",
      ),
    ).toBe(true);
    expect(output).toContain('"type":"tool_execution_update"');
    expect(
      entries
        .filter((entry) => entry.customType === "factory.timeline")
        .every((entry) => entry.data.runId === first.runId),
    ).toBe(true);
    await command("refine-one", "/factory refine");
    expect(readRuns(root)[0].sessionFile).toBe(first.sessionFile);
    writeFileSync(
      resolve(root, ".factory/pipelines/test.yml"),
      `inputs:\n  goal: {}\nsteps:\n  - id: work\n    shell: test ! -f stop && echo \${{ inputs.goal }} >> output\n`,
    );
    writeFileSync(resolve(root, "stop"), "");
    await command("run-two", "/factory run test");
    const runs = readRuns(root);
    expect(runs).toHaveLength(2);
    expect(runs[1].runId).not.toBe(first.runId);
    expect(runs[1].sessionFile).not.toBe(first.sessionFile);
    expect(runs[1].status).toBe("started");
    unlinkSync(resolve(root, "stop"));
    // Switch back to the completed first session, then resume the interrupted second.
    await command("refine-first", `/factory refine ${first.runId}`);
    await command("resume-second", "/factory resume");
    const resumed = readRuns(root).find((run) => run.runId === runs[1].runId);
    expect(resumed?.sessionFile).toBe(runs[1].sessionFile);
    expect(resumed?.status).toBe("completed");
    expect(resumed?.pending).toBeUndefined();
    expect(readFileSync(resolve(root, "output"), "utf8")).toBe(
      "test goal\ntest goal\n\nAdditional instruction (round 2):\ntest goal\n" +
        "test goal\n\nAdditional instruction (round 2):\ntest goal\n\nAdditional instruction (round 3):\ntest goal\n" +
        "test goal\n",
    );
    if (!resumed) throw new Error("Resumed run missing");
    const resumedEntries = readFileSync(resumed.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(resumedEntries.filter((entry) => entry.customType === "factory.run")).toHaveLength(1);
    expect(
      resumedEntries.some(
        (entry) =>
          entry.customType === "factory.timeline" &&
          entry.data.type === "new" &&
          entry.data.runId === resumed?.runId,
      ),
    ).toBe(true);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
    reader.releaseLock();
    rmSync(root, { recursive: true, force: true });
  }
}, 25000);
