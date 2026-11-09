
Protocol test complete. Executed exactly the three bounded steps: (1) progress report sent, (2) created /tmp/pi-superagent-report-test2.txt with the single line "HELLO from Qwen3-5 DeepSeek-style worker" and verified the content by reading it back, (3) ready report sent with the file path and write confirmation. No user files, ~/.pi, credentials, or network were touched.
# MC RSI Episode — Deployment/Reload Friction Inventory (read-only)

Paths: `EP = remote-agent/operations/20261029-minimal-sword-episode/`, `CORE = remote-agent/operations/20261028-single-agent-sword-v2.1/`. All line numbers below verified against the files.

---

## Q1 — Cold-start step sequence and shell invocations per round

The operator-documented sequence (`.pi/skills/mc-rsi-episode/SKILL.md`, "The correct episode sequence") is **5 shell invocations per round**, plus 3 unscripted prerequisites:

| # | Command | Process type |
|---|---------|--------------|
| 0a | `docker stop 9fc2995b` | manual (server must be `exited`; else deploy fails "Server already active; no takeover", `deploy_artifact.py`) |
| 0b | RCON tree placement + server stop (save world) | manual (SKILL.md pitfall 7) |
| 0c | SSH tunnel to `127.0.0.1:18002` must be up | operator-managed long-lived `ssh -L`; **no tunnel-launch command exists anywhere in the repo** (only referenced in `openrouter_client.py:20-24` and SKILL.md) |
| 1 | `python3 prepare_artifact.py` | local python |
| 2 | `cp artifact-receipt-<run>.json prepared-artifact.json` | shell cp (deploy reads the **fixed** filename, `deploy_artifact.py:12`) |
| 3 | `python3 deploy_artifact.py` | local python → 1 one-shot SSH |
| 4 | `python3 run_runtime_preflight.py` | local python → 1 one-shot SSH |
| 5 | `PI_MC_PROFILE=local-qwen python3 run_model_episode.py artifact-<run>/episode-config.json` | local python → ssh-keyscan + long-lived SSH session + ssh-keyscan + SSH evidence read |

The automated variant `EP/rsi_loop.py` runs the same 5 steps as **separate subprocesses** in one loop (prepare → cp → deploy