---
title: Architecture
description: Why Factory uses pi-durable, how a run executes, and what survives interruption.
---

Factory turns project-local YAML into a resumable workflow inside Pi. **Factory decides what step comes next; `pi-durable` makes agent execution and stored state recoverable; Pi provides the interactive coding-agent session.** There is no central Factory server or public command-line executable.

For commands and setup, see the [user guide](guide.md). For configuration examples and contracts, see the [syntax reference](syntax.md).

## Why pi-durable?

A simple in-process runner could loop over steps, call a model, and keep results in memory. That works until the process dies during a long agent turn, a tool delegates work, or a human leaves an approval unanswered. Saving only the last pipeline step would lose the conversation and leave the runner unable to tell whether an agent request was already accepted.

Factory uses two levels of durability:

- **Pipeline checkpoints, owned by Factory:** saved inputs, results, output mappings, the current step, and visit counters let the dispatcher skip completed work and continue the selected route.
- **Agent execution, delegated to `pi-durable`:** the `Harness` manages persisted conversations, input submissions, model/tool tasks, checkpoints, and recovery. Stable request IDs let Factory reconnect to an admitted turn instead of starting another one. Task-owned child conversations make handoffs recoverable too.

Thus `pi-durable` is not the YAML workflow engine: Factory still implements shell steps, human checkpoints, status routing, loop limits, and refine rounds. Durable orchestrates the agent tasks underneath that workflow and supplies the transactional storage API used for Factory's records.

The trade-off is more machinery than an in-memory loop: journal storage, conversation mappings, request identities, recovery scoping, and compatibility with older records. State can contain sensitive prompts and outputs, must remain available, and is not a backup of the workspace. The runner executes in the Pi process; Durable contexts propagate cancellation for agent work, while shell steps still run in child processes. This is **not exactly-once execution** of arbitrary external effects.

## System overview

The arrows below show calls and data flow, not a single conversation shared by every component.

```text
Target project                         Installed Factory / Pi runtime
.factory/pipelines/*.yml -----+         Pi UI: /factory run
.factory/agents/*.md ---------+                  |
.agents/skills/*/SKILL.md -----+--> pi-extension.ts + pi-session.ts
                             |         | factory_run (native Pi tool)
                             |         | runPipeline(ctx.cwd)
                             |         v
                             +----> runner.ts (in-process sequential dispatcher)
                                   /         |             \
                              bash -lc   agent-runtime.ts   human checkpoint
                                             |              | keyed response
                                     pi-durable Harness     +---- Pi UI
                                      /              \
                               Pi model APIs     CodingTools / handoffs
                                      \              /
                                       conversations + tasks
                                             |
                             journal.ts + run-storage.ts
                                             |
                             .factory/state/durable/*.jsonl

Runner -- events --> Pi progress + factory.timeline
Pi session/run mapping -----------> .factory/state/pi-runs.json
```

The installed package supplies code; the **target project** supplies configuration, working directory, and run state. Pipeline steps are sequential, although an agent turn can invoke tools and delegate to child conversations.

## Who owns what?

| Component | Responsibility and boundary |
| --- | --- |
| Factory Pi extension | Registers `/factory` and `factory_run`, collects inputs, creates/reopens Pi sessions, displays progress, and presents human dialogs. It does not execute YAML in the kickoff model turn. |
| Factory pipeline and agent definitions | YAML defines steps, transitions, outputs, and limits. Agent Markdown defines instructions, model/tool choices, and selected skills. These are trusted project configuration, not Pi sessions. |
| Factory runner | Validate configuration, interpolate inputs/results, run shell commands, dispatch agent/human steps, persist step results and cursors, and route by status inside Pi. |
| `pi-durable` | Supplies `Harness`, conversations, transactional commits, input deduplication by request ID, model/tool task scheduling, recovery, and JSONL storage. Factory selects which run's task tree may recover. |
| Pi model and tool runtime | `pi-ai` supplies provider/model access. Durable's `CodingTools` and `NodeExecutionEnv` provide agent file and shell operations. Factory selects tools and adds pipeline-authorized handoff tools. |
| Native Pi session | `pi-coding-agent` provides extension APIs, session history, UI, and the outer model turn that calls `factory_run`; `pi-tui` renders Factory output. This session is distinct from Durable's agent conversations. |
| Supporting packages | `pi-schema` defines durable handoff tool arguments; Chord provides the context used by durable operations. Factory adapts Pi credentials for agent model providers. |

Factory parses an agent's final `<factory-result>` JSON and checks that its status is declared. It requests one result-only correction for an invalid result; a second invalid result fails the step. A valid result status such as `rejected` is **data for routing**, not necessarily an execution error. Ending a route does not prove approval or independently verify the checks an agent reports.

Handoffs are also distinct from pipeline transitions. Factory exposes `handoff_<source>_to_<target>` tools only for agent-to-agent edges allowed by the pipeline. A handoff runs a task-owned child conversation and returns its answer to the caller; it does not move the pipeline cursor. The dispatcher routes only after the current step returns.

### Source map

These links point to the implementation on the default branch:

| Source | Start here for |
| --- | --- |
| [`pi-extension.ts`](https://github.com/klab365/factory-pi/blob/main/src/pi-extension.ts) | Commands, kickoff, `factory_run` binding, session timeline |
| [`pi-session.ts`](https://github.com/klab365/factory-pi/blob/main/src/pi-session.ts) | Run catalog, workspace identity, and session mapping |
| [`runner.ts`](https://github.com/klab365/factory-pi/blob/main/src/runner.ts) | `runPipeline`, dispatcher, shell execution, checkpoints, transitions |
| [`pipeline-validation.ts`](https://github.com/klab365/factory-pi/blob/main/src/pipeline-validation.ts), [`pipeline-inputs.ts`](https://github.com/klab365/factory-pi/blob/main/src/pipeline-inputs.ts) | Shared preflight, YAML loading, path boundaries, input rules |
| [`agent-runtime.ts`](https://github.com/klab365/factory-pi/blob/main/src/agent-runtime.ts) | Agent configuration, submissions, handoffs, result parsing |
| [`journal.ts`](https://github.com/klab365/factory-pi/blob/main/src/journal.ts) | `openJournal`, run/agent mappings, checkpoint restoration |
| [`run-storage.ts`](https://github.com/klab365/factory-pi/blob/main/src/run-storage.ts) | Recovery and queued-input admission scoping before `Harness.open` |
| [`human.ts`](https://github.com/klab365/factory-pi/blob/main/src/human.ts), [`step-outputs.ts`](https://github.com/klab365/factory-pi/blob/main/src/step-outputs.ts) | Response and output validation |
| [`skills.ts`](https://github.com/klab365/factory-pi/blob/main/src/skills.ts), [`pi-credentials.ts`](https://github.com/klab365/factory-pi/blob/main/src/pi-credentials.ts) | Instruction assembly and provider credential adapter |

## Run lifecycle

Consider a pipeline with an agent step, a shell check, and a human decision, as described in the [syntax reference](syntax.md).

1. **Select and validate.** `/factory run` selects project YAML, validates the pipeline and referenced agents/skills/outputs, then collects inputs in Pi. `/factory validate` stops after preflight and needs no model.
2. **Create the kickoff.** The extension generates a run ID and a pending request ID, creates a named native Pi session, and saves its mapping in `pi-runs.json`. It dispatches a message asking the selected Pi model to call `factory_run`. This outer turn needs a model even for shell-only pipelines; pipeline agents have their own configuration.
3. **Enter the runner.** `factory_run` verifies the run, pending request, and native session binding, then invokes `runPipeline` in the Pi process with the target project directory and request data.
4. **Open the selected durable state.** `openJournal` opens local JSONL storage. `scopeRunStorage` restricts task recovery and queued-input admission **before** `Harness.open`. A new run gets its own run conversation, atomically created with its mapping in the root index. Resume restores saved inputs, cursor, results, and agent mappings. The harness scheduler is then started.
5. **Execute a step visit.** The dispatcher saves a cursor and a `factory.step` started record. A shell step runs `bash -lc`; an agent step submits an input to its durable conversation; a human step follows the checkpoint protocol below. A saved completed result is reused instead of executing that visit again.
6. **Run an agent turn.** Factory opens or creates the conversation for `(runId, agentName)`. For a new request it configures instructions, selected skills, model, tools, and handoffs. It submits with a deterministic ID derived from run, round, step, and visit, waits for Durable's model/tool execution, then parses the final result. An already admitted request keeps its original configuration and child tasks on recovery.
7. **Persist and route.** Output mappings are validated, then the completed step result is persisted **before** routing. Factory chooses the transition for the returned status (or the next ordered step), checks visit limits, and persists the next cursor. A crash between result and cursor can reuse that result and compute the transition again.
8. **Pause for a human.** Factory writes `factory.human.pending`, emits `pending-input` with the checkpoint key, and waits. Pi displays the full prompt before opening a compact dialog. The keyed response is validated and becomes a completed step result. Dismissing the dialog interrupts the run; resume presents the unfinished checkpoint again rather than inventing a response.
9. **Finish or interrupt.** Reaching `end` records `factory.run` completed in the index, then emits `completed`; Pi clears the pending request and updates its catalog. Execution errors record a failed step when they occur inside step execution, stop dispatch, and close the harness. The run remains unfinished so it can be resumed; there is no automatic rollback or automatic pipeline-level retry loop.

## Persistence and isolation

There are two histories, with different jobs:

| State | What it contains |
| --- | --- |
| `.factory/state/pi-runs.json` | Run-to-native-session mapping, workspace identity, goal/date, started/completed status, and pending kickoff request. This is a UI catalog, not the execution checkpoint store. |
| Native Pi session file | Human kickoff, outer tool turn, and `factory.timeline` entries including runner events and shell output. The catalog stores its path; the local development launcher uses `.factory/state/pi-sessions`. |
| `.factory/state/durable/*.jsonl` | Durable conversations, submissions, model/tool task state, and Factory entries: root `factory.run` index, `factory.agent` mappings, `factory.round`, `factory.cursor`, `factory.step` results, and pending human prompts. |
| Project filesystem | Actual edited files and artifacts. They are shared by all agents and are **not** snapshotted by the journal. |

| Identity | Purpose |
| --- | --- |
| `runId` | Independent run with its own inputs and results |
| Run conversation | Cursor, step checkpoints, round state, and agent mappings |
| `(runId, agentName)` | Agent history reused across visits and refine rounds within one run |
| Handoff child | Delegated task under its owning durable tool task |
| Round / step / visit | Distinguishes follow-up rounds and loop iterations |
| Request ID | Reattaches to an admitted input; the outer Pi request and inner agent submissions use separate IDs |

Different agents do not share a conversation; structured results and feedback pass through templates. Conversation isolation is **not** worktree, process, or security isolation.

Run/agent mappings are saved atomically with conversation creation. Resume opens those exact records and fails if one is missing rather than silently replacing history. Legacy runs preserve their original root conversation and already admitted requests. Ambiguous interrupted legacy runs on the same root are rejected rather than recovering unrelated work.

`run-storage.ts` filters both live-task recovery and pending-input admission to the run conversation, its agents, and transitive task-owned children. Restricting only the visible conversation would not suffice: the harness scheduler otherwise operates over shared storage.

## Resume, refine, and replay

- **New run:** Creates an independent native Pi session and fresh durable run/agent conversations.
- **Resume:** Reopens the mapped Pi session, continues with saved inputs and histories, skips completed step visits, and reconnects to admitted agent requests. Failed or uncheckpointed shell/human visits can execute again.
- **Refine:** Starts a new round of a completed run, adding the follow-up instruction to the saved goal. Agent histories remain; outputs and visit counts start fresh for that round. Resume an interrupted round before refining again. The outer request ID prevents the same refine request from creating another round on replay.

The catalog stores canonical repository/worktree identities. Refine selection is scoped to the current worktree and rejects an explicit ID known to belong elsewhere; older records without identity remain usable by explicit ID. Keep both the Pi session and durable state if you need to continue a run.

### External effects are not exactly-once

A crash can occur after a shell command writes a file, calls an API, or pushes a commit but before its Factory checkpoint is saved. Resume can run that step again: treat such effects as **at-least-once**, using idempotent commands or external deduplication.

Inside an agent turn, Durable applies each tool's replay policy: a replay-safe interrupted tool can rerun; an unsafe one can return an interruption error instead. Stable submission IDs prevent duplicate admission, not duplicate external effects. Provider retries and interrupted requests can still incur additional model calls. Durable recovery is not a guarantee that every failed task will eventually succeed.

Saved outputs are values, not snapshots: a saved artifact path does not guarantee the file still exists. Factory revalidates and reads current project configuration on invocation, rather than replaying a frozen copy of YAML and agent files. Avoid changing step IDs, routes, or required files under an interrupted run; fix the underlying error and inspect saved history before resuming. Do not edit real journals to force recovery.

## Pi execution and cancellation

The Pi extension invokes the runner directly in-process and forwards runner events to progress updates and the session timeline. The durable journal stores checkpoints independently of the Pi transcript. Pi cancellation is propagated through the runner to shell processes and Durable agent contexts; shell descendants are terminated as a process group. Session switching is blocked during active work, and interrupted requests remain available for resume. Do not run multiple Factory-enabled Pi processes in the same repository at once.

## Trust and limits

Pipeline YAML, agent Markdown, and skills are trusted project configuration. Shell steps run with the user's environment, and agent tools can modify files and execute commands. Path checks and tool allowlists are not a sandbox. The durable runner can update provider credentials in `~/.pi/agent/auth.json` (or the configured Pi agent directory). Prompts, responses, inputs, and selected outputs can persist secrets: review what you store, protect state/session files, and keep `.factory/state/` out of Git.

Steps have no automatic triggers. Publishing or deployment is an explicit configured step, not a built-in consequence of completion. See the [user guide](guide.md#use-the-repository-workflow) for this repository's approval and publishing workflow.

## Verification

The source map and lifecycle above track the current Factory implementation. Relevant regression tests cover [journal recovery](https://github.com/klab365/factory-pi/blob/main/tests/journal.test.ts), [runner checkpoints](https://github.com/klab365/factory-pi/blob/main/tests/runner.test.ts), and [Pi tool/session behavior](https://github.com/klab365/factory-pi/blob/main/tests/pi-session.test.ts).

`bun run check` runs format, lint, Bun tests, TypeScript checks, and repository pipeline validation. Tests use deterministic fixtures and test providers. `bun run docs:build` checks the documentation build. The Pi smoke test checks extension registration without credentials or model calls; it does not verify live provider availability.
