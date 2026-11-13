# pi-rsi-loop

Generic closed-loop RSI (run-self-improvement) engine: the eight-stage
control flow proven in the Minecraft closed-loop engine, extracted as a
platform package so **any project with a scorer can run the loop** — MC
becomes the first consumer/reference adapter, not the owner.

    SENSE -> PROPOSE -> FILTER -> EXPERIMENT -> GATE -> APPLY -> CURRICULUM -> LOOP

Six pluggable ports (`LedgerSource`, `Proposer`, `ExperimentRunner`, `Gate`,
`Applier`, `Curriculum`); framework-owned features: budget caps, two-strikes
infra breaker, crash-resume (terminal `results.json` only, never relaunch),
observe-first / live gating, proposal filter with rejection memory.

- **Adapter contract:** [ADAPTER.md](ADAPTER.md) — what a project must
  provide; MC's `closed_loop.py` documented as the reference adapter.
- **Toy second consumer (C2 acceptance):** `tests/dry_run/` — fixture ledger
  + deterministic scorer + no-op applier completing one full loop iteration
  in dry-run with zero side effects. Run:
  `python3 tests/dry_run/run_dry_run.py [--observe]`
- **Origin:** copy-adapted from
  `remote-agent/operations/20261029-minimal-sword-episode/closed_loop.py`
  (no imports; the MC instance is untouched and its own suite must stay
  green).

## Why Python (repo packages are mostly TS)

The proven engine and its defect history live in Python; a copy-adapt
preserves the exact, field-hardened control-flow semantics (two-strikes,
terminal-only resume, saturation variance) and keeps it reviewable 1:1
against the original. Stdlib-only. A TS port is future work if a TS consumer
appears.

## Usage

```python
import sys; sys.path.insert(0, 'packages/pi-rsi-loop/src')
from rsi_loop import (LoopState, RsiLoopEngine, AcceptGate, RecordingApplier,
                      SaturationCurriculum)

state = LoopState('state.json', mode='observe', budget_cap=1_000_000)
engine = RsiLoopEngine(state, my_ledger_source, my_proposer, my_runner,
                       gate=AcceptGate(threshold=0.15),
                       applier=RecordingApplier(would_write='skills.json'),
                       curriculum=SaturationCurriculum(next_node_fn=...),
                       observe_window=2)
exit_code = engine.run(10)   # 0/3/4/5/6/7/8 — see ADAPTER.md §2
```

## Tests

```sh
cd packages/pi-rsi-loop
python3 -m unittest discover -s tests -p "test_*.py"   # 93 tests
python3 tests/dry_run/run_dry_run.py                   # C2 toy consumer, exit 7
python3 tests/dry_run/run_dry_run.py --observe         # observe posture, exit 6
```

## Status

P0 of Theme C (architecture-expansion plan, 2026-11-13): C1 extraction +
C2 adapter contract & toy consumer, delivered. Not yet wired to any live
project; MC's instance keeps running its own proven code path.
