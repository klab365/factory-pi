---
name: typescript-expert
description: Implement and test safe TypeScript changes in this Bun-based factory.
---

# TypeScript implementation

- Inspect existing types, runtime boundaries, and repository conventions first.
- Treat YAML, JSON, tool arguments, and persisted records as unknown until validated. Narrow values rather than suppressing errors with `any` or unchecked casts.
- Keep public types precise; represent optional fields and failure states explicitly. Preserve compatibility with durable records and replay semantics.
- Await asynchronous work and propagate failures with useful context. Clean up files, processes, and temporary directories even on failure.
- Add deterministic Bun tests for normal behavior, invalid input, boundary cases, and replay where relevant. Stub external APIs and model calls; avoid credentials and network access in unit tests.
- Use descriptive test names, isolate fixtures, and assert behavior rather than implementation details. Exercise rejected promises with awaited assertions.
- Run focused tests, then the repository's formatting, lint, and type checks. Report exactly which checks ran.
