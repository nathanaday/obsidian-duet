import { describe, expect, it } from 'vitest';
import { isCalloutHeader, renderCallout } from '../../../plugin/src/callout.ts';

describe('renderCallout', () => {
  it('shows only the header until text arrives', () => {
    expect(renderCallout('Claude', { kind: 'working', text: '' })).toBe('> [!agent]+ Claude');
  });

  it('only appends while text streams in, so the note can type it out', () => {
    const steps = ['Hello', 'Hello\n', 'Hello\n\n', 'Hello\n\n- one', 'Hello\n\n- one\n- two'];
    const rendered = steps.map((text) => renderCallout('Claude', { kind: 'working', text }));
    for (let index = 1; index < rendered.length; index++) expect(rendered[index]!.startsWith(rendered[index - 1]!)).toBe(true);
    expect(rendered.at(-1)).toBe('> [!agent]+ Claude\n> Hello\n> \n> - one\n> - two');
  });

  it('closes blank lines when the reply is complete', () => {
    expect(renderCallout('Claude', { kind: 'completed', text: 'Hello\n\nWorld\n' })).toBe('> [!agent]+ Claude\n> Hello\n>\n> World');
  });

  it('marks a stopped or failed reply', () => {
    expect(renderCallout('Codex', { kind: 'stopped', text: 'Part' })).toBe('> [!agent]+ Codex\n> Part\n>\n> *Stopped.*');
    expect(renderCallout('Codex', { kind: 'failed', text: '', error: 'Rate limited\ndetails' })).toBe('> [!agent]+ Codex\n> *Failed: Rate limited*');
    expect(renderCallout('Codex', { kind: 'completed', text: '' })).toBe('> [!agent]+ Codex\n> *No reply.*');
  });

  it('recognizes callout headers', () => {
    expect(isCalloutHeader('> [!agent]+ Claude')).toBe(true);
    expect(isCalloutHeader('> [!note] Other')).toBe(false);
  });
});
