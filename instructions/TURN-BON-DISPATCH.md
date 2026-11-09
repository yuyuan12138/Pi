# Turn-BoN dispatch pattern for the primary conversation

Turn-level Best-of-N sampling (Turn-BoN, arXiv 2611.06868) applied to the
primary conversation's OWN dispatch decisions. The paper's mechanism: at each
turn, a generator proposes N candidate actions (temp 1.0, top-p 0.95) and a
selector picks ONE, which is executed; unselected candidates are discarded
before execution. The paper's theory: this is a sampled one-step policy
improvement — it helps exactly when the selector has positive expected
advantage over the generator's raw sample.

## When to use it

Multi-turn INTERACTIVE tasks where a wrong single step costs a full re-run of
everything after it: long episode loops, deployment chains, multi-day
debugging campaigns, world/repair sequences. There, running N full trajectory
candidates (trajectory-level BoN) is wasteful — most compute is spent on
trajectories that die at the same early mistake. Turn-level selection fixes
the mistake before it executes.

Trajectory-level best-of-N (dispatch N parallel candidates on the SAME bounded
task, accept the best) stays the DEFAULT for bounded, locally verifiable
deliverables. Turn-BoN is the variant for work that is too long or too
stateful to run N times end-to-end.

## Mechanism

At each dispatch turn of such a task:

1. Spawn N=4 parallel subagent candidates in isolated working copies
   (disjoint worktrees/dirs, no shared writes) for the NEXT STEP ONLY —
   a bounded deliverable: one fix, one decision, one repair step — not the
   whole task.
2. The primary acts as the SELECTOR with full context: current state, error
   ledger of prior turn failures, acceptance criteria. It picks exactly ONE
   candidate to execute/keep; the other N-1 are discarded (their worktrees
   dropped, nothing merged).
3. Only the selected step is executed in the real environment. Next turn
   re-plans from the resulting state, with fresh candidates.

Because selection happens before execution, a bad step never reaches the
shared machine — the same property that makes the paper's approach cheaper
than N full trajectories.

## Selector prompt template

The primary asks itself (or a read-only advisor subagent), per turn:

> "Given the current state and prior failures, which candidate step makes
> genuine progress toward <goal>? Reply with the candidate index."

Selection criteria that mirror the paper's selector behavior: prefer
candidates that act on established facts over re-observing; reject candidates
that repeat a step that already failed the same way; reject empty or
malformed deliverables; when candidates are near-identical, any pick is fine —
but record it, because near-identical candidates mean the generator (not the
selector) is the bottleneck.

## Theory anchor and monitoring condition

The pattern is justified only by sampled one-step policy improvement: the
selected steps must have positive expected advantage over raw generator
samples (paper Proposition 2). This is an empirical condition, not a given:

- Log every turn: candidates offered, index picked, agreement with what the
  primary would have picked anyway (override rate), and downstream outcome.
- If the selector's picks are statistically indistinguishable from a random
  candidate (or from the first candidate), measured advantage is ~0 and the
  pattern should be DROPPED for that task — N parallel candidates plus a
  selector is real cost for no improvement. The paper itself flags selector
  advantage as the binding constraint.
- Drop trigger, concrete: over a rolling window of ≥5 selection turns, if the
  outcome distribution of selected steps does not beat the unselected
  candidates' expected outcome, stop using Turn-BoN for that task and fall
  back to trajectory-level best-of-N or serial repair.

## Cost rule

- Use ONLY for turns where a wrong step costs a full re-run (long episodes,
  stateful chains, hard-to-revert environments).
- NEVER for trivial steps: a trivial step has no downside risk, and N=2 is
  provably ≈ baseline in the paper — so if a turn merits candidates at all,
  the minimum is N=3; default N=4.
- Sequential-candidate fallback: if parallel worktrees are impossible for the
  step (e.g. the step mutates one shared external resource), generate
  candidates as written PLANS instead of executed changes and select among
  plans — cheaper and still pre-execution selection.

## Integration with existing policy

- Complements, does not replace: trajectory-level best-of-N remains the
  default for bounded deliverables; Turn-BoN covers its blind spot (long
  interactive work).
- Does NOT touch the zero-inline-execution rule: the primary still never
  executes work inline — it selects among candidate deliverables produced by
  subagents. Selection is a decision, not execution.
- Same file-ownership discipline as best-of-N: each candidate owns its own
  copy; exactly one is kept per turn; never merge two candidates' partial
  work.
- Attempt accounting is unchanged: a Turn-BoN turn is one dispatch round in
  the task record; log which candidate was kept and why.
