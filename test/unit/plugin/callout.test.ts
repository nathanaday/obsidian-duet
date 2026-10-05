import { describe, expect, it } from 'vitest';
import { findCallout, inlineCode, renderCallout } from '../../../plugin/src/callout.ts';

describe('renderCallout', () => {
  it('shows a placeholder and the marker while the agent works', () => {
    expect(renderCallout('Claude', { kind: 'working', text: '' }, 'abc')).toBe('> [!agent]+ Claude %%h:abc%%\n> *Thinking…*');
  });

  it('shows the current activity as code under the text so far', () => {
    expect(renderCallout('Claude', { kind: 'working', text: 'Looking.', activity: 'Read Ideas.md' }, 'abc')).toBe(
      '> [!agent]+ Claude %%h:abc%%\n> Looking.\n>\n> `Read Ideas.md`',
    );
  });

  it('fences commands that contain backticks or asterisks', () => {
    expect(inlineCode('echo `date` *')).toBe('``echo `date` *``');
    expect(inlineCode('`x`')).toBe('`` `x` ``');
  });

  it('drops the marker and quotes every line of the final reply', () => {
    expect(renderCallout('Codex', { kind: 'completed', text: '- one\n\n- two' }, 'abc')).toBe(
      '> [!agent]+ Codex\n> - one\n>\n> - two',
    );
  });

  it('notes a stopped or failed reply', () => {
    expect(renderCallout('Claude', { kind: 'stopped', text: 'Partial' }, 'x')).toBe('> [!agent]+ Claude\n> Partial\n>\n> *Stopped.*');
    expect(renderCallout('Claude', { kind: 'failed', text: '', error: 'boom\ndetail' }, 'x')).toBe(
      '> [!agent]+ Claude\n> *Failed: boom*',
    );
  });
});

describe('findCallout', () => {
  const note = [
    'Intro',
    '@claude first',
    '> [!agent]+ Claude %%h:aaa%%',
    '> *Thinking…*',
    '',
    '@claude second',
    '> [!agent]+ Claude %%h:bbb%%',
    '> line one',
    '>',
    '> line two',
    'After',
  ].join('\n');

  it('finds the callout with the marker, up to its last quoted line', () => {
    const range = findCallout(note, 'bbb')!;
    expect(note.slice(range.from, range.to)).toBe('> [!agent]+ Claude %%h:bbb%%\n> line one\n>\n> line two');
  });

  it('returns undefined when the callout is gone', () => {
    expect(findCallout(note, 'zzz')).toBeUndefined();
  });

  it('finds a callout at the end of the note', () => {
    const range = findCallout('x\n> [!agent]+ Claude %%h:end%%\n> text', 'end')!;
    expect(range.to).toBe('x\n> [!agent]+ Claude %%h:end%%\n> text'.length);
  });
});
