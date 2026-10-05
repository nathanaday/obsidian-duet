import { randomUUID } from 'node:crypto';
import { cp, mkdtemp } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import {
  type AgentSession,
  type CreateSessionOptions,
  createSession,
  findExecutable,
  harnessEnvironment,
  type PermissionDecision,
  type PermissionRequest,
} from '../../src/index.ts';
import type { DemoInfo, Envelope, Harness, SessionInfo, StartRequest, WireEvent } from './protocol.ts';

const SAMPLE_VAULT = fileURLToPath(new URL('../sample-vault', import.meta.url));
const DECISIONS: PermissionDecision[] = ['allow', 'allow-session', 'deny'];

class HostedSession {
  readonly log: Envelope[] = [];
  readonly clients = new Set<ServerResponse>();
  private readonly pending = new Map<string, (decision: PermissionDecision) => void>();
  private readonly startedAt = Date.now();
  session!: AgentSession;

  constructor(
    readonly harness: Harness,
    readonly cwd: string,
  ) {}

  push(event: WireEvent): void {
    const envelope: Envelope = { seq: this.log.length, at: Date.now() - this.startedAt, event };
    this.log.push(envelope);
    const frame = `data: ${JSON.stringify(envelope)}\n\n`;
    for (const client of this.clients) client.write(frame);
  }

  readonly askPermission = (request: PermissionRequest): Promise<PermissionDecision> =>
    new Promise((resolve) => {
      const requestId = randomUUID();
      this.pending.set(requestId, resolve);
      this.push({ type: 'permission-request', requestId, tool: request.tool, title: request.title, detail: request.detail });
      request.signal.addEventListener('abort', () => {
        if (!this.pending.delete(requestId)) return;
        resolve('deny');
        this.push({ type: 'permission-resolved', requestId, decision: 'cancelled' });
      });
    });

  decide(requestId: string, decision: PermissionDecision): boolean {
    const resolve = this.pending.get(requestId);
    if (!resolve) return false;
    this.pending.delete(requestId);
    resolve(decision);
    this.push({ type: 'permission-resolved', requestId, decision });
    return true;
  }

  info(): SessionInfo {
    return { id: this.session.id, harness: this.harness, cwd: this.cwd };
  }
}

function harnessOptions({ harness, approval, userTools }: StartRequest): Partial<CreateSessionOptions> {
  if (harness === 'claude') {
    return {
      permissionMode: approval === 'accept-edits' ? 'acceptEdits' : approval === 'plan' ? 'plan' : 'default',
      sdkOptions: { strictMcpConfig: !userTools },
    };
  }
  return { approvalPolicy: approval === 'sandbox' ? 'on-request' : 'untrusted', sandbox: 'workspace-write' };
}

/** Hosts agent sessions in the Vite dev server and exposes them under /api. */
export function agentApi(): Plugin {
  const sessions = new Map<string, HostedSession>();
  let info: Promise<DemoInfo> | undefined;

  async function freshSandbox(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'helenite-demo-'));
    await cp(SAMPLE_VAULT, dir, { recursive: true });
    return dir;
  }

  const demoInfo = () =>
    (info ??= (async () => {
      const env = await harnessEnvironment();
      const check = async (name: string) => {
        try {
          await findExecutable(name, env);
          return { available: true };
        } catch (error) {
          return { available: false, error: (error as Error).message };
        }
      };
      return { harnesses: { claude: await check('claude'), codex: await check('codex') } };
    })());

  async function start(request: StartRequest): Promise<SessionInfo> {
    const cwd = request.cwd.trim() || (await freshSandbox());
    const hosted = new HostedSession(request.harness, cwd);
    hosted.session = await createSession({
      harness: request.harness,
      cwd,
      clientName: 'agent-helenite-demo',
      resume: request.resume || undefined,
      onPermission: hosted.askPermission,
      ...harnessOptions(request),
    } as CreateSessionOptions);
    hosted.session.on((event) => hosted.push(event));
    sessions.set(hosted.session.id, hosted);
    return hosted.info();
  }

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const [resource, id, action, actionId] = url.pathname.split('/').filter(Boolean);

    if (resource === 'info' && req.method === 'GET') return json(res, 200, await demoInfo());

    if (resource !== 'sessions') return json(res, 404, { error: 'Not found' });
    if (!id && req.method === 'POST') return json(res, 201, await start(await body<StartRequest>(req)));

    const hosted = id ? sessions.get(id) : undefined;
    if (!hosted) return json(res, 404, { error: 'This session does not exist. Start a new one.' });

    if (!action && req.method === 'GET') return json(res, 200, hosted.info());
    if (!action && req.method === 'DELETE') {
      sessions.delete(hosted.session.id);
      await hosted.session.close();
      return json(res, 200, {});
    }
    if (action === 'events' && req.method === 'GET') return stream(req, res, hosted);
    if (action === 'messages' && req.method === 'POST') {
      const { text } = await body<{ text: string }>(req);
      if (hosted.session.closed) return json(res, 409, { error: 'The session has ended.' });
      hosted.session.send(text).catch(() => undefined);
      return json(res, 202, {});
    }
    if (action === 'interrupt' && req.method === 'POST') {
      await hosted.session.interrupt();
      return json(res, 200, {});
    }
    if (action === 'permissions' && actionId && req.method === 'POST') {
      const { decision } = await body<{ decision: PermissionDecision }>(req);
      if (!DECISIONS.includes(decision)) return json(res, 400, { error: `Unknown decision: ${decision}` });
      if (!hosted.decide(actionId, decision)) return json(res, 410, { error: 'The agent no longer needs this answer.' });
      return json(res, 200, {});
    }
    return json(res, 404, { error: 'Not found' });
  }

  return {
    name: 'agent-helenite-api',
    configureServer(server) {
      server.middlewares.use('/api', (req, res) => {
        route(req, res).catch((error: Error) => json(res, 500, { error: error.message }));
      });
      server.httpServer?.on('close', () => {
        for (const hosted of sessions.values()) void hosted.session.close();
      });
    },
  };
}

function stream(req: IncomingMessage, res: ServerResponse, hosted: HostedSession): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const envelope of hosted.log) res.write(`data: ${JSON.stringify(envelope)}\n\n`);
  hosted.clients.add(res);
  req.on('close', () => hosted.clients.delete(res));
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function body<T>(req: IncomingMessage): Promise<T> {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return JSON.parse(raw || '{}') as T;
}
