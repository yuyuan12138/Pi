# Runbook index

One line per runbook (PROJECT-SPACE-STANDARD §4). Entries may point anywhere in
the project; nothing moves.

- `pi-restart.md` — zero-loss coordinator pi restart: snapshot → idle-detect → `/quit` (not Ctrl-C) → `pi --continue` → `/telegram-connect` → wake → reconcile; `/reload` never swaps extension code.
