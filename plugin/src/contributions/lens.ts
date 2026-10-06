import { type Extension, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { type App, editorInfoField, type MarkdownPostProcessorContext, MarkdownView } from 'obsidian';
import type { ContributionLedger } from './ledger.ts';
import type { Span } from './spans.ts';

/** Most time between a change and the lens update that shows it. */
const REFRESH_MS = 120;

const setSpans = StateEffect.define<DecorationSet>();

/** The lens marks of an editor. They follow edits until the next refresh replaces them. */
const lensField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, transaction) {
    marks = marks.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(setSpans)) marks = effect.value;
    return marks;
  },
  provide: (field) => EditorView.decorations.from(field),
});

/**
 * Shows which text of a note a Duet agent wrote. In the editor, the agent's text is marked. Blocks that render
 * as widgets, such as callouts and tables, and sections in Reading view are marked as a whole when they hold
 * agent text, because their rendered text has no positions in the note.
 */
export class ContributionLens {
  readonly views = new Set<LensView>();

  constructor(
    private readonly app: App,
    readonly ledger: ContributionLedger,
    private readonly isOn: () => boolean,
  ) {}

  get enabled(): boolean {
    return this.isOn();
  }

  extension(): Extension {
    return [lensField, ViewPlugin.define((view) => new LensView(view, this))];
  }

  /** Updates the marks of the editors that show `path`, or of all editors and Reading views. */
  refresh(path?: string): void {
    for (const view of this.views) if (!path || view.path === path) view.schedule();
    if (path) return;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view instanceof MarkdownView && leaf.view.getMode() === 'preview') leaf.view.previewMode.rerender(true);
    });
  }

  /** Marks the Reading view sections that hold agent text. */
  readonly postProcessor = async (element: HTMLElement, context: MarkdownPostProcessorContext): Promise<void> => {
    if (!this.enabled) return;
    const info = context.getSectionInfo(element);
    if (!info) return;
    const { from, to } = lineRange(info.text, info.lineStart, info.lineEnd);
    const spans = await this.ledger.spans(context.sourcePath, info.text);
    if (spans.some((span) => span.to > from && span.from < to)) element.addClass('duet-lens-block');
  };
}

class LensView {
  private timer: number | undefined;
  private version = 0;

  constructor(
    private readonly view: EditorView,
    private readonly lens: ContributionLens,
  ) {
    lens.views.add(this);
    this.schedule(0);
  }

  get path(): string | undefined {
    return this.view.state.field(editorInfoField, false)?.file?.path;
  }

  update(update: ViewUpdate): void {
    if (update.docChanged) this.schedule();
    if (update.docChanged || update.viewportChanged || update.selectionSet || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setSpans)))) {
      this.markBlocks();
    }
  }

  /** Refreshes the marks soon. A refresh that is already waiting covers the new change too. */
  schedule(delay = REFRESH_MS): void {
    if (this.timer !== undefined) return;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.refresh();
    }, delay);
  }

  destroy(): void {
    window.clearTimeout(this.timer);
    this.lens.views.delete(this);
  }

  private async refresh(): Promise<void> {
    const version = ++this.version;
    const path = this.path;
    if (!this.lens.enabled || !path) {
      if (this.view.state.field(lensField).size) this.view.dispatch({ effects: setSpans.of(Decoration.none) });
      return;
    }
    const text = this.view.state.doc.toString();
    const spans = await this.lens.ledger.spans(path, text);
    // A newer refresh or a newer text replaces this one.
    if (version !== this.version || !this.view.dom.isConnected || this.view.state.doc.toString() !== text) return;
    this.view.dispatch({ effects: setSpans.of(Decoration.set(spans.map((span) => mark(span).range(span.from, span.to)))) });
  }

  /** Marks block widgets, such as a rendered callout, that hold agent text. */
  private markBlocks(): void {
    this.view.requestMeasure({
      key: this,
      read: (view) => {
        const marks = view.state.field(lensField);
        const blocks: [Element, boolean][] = [];
        for (const element of Array.from(view.contentDOM.children)) {
          if (element.classList.contains('cm-line')) continue;
          let marked = false;
          try {
            const block = view.lineBlockAt(view.posAtDOM(element));
            marks.between(block.from, block.to, (from, to) => {
              if (to <= block.from || from >= block.to) return;
              marked = true;
              return false;
            });
          } catch {
            // The element is not part of the document.
          }
          blocks.push([element, marked]);
        }
        return blocks;
      },
      write: (blocks) => {
        for (const [element, marked] of blocks) element.classList.toggle('duet-lens-block', marked);
      },
    });
  }
}

function mark(span: Span): Decoration {
  return Decoration.mark({
    class: 'duet-lens',
    attributes: { 'aria-label': `Written by ${span.agent}, ${new Date(span.time).toLocaleDateString(undefined, { dateStyle: 'medium' })}` },
  });
}

/** The character range of lines `start` to `end`, both included. */
function lineRange(text: string, start: number, end: number): { from: number; to: number } {
  let from = 0;
  let line = 0;
  while (line < start) {
    const next = text.indexOf('\n', from);
    if (next < 0) return { from: text.length, to: text.length };
    from = next + 1;
    line++;
  }
  let to = from;
  while (line <= end) {
    const next = text.indexOf('\n', to);
    if (next < 0) return { from, to: text.length };
    to = next + 1;
    line++;
  }
  return { from, to: to - 1 };
}
