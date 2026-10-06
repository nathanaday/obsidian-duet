import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathDisplay } from '../../src/environment.ts';

describe('pathDisplay', () => {
  const cwd = mkdtempSync(path.join(tmpdir(), 'duet-paths-'));
  const show = pathDisplay(cwd);

  it('shows paths inside the working directory relative to it', () => {
    expect(show(path.join(cwd, 'Notes', 'a.md'))).toBe(path.join('Notes', 'a.md'));
  });

  it('matches the resolved directory, as harnesses often report it', () => {
    expect(show(path.join(realpathSync(cwd), 'a.md'))).toBe('a.md');
  });

  it('keeps paths outside the working directory and the directory itself', () => {
    expect(show('/etc/hosts')).toBe('/etc/hosts');
    expect(show(path.join(cwd, '..', 'other.md'))).toBe(path.join(cwd, '..', 'other.md'));
    expect(show(cwd)).toBe(cwd);
  });
});
