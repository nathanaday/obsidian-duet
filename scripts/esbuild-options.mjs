// Settings for a CommonJS bundle that runs inside Obsidian (Electron renderer with Node access).
// The Claude Agent SDK is ESM and calls createRequire(import.meta.url), which is undefined in CommonJS.
// The define and banner give it a file URL. Obsidian does not set __filename, hence the fallback.
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';

const EVENTS_SHIM = fileURLToPath(new URL('./shims/node-events.cjs', import.meta.url));
const VALIDATOR_SHIM = fileURLToPath(new URL('./shims/mcp-validator.mjs', import.meta.url));

/** Points the bundle's `events` imports at the shim. The shim itself gets the real module. */
const electronEvents = {
  name: 'electron-events',
  setup(build) {
    build.onResolve({ filter: /^(node:)?events$/ }, (args) =>
      args.importer === EVENTS_SHIM ? { path: 'node:events', external: true } : { path: EVENTS_SHIM },
    );
  },
};

/** Points the MCP SDK's validator at the shim, so the bundle holds no code that generates code. */
const mcpValidator = {
  name: 'mcp-validator',
  setup(build) {
    build.onResolve({ filter: /\/validation\/ajv-provider\.js$/ }, () => ({ path: VALIDATOR_SHIM }));
  },
};

export const obsidianBundle = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: 'es2022',
  external: [
    'electron',
    'obsidian',
    '@codemirror/*',
    '@lezer/*',
    ...builtinModules,
    ...builtinModules.map((name) => `node:${name}`),
  ],
  plugins: [electronEvents, mcpValidator],
  define: { 'import.meta.url': '__importMetaUrl' },
  banner: {
    js: `var __importMetaUrl = require('node:url').pathToFileURL(typeof __filename === 'string' ? __filename : require('node:path').join(process.cwd(), 'main.js')).href;`,
  },
};
