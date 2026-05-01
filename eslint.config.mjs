import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: [
            "packages/*/test/*.ts",
            "packages/*/test/integration/*.ts",
            "scripts/*.ts",
            "vitest.*.ts",
            "packages/*/vitest.config.ts",
            // Per-package integration runner configs — they live next to
            // vitest.config.ts and aren't part of the package tsconfigs.
            "packages/*/vitest.integration.config.ts",
          ],
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 20,
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-import-type-side-effects": "error",

      // ── Real bugs, kept strict ────────────────────────────────────
      // These catch unhandled rejections and Promise-as-condition bugs
      // that are silently broken in production. Don't soften.
      "@typescript-eslint/no-floating-promises": "error",
      // ...but the `void return expected` arm of no-misused-promises is
      // mostly noise on JSX `onClick={async () => ...}` — that pattern is
      // safe (React swallows the returned Promise) and clean to read.
      // Keep the conditional/argument checks, drop the void-return one.
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: false },
      ],

      // ── Pedantic; demoted to warnings ─────────────────────────────
      // Literal-string unions next to `string` are useful as inline docs
      // ("here are the values you'll typically see"). The rule fires
      // anyway. Warn so contributors notice; don't block CI.
      "@typescript-eslint/no-redundant-type-constituents": "warn",
      // String(v ?? '') is a routine pattern after a typeof guard the
      // rule doesn't track through. Real cases are narrowable; the false
      // positives outnumber them. Warn instead of error.
      "@typescript-eslint/no-base-to-string": "warn",
      // any is a contract smell, not a bug.
      "@typescript-eslint/no-explicit-any": "warn",

      // ── Relaxed: noisy with the project's TS setup ───────────────
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**"],
  }
);
