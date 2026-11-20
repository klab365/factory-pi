---
name: systematic-debugging
description: Investigate reproducible failures and identify their cause before changing factory code.
---

# Systematic debugging

Apply this workflow when a test fails, a run cannot resume, or observed behavior differs from the goal. Do not introduce speculative fixes for unrelated code.

1. Record the exact failing command, exit status, error, and relevant environment differences. Reproduce with the smallest deterministic fixture available; never use real credentials or paid model calls just to reproduce a unit-test failure.
2. Read the failing code and its callers. Compare with a working path and inspect the current diff before changing anything. Distinguish observed evidence from assumptions.
3. Trace values across the relevant boundaries: pipeline YAML, CLI input collection, child-process protocol, journal admission, conversation configuration, and result parsing. For resume failures, distinguish saved requests from newly admitted turns and inspect the run/agent mapping without editing real journals.
4. State one falsifiable explanation and test it with one narrow experiment. Prefer temporary fixtures or test doubles; redact secrets from diagnostics. Do not stack unrelated changes when an experiment fails.
5. Once the cause is understood, add a regression test that demonstrates the original failure, then make the smallest correction. Where feasible, confirm the test fails without the correction and passes with it; do not revert unrelated working-tree changes to do this.
6. Re-run the reproduction and relevant neighboring tests. If repeated attempts expose new symptoms, revisit the assumptions and report the evidence or blocker rather than broadening the patch blindly.

This workflow does not authorize changing files during a read-only review, changing pipeline transitions, or invoking unavailable handoff tools.
