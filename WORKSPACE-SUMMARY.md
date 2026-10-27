# Multi-agent workspace checkpoint

**As of:** 2026-10-27. **Scope:** completed capability setup, research, Minecraft experiments, failures, and remaining work. No new remote execution, installation, gameplay, or model training is authorized by this document.

## 1. Executive summary

We built a coordinated local agent workspace, reusable safety and evidence workflows, research records, compact public search, local retrieval, and a bounded Minecraft experiment harness. The Minecraft harness reached deployment and two real gameplay attempts, but neither collected a log. The latest navigation revision passed offline tests but has not had a gameplay episode.

**The core research result is still pending:** no Qwen-controlled Minecraft run, no fine-tuning, no before/after evaluation, and no actual Minecraft footage. Infrastructure and diagnostics are real deliverables, not evidence that the original training objective has been achieved.

The official local launcher was verified, installed, and tried in an isolated sign-in environment. Its bootstrap exited; authentication readiness was not established. At the user's request the installed app was subsequently moved to the Trash. Existing Minecraft data, the separate working directory, and the installer were retained. No alternative launcher is installed or approved.

## 2. Who does what—and what actually happened

There are **one coordinator and four specialist workspace roles**, plus a knowledge-base repository. A workspace is not a running agent or an autonomous service. At this checkpoint, coordinator/research/code/remote sessions were connected; no independent internet-search session was connected. These are six independent local repositories, not a monorepo or Git submodules.

| Workspace | Responsibility | Established deliverables and limitations |
|---|---|---|
| Coordinator (`.`) | Scope, approvals, integration, collaboration and evidence quality | Agent registry/policies; independent local Git setup and shared staged-content guard; intercom/Telegram capability setup; cross-workspace maintenance. The coordinator also performed the recorded Minecraft execution, diagnostics and Mac launcher work. Do not attribute those executions to another agent just because records live in its directory. |
| `research-agent/` | Evidence-based literature work | Focused simulated-patient behavioral-fidelity review; five-paper LLM-training review; voice/psychiatric simulated-patient landscape; source/search notes and experimental proposals. PDF tracking skill/tool/template were added by the coordinator; the voice report and search routing include research-agent contributions. No patient simulation experiment or model training ran. |
| `code-agent/` | Scoped software implementation and validation | Task/configuration/instruction scaffold, safe repository workflow, and knowledge retrieval routing. Earlier Minecraft implementation was coordinator takeover, not a completed code-agent implementation. A further implementation-validation skill was proposed during this checkpoint but deferred; it is not present or counted as delivered. |
| `remote-agent/` | Approved, bounded remote operations | Enrollment/approval/SSH safety policies; five original operation skills; fixed pinned health tool and offline tests; private operational-record structure. Minecraft deployment/run/diagnosis evidence is stored here, but the coordinator owned its execution. This checkpoint adds two Minecraft-specific procedural skills; none grants standing remote access. |
| `internet-search-agent/` | Compact public-source discovery | Dependency-free web/GitHub/academic-metadata search tool, bounded source-linked results, compact-search skill and offline tests. Dedicated session launch was unsuccessful; the tool remains usable directly under its instructions and normal network approval. Metadata/snippets are leads, not verified primary evidence. |
| `knowledge-base/` | Local retrieval infrastructure, not an agent | SQLite FTS5 indexing/search, source locators, incremental refresh and exclusions, six offline tests. Scope is the approved research/code sources, not all repositories or remote records. No embeddings, external vector database, or continuously running indexer was installed. Local retrieval does not make a cloud model's context private. |

## 3. Skills catalog

The seven existing project skills were:

| Workspace | Skill | Purpose |
|---|---|---|
| Research | `paper-tracking` | Check duplicate/version records; record PDF acquisition and exact reading coverage with provenance. |
| Search | `compact-search` | Discover public sources with small, bounded, source-linked results; verify selected originals. |
| Remote | `remote-health` | Approved bounded health inspection; a fixed tool is not permission for arbitrary SSH. |
| Remote | `remote-storage` | Bounded disk attribution and guards; no implicit cleanup. |
| Remote | `remote-deploy` | Approval, backups, constrained deployment, verification and rollback limits. |
| Remote | `remote-training` | Resource/approval-aware training preparation and operation; no training was performed. |
| Remote | `remote-recovery` | Evidence-preserving recovery planning; no destructive reset by default. |

This checkpoint adds three reusable skills (ten project-authored skills total):

| Workspace | Skill | Lesson captured |
|---|---|---|
| Coordinator | `workspace-checkpoint` | Evidence-linked handoff, actual authorship, status classification, and extraction of reusable skills without broadening permissions. |
| Remote | `minecraft-baseline` | Version/source integrity, bounded single-episode lifecycle, evidence-based success, safe cancellation and record integrity. |
| Remote | `private-game-view` | Version-fidelity gates, private transport, account privacy, client/capture approval separation and truthful visual evidence. |

These are Markdown instruction skills, not newly running programs or enforced security controls. Paths are `<workspace>/.pi/skills/<name>/SKILL.md`; the coordinator's workspace is `.`. They are project-scoped; sibling repositories do not automatically load one another's skills. Use `/reload` or a new session to discover additions, and inspect startup diagnostics. Structural checks alone do not prove Pi loader discovery or safe runtime behavior.

Installed external capabilities are separate from these project-authored skills: pi-intercom, the Telegram bridge, and its control-surface/show-me/Generative Apps guidance. Telegram connectivity is not permission to publish, start another bot poller, or send private records. No custom Generative App was created for Minecraft.

## 4. Research and data records

Key reports under `research-agent/reports/`:
- `behavioral-fidelity-llm-simulated-patients.md`: five-study focused review; learner outcomes are not patient-fidelity validation.
- `llm-training-five-papers.md`: selected foundational training-paper review, not a training experiment.
- `voice-mental-health-simulated-patients-landscape.md`: seven-source landscape distinguishing direct from adjacent evidence, metrics and two proposed experiments.

The paper registry supports stable identifiers/aliases, local-copy hashes, acquisition/read events, exact coverage and notes, duplicate/missing-copy checks, atomic writes and locking. It does not itself download, extract or read papers and is not a watcher.

**Important correction against overstating progress:** research-agent's local-file check found zero registered papers and no PDF acquisition/read events in the registry or available notes. Existing reports used sources such as publisher/PMC XML and arXiv HTML; those must not be retroactively described as PDF reading. The reviews are focused, not systematic, and require broader coverage/expert validation before strong clinical claims.

## 5. Minecraft project ledger

### Framework and experiment design
- Compared headless agent frameworks, separating planners/skill memory from weight training. Mindcraft was the preferred planner candidate; insecure code execution must remain disabled. Other frameworks remain alternatives, not installed systems.
- The requested Qwen model identity was not resolved to a verified checkpoint. No model was downloaded, served or trained.
- Chose a deterministic four-log Survival task first, to distinguish environment/skill failures from model quality. Success requires at least four net qualifying logs plus own-harvest/correlated-pickup evidence, not an inventory delta alone.

### Environment and execution
- Built a private Java 1.21.6 server/bot scaffold, completed an approved connection/spawn probe, and verified shutdown afterward.
- Added pinned Mineflayer/pathfinder dependencies and a separate baseline image while preserving the original probe image/source/backups.
- Kept the game private, used bounded CPU/memory/logs/time, and did not use remote GPUs or publish a public game port.
- Implemented bounded controller/adapter/JSONL recorder, check-only default, explicit live opt-in, movement/safety limits, deadline/cancellation behavior and source manifests.

| Revision / attempt | Established result | What it does NOT prove |
|---|---|---|
| Original baseline / attempt 1 | Startup returned success, then failed `stale_state`; no navigation or harvesting; zero logs. Initialization diagnostic coverage was insufficient. | The exact stale component was not established. |
| `four-log-v1.1` startup fix | Real fresh physics/chunk/health readiness gate; more prevalidation evidence; 42 offline tests reported passing locally and on cached remote Node. | One successful startup does not prove the readiness issue can never recur. |
| `v1.1` / attempt 2 | Initialization succeeded; task failed `unsafe_route` after bounded attempts at three adjacent block targets. Some movement occurred. No harvesting/pickup; zero logs. Shutdown verified. | Targets were not three confirmed distinct trees; logs do not establish whether terrain, planner constraints or the later reproduced defect caused the failure. |
| Local diagnostic probes | A non-null unknown-block placeholder lacking position could throw in the navigation callback and be mapped to `unsafe_route`. | Reproducing this defect locally does not prove it triggered attempt 2. |
| `four-log-v1.2` | Missing/nonfinite step positions fail closed; bounded terminal navigation diagnostics preserve cause before cleanup. 52 offline tests reported passing locally and in the cached remote test environment; source published with backups/manifests. | **No v1.2 gameplay episode has run.** Harvesting and four-log success remain unverified. |

The two episodes advanced the retained world; no reset/retry was silently performed. Latest observed game-service shutdown was verified during approved operations; it was not freshly checked for this summary. Offline tests used mocks/cached code and are not successful Survival episodes. The application source and evidence remain in the private project/ignored operation records, not in agent-capability Git commits.

### Visualization and local client work
- Produced and delivered a trajectory schematic from saved samples, explicitly labeled not an in-game screenshot. No terrain or continuous path was invented.
- Investigated a browser renderer. A bounded synthetic registry check found 8,707 differing/missing block names among 27,946 compared state IDs for the chosen version mapping. Some common defaults/roundtrips matched; faithful complete rendering was not established. No viewer was installed or frames rendered. This is not a measurement of incorrect world area or pixels.
- Tried an official launcher on the local Apple Silicon Mac, with verified official DMG/signing/Gatekeeper and already-installed Rosetta only. The verified app was installed without overwriting an existing app. Old Minecraft data was isolated rather than copied, because launcher profiles can contain sensitive state.
- The guarded bootstrap exited after about 17 seconds. No persistent sign-in UI/authentication readiness was established; the cause is unknown. No unrestricted retry was performed and no authentication files were inspected.
- The user then requested removal. Only the installed app was moved to the Trash; installer and working data remain. No game/runtime preparation, real-client launch, world entry, tunnel or recording occurred under that attempt.
- Prism Launcher was suggested for a future native-client review only. Its current compatibility/signing/security have not yet been verified and installation is not approved.

## 6. Validation accounting

Known suite counts and evidence (not a fresh run of every suite):
- Shared staged-content guard: 5 tests passed again during this checkpoint's local validation.
- Knowledge retrieval: 6 offline tests.
- Paper registry: 6 offline tests; research-agent did not rerun them in its summary check.
- Compact search: 6 offline tests.
- Fixed remote health tool: 10 offline tests; these are not ten remote health runs.
- Minecraft baseline revisions: 31 original, 42 startup-fix, 52 navigation-fix tests, each revision a suite total rather than additive new successes.

Checkpoint-specific checks: the installed Pi skill-directory loader discovered all ten project skills with zero diagnostics; the five shared guard tests passed; changed documentation passed whitespace/diff checks. These validate discovery and commit safeguards, not the runtime workflows. Commit identifiers are reported separately in the completion message. No fresh network check, remote test, gameplay, launcher retry or research experiment is implied by local documentation validation.

## 7. Lessons and process changes

1. **Choose the smallest end-to-end evidence gate first.** For viewing, verify exact version and a supported native/renderer path before spending time on transport/capture plumbing.
2. **Stop infrastructure work being mistaken for research progress.** The four-log task, Qwen integration and model-improvement evaluation each need their own acceptance gate.
3. **Diagnose before changing policy.** Preserve first cause and bounded state evidence; do not relax safety or invent a root cause to make a run appear successful.
4. **Separate code, deployment and experiment.** Source publication plus offline tests is not live success; backups/manifests identify what ran but are not a whole-tree transaction or a full world backup.
5. **Make agent work ownership visible.** The coordinator did substantial execution; a repository name is not proof of specialist contribution. Future handoffs should be smaller and acknowledged before takeover.
6. **Preserve approvals as narrow checkpoints.** Install, authentication, runtime preparation, menu launch, remote forwarding, server episode and capture are distinct actions. Buttons, skills and plans are not accepted permission.
7. **Record failures and removals.** Keep the original failure evidence, current state and retained artifacts; do not leave a handoff suggesting a removed app is installed or a failed viewer is operational.

## 8. Remaining work and recommended sequence

1. Decide the observation path after a read-only native-launcher compatibility/security review; obtain approval before any alternative installation.
2. If actual footage is still required, separately approve local authentication, game/runtime preparation, menu-only launch, private connection and capture. Keep account state off shared remote machines.
3. Obtain a fresh single-episode approval for `v1.2`, preserving the existing safety/task policy and world. Use its new diagnostics to decide what to fix next; no automatic retry loop.
4. Only after a reproducible baseline: select a verified model, define skill/tool contracts, choose seed/reset/snapshot policy, establish evaluation splits and resource budgets, and then approve inference/training separately.
5. For psychiatric voice research: expand/verify primary evidence and establish expert rubrics/ethics/data boundaries before building or evaluating simulated patients.

**Nothing in this sequence has been implicitly started.** The durable capabilities are useful, but the next milestone should be a small, explicitly accepted end-to-end result rather than another large infrastructure branch.

## 9. Where to resume

- Root `AGENTS.md`, `README.md`, `agents.json`: ownership and repository boundaries.
- Per-agent `AGENTS.md` and `.pi/skills/`: reusable behavior; role-specific config/tasks remain subject to ignore/privacy rules.
- `knowledge-base/README.md`: exact approved retrieval scope and limitations.
- `research-agent/reports/`, `notes/`, registry tool and paper-tracking skill: evidence and provenance workflow.
- Ignored `remote-agent/operations/`: detailed approvals, source manifests, run/fetch results, failure evidence, retained artifacts and launcher removal checkpoint. Review privately, not by bulk attaching or indexing the directory.

Local Git preserves reviewed capability changes only. It does not back up ignored operational evidence, remote worlds, installers, account state or model/data artifacts, and it does not authorize publication.
