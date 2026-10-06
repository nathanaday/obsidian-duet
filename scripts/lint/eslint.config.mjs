// Obsidian's review rules, for the code that goes into the plugin bundle.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';

export default defineConfig([
  { ignores: ['src/cli/**'] },
  ...obsidianmd.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: { parserOptions: { project: 'plugin/tsconfig.json', tsconfigRootDir: `${import.meta.dirname}/../..` } },
    rules: {
      // In the settings text, "cursor" is the text cursor, not the Cursor editor. Key names, acronyms and environment variables keep their case.
      'obsidianmd/ui/sentence-case': [
        'warn',
        { brands: DEFAULT_BRANDS.filter((brand) => brand !== 'Cursor'), ignoreWords: ['Enter', 'MCP'], ignoreRegex: ['[A-Z][A-Z_]+='] },
      ],
      // The declarative settings API needs Obsidian 1.13. The plugin supports older versions, which need display().
      'obsidianmd/settings-tab/prefer-setting-definitions': 'off',
    },
  },
  {
    // The library also runs outside Obsidian, in Node, where there is no window.
    files: ['src/**/*.ts'],
    rules: { 'obsidianmd/prefer-window-timers': 'off' },
  },
]);
