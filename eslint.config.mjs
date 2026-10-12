import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      eqeqeq: ["error", "smart"],
      "no-console": ["error", { allow: ["warn", "error"] }],
    },
  },
  {
    // No hardcoded UI copy: every visible string goes through next-intl.
    files: ["src/app/**/*.tsx", "src/components/**/*.tsx"],
    rules: {
      "react/jsx-no-literals": [
        "error",
        {
          noStrings: false,
          ignoreProps: true,
          allowedStrings: ["·", "—", "/", "₮", "%", "×", ":"],
        },
      ],
    },
  },
  {
    // Money must never touch floating point: forbid parseFloat / Number() on
    // anything in the domain layer; use the bigint helpers instead.
    files: ["src/domain/**/*.ts"],
    ignores: ["src/domain/**/*.test.ts"],
    rules: {
      "no-restricted-globals": ["error", { name: "parseFloat", message: "Use money/qty parsers." }],
    },
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "src/generated/**",
    "playwright-report/**",
    "test-results/**",
  ]),
]);

export default eslintConfig;
