---
title: Architecture
description: Execution, state isolation, recovery, and replay in Factory.
---

Factory is a Pi extension backed by a sequential, project-local pipeline runner built on Pi Durable. YAML defines control flow; Markdown defines agent instructions. The extension owns the interactive experience, while a separate runner process executes the pipeline. Factory has no public command-line executable.

## System overview

```text
                           Pi UI (/factory)
                                        │
                           pi-extension.ts / pi-session.ts
                                        │ JSON stdin / JSONL stdout
                                    worker.ts
                                        │
                                    runner.ts
                                        │
                              Validation and inputs
                                        │
                               Sequential dispatcher
                              /         |          \
                       bash -lc      Agent turn   Human checkpoint
                                        │
                                 agent-runtime.ts
                                        │
                                Pi Durable harness
                                        │
                            journal.ts + run-storage.ts
                                        │
                          .factory/state/durable/*.jsonl
```

The installed package provides the extension, worker, and runtime. Configuration, the working directory, and run state come from the **target project**. There is no central Factory server or database outside the local journal.

## Module boundaries

| Module under `src/` | Responsibility |
| --- | --- |
| `worker.ts` | Private JSON/JSONL process entry point |
| `runner.ts` | Shell processes, dispatch, transitions, and events |
| `pipeline-validation.ts` | Shared validation for Pi, worker preflight, and CI |
| `pipeline-inputs.ts` | Load YAML, enforce path boundaries, and validate pipeline inputs |
| `agent-runtime.ts` | Agent definitions, models, tools, handoffs, and result parsing |
| `skills.ts` | Validate project-local skills and assemble agent instructions |
| `human.ts` | Validate prompts and responses |
| `step-outputs.ts` | Validate output declarations, path dependencies, and runtime types |
| `journal.ts` | Persist and restore run and agent conversations, cursors, and checkpoints |
| `run-storage.ts` | Scope recovery and input admission to the selected conversation tree |
| `pi-extension.ts` | Pi commands, session mapping, UI, and tool integration |
| `pi-session.ts` | Child process, event protocol, and process cleanup |
| `pi-credentials.ts` | Provider credentials for the harness |
| `init.ts` | Non-destructive project scaffolding |
| `pi-test.ts` | Isolated Pi development environment and smoke test |

## Run lifecycle

1. Preflight checks the pipeline, agents, selected skills, and output references before opening the journal or executing steps.
2. The runner selects a new or existing run. It sets the storage scope **before** `Harness.open` so recovery cannot activate unrelated tasks.
3. New runs collect inputs. Resume loads inputs from the journal.
4. The dispatcher executes the current step visit or reuses its saved successful result.
5. Shell steps return process results, agents return Factory result JSON, and human steps return validated responses. Output mappings are checked at this boundary.
6. The runner persists completion and outputs before routing by status. The cursor and visit counters track progress and bound loops.
7. `end` completes the run. Execution errors stop it, and the runner closes the harness.

## Persistence and isolation

| Identity | Purpose |
| --- | --- |
| `runId` | Independent run with its own inputs and results |
| Run conversation | Cursor, step checkpoints, and run state |
| `(runId, agentName)` | Agent history reused across visits within one run |
| Handoff child | Delegated task under its owning conversation |
| Round / step / visit | Distinguishes refine rounds and loop iterations |
| Request ID | Recovers already admitted agent calls |

Each new run starts fresh run and agent conversations. Repeated visits by the same agent reuse its history; different agents do not share a conversation. Structured results and feedback pass through templates. **The filesystem is shared:** conversation isolation is not worktree or process isolation.

Mappings are saved atomically with their conversations. Resume opens those exact records and fails if one is missing rather than starting a replacement. Legacy runs keep their original root conversation and already admitted requests. Ambiguous interrupted legacy runs on the same root are rejected instead of recovering unrelated work.

`run-storage.ts` restricts both live-task recovery and pending-input admission to the run conversation, its agents, and their transitive handoff children. Filtering only the visible conversation would not be enough because the harness scheduler otherwise operates over shared storage.

## Resume, refine, and replay

- **New Pi run:** Creates an independent Pi session and fresh durable conversations.
- **Resume:** Continues unfinished work with its saved inputs and conversations. It skips successful checkpoints and recovers pending requests.
- **Refine:** Opens a new round of a completed run with a follow-up instruction and existing agent history. Visit limits and outputs start fresh for the round. Resume an interrupted round before refining again.

`.factory/state/pi-runs.json` maps run IDs to Pi sessions and canonical workspace identities; the durable journal holds the execution checkpoints. Pi rejects IDs known to belong to a different worktree. Older entries without workspace identity remain available by explicit ID.

### External effects are not exactly-once

A crash can occur after an external action (such as a file write, API call, or push) and before its checkpoint. The step may run again: **at-least-once**. Make those actions idempotent or deduplicate them separately. Saved outputs are values, not snapshots; a saved artifact path does not guarantee that the file still exists.

## Pi process boundary

The extension starts the internal Bun worker without interpolating user inputs into a shell command. It sends a JSON request over stdin and receives JSONL events over stdout. Logs go to stderr in session mode. Human responses are bound to the current checkpoint.

A real Pi agent turn invokes the registered `factory_run` tool, which checks the run, request, and native session binding. Session monitors can see active tool work, and reopening the session preserves the timeline. The Pi kickoff needs the selected model even for a shell-only pipeline.

Session switching is blocked during active work. On POSIX, cancellation, shutdown, and event-processing errors terminate the process group with SIGTERM, then SIGKILL after 300 ms. The pending request remains available for resume. Do not run multiple Factory-enabled Pi processes in the same repository at once.

## Trust and limits

Pipeline YAML, agent Markdown, and skills are trusted project configuration. Shell steps run with the user's environment, and agent tools can modify files and execute commands. Path checks and tool allowlists are not a sandbox. The durable runner can update provider credentials in `~/.pi/agent/auth.json`. Review selected outputs before persisting them.

Steps are sequential and have no automatic triggers. This repository's publishing step is an explicit shell step after human approval, not an implicit feature of every run.

## Verification

`bun run check` runs format, lint, Bun tests, TypeScript checks, and repository pipeline validation. Tests use deterministic fixtures and test providers. The Pi smoke test checks extension registration without credentials or model calls; it does not verify live provider availability.
