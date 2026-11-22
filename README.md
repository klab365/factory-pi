# Factory for Pi

**A Pi extension for resumable software workflows.**

Factory adds `/factory` to Pi. Define shell commands, agent tasks, and human checkpoints in project-local YAML. Pi Durable records progress and agent history so you can pick up interrupted work and refine completed runs.

- Version pipelines, agents, and skills alongside your code.
- Route steps by status, bound review loops, and pause for human approval.
- Resume from saved checkpoints instead of repeating completed work.

## Get started in Pi

Install the extension once the npm package is published:

```sh
pi install npm:pi-software-factory
```

Or load it from a local Factory checkout. Install dependencies there with `bun install --frozen-lockfile`, then start Pi from your target project:

```sh
pi -e /path/to/factory-pi/src/pi-extension.ts
```

In Pi, run `/factory init` to create a starter project configuration. To try a pipeline with an approval step, save this as `.factory/pipelines/check.yml` in the target project:

```yaml
name: Check the project
steps:
  - id: test
    shell: bun test
  - id: accept
    human:
      prompt: Approve the result?
      choices: [approved, rejected]
    transitions:
      approved: end
      rejected: end
```

In Pi, select a model and run:

```text
/factory validate check
/factory run check
```

Use `/factory resume` to continue an interrupted run or `/factory refine` to start a follow-up round of a completed one. Pi needs a configured model to start the run, even when the pipeline only contains shell and human steps. Factory's built-in `agent:` steps also use Pi Durable; see the [syntax reference](docs/syntax.md) for a complete agent example.

## Set up Factory for a repository

To tailor Factory to an existing project, open that repository in Pi with Factory installed and paste this prompt into the coding agent. It interviews you before proposing configuration, then waits for approval before creating or changing files.

```text
Help me set up Factory for this repository. Interview me first; do not edit files until I approve your proposed configuration.

Start by inspecting the repository structure, existing project documentation, package/build/test configuration, and any existing `.factory/` pipelines and agents or `.agents/skills/`. Do not assume a framework, command, workflow, or convention that you have not found or confirmed.

Interview me one focused question at a time. Ask follow-up questions when an answer is ambiguous or exposes an important decision. Cover the outcomes I want automated, the steps and order, checks and commands, review or human approval points, which work should be handled by separate agents, each agent's responsibilities and tool access, reusable skills, and any integrations or secrets needed. Tailor questions to the repository; skip anything that is already clear from inspection. Let me say “you decide” and state your assumptions. Continue until the design is specific enough to implement without guessing.

Then summarize the proposed workflow and list every file you would create or change, explaining its purpose. Include appropriate `.factory/pipelines/*.yml`, `.factory/agents/*.md`, and `.agents/skills/<skill-name>/SKILL.md` files. Follow the Factory syntax reference at https://github.com/klab365/factory-pi/blob/main/docs/syntax.md; use only supported pipeline fields and ensure agent skill references point to skills you create. Reuse existing conventions and configuration where appropriate. Do not rely on an `AGENTS.md` file for Factory-specific behavior.

Ask me to approve this plan. If I request changes, revise the plan and ask again. After approval, create the files. Never overwrite or delete existing project files without asking me first; preserve unrelated content. Finally, summarize the files created or changed, note assumptions and any setup still needed, and give me the `/factory validate <pipeline-name>` commands to validate each generated pipeline.
```

## Documentation

| Page | What it covers |
| --- | --- |
| [User guide](docs/guide.md) | Pi setup, `/factory` commands, and credentials |
| [Syntax reference](docs/syntax.md) | Pipelines, agents, skills, templates, and outputs |
| [Architecture](docs/architecture.md) | The extension, runner process, state isolation, and replay |

## Development

```sh
mise install
mise run dev-pi            # Launch Pi with the local extension
mise run dev-pi -- --smoke # Check extension registration without a model
mise run check             # Format, lint, tests, TypeScript, and pipeline validation
```

Start the documentation site with `mise run docs:dev` and open <http://localhost:4321/factory-pi/>. Use `mise run docs:build` for a static build or `mise run docs:preview` to preview it locally.

The bundled `software-factory` pipeline implements and reviews a change, then asks for approval before committing and pushing. **Run it only on a separate branch with a clean worktree:** publishing commits all worktree changes and requires Git, Python, and `gh`.

## Operational limits

Factory is a prototype, not a sandbox. Treat pipeline YAML and agent instructions as trusted executable project code. Steps run sequentially; there are no automatic triggers. Shell side effects may be repeated after interruptions, so make commands idempotent. Do not commit `.factory/state/` or persist secrets as outputs.
