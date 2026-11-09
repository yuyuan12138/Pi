---
name: info-router-sources
description: Add a source plugin to the info-router daily-digest pipeline (repo /Users/yuyuan/projects/info-router). Covers the base.Source fetch contract, config.toml wiring, mock-based zero-network tests, the curl-subprocess workaround for TLS-fingerprint blocks, and safe dedupe state handling. Use when adding, testing, or smoke-running an info-router source.
---

# info-router — adding a source plugin

Repo `/Users/yuyuan/projects/info-router`; run tests with `.venv/bin/python -m pytest`.

## 1. New source in four steps

1. `sources/<name>.py`: define `class Source(base.Source)` with `name = "<name>"` and
   `fetch(self, cfg, query=None) -> list[base.Item]`. `cfg` = the `[sources.<name>]` table from
   config.toml; `query` = the CLI `--now` query word (may ignore). The registry
   (`sources/__init__.py`) auto-discovers the file by pkgutil scan — NO core change needed
   (`reset_registry_cache()` exists for tests/dynamic loads).
2. Emit `base.Item(id=…, source=self.name, title=…, url=…, summary=…, published=…, meta={…})`;
   `dedupe_key` is auto `f"{source}:{id}"`. Follow `github_trending.py` conventions: per-item
   failure → skip the item; per-request failure (403/timeout/parse) → degrade gracefully and return
   what you have; never let one bad entry kill the whole fetch.
3. `config.toml`: add a `[sources.<name>]` section (mirror `config.example.toml`). Without a config
   section the source is skipped in scheduled runs — only `--now` mode runs unconfigured sources.
4. `tests/test_<name>.py`: zero network is ENFORCED (conftest blocks socket). Mock
   `monkeypatch.setattr(<mod>.requests, "get", fake_get)` returning `tests.conftest.FakeResponse(payload=…)`;
   route canned responses by query-string to cover each query group your fetch issues.

## 2. TLS-fingerprint blocking → curl subprocess

- Symptom: `requests` gets 403 / redirect-to-login while curl with the same UA gets 200.
- Cause: the target (e.g. reddit) blocks the python-requests TLS fingerprint.
- Action: fetch via `subprocess.run(["curl","-sSL","--max-time",str(t),"-A",ua,"-H","Accept: application/json",url], capture_output=True, text=True)` and `json.loads(stdout)` (see `sources/reddit.py`).
- Tests then stub `subprocess.run` (monkeypatch), NOT `requests`.

## 3. Dedupe state — never touch the real state.json in tests

- `state.py`: `State(path)` wraps JSON `{"seen": {dedupe_key: …}, "last_push"}` with
  `unseen()` / `mark_seen()` / `mark_all_seen()`; `DEFAULT_PATH = data/state.json` is the REAL state.
- In tests and smoke runs always pass a throwaway path (`State("/tmp/...")` or `--state /tmp/...`);
  a run against the default path would swallow today's items as "seen".

## 4. Smoke-verify a new source

```bash
set -a; source ~/.config/info-router/env; set +a   # exports INFO_ROUTER_SMTP_PASSWORD; set -a is required
cd /Users/yuyuan/projects/info-router
.venv/bin/python -m cli preview --source <name>     # read-only, no email
.venv/bin/python -m cli send --state /tmp/info-router-smoke-state.json --now --source <name>
```
