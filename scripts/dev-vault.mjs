// Creates dev-vault/: the sample notes, with the plugin installed and enabled. Existing notes stay as they are.
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

const VAULT = 'dev-vault';
await cp('demo/sample-vault', VAULT, { recursive: true, force: false, errorOnExist: false });
await mkdir(`${VAULT}/.obsidian`, { recursive: true });
await writeFile(`${VAULT}/.obsidian/community-plugins.json`, JSON.stringify(['helenite']));
execFileSync('node', ['scripts/plugin.mjs', '--vault', VAULT], { stdio: 'inherit' });
console.log(`Open ${process.cwd()}/${VAULT} as a vault in Obsidian, then turn on community plugins when Obsidian asks.`);
