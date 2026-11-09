---
name: mc-rsi-episode
description: Run and debug the Minecraft RSI episode loop on the production host wangruojun@49.235.120.201 (MC container 9fc2995bbc12, default model deepseek-v4.1-flash-1017 via axonhub). Captures the full prepare→cp-receipt→deploy→preflight→nohup-double-fork launch chain, single-use run_id, seed natural-state world reset (operator trees = cheating), world_rcon.py verification, remote-truth diagnosis, and prompt-lab iteration rules. Use when preparing, launching, resetting the world, or debugging an episode; procedure + hard-won gotchas, grants no runtime permission.
---

# MC RSI episode — launch chain, world reset, verification, diagnosis

All scripts live in `remote-agent/operations/20261029-minimal-sword-episode/` (run them from there).
This skill is procedure + gotchas, not authorization. Read logs before touching state.

## 1. Environment and transport

- Remote host `wangruojun@49.235.120.201`. ALL remote access goes through the pinned transport
  `operations/20261027-model-driven-sword/ssh_once.py`: it re-scans the ED25519 host key on every
  connection and asserts the PIN before login, uses BatchMode + no agent/tty forwarding, and writes
  one per-call record JSON (`<stem>.json`, exit/stdout/stderr + `host_pin_verified`). Do not open a
  second auth surface; use `ssh_once.run_remote(script, stem)` or a helper that wraps it.
- Minecraft server: docker container `9fc2995bbc12` (full ID in `world_rcon.py`), MC 1.21.6,
  `rcon-cli` inside the container. World bind-mount `/DATA/COLA/wangruojun/minecraft-headless/data/minecraft/world`,
  owned by uid 1003.
- Default model `deepseek-v4.1-flash-1017` via axonhub. Launch with `env -u PI_MC_PROFILE` so any
  locally exported `PI_MC_PROFILE` cannot silently redirect the episode to a different profile.
- The episode starts and stops the server itself. Before prepare/deploy/preflight the container must
  be `exited`; `world_rcon.py serverstate` to check, `world_rcon.py stopserver` for a graceful stop.

## 2. Launch chain (do not skip or reorder steps)

1. **prepare** — `python3 prepare_artifact.py` → writes `artifact-receipt-<run>.json` with a fresh
   `run_id` (format `20261105T111239Z-05a7dc63`), plus `source_sha256` and the goal file.
2. **cp the receipt** — `cp artifact-receipt-<run>.json prepared-artifact.json`. deploy/preflight read
   the FIXED name `prepared-artifact.json`, not the per-run receipt. Copy the receipt into the artifact
   dir too (9b0a5c1a97a7 lesson). Forgetting this = stale run_id binding downstream.
3. **deploy** — `python3 deploy_artifact.py` → uploads the source files (~36) to remote
   `bot/model-code-sword-<run>/`, sha-verified, and reports `server_state` + `game_connections`.
   Fails with "Server already active; no takeover" if the server is running.
4. **preflight** — `python3 run_runtime_preflight.py` → deletes any old report and writes a fresh
   `preflight-report.json` (O_EXCL, 0600) in the remote run dir. The episode REQUIRES it and
   validates exact bindings (run_id/actor_id/source_sha256, image IDs, node version) — a valid-looking
   but stale report is still rejected (see `_validate_preflight`).
   - **Preflight log double-escaping**: the payload is Python source embedded in a
     `python3 - <<'MC_RUNTIME_PREFLIGHT'` heredoc, itself piped to `sh -s` by ssh_once — TWO quoting
     layers. Values are injected via `repr()` substitution and the payload is `compile()`-gated
     locally before any SSH. If you add log lines/paths containing quotes to the payload, escape them
     for both layers; symptoms of getting it wrong: remote `wrapper_failed` with only a `stderr_tail`.
5. **launch** — double-fork so the episode survives the ssh session:
   `(env -u PI_MC_PROFILE nohup python3 run_model_episode.py artifact-<run>/episode-config.json > launch-<run>.log 2>&1 & echo $! > launcher-<run>.pid)`
   A bare nohup without the subshell+`&` repeatedly died with its parent — keep the subshell form.
6. **watcher** — `nohup ./watcher-<run>.sh` (generated per run): polls `records-<run>/summary.json`
   every 30 s up to the deadline (165 min), then writes `watcher-<run>.status` (done/timeout).

- **run_id is single-use**: local `records-<run>/` is created mode 0700 with no `exist_ok`
  (reuse → `FileExistsError`); remote `run-marker.json` is created O_EXCL. Symptom: re-running a used
  run_id crashes or silently binds stale artifacts. Action: NEVER reuse — even a launch that failed
  seconds in burns the run_id (648afb15 did). Always re-prepare a NEW run_id and redo steps 2–5.

## 3. World reset runbook — seed natural state

User rule: worldgen trees are fair; operator-planted trees are CHEATING and invalidate the run.
After ~11 episodes the spawn area was deforested — reset to the seed's natural state EVERY round,
or environment drift fakes a regression.

1. **Seed check (NBT)**: parse `level.dat` → `WorldGenSettings.seed`, compare with
   `seed-trial-accepted.json` (2402286999375985384). Use the reviewed `rsi_random_world.py` SEED_CHECK
   logic — a hand-rolled quick parser was offset-buggy once and "verified" a wrong seed. Re-verify
   after chmod.
2. **Natural-tree verification WITHOUT booting the server**:
   `python3 diag-20261105/offline_world_verify.py <world_dir> [radius]` — mechanically extracted pure
   functions of `rsi_random_world.py` (lines 56–73 + 95–319, byte-identical); offline only, no
   RCON/server/SSH. It scans region files for natural log-family trunks (reference result: 2 natural
   oaks 27.5 / 36.1 blocks from spawn). Never "confirm" trees by planting.
3. **Perms**: `chmod -R u+rwX,go+rX,go-w <world>` (the reviewed `rsi_random_world.py:442`
   normalization) → dirs 755, files 644, uid 1003.
4. **Re-check**: `find <world> -perm /022 | wc -l` must print `0` (GNU find syntax — it runs on the
   remote Linux host inside the ssh_once script; macOS BSD find rejects `/022` with "illegal mode
   string", so don't test it locally).
   - Symptom: episode dies `world_directory_group_or_world_writable` with `model_requests=0` →
     cause: server boot under JVM umask 002 left 775/664 files after the world regen →
     action: redo steps 3–4; never trust that a chmod "ran".
5. **Empty `world/stats/`**: a fresh world has NO stats dir.
   - Symptom: status `episode_failed` (uncoded) with `EvidenceError('baseline_absence_or_bytes_unverified')`
     → cause: the collector can only return `missing_unverified` for a missing stats parent, and the
     raised EvidenceError has no `.code` so it folds to episode_failed →
     action: `mkdir world/stats` empty (755, uid 1003, no game content). Verified by read-only remote
     repro: stage 1 reproduced the exception, stage 2 after mkdir returned BASELINE_OK.
6. Keep the container `exited` throughout the reset; the episode starts the server itself.

## 4. Verification with world_rcon.py

All game-side ops go through `world_rcon.py` (ssh_once transport; RCON inside the container; commands
are ONE quoted string — no `--` before negative coordinates).

- `verify X Y Z BLOCK` — 1.21.6's `data get block` only reports block entities, so the helper uses
  `execute if block …` and treats `Test passed` as the match signal.
- `setblock` no-op: setting a block to what it already is prints `Could not set` — that is a NO-OP,
  not a failure. Confirm real placements with `verify`, don't panic on the message.
- `swordcheck` — reads `world/stats/<uuid>.json` and sums `minecraft:crafted → minecraft:wooden_sword`.
  The old playerdata-grep pattern never matched the real file format (false negative) — do not revive it.
- Per-run identity: the bot spawns as `Sword<run_id-suffix>` (e.g. `Sword05a7dc63`) with a run-unique
  uuid in stats/playerdata, so counts from previous runs cannot be mistaken for this run's.
- Other subcommands: `serverstate`, `waitready [max_s]`, `rcon '<cmd>'`, `clearbox X0 Y0 Z0 X1 Y1 Z1 BLOCK`,
  `stopserver` (graceful rcon stop — saves the world), `startserver`, `chmodworld`, `buildpillars`
  (resets the spawn area: fill-clears the spawn box, restores the grass surface, setblocks 3 pillars
  — 2 dirt layers + a jungle_log top each — then verifies every block and prints `PILLARS_OK` /
  `PILLARS_MISMATCH`; use it instead of hand-building the pillar fixture).
- **clearbox is one fill, not a loop**: `clearbox -168 68 -579 -162 75 -573 air` (same thing as
  `rcon 'fill -168 68 -579 -162 75 -573 air'`) clears the whole box in a single command. The response
  `Successfully filled N` doubles as the debris count — N tells you exactly how many blocks were
  cleared. Never replace this with a per-block setblock loop (slow, and it hides the debris count).
- Known limitation (pre-existing, unfixed): JVM umask 002 means files the server creates DURING the
  episode are 664. The collector never reads region/poi/entities, but if the model successfully crafts
  the goal item, a JVM-created `stats/<uuid>.json` may be group-writable → final collect rejects →
  goal proof unverified despite success. Fixing it needs separate authorization.

## 5. Diagnosis — the remote final-report is the only truth

- Symptom: local summary says `remote_transport_outcome_unknown` or a coarse `episode_terminal_error`.
  Cause: the local side folds ssh timeouts (exit 124, `outcome_unknown`) and uncoded remote errors.
  Action: read the REMOTE `final-report.json` in `bot/model-code-sword-<run>/` — its `status` field is
  the sole authority (real case 9865aba1: local said "transport unknown", remote truth was
  `world_directory_group_or_world_writable`).
- Actor-side evidence: bot stderr/logs live under remote `bot/model-code-sword-<run>/`. A 0-byte
  journal + no `server-owned.json` = died before the server started.
- After ANY ssh timeout the state is unknown: reconcile read-only (`serverstate`, ps, docker ps)
  before retrying; never restart blind.
- Uncoded `episode_failed`: reproduce READ-ONLY on the remote (reuse the deployed `remote_episode`
  module) before touching anything — the 648afb15 stats-dir bug was proven this way.
- **`no_safe_route` is a stop, not a crash** (post-38dfb38): when the pathfinder rejects a route,
  the safety monitor records a non-sticky `routeFault {reason, node}` and PHYSICALLY STOPS the bot
  (clears the goal, stops digging, clears control states) WITHOUT tripping or quitting — no sticky
  fault, no close, no quit, the bot stays connected. The port folds the stop into
  `no_safe_route: route node N rejected: <reason>` / `route rejected: <reason>` in the goto receipt.
  Precondition to remember: the bot will NOT move again until the model issues a new goto — treat
  the receipt as "stopped at the wall, still alive", not as a terminal error. Escalation: 3
  consecutive rejected routes with no validated path in between DO trip `unsafe_route_loop` and quit.
- ssh_once per-call record JSONs are evidence: keep stems meaningful, cite them in operator records.

## 6. Prompt-lab iteration rules

- Ledger first: record every iteration in `prompt-lab.md` (run / requests / sword / placement
  attempts / reach errors / mem-plan use / change tested) before drawing conclusions.
- Reset the world to seed natural state EVERY round (chapter 3) — a depleted world is a confound.
- **Mechanism > doctrine** for anything requiring arithmetic or estimation: the placement
  pre-validation doctrine (checkable blockAt facts) worked (3→1 attempts); the reach-estimation
  doctrine FAILED (8 errors — the model cannot estimate distance); the auto-approach MECHANISM fixed
  it for good (0 receipt-level reach errors).
- Write-time normalization beats read-time hope: a wrong remembered y=71 was fixed deterministically
  by y-snapping to the trunk base at remember-time.
- Probe budget for any world-touching verification: recall verification runs under a wall budget
  (24 probes / 400 ms); UNLOADED chunks are UNVERIFIABLE, never "stale". A bare recall overran the
  program deadline and killed an episode (7fbf5741, runner_blocked) — budgets turned that death into
  a recoverable error.
- Prompt (EN) lessons: placement = one candidate + one fallback maximum; escalate search radius
  before traveling; never pass null blocks; short API names in prompts must match bindings.

## Source

`operations/20261029-minimal-sword-episode/` (prompt-lab.md, tasks.md,
OPERATOR-RECORD-furnace-reset-20261105.md, diag-20261105/offline_world_verify.py, world_rcon.py),
`operations/20261027-model-driven-sword/ssh_once.py`. 2026-11-05 furnace-reset + prompt-lab sessions.
