# pi-coordinator-guard

A Pi extension for the **main coordinator session only** that classifies every
tool call and enforces or logs decisions per category. As of 2026-11-13 (user
decision: "process rigor matters — make it controllable-but-enforced") the guard
runs **per-category enforcement** on top of the P0 observe evidence: `edit/write`
outside the allowlist and dispatches without a `[project:<name>]` tag are
**denied** in enforce mode, while mutating bash stays log-only everywhere.

The point is structural enforcement, not prompt reminders (research sa36:
opencode's `{edit,write}→deny` permission set, Aider's no-edit-path architect,
CrewAI's manager toolset hard-fail).

## Categories and mode matrix

| category | trigger | observe mode | enforce mode |
|---|---|---|---|
| `edit_write` | `edit`/`write` targeting a path **outside** the effective allowlist (see below) | `would_deny`, never blocks | **`denied`** — returns `{block:true, reason}` |
| `dispatch_missing_project_tag` | `subagent_spawn` whose task/arguments lack the literal token `[project:<name>]` | `would_deny`, never blocks | **`denied`** — returns `{block:true, reason}` |
| `dispatch_unknown_project` | `subagent_spawn` whose `[project:<name>]` tag names a project **not in the coordinator registry** (read errors fail OPEN to format-only — see below) | `would_deny`, never blocks | **`denied`** — returns `{block:true, reason}` |
| `mutating_bash` | git commit/push/reset/clean · `rm -rf` (any flag grouping) · `mv` or `>` overwrite outside obvious temp (`/tmp`, `$TMPDIR`, `/var/folders`, `/dev/null`) · brew/npm/pip/uv installs · kill/pkill/killall · curl/wget piped into sh/bash/zsh/dash/fish | `would_deny` | **`would_deny` — LOG-ONLY, deliberately** (see rationale) |
| passthrough | everything else (including edit/write inside the allowlist, tagged spawns) | not logged | not logged |

The deny shape matches the pi 1.5.0 `tool_call` hook contract
(`ToolCallEventResult { block?: boolean, reason?: string }`,
`dist/core/extensions/types.d.ts`; optional `terminate` is not used).
Deny reasons are actionable: the `edit_write` reason names the denied path, the
full allowlist, and the config escape hatch; the spawn reason names the missing
`[project:<name>]` token with an example; the unknown-project reason names the
offending tag and lists the registered project ids.

### Registry validation of the spawn tag (`dispatch_unknown_project`)

A format-valid tag can still name a misspelled or nonexistent project. When a
tag is found, the guard validates it against the coordinator registry
(`~/.pi/agent/project-coordinator/coordinator.db`, sqlite, single-row JSON —
read-only, loaded via `node:sqlite` with the same lazy `createRequire` pattern
as `pi-web-bridge/src/projects.ts`; zero dependencies).

- **Membership mirrors the coordinator router exactly** (`router.ts:route()`):
  exact project id, exact alias (case-insensitive), or exact canonical root
  path, over projects with status `registered`. The guard must agree with the
  router — denying an identifier the router would accept would break valid
  dispatches; accepting one it would reject would leave the gap open.
- **Fail-open on READ errors only, never on format**: a missing, unreadable,
  corrupt, or table-less db (or a runtime without `node:sqlite`) falls back to
  the format-only check and logs one `registry_unavailable` warning line
  (`decision:"error"`) to the JSONL sink per read attempt. Rationale: the
  format check is the primary gate; the registry is secondary hardening — a db
  hiccup must not brick dispatching.
- **60s TTL cache** per db path (failures cached with the same TTL): the hook
  re-reads the db at most once per minute, so the per-call cost stays cheap and
  a broken db warns once per window, not once per tool call. Registry changes
  apply within 60s; there is no config knob for the TTL by design.
- **Division of labor with the spawner**: worker sessions run `--no-extensions`,
  so this guard never sees sub-spawns. `pi-superagent`'s manager therefore
  enforces the tag **format** at the spawn chokepoint for every path (root and
  nested); **registry truth stays here**, next to the db and the router. The
  manager deliberately does not duplicate registry validation.

### Why mutating_bash is log-only in every mode (deliberate)

`git push`/`git reset`, process cleanup (`kill`), and package installs are
**legitimate main-session duties** of a release-coordinating session (release
coordination, tunnel/worker hygiene, environment setup). Blocking them
mid-session costs more than it protects, and the classifier is
precision-over-recall by design. Upgrading this category is **evidence-gated**:
revisit only when the observe log shows a concrete false-negative class (e.g.
an accidental `git clean -fd` in the wrong cwd). Rationale is kept as a comment
in `index.js` next to the enforcement code.

## Modes and config

### Mode resolution (evaluated on every tool call)

Precedence: **`PI_COORDINATOR_GUARD` env > config file > default observe.**

1. `PI_COORDINATOR_GUARD` env var, when set: `enforce` → enforce, anything else
   (including `observe`) → observe.
2. `~/.pi/agent/coordinator-guard.json`, read **live** via a stat + mtime cache:
   the file is re-read only when its mtime changes, so mode/allowlist edits
   **apply without `/reload`**.
3. Safe default: `observe` (nothing blocked).

A missing config file is the quiet normal case. A **corrupt/unusable** config
(bad JSON, non-object, unsupported `version`, unknown `mode`, non-array
`allow`) falls back to the observe default and logs the parse error **once per
file change** to the JSONL sink (`decision:"error"`, `pattern:"config_parse_error"`).

### Config schema (v1)

```json
{ "version": 1, "mode": "observe" | "enforce", "allow": ["/absolute/path", "..."] }
```

- `version` — must be `1` (anything else is treated as corrupt → observe).
- `mode` — `"observe"` or `"enforce"`; missing means `"observe"`.
- `allow` — absolute path prefixes **added** to the code-default allowlist
  (union; there is no way to shrink the defaults via config).

### Allowlist (for `edit_write`)

Effective allowlist = **code defaults ∪ config `allow` ∪ `PI_COORDINATOR_GUARD_ALLOW`**
(colon-separated env, also additive).

Code defaults:

- `/Users/yuyuan/PiAgents`
- `/Users/yuyuan/projects`
- `/tmp`
- `/private/tmp`
- `/Users/yuyuan/.pi`
- `/Users/yuyuan/.config`
- `/Users/yuyuan/My Knowledge Vault` — read-only source vault; allowlisted for
  the rare sanctioned sync tasks, not casual edits
- `/Users/yuyuan/.feishu-user-plugin`

Matching: path-prefix match on **lexically normalized absolute paths**
(`node:path` resolve), so `..` traversal cannot escape a root
(`/root/allowed/../secret` → `/secret` → flagged). Relative targets resolve
against the session cwd. `~/...` targets cannot be proven inside an absolute
root and are flagged. **Known limitation:** symlinks are not resolved (no fs
I/O in the classifier, and write targets may not exist yet) — a symlink inside
an allowlisted root pointing outside is not detected.

## The active configuration

`~/.pi/agent/coordinator-guard.json` ships as
`{"version":1,"mode":"enforce","allow":[]}` (empty `allow` = code defaults
apply). This is the user-sanctioned activation of 2026-11-13.

### How to flip back to observe (escape hatch)

Either:

- edit the config file: `{"version":1,"mode":"observe","allow":[]}` — applies
  **live**, no reload needed; or
- set `PI_COORDINATOR_GUARD=observe` in the coordinator session environment and
  `/reload` (env beats the config file); or
- delete the config file (falls back to the observe default, live).

To leave enforce entirely for one call there is no bypass by design; sanction a
path via `allow` in the config instead (also live).

## Log

`~/.pi/agent/logs/coordinator-guard.jsonl` — one JSON object per line, file
created `0600`, directory `0700`. Fields: `ts`, `mode`, `decision`
(`would_deny` | `denied` | `error`), `tool`, `category`, `pattern`, `excerpt`
(command head / target path / task head, ≤ 200 chars), `toolCallId`;
config errors add `error` and use `tool:"_config"`, `category:"config_error"`;
registry read failures add `error` and use `tool:"_registry"`,
`category:"registry_unavailable"`.

Read it:

```sh
# timeline
jq -r 'select(.decision=="would_deny" or .decision=="denied") | [.ts,.mode,.tool,.category,.pattern,.excerpt] | @tsv' \
  ~/.pi/agent/logs/coordinator-guard.jsonl

# counts by pattern
jq -r '.pattern' ~/.pi/agent/logs/coordinator-guard.jsonl | sort | uniq -c | sort -rn

# config problems
jq -r 'select(.decision=="error") | [.ts,.error] | @tsv' ~/.pi/agent/logs/coordinator-guard.jsonl
```

All guard failures (file errors, odd events) are swallowed silently — the
guard must never break the session.

## Scope: main session only

Worker sessions are spawned by pi-superagent with
`--mode rpc --no-extensions --no-mcp --no-approve --offline -e <extensionPath>`
(`packages/pi-superagent/src/subagent/manager.ts`), so user extensions are
never loaded in workers. The guard never sees worker traffic — by construction,
not by filtering.

## Deployment timeline (for the record)

1. **Observe (P0, 2026-11-13)** — commit 699f8ea: env-only mode, empty
   allowlist, everything logged as `would_deny`, nothing blocked.
2. **Per-category enforcement (2026-11-13, user decision)** — config-file mode
   (live), code-default allowlist, `edit_write` + spawn-tag denial in enforce
   mode, mutating bash deliberately log-only. Shipped config activates
   enforce; the running instance picks the new behavior up on `/reload`
   (config *mode/allow* changes are live per call, but the *new code* — the
   per-category matrix and config-file reading itself — only loads with
   `/reload`).

Optional env (all still honored):

- `PI_COORDINATOR_GUARD` — mode override (beats the config file).
- `PI_COORDINATOR_GUARD_ALLOW` — extra colon-separated allowlist prefixes.
- `PI_COORDINATOR_GUARD_LOG` — alternate log sink (tests / debugging).

## Test

```sh
cd /Users/yuyuan/PiAgents/packages/pi-coordinator-guard
npm test          # node --test test/
```

## Files

- `classify.js` — pure classifier (bash pattern table, allowlist matcher with traversal normalization, spawn-tag rule + tag extraction, `DEFAULT_ALLOWLIST`)
- `registry.js` — coordinator-registry reader (lazy `node:sqlite` via `createRequire`, router-parity membership, 60s TTL cache, fail-open read contract)
- `config.js` — live config loader (`stat` + mtime cache, v1 schema parse, safe observe fallback, once-per-change error reporting)
- `log.js` — JSONL log-writer (append, `0600`, swallow-all-errors)
- `index.js` — extension entry (`tool_call` hook, env > config > default mode resolution, per-category enforcement, deny reasons)
- `package.json` — manifest with `pi.extensions` entry point
- `test/guard.test.js` — `node --test` suite
- `README.md` — this file
