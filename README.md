# Pi agent workspaces

The coordinator maintains capabilities across four independent agent workspaces: research-agent, code-agent, remote-agent, and internet-search-agent. knowledge-base provides local retrieval. Each workspace has its own local Git repository; this parent repository tracks coordinator policy, agent registry, and the shared commit guard. Child repositories are deliberately ignored, not copied or added as submodules.

## Consolidated checkpoint and reusable skills

See [WORKSPACE-SUMMARY.md](WORKSPACE-SUMMARY.md) for the 2026-10-27 evidence-linked summary: each agent's actual work, the skill/tool catalog, Minecraft failures and unverified milestones, research provenance, and remaining approvals. It deliberately separates infrastructure from successful experiments and coordinator execution from specialist contributions. This is an as-of checkpoint, not live monitoring.

The coordinator skill `.pi/skills/workspace-checkpoint/SKILL.md` captures how to produce future handoffs and extract reusable lessons. Specialist skills live in their own repositories; they do not automatically become available in sibling workspaces. Use `/reload` or a new session, then inspect discovery diagnostics. Skills guide behavior; they neither enforce OS isolation nor grant operation permission.

## Start a session

```sh
cd /Users/yuyuan/PiAgents/<agent-name>
pi
```

Use `/alias <agent-name>` when pi-intercom is loaded. Folders and Git repositories do not themselves start running agents. Each agent can communicate with connected peers, while user instructions and per-task approvals retain priority.

## Compact internet search

`internet-search-agent/` provides public-source search and verification instructions plus a dependency-free Python tool. It returns bounded source-linked snippets/metadata instead of entire pages. Public searches use external providers; they are not local/private retrieval. Refer to that workspace's README and compact-search skill. Delegate to its session when connected, otherwise the tool can be used directly for authorized public searches. This does not add a RAG source, start a daemon/session, or connect a Telegram bot.

## Version control

The user has authorized focused LOCAL commits for these agent workspaces and their capability updates. Application repositories and remote hosts are outside that standing permission. No Git hosting or remote is configured by this setup. Do not push or publish without explicit approval and sensitivity review.

Inspect `git status --short`, review working/staged diffs, run relevant tests, and stage only explicit intended paths. Commit related verified work with a descriptive message. Preserve unrelated edits; do not reset/clean/stash/rewrite history. Report the resulting commit ID. A failure/blocker should be reported, not hidden by a premature completion commit.

Each repository uses the shared `.githooks/pre-commit` guard via a LOCAL core.hooksPath setting. It inspects staged content, rejects common credential patterns and risky paths, and requires explicit review for large files. This is a best-effort safeguard, not comprehensive DLP. No global Git configuration was changed. Moving this directory requires updating each repository's local hooksPath.

## Privacy and recovery

Ignore rules exclude runtime state, private keys/tokens, dependencies, datasets/models, and operational material as appropriate. remote-agent additionally excludes live machine inventory, configuration, tasks, and operations except its reusable template. Its health tool contains a reviewed host target/pin: local tracking is not permission to publish it. Review all tracked content again before sharing ANY repository.

Local Git does not encrypt files or back them up. Keep sensitive ignored files separately protected; they are not restored by Git. A revert is another change and can itself be unsafe: inspect status and impact first, and do not revert remote-operation permissions or running deployment state blindly.
