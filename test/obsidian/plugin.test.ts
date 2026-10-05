import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchObsidian, type ObsidianInstance, openAtEnd } from './harness.ts';

const TIMEOUT = 180_000;
const SHOTS = process.env.HELENITE_SHOTS;
const done = (text: string) => !text.includes('%%h:');

describe('Helenite in Obsidian', () => {
  let obsidian: ObsidianInstance;

  beforeAll(async () => {
    obsidian = await launchObsidian();
  }, 60_000);

  afterAll(async () => {
    await obsidian?.close();
  });

  async function mention(note: string, line: string) {
    await openAtEnd(obsidian.page, note);
    await obsidian.page.keyboard.type(line);
    await obsidian.page.keyboard.press('Enter');
  }

  async function shot(name: string) {
    if (SHOTS) await obsidian.page.screenshot({ path: path.join(SHOTS, `obsidian-${name}.png`) });
  }

  it('answers a mention in a callout under the line', { timeout: TIMEOUT }, async () => {
    await mention('Ideas.md', '@claude Reply with exactly the word: pineapple');

    const placeholder = await obsidian.waitForNote('Ideas.md', (text) => text.includes('%%h:'), 5_000);
    expect(placeholder).toMatch(/: pineapple\n> \[!agent\]\+ Claude %%h:\w+%%\n> \*Thinking…\*\n\n$/);

    const text = await obsidian.waitForNote('Ideas.md', (note) => done(note) && /> pineapple/i.test(note));
    expect(text).toMatch(/@claude Reply with exactly the word: pineapple\n> \[!agent\]\+ Claude\n> pineapple\.?\n\n$/i);
    await shot('reply');
  });

  it('continues the same conversation in the same note', { timeout: TIMEOUT }, async () => {
    await mention('Ideas.md', '@claude Which word did you just reply with? Reply with only that word, in capitals.');
    const text = await obsidian.waitForNote('Ideas.md', (note) => done(note) && note.includes('PINEAPPLE'));
    expect(text.match(/\[!agent\]/g)).toHaveLength(2);
  });

  it('keeps text the user types while the agent replies', { timeout: TIMEOUT }, async () => {
    await mention('Reading list.md', '@claude List five fruits, one per line, nothing else.');
    await obsidian.page.keyboard.type('My own line, typed during the reply.');
    const text = await obsidian.waitForNote('Reading list.md', done);
    expect(text).toMatch(/> \[!agent\]\+ Claude\n(> .+\n){5}\nMy own line, typed during the reply\.$/);
  });

  it('asks before writing a file, and writes it when allowed', { timeout: TIMEOUT }, async () => {
    await mention('Welcome.md', '@claude Use the Write tool to create Tasks.md containing exactly: hello');
    const modal = await obsidian.page.waitForSelector('.helenite-permission', { timeout: 60_000 });
    expect(await modal.textContent()).toContain('Claude wants to change a file');
    expect(await modal.textContent()).toContain('From Welcome.md');
    await shot('permission');
    await obsidian.page.keyboard.press('y');
    await obsidian.waitForNote('Welcome.md', done);
    expect(readFileSync(path.join(obsidian.vault, 'Tasks.md'), 'utf8').trim()).toBe('hello');
  });

  it('does not write the file when denied', { timeout: TIMEOUT }, async () => {
    await mention(
      'Welcome.md',
      '@claude Use the Write tool to create Denied.md containing: no. If you are not allowed, say so in one sentence.',
    );
    await obsidian.page.waitForSelector('.helenite-permission', { timeout: 60_000 });
    await obsidian.page.keyboard.press('n');
    await obsidian.waitForNote('Welcome.md', done);
    expect(existsSync(path.join(obsidian.vault, 'Denied.md'))).toBe(false);
  });

  it('keeps its reply when the agent edits the same note', { timeout: TIMEOUT }, async () => {
    await mention('Meetings/2026-10-02 Standup.md', '@claude Add the line "Status: reviewed" directly under the title of this note. Then reply with: Added.');
    const modal = await obsidian.page.waitForSelector('.helenite-permission', { timeout: 60_000 });
    expect(await modal.textContent()).toContain('Claude wants to change a file');
    await obsidian.page.keyboard.press('y');
    const text = await obsidian.waitForNote('Meetings/2026-10-02 Standup.md', (note) => done(note) && note.includes('Status: reviewed'));
    expect(text).toMatch(/^# Standup, October 2\n+Status: reviewed/);
    expect(text).toMatch(/> \[!agent\]\+ Claude\n> Added/);
  });

  it('answers with Codex for @codex', { timeout: TIMEOUT }, async () => {
    await mention('Reading list.md', '@codex Reply with exactly the word: mango');
    const text = await obsidian.waitForNote('Reading list.md', (note) => done(note) && /> \[!agent\]\+ Codex\n> mango/i.test(note));
    expect(text).toMatch(/> mango\.?\n\n$/i);
  });

  it('stops a reply with the Stop command', { timeout: TIMEOUT }, async () => {
    await mention('Ideas.md', '@claude Run the shell command `sleep 30`, then reply with: finished.');
    const working = await Promise.race([
      obsidian.page.waitForSelector('.helenite-permission', { timeout: 60_000 }).then(() => 'asked'),
      obsidian.waitForNote('Ideas.md', (note) => /%%h:\w+%%\n(>.*\n)*> `Bash sleep 30`/.test(note), 60_000),
    ]);
    if (working === 'asked') await obsidian.page.keyboard.press('y');
    await obsidian.waitForNote('Ideas.md', (note) => /%%h:\w+%%\n(>.*\n)*> `Bash sleep 30`/.test(note), 60_000);
    await obsidian.page.evaluate(() => (window as any).app.commands.executeCommandById('helenite:stop'));
    const text = await obsidian.waitForNote('Ideas.md', done, 15_000);
    expect(text).toMatch(/> \*Stopped\.\*\n\n$/);
  });

  it('leaves plain Enter and code blocks alone', { timeout: TIMEOUT }, async () => {
    const before = await obsidian.read('Welcome.md');
    await openAtEnd(obsidian.page, 'Welcome.md');
    await obsidian.page.keyboard.type('```\n@claude this is code\n');
    await obsidian.page.keyboard.type('```\nmail me at ana@claude.ai\n');
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const text = await obsidian.waitForNote('Welcome.md', () => true);
    expect(text.slice(before.length)).not.toContain('[!agent]');
  });

  it('remembers the conversation after the plugin reloads', { timeout: TIMEOUT }, async () => {
    const data = JSON.parse(readFileSync(path.join(obsidian.vault, '.obsidian/plugins/helenite/data.json'), 'utf8'));
    expect(data.sessions['Ideas.md'].claude).toMatch(/^[0-9a-f-]{36}$/);
    await obsidian.page.evaluate(async () => {
      const plugins = (window as any).app.plugins;
      await plugins.disablePlugin('helenite');
      await plugins.enablePlugin('helenite');
    });
    await mention('Ideas.md', '@claude Earlier in this conversation you replied with one fruit word. Which? Reply with only that word, in capitals.');
    const text = await obsidian.waitForNote('Ideas.md', (note) => done(note) && (note.match(/PINEAPPLE/g) ?? []).length >= 2);
    expect(text).toContain('PINEAPPLE');
    await shot('note');
  });
});
