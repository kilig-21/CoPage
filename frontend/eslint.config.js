import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'

export default [
  { ignores: ['dist/**', 'test-results/**', 'playwright-report/**', 'coverage/**'] },
  {
    files: ['**/*.{js,jsx,mjs}'],
    rules: {
      'no-debugger': 'error',
      'no-dupe-args': 'error',
      'no-undef': 'error',
      'no-unreachable': 'error',
    },
  },
  {
    files: ['src/**/*.{js,jsx}', 'e2e/**/*.js'],
    languageOptions: {
      globals: globals.browser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
  {
    files: ['*.config.js', 'scripts/**/*.mjs', 'src/**/*.test.js', 'e2e/**/*.js'],
    languageOptions: { globals: globals.node },
  },
]
