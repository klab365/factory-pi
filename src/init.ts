import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/** The setup runs in the current Pi conversation, not in a durable Factory run. */
export function setupPrompt(model: { provider: string; id: string }): string {
  return `Help me set up Factory for this repository. Interview me first (grill-me style);
do not create or edit project configuration until I approve the proposed plan.
1. Read AGENTS.md, project documentation, build/test configuration, and existing .factory/ pipelines,
   agents, and .agents/skills/. Inspect conventions and available check commands before asking questions.
   Preserve existing configuration and unrelated changes. Keep .factory/state/ ignored.
2. Ask one focused question at a time and wait for my answer. Challenge unclear assumptions and ask
   follow-up questions until the workflow is specific enough to implement without guessing.
   Cover desired outcomes, inputs, steps and order, checks, failure/correction paths, review and human
   approval points, agent responsibilities and tool access, reusable skills, and required integrations.
   Use Plan → Builder → Verify-guard → independent Review → Human approval → Publisher as the default
   for code changes, adapting names and checks to repository evidence. Failed shell checks stop the run
   and must be corrected before resuming. Skip questions already answered by the repository or docs.
   Let me say "you decide"; then make an evidence-based recommendation and state assumptions.
3. Discuss whether multiple specialist agents and independent review would help this workflow.
   Treat that standard code-change pipeline as a starting point, not a constraint: adapt or omit stages
   when repository evidence or my answers justify it. Derive the design from my answers, project evidence,
   and the Factory syntax documentation:
   https://klab365.github.io/factory-pi/syntax/
   Read that documentation before generating files; use only supported fields and syntax.
   If we choose independent review for code changes, place it after implementation/checks and before
   any final human approval step. Scope it to correctness, regressions, and missing tests without
   modifying files; route findings for correction and re-review or surface them before approval.
4. Summarize the proposed pipelines, agents, responsibilities, tool access, and files to create or
   change. Explain the choices, including whether independent review is useful, and note assumptions.
   Ask for my approval before editing. If I request changes, revise the plan and ask again.
5. After approval, create the agreed project-appropriate .factory/pipelines/<name>.yml and
   .factory/agents/<name>.md files using model ${model.provider}/${model.id} for agents.
   Add skills only where useful. Ensure referenced agents and skills exist, transitions match result
   statuses, feedback reaches correction tasks, and correction loops have explicit visit limits.
   Agent Markdown needs YAML frontmatter and project-specific instructions. Agents must end with a
   <factory-result> JSON block with status and summary, plus feedback when needed.
   Do not add commit/push steps or run the pipeline during setup.
6. Review the generated configuration for valid pipeline syntax, agent definitions, and transitions.
   Summarize changed files, decisions, and remaining setup. Tell me to run
   /factory validate <pipeline> before /factory run <pipeline>. Do not claim validation ran.`;
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
