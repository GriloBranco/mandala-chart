import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Which folder may import which. See "Where code goes" in README.md.
const banned = (groups, message) => ["error", { patterns: [{ group: groups, message }] }];

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["src/domain/**"],
    rules: {
      "no-restricted-imports": banned(
        ["@/server/*", "@/client/*", "@/components/*", "@/app/*", "react", "react-dom", "next", "next/*"],
        "src/domain holds pure rules and types: no React, no Next, no server or browser code.",
      ),
    },
  },
  {
    files: ["src/client/**", "src/components/**"],
    rules: {
      "no-restricted-imports": banned(["@/server/*"], "Browser code reaches the server through src/client/api.ts."),
    },
  },
  {
    files: ["src/server/**", "src/app/api/**", "src/proxy.ts"],
    rules: {
      "no-restricted-imports": banned(
        ["@/client/*", "@/components/*"],
        "Server code must not import browser code.",
      ),
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    "test-results/**",
    "playwright-report/**",
  ]),
]);

export default eslintConfig;
