// spectrace-core (Rust) compiled to WASM by `just wasm`; see crates/core-wasm.
// The generated files in ./wasm are git-ignored. wrangler and the Vite plugin
// bundle the .wasm import as a precompiled module, so no network or fs is needed.
import wasm from "./wasm/spectrace_core_bg.wasm";
import { editSpec, initSync, isValidId, parseSpec, scanAnchors } from "./wasm/spectrace_core";

export type { Anchor, AnchorClass, AnchorKind, Diagnostic, DiagnosticCode, Language, ParsedSpec, Spec, SpecEdit } from "./wasm/spectrace_core";

// Instantiated once per isolate, when this module is first imported.
initSync({ module: wasm });

export { editSpec, isValidId, parseSpec, scanAnchors };
