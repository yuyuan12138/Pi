---
name: hbench-ab
description: Run the HarnessBench pi-vs-pi-stack A/B benchmark on this Mac (ClawBench v1-lite 20-task suite, both arms containerized). Use when preparing, smoke-testing, running, resuming, or triaging the local harness A/B — container-engine prerequisites, arm-purity gate, GLM tunnel reachability from host and containers, smoke-first sequencing, and the upstream run/batch exit-10 workaround.
---

# HarnessBench pi vs pi-stack A/B (local Mac)

Everything lives in `/tmp/hbench-ab/`: `SMOKE.md` (smoke sequence),
`run-ab.sh` (one-command full run, resume-safe), `check-arm-delta.sh`
(purity gate), `install-harness.sh`, `README.md` (design + provenance).

## Prerequisites
- **Container engine**: `docker info` must succeed — colima started with
  `--cpu 4 --memory 8 --disk 60` plus the homebrew `docker` CLI. Nothing in
  the repo installs an engine; that is an operator step.
- **harness-bench** installed as a uv tool at
  `~/.local/share/uv/tools/harness-bench/` (its venv python and the bundled
  `clawbench-run` / `clawbench-batch` console scripts live there).
- **Model endpoint**: GLM tunnel on `127.0.0.1:18002` must be reachable from
  **both the host and the containers** (models.yaml uses
  `http://host.docker.internal:18002/v1`). Verify both sides before any run
  (curl from host, and a `--add-host=host.docker.internal:host-gateway`
  container curl). #1 smoke-failure cause. On Linux engines a tunnel bound to
  127.0.0.1 is NOT reachable via host-gateway — republish on 0.0.0.0 or socat.

## Two registry arms + purity gate
- `pi-bare`: pinned pi 1.5.0 alone.
- `pi-stack`: same image/script **plus** seeded `AGENTS.md`, pi-superagent +
  observational-memory extensions (the only intended delta).
- Before any batch, `check-arm-delta.sh` must end **`15 passed, 0 failed`**
  (P1–P12 assertions, negative-mutation tested). Re-run it whenever an arm
  file changes; the runner re-runs it on every start.

## Flow: smoke first, then the 20-task Lite batch
1. **Smoke** (SMOKE.md): 1 task × both arms first, ~35 min/arm worst case
   including image build. Pass = exit 0 + `run-meta.json`, non-empty
   `data/usage.jsonl` (model path works), non-empty
   `data/agent-messages.jsonl`, `.stop-reason` present; pi-stack must also
   show AGENTS.md/subagent evidence in its startup events.
2. **Full run**: `run-ab.sh` — engine gate → arms+images → 20-task v1-lite ×
   2 arms (`clawbench-batch`, separate batch dir per arm, resume-safe) →
   collect → summary. Results land in
   `/tmp/hbench-ab/results/summary/results.csv` (+ `summary.txt`, per-arm
   `<arm>-rollup.json`) with per-arm verdict and token counts. Worst case
   ~20 h serial; `AB_MAX_CONCURRENT` parallelizes. Interrupted batches resume
   in place (skips completed (case × arm) triples).

## Known upstream defect
`harness-bench`'s own `run`/`batch` entry points call a nonexistent
`clawbench.run_case` and die with **exit 10** — use the bundled
`clawbench-run` / `clawbench-batch` console scripts instead (they are the real
pipeline; `run-ab.sh` already drives them).

## Other smoke-time risks
- **Judge inconclusive**: default judge is the same reasoning model; its
  800-token budget can be eaten by reasoning → `judge.json.match = null`.
  Rerun with `AB_NO_JUDGE=1` or point the judge at a non-reasoning endpoint
  (the YAML key is sent verbatim upstream as the model id).
- **LiteLLM proxy**: `litellm[proxy]==1.83.9` installs at image build; if the
  proxy never turns healthy, read `/data/proxy.log` surfaced in `docker logs`.
- pi 1.5.0 needs no network beyond the model endpoint and task websites (npm
  pin installed at build).
