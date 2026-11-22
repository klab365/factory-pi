---
name: conventional-commits
description: Create and maintain Conventional Commit messages for changes, releases, and pull requests.
---

# Conventional commits

Use this skill whenever creating commits or pull requests in this repository.

## Commit format

Use the Conventional Commits format:

```text
<type>(<optional scope>): <imperative summary>
```

Common types:

- `feat`: user-facing capability; may trigger a minor release.
- `fix`: bug fix; may trigger a patch release.
- `docs`: documentation only.
- `refactor`: code change without a behavior fix or feature.
- `test`: tests only.
- `build`, `ci`, `chore`: tooling, automation, or maintenance.

Use a concise, imperative summary in lowercase after the colon. Add a body when context is useful. Mark breaking changes with `!` before the colon and explain them with a `BREAKING CHANGE:` footer.

Examples:

```text
fix(release): use staged npm publishing
feat(pipeline): support step timeouts
```

## Before creating a PR

1. Inspect the final staged diff and choose the correct type and optional scope.
2. Create a Conventional Commit message before committing; do not use a plain descriptive sentence as the commit subject.
3. Use a matching Conventional Commit PR title so the intent remains clear in GitHub and release automation.
4. After committing, verify the commit subject with `git log -1 --format=%s` and verify the PR title.
5. Only then push and open the PR, unless the user requests a different sequence.

## If a PR already exists or was merged

- Before amending or force-pushing, check the PR state and remote branch. Never rewrite a merged PR or shared branch without explicit authorization.
- If the PR is still open and the branch is exclusively yours, amend the commit and update the PR title; push rewritten history with `--force-with-lease`, never plain `--force`.
- If the PR is merged, do not rewrite `main` or create an empty commit merely to correct the subject. Explain that the commit is already merged and ask before taking any history-changing or follow-up action.

## Release awareness

This repository uses Conventional Commits on `main` to drive Release Please. Choose types and scopes that accurately describe the change; do not mislabel changes to force a release. Confirm the resulting commit/PR metadata before merge when release behavior depends on it.
