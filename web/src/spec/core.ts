// spectrace-core in the browser: the same WASM build the Worker uses
// (`scripts/build-wasm.sh` writes it to worker/src/wasm, git-ignored), loaded
// on first use. The diagram editor parses and rewrites spec files with it, so
// every edit is the core writer's: only the touched lines change.
import init, { editSpec, parseSpec, type ParsedSpec, type SpecEdit } from "../../../worker/src/wasm/spectrace_core.js";
import wasmUrl from "../../../worker/src/wasm/spectrace_core_bg.wasm?url";

export type { ParsedSpec, SpecEdit };

let ready: Promise<unknown> | null = null;

/** Resolves once the WASM module is instantiated. */
export const loadCore = () => (ready ??= init({ module_or_path: wasmUrl }));

export { editSpec, parseSpec };
