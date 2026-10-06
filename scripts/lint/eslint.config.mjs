// Obsidian's review rules, for all the code in the repository, as the community directory scan reads it.
import { defineConfig } from 'eslint/config';
import obsidianmd from 'eslint-plugin-obsidianmd';
import { DEFAULT_BRANDS } from 'eslint-plugin-obsidianmd/dist/lib/rules/ui/brands.js';

export default defineConfig([
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
    },
  },
]);
