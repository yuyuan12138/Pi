<!--
RUNBOOK template (Project-Space Standard §4). Model: SRE workbook.
Budget: ≤120 lines. Write when an operation has succeeded twice manually;
update on any failure this doc did not cover.
Save as docs/runbooks/<topic>-runbook.md and add a one-line row to
docs/runbooks/INDEX.md (the INDEX may also reference pre-existing files
anywhere in the project — retrofit means index-in-place, nothing moves).
-->
# <Operation> — runbook

## What this automates + authorization basis
<!-- e.g. "Cold-change path; authorized by user decision A, 2026-11-09"
     (pattern: sample COLD-PIPELINE-RUNBOOK.md header). -->

## Preconditions
<!-- Budgets, permissions, fresh run_id, state checks — copy-pasteable. -->

## Procedure
1. <!-- Numbered, copy-pasteable commands; success criterion per step. -->
2. <!-- Record the revert point BEFORE the risky step.
     Pattern (COLD-PIPELINE-RUNBOOK step 2): the git commit id is recorded
     into the hypothesis record BEFORE any A/B runs. -->

## Verification
<!-- What "success" looks like + the evidence to keep (receipts, logs, state). -->

## Failure paths
| Symptom | Diagnosis | Remediation |
|---|---|---|
| <observed signature> | <where to look> | <fix or revert> |
<!-- Pattern: OPERATOR-RECORD-furnace-reset-20261105.md — world perms
     (umask 002) + empty-stats baseline diagnosis → fixes. -->

## Escalation (hand back to a human)
<!-- Unknown outcomes, replay decisions, authorization boundaries.
     Standing rule: unknown-outcome crashes are never auto-replayed. -->
