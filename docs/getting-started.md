---
title: Getting started
description: Install Factory via npm, run your first pipeline, and set up a project with a short prompt.
---

Go from installation to a resumable workflow in your own project. No Factory checkout is needed.

## 1. Install Factory

With [Pi](https://github.com/earendil-works/pi) already installed, add Factory from npm:

```sh
pi install npm:pi-software-factory
```

You also need **[Bun 1.3+](https://bun.sh/docs/installation)** on your `PATH` for Factory's worker. There is no need to reinstall Pi or run a separate global `npm install` for Factory. Use `pi update` to update installed packages later.

## 2. Open your project

```sh
cd /path/to/your-project
pi
```

In Pi, use `/login` to connect your provider and `/model` to select an available model. You can also use existing provider credentials in Pi's `auth.json`; see the [user guide](guide.md#factory-in-pi).

:::note[Why a model?]
Factory starts through a real Pi agent turn. Even a pipeline containing only shell commands needs a configured model for kickoff. Validation does not call a model.
:::

## 3. Set up your project

In Pi, run:

```text
/factory init
```

`init` creates missing starter files and automatically sends a built-in setup prompt to your current Pi conversation. **A configured model is required**, and setup uses model calls and Pi's available tools to inspect and edit your project. No prompt needs to be copied manually.

The setup prompt asks Pi to inspect the project and its documentation, then interview you **one focused question at a time** (grill-me style). It challenges unclear assumptions, follows up where needed, and skips questions already answered by the repository. You can say “you decide” to request an evidence-based recommendation. Together you clarify outcomes, inputs, checks, correction paths, review/approval points, agent responsibilities, and tool access.

Pi derives the design from those answers, project conventions, and the Factory syntax documentation. It discusses whether specialist agents or independent review would help, but does not prescribe a builder, reviewer, agent count, or pipeline shape. If you choose independent code review, it should inspect correctness, regressions, and missing tests without modifying files, with findings routed for correction or surfaced before approval. Pi explains the proposed files and responsibilities and waits for your approval before creating or editing configuration; requested changes trigger a revised proposal. It should not add commit/push steps or start the pipeline. Review generated configuration; the prompt is guidance, not an execution sandbox.

In a project without pipelines, the initial scaffold includes `.factory/pipelines/hello.yml`, an agents directory, and an ignore file for local state. Repeating `init` preserves existing files during scaffolding but requests another model-assisted setup pass. Setup happens in Pi, not in a durable Factory run; `/factory resume` does not resume setup.

## 4. Validate and run

Wait for Pi's setup response, review the files, then select the generated pipeline:

```text
/factory validate
/factory run
```

For a small smoke test instead, validate and run `hello`; it prints `Hello from Factory`.

Prefer writing the configuration yourself? Copy the [complete agent example](syntax.md#complete-agent-example) and choose a model available from your provider.

:::caution[Trusted code, not a sandbox]
Pipelines and agent tools can execute commands and modify project files. Only run trusted configuration, make side effects safe to repeat, and never persist secrets as outputs.
:::

## Continue your work

| You want to… | In Pi |
| --- | --- |
| Start a workflow | `/factory run` |
| Continue interrupted work | `/factory resume` |
| Request a follow-up on a completed run | `/factory refine` |
| Check configuration without running it | `/factory validate` |

**Next:** [Command guide](guide.md) · [Pipeline syntax](syntax.md) · [How replay works](architecture.md#resume-refine-and-replay)
