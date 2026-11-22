import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { runChild } from "../src/pi-session";

test("standalone runtime initializes, runs, resumes and serves Pi without Bun on PATH", async () => {
  const folder = mkdtempSync(resolve(tmpdir(), "factory-standalone-"));
  const target = resolve(folder, "target");
  const binary = process.env.FACTORY_TEST_BINARY ?? resolve(folder, "factory");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(target);
  const previousPath = process.env.PATH;
  const previousBinary = process.env.FACTORY_BIN;
  try {
    if (!process.env.FACTORY_TEST_BINARY) {
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          resolve(import.meta.dir, "../src/cli.ts"),
          "--outfile",
          binary,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      expect(build.exitCode).toBe(0);
    }
    // Keep system bash available, but exclude package managers and user-installed Bun.
    process.env.PATH = "/usr/bin:/bin";
    process.env.FACTORY_BIN = binary;
    const run = (...args: string[]) => {
      const result = Bun.spawnSync([binary, ...args], { cwd: target, stdout: "pipe", stderr: "pipe" });
      expect(new TextDecoder().decode(result.stderr)).not.toContain("✗");
      expect(result.exitCode).toBe(0);
    };
    run("init");
    writeFileSync(
      resolve(target, ".factory/pipelines/hello.yml"),
      'steps:\n  - id: work\n    shell: "printf standalone > marker"\n',
    );
    run("validate", "hello");
    run("run", "hello");
    expect(readFileSync(resolve(target, "marker"), "utf8")).toBe("standalone");
    const events: Record<string, unknown>[] = [];
    await runChild(target, { mode: "new", runId: "standalone-pi", pipeline: "hello", inputs: {} }, (event) =>
      events.push(event),
    );
    expect(events.some((event) => event.type === "completed")).toBe(true);
    // Replaying the same session uses the stored checkpoint, not the changed command.
    writeFileSync(resolve(target, "marker"), "preserved");
    await runChild(
      target,
      { mode: "resume", runId: "standalone-pi", pipeline: "hello", inputs: {} },
      () => {},
    );
    expect(readFileSync(resolve(target, "marker"), "utf8")).toBe("preserved");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousBinary === undefined) delete process.env.FACTORY_BIN;
    else process.env.FACTORY_BIN = previousBinary;
    rmSync(folder, { recursive: true, force: true });
  }
}, 30000);
