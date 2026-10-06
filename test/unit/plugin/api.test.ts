import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => {
  class TFile {
    parent: { path: string } | null = null;
    constructor(public path: string) {}
    get basename() {
      return this.path.split('/').pop()!.replace(/\.md$/, '');
    }
  }
  class MarkdownView {
    file: TFile | null = null;
  }
  class Notice {
    static messages: string[] = [];
    constructor(message: string) {
      Notice.messages.push(message);
    }
  }
  const normalizePath = (path: string) => path.replace(/\/+/g, '/').replace(/^\/|\/$/g, '') || '/';
  return { TFile, MarkdownView, Notice, PluginSettingTab: class {}, normalizePath };
});

const agents = vi.hoisted(() => ({ startAgent: vi.fn() }));

vi.mock('../../../plugin/src/agent-session.ts', () => ({
  startAgent: agents.startAgent,
  activity: () => undefined,
  Presence: class {
    peer() {
      return { beginTurn() {}, setCursor() {} };
    }
    setStatus() {}
    clear() {}
  },
}));

vi.mock('../../../plugin/src/collab/region.ts', () => ({
  LiveRegion: class {
    set() {}
    settled() {
      return Promise.resolve();
    }
    close() {}
  },
}));

vi.mock('../../../plugin/src/conversation/composer.ts', () => ({
  Composer: class {
    constructor(_app: unknown, _view: unknown, readonly controller: { attach(holder: object): Promise<void> }) {
      void controller.attach(this);
    }
    focus() {}
    destroy() {}
  },
}));

import { MarkdownView, TFile } from 'obsidian';
import type { AgentEvent, TurnResult } from '../../../src/index.ts';
import type { TurnEnd } from '../../../plugin/src/api.ts';
import { applyOps } from '../../../plugin/src/collab/text-ops.ts';
import { ConversationManager } from '../../../plugin/src/conversation/manager.ts';
import { DEFAULT_SETTINGS, type AgentProfile } from '../../../plugin/src/settings.ts';

// The mocks take the arguments that the tests need, not those of Obsidian's classes.
const FakeFile = TFile as unknown as new (path: string) => TFile;
const FakeView = MarkdownView as unknown as new () => MarkdownView;

beforeAll(() => {
  const formats: Record<string, string> = { 'YYYY-MM-DD': '2026-10-06', 'YYYY-MM-DD HHmm': '2026-10-06 1402', 'YYYY-MM-DD HH:mm': '2026-10-06 14:02' };
  Object.assign(globalThis, { window: globalThis, moment: () => ({ format: (format: string) => formats[format] }) });
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A harness session that the test drives with `emit`. */
function fakeSession() {
  let listener: (event: AgentEvent) => void = () => undefined;
  return {
    id: 'session-1',
    closed: false,
    sent: [] as string[],
    on(next: (event: AgentEvent) => void) {
      listener = next;
    },
    send(text: string) {
      this.sent.push(text);
      return new Promise<TurnResult>(() => undefined);
    },
    emit: (event: AgentEvent) => listener(event),
    endTurn(status: TurnResult['status'] = 'completed') {
      listener({ type: 'turn-start' } as AgentEvent);
      listener({ type: 'turn-end', result: { status, text: 'Done.' } });
    },
    models: async () => [],
    commands: async () => [],
    interrupt: async () => undefined,
    close: async () => undefined,
    configure: async () => undefined,
  };
}

/** The parts of Obsidian's App that conversations use, over files in memory. */
function fakeApp() {
  const files = new Map<string, TFile>();
  const text = new Map<TFile, string>();
  const folders = new Set<string>();
  const listeners = new Set<(file: TFile) => void>();
  const leaves: { view: MarkdownView }[] = [];
  const frontmatter = (file: TFile) => {
    const match = /^---\n([\s\S]*?)\n---/.exec(text.get(file) ?? '');
    if (!match) return undefined;
    const properties: Record<string, unknown> = {};
    for (const line of match[1]!.split('\n')) {
      const [, key, value] = /^([\w-]+): (.+)$/.exec(line) ?? [];
      if (key) properties[key] = value === 'true' ? true : value;
    }
    return properties;
  };
  const getLeaf = vi.fn((_where: unknown) => {
    const leaf = {
      view: new FakeView(),
      openFile: vi.fn(async (file: TFile, _state: unknown) => {
        leaf.view.file = file;
      }),
    };
    leaves.push(leaf);
    return leaf;
  });
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? {} : null),
      getFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: async (path: string) => void folders.add(path),
      create: async (path: string, content: string) => {
        const file = new FakeFile(path);
        file.parent = { path: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '/' } as TFile['parent'];
        files.set(path, file);
        text.set(file, content);
        // The metadata cache reads a new file a moment later.
        queueMicrotask(() => listeners.forEach((listener) => listener(file)));
        return file;
      },
    },
    metadataCache: {
      getFileCache: (file: TFile) => ({ frontmatter: frontmatter(file) }),
      getFirstLinkpathDest: (link: string) => ({ path: `${link}.md` }),
      on: (_name: string, listener: (file: TFile) => void) => (listeners.add(listener), listener),
      offref: (listener: (file: TFile) => void) => listeners.delete(listener),
    },
    fileManager: {
      processFrontMatter: async (file: TFile, change: (properties: Record<string, unknown>) => void) => {
        const properties = frontmatter(file) ?? {};
        change(properties);
        const body = (text.get(file) ?? '').replace(/^---\n[\s\S]*?\n---\n/, '');
        text.set(file, `---\n${Object.entries(properties).map(([key, value]) => `${key}: ${value}`).join('\n')}\n---\n${body}`);
      },
      renameFile: vi.fn(async (file: TFile, path: string) => {
        files.delete(file.path);
        file.path = path;
        files.set(path, file);
      }),
    },
    workspace: {
      getLeaf,
      iterateAllLeaves: (visit: (leaf: { view: MarkdownView }) => void) => leaves.forEach(visit),
    },
  };
  return { app, text, folders, getLeaf };
}

/** A shared note over the fake file's text. */
function fakeHub(text: Map<TFile, string>) {
  return {
    acquire: async (file: TFile) => ({
      get content() {
        return text.get(file) ?? '';
      },
      applyOps: (ops: Parameters<typeof applyOps>[1]) => text.set(file, applyOps(text.get(file) ?? '', ops)),
      relative: () => undefined,
    }),
    release() {},
    addWriter: () => () => undefined,
    prepare: async () => undefined,
  };
}

describe('the API for other plugins', () => {
  let fake: ReturnType<typeof fakeApp>;
  let manager: ConversationManager;
  let session: ReturnType<typeof fakeSession>;
  let profiles: AgentProfile[];

  beforeEach(() => {
    fake = fakeApp();
    profiles = structuredClone(DEFAULT_SETTINGS.profiles);
    session = fakeSession();
    agents.startAgent.mockReset().mockImplementation(async () => session);
    manager = new ConversationManager(fake.app as never, fakeHub(fake.text) as never, {} as never, {
      profiles: () => profiles,
      folder: () => 'Conversations',
      animate: () => false,
      idleMinutes: () => 15,
      onActivity: () => undefined,
    });
  });

  afterEach(async () => {
    await manager.destroy();
  });

  const start = async (options: Parameters<ConversationManager['start']>[0]) => {
    const file = await manager.start(options);
    await flush();
    return { file, text: () => fake.text.get(file)! };
  };

  it('creates the note in the conversation folder, named after the message, and sends the message', async () => {
    const { file, text } = await start({ message: 'Summarize [[Ideas]] please', open: false });
    expect(file.path).toBe('Conversations/2026-10-06 Summarize Ideas please.md');
    expect(fake.folders.has('Conversations')).toBe(true);
    expect(text()).toMatch(/^---\nduet: conversation\nagent: claude\nstatus: active\ncreated: 2026-10-06 14:02\n/);
    expect(text()).toContain('> [!user]\n> Summarize [[Ideas]] please');
    expect(session.sent).toEqual([`Summarize [[Ideas]] please\n\nConversation note: ${file.path} (do not edit it)\nLinked notes: Ideas.md`]);
    expect(fake.app.fileManager.renameFile).not.toHaveBeenCalled();
    expect(fake.getLeaf).not.toHaveBeenCalled();
    expect(agents.startAgent.mock.calls[0]![1].profile).toMatchObject({ name: 'claude', userTools: false });

    const again = await start({ message: 'Summarize [[Ideas]] please', open: false });
    expect(again.file.path).toBe('Conversations/2026-10-06 Summarize Ideas please 2.md');
  });

  it('uses the given agent, title, folder and user setup', async () => {
    const { file, text } = await start({
      message: '/atlas-obsidian:wiki-ingest',
      profile: 'Codex',
      title: 'Ingest: notes/today',
      folder: 'changes/agents/',
      open: false,
      loadUserSetup: true,
    });
    expect(file.path).toBe('changes/agents/Ingest notes today.md');
    expect(text()).toMatch(/\nagent: codex\n[\s\S]*\nuser-setup: true\n/);
    expect(agents.startAgent.mock.calls[0]![1].profile).toMatchObject({ name: 'codex', userTools: true });
    expect(profiles[1]!.userTools).toBe(false);
    expect(session.sent[0]).toMatch(/^\/atlas-obsidian:wiki-ingest\n/);
  });

  it('opens the note in a new tab unless asked not to', async () => {
    const { file } = await start({ message: 'Hello' });
    expect(fake.getLeaf).toHaveBeenCalledWith('tab');
    const leaf = fake.getLeaf.mock.results[0]!.value;
    expect(leaf.openFile).toHaveBeenCalledWith(file, expect.objectContaining({ active: true }));
  });

  it('reports the status, and calls listeners when a turn ends', async () => {
    const { file } = await start({ message: 'Hello', open: false });
    expect(manager.status(file.path)).toBe('working');
    const turns: TurnEnd[] = [];
    const stop = manager.onTurnEnd(file.path, (turn) => turns.push(turn));
    session.endTurn();
    await flush();
    expect(turns).toEqual([{ path: file.path, status: 'completed' }]);
    expect(manager.status(file.path)).toBe('active');

    await manager.controller(file)!.end();
    expect(manager.status(file.path)).toBe('ended');
    stop();
    expect(manager.status('Conversations/Missing.md')).toBe('none');
  });

  it('shows a queued message as working when listeners hear of the end', async () => {
    const { file } = await start({ message: 'First', open: false });
    await manager.controller(file)!.send('Second');
    const seen: string[] = [];
    manager.onTurnEnd(file.path, () => seen.push(manager.status(file.path)));
    session.endTurn();
    await flush();
    expect(seen).toEqual(['working']);
    expect(session.sent.at(-1)).toBe('Second');
  });

  it('follows a renamed note, isolates a failing listener, and stops calling after unsubscribe', async () => {
    const { file } = await start({ message: 'Hello', title: 'Named', open: false });
    const turns: TurnEnd[] = [];
    manager.onTurnEnd(file.path, () => {
      throw new Error('listener bug');
    });
    const stop = manager.onTurnEnd(file.path, (turn) => turns.push(turn));
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await fake.app.fileManager.renameFile(file, 'Conversations/Renamed.md');
    session.endTurn('interrupted');
    await flush();
    expect(turns).toEqual([{ path: 'Conversations/Renamed.md', status: 'interrupted' }]);
    expect(error).toHaveBeenCalledOnce();
    error.mockRestore();
    stop();
    session.endTurn();
    await flush();
    expect(turns).toHaveLength(1);
  });

  it('ends the turn as failed when the agent cannot start', async () => {
    agents.startAgent.mockRejectedValue(new Error('claude not found'));
    const turns: TurnEnd[] = [];
    const file = await manager.start({ message: 'Hello', open: false });
    manager.onTurnEnd(file.path, (turn) => turns.push(turn));
    await flush();
    expect(turns).toEqual([{ path: file.path, status: 'failed', error: 'claude not found' }]);
    expect(manager.status(file.path)).toBe('active');
  });

  it('rejects an empty message, an unknown agent, and calls after the plugin unloads', async () => {
    await expect(manager.start({ message: '  ' })).rejects.toThrow('needs a message');
    await expect(manager.start({ message: 'Hi', profile: 'gemini' })).rejects.toThrow('Duet has no agent named gemini. Agents: claude, codex.');
    profiles.length = 0;
    await expect(manager.start({ message: 'Hi' })).rejects.toThrow('Duet has no agents.');
    await manager.destroy();
    await expect(manager.start({ message: 'Hi' })).rejects.toThrow('Duet is turned off.');
  });
});
