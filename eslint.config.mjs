import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // Codebase convention: leading underscore marks an intentionally-unused
      // binding (required-but-unused route handler params, rest-sibling
      // destructuring used to strip a field). Matches existing usage rather
      // than disabling the rule.
      "@typescript-eslint/no-unused-vars": ["warn", {
        args: "after-used",
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
        ignoreRestSiblings: true,
      }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Standalone CommonJS debug scripts run directly via `node <file>`,
    // outside the app source tree and Next.js build — not app code.
    "diag_xls.js",
    "read_xls.js",
  ]),
]);

export default eslintConfig;
