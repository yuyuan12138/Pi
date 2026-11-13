# pi-coordinator-guard

A Pi extension for the **main coordinator session only** that classifies every
tool call and logs *would-deny* decisions to a private JSONL log. **P0 is
OBSERVE MODE ONLY: it never blocks, never modifies, never delays a call.**
The point is evidence: research (sa36) showed structural enforcement beats
prompt reminders; this package produces the 1–2 day observation log that the
enforcement decision will be based on.

## What it observes

| category | trigger | decision |
|---|---|---|
| `mutating_bash` | git commit/push/reset/clean · `rm -rf` (any flag grouping) · `mv` or `>` overwrite outside obvious temp (`/tmp`, `$TMPDIR`, `/var/folders`, `/dev/null`) · brew/npm/pip/uv installs · kill/pkill/killall · curl/wget piped into sh/bash/zsh/dash/fish | `would_deny` |
| `edit_write` | `edit`/`write` targeting a path **outside** `PI_COORDINATOR_GUARD_ALLOW` (P0 default allowlist is **empty** — the turn's attributed project space is not yet derivable, so every main-session edit/write is logged with its target path) | `would_deny` |
| `dispatch_missing_project_tag` | `subagent_spawn` whose task/arguments lack the literal token `[project:<name>]` (the project-space routing rule; today's actual compliance failure) | `would_deny` |
| passthrough | everything else | not logged |

Precision beats recall by design: patterns are deliberately narrow, and a
false positive only costs a log line.

## Log

`~/.pi/agent/logs/coordinator-guard.jsonl` — one JSON object per line, file
created `0600`, directory `0700`. Fields: `ts`, `mode`, `decision`, `tool`,
`category`, `pattern`, `excerpt` (command head / target path / task head,
≤ 200 chars), `toolCallId`.

Read it:

```sh
# timeline
jq -r 'select(.decision=="would_deny") | [.ts,.tool,.category,.pattern,.excerpt] | @tsv' \
  ~/.pi/agent/logs/coordinator-guard.jsonl

# counts by pattern
jq -r '.pattern' ~/.pi/agent/logs/coordinator-guard.jsonl | sort | uniq -c | sort -rn
```

All guard failures (file errors, odd events) are swallowed silently — the
guard must never break the session.

## Scope: main session only

Worker sessions are spawned by pi-superagent with
`--mode rpc --no-extensions --no-mcp --no-approve --offline -e <extensionPath>`
(`packages/pi-superagent/src/subagent/manager.ts`), so user extensions are
never loaded in workers. The guard never sees worker traffic — by construction,
not by filtering.

## Modes (enforce stub)

- `PI_COORDINATOR_GUARD=observe` (default): log everything flagged, never block.
- `PI_COORDINATOR_GUARD=enforce`: **stub only** — additionally denies
  `edit_write` calls outside the allowlist (`decision: "denied"`); mutating
  bash and the spawn-tag rule stay observe-only.

**Flipping to enforce is a user decision**, made only after reviewing 1–2 days
of observe-mode logs. The mode is read once at extension load: change the env
in the coordinator session's environment, then `/reload` (or start fresh).

Optional env:

- `PI_COORDINATOR_GUARD_ALLOW` — colon-separated absolute path prefixes exempt
  from the `edit_write` flag (e.g. the coordinator's own glue repo, once the
  review decides on them).
- `PI_COORDINATOR_GUARD_LOG` — alternate log sink (tests / debugging).

## Deliberate upgrade path

1. **Observe (1–2 days)** — this P0. Nothing changes behavior; the log grows.
2. **Review** — tune patterns/allowlist from real traffic (false positives,
   missed mutations, spawn-tag compliance rate).
3. **User decides** — keep observing, or flip `PI_COORDINATOR_GUARD=enforce`
   (edit/write denial only), or extend enforcement categories explicitly.

## Test

```sh
cd /Users/yuyuan/PiAgents/packages/pi-coordinator-guard
npm test          # node --test test/
```

## Files

- `classify.js` — pure classifier (bash pattern table, allowlist matcher, spawn-tag rule)
- `log.js` — JSONL log-writer (append, `0600`, swallow-all-errors)
- `index.js` — extension entry (`tool_call` hook, env resolution, enforce stub)
- `package.json` — manifest with `pi.extensions` entry point
- `test/guard.test.js` — `node --test` suite
- `README.md` — this file
