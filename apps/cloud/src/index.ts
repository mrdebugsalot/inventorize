/**
 * Cloud relay (PLAN.md §4.1): lets family members sync while away from home.
 *
 * Each household is one Durable Object holding the full op log in its built-in SQLite.
 * WebSocket hibernation keeps idle connections free: the object sleeps between messages
 * and rebuilds its small in-memory state when woken.
 *
 * Phase 0: no sign-in yet. The household id (128-bit random) acts as the secret.
 * Phase 2 adds signed device tokens.
 */
import { DurableObject } from 'cloudflare:workers';
import { SqlOpStore, handleMessage, helloMessage, parseMessage, type SqlAdapter, type SyncMessage } from '@inventorize/sync';

interface Env {
  HOUSEHOLD: DurableObjectNamespace<Household>;
}

const HOUSEHOLD_PATH = /^\/sync\/([a-f0-9]{16,64})$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === '/health') return Response.json({ ok: true });

    const match = url.pathname.match(HOUSEHOLD_PATH);
    if (!match) return new Response('Not found', { status: 404 });
    if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 });
    }
    const household = match[1]!;
    const stub = env.HOUSEHOLD.get(env.HOUSEHOLD.idFromName(household));
    const headers = new Headers(req.headers);
    headers.set('X-Household', household);
    return stub.fetch(new Request(req, { headers }));
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  household: string;
}

export class Household extends DurableObject<Env> {
  private readonly store: SqlOpStore;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    const adapter: SqlAdapter = {
      run: (q, ...params) => void sql.exec(q, ...params),
      all: (q, ...params) => sql.exec(q, ...params).toArray() as Record<string, unknown>[],
    };
    this.store = new SqlOpStore(adapter);
  }

  override async fetch(req: Request): Promise<Response> {
    const household = req.headers.get('X-Household');
    if (!household) return new Response('Bad request', { status: 400 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ household } satisfies Attachment);
    // Opening handshake: tell the device what we hold, so it sends what we're missing.
    server.send(JSON.stringify(helloMessage(this.store, household)));
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer): Promise<void> {
    const { household } = ws.deserializeAttachment() as Attachment;
    const msg = parseMessage(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (!msg) return;
    const send = (m: SyncMessage) => ws.send(JSON.stringify(m));
    const added = handleMessage(this.store, msg, send, { household });
    if (added.length === 0) return;
    const forward = JSON.stringify({ t: 'ops', ops: added } satisfies SyncMessage);
    for (const other of this.ctx.getWebSockets()) {
      if (other !== ws) {
        try {
          other.send(forward);
        } catch {
          // Socket already closing; that device will catch up on reconnect.
        }
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    ws.close(code === 1005 ? 1000 : code, 'closing');
  }
}
