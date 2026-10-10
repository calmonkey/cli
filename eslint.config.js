import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**", "skills/**", "test/fixtures/**", "coverage/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // Everything a person sees goes through src/ui.ts, so output can be captured and coloured in one place.
      "no-console": "error",
    },
  },
  { files: ["scripts/**"], languageOptions: { globals: { process: "readonly", console: "readonly", URL: "readonly", URLSearchParams: "readonly", fetch: "readonly", setTimeout: "readonly", clearTimeout: "readonly", AbortSignal: "readonly", Buffer: "readonly" } }, rules: { "no-console": "off" } },
);
