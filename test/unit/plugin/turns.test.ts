import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({}));

import type { TFile } from 'obsidian';
import type { AgentEvent } from '../../../src/index.ts';
import { AgentPeer } from '../../../plugin/src/collab/agent-peer.ts';
import { LiveRegion } from '../../../plugin/src/collab/region.ts';
import { LOCAL_ORIGIN, SharedNote } from '../../../plugin/src/collab/shared-note.ts';
import { renderTurn, userBlock } from '../../../plugin/src/conversation/format.ts';
import { TurnTranscript } from '../../../plugin/src/conversation/transcript.ts';

beforeAll(() => {
  (globalThis as { window?: unknown }).window = globalThis;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function turn(note: SharedNote, peer: AgentPeer, message: string, events: AgentEvent[]) {
  const content = note.content;
  const separator = content.endsWith('\n\n') || !content ? '' : content.endsWith('\n') ? '\n' : '\n\n';
  note.applyOps([{ from: content.length, to: content.length, insert: `${separator}${userBlock(message)}\n\n\n` }], LOCAL_ORIGIN);
  const at = note.content.length - 1;
  const region = new LiveRegion(peer, at, at);
  const transcript = new TurnTranscript();
  for (const event of events) {
    transcript.apply(event);
    const text = renderTurn(transcript);
    region.set(text ? `${text}\n` : '');
    await sleep(5);
  }
  await region.settled();
  region.close();
}

const stream = (text: string): AgentEvent[] => [...text.match(/.{1,7}/gs)!.map((part) => ({ type: 'text-delta' as const, text: part })), { type: 'message', text }];

describe('conversation turns in a shared note', () => {
  it.each([false, true])('writes consecutive turns in order (typing: %s)', async (typing) => {
    const note = new SharedNote({ path: 'Chat.md' } as TFile, '---\nduet: conversation\n---\n', '---\nduet: conversation\n---\n', { read: async () => '', author: () => undefined });
    if (typing) note.views.add({ visible: true });
    const peer = new AgentPeer(note, { name: 'Claude', color: '#d97757' }, () => typing);
    const first = 'The Meetings folder has one file.';
    await turn(note, peer, 'What files?', [
      { type: 'tool-start', id: '1', tool: 'Bash', title: 'Bash ls', detail: 'ls' },
      { type: 'tool-end', id: '1', ok: true, output: 'a.md' },
      ...stream(first),
      { type: 'turn-end', result: { status: 'completed', text: first } },
    ]);
    const second = 'Summary:\n\n- One\n- Two';
    await turn(note, peer, 'Summarize it.', [
      { type: 'thinking-delta', text: '' },
      { type: 'tool-start', id: '2', tool: 'Read', title: 'Read Meetings/S.md', paths: ['Meetings/S.md'] },
      { type: 'tool-end', id: '2', ok: true },
      { type: 'thinking-delta', text: '' },
      ...stream(second),
      { type: 'turn-end', result: { status: 'completed', text: second } },
    ]);
    expect(note.content).toBe(
      [
        '---\nduet: conversation\n---\n',
        '> [!user]\n> What files?\n',
        '> [!activity]- Ran a command\n> - `Bash ls`\n>   ```\n>   a.md\n>   ```\n',
        `${first}\n`,
        '> [!user]\n> Summarize it.\n',
        '> [!activity]- Thought · Read a file\n> - Read [[Meetings/S]]\n',
        `${second}\n\n`,
      ].join('\n'),
    );
  });
});
