import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Load pi-web-bridge through the REAL pi loader of the running install
 * (same resolution path pi itself uses for a settings.json package entry:
 * a package directory whose package.json declares pi.extensions).
 * Zero diagnostics required: no errors, no load failures.
 */
const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

function realPiPkgRoot(): string {
  const override = process.env.PI_PI_CODING_AGENT_ROOT;
  if (override) return override;
  const agentDir = join(process.env.HOME ?? "", ".pi", "agent");
  const version = readFileSync(join(agentDir, "install", "current-version"), "utf8").trim();
  return join(agentDir, "install", "releases", version, "node_modules", "@earendil-works", "pi-coding-agent");
}

describe("extension loads with zero diagnostics through the real pi loader", () => {
  test("package manifest points at an existing extension entry", () => {
    const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    assert.ok(Array.isArray(manifest.pi?.extensions) && manifest.pi.extensions.length > 0);
    for (const rel of manifest.pi.extensions) {
      assert.equal(existsSync(join(PKG_DIR, rel)), true, rel);
    }
  });

  test("loadExtensions on the manifest-declared entry yields one extension, zero errors/warnings", { timeout: 60_000 }, async () => {
    // The extension starts its HTTP server at load; port 0 keeps the test side-effect-free.
    process.env.PI_WEB_BRIDGE_PORT = "0";
    const loaderUrl = pathToFileURL(join(realPiPkgRoot(), "dist", "core", "extensions", "loader.js"));
    const loader = await import(loaderUrl.href);
    assert.equal(typeof loader.loadExtensions, "function", "real loader found");
    // Resolve entries exactly like pi does for a package-dir settings entry:
    // read package.json pi.extensions -> resolve relative to the package dir.
    const manifest = JSON.parse(readFileSync(join(PKG_DIR, "package.json"), "utf8"));
    const entries = manifest.pi.extensions.map((rel: string) => join(PKG_DIR, rel));
    const result = await loader.loadExtensions(entries, PKG_DIR);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    const ext = result.extensions[0];
    assert.ok(ext.resolvedPath.endsWith("extension.ts"));
  });
});
