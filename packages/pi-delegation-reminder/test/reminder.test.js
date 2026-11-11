// Tests for pi-delegation-reminder.
//
// Mock style: a capture-style fake of the small ExtensionAPI surface the
// extension uses (pi.on only), then direct invocation of the registered
// before_agent_start handler with synthetic events — the same approach the
// repo's other extension tests use (node:test + node:assert/strict, no pi
// runtime needed).
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import delegationReminder, { REMINDER, SECTION_KEY } from "../index.js";

/** Fake pi ExtensionAPI: records event handler registrations. */
function createFakePi() {
  const handlers = new Map();
  const pi = {
    on(name, handler) {
      if (!handlers.has(name)) handlers.set(name, []);
      handlers.get(name).push(handler);
    },
  };
  return { pi, handlers };
}

const wordCount = (text) => text.trim().split(/\s+/).filter(Boolean).length;

describe("REMINDER constant", () => {
  test("is non-empty, <= 60 words, and names the rule's key parts", () => {
    assert.ok(REMINDER.length > 0);
    assert.ok(wordCount(REMINDER) <= 60, `reminder is ${wordCount(REMINDER)} words`);
    assert.match(REMINDER, /ROUTER CHECK/);
    assert.match(REMINDER, /subagent_spawn/);
    assert.match(REMINDER, /GLM-5\.3-Flash/);
    assert.match(REMINDER, /edit\/write/);
  });

  test("carries both injected rules: decompose-first and the dispatch gate", () => {
    assert.match(REMINDER, /DECOMPOSE FIRST/);
    assert.match(REMINDER, /subagent_spawn/);
  });
});

describe("extension registration", () => {
  test("registers exactly one before_agent_start handler and nothing else", () => {
    const { pi, handlers } = createFakePi();
    delegationReminder(pi);
    assert.equal(handlers.size, 1);
    assert.equal(handlers.get("before_agent_start").length, 1);
    assert.equal(typeof handlers.get("before_agent_start")[0], "function");
  });
});

describe("before_agent_start handler — sections path (modern Pi)", () => {
  test("writes the reminder under its own section key and keeps other sections", async () => {
    const { pi, handlers } = createFakePi();
    delegationReminder(pi);
    const handler = handlers.get("before_agent_start")[0];

    const sections = { ponytail: "other extension's section" };
    const event = { messageType: "user", prompt: "do a task", systemPromptOptions: { sections } };
    const result = await handler(event, {});

    // In-place mutation, no whole-prompt replacement.
    assert.equal(result, undefined);
    assert.equal(sections[SECTION_KEY], REMINDER);
    assert.equal(sections.ponytail, "other extension's section");
  });

  test("is idempotent: re-running keeps the same reminder value", async () => {
    const { pi, handlers } = createFakePi();
    delegationReminder(pi);
    const handler = handlers.get("before_agent_start")[0];

    const sections = {};
    await handler({ systemPromptOptions: { sections } }, {});
    const first = sections[SECTION_KEY];
    await handler({ systemPromptOptions: { sections } }, {});
    assert.equal(sections[SECTION_KEY], first);
    assert.equal(sections[SECTION_KEY], REMINDER);
  });
});

describe("before_agent_start handler — fallback paths (older Pi)", () => {
  test("string systemPrompt: returns a replacement containing base + reminder", async () => {
    const { pi, handlers } = createFakePi();
    delegationReminder(pi);
    const handler = handlers.get("before_agent_start")[0];

    const result = await handler({ systemPrompt: "BASE PROMPT" }, {});
    assert.ok(result && typeof result.systemPrompt === "string");
    assert.match(result.systemPrompt, /^BASE PROMPT\n\n/);
    assert.ok(result.systemPrompt.includes(REMINDER));
  });

  test("array systemPrompt: appends the reminder as one more part", async () => {
    const { pi, handlers } = createFakePi();
    delegationReminder(pi);
    const handler = handlers.get("before_agent_start")[0];

    const result = await handler({ systemPrompt: ["part one", "part two"] }, {});
    assert.deepEqual(result.systemPrompt, ["part one", "part two", REMINDER]);
  });

  test("missing/empty event: does not crash and never emits 'undefined'", async () => {
    const { pi, handlers } = createFakePi();
    delegationReminder(pi);
    const handler = handlers.get("before_agent_start")[0];

    for (const event of [undefined, {}, { systemPrompt: null }, { systemPromptOptions: {} }]) {
      const result = await handler(event, {});
      assert.ok(result && typeof result.systemPrompt === "string");
      assert.equal(result.systemPrompt, REMINDER);
      assert.ok(!result.systemPrompt.includes("undefined"));
    }
  });
});
