import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createBridgeServer } from "../src/server.ts";
import { MAX_BODY_BYTES } from "../src/server.ts";

describe("bridge server security", () => {
  let server: ReturnType<typeof createBridgeServer>;
  let port: number;
  const base = () => `http://127.0.0.1:${port}`;

  before(async () => {
    server = createBridgeServer({
      project: "SecProj",
      inject: () => true,
      sessionFile: () => undefined,
      subagentsDir: () => "/nonexistent-subagents",
      indexHtml: () => "<!doctype html><html><head><title>t</title></head><body><p>hi</p><script>\"use strict\";</script></body></html>",
      log: () => {},
    });
    await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.closeBridge());

  test("binds to 127.0.0.1 only", () => {
    const addr = server.address() as { address: string };
    assert.equal(addr.address, "127.0.0.1");
  });

  test("rejects a spoofed Host header (DNS-rebinding guard)", async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method: "GET", path: "/state", headers: { Host: "attacker.example.com" } }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  });

  test("accepts its own loopback host header", async () => {
    const r = await fetch(`${base()}/state`);
    assert.equal(r.status, 200);
  });

  test("rejects foreign Origin headers (CSRF guard)", async () => {
    const r = await fetch(`${base()}/state`, { headers: { Origin: "http://evil.example.com" } });
    assert.equal(r.status, 403);
    const r2 = await fetch(`${base()}/message`, {
      method: "POST", headers: { "Content-Type": "application/json", Origin: "http://evil.example.com" },
      body: JSON.stringify({ target: "main", text: "nope" }),
    });
    assert.equal(r2.status, 403);
  });

  test("rejects bodies over the 32KB cap with 413", async () => {
    const big = "x".repeat(MAX_BODY_BYTES + 1);
    const r = await fetch(`${base()}/message`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: "main", text: big }),
    });
    assert.equal(r.status, 413);
  });

  test("rejects non-GET/POST methods with 405", async () => {
    const r = await fetch(`${base()}/state`, { method: "DELETE" });
    assert.equal(r.status, 405);
    assert.match(r.headers.get("allow") ?? "", /GET/);
  });

  test("404s unknown paths", async () => {
    const r = await fetch(`${base()}/admin`);
    assert.equal(r.status, 404);
  });

  test("sub-log ids cannot traverse paths", async () => {
    for (const id of ["..", "../..", "sa1/../..", "%2e%2e"]) {
      const r = await fetch(`${base()}/sub-log?id=${encodeURIComponent(id)}`);
      assert.notEqual(r.status, 200, id);
    }
  });

  test("serves the UI with an html content type and zero external resources", async () => {
    const r = await fetch(base() + "/");
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type") ?? "", /text\/html/);
    const html = await r.text();
    assert.doesNotMatch(html, /<script\s+src=/i);
    assert.doesNotMatch(html, /<link\s+[^>]*href=/i);
    assert.doesNotMatch(html, /url\(\s*['"]?https?:/i);
    assert.doesNotMatch(html, /@import/i);
  });

  test("no store caching on API and UI responses", async () => {
    for (const p of ["/", "/state"]) {
      const r = await fetch(base() + p);
      assert.equal(r.headers.get("cache-control"), "no-store");
    }
  });
});
