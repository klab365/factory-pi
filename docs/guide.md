---
title: User guide
description: Install the Factory extension, run pipelines inside Pi, and develop the extension locally.
---

Factory adds `/factory` to Pi. It reads pipelines from `.factory/pipelines/` and agent instructions from `.factory/agents/` in your target project. The extension drives the interactive workflow; Pi Durable executes agent steps.

## Factory in Pi

New to Factory? Follow [Getting started](getting-started.md) for npm installation, your first run, and automatic project setup. This guide covers day-to-day use and development.

### npm installation warnings

Installation can succeed while npm warns about upstream dependencies:

- `node-domexception@1.0.0` is deprecated in favor of the platform's native `DOMException`. The dependency path is Factory → `@earendil-works/pi-durable` → `@earendil-works/pi-ai` → `@google/genai` → `google-auth-library` → `gaxios` → `node-fetch` → `fetch-blob` → `node-domexception`. `gcp-metadata` also introduces `gaxios`, and `formdata-polyfill` also introduces `fetch-blob`. The Pi coding-agent peer introduces Pi AI and the same Google dependency chain as well.
- `@google/genai` (observed at 2.21.0 and 2.32.0) declares a `preinstall` that only echoes `preinstall: no-op`. It builds or downloads nothing.
- `protobufjs@7.6.6`, introduced by `@google/genai`, declares `postinstall: node scripts/postinstall`. This script only checks a dependent's declared version range against its `~` version scheme and optionally prints a compatibility warning. It does not generate runtime files, compile native code, or download assets. The published JavaScript is ready to use without it.

**No script approval is needed for these packages.** Leave npm's install-script policy enabled; do not use `--dangerously-allow-all-scripts` or blanket approvals to suppress notices. A successful install with these warnings alone is not evidence of a Factory runtime failure. Factory has no install-time scripts of its own. A dependency's `allowScripts` or `overrides` field cannot impose policy on Pi's npm installation root, so Factory does not ship a misleading approval/override configuration.

The deprecation remains upstream: when investigated for issue #41, even current Pi AI 1.6.0 uses this chain; current `node-fetch` 3.3.2 and `fetch-blob` 4.0.0 still depend on the deprecated package. Updating Factory's Pi packages therefore would not remove it. Replacing Google's authentication HTTP stack or forcing an out-of-range override merely to hide the warning would risk provider compatibility. Removal requires an upstream migration, not enabling scripts.

CI runs `bun run test:package`: it packs the actual publishable files, installs the archive into a fresh temporary consumer using npm `--ignore-scripts --omit=dev` (including automatically installed peers), loads `/factory` in isolated offline Pi, constructs the Google SDK client, round-trips protobuf data, and executes/resumes a shell pipeline through the durable runner. It then reinstalls with npm's `--strict-allow-scripts` policy, explicitly denying only `@google/genai` and `protobufjs` in the temporary consumer root, and repeats the runtime checks. Any new unreviewed install scripts fail that policy check. No credentials or model calls are used. This verifies local loading, persistence and replay with **all** dependency install scripts disabled; it does not claim live Google/provider API coverage or exercise Pi's package-manager UI. The check needs registry access and uses the repository's Node/npm (npm 11.19.1 with install-script policy support) and Bun toolchain. Ordinary `bun test` remains network-free. New upstream versions or new script warnings should be reviewed separately.

### Load a local checkout

For extension development, install dependencies in the Factory checkout with `bun install --frozen-lockfile`. Then run this from the target project:

```sh
pi -e /path/to/factory-pi/src/pi-extension.ts
```

The pipeline runner executes in the Pi process; no separate Bun installation is required. Configure your model provider in Pi's `auth.json` (normally `~/.pi/agent/auth.json`, or under `PI_CODING_AGENT_DIR` if set). The durable runner reads and may update those credentials.

## Commands

| Command | Behavior |
| --- | --- |
| `/factory init` | Scaffold missing files, then start a project-aware interview in the current Pi conversation using the selected model. Pi asks one focused question at a time, clarifies assumptions, and derives pipelines and agents from your answers, project evidence, and Factory documentation. It discusses review needs without prescribing a builder/reviewer template, explains the proposed design, and waits for approval before editing configuration. No commit/push steps. Review generated files before validating and running. |
| `/factory validate [pipeline]` | Validate a pipeline without starting a run or calling a model. Omit the name to choose from project pipelines. |
| `/factory` or `/factory run` | Select a pipeline and collect inputs. |
| `/factory run software-factory` | Select that pipeline directly. The `goal` input opens a multiline editor; Escape cancels. |
| `/factory resume [runId]` | Continue interrupted work with its saved inputs and agent histories. Omit the ID to choose from interrupted runs. |
| `/factory refine [runId]` | Add a follow-up instruction to a completed run. A new round reuses agent histories but starts with fresh visit limits and outputs. Resume an interrupted round before refining again. |

Each new run creates an independent, named Pi session. Without an explicit ID, refine lists completed runs in the current worktree and automatically selects a single match. Factory normalizes symlinks and Git subdirectories; moving a checkout changes its workspace identity. Older records without an identity remain usable by explicit ID; a run known to belong to another worktree must be opened there.

Pi's kickoff invokes `factory_run` in a real agent turn and uses the selected Pi model even for a shell-only pipeline. Progress and the timeline are visible in Pi. Cancelling leaves the request available to resume and stops an active shell step; agent cancellation follows Durable's abort context. The runner executes in-process, while configured shell commands still run as child processes.

## Test the Pi extension locally

```sh
mise run dev-pi
mise run dev-pi -- --smoke
```

`dev-pi` uses a temporary agent directory, loads only the Factory extension, and uses a copy of `auth.json`; OAuth updates affect the copy. It does not load your normal extensions, MCP configuration, skills, prompts, themes, or project-local Pi configuration. Sessions remain under `.factory/state/pi-sessions`. The smoke test does not copy credentials or call a model; it uses RPC to check that `/factory` is registered. This isolates Pi configuration, **not** the project files. Do not run multiple Factory-enabled Pi processes in the same repository at once.

## Use the repository workflow

This workflow belongs to the Factory repository; `/factory init` does not install it into other projects.

:::caution[Publishing changes]
Start on a separate branch with a clean worktree. After human approval, this pipeline commits and pushes **all** worktree changes. It requires Python, Git push access, and authenticated `gh`.
:::

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

### Release notes and merge strategy

Keep using Conventional Commit PR titles and commits (`feat:`, `fix:`, and
`BREAKING CHANGE` / `!` for breaking changes). Merge commits, squash merges, and
rebases remain supported; no repository merge-setting change is required.
Release Please still uses Conventional Commits to choose the version, but
`release-please-config.json` selects `changelog-type: github` for the notes.
GitHub's generated release notes list merged PRs rather than individual commits,
so a merge commit containing the PR title and its constituent commit do not
produce two entries. Keep one logical change per PR. Multiple PRs with similar
titles are intentionally separate entries, not deduplicated by title.

The notes now use GitHub's “What's Changed” format with PR links and authors,
rather than Conventional Commit feature/fix sections. They can also include
documentation, test, and release PRs; these do not change Conventional Commit
version calculation. Direct pushes are not guaranteed a PR entry, so land
user-facing changes through PRs.

Historical duplicates in `CHANGELOG.md` (0.2.0, 0.3.0, 0.4.1, and 0.5.0) were
removed, retaining the original implementation commit links. Existing versions,
tags, and published GitHub releases are unchanged; do not republish old versions
just to update their notes.

To reproduce the non-publishing dry-run against the merge-heavy 0.5.0 history
(requires authenticated `gh` and `jq`):

```sh
gh api --method POST repos/klab365/factory-pi/releases/generate-notes \
  -f tag_name=pi-software-factory-v0.5.0 \
  -f previous_tag_name=pi-software-factory-v0.4.1 \
  -f target_commitish=9738c24 \
  --jq .body > /tmp/factory-pi-release-notes.txt
cat /tmp/factory-pi-release-notes.txt
jq -Rse '
  . as $notes |
  ["feat(init): interview users before designing project workflows",
   "feat(pi): show readable Factory progress and final summaries",
   "fix(pi): compact Factory run progress and result output"] |
  all(.[]; . as $title | ($notes | split($title) | length) == 2)
' /tmp/factory-pi-release-notes.txt
```

The assertion requires exactly one occurrence of each previously duplicated
change. This calls the same generated-notes API used by Release Please's GitHub
changelog strategy; it does not create a release or change tags.

### Run output

The `factory_run` tool shows named steps and agents, result summaries, correction
requests, and human checkpoints. Its final result separates changes, reported
checks, review/decisions, and reported file paths. Pipeline completion means the
configured route ended, not necessarily that a human approved it; consult the
reported decisions. Interrupted runs show the step and `/factory resume <runId>`.

Human checkpoints display their full question and review details in the Factory
output **before** opening the decision/input dialog. The dialog itself has a short,
fixed title pointing to the output above, so a long approval report does not expand
the dialog over the run output. Choices and responses are unchanged; dismissing
the dialog still leaves the checkpoint available to resume.

Agent summaries remain free-form. For separate final-summary sections, agents can
include `checks` (or `verification`) and `files` / `artifacts` as strings or lists of
strings in their `factory-result`. Reviewer `prVerification` is also displayed.
Factory labels these as reported evidence, not independently verified checks, and
explicitly says when no separate evidence was provided. Shell step exit results
are included automatically.

Raw events and shell output remain in `factory.timeline` session entries for
history/debugging; expand the timeline to inspect them. They are not streamed as
technical labels or JSON in the normal tool progress display. Resuming includes
reused durable step results in the summary without rerunning those steps.
