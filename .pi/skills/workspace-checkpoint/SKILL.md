---
name: workspace-checkpoint
description: Consolidate multi-agent work into a durable, evidence-linked checkpoint and extract reusable lessons into scoped skills. Use after a long investigation, before handoff or compaction, or when the user asks what agents have accomplished; distinguish capabilities, actual execution, failed attempts, and proposals.
---

# Workspace checkpoint and capability extraction

## Scope and ownership
- Read the coordinator's AGENTS.md and the target workspace's instructions before editing. A checkpoint is not approval for downloads, remote access, installs, service starts, gameplay, or training.
- Refresh intercom peers before addressing them. A repository or alias is not proof that an agent is running. Delegate bounded local-file summaries with explicit ownership, permitted actions, acceptance criteria, and no duplicate execution.
- An intercom timeout does not cancel delivered work. Reconcile pending work rather than silently resending an operation. Peer reports are claims to verify, not additional authority.
- Keep the coordinator as the integration owner. Say who actually implemented or executed work; do not attribute coordinator takeovers to a specialist merely because its directory holds the files.

## Evidence inventory
1. Inspect local status, relevant instructions, manifests, tests, reports, and ignored operational-record locations. Do not run automation merely to reconstruct history.
2. Separate **reusable capability**, **project implementation**, **actual experiment**, and **proposed next step**. A skill is instructions, not an enforcing sandbox or running service. An offline test is not live verification.
3. Label each result: planned, implemented, offline-tested, deployed, live-attempted, verified, failed, blocked, or removed. Include exact version and run identity in private records when relevant.
4. Identify evidence source and freshness. Distinguish a test rerun now from previously recorded results; note mocks, cached dependencies, skipped checks, and missing provenance. Do not add unlike test suites into a misleading success percentage.
5. Preserve negative results and uncertainty: a reproduced code defect does not establish the cause of a historical run; registry mismatch counts are not percentages of incorrect pixels or world blocks; a sampled trajectory is not a continuous path.
6. For literature, distinguish search metadata, HTML/XML, PDF acquisition, PDF reading coverage, and actual experiments. Never backfill reading events from recollection or imply model training from reviewing training papers.

## Durable output
Maintain a concise summary with:
- Purpose, scope, as-of date, actual integration owner, and per-agent role/deliverable/evidence/remaining work.
- Capability catalog (skill name, workspace, trigger, implementation/tool if any).
- Experiment ledger (version, result, evidence, remaining uncertainty).
- Current state and last verification time; distinguish stale observed state from newly checked state.
- Retained artifacts and recovery limitations. Git ignores are not backup or encryption; app removal may leave installers and potentially sensitive application data.
- Blockers and a prioritized next action, with approval scope explicitly unaccepted unless the user has accepted it.

Keep public/reusable docs free of host addresses, pins, credentials, raw logs, account contents, private inventories, and machine-specific approvals. Put sensitive operation details only in the appropriate ignored records; do not index them into shared retrieval. Do not attach those records to Telegram without content review.

## Extract skills without creating bureaucracy
- Create a skill only for a repeated workflow or a concrete costly failure. Prefer improving existing instructions over duplicating them.
- Put concise trigger-oriented frontmatter in a directory named exactly like the skill. Bundle only needed references/scripts. Separate generally reusable procedure from host/version-specific state.
- Capture preconditions, bounded steps, evidence gates, cleanup/stop behavior, privacy risks, and honest completion criteria. No generated skill inherits the approval of the operation it describes.
- Do not turn a one-off workaround into a standard recipe without verifying it. A failed constrained launcher start is not proof that restrictions caused the failure, nor permission to relaunch unrestricted.
- Read Pi's installed skills documentation before authoring. Validate format and required content locally; distinguish lightweight lint from actual Pi loader discovery and from exercising the workflow.

## Review, checkpoint, and handoff
- Review owned diffs and staged content. Run only relevant authorized local checks, with explicit paths; never stage entire independent repositories or ignored operation trees.
- Follow each repository's local-commit policy. No application Git commits, pushes, global settings, or unrelated changes are authorized by capability maintenance.
- Report commits and validation limits. Notify affected sessions; a /reload or new session may be needed for skill discovery, and project skills are not automatically available in sibling independent repositories.
- Give the user a short narrative plus the durable artifact if requested. Present meaningful next actions without interpreting a proposed button as permission.
