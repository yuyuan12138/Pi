# pi-delegation-gate

A Pi 1.3.0 extension that turns the workspace's delegation policy
(`tools/delegation_gate.py`) from an advisory check into a real tool-call gate.

## Mechanism

Registers a `tool_call` event handler (Pi 1.3.0 `ExtensionAPI.on("tool_call")`).
Per `docs/extensions.md`: "`tool_call` can mutate input or block execution";
returning `{ block: true, reason }` from the handler blocks the tool call. This
is genuine pre-execution interception, not a wrapper.

## Policy

- Every call to the `fork` tool must include an explicit context-dependency
  justification in its text arguments, as a marker:
  `[fork-context: <one line stating why the live conversation is needed>]`.
- Without the marker, the call is **blocked**; the model is told to either add
  the marker or use a clean-context `subagent` (preferred when a written brief
  suffices, because fork copies the entire primary conversation into the child).
- Allowed forks append one JSON line to `~/.pi/agent/usage/delegation.jsonl`:
  `{ "timestamp": ..., "tool": "fork", "toolCallId": ..., "reason": ... }`.
  Logging failures never block an allowed fork (observability, not enforcement).

## Install / enable (not yet enabled)

Coordinator review first. Then either load directly:

```
pi --extension /Users/yuyuan/PiAgents/packages/pi-delegation-gate/index.ts
```

or install the local package and add its extension path to
`~/.pi/agent/settings.json` `extensions`, following the pattern used by
`packages/pi-fork` and `packages/pi-minimal-subagent`.

## Limitations

- Only intercepts calls with tool name exactly `fork`. Other context-copying
  tools would need their own entries.
- The marker is a string match; it cannot verify the stated reason is true.
  It forces an explicit, logged declaration, mirroring the CLI gate's
  `--fork-context-dependency`.
- Extension handler errors in Pi fail-safe by blocking the tool; logging is
  wrapped so ordinary I/O problems do not block allowed forks.
- Handler ordering: if a `fork` implementation were itself registered as a
  non-tool path (e.g. a command), the event would not fire. The current
  `packages/pi-fork` registers `fork` as a tool, so it is covered.

## Tests

`node tools/test_delegation_gate.mjs` — offline, fake contexts, no model or
network calls; loads via the real `loadExtensions` loader.
