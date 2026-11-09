import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, symlinkSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBridgeServer, MAX_UPLOAD_BYTES, sanitizeFilename, type BridgeServer } from "../src/server.ts";

function makeServer(opts: { uploadMaxBytes?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "web-bridge-files-"));
  const inbox = join(root, "inbox");
  const outbox = join(root, "outbox");
  const server: BridgeServer = createBridgeServer({
    project: "demo",
    inject: () => true,
    sessionFile: () => undefined,
    subagentsDir: () => "/nonexistent",
    indexHtml: () => "<html></html>",
    inboxDir: () => inbox,
    outboxDir: () => outbox,
    ...opts,
  });
  return { server, inbox, outbox, root };
}

function listen(server: BridgeServer): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

/** The inbox is the only place an upload may land. */
function uploadedOutsideInbox(inbox: string): string | null {
  const parent = join(inbox, "..");
  for (const f of ["evil.txt", "passwd"]) {
    if (existsSync(join(parent, f))) return join(parent, f);
  }
  return null;
}

describe("sanitizeFilename", () => {
  test("basename only, both slash types, control chars stripped, dot-only rejected", () => {
    assert.equal(sanitizeFilename("a/b/c.txt"), "c.txt");
    assert.equal(sanitizeFilename("a\\b.txt"), "b.txt");
    assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
    assert.equal(sanitizeFilename("a\u0000\u001fb.txt"), "ab.txt");
    assert.equal(sanitizeFilename("  spaced name.pdf "), "spaced name.pdf");
    assert.equal(sanitizeFilename(".."), "");
    assert.equal(sanitizeFilename("."), "");
    assert.equal(sanitizeFilename(""), "");
    assert.equal(sanitizeFilename("///"), "");
  });
});

describe("POST /file (inbox uploads)", () => {
  const { server, inbox, outbox, root } = makeServer();
  let port = 0;
  before(async () => { port = await listen(server); server.unref(); });
  after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

  test("outbox (and inbox) dirs are auto-created 0700 at server start", () => {
    const st = statSync(outbox);
    assert.ok(st.isDirectory());
    assert.equal(st.mode & 0o777, 0o700);
    assert.ok(statSync(inbox).isDirectory());
  });

  test("happy upload lands in the inbox with a timestamped, sanitized name", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/file?name=${encodeURIComponent("notes.txt")}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: Buffer.from("hello bytes"),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { ok: boolean; id: string; path: string; name: string; size: number };
    assert.equal(body.ok, true);
    assert.equal(body.name, "notes.txt");
    assert.equal(body.size, 11);
    assert.ok(body.path.startsWith(inbox + "/"), `path escaped inbox: ${body.path}`);
    assert.equal(body.id, body.path.split("/").pop());
    assert.match(body.id, /^\d{4}-\d{2}-\d{2}T[\d.]+Z-notes\.txt$/); // <utc-timestamp>-<name>
    assert.equal(readFileSync(body.path, "utf8"), "hello bytes");
  });

  test("binary uploads round-trip byte-exactly", async () => {
    const bytes = Buffer.from([0, 1, 2, 0xff, 0x80, 0xfe, 7, 9]);
    const r = await fetch(`http://127.0.0.1:${port}/file?name=blob.bin`, {
      method: "POST", body: bytes,
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { path: string };
    assert.deepEqual(readFileSync(body.path), bytes); // no utf8 mangling
  });

  test("traversal names are reduced to a basename inside the inbox", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/file?name=${encodeURIComponent("../../../evil.txt")}`, {
      method: "POST", body: Buffer.from("x"),
    });
    assert.equal(r.status, 200);
    const body = await r.json() as { path: string; name: string };
    assert.equal(body.name, "evil.txt");
    assert.ok(body.path.startsWith(inbox + "/"));
    assert.equal(uploadedOutsideInbox(inbox), null); // nothing landed outside
  });

  test("missing / dot-only ?name= is rejected", async () => {
    const r1 = await fetch(`http://127.0.0.1:${port}/file`, { method: "POST", body: Buffer.from("x") });
    assert.equal(r1.status, 400);
    const r2 = await fetch(`http://127.0.0.1:${port}/file?name=${encodeURIComponent("..")}`, { method: "POST", body: Buffer.from("x") });
    assert.equal(r2.status, 400);
  });

  test("uploads over the size cap get 413 (cap default is exactly 100MB)", async () => {
    assert.equal(MAX_UPLOAD_BYTES, 100 * 1024 * 1024);
    const { server: capped, root: r2 } = makeServer({ uploadMaxBytes: 64 });
    try {
      const p = await listen(capped);
      capped.unref();
      const r = await fetch(`http://127.0.0.1:${p}/file?name=big.bin`, {
        method: "POST", body: Buffer.alloc(100, 7),
      });
      assert.equal(r.status, 413);
    } finally {
      capped.close();
      rmSync(r2, { recursive: true, force: true });
    }
  });
});

describe("GET /file/<id> (outbox downloads)", () => {
  const { server, outbox, root } = makeServer();
  let port = 0;
  before(async () => { port = await listen(server); server.unref(); });
  after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

  test("serves an outbox file as an attachment", async () => {
    writeFileSync(join(outbox, "report.txt"), "SHARE-PAYLOAD");
    const r = await fetch(`http://127.0.0.1:${port}/file/report.txt`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-disposition") ?? "", /^attachment; filename="report\.txt"$/);
    assert.equal(r.headers.get("content-type"), "application/octet-stream");
    assert.equal(await r.text(), "SHARE-PAYLOAD");
  });

  test("missing file → 404; bare /file and empty id → 404/403 (no listing endpoint)", async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/file/nope.txt`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/file`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${port}/file/`)).status, 403); // empty id: invalid, not a listing
  });

  test("traversal ids are 403, not served: ../, %2e%2e, absolute", async () => {
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "SECRET");
    for (const id of ["..%2Fsecret.txt", "%2e%2e%2fsecret.txt", "..%2f..%2fsecret.txt", "/etc/hosts"]) {
      const r = await fetch(`http://127.0.0.1:${port}/file/${id}`);
      assert.equal(r.status, 403, `expected 403 for ${id}`);
      assert.notEqual(await r.text(), "SECRET");
    }
    // Raw /file/.. and /file/. are normalized to "/" by the URL parser before
    // the route runs (they serve the UI page) — the security property is that
    // they never return outbox/inbox file bytes.
    for (const raw of ["..", "."]) {
      const r = await fetch(`http://127.0.0.1:${port}/file/${raw}`);
      assert.notEqual(await r.text(), "SECRET");
    }
    // raw double-slash absolute form: /file//etc/hosts
    const r = await fetch(`http://127.0.0.1:${port}/file//etc/hosts`);
    assert.equal(r.status, 403);
  });
});

describe("GET /file/<id> symlink + directory policy (own server)", () => {
  const { server, outbox, root } = makeServer();
  let port = 0;
  before(async () => {
    port = await listen(server);
    server.unref();
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "SECRET");
    symlinkSync(secret, join(outbox, "link.txt"));        // relative-ish escape
    symlinkSync("/etc/hosts", join(outbox, "abs-link.txt")); // absolute escape
    mkdirSync(join(outbox, "subdir"));
    writeFileSync(join(outbox, "ok.txt"), "OK");
  });
  after(() => { server.close(); rmSync(root, { recursive: true, force: true }); });

  test("symlink escape → 403", async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/file/link.txt`)).status, 403);
    assert.equal((await fetch(`http://127.0.0.1:${port}/file/abs-link.txt`)).status, 403);
  });

  test("directory id → 403 (only regular files are served)", async () => {
    assert.equal((await fetch(`http://127.0.0.1:${port}/file/subdir`)).status, 403);
  });

  test("regular files still download after the refusals", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/file/ok.txt`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "OK");
  });
});
