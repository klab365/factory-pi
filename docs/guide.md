---
title: User guide
description: Install the Factory extension, run pipelines inside Pi, and develop the extension locally.
---

Factory adds `/factory` to Pi. It reads pipelines from `.factory/pipelines/` and agent instructions from `.factory/agents/` in your target project. The extension drives the interactive workflow; Pi Durable executes agent steps.

## Factory in Pi

Install Pi separately if needed. Once the Factory package is published, install the extension with:

```sh
pi install npm:pi-software-factory
pi update
```

To load the extension from a checkout instead, run this from the target project:

```sh
pi -e /path/to/factory-pi/src/pi-extension.ts
```

Install Bun on `PATH`; the extension uses it to launch its internal worker. Configure your model provider in Pi's `auth.json` (normally `~/.pi/agent/auth.json`, or under `PI_CODING_AGENT_DIR` if set). The durable runner reads and may update those credentials.

| Command | Behavior |
| --- | --- |
| `/factory init` | Create a starter pipeline if none exists, an agents directory, and a local state ignore file. Existing files are preserved. |
| `/factory validate [pipeline]` | Validate a pipeline without starting a run or calling a model. Omit the name to choose from project pipelines. |
| `/factory` or `/factory run` | Select a pipeline and collect inputs. |
| `/factory run software-factory` | Select that pipeline directly. The `goal` input opens a multiline editor; Escape cancels. |
| `/factory resume [runId]` | Continue interrupted work with its saved inputs and agent histories. Omit the ID to choose from interrupted runs. |
| `/factory refine [runId]` | Add a follow-up instruction to a completed run. A new round reuses agent histories but starts with fresh visit limits and outputs. Resume an interrupted round before refining again. |

Each new run creates an independent, named Pi session. Without an explicit ID, refine lists completed runs in the current worktree and automatically selects a single match. Factory normalizes symlinks and Git subdirectories; moving a checkout changes its workspace identity. Older records without an identity remain usable by explicit ID; a run known to belong to another worktree must be opened there.

Pi's kickoff invokes `factory_run` in a real agent turn and uses the selected Pi model even for a shell-only pipeline. Progress and the timeline are visible in Pi. Cancelling stops the child process tree and leaves the request available to resume. See [Pi process boundary](architecture.md#pi-process-boundary) for the event protocol and cleanup behavior.

### Test the Pi extension locally

```sh
mise run dev-pi
mise run dev-pi -- --smoke
```

`dev-pi` uses a temporary agent directory, loads only the Factory extension, and uses a copy of `auth.json`; OAuth updates affect the copy. It does not load your normal extensions, MCP configuration, skills, prompts, themes, or project-local Pi configuration. Sessions remain under `.factory/state/pi-sessions`. The smoke test does not copy credentials or call a model; it uses RPC to check that `/factory` is registered. This isolates Pi configuration, **not** the project files. Do not run multiple Factory-enabled Pi processes in the same repository at once.

## Use the repository workflow

```sh
mise install
mise run check
mise run dev-pi
```

In Pi, run `/factory run software-factory` and enter your goal. This repository's pipeline sends the change from builder to reviewer. A review requesting changes returns to the builder; approval opens a human checkpoint. A human change request collects free text and sends it back with reviewer feedback. Visit limits bound the loop. A human rejection ends the run without publishing.

After human approval, the `publisher` agent commits the approved changes, pushes the current feature branch to `origin` without force-pushing, and creates a pull request if one is not already open. Start from a clean worktree on a separate branch. The publisher requires authenticated `gh` and Git push access. It uses the approved Conventional Commit title as the commit subject and PR title; a new PR includes the approved summary and verification, and closes only issues from the same repository that were referenced in the goal. If a PR is already open, it returns that PR without changing its title or body. Resume can reuse the existing commit and PR if the branch and worktree have not changed.

## Skills

Agent frontmatter explicitly selects reusable instructions, for example `skills: [typescript-expert]`. Each name maps to `.agents/skills/<name>/SKILL.md`. The runner loads only the selected instructions, in order, before the result protocol; linked files are not loaded automatically. Skills do not grant tools or handoff permissions. For the file contract and validation rules, see [Skills in the syntax reference](syntax.md#skills).

| Bundled skill | Agent | Purpose |
| --- | --- | --- |
| `typescript-expert` | Builder | TypeScript implementation and deterministic Bun tests |
| `systematic-debugging` | Builder | Reproduction, root-cause analysis, and regression tests |
| `code-review` | Reviewer | Correctness, security, and regression review |
| `verification-before-completion` | Builder and reviewer | Check current evidence before claiming completion |

The bundled skills are local checklists. References include Obra's [Systematic Debugging](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/systematic-debugging/SKILL.md) and [Verification Before Completion](https://github.com/obra/superpowers/blob/22f0b463e7a5e579904dd6211a520321035526f7/skills/verification-before-completion/SKILL.md). Factory does not load remote skills at runtime.

## CI and releases

`.github/workflows/ci.yml` runs `mise run check` for pull requests and pushes to `main`. `mise install` sets up the pinned toolchain and the postinstall hook installs Bun dependencies from `bun.lock`. Commit the updated lockfile after changing dependencies.

Conventional Commits on `main` drive Release Please in `.github/workflows/cd.yml`. The release PR updates the version and changelog. Merging it creates a GitHub release; the publish job verifies and packs that tag, then stages the Pi extension via npm Trusted Publishing (GitHub Actions OIDC). A maintainer must review and approve the staged version on npm before it becomes public. No `NPM_TOKEN` is needed. The trusted publisher for `pi-software-factory` must authorize `klab365/factory-pi`, workflow filename `cd.yml`, with no environment restriction and `npm stage publish` permission enabled. If using `RELEASE_PLEASE_TOKEN` to let release PRs trigger other workflows, configure an appropriate PAT or GitHub App token. GitHub must allow the workflow to create PRs.
