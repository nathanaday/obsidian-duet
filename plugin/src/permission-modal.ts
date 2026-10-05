import { type App, Modal } from 'obsidian';
import type { PermissionDecision, PermissionRequest } from '../../src/index.ts';

export interface PermissionContext {
  agent: string;
  notePath: string;
}

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit', 'fileChange']);

function action(tool: string): string {
  if (tool === 'Bash' || tool === 'command') return 'run a command';
  if (FILE_TOOLS.has(tool)) return 'change a file';
  if (tool === 'permissions') return 'get more access';
  return `use ${tool}`;
}

/** Shows approval requests one at a time. Requests from several notes wait in order. */
export class PermissionPrompts {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly app: App) {}

  ask(request: PermissionRequest, context: PermissionContext): Promise<PermissionDecision> {
    const answer = this.queue.then(() =>
      request.signal.aborted ? ('deny' as const) : new PermissionModal(this.app, request, context).result,
    );
    this.queue = answer.catch(() => undefined);
    return answer;
  }
}

class PermissionModal extends Modal {
  readonly result: Promise<PermissionDecision>;
  private resolve!: (decision: PermissionDecision) => void;
  private decided = false;

  constructor(
    app: App,
    private readonly request: PermissionRequest,
    private readonly context: PermissionContext,
  ) {
    super(app);
    this.result = new Promise((resolve) => {
      this.resolve = resolve;
    });
    request.signal.addEventListener('abort', () => this.decide('deny'));
    this.open();
  }

  onOpen(): void {
    const { request, context } = this;
    this.modalEl.addClass('helenite-permission');
    this.titleEl.setText(`${context.agent} wants to ${action(request.tool)}`);
    const { contentEl } = this;
    contentEl.createEl('p', { cls: 'helenite-permission-note', text: `From ${context.notePath}` });
    contentEl.createEl('p', { cls: 'helenite-permission-title', text: request.title });

    if (request.detail && !request.title.includes(request.detail)) {
      const pre = contentEl.createEl('pre', { cls: 'helenite-permission-detail' });
      const isDiff = FILE_TOOLS.has(request.tool);
      for (const line of request.detail.split('\n')) {
        const kind = !isDiff ? '' : line.startsWith('+') ? 'is-add' : line.startsWith('-') ? 'is-remove' : line.startsWith('@@') ? 'is-hunk' : '';
        pre.createSpan({ cls: `helenite-line ${kind}`, text: line || ' ' });
      }
    }

    const choices = contentEl.createDiv({ cls: 'helenite-permission-choices' });
    const choice = (label: string, key: string, decision: PermissionDecision, primary = false) => {
      const button = choices.createEl('button', { cls: primary ? 'mod-cta' : '' });
      button.createSpan({ text: label });
      button.createEl('kbd', { text: key.toUpperCase() });
      button.addEventListener('click', () => this.decide(decision));
      this.scope.register([], key, () => {
        this.decide(decision);
        return false;
      });
      return button;
    };
    choice('Allow once', 'y', 'allow', true).focus();
    choice('Allow for this conversation', 'a', 'allow-session');
    choice('Deny', 'n', 'deny');
  }

  onClose(): void {
    this.contentEl.empty();
    this.decide('deny');
  }

  private decide(decision: PermissionDecision): void {
    if (this.decided) return;
    this.decided = true;
    this.resolve(decision);
    this.close();
  }
}
