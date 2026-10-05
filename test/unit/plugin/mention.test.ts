import { describe, expect, it } from 'vitest';
import { findMention } from '../../../plugin/src/mention.ts';

const NAMES = ['claude', 'codex', 'work'];

describe('findMention', () => {
  it('finds a tag at the start of a line', () => {
    expect(findMention('@claude summarize this note', NAMES)).toEqual({ name: 'claude', prompt: 'summarize this note' });
  });

  it('finds a tag after other text and keeps everything after it', () => {
    expect(findMention('Draft intro. @codex: shorten the intro, please', NAMES)).toEqual({
      name: 'codex',
      prompt: 'shorten the intro, please',
    });
  });

  it('matches names without regard to case and returns the configured name', () => {
    expect(findMention('- [ ] @Claude check the links', NAMES)?.name).toBe('claude');
  });

  it('needs a request after the tag', () => {
    expect(findMention('@claude', NAMES)).toBeUndefined();
    expect(findMention('@claude   ', NAMES)).toBeUndefined();
  });

  it('ignores email addresses, longer names and unknown names', () => {
    expect(findMention('mail ana@claude.ai about it', NAMES)).toBeUndefined();
    expect(findMention('@claudette do this', NAMES)).toBeUndefined();
    expect(findMention('@work-notes do this', NAMES)).toBeUndefined();
    expect(findMention('@gemini do this', NAMES)).toBeUndefined();
  });

  it('ignores blockquotes and callouts', () => {
    expect(findMention('> @claude do this', NAMES)).toBeUndefined();
    expect(findMention('  > [!agent]+ Claude @claude do this', NAMES)).toBeUndefined();
  });
});
