/**
 * pi-project-coordinator: multi-project coordination layer.
 *
 * One long-lived coordinator conversation routes user requests to per-project
 * primary agents. This package provides the deterministic, testable core:
 * registry, routing, journal, queue/lease engine and a Pi RPC runtime adapter.
 * It deliberately does NOT auto-activate anything: see README.md.
 */
export * from "./src/registry.ts";
export * from "./src/router.ts";
export * from "./src/journal.ts";
export * from "./src/engine.ts";
export * from "./src/rpc-runtime.ts";
