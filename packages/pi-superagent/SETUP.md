# Setting up pi-superagent

> If you are a coding agent reading this: ask the operator one short question at a time, show the full plan once, then do it. **Never ask for a secret in chat** — steps that need the operator's hands go into one message with exact terminal commands.

## Subagent mode only (no GitHub setup)
```bash
pi install git:github.com/aicodewith-team/pi-superagent
pi        # then ask: "spawn a subagent to …"  — or type /subagent spawn <task>
```
Optional: `export PI_SUBAGENT_MAX=4` (concurrency cap). Logs: `.pi/subagents/<id>/` (add `.pi/subagents/` to `.git/info/exclude`). Subagents load only this extension (`-ne -e`), use your default model unless `model` is given, and run with the same guard. Sections 0-4 below are only for the GitHub mode.

## 0. Prerequisites
- Node.js ≥ 20, git, [pi](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent) (`npm i -g @earendil-works/pi-coding-agent`) with a working model (`pi` → `/login` or an API key).
- [GitHub CLI](https://cli.github.com/) `gh`.
- An **isolated machine or container**. Workers run commands without approval as this OS user.

## 1. Dedicated GitHub account
Create a bot account (e.g. `acme-agent-bot`), give it write access to the one target repo, and log in **as the bot** on this machine (operator runs this):
```bash
gh auth login        # choose the bot account, HTTPS, and authenticate git with gh
gh auth setup-git
```

## 2. Install the extension
```bash
pi install git:github.com/aicodewith-team/pi-superagent
```

## 3. Clone the target repo and configure
```bash
git clone https://github.com/<owner>/<repo> && cd <repo>
mkdir -p .pi && curl -fsSL https://raw.githubusercontent.com/aicodewith-team/pi-superagent/main/examples/superagent.yml -o .pi/superagent.yml
echo ".pi/superagent/" >> .git/info/exclude   # local state + worktrees
```
Edit `.pi/superagent.yml`: `repo`, `mention` (the bot login with `@`), `allow` (start with only yourself). Keep `dryRun: true` first.

## 4. Run
```bash
tmux new -s superagent 'pi'      # keep pi alive; the extension only runs while pi runs
```
In pi: trust the project if asked, then `/superagent start`. Comment `@acme-agent-bot add a CONTRIBUTING.md` on an issue, and `/superagent status` should show the work item within one poll interval.

When it looks right, set `dryRun: false`, `/reload`, `/superagent start` again.

## Configuration reference
See [examples/superagent.yml](examples/superagent.yml). State lives in `.pi/superagent/state.json`; worktrees in `.pi/superagent/worktrees/` (removed after success, kept after failure for inspection).
