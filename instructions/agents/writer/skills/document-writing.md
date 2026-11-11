---
name: document-writing
description: Write documents (Feishu docx / local markdown) in the user's preferred style — plain language, detailed, no technical jargon — deliver via the correct Feishu tenant-domain link, and keep this skill's preference list updated from user feedback after every delivery.
---

# Skill: document-writing (writing documents)

Write documents in the user's preferred style, and continuously record newly
learned preferences back into this file. This skill is alive — not a
write-once-then-dead template.

## Most important rule: update this skill after every delivery

After every document, if the user gave new feedback (liked/disliked a phrasing,
pointed out a new pitfall), append the new preference to the "User Preferences
(Continuously Updated)" section below: one entry per line, dated, recording
"what the user said → how to write from now on". No feedback, no change. The
plain-language writing habits and the Feishu delivery pitfalls below all grew
out of this mechanism, one entry at a time.

## The user's document style: plain language, detailed, no piled-up technical detail

The user said explicitly: "Write it in detail, in plain language, without too
much technical detail." Operationalized as three rules:

- **Explain clearly, in detail**: what was done / how it turned out / where it
  is stuck / what comes next — explained paragraph by paragraph. Prefer
  slightly longer over terse; the user wants to "understand what happened".
- **Plain language**: words an ordinary person understands. Say "the system
  now starts normally, and if it crashes it is restarted automatically", not
  "process liveness check passed, automatic restart policy in effect".
- **No piled-up technical detail** (the no-technical-jargon checklist; any hit
  is a violation):
  - No commit hashes (e.g. a1b2c3d)
  - No class names / function names / module paths or other code symbols
  - No concrete parameter values (e.g. spawn-protection=16, timeout=30s)
  - No test counts (e.g. "415 tests")
  - No library/framework version numbers (e.g. Node 22.11, pytest 8.3)
  - When a technical term must appear, follow it with a plain-language
    explanation (e.g. "protection mechanism (keeps the service from being
    killed by mistake)")

## Language by audience (org rule, 2026-11-05)
- Agent-authored published docs (README, ADR, runbook, spec — anything
  other agents or future maintainers read): written in English.
- Deliverables whose audience is the user (Feishu documents, chat
  reports, user guides): written in the user's language.
- The plain-language style rules above apply to both; only the language
  differs.

## Feishu document delivery flow (with known pitfalls)

1. **Create the document**: read credentials from the path the task brief
   gives (read-only; credentials never enter this skill or the experience
   log), then create the docx under the target folder. Pitfall: **the
   batch_create endpoint returns 404** — write the body block by block via
   the **single-block children endpoint**.
2. **Share to the author**: add the author as an edit collaborator. Without
   sharing, the user has no permission to open it.
3. **Link sharing**: use **PATCH** (not POST) to set link sharing to
   **tenant_editable**. The only valid enum values are: tenant_readable /
   tenant_editable / anyone_readable / anyone_editable / closed — anything
   else is rejected.
4. **Take the correct-domain link**: take the **url field** from the
   `GET /drive/v1/files` response (shape: `ycndys4bta39.feishu.cn/docx/<id>`).
   **Never use open.feishu.cn** — it is the developer-console shell; the user
   sees a "page not found" error there.

Treat "the user can actually open it" as the acceptance criterion at
delivery: link from the correct domain + sharing set — missing either one
means the delivery is not done.

## User Preferences (Continuously Updated)

Format: `- YYYY-MM-DD user feedback (verbatim or summary) → how to write from
now on`. Append new entries at the end of the list; never modify old entries
(when an old preference is overturned, the new entry notes which dated entry
it overrides).

- 2026-11-03 user: "Write it in detail, in plain language, without too much
  technical detail" → all documents in plain, detailed language; strip jargon
  such as commit hashes / class names / parameter values / test counts /
  version numbers; explain unavoidable technical terms in plain words.
- 2026-11-03 Feishu link pitfall → the delivered link must come from the url
  field of /drive/v1/files (ycndys4bta39.feishu.cn tenant domain);
  open.feishu.cn shows the user a "page not found" error.
- 2026-11-03 document-creation pitfall → batch_create returns 404; write the
  body block by block via the single-block children endpoint; link sharing
  via PATCH + tenant_editable, and add the author as an edit collaborator
  first.

<!-- Append new preferences here: one per line, dated, "what the user said → how to write from now on" -->
