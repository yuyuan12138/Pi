"""pi-rsi-loop: generic closed-loop RSI (run-self-improvement) engine.

Extracted (copy-adapt, no imports) from the Minecraft-proven closed-loop engine
at remote-agent/operations/20261029-minimal-sword-episode/closed_loop.py.
The eight stages — SENSE -> PROPOSE -> FILTER -> EXPERIMENT -> GATE -> APPLY ->
CURRICULUM -> LOOP — are an orchestration core over six pluggable ports:

    LedgerSource      project evidence in, frontier + next_before out
    Proposer          raw hypotheses (LLM or scripted); engine feeds it the
                      rejection memory (novelty pressure)
    ExperimentRunner  A/B driver + scorer; returns canonical results
    Gate              accept/reject on pinned criteria (default: AcceptGate)
    Applier           writes the accepted change (default: RecordingApplier)
    Curriculum        node/advance policy (default: SaturationCurriculum)

Framework-owned features (not adapter concerns): budget caps, two-strikes
infra breaker, crash-resume (terminal results.json only), observe-first /
live gating, proposal filter with rejection memory, state checkpointing.

MC's instance stays the reference adapter; see ADAPTER.md in the package root.
"""
from .errors import ProposerUnavailable
from .results import load_terminal_results
from .jsonparse import extract_json_object
from .state import LoopState, TwoStrikes, repair_consecutive_counters
from .ports import (AcceptGate, RecordingApplier, SaturationCurriculum,
                    request_variance_ok, observe_estimate)
from .filter import filter_proposals, validate_entry_generic, entry_from_raw
from .proposer import HttpProposer, strict_key_loader
from .engine import RsiLoopEngine, emit_decision, EXIT_CODES
from .evidence import (EVIDENCE_SCHEMA, EvidenceReadError,
                       build_cycle_evidence, persist_evidence_envelope,
                       read_evidence)

__all__ = [
    'ProposerUnavailable', 'load_terminal_results', 'extract_json_object',
    'LoopState', 'TwoStrikes', 'repair_consecutive_counters',
    'AcceptGate', 'RecordingApplier', 'SaturationCurriculum',
    'request_variance_ok', 'observe_estimate',
    'filter_proposals', 'validate_entry_generic', 'entry_from_raw',
    'HttpProposer', 'strict_key_loader',
    'RsiLoopEngine', 'emit_decision', 'EXIT_CODES',
    'EVIDENCE_SCHEMA', 'EvidenceReadError', 'build_cycle_evidence',
    'persist_evidence_envelope', 'read_evidence',
]
