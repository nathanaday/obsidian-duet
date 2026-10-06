import { type ChildProcess, spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';

const OBSIDIAN = process.env.OBSIDIAN_BINARY ?? '/Applications/Obsidian.app/Contents/MacOS/Obsidian';

export interface ObsidianInstance {
  page: Page;
  vault: string;
  read(note: string): Promise<string>;
  /** Waits until `check` returns true for the note's text, and returns that text. */
  waitForNote(note: string, check: (text: string) => boolean, timeout?: number): Promise<string>;
  close(): Promise<void>;
}

export interface LaunchOptions {
  /** The vault to copy. Default: the demo's sample vault. */
  vault?: string;
  /** The plugin's data.json. */
  pluginData?: unknown;
}

/**
 * Starts a separate Obsidian with its own profile and a fresh copy of a vault,
 * with the built plugin installed and enabled. The user's own Obsidian and vaults are not touched.
 */
export async function launchObsidian({ vault: source = 'demo/sample-vault', pluginData }: LaunchOptions = {}): Promise<ObsidianInstance> {
  const root = await mkdtemp(path.join(tmpdir(), 'duet-obsidian-'));
  const vault = path.join(root, 'vault');
  const profile = path.join(root, 'profile');
  const pluginDir = path.join(vault, '.obsidian/plugins/duet');

  await cp(source, vault, { recursive: true });
  await mkdir(pluginDir, { recursive: true });
  for (const file of ['main.js', 'manifest.json', 'styles.css']) await cp(path.join('plugin/dist', file), path.join(pluginDir, file));
  if (pluginData) await writeFile(path.join(pluginDir, 'data.json'), JSON.stringify(pluginData));
  await mkdir(profile);
  await writeFile(
    path.join(profile, 'obsidian.json'),
    JSON.stringify({ vaults: { duettest00001: { path: vault, ts: Date.now(), open: true } } }),
  );

  const port = await freePort();
  const child = spawn(OBSIDIAN, [`--user-data-dir=${profile}`, `--remote-debugging-port=${port}`], { stdio: 'ignore' });
  let browser: Browser | undefined;
  try {
    browser = await connect(port);
    const page = await vaultPage(browser);
    await page.waitForFunction(() => (window as any).app?.workspace?.layoutReady, undefined, { timeout: 30_000 });
    await page.evaluate(async () => {
      const plugins = (window as any).app.plugins;
      // The plugin is not in community-plugins.json yet, so turning on community plugins loads nothing,
      // and enablePluginAndSave loads it exactly once.
      plugins.setEnable(true);
      await plugins.enablePluginAndSave('duet');
    });
    await page.waitForFunction(() => !!(window as any).app.plugins.plugins.duet, undefined, { timeout: 10_000 });
    // Turning on community plugins opens the settings window a moment later. It would take the keyboard.
    await page.waitForSelector('.modal-container', { timeout: 3_000 }).catch(() => undefined);
    for (let attempt = 0; attempt < 5 && (await page.$('.modal-container')); attempt++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    if (await page.$('.modal-container')) throw new Error('A dialog stayed open in Obsidian.');

    const read = (note: string) => readFile(path.join(vault, note), 'utf8');
    return {
      page,
      vault,
      read,
      async waitForNote(note, check, timeout = 120_000) {
        const deadline = Date.now() + timeout;
        let text = '';
        while (Date.now() < deadline) {
          // Read through Obsidian, which includes edits that are not saved to disk yet.
          text = await page.evaluate((file) => {
            const app = (window as any).app;
            const leaf = app.workspace.getLeavesOfType('markdown').find((l: any) => l.view.file?.path === file);
            return leaf ? leaf.view.editor.getValue() : app.vault.adapter.read(file);
          }, note);
          if (check(text)) return text;
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        throw new Error(`Timed out waiting for ${note}. Last text:\n${text}`);
      },
      async close() {
        await browser?.close().catch(() => undefined);
        await stop(child);
        await rm(root, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await browser?.close().catch(() => undefined);
    await stop(child);
    throw error;
  }
}

/** Opens a note and puts the cursor at the end of a new last line. */
export async function openAtEnd(page: Page, note: string): Promise<void> {
  await page.evaluate(async (file) => {
    const app = (window as any).app;
    await app.workspace.openLinkText(file, '', false);
    const editor = app.workspace.activeEditor.editor;
    const last = editor.lastLine();
    editor.setCursor({ line: last, ch: editor.getLine(last).length });
    editor.focus();
  }, note);
  await page.keyboard.press('Enter');
}

async function connect(port: number): Promise<Browser> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      return await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

async function vaultPage(browser: Browser): Promise<Page> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) if (page.url().startsWith('app://obsidian.md/index.html')) return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('Obsidian did not open the vault window.');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (child.exitCode === null) child.kill('SIGKILL');
}
