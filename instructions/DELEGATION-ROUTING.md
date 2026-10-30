# Explicit delegation routing

## Default ownership

Before nontrivial execution, declare the category, bounded deliverable, owner,
write boundary, authorization and acceptance evidence. Do not wait for the user
to ask for an agent. The primary coordinates and verifies, rather than taking
execution work by default.

| Category | Default owner | Boundary |
|---|---|---|
| research | fork or subagent | Public-source research; subagent remains read-only |
| implementation | fork | Feature development and nontrivial fixes |
| testing | fork | Reproduction, test authoring and independent execution |
| review | subagent | Read-only advice/review, no edits or remote execution |
| deployment | fork | Only already-authorized target and operations |
| coordination | primary | Requirements, decisions, task briefs, integration acceptance |
| trivial | primary | Truly trivial single-point work, not a whole feature |

These are task roles, not persistent departments. Usually use at most two
independent children concurrently, with disjoint write ownership. Children must
not delegate. Use the session model/provider unless the user authorizes a change.
The primary reviews actual diffs and material evidence; a child's PASS report is
not final acceptance. API checks do not establish browser usability, and an
idempotent response does not establish that scoring ran again.

## Explicit exceptions

Primary execution of nontrivial work requires a declared applicable exception:

- `unavailable-tools`: delegation tools are actually unavailable, not merely
  inconvenient. Applies to research, implementation, testing, review, deployment.
- `integration-only`: inseparable integration or focused integration verification,
  not a feature relabeled as integration. Applies to implementation/testing.
- `trivial-fix`: a genuinely tiny correction or its focused regression check.
  Applies to implementation/testing; not deployment or broad research/review.

Exceptions apply only to primary ownership. They never expand permissions or
waive required verification. Review independence cannot be claimed when the
primary reviews its own implementation under a fallback exception.

## Advisory Python validator

From the repository root:

```sh
python3 tools/delegation_gate.py --category implementation --owner fork
# ALLOW, exit 0
python3 tools/delegation_gate.py --category implementation --owner primary
# DENY, exit 1
python3 tools/delegation_gate.py --category implementation --owner primary --exception integration-only
# ALLOW, exit 0
python3 -m unittest discover -s tools -p test_delegation_gate.py
```

The CLI accepts only structured enumerated inputs; it does not infer category
from keywords, call an LLM, execute a task or persist task text. Exit 0 means the
**declared ownership** is allowed; 1 means a policy mismatch; 2 means invalid CLI
arguments. It can be used in a manually invoked preflight or CI check, but is not
currently wired into either.

**This is not actual Pi tool interception, a security sandbox, an automatic
launcher, or proof that a child ran.** A caller can omit the check, misclassify a
task or falsely declare tool unavailability. A successful validator invocation
must not be reported as successful delegation. No Pi hooks are installed here.

## Possible future hard gate (not implemented)

Real enforcement needs a separately designed and tested Pi tool-call hook:
validated per-task ownership state, trustworthy child execution evidence,
primary-versus-child identity, constrained exceptions, and clear recovery when
tools are missing. It must cover shell/CLI bypass paths and avoid blocking
legitimate primary inspection or integration verification. Design against the
installed Pi documentation before implementing. A Python file alone cannot
provide those guarantees. Retain publication, restart and destructive-operation
authorization checks regardless of routing.
