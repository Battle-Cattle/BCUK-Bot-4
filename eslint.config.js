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
    },
  },
  {
    // Mocks legitimately lean on `any` throughout this codebase's test suites
    // (e.g. stubbing Express req/res) — that's a deliberate convention, not debt.
    files: ['src/**/*.test.ts', 'src/test-utils/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
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
          group: ['**/db/*'],
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
