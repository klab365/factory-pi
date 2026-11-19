import { describe, expect, test } from "bun:test";

function runCli(...args: string[]) {
  const result = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], {
    cwd: `${import.meta.dir}/..`,
    stdout: "pipe",
    stderr: "pipe",
  });
  const decoder = new TextDecoder();
  return {
    exitCode: result.exitCode,
    output: decoder.decode(result.stdout) + decoder.decode(result.stderr),
  };
}

describe("factory CLI", () => {
  test("validates the software-factory pipeline", () => {
    const result = runCli("validate", "software-factory");
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("Pipeline valid: software-factory");
  });

  test("rejects unknown pipeline inputs", () => {
    const result = runCli("run", "software-factory", "--unknown=value");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Unknown pipeline input: unknown");
  });

  test("requires goal input for software-factory", () => {
    const result = runCli("run", "software-factory");
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Missing required input 'goal'");
  });
});
