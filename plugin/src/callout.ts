export type ReplyState =
  | { kind: 'working'; text: string; activity?: string }
  | { kind: 'completed'; text: string }
  | { kind: 'stopped'; text: string }
  | { kind: 'failed'; text: string; error: string };

const MARKER = /%%h:([a-z0-9]+)%%/;

export function newMarker(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Renders the reply callout. While the reply is in progress, the title carries a hidden marker
 * (an Obsidian comment) that `findCallout` uses to locate the callout again.
 */
export function renderCallout(title: string, state: ReplyState, marker: string): string {
  const header = `> [!agent]+ ${title}${state.kind === 'working' ? ` %%h:${marker}%%` : ''}`;
  const body = [bodyText(state)].filter(Boolean).join('\n\n');
  return [header, ...body.split('\n').map((line) => (line ? `> ${line}` : '>'))].join('\n');
}

function bodyText(state: ReplyState): string {
  const text = state.text.trim();
  switch (state.kind) {
    case 'working':
      if (state.activity) return [text, inlineCode(state.activity)].filter(Boolean).join('\n\n');
      return text || '*Thinking…*';
    case 'completed':
      return text || '*No reply.*';
    case 'stopped':
      return [text, '*Stopped.*'].filter(Boolean).join('\n\n');
    case 'failed':
      return [text, `*Failed: ${state.error.split('\n')[0]}*`].filter(Boolean).join('\n\n');
  }
}

/** Formats text as inline code, with a fence longer than any run of backticks inside it. */
export function inlineCode(text: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Returns the character range of the callout that carries `marker`, from its header to its last line. */
export function findCallout(text: string, marker: string): { from: number; to: number } | undefined {
  const lines = text.split('\n');
  let offset = 0;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('> [!agent]') && line.match(MARKER)?.[1] === marker) {
      const from = offset;
      let to = offset + line.length;
      for (let next = index + 1; next < lines.length && lines[next]!.startsWith('>'); next++) {
        to += 1 + lines[next]!.length;
      }
      return { from, to };
    }
    offset += line.length + 1;
  }
  return undefined;
}

/** True when the line is the header of an agent callout. */
export function isCalloutHeader(line: string): boolean {
  return line.startsWith('> [!agent]');
}
