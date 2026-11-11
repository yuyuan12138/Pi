<!--
ADR LOG template (Project-Space Standard §3). Model: MADR, compressed.
Append-only: entries are NEVER edited after being written; newest at the
bottom. Budget: ≤10 lines per entry. Rejected experiments also live here,
with their outcome — never delete an entry, supersede it with a new one.
-->
# Decision log (ADR-style)

Format: **Context → Decision → Consequence**, 3-8 lines each, with date and a
source pointer. No decision here is re-litigated in docs work — live files own
the behavior.

---

## ADR-001 — <title>
**Date**: YYYY-MM-DD · **Source**: `<file>` (or commit id)
- **Context**: <the forces; 2-3 lines>
- **Decision**: <what was decided; 2-4 lines>
- **Consequence**: <what this costs or commits us to; 1-3 lines>

<!--
Filled pattern (sample ADR-004, compressed):
  ## ADR-004 — Water removed from the hazard system (user ruling)
  Date: 2026-11-08 · Sources: commit 08b6e07; OPERATOR-RECORD-wave31 (the
  hazard_support(water) self-quit that motivated it); wave32 (validation).
  Context: wave-31 died when the safety monitor read a water block under the
  bot's feet — a fatal false-positive class.
  Decision: water is ordinary terrain; removed from safety_monitor HAZARDS.
  Consequence: wave-32 ran end-to-end with zero safety trips.
Rejected-experiment pattern (sample ADR-007, Turn-BoN): "prediction falsified
as run (182 turns / 910 calls vs 73-request baseline); mechanism healthy —
deficit was turn-economy."
-->
