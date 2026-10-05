// Bundles the library the way an Obsidian plugin build does: one CommonJS file, Node built-ins external.
// The Claude Agent SDK is ESM and calls createRequire(import.meta.url), which is undefined in CommonJS.
// The define and banner below give it a file URL. Obsidian does not set __filename, hence the fallback.
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/agent-helenite.cjs',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  external: ['electron', 'obsidian', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: {
    js: `var __importMetaUrl = require('node:url').pathToFileURL(typeof __filename === 'string' ? __filename : require('node:path').join(process.cwd(), 'main.js')).href;`,
  },
  logLevel: 'info',
  metafile: true,
}).then((result) => {
  const inputs = Object.entries(result.metafile.outputs['dist/agent-helenite.cjs'].inputs)
    .map(([file, info]) => [file.replace(/^node_modules\//, '').split('/').slice(0, 2).join('/'), info.bytesInOutput])
    .reduce((sizes, [name, bytes]) => sizes.set(name, (sizes.get(name) ?? 0) + bytes), new Map());
  for (const [name, bytes] of [...inputs].sort((a, b) => b[1] - a[1]).slice(0, 8)) {
    console.log(`  ${(bytes / 1024).toFixed(0).padStart(6)} KB  ${name}`);
  }
});
