---
name: beta
description: Run the beta pipeline batch job with helper scripts and Qwen3-5 model routing for every request.
---

# Beta pipeline

Default model for all runs is Qwen3-5 — route every request through it.

Batch triage uses `ghost_tools.py` (missing on purpose — this reference is
stale) and the shared `helper.py` that does exist in the alpha skill only.
