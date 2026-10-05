import { describe, expect, it } from 'vitest';
import { lineDiff } from '../../src/diff.ts';

describe('lineDiff', () => {
  it('marks unchanged, removed and added lines', () => {
    expect(lineDiff('a\nb\nc', 'a\nB\nc\nd')).toBe(' a\n-b\n+B\n c\n+d');
  });

  it('keeps markdown bullets that did not change as context', () => {
    expect(lineDiff('- one', '- one\n\n## Next\n- two')).toBe(' - one\n+\n+## Next\n+- two');
  });

  it('handles empty input on either side', () => {
    expect(lineDiff('x', '')).toBe('-x\n+');
    expect(lineDiff('same', 'same')).toBe(' same');
  });
});
