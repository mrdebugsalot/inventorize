/**
 * Home hub (PLAN.md §4): runs on the Raspberry Pi. Phones and the wall display sync with it
 * over the home network, and it relays everything to the cloud whenever the internet is up.
 *
 * Environment:
 *   PORT        default 8787
 *   DATA_DIR    default apps/hub/data
 *   CLOUD_URL   e.g. wss://inventorize-relay.<you>.workers.dev (optional)
 *   HOUSEHOLDS  comma-separated household ids this hub serves (optional; default: any)
 *   TLS_CERT / TLS_KEY  paths to a certificate and key, to serve wss:// (phase 5: Let's Encrypt via DuckDNS)
 *
 * Run: npm run hub
 */
import { createServer as createHttp, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketServer } from 'ws';
import { SqlOpStore, SyncNode, parseMessage, type SqlAdapter, type SyncMessage } from '@inventorize/sync';

const PORT = Number(process.env.PORT ?? 8787);
const DATA_DIR = resolve(process.env.DATA_DIR ?? join(import.meta.dirname, '..', 'data'));
const CLOUD_URL = (process.env.CLOUD_URL ?? '').replace(/\/+$/, '');
const ALLOWED = new Set((process.env.HOUSEHOLDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));
const HOUSEHOLD_RE = /^[a-f0-9]{16,64}$/;
const SYNC_PATH = /^\/sync\/([a-f0-9]{16,64})$/;

mkdirSync(DATA_DIR, { recursive: true });

interface HouseholdHub {
  node: SyncNode;
  upstream: 'off' | 'connecting' | 'online' | 'offline';
}
const households = new Map<string, HouseholdHub>();

function sqlite(file: string): SqlAdapter {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  return {
    run: (sql, ...params) => void db.prepare(sql).run(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
  };
}

function hubFor(household: string): HouseholdHub {
  let hub = households.get(household);
  if (!hub) {
    const node = new SyncNode(household, new SqlOpStore(sqlite(join(DATA_DIR, `${household}.db`))));
    hub = { node, upstream: 'off' };
    households.set(household, hub);
    if (CLOUD_URL) connectUpstream(household, hub);
  }
  return hub;
}

/** Keep a connection to the cloud relay open, reconnecting with backoff. */
function connectUpstream(household: string, hub: HouseholdHub): void {
  let retries = 0;
  const open = () => {
    hub.upstream = 'connecting';
    const ws = new WebSocket(`${CLOUD_URL}/sync/${household}`);
    let conn: ReturnType<SyncNode['connect']> | null = null;
    ws.onopen = () => {
      retries = 0;
      hub.upstream = 'online';
      conn = hub.node.connect((m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)));
      log(`cloud: connected (${household.slice(0, 6)}…)`);
    };
    ws.onmessage = (e) => {
      const msg = parseMessage(String(e.data));
      if (msg) conn?.receive(msg);
    };
    ws.onclose = () => {
      conn?.close();
      if (hub.upstream === 'online') log(`cloud: disconnected (${household.slice(0, 6)}…)`);
      hub.upstream = 'offline';
      const delay = Math.min(60_000, 1000 * 2 ** retries++);
      setTimeout(open, delay);
    };
    ws.onerror = () => {
      // onclose follows and schedules the retry.
    };
  };
  open();
}

function handleHttp(req: IncomingMessage, res: ServerResponse): void {
  // Lets the GitHub-hosted app (a public origin) talk to this LAN device (Private Network Access).
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        ok: true,
        cloud: CLOUD_URL || null,
        households: [...households].map(([id, h]) => ({
          id: `${id.slice(0, 6)}…`,
          devices: h.node.connectionCount - (h.upstream === 'online' ? 1 : 0),
          ops: Object.values(h.node.store.vector()).reduce((a, b) => a + b, 0),
          upstream: h.upstream,
        })),
      }),
    );
    return;
  }
  res.writeHead(404).end('Not found');
}

const server =
  process.env.TLS_CERT && process.env.TLS_KEY
    ? createHttps({ cert: readFileSync(process.env.TLS_CERT), key: readFileSync(process.env.TLS_KEY) }, handleHttp)
    : createHttp(handleHttp);

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const household = req.url?.match(SYNC_PATH)?.[1];
  if (!household || (ALLOWED.size > 0 && !ALLOWED.has(household))) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const hub = hubFor(household);
    const conn = hub.node.connect((m: SyncMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)));
    let alive = true;
    ws.on('pong', () => (alive = true));
    const ping = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 30_000);
    ws.on('message', (data) => {
      const msg = parseMessage(data.toString());
      if (msg) conn.receive(msg);
    });
    ws.on('close', () => {
      clearInterval(ping);
      conn.close();
    });
  });
});

// Re-open households this hub already knows, so they relay to the cloud straight away.
for (const file of readdirSync(DATA_DIR)) {
  const id = file.replace(/\.db$/, '');
  if (file.endsWith('.db') && HOUSEHOLD_RE.test(id)) hubFor(id);
}

function log(msg: string): void {
  console.log(`${new Date().toISOString()} ${msg}`);
}

server.listen(PORT, () => {
  const scheme = process.env.TLS_CERT ? 'wss' : 'ws';
  log(`hub listening on ${scheme}://0.0.0.0:${PORT} (data: ${DATA_DIR}${CLOUD_URL ? `, cloud: ${CLOUD_URL}` : ''})`);
});
