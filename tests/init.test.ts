import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const runtime = resolve(import.meta.dir, "../src/cli.ts");
test("runtime checkout bootstraps, validates and executes a separate target without overwriting configuration", () => {
  const target = mkdtempSync(resolve(tmpdir(), "factory-target-"));
  const run = (...args: string[]) => {
    const result = Bun.spawnSync([process.execPath, runtime, ...args], {
      cwd: target,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(new TextDecoder().decode(result.stderr)).not.toContain("✗");
    expect(result.exitCode).toBe(0);
  };
  try {
    run("init");
    expect(readFileSync(resolve(target, ".factory/.gitignore"), "utf8")).toBe("state/\n");
    const pipeline = resolve(target, ".factory/pipelines/hello.yml");
    const custom = 'steps:\n  - id: work\n    shell: "printf target > marker"\n';
    writeFileSync(pipeline, custom);
    run("init");
    expect(readFileSync(pipeline, "utf8")).toBe(custom);
    run("run", "hello");
    expect(readFileSync(resolve(target, "marker"), "utf8")).toBe("target");
    writeFileSync(pipeline, "steps: []\n");
    const invalid = Bun.spawnSync([process.execPath, runtime, "init"], { cwd: target });
    expect(invalid.exitCode).toBe(1);
    expect(readFileSync(pipeline, "utf8")).toBe("steps: []\n");
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
