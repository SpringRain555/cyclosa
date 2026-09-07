import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import prettier from 'eslint-config-prettier';

/**
 * flat config。
 *
 * **格式相關的規則一律由 `eslint-config-prettier` 關掉** ——
 * 兩套工具同時管格式的結果是它們互相改對方的輸出，而 CI 永遠是紅的。
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'web/dist/**', 'node_modules/**', 'docs/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser },
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      // 未使用的參數以 _ 開頭就放行 —— 介面要求的簽名常常用不到全部參數
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // 這個專案用 Result 而不是丟例外，所以 non-null assertion 應該很少見
      '@typescript-eslint/no-non-null-assertion': 'warn',
      'no-console': 'error',
    },
  },
  {
    // 工具腳本與測試放寬：它們本來就要印東西
    files: ['tools/**/*.mjs', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
