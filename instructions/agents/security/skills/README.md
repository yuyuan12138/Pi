# security skills

Entry point for the security role's specialization skills. Each file is a
concrete procedure, not a placeholder; they are promoted further into full
methodology as verified lessons accumulate in `../records/experience.md`.

## Files
- `threat-modeling.md` — assets, trust boundaries, entry points, attacker paths.
- `vuln-review.md` — class-based diff review; blocking = exploitable.
- `secret-scanning.md` — credential shapes in trees/diffs/config; values redacted.
- `dependency-risk.md` — manifests/lockfiles: CVEs, drift, abandonment, licenses.

## Read order
1. The specialization the brief names — read it first, fully.
2. `threat-modeling.md` for any change touching an entry point, even when
   another specialization was named — the model anchors the review.
3. The project's own security notes (README security section, existing
   threat docs) before reporting findings.

## Standing rule
Read-only, proposal-graded: findings and remediation suggestions only, no
fixes, no exploit execution, no secret values ever echoed into reports or
logs. No specialization skill overrides this.
