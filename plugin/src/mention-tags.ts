import { syntaxTree } from '@codemirror/language';
import type { EditorState } from '@codemirror/state';
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { findTags } from './mention.ts';

export interface TagStyle {
  name: string;
  color: string;
}

/** True when the position is in code, frontmatter or math, where a tag is plain text. */
export function inCode(state: EditorState, position: number): boolean {
  for (let node: ReturnType<typeof syntaxTree>['topNode'] | null = syntaxTree(state).resolveInner(position, 1); node; node = node.parent) {
    if (/code|frontmatter|math/i.test(node.name)) return true;
  }
  return false;
}

/** Shows each `@name` tag of a configured agent as a pill in the agent's color, like a #tag. */
export function mentionTags(agents: () => TagStyle[]) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private key: string;

      constructor(view: EditorView) {
        this.key = keyOf(agents());
        this.decorations = build(view, agents());
      }

      update(update: ViewUpdate): void {
        const styles = agents();
        const key = keyOf(styles);
        if (update.docChanged || update.viewportChanged || key !== this.key || syntaxTree(update.startState) !== syntaxTree(update.state)) {
          this.key = key;
          this.decorations = build(update.view, styles);
        }
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}

/** Wraps the tags in rendered Markdown, such as Reading view, in pills. Code, quotes and links stay as they are. */
export function tagPostProcessor(agents: () => TagStyle[]) {
  return (element: HTMLElement): void => {
    const styles = agents();
    const names = styles.map((style) => style.name);
    if (!names.length || !element.textContent?.includes('@')) return;
    const walker = element.doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.parentElement?.closest('code, pre, blockquote, .callout, a, .duet-tag')) nodes.push(node as Text);
    }
    for (const node of nodes) {
      const text = node.data;
      const tags = findTags(text, names);
      if (!tags.length) continue;
      const fragment = createFragment();
      let position = 0;
      for (const tag of tags) {
        fragment.append(text.slice(position, tag.from));
        const pill = createSpan({ cls: 'duet-tag', text: text.slice(tag.from, tag.to) });
        pill.style.setProperty('--duet-agent', colorOf(styles, tag.name));
        fragment.append(pill);
        position = tag.to;
      }
      fragment.append(text.slice(position));
      node.replaceWith(fragment);
    }
  };
}

function build(view: EditorView, styles: TagStyle[]): DecorationSet {
  const names = styles.map((style) => style.name);
  if (!names.length) return Decoration.none;
  const ranges = [];
  for (const { from, to } of view.visibleRanges) {
    for (let position = from; position <= to; ) {
      const line = view.state.doc.lineAt(position);
      if (line.text.includes('@')) {
        for (const tag of findTags(line.text, names)) {
          if (inCode(view.state, line.from + tag.from)) continue;
          const pill = Decoration.mark({ class: 'duet-tag', attributes: { style: `--duet-agent: ${colorOf(styles, tag.name)}` } });
          ranges.push(pill.range(line.from + tag.from, line.from + tag.to));
        }
      }
      position = line.to + 1;
    }
  }
  return Decoration.set(ranges);
}

function colorOf(styles: TagStyle[], name: string): string {
  return styles.find((style) => style.name === name)?.color ?? 'var(--text-accent)';
}

function keyOf(styles: TagStyle[]): string {
  return styles.map((style) => `${style.name}:${style.color}`).join(',');
}
