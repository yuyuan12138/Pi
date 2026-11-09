import { test, describe } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { createBridgeServer } from "../src/server.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** True when a fresh TCP bind to 127.0.0.1:port succeeds right now. */
function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer();
    const done = (ok: boolean) => {
      probe.removeAllListeners("error");
      try { probe.close(); } catch { /* not listening */ }
      resolve(ok);
    };
    probe.once("error", () => done(false));
    probe.listen(port, "127.0.0.1", () => done(true));
  });
}

function demoServer(log?: (m: string) => void) {
  return createBridgeServer({
    project: "demo",
    inject: () => true,
    sessionFile: () => undefined,
    subagentsDir: () => "/nonexistent",
    indexHtml: () => "<html></html>",
    log,
  });
}

describe("closeBridge force-closes tracked sockets (reload rebind)", () => {
  test("a live keep-alive socket is destroyed and the port frees within ~1s", async () => {
    const logs: string[] = [];
    const server = demoServer((m) => logs.push(m));
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    server.unref();

    // Browser-like keep-alive connection that stays open between polls
    // (no request in flight — exactly the state that used to hold
    // server.close() open forever and break the /reload rebind).
    const client = net.connect(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    const socketClosed = new Promise<void>((resolve) => client.once("close", resolve));

    const t0 = Date.now();
    server.closeBridge();
    await Promise.race([socketClosed, sleep(1000)]);
    assert.ok(client.destroyed || client.readableEnded, "keep-alive socket was not destroyed by closeBridge");
    assert.ok(
      logs.some((m) => m.includes("force-closed 1 tracked socket")),
      `forced-destroy log line missing: ${JSON.stringify(logs)}`,
    );

    // The port must be rebindable promptly — this is the /reload swap-in path.
    let rebound = false;
    while (Date.now() - t0 < 1000) {
      if (await canBind(port)) { rebound = true; break; }
      await sleep(25);
    }
    assert.ok(rebound, `port ${port} not rebindable within ${Date.now() - t0}ms of closeBridge`);
    client.destroy();
  });

  test("double closeBridge is a no-op (no ERR_SERVER_NOT_RUNNING noise)", async () => {
    const errors: unknown[] = [];
    const server = demoServer();
    server.on("error", (e) => errors.push(e));
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    server.unref();
    server.closeBridge();
    server.closeBridge();
    await sleep(50);
    assert.deepEqual(errors, []);
    assert.ok(await canBind(port), "port not freed after closeBridge");
  });
});
