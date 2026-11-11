# pi-delegation-reminder

A minimal Pi extension that mechanically reminds the main session of its
**dispatcher role** on every turn, so delegation rules cannot be forgotten
under flow.

The standing rule (`~/.pi/agent/AGENTS.md`): the main session is a
router/coordinator — every delegatable task must be dispatched via
`subagent_spawn` (model `GLM-5.3-Flash`); main-session edit/write is allowed
only for cross-module integration glue, unavailable delegation tools, or an
explicit user instruction in the current turn. Prose in `AGENTS.md` is
necessary but not sufficient; this extension re-injects the rule mechanically.

## Reminder text

Single constant (`REMINDER`) at the top of `index.js` — edit it there, then
`/reload`:

> ROUTER CHECK: You are the dispatcher. (1) DECOMPOSE FIRST — for every
> nontrivial request apply decompose-or-execute (independently verifiable?
> disjointly owned? context/budget favor delegation?), state the split before
> acting. (2) Before any edit/write, state the routing decision or dispatch via
> subagent_spawn (model GLM-5.3-Flash). Main-session edits only for cross-module
> glue, unavailable delegation tools, or explicit user instruction this turn.

(~57 words; the tests assert it stays ≤ 60.)

## How it works

- On every run start the extension subscribes to Pi's **`before_agent_start`**
  hook and writes the reminder into the structured system prompt as its own
  section: `event.systemPromptOptions.sections["delegation-reminder"]`.
- Pi diffs system-prompt sections against what the model already has and
  appends only the changed part, so the injection is cache-friendly, and the
  section remains part of the system prompt sent with **every model request
  (every turn)** — not just once per transcript.
- Fallbacks for older Pi without `systemPromptOptions.sections`: the reminder
  is appended to the chained system prompt (string or array of parts).
- Zero dependencies, one small file (`index.js`), no settings changes.

## Install

Copy or symlink the package into Pi's global extension directory (Pi
auto-discovers subdirectories whose `package.json` has a `pi.extensions`
field, one level deep):

```sh
ln -s /Users/yuyuan/PiAgents/packages/pi-delegation-reminder ~/.pi/agent/extensions/pi-delegation-reminder
# or: cp -r /Users/yuyuan/PiAgents/packages/pi-delegation-reminder ~/.pi/agent/extensions/
```

**This package is not installed by default.** Activation is a separate human
decision: the command above plus a reload (below) is all it takes, and
uninstalling is just removing the symlink/directory and reloading.

## Activation notes

- Takes effect in **new sessions** or after **`/reload`** in existing ones.
- `/reload` kills in-flight background subagents — avoid reloading while a
  long task is running.
- Verify it is loaded by checking that a new turn's system prompt contains the
  `ROUTER CHECK` text, or by running the tests below.

## Test

```sh
cd /Users/yuyuan/PiAgents/packages/pi-delegation-reminder
npm test          # node --test test/
```

The tests load the extension module with a capture-style fake of the pi API
(no Pi runtime needed) and assert: the reminder is short and mentions the key
rule parts; exactly one `before_agent_start` handler is registered; the
section path injects without clobbering other extensions' sections and is
idempotent; the fallback paths handle string, array, and missing prompts.

## Files

- `index.js` — the extension (reminder constant + `before_agent_start` hook)
- `package.json` — manifest with `pi.extensions` entry point
- `test/reminder.test.js` — `node --test` suite
- `README.md` — this file
