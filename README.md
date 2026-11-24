# Factory for Pi

[![Documentation](https://img.shields.io/badge/docs-GitHub%20Pages-blue)](https://klab365.github.io/factory-pi/)

**[Documentation](https://klab365.github.io/factory-pi/)** · [Getting started & automatic setup](https://klab365.github.io/factory-pi/getting-started/) · [Syntax reference](https://klab365.github.io/factory-pi/syntax/)

**Resumable software workflows inside the Pi coding agent.**

Define shell commands, agent tasks, and human checkpoints in project-local YAML. Factory records progress and agent history so you can resume interrupted work or refine completed runs.

## Get started

With [Pi](https://github.com/earendil-works/pi) installed:

```sh
pi install npm:pi-software-factory
pi
```

npm may report upstream `node-domexception` deprecation and blocked install-script warnings for `@google/genai` and `protobufjs`. These scripts are not required; **do not approve them just to silence warnings**. See [installation warnings](https://klab365.github.io/factory-pi/guide/#npm-installation-warnings) for the dependency trace and verification scope.

Select a configured model in Pi, then run `/factory init` in your project. Pi inspects the project and interviews you one focused question at a time (grill-me style), clarifying goals, checks, review needs, and responsibilities. It derives pipelines and agents from your answers, project conventions, and Factory documentation—not a prescribed builder/reviewer template. It explains the design and waits for your approval before editing configuration. Review the generated workflow, then use `/factory validate` and `/factory run` to select it.

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

### Run output

Factory groups progress and results in the **Factory run** tool output without empty padding rows. Internal timeline events are hidden by default and retained unchanged in the Pi session history. To render them, enable expanded tool output before loading the session (Pi may omit hidden entries from the live view). The final report includes results, reported checks, decisions, artifacts, and `/factory refine` for follow-up work. Failures and dismissed human checkpoints show `/factory resume`; checkpoint details remain visible above the response dialog.

Pi controls its startup/help banner, project trust notices, kickoff user-message layout, and spacing between host transcript components. Factory does not suppress those notices or change global Pi settings. Factory's compact rendering is covered by `bun test tests/pi-rendering.test.ts` at 32- and 80-column widths, without model calls.

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
| [User guide](https://klab365.github.io/factory-pi/guide/) | Pi setup, `/factory` commands, and credentials |
| [Syntax reference](https://klab365.github.io/factory-pi/syntax/) | Pipelines, agents, skills, templates, and outputs |
| [Architecture](https://klab365.github.io/factory-pi/architecture/) | Why pi-durable, component boundaries, run lifecycle, and recovery trade-offs |

## Development

```sh
mise install
mise run dev-pi            # Pi with the local extension
mise run dev-pi -- --smoke # Registration check; no model needed
mise run check            # Format, lint, tests, types, pipeline validation
bun run test:package      # Pack + fresh npm install without scripts (registry access)
mise run docs:dev         # Documentation at localhost:4321/factory-pi/
```

See the [user guide](https://klab365.github.io/factory-pi/guide/) for local loading and the repository's build/review workflow.

Factory is not a sandbox: only run trusted pipelines, make side effects idempotent, and keep secrets and `.factory/state/` out of Git. The repository's `software-factory` pipeline commits and pushes **all** worktree changes after approval; use a separate branch and start with a clean worktree.
