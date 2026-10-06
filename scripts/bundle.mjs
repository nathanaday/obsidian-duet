// Bundles the library the way the Obsidian plugin build does, to check that it loads as CommonJS.
import { build } from 'esbuild';
import { obsidianBundle } from './esbuild-options.mjs';

await build({ ...obsidianBundle, entryPoints: ['src/index.ts'], outfile: 'dist/obsidian-duet.cjs', logLevel: 'info' });
