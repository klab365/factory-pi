import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Registry access is intentional here, not in the deterministic unit suite.
const repository = resolve(import.meta.dir, "..");
const directory = mkdtempSync(resolve(tmpdir(), "factory-package-"));
async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...process.env, PI_CODING_AGENT_DIR: resolve(directory, "agent") },
    stdout: "inherit",
    stderr: "inherit",
  });
  const timeout = setTimeout(() => child.kill(), 180_000);
  try {
    const code = await child.exited;
    if (code !== 0) throw new Error(`${command.join(" ")} exited with ${code}`);
  } finally {
    clearTimeout(timeout);
    child.kill();
    await child.exited;
  }
}

try {
  const npm = Bun.spawn(["npm", "--version"], { stdout: "pipe", stderr: "inherit" });
  const [version, code] = await Promise.all([new Response(npm.stdout).text(), npm.exited]);
  const [major, minor, patch] = version.trim().split(".").map(Number);
  if (
    code !== 0 ||
    ![major, minor, patch].every(Number.isInteger) ||
    !(major > 11 || (major === 11 && (minor > 19 || (minor === 19 && patch >= 1))))
  ) {
    throw new Error(`Package policy smoke requires npm >=11.19.1; found ${version.trim()}`);
  }
  await run(["npm", "pack", "--ignore-scripts", "--pack-destination", directory], repository);
  const archives = readdirSync(directory).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected exactly one packed archive");
  const consumer = resolve(directory, "consumer");
  mkdirSync(consumer);
  writeFileSync(resolve(consumer, "package.json"), '{"private":true,"type":"module"}\n');
  await run(
    [
      "npm",
      "install",
      resolve(directory, archives[0]),
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ],
    consumer,
  );
  const installed = resolve(consumer, "node_modules/pi-software-factory");
  await run([process.execPath, resolve(installed, "src/pi-test.ts"), "--smoke"], consumer);
  mkdirSync(resolve(consumer, ".factory/pipelines"), { recursive: true });
  writeFileSync(
    resolve(consumer, ".factory/pipelines/smoke.yml"),
    "steps:\n  - id: work\n    shell: echo ran >> visits\n",
  );
  writeFileSync(
    resolve(consumer, "smoke.ts"),
    `
import { strict as assert } from "node:assert";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { runPipeline } from "pi-software-factory/src/runner.ts";
// Resolve from the actual Pi AI dependency, including nested npm layouts.
const require = createRequire(import.meta.resolve("@earendil-works/pi-ai"));
const genaiPath = require.resolve("@google/genai");
const { GoogleGenAI } = await import(genaiPath);
assert.ok(new GoogleGenAI({ apiKey: "smoke-not-a-real-key" }));
const googleRequire = createRequire(genaiPath);
const protobuf = googleRequire("protobufjs");
const type = protobuf.parse('syntax = "proto3"; message Smoke { string text = 1; }').root.lookupType("Smoke");
assert.equal(type.decode(type.encode({ text: "works" }).finish()).text, "works");
await runPipeline("smoke", [], { mode: "new", runId: "package-smoke" });
await runPipeline("smoke", [], { mode: "resume", runId: "package-smoke" });
assert.equal(readFileSync("visits", "utf8"), "ran\\n");
console.log("Packed extension, protobuf, durable execution and replay work without install scripts");
`,
  );
  await run([process.execPath, resolve(consumer, "smoke.ts")], consumer);

  // Also exercise npm's current policy, rather than only its ignore-scripts override.
  // Explicit denials belong to this temporary install root, never the shipped package.
  const manifestPath = resolve(consumer, "package.json");
  const manifest: unknown = await Bun.file(manifestPath).json();
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("Invalid consumer manifest");
  }
  writeFileSync(
    manifestPath,
    JSON.stringify({
      ...manifest,
      allowScripts: { "@google/genai": false, protobufjs: false },
    }),
  );
  await run(["npm", "ci", "--strict-allow-scripts", "--omit=dev", "--no-audit", "--no-fund"], consumer);
  rmSync(resolve(consumer, ".factory/state"), { recursive: true, force: true });
  rmSync(resolve(consumer, "visits"));
  await run([process.execPath, resolve(installed, "src/pi-test.ts"), "--smoke"], consumer);
  await run([process.execPath, resolve(consumer, "smoke.ts")], consumer);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
