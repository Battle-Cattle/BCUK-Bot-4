// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');

module.exports = tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.js', 'public/**'],
  },
  js.configs.recommended,
  {
    files: ['src/**/*.ts'],
    extends: [...tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The two type-aware checks worth the parserOptions.projectService cost: everything
      // else in the *TypeChecked rule sets floods on Express's untyped req.body/req.session,
      // which is a pre-existing, codebase-wide pattern well beyond the scope of adding lint.
      '@typescript-eslint/no-floating-promises': 'error',
      // `arguments: false` — passing an async function as a plain callback (setTimeout,
      // EventEmitter.on) is this codebase's established pattern for handlers that already
      // catch their own errors internally; only flag misuse in conditionals/properties/etc.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'error',
      // Cyclomatic complexity cap. Every source function was brought under this; a warning
      // (not an error) nudges new code to extract helpers without failing CI on an edge case.
      complexity: ['warn', 12],
      // Structure and async hygiene. Everything below is at zero violations; keep it that way.
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/only-throw-error': 'error',
      '@typescript-eslint/prefer-promise-reject-errors': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/return-await': ['error', 'in-try-catch'],
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'error',
      'max-depth': ['error', 3],
      'max-lines-per-function': ['error', { max: 80, skipBlankLines: true, skipComments: true }],
      'no-nested-ternary': 'error',
      'no-else-return': 'error',
      'no-lonely-if': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      // A warning, not an error: flags signatures that are growing without forcing a refactor.
      'max-params': ['warn', 5],
    },
  },
  {
    // Mocks legitimately lean on `any` throughout this codebase's test suites
    // (e.g. stubbing Express req/res) — that's a deliberate convention, not debt.
    files: ['src/**/*.test.ts', 'src/test-utils/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
      complexity: 'off',
      // Test files legitimately use long describe/it callbacks, deep nesting and async mocks
      // without awaits, so the structure/async rules above apply to source files only.
      '@typescript-eslint/switch-exhaustiveness-check': 'off',
      '@typescript-eslint/only-throw-error': 'off',
      '@typescript-eslint/prefer-promise-reject-errors': 'off',
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/return-await': 'off',
      '@typescript-eslint/no-unnecessary-boolean-literal-compare': 'off',
      'max-depth': 'off',
      'max-lines-per-function': 'off',
      'no-nested-ternary': 'off',
      'no-else-return': 'off',
      'no-lonely-if': 'off',
      eqeqeq: 'off',
      'max-params': 'off',
    },
  },
  {
    // CLAUDE.md's "Import DB functions from src/db.ts only, never src/db/* directly" is
    // otherwise enforced only by convention/comment — db.ts wraps some src/db/* write
    // functions with withInvalidation() for cache-invalidation side effects, and a direct
    // import bypasses that silently. src/db/** itself is exempt (submodules import each
    // other internally) and test files keep their existing documented exception.
    files: ['src/**/*.ts'],
    ignores: ['src/db.ts', 'src/db/**', 'src/**/*.test.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          // Relative paths only (one or more leading ./ or ../ segments) — a glob group like
          // '**/db/*' would also match an unrelated third-party package with its own "db"
          // subpath (e.g. 'some-pkg/db/foo'), which isn't what this rule is meant to catch.
          regex: '^(\\.\\.?/)+db/.+$',
          message: 'Import DB functions from src/db.ts only, not directly from src/db/* modules — see CLAUDE.md Critical Invariants.',
        }],
      }],
    },
  },
  {
    // Not part of tsconfig.json's `include` (src/**/*), so lint it without type info.
    files: ['vitest.config.mts'],
    languageOptions: {
      parserOptions: {
        projectService: false,
      },
    },
  },
  {
    // Plain CommonJS CLI scripts, run directly via `node` — not part of the src/**/*.ts
    // TypeScript program, so they need their own Node globals instead of tsconfig's.
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        process: 'readonly',
        console: 'readonly',
      },
    },
  },
);
