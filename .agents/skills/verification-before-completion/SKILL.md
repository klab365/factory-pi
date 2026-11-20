---
name: verification-before-completion
description: Ground implementation and review completion claims in current, explicitly scoped check results.
---

# Verification before completion

Before returning the final factory result:

- Compare the actual diff with the requested goal and acceptance criteria. Passing tests alone do not establish that every requirement is implemented.
- Choose checks that support the claims you intend to make. Run focused Bun tests for affected behavior; for code or agent-configuration changes, run `bun run check` when feasible. It includes formatting, lint, tests, TypeScript checking, and pipeline validation. Use `git diff --check` to catch whitespace errors.
- Read exit codes and output. A started command, a timeout, or a truncated log without a confirmed result is not a passing check. Re-run affected checks after subsequent edits; do not present earlier output as evidence for changed code.
- Keep scopes explicit: a passing focused test is not the full suite, typechecking is not runtime verification, and a mocked test does not prove live provider behavior. Do not make paid model calls or require credentials to validate this repository's local changes.
- Independently inspect any delegated analysis against the code and available evidence. Do not substitute another agent's success statement for verification.
- Report the commands actually run, observed failures or blockers, and checks still outstanding. If a check cannot run, explain why instead of implying success. In review, distinguish an implementation defect from an unavailable check.

Preserve the agent's role: reviewers must not edit files or run formatting in write mode. Verification does not authorize commits, destructive cleanup, or edits to real run history. Finish using the statuses and factory-result format provided by the pipeline, not a new status invented by this skill.
