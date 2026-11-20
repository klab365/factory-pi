---
name: code-review
description: Review changes for concrete correctness, safety, and regression risks.
---

# Code review

- Read the diff and surrounding call sites; compare behavior with the requested acceptance criteria before reporting findings.
- Follow untrusted inputs through validation, filesystem resolution, shell execution, and prompt assembly. Check traversal, unintended disclosure, and error handling.
- For durable workflows, examine admission, replay, crash windows, history isolation, and compatibility with persisted records. Do not assume a retry is a fresh run.
- Check asynchronous cleanup, cancellation, and propagation of failures. Look for shared mutable state crossing agent or run boundaries.
- Verify tests cover failure paths as well as successful behavior and do not depend on paid model calls or credentials. Run focused checks when useful and distinguish observed failures from speculation.
- Report only actionable issues introduced by the change, ordered by severity, with file/line references, a concrete failure scenario, and a suggested correction. Avoid style-only requests when existing checks cover formatting.
- If no actionable findings remain, say so. Do not claim unexecuted checks passed or modify the implementation during review.
