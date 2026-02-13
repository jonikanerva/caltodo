import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import tseslint from "typescript-eslint"
import importPlugin from "eslint-plugin-import"
import sonarjs from "eslint-plugin-sonarjs"
import unicorn from "eslint-plugin-unicorn"
import functional from "eslint-plugin-functional"

const tsconfigRootDir = dirname(fileURLToPath(import.meta.url))

export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      "migrations/**",
      "drizzle/**",
      "script/**",
      "server/integration/**",
      "**/*.test.ts",
      "drizzle.config.ts",
      "tailwind.config.ts",
      "vite.config.ts",
      "vitest.config.ts",
      "eslint.config.mjs",
    ],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: {
        project: true,
        tsconfigRootDir,
      },
    },
    plugins: {
      import: importPlugin,
      sonarjs,
      unicorn,
      functional,
    },
    settings: {
      "import/resolver": {
        typescript: {
          project: "./tsconfig.json",
        },
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "import/no-cycle": "error",
      "sonarjs/cognitive-complexity": ["error", 12],
      complexity: ["error", 10],
      "prefer-const": "error",
      "functional/no-let": "error",
      "functional/immutable-data": [
        "error",
        {
          ignoreAccessorPattern: [
            "*.displayName",
            "req.*",
            "res.*",
            "next.*",
            "session.*",
          ],
        },
      ],
      "no-param-reassign": [
        "error",
        {
          props: true,
          ignorePropertyModificationsFor: ["req", "res", "next", "tooltip"],
        },
      ],
      "max-lines-per-function": [
        "error",
        {
          max: 120,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-null": "off",
      "unicorn/consistent-function-scoping": "off",
      "@typescript-eslint/no-namespace": "off",
    },
  },
  {
    files: [
      "server/calendar.ts",
      "server/handlers/taskRoutes.ts",
      "server/handlers/actionRoutes.ts",
    ],
    rules: {
      "sonarjs/cognitive-complexity": ["error", 25],
      complexity: ["error", 25],
      "max-lines-per-function": [
        "error",
        {
          max: 260,
          skipBlankLines: true,
          skipComments: true,
          IIFEs: true,
        },
      ],
    },
  },
  {
    files: ["server/scheduler.ts", "server/auth.ts"],
    rules: {
      "sonarjs/cognitive-complexity": ["error", 18],
      complexity: ["error", 16],
    },
  },
  {
    files: [
      "client/src/components/ui/**/*.tsx",
      "client/src/hooks/use-toast.ts",
      "server/auth.ts",
      "server/calendar.ts",
      "server/csrf.ts",
      "server/handlers/authRoutes.ts",
      "server/handlers/testUtils.ts",
      "server/testSetup.ts",
    ],
    rules: {
      "functional/immutable-data": "off",
    },
  },
  {
    files: [
      "client/src/components/ui/chart.tsx",
      "client/src/hooks/use-toast.ts",
      "client/src/lib/csrf.ts",
      "server/calendar.ts",
      "server/handlers/taskRoutes.ts",
      "server/scheduler.ts",
      "server/vite.ts",
    ],
    rules: {
      "functional/no-let": "off",
    },
  },
  {
    files: ["client/src/pages/**/*.tsx", "client/src/components/ui/**/*.tsx"],
    rules: {
      "max-lines-per-function": "off",
      complexity: "off",
      "sonarjs/cognitive-complexity": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: ["client/src/hooks/use-toast.ts"],
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
)
