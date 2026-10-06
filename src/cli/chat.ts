import { createInterface } from 'node:readline';
import { AsyncQueue } from '../async-queue.ts';
import { parseArgs, styleText } from 'node:util';
import { type CreateSessionOptions, createSession, type PermissionDecision, type PermissionRequest } from '../index.ts';

const USAGE = `Usage: npm run chat -- [options]

  --harness <claude|codex>   Agent harness (default: claude)
  --cwd <dir>                Working directory of the agent (default: current directory)
  --resume <id>              Continue an earlier session
  --model <name>             Model override
  --exe <path>               Path to the harness binary
  --env KEY=VALUE            Extra environment variable, repeatable (e.g. CLAUDE_CONFIG_DIR=~/.claude-work)
  --permission-mode <mode>   Claude: default | acceptEdits | plan | auto | dontAsk
  --approval-policy <p>      Codex: untrusted | on-request | never
  --sandbox <mode>           Codex: read-only | workspace-write | danger-full-access

In the chat: Ctrl-C stops the current turn. Ctrl-C at the prompt, Ctrl-D or /exit quits.`;

const { values } = parseArgs({
  options: {
    harness: { type: 'string', default: 'claude' },
    cwd: { type: 'string', default: process.cwd() },
    resume: { type: 'string' },
    model: { type: 'string' },
    exe: { type: 'string' },
    env: { type: 'string', multiple: true, default: [] },
    'permission-mode': { type: 'string' },
    'approval-policy': { type: 'string' },
    sandbox: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (values.help || (values.harness !== 'claude' && values.harness !== 'codex')) {
  console.log(USAGE);
  process.exit(values.help ? 0 : 1);
}

const env = Object.fromEntries(
  values.env.map((pair) => {
    const index = pair.indexOf('=');
    if (index < 1) throw new Error(`--env expects KEY=VALUE, got '${pair}'`);
    return [pair.slice(0, index), pair.slice(index + 1).replace(/^~(?=\/)/, process.env.HOME ?? '~')];
  }),
);

const rl = createInterface({ input: process.stdin, output: process.stdout });
const dim = (text: string) => styleText('dim', text);

// Lines go through a queue so that input typed or piped before a prompt appears is not lost.
const lines = new AsyncQueue<string>();
rl.on('line', (line) => lines.push(line));
rl.on('close', () => lines.end());
const lineReader = lines[Symbol.asyncIterator]();
let pendingLine: Promise<IteratorResult<string>> | undefined;

/** Resolves with the next input line, or undefined at end of input or when `signal` aborts. */
async function readLine(prompt: string, signal?: AbortSignal): Promise<string | undefined> {
  rl.setPrompt(prompt);
  rl.prompt();
  pendingLine ??= lineReader.next();
  const next = pendingLine;
  const aborted = new Promise<undefined>((resolve) => signal?.addEventListener('abort', () => resolve(undefined)));
  const result = await Promise.race([next, aborted]);
  if (!result) return undefined;
  pendingLine = undefined;
  return result.done ? undefined : result.value;
}

async function askPermission(request: PermissionRequest): Promise<PermissionDecision> {
  process.stdout.write(`\n${styleText('yellow', `? ${request.title}`)}\n`);
  if (request.detail && !request.title.includes(request.detail)) process.stdout.write(dim(indent(request.detail)) + '\n');
  const answer = (await readLine('  Allow? [y]es / [a]lways / [n]o: ', request.signal))?.trim() ?? '';
  return answer.startsWith('a') ? 'allow-session' : answer.startsWith('y') ? 'allow' : 'deny';
}

const base = {
  cwd: values.cwd,
  clientName: 'obsidian-duet-chat',
  executablePath: values.exe,
  env,
  model: values.model,
  resume: values.resume,
  onPermission: askPermission,
};
const options: CreateSessionOptions =
  values.harness === 'claude'
    ? { harness: 'claude', ...base, permissionMode: values['permission-mode'] as never }
    : {
        harness: 'codex',
        ...base,
        approvalPolicy: values['approval-policy'] as never,
        sandbox: values.sandbox as never,
      };

process.stdout.write(dim(`Starting ${values.harness} in ${values.cwd} ...\n`));
const session = await createSession(options);
console.log(dim(`Session ${session.id}. Resume it with --harness ${session.harness} --resume ${session.id}\n`));

let streamed = false;
session.on((event) => {
  switch (event.type) {
    case 'text-delta':
      streamed = true;
      process.stdout.write(event.text);
      break;
    case 'message':
      process.stdout.write(streamed ? '\n' : `${event.text}\n`);
      streamed = false;
      break;
    case 'tool-start':
      process.stdout.write(dim(`  > ${event.title}\n`));
      break;
    case 'tool-end':
      if (!event.ok) process.stdout.write(styleText('red', `  x failed${event.output ? `: ${firstLine(event.output)}` : ''}\n`));
      break;
    case 'closed':
      if (event.error) console.error(styleText('red', `\nSession closed: ${event.error}`));
      break;
  }
});

let turnRunning = false;
rl.on('SIGINT', () => {
  if (turnRunning) {
    process.stdout.write(dim('\n[interrupting]\n'));
    void session.interrupt();
  } else {
    void quit();
  }
});

async function quit(): Promise<void> {
  await session.close();
  process.exit(0);
}

while (!session.closed) {
  const line = await readLine(styleText('cyan', 'you> '));
  if (line === undefined) break;
  const text = line.trim();
  if (!text) continue;
  if (text === '/exit') break;
  turnRunning = true;
  const result = await session.send(text).finally(() => {
    turnRunning = false;
  });
  if (result.status !== 'completed') {
    console.log(styleText(result.status === 'failed' ? 'red' : 'yellow', `[${result.status}]${result.error ? ` ${result.error}` : ''}`));
  }
  console.log();
}
await quit();

function indent(text: string): string {
  return text
    .split('\n')
    .slice(0, 20)
    .map((line) => `    ${line}`)
    .join('\n');
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0]?.slice(0, 200) ?? '';
}
