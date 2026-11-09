import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createInjector,
  injectionOptions,
  default as webBridge,
  type InjectedMessage,
  type InjectionOptions,
} from "../src/extension.ts";

describe("injection decision (busy => steer, idle => current behavior)", () => {
  test("main-target: steer while streaming, followUp while idle (exact previous path)", () => {
    assert.deepEqual(injectionOptions("main", true), { triggerTurn: true, deliverAs: "steer" });
    assert.deepEqual(injectionOptions("main", false), { triggerTurn: true, deliverAs: "followUp" });
  });

  test("subagent-target: followUp in every state (unchanged behavior)", () => {
    assert.deepEqual(injectionOptions("subagent", true), { triggerTurn: true, deliverAs: "followUp" });
    assert.deepEqual(injectionOptions("subagent", false), { triggerTurn: true, deliverAs: "followUp" });
  });
});

describe("createInjector against a fake pi.sendMessage capture", () => {
  const sent: Array<{ message: InjectedMessage; options: InjectionOptions }> = [];
  let streaming = false;
  const logs: string[] = [];
  const inject = createInjector(
    (message, options) => { sent.push({ message, options }); },
    () => streaming,
    (msg) => logs.push(msg),
  );

  test("idle main-target: web-chat custom message queued as followUp, exactly as before", () => {
    streaming = false;
    assert.equal(inject("[web-chat · project:Demo] hello", "main"), true);
    assert.deepEqual(sent.at(-1), {
      message: { customType: "web-chat", content: "[web-chat · project:Demo] hello", display: true },
      options: { triggerTurn: true, deliverAs: "followUp" },
    });
  });

  test("busy main-target: same message shape, delivered as a steer into the in-flight turn", () => {
    streaming = true;
    assert.equal(inject("[web-chat · project:Demo] steer me", "main"), true);
    assert.deepEqual(sent.at(-1), {
      message: { customType: "web-chat", content: "[web-chat · project:Demo] steer me", display: true },
      options: { triggerTurn: true, deliverAs: "steer" },
    });
  });

  test("busy subagent-target: still queued as followUp (current behavior kept)", () => {
    streaming = true;
    assert.equal(inject("[web-chat · for-subagent:sa-1] for the worker", "subagent"), true);
    assert.deepEqual(sent.at(-1)?.options, { triggerTurn: true, deliverAs: "followUp" });
  });

  test("a throwing sink is reported as refused and logged, not propagated", () => {
    const failing = createInjector(() => { throw new Error("boom"); }, () => false, (m) => logs.push(m));
    assert.equal(failing("x", "main"), false);
    assert.ok(logs.at(-1)?.includes("inject failed: boom"));
  });
});

describe("webBridge wiring over a fake ExtensionAPI", () => {
  test("lifecycle events flip the streaming flag; a live POST observes busy => steer", async () => {
    const previousPort = process.env.PI_WEB_BRIDGE_PORT;
    process.env.PI_WEB_BRIDGE_PORT = "0";
    try {
      const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
      const sent: Array<{ message: unknown; options: unknown }> = [];
      const pi = {
        on: (type: string, handler: (event: unknown, ctx: unknown) => void) => { handlers.set(type, handler); return pi; },
        sendMessage: (message: unknown, options: unknown) => { sent.push({ message, options }); },
      };
      webBridge(pi as unknown as ExtensionAPI);
      assert.ok(handlers.has("agent_start"));
      assert.ok(handlers.has("agent_settled"));

      // session_start reveals the ephemeral port through the UI status line.
      // The 'listening' callback is async, so re-fire (as a reload would) until
      // the bound port shows up.
      let status: string | undefined;
      const uiCtx = { ui: { setStatus: (_k: string, v: string) => { status = v; } } };
      for (let i = 0; i < 50 && !(status ?? "").includes("127.0.0.1:"); i++) {
        handlers.get("session_start")?.({}, uiCtx);
        if (!(status ?? "").includes("127.0.0.1:")) await new Promise((r) => setTimeout(r, 10));
      }
      const m = /127\.0\.0\.1:(\d+)/.exec(status ?? "");
      assert.ok(m, `no bridge port in status: ${status}`);
      const url = `http://127.0.0.1:${m![1]}`;

      handlers.get("agent_start")?.({}, {});
      let res = await fetch(`${url}/message`, { method: "POST", body: JSON.stringify({ target: "main", text: "busy hello" }) });
      assert.equal(res.status, 200);
      assert.deepEqual(sent.at(-1)?.options, { triggerTurn: true, deliverAs: "steer" });
      assert.deepEqual((sent.at(-1)?.message as InjectedMessage).content, "[web-chat · project:pi-web-bridge] busy hello");

      handlers.get("agent_settled")?.({}, {});
      res = await fetch(`${url}/message`, { method: "POST", body: JSON.stringify({ target: "main", text: "idle hello" }) });
      assert.equal(res.status, 200);
      assert.deepEqual(sent.at(-1)?.options, { triggerTurn: true, deliverAs: "followUp" });
    } finally {
      if (previousPort === undefined) delete process.env.PI_WEB_BRIDGE_PORT;
      else process.env.PI_WEB_BRIDGE_PORT = previousPort;
    }
  });
});
