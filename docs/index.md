---
title: Factory for Pi
description: Run and resume project-local workflows from the Pi coding agent.
---

Factory is a Pi extension that runs shell commands, agent tasks, and human checkpoints as resumable YAML pipelines. Configuration stays in your project, and Pi Durable records results and agent histories in a local journal.

## Quick start

1. [Install or load the extension](guide.md#factory-in-pi).
2. [Define a pipeline in your project](syntax.md).
3. Open Pi in the project and run `/factory run` to select the pipeline. Use `/factory resume` to continue interrupted work or `/factory refine` for a follow-up round.

Pi needs a configured model for the kickoff, even if the selected pipeline only runs shell commands. For the execution and replay details, see [Architecture](architecture.md).

Factory is not a sandbox. Only run trusted pipelines, make side effects idempotent, and do not persist secrets as outputs.
