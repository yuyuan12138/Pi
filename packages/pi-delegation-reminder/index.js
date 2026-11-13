// pi-delegation-reminder — mechanical router-role reminder for the main session.
//
// The user's standing rules (~/.pi/agent/AGENTS.md) for the main session,
// a router/coordinator:
//   (1) DECOMPOSE FIRST — every nontrivial request gets decompose-or-execute
//       (independently verifiable? disjointly owned? context/budget favor
//       delegation?), with the split stated before acting;
//   (2) the edit→dispatch gate — every delegatable task is dispatched via
//       subagent_spawn (model GLM-5.3-Flash); main-session edit/write is allowed
//       only for cross-module integration glue, unavailable delegation tools, or
//       an explicit user instruction in the current turn;
//   (3) the user-data write gate — writes into shared external state (ledgers,
//       sheets, cloud docs, Notion, any shared data store) are never inline, not
//       even a one-row bookkeeping entry found "while just checking the sheet";
//   (4) project-space routing — attribute the turn to a registered coordinator
//       project, begin every dispatch brief with [project:<name>], and include
//       a work record in that project's work/ directory
//       (PROJECT-SPACE-STANDARD).
// Prose alone gets forgotten under flow, so this extension mechanically
// re-injects all four rules.
//
// Mechanism: on every run start ("before_agent_start") the reminder is written
// into the structured system prompt as its own section
// (event.systemPromptOptions.sections). Pi diffs sections against what the
// model already has, so an unchanged reminder costs nothing, and the section
// stays part of the system prompt sent with every turn of the session.
// Fallbacks cover older Pi versions without systemPromptOptions.sections.
//
// To change the reminder, edit the REMINDER constant below and /reload.
// Activation: this extension ships in the installed Pi package set, so a text
// change here does NOT reach a running session — the session must be started
// fresh or /reload'ed before the new wording is injected.

/** Key under systemPromptOptions.sections; namespaced to avoid clobbering other extensions. */
export const SECTION_KEY = "delegation-reminder";

/** The fixed reminder. Keep it short and imperative (all four rules, <= 100 words). */
export const REMINDER =
  "ROUTER CHECK: You are the dispatcher. " +
  "(1) DECOMPOSE FIRST — every nontrivial request: decompose-or-execute " +
  "(independently verifiable? disjointly owned? context/budget favor delegation?), " +
  "state the split first. " +
  "(2) Before any edit/write, state the routing decision or dispatch via " +
  "subagent_spawn (model GLM-5.3-Flash); inline edits only for cross-module glue, " +
  "unavailable tools, or user instruction this turn. " +
  "(3) USER DATA writes — ledgers, sheets, cloud docs, Notion, any shared " +
  "external state — are NEVER inline, not even small ones or after read-only " +
  "exploration: dispatch first, then write. " +
  "(4) Attribute the turn to a registered project; dispatch briefs begin " +
  "[project:<name>]; deliverables include a work/ record (PROJECT-SPACE-STANDARD).";

export default function delegationReminderExtension(pi) {
  pi.on("before_agent_start", async (event) => {
    // Preferred path: structured sections (ponytail-style, cache-friendly).
    const sections = event?.systemPromptOptions?.sections;
    if (sections && typeof sections === "object") {
      sections[SECTION_KEY] = REMINDER;
      // In-place mutation is the documented composition pattern for
      // before_agent_start.systemPromptOptions; returning undefined keeps the
      // chained prompt otherwise untouched.
      return;
    }
    // Fallback: append to the chained system prompt. OMP-style prompts are
    // arrays of parts; keep them one.
    if (Array.isArray(event?.systemPrompt)) {
      return { systemPrompt: [...event.systemPrompt, REMINDER] };
    }
    // Guard a missing systemPrompt: never prepend the literal "undefined".
    const base = event?.systemPrompt ? `${event.systemPrompt}\n\n` : "";
    return { systemPrompt: `${base}${REMINDER}` };
  });
}
