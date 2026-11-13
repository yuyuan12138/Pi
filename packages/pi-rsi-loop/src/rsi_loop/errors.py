"""Exception types for the RSI loop engine (stdlib-only)."""


class ProposerUnavailable(RuntimeError):
    """Proposer endpoint unreachable / key missing / repeatedly unparseable.

    Framework contract: the engine PAUSES the loop (status=paused_no_llm)
    instead of fabricating proposals. Raised by proposer implementations;
    caught by RsiLoopEngine.run().
    """
