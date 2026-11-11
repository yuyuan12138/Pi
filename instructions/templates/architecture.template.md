<!--
DESIGN DOC template (Project-Space Standard §2). Model: Google design docs / RFC.
Budget: ≤250 lines. Audience: maintainers + future coder workers.
Cite file:line for load-bearing claims; mark unverifiable claims "unverified".
Link ADRs instead of re-arguing settled decisions.
-->
# Architecture — <system name>

Audience: maintainers of this project space. Every load-bearing claim cites a
source file; unverifiable facts are marked **unverified**.

## 1. Context
<!-- Problem, constraints, prior art elsewhere in this workspace. 5-10 lines. -->

## 2. Goals / Non-goals
<!-- Goals: 3-6 bullets. Non-goals: explicit "NOT doing X (yet/because)". -->

## 3. Design overview
<!-- One layered table or ASCII diagram.
     Pattern (sample architecture.md §1):
       Closed-loop engine (days) → Episode (run_id) → server-authoritative truth -->

## 4. Detailed design
<!-- Per component. Load-bearing claims cite file:line.
     Pattern (sample §2): "| prepare_artifact.py | Stages ~33 sources, hashes
     each, derives source_sha256 | prepare_artifact.py:28-47 |" -->

## 5. Alternatives considered
<!-- ≥1 per major choice: option, why rejected. Link ADRs where they exist. -->

## 6. Cross-cutting concerns
<!-- Safety envelope, evidence/trust hierarchy, failure & resume policy.
     Pattern (sample §6): numbered hierarchy — server data > collector verdict
     > actor receipts > model self-report (never proof). -->

## 7. Open limitations
<!-- From records, not speculation; each cites its source.
     Pattern (sample §7): "JVM umask 002 world files during episodes —
     neutralized post-stop by the wave-12b chmod-portability fix." -->
