---
title: Syntax reference
description: YAML pipelines, Markdown agents, skills, templates, and typed outputs.
---

This reference describes the current runner syntax. Paths are relative to the target project. `/factory validate <name>` checks a pipeline without calling a model. The runner also performs preflight checks before each run.

## File layout

```text
.factory/
  pipelines/feature.yml
  agents/builder.md
  state/                   # Local; do not commit
.agents/
  skills/typescript-expert/SKILL.md
```

Use the filename without its extension in Pi commands: `/factory run feature`. Pipeline files use `.yml`; agent definitions use `.md`.

## Complete agent example

`.factory/pipelines/feature.yml`:

```yaml
name: Implement a change with approval
inputs:
  goal:
    description: What should change?
    required: true
steps:
  - id: implement
    agent: builder
    maxVisits: 3
    task: |-
      Implement: ${{ inputs.goal }}
      Previous feedback: ${{ steps.accept.response }}
    transitions:
      completed: accept
  - id: accept
    maxVisits: 3
    human:
      prompt: Approve the change?
      choices: [approved, changes_requested, rejected]
    transitions:
      approved: end
      changes_requested: implement
      rejected: end
```

`.factory/agents/builder.md`:

```markdown
---
name: builder
description: Implements changes and adds tests
model: openai-codex/gpt-6.1-sol
thinking: medium
tools: [read, bash, edit, write]
---
Read the project instructions first. Implement and verify the change.
Report only the checks you actually ran.
```

The model ID is an example. Use a model available from your configured provider.

```text
/factory validate feature
/factory run feature
```

Enter the goal in Pi when prompted.

## Pipeline fields

| Field | Meaning |
| --- | --- |
| `name` | Display name; Pi selects by filename |
| `inputs` | Map of input names to definitions |
| `steps` | Non-empty list; execution starts at the first step |

Inputs support `description`, `required` (default: `true`), `default`, and `options` (allowed values). Runtime values are strings. An optional input with no value or default is omitted. Pi prompts for inputs and rejects missing required values.

```yaml
inputs:
  mode:
    description: Scope of checks
    default: quick
    options: [quick, full]
  note:
    required: false
```

Each step needs a unique `id` and **exactly one** of `shell`, `agent`, or `human`. Optional fields are `name`, `outputs`, `transitions`, and `maxVisits`. Agent steps also require `task`.

For agent, shell, and human steps, omitting `maxVisits` allows **unlimited visits**. When provided, `maxVisits` must be a positive integer and limits visits per round; validation rejects zero, negative, fractional, and nonnumeric values (including `null`). Resume preserves visit counts; refine starts a new round with fresh counts. Existing explicit limits remain enforced.

Unbounded cycles can run indefinitely; agent cycles can also consume model tokens, time, and money. Use explicit limits for bounded workflows and ensure every cycle has an exit transition. The example above deliberately bounds both implementation and acceptance to three visits.

Without `transitions`, execution advances to the next listed step or ends after the last. With `transitions`, the result status must have an entry pointing to a step ID or the reserved `end`. A missing entry or execution failure stops the run; there is no implicit error branch. The old `run:` and `captureOutput:` fields are rejected.

## Shell steps

```yaml
steps:
  - id: build
    shell:
      command: bun run build
      workingDirectory: packages/app
      env:
        BUILD_MODE: production
      timeout: 120000
      outputs: {stdout: true, stderr: false}
```

Use `shell: bun test` for a simple command. Commands run via `bash -lc` in the project root by default. `workingDirectory` is relative to that root and is not a sandbox boundary. `env` extends or overrides the process environment; supply strings as values. `timeout` is in milliseconds and terminates descendant processes too.

A successful command returns `status: completed` and `exitCode: 0`. A nonzero exit, timeout, or output overflow stops execution. Streams are displayed, but only explicitly selected streams are persisted as trimmed `stdout` or `stderr`. Selected streams share a 64 KiB UTF-8 limit.

## Human checkpoints

```yaml
steps:
  - id: approval
    human:
      prompt: Approve the result?
      choices: [approved, rejected]
    transitions:
      approved: end
      rejected: end
```

With `choices`, the selected value becomes the `status`. Without choices, Factory collects free text and returns `completed`. The `response` and `summary` contain the answer. Pi opens a selector or editor. Cancellation leaves the checkpoint pending. Use `/factory resume` to return to it. Factory persists accepted responses before downstream actions and reuses them during replay.

## Templates and outputs

- `${{ inputs.goal }}`: Run input.
- `${{ steps.build.stdout }}`: Raw result field.
- `${{ steps.build.outputs.report }}`: Declared, typed output.

Templates work in `task`, human prompts, and shell commands. Shell substitutions are quoted and inserted values are not re-evaluated as templates. Treat these values as data, not executable shell fragments. Direct result references may be empty on the first pass through a feedback loop. Typed outputs have statically checked producer dependencies.

```yaml
steps:
  - id: build
    shell:
      command: 'mkdir -p dist && printf "{}\n" > dist/report.json && printf "dist/report.json"'
      outputs: {stdout: true}
    outputs:
      report: {type: artifact, from: result.stdout}
      exit: {type: number, from: result.exitCode}
  - id: consume
    shell: 'cat ${{ steps.build.outputs.report }}'
```

`outputs.<name>` needs a `type` (`string`, `number`, `boolean`, or `artifact`) and a `from: result.<field>` reference. Nested agent result fields are supported. Missing or mismatched values fail the step; Factory does not coerce types. Every path to a consumer must pass through its named output producer. Forward references, self-references, and branches that skip the producer are invalid.

An `artifact` is a non-empty relative path without `..`, not an upload or snapshot. The producer must create the file, and callers must retain it. Each JSON-encoded output has a 64 KiB limit. Outputs are saved with step completion and reused on resume; refine regenerates them in the new round. **Do not select secrets.**

## Agent frontmatter and result protocol

| Field | Contract |
| --- | --- |
| `name` | Required; must match the filename without `.md` |
| `description` | Optional description |
| `model` | Optional `provider/model-id` |
| `thinking` | Optional: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | Optional list of tool names, e.g. `read`, `bash`, `edit`, `write` |
| `skills` | Optional list of project-local skill names |

Omitting `tools` leaves registered tools available; a list filters coding tools. Allowed handoff tools also derive from transitions. `tools: []` is not a sandbox. Markdown instructions follow the frontmatter; the runner appends selected skills and the result protocol.

Each agent turn ends with a structured block:

```text
<factory-result>{"status":"completed","summary":"Implemented the change","feedback":""}</factory-result>
```

Allowed statuses come from the step's transitions, or `completed` if there are none. Later tasks and output mappings can reference additional JSON fields. Transitions select the next pipeline step. Direct handoffs run separate child tasks and do not replace pipeline routing.

## Skills

Select skills explicitly with `skills: [typescript-expert]` in agent frontmatter. Factory resolves them only as `.agents/skills/<name>/SKILL.md`:

```markdown
---
name: typescript-expert
description: Safe TypeScript changes
---
Validate external inputs and add deterministic tests.
```

Names use lowercase ASCII letters and digits with single hyphens between segments and can be at most 64 characters. Duplicate references, paths, URLs, and global fallbacks are not supported. The frontmatter name must match the directory; the description and instructions cannot be empty. Symlinks cannot point outside the project.

Omitting `skills` or passing `[]` loads nothing; `null` is invalid. Preflight checks referenced skills, even on resume. The runner appends instructions in list order and ignores unreferenced files. Skills cannot grant tools or handoff permissions. Replay preserves the configuration of already admitted requests; new requests use the current definitions.
