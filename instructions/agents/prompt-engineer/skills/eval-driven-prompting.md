# Skill: eval-driven-prompting (prompt-engineer specialization)

> Stub: minimum bar for this specialization; promoted into full methodology as
> verified lessons accumulate in `../records/experience.md`.

- No prompt change ships without a before/after eval on a fixed case set: the
  symptom case must flip, the regression cases must hold.
- Fix the case set before the diff, freeze it during the comparison; post-hoc
  case selection is how prompt changes fake improvement.
- Report negative results too — a change that does not move the eval is a
  finding about the symptom's cause, not a failure to hide.
