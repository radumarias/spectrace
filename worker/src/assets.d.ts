// Ambient module types for files that wrangler and Vite import as values.
declare module "*.wasm" {
  const module: WebAssembly.Module;
  export default module;
}

// Vite's `?raw` (used by tests to read the shared fixture files).
declare module "*?raw" {
  const text: string;
  export default text;
}
