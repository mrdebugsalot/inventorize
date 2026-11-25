/**
 * This device's place in the household: identity, local persistence and sync connections.
 *
 * Phase 0 stores ops in localStorage; Phase 1 moves them to IndexedDB (Dexie).
 * Phase 0 has no sign-in: the household code in the invite link is the only secret.
 * QR pairing with signed device tokens replaces this in Phase 2 (PLAN.md §4.4).
 */
import type { Op } from '@inventorize/core';
import { MemoryOpStore, Replica, parseMessage, type Connection } from '@inventorize/sync';

const KEY = {
  household: 'inv.household',
  device: 'inv.device',
  member: 'inv.member',
  hubUrl: 'inv.hubUrl',
  ops: (household: string) => `inv.ops.${household}`,
};

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: data stays in memory and still syncs.
  }
}

/** Works outside secure contexts too (plain-HTTP LAN testing), unlike crypto.randomUUID. */
function randomId(bytes = 12): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export interface Identity {
  household: string;
  device: string;
}

const HOUSEHOLD_RE = /^[a-f0-9]{16,64}$/;

export function loadIdentity(): Identity {
  let household = read(KEY.household);
  const url = new URL(location.href);
  const join = url.searchParams.get('join');
  if (join && HOUSEHOLD_RE.test(join) && join !== household) {
    const hasData = household !== null && (read(KEY.ops(household))?.length ?? 0) > 2;
    if (!hasData || confirm('Join the household from this link? This device will switch to that household’s list.')) {
      household = join;
    }
  }
  if (join) {
    url.searchParams.delete('join');
    history.replaceState(null, '', url);
  }
  if (!household) household = randomId(16);
  write(KEY.household, household);

  let device = read(KEY.device);
  if (!device) {
    device = `d${randomId(8)}`;
    write(KEY.device, device);
  }
  return { household, device };
}

export const settings = {
  member: () => read(KEY.member) ?? '',
  setMember: (v: string) => write(KEY.member, v.trim()),
  hubUrl: () => read(KEY.hubUrl) ?? '',
  setHubUrl: (v: string) => write(KEY.hubUrl, v.trim()),
};

export function inviteLink(household: string): string {
  const url = new URL(import.meta.env.BASE_URL, location.origin);
  url.searchParams.set('join', household);
  return url.toString();
}

export function createReplica({ household, device }: Identity): Replica {
  let saved: Op[] = [];
  try {
    saved = JSON.parse(read(KEY.ops(household)) ?? '[]') as Op[];
  } catch {
    saved = [];
  }
  const replica = new Replica(household, device, new MemoryOpStore(saved));

  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    write(KEY.ops(household), JSON.stringify(replica.store.all()));
  };
  replica.onOps(() => {
    if (timer === undefined) timer = setTimeout(flush, 150);
  });
  addEventListener('pagehide', flush);
  return replica;
}

export type LinkState = 'off' | 'connecting' | 'online' | 'offline';

/** One sync server (cloud relay or home hub), reconnecting with backoff. */
export class Endpoint {
  readonly label: string;
  state: LinkState = 'off';
  private url = '';
  private readonly replica: Replica;
  private readonly onChange: () => void;
  private ws: WebSocket | null = null;
  private conn: Connection | null = null;
  private retries = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(label: string, replica: Replica, onChange: () => void) {
    this.label = label;
    this.replica = replica;
    this.onChange = onChange;
  }

  setUrl(url: string): void {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean === this.url) return;
    this.url = clean;
    this.retries = 0;
    this.open();
  }

  /** Try again right away, e.g. when the device comes back online. */
  nudge(): void {
    if (this.url && this.state !== 'online' && this.state !== 'connecting') {
      this.retries = 0;
      this.open();
    }
  }

  private setState(s: LinkState): void {
    if (this.state !== s) {
      this.state = s;
      this.onChange();
    }
  }

  private open(): void {
    clearTimeout(this.timer);
    this.teardown();
    if (!this.url) return this.setState('off');
    // Only the first attempt shows "Connecting…"; background retries keep showing "Offline".
    this.setState(this.retries === 0 ? 'connecting' : 'offline');
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${this.url}/sync/${this.replica.household}`);
    } catch {
      return this.scheduleRetry();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.conn = this.replica.connect((m) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(m)));
      this.setState('online');
    };
    ws.onmessage = (e) => {
      const msg = parseMessage(String(e.data));
      if (msg) this.conn?.receive(msg);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.teardown();
      this.scheduleRetry();
    };
  }

  private teardown(): void {
    this.conn?.close();
    this.conn = null;
    if (this.ws) {
      const old = this.ws;
      this.ws = null;
      old.onclose = null;
      old.close();
    }
  }

  private scheduleRetry(): void {
    this.setState('offline');
    const delay = Math.min(30_000, 1000 * 2 ** this.retries) * (0.5 + Math.random() / 2);
    this.retries += 1;
    this.timer = setTimeout(() => this.open(), delay);
  }
}
