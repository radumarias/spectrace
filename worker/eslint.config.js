import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["node_modules", ".wrangler", "dist", "src/wasm"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: { globals: globals.serviceworker },
    rules: {
      // Errors go through AppError, and `console` is only used by src/log.ts.
      "no-console": "error",
    },
  },
  { files: ["src/log.ts"], rules: { "no-console": "off" } },
);
