import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** The setup runs in the current Pi conversation, not in a durable Factory run. */
export function setupPrompt(model: { provider: string; id: string }): string {
  return `Set up a minimal Factory workflow for this project.
1. Read AGENTS.md and inspect the project conventions and available check commands.
2. Preserve existing Factory configuration and unrelated changes. Keep .factory/state/ ignored.
3. Create a project-appropriate builder agent and a pipeline with a required goal input,
   implementation and checks, then a human approval step. Use model ${model.provider}/${model.id}.
   Do not add commit/push steps or run the pipeline during setup.
4. Review the generated configuration. Summarize changed files and tell the user to run
   /factory validate <pipeline> before /factory run <pipeline>. Do not claim validation ran.

Factory files: .factory/pipelines/<name>.yml and .factory/agents/<name>.md.
Minimal pipeline shape (adapt names and tasks; keep the approval gate):
name: Project workflow
inputs:
  goal:
    description: What should change?
    required: true
steps:
  - id: implement
    agent: builder
    task: 'Implement and check: \${{ inputs.goal }}'
  - id: accept
    human:
      prompt: Approve the change?
      choices: [approved, rejected]
    transitions:
      approved: end
      rejected: end

Agent Markdown needs YAML frontmatter with name, description, model, and
tools: [read, bash, edit, write], followed by project-specific implementation and check instructions.
Full syntax: https://klab365.github.io/factory-pi/syntax/`;
}

/** Bootstrap only missing files; project-owned configuration is never overwritten. */
export function initProject(root: string): string[] {
  for (const folder of ["pipelines", "agents"]) {
    mkdirSync(resolve(root, ".factory", folder), { recursive: true });
  }
  const pipelines = resolve(root, ".factory/pipelines");
  if (!readdirSync(pipelines).some((name) => name.endsWith(".yml"))) {
    writeFileSync(
      resolve(pipelines, "hello.yml"),
      'name: Hello Factory\nsteps:\n  - id: hello\n    shell: "echo Hello from Factory"\n',
      { flag: "wx" },
    );
  }
  const ignore = resolve(root, ".factory/.gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "state/\n", { flag: "wx" });
  return listPipelines(root);
}

export function listPipelines(root: string): string[] {
  const pipelines = resolve(root, ".factory/pipelines");
  if (!existsSync(pipelines)) return [];
  return readdirSync(pipelines)
    .filter((name) => name.endsWith(".yml"))
    .map((name) => name.slice(0, -4));
}
