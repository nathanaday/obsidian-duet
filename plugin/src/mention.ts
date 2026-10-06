export interface Mention {
  /** The agent name as configured, for example `claude`. */
  name: string;
  /** The text after the tag. */
  prompt: string;
}

export interface Tag {
  /** The agent name as configured. */
  name: string;
  /** The tag's range in the line, `@` included. */
  from: number;
  to: number;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds the `@name` tags of configured agents in a line. A tag must start the line or follow whitespace or an
 * opening bracket, so email addresses do not match. Lines in a blockquote or callout have no tags.
 */
export function findTags(line: string, names: string[]): Tag[] {
  if (!names.length || /^\s*>/.test(line)) return [];
  const pattern = new RegExp(`(^|[\\s([{])@(${names.map(escape).join('|')})(?![\\w-])`, 'gi');
  const tags: Tag[] = [];
  for (const match of line.matchAll(pattern)) {
    const from = match.index + match[1]!.length;
    const name = names.find((candidate) => candidate.toLowerCase() === match[2]!.toLowerCase())!;
    tags.push({ name, from, to: from + 1 + match[2]!.length });
  }
  return tags;
}

/** Finds `@name request` in a line: the first tag that a request follows. */
export function findMention(line: string, names: string[]): Mention | undefined {
  for (const tag of findTags(line, names)) {
    const request = /^[:,]?\s+(\S.*)$/.exec(line.slice(tag.to));
    if (request) return { name: tag.name, prompt: request[1]!.trim() };
  }
  return undefined;
}
