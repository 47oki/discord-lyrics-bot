/* ESLint configuration tuned for ES2023+, Node 18+ */
'use strict';

module.exports = {
  root: true,
  env: {
    node: '>=18.17.0',
    es2023: true,
  },
  parserOptions: {
    ecmaVersion: 2023,
    sourceType: 'module',
  },
  extends: ['eslint:recommended'],
  rules: {
    'no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrors: 'none' }],
    'no-implicit-globals': 'error',
    'no-var': 'error',
    'prefer-const': 'error',
    'eqeqeq': ['error', 'always', { null: 'ignore' }],
    'no-throw-literal': 'error',
    'no-return-await': 'off',
    'require-await': 'error',
    'no-console': 'warn',
    'no-process-exit': 'off',
  },
  ignorePatterns: ['dist/', 'release/', 'node_modules/', 'logs/'],
};
