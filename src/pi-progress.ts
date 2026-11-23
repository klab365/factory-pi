type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}
/** Remove empty rows without changing indentation or meaningful line breaks. */
export function compactOutput(value: string): string {
  return value
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .join("\n")
    .trim();
}
function text(value: unknown): string {
  return typeof value === "string" ? compactOutput(value) : "";
}
function evidence(value: unknown): string {
  if (Array.isArray(value)) return value.map(evidence).filter(Boolean).join("; ");
  return text(value);
}

type Step = { label: string; kind: string; agent: string; result?: RecordValue };

/** Presentation only: raw events remain unchanged in the session timeline. */
export class FactoryProgress {
  private steps = new Map<string, Step>();
  private current = "";
  private waiting = false;
  private lines: string[] = [];

  constructor(private runId: string) {}

  accept(event: RecordValue): string | undefined {
    const id = text(event.stepId);
    let message = "";
    if (event.type === "saved-result") {
      this.steps.set(id, {
        label: text(event.name) || id,
        kind: text(event.kind),
        agent: text(event.agent),
        result: record(event.result),
      });
      return undefined;
    }
    if (event.type === "run") {
      message = `Factory: running ${text(event.pipeline) || "pipeline"}.`;
    } else if (event.type === "activity") {
      const step = {
        label: text(event.name) || id,
        kind: text(event.kind),
        agent: text(event.agent),
      };
      this.steps.set(id, step);
      this.current = step.label;
      this.waiting = false;
      const visit = typeof event.visit === "number" && event.visit > 1 ? ` (attempt ${event.visit})` : "";
      message = `${step.label}${step.agent ? ` — ${step.agent}` : ""}${visit}: ${step.kind === "human" ? "requesting your decision" : "working"}.`;
    } else if (event.type === "pending-input") {
      this.waiting = true;
      message = `Waiting for your response — ${this.current || id}.\n${text(event.prompt)}\n${Array.isArray(event.choices) ? `Choose: ${event.choices.filter((v) => typeof v === "string").join(", ")}. ` : ""}Respond in the Pi dialog; if dismissed, use /factory resume ${this.runId}.`;
    } else if (event.type === "step" && event.status === "completed") {
      const step = this.steps.get(id) ?? { label: id, kind: "", agent: "" };
      step.result = record(event.result);
      this.steps.set(id, step);
      this.waiting = false;
      const status = text(step.result.status);
      message = `${step.label}: ${status || "completed"}.`;
      if (status === "changes_requested" || status === "change_requested") {
        message += " Corrections requested; continuing to the configured correction step.";
      }
      const detail = text(step.result.feedback) || text(step.result.summary);
      if (detail) message += `\n${detail}`;
    }
    if (!message) return undefined;
    message = compactOutput(message);
    this.lines.push(message);
    return message;
  }

  progress(): string {
    return this.lines.join("\n");
  }

  summary(): string {
    const steps = [...this.steps.values()];
    const results = steps.filter((step) => step.result);
    const changes = results
      .filter((step) => step.kind !== "human" && step.kind !== "shell")
      .map(
        (step) =>
          `${step.label}${step.agent ? ` (${step.agent})` : ""}: ${text(step.result?.status)}${text(step.result?.summary) ? ` — ${text(step.result?.summary)}` : ""}`,
      );
    const checks = results.flatMap((step) => {
      const result = step.result ?? {};
      const reported =
        evidence(result.checks) || evidence(result.verification) || evidence(result.prVerification);
      return reported
        ? [`${step.label}: ${reported}`]
        : step.kind === "shell"
          ? [`${step.label}: completed (exit ${result.exitCode ?? "unknown"})`]
          : [];
    });
    const files = results
      .flatMap((step) => [evidence(step.result?.files), evidence(step.result?.artifacts)])
      .filter(Boolean);
    const decisions = results
      .filter((step) => step.kind === "human" || /review/i.test(`${step.agent} ${step.label}`))
      .map((step) => `${step.label}: ${text(step.result?.status)}`);
    return [
      `Factory ${this.runId}: pipeline completed.`,
      `Changes / results:\n${changes.join("\n") || "No agent change summary reported."}`,
      `Checks (reported):\n${checks.join("\n") || "No separate check results reported; see step summaries above."}`,
      `Review / decisions:\n${decisions.join("\n") || "No review or human decision reported."}`,
      `Files / artifacts (reported):\n${files.join("\n") || "No file paths reported; see step summaries above."}`,
      `Next: /factory refine ${this.runId} for follow-up work.`,
    ].join("\n");
  }

  interrupted(error: unknown, cancelled: boolean): string {
    return compactOutput(
      `Factory ${this.runId}: ${this.waiting ? "waiting for human input" : cancelled ? "cancelled" : "failed"}${this.current ? ` at ${this.current}` : ""}.\n${error instanceof Error ? error.message : String(error)}\n${this.waiting ? "Respond to the pending checkpoint" : "Resolve the interruption and retry"} with /factory resume ${this.runId}.`,
    );
  }
}
