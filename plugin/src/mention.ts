export interface Mention {
  /** The agent name as configured, for example `claude`. */
  name: string;
  /** The text after the tag. */
  prompt: string;
}

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Finds `@name request` in a line. The tag must start the line or follow whitespace or an opening
 * bracket, so email addresses do not match. Lines in a blockquote or callout never match.
 */
export function findMention(line: string, names: string[]): Mention | undefined {
  if (!names.length || /^\s*>/.test(line)) return undefined;
  const pattern = new RegExp(`(?:^|[\\s([{])@(${names.map(escape).join('|')})(?![\\w-])[:,]?\\s+(\\S.*)$`, 'i');
  const match = line.match(pattern);
  if (!match) return undefined;
  const name = names.find((candidate) => candidate.toLowerCase() === match[1]!.toLowerCase())!;
  return { name, prompt: match[2]!.trim() };
}
