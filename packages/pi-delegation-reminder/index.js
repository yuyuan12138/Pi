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
//       an explicit user instruction in the current turn.
// Prose alone gets forgotten under flow, so this extension mechanically
// re-injects both rules.
//
// Mechanism: on every run start ("before_agent_start") the reminder is written
// into the structured system prompt as its own section
// (event.systemPromptOptions.sections). Pi diffs sections against what the
// model already has, so an unchanged reminder costs nothing, and the section
// stays part of the system prompt sent with every turn of the session.
// Fallbacks cover older Pi versions without systemPromptOptions.sections.
//
// To change the reminder, edit the REMINDER constant below and /reload.

/** Key under systemPromptOptions.sections; namespaced to avoid clobbering other extensions. */
export const SECTION_KEY = "delegation-reminder";

/** The fixed reminder. Keep it short and imperative (both rules, <= 70 words). */
export const REMINDER =
  "ROUTER CHECK: You are the dispatcher. " +
  "(1) DECOMPOSE FIRST — for every nontrivial request apply decompose-or-execute " +
  "(independently verifiable? disjointly owned? context/budget favor delegation?), " +
  "state the split before acting. " +
  "(2) Before any edit/write, state the routing decision or dispatch via " +
  "subagent_spawn (model GLM-5.3-Flash). Main-session edits only for cross-module " +
  "glue, unavailable delegation tools, or explicit user instruction this turn.";

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
