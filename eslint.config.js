import js from '@eslint/js';
import globals from 'globals';
import prettier from 'eslint-plugin-prettier/recommended';

export default [
  {
    /**
     * The ported service layer is excluded on purpose. It is shared verbatim
     * with the Next frontend, which lints it under its own config; linting it
     * again here would produce a second set of rules for the same files and
     * invite edits that make the two copies diverge.
     */
    ignores: ['node_modules/**', 'drizzle/**', 'src/services/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
      eqeqeq: ['error', 'smart'],
      'prefer-const': 'error',
      'no-var': 'error',
    },
  },
  prettier,
];
