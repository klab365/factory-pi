import { validatePipeline } from "../../src/pipeline-validation";
import { runPipeline } from "../../src/runner";

// Test-only entry point for runner cases that do not need a Pi session.
const [command, name, ...args] = Bun.argv.slice(2);
try {
  if (command === "validate") {
    validatePipeline(process.cwd(), name);
    console.log(`Pipeline valid: ${name}`);
  } else {
    const response = args.find((arg) => arg.startsWith("--human-response="));
    let consumed = false;
    await runPipeline(
      name,
      args.filter((arg) => arg !== response),
      undefined,
      undefined,
      async () => {
        if (!response) throw new Error("Human response required");
        if (consumed) throw new Error("Another human response is required");
        consumed = true;
        return response.slice("--human-response=".length);
      },
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
