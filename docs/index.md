---
title: Factory for Pi
description: Turn project-local YAML into resumable workflows inside the Pi coding agent.
---

**Define the workflow. Let agents work. Stay in control.**

Factory adds `/factory` to Pi: combine shell commands, agent tasks, and human checkpoints in project-local YAML. Progress and agent history are saved so interrupted work can resume without starting over.

## Start here

**[Get started →](getting-started.md)** Install with npm, run your first pipeline, and let `/factory init` set up a workflow for your project.

## Find your way

| Page | What you'll find |
| --- | --- |
| [Getting started](getting-started.md) | Installation, automatic setup, and first run |
| [User guide](guide.md) | Commands, credentials, local development, and the repository workflow |
| [Syntax reference](syntax.md) | Copyable pipelines, agent definitions, skills, and outputs |
| [Architecture](architecture.md) | How execution, isolation, and replay work |

## Work at your own pace

- **Run** a pipeline and approve important steps in Pi.
- **Resume** interrupted work with saved inputs and agent histories.
- **Refine** a completed run with a follow-up instruction.

:::caution[Run only trusted workflows]
Factory is not a sandbox. Commands and agents can change project files. Keep side effects idempotent and secrets out of saved outputs.
:::
