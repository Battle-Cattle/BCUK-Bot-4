// @ts-check
const js = require('@eslint/js');
const tseslint = require('typescript-eslint');
const jsdoc = require('eslint-plugin-jsdoc');
const vitest = require('@vitest/eslint-plugin');

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
      // allowThrowingUnknown: re-rejecting a caught (`unknown`) error as-is is propagation, not a
      // non-Error rejection; casting it to Error just to satisfy the rule would be a lie.
      '@typescript-eslint/prefer-promise-reject-errors': ['error', { allowThrowingUnknown: true }],
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
      // Type-aware bug catchers cherry-picked from recommendedTypeChecked/strictTypeChecked —
      // the ones that don't depend on Express's untyped req.body. All at zero violations.
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-deprecated': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-mixed-enums': 'error',
      '@typescript-eslint/no-redundant-type-constituents': 'error',
      '@typescript-eslint/no-duplicate-type-constituents': 'error',
      '@typescript-eslint/no-unnecessary-type-parameters': 'error',
      '@typescript-eslint/no-meaningless-void-operator': 'error',
      '@typescript-eslint/prefer-return-this-type': 'error',
      '@typescript-eslint/prefer-reduce-type-parameter': 'error',
      '@typescript-eslint/no-misused-spread': 'error',
      '@typescript-eslint/no-unnecessary-type-assertion': 'error',
      // `.catch((err) => …)` gets `err: any` by default; this makes it `unknown`, matching what
      // `strict`'s useUnknownInCatchVariables already does for try/catch.
      '@typescript-eslint/use-unknown-in-catch-callback-variable': 'error',
      // Correctness. All at zero violations.
      'no-param-reassign': 'error',
      'no-return-assign': 'error',
      'array-callback-return': 'error',
      'no-template-curly-in-string': 'error',
      'no-self-compare': 'error',
      'no-sequences': 'error',
      'no-unreachable-loop': 'error',
      'no-constructor-return': 'error',
      radix: 'error',
      'no-eval': 'error',
      'no-new-func': 'error',
      'default-case-last': 'error',
      'guard-for-in': 'error',
      // Readability. All at zero violations.
      '@typescript-eslint/prefer-readonly': 'error',
      '@typescript-eslint/prefer-includes': 'error',
      '@typescript-eslint/prefer-string-starts-ends-with': 'error',
      '@typescript-eslint/prefer-find': 'error',
      '@typescript-eslint/prefer-for-of': 'error',
      '@typescript-eslint/no-unnecessary-template-expression': 'error',
      '@typescript-eslint/default-param-last': 'error',
      '@typescript-eslint/no-extraneous-class': 'error',
      '@typescript-eslint/unified-signatures': 'error',
      '@typescript-eslint/consistent-indexed-object-style': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
      'no-useless-return': 'error',
      'no-useless-rename': 'error',
      'no-useless-concat': 'error',
      'no-useless-computed-key': 'error',
      'no-unneeded-ternary': 'error',
      'logical-assignment-operators': 'error',
      // File-size backstop alongside max-lines-per-function; every source file is under it.
      'max-lines': ['error', { max: 400, skipBlankLines: true, skipComments: true }],
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
      // Tests await sync mocks/handlers defensively (harmless, and robust to a handler later
      // going async), build ad-hoc mock classes/generics, and run long — none of which the
      // source-file rules above are aimed at.
      '@typescript-eslint/await-thenable': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
      '@typescript-eslint/no-extraneous-class': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      '@typescript-eslint/no-redundant-type-constituents': 'off',
      '@typescript-eslint/prefer-readonly': 'off',
      'prefer-template': 'off',
      'max-lines': 'off',
      // Tests cast mocks (`as any`, `as ReturnType<…>`) deliberately for readability.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
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
    // CLAUDE.md "Docstrings": every function needs a JSDoc comment, and a stale one is worse
    // than none. require-jsdoc covers function declarations, methods, and module-level arrow/
    // function expressions; concise inline callbacks are exempt per CLAUDE.md, and constructors
    // are covered by their class's JSDoc. Test files are exempt too.
    files: ['src/**/*.ts'],
    ignores: ['src/**/*.test.ts'],
    plugins: { jsdoc },
    settings: { jsdoc: { mode: 'typescript' } },
    rules: {
      'jsdoc/require-jsdoc': ['error', {
        publicOnly: false,
        checkConstructors: false,
        require: { FunctionDeclaration: true, MethodDefinition: true },
        // Module-level arrow/function expressions only (plain or exported `const x = () => …`);
        // small closures declared inside a function body count as inline callbacks.
        contexts: [
          'Program > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
          'Program > VariableDeclaration > VariableDeclarator > FunctionExpression',
          'Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > ArrowFunctionExpression',
          'Program > ExportNamedDeclaration > VariableDeclaration > VariableDeclarator > FunctionExpression',
        ],
      }],
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      'jsdoc/check-tag-names': 'error',
      // Types live in the TypeScript signature; a JSDoc {type} would just drift from it.
      'jsdoc/no-types': 'error',
    },
  },
  {
    // A stray `.only`/`.skip` or an assertion-free test silently weakens CI.
    files: ['src/**/*.test.ts'],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      'vitest/no-disabled-tests': 'error',
      // Count shared assertion helpers (e.g. server.test.ts's expectExactThreshold) as assertions.
      'vitest/expect-expect': ['error', { assertFunctionNames: ['expect*'] }],
      // Off: this codebase deliberately creates `expect(p).rejects…` before advancing fake
      // timers and awaits it afterwards, which valid-expect can't distinguish from a missing await.
      'vitest/valid-expect': 'off',
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
