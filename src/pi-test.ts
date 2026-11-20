#!/usr/bin/env bun
import { copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(resolve(tmpdir(), "factory-pi-"));
const source = resolve(process.env.PI_CODING_AGENT_DIR ?? resolve(homedir(), ".pi/agent"), "auth.json");
const smoke = process.argv.includes("--smoke");
try {
  if (!smoke && existsSync(source)) copyFileSync(source, resolve(directory, "auth.json"));
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent"))),
      "--no-extensions",
      "--extension",
      resolve(import.meta.dir, "pi-extension.ts"),
      "--no-mcp",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-approve",
      "--offline",
      "--session-dir",
      resolve(".factory/state/pi-sessions"),
      ...(smoke ? ["--mode", "rpc", "--no-session"] : process.argv.slice(2)),
    ],
    {
      env: { ...process.env, PI_CODING_AGENT_DIR: directory },
      stdin: smoke ? "pipe" : "inherit",
      stdout: smoke ? "pipe" : "inherit",
      stderr: "inherit",
    },
  );
  const interrupt = () => child.kill("SIGINT");
  const terminate = () => child.kill("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (smoke) {
      if (!child.stdin || !child.stdout) throw new Error("Missing smoke-test pipes");
      child.stdin.write(`${JSON.stringify({ id: "smoke", type: "get_commands" })}\n`);
      timeout = setTimeout(() => child.kill(), 20000);
      let output = "";
      let loaded = false;
      for await (const chunk of child.stdout) {
        output += new TextDecoder().decode(chunk);
        if (output.includes('"name":"factory"')) {
          loaded = true;
          child.kill();
          break;
        }
      }
      clearTimeout(timeout);
      await child.exited;
      if (!loaded) throw new Error(`Factory extension not loaded: ${output}`);
      console.log("Factory extension loaded in isolated Pi (get_commands)");
    } else process.exitCode = await child.exited;
  } finally {
    clearTimeout(timeout);
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
    child.kill();
    await child.exited;
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
