# Skill: infra (coder specialization)

> Minimum bar plus operating procedure; promoted further into full methodology
> as verified lessons accumulate in `../records/experience.md`.

## Procedure
1. Prove reproducibility first: run the build/CI/script path from a clean
   checkout or fresh worktree, before and after the change — a pipeline
   that only works on the author's machine is not finished.
2. Pin what the pipeline depends on: tool versions, image/action tags, and
   required env vars are declared in the repo, not inherited from
   "whatever is installed here".
3. Every script step logs what it did (command + target + result); no
   silent side effects — a step that fails loudly beats one that skips
   quietly under a `|| true`.
4. Idempotency: re-running on an already-built state either no-ops or
   explicitly rebuilds; test the second run, not just the first.
5. Local parity: CI-green is not proof if the change only manifests in CI;
   run the same commands locally, or state in the report why that is
   impossible and what evidence substitutes.
6. Cleanup: temp artifacts, caches, and generated files the script creates
   are named and removed or gitignored deliberately — never left to
   accumulate silently.

## Anti-patterns
- Absolute paths and implicit-cwd assumptions in scripts.
- Steps gated on interactive prompts in unattended runs.
