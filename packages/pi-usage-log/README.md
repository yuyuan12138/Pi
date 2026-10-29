# pi-usage-log

Local, offline usage monitoring for the Pi coding agent.

- On every `turn_end`, appends one JSON line to `~/.pi/agent/usage/YYYY-MM-DD.jsonl`:
  timestamp, cwd, session id, turn index, model, stop reason, token usage
  (input/output/cache read+write/total), cost, tool names invoked that turn,
  and context usage percent.
- `/usage` command prints today's aggregate grouped by session+model, with a grand total.
- Never sends data anywhere; failures to write are silently ignored so monitoring
  cannot break a session.

Adapted locally for Pi 1.3.0 (first-party package, not from npm).
