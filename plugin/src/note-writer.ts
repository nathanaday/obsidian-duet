import { Transaction } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import { type App, MarkdownView, type TFile } from 'obsidian';
import { findCallout } from './callout.ts';

const WRITE_INTERVAL_MS = 120;

/**
 * Keeps one reply callout up to date. It finds the callout by its marker before every write,
 * so the callout can move while the user types or the agent edits the note.
 */
export class CalloutWriter {
  private pending: string | undefined;
  private timer: number | undefined;
  private writing: Promise<void> = Promise.resolve();
  private lost = false;

  constructor(
    private readonly app: App,
    /** Obsidian updates `file.path` when the note is renamed, so the writer follows the note. */
    readonly file: TFile,
    readonly marker: string,
  ) {}

  /** Adds a callout at the end of the note and returns a writer for it. */
  static async append(app: App, file: TFile, marker: string, callout: string): Promise<CalloutWriter> {
    const writer = new CalloutWriter(app, file, marker);
    const view = writer.editorView();
    if (view) {
      const { doc } = view.state;
      const separator = doc.length === 0 ? '' : doc.toString().endsWith('\n\n') ? '' : doc.toString().endsWith('\n') ? '\n' : '\n\n';
      view.dispatch({
        changes: { from: doc.length, insert: `${separator}${callout}\n` },
        annotations: Transaction.addToHistory.of(false),
      });
    } else {
      await app.vault.process(file, (text) => `${text.replace(/\n*$/, '')}\n\n${callout}\n`);
    }
    return writer;
  }

  /** True after the user deleted the callout. Later updates have no effect. */
  get gone(): boolean {
    return this.lost;
  }

  update(callout: string): void {
    this.pending = callout;
    this.timer ??= window.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, WRITE_INTERVAL_MS);
  }

  /** Writes the latest update now. Resolves when it is in the note. */
  flush(): Promise<void> {
    if (this.timer !== undefined) {
      window.clearTimeout(this.timer);
      this.timer = undefined;
    }
    const callout = this.pending;
    this.pending = undefined;
    if (callout !== undefined && !this.lost) {
      this.writing = this.writing.then(() => this.write(callout)).catch((error) => console.error('Helenite:', error));
    }
    return this.writing;
  }

  private async write(callout: string): Promise<void> {
    const view = this.editorView();
    if (view) {
      const range = findCallout(view.state.doc.toString(), this.marker);
      if (!range) return this.markLost();
      view.dispatch({
        changes: { ...range, insert: callout },
        annotations: Transaction.addToHistory.of(false),
      });
      return;
    }
    let found = true;
    await this.app.vault.process(this.file, (text) => {
      const range = findCallout(text, this.marker);
      if (!range) {
        found = false;
        return text;
      }
      return text.slice(0, range.from) + callout + text.slice(range.to);
    });
    if (!found) this.markLost();
  }

  private markLost(): void {
    this.lost = true;
  }

  /** The CodeMirror view of an editor that shows this note, if one is open. */
  private editorView(): EditorView | undefined {
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const view = leaf.view;
      if (view instanceof MarkdownView && view.file === this.file) {
        return (view.editor as unknown as { cm?: EditorView }).cm;
      }
    }
    return undefined;
  }
}
