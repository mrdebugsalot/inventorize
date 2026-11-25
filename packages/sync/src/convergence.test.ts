/**
 * The most important test in the project (PLAN.md §11): random edits on several devices,
 * random connections, partial deliveries and dropped connections must always end with every
 * device and server holding the same ops and computing the same state, with no stock
 * adjustment lost.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { reduce, type ItemField, type OpBody } from '@inventorize/core';
import { MemoryOpStore, Replica, SyncNode, type Connection, type SyncMessage } from './index.ts';

const HOUSEHOLD = 'house';
const CLIENTS = 3;

type Action =
  | { k: 'op'; client: number; choice: number; pick: number; amount: number }
  | { k: 'open'; link: number }
  | { k: 'close'; link: number }
  | { k: 'deliver'; link: number; forward: boolean; n: number }
  | { k: 'tick'; ms: number };

interface Link {
  a: SyncNode;
  b: SyncNode;
  live: { ab: SyncMessage[]; ba: SyncMessage[]; connA: Connection; connB: Connection } | null;
}

function buildWorld(skews: number[]) {
  const time = { now: 1_700_000_000_000 };
  const clients = Array.from(
    { length: CLIENTS },
    (_, i) => new Replica(HOUSEHOLD, `phone${i}`, new MemoryOpStore(), () => time.now + (skews[i] ?? 0)),
  );
  const hub = new SyncNode(HOUSEHOLD, new MemoryOpStore(), () => time.now);
  const cloud = new SyncNode(HOUSEHOLD, new MemoryOpStore(), () => time.now);
  const links: Link[] = [{ a: hub, b: cloud, live: null }];
  for (const c of clients) {
    links.push({ a: c, b: hub, live: null }, { a: c, b: cloud, live: null });
  }
  return { time, clients, hub, cloud, links, nodes: [...clients, hub, cloud] };
}

const wire = (m: SyncMessage): SyncMessage => JSON.parse(JSON.stringify(m)) as SyncMessage;

function open(link: Link): void {
  if (link.live) return;
  const ab: SyncMessage[] = [];
  const ba: SyncMessage[] = [];
  const connA = link.a.connect((m) => ab.push(wire(m)));
  const connB = link.b.connect((m) => ba.push(wire(m)));
  link.live = { ab, ba, connA, connB };
}

function close(link: Link): void {
  if (!link.live) return;
  link.live.connA.close();
  link.live.connB.close();
  link.live = null; // anything still in flight is lost, like a dropped socket
}

function deliver(link: Link, forward: boolean, n: number): void {
  const live = link.live;
  if (!live) return;
  for (let i = 0; i < n; i++) {
    const msg = forward ? live.ab.shift() : live.ba.shift();
    if (!msg) return;
    (forward ? live.connB : live.connA).receive(msg);
  }
}

function pending(links: Link[]): number {
  return links.reduce((n, l) => n + (l.live ? l.live.ab.length + l.live.ba.length : 0), 0);
}

/** A realistic edit made from what this device currently sees. */
function localEdit(client: Replica, choice: number, pick: number, amount: number, onlyStock: boolean): void {
  const state = reduce(client.store.all());
  const items = Object.values(state.items).filter((i) => i.exists);
  const actor = `member${pick % 2}`;
  const item = items[pick % Math.max(items.length, 1)];
  const kinds = onlyStock ? 2 : 7;
  const kind = item ? choice % kinds : 0;

  let body: OpBody;
  if (kind === 0 || !item) {
    body = {
      type: 'item.create',
      itemId: `${client.writer.device}-item${client.writer.lastSeq + 1}`,
      fields: { name: `Item ${pick % 5}`, unit: 'pcs', min: 1, par: 4, locationId: null, categoryId: null },
    };
  } else if (kind === 1) {
    body = { type: 'stock.adjust', itemId: item.id, delta: amount === 0 ? 1 : amount, reason: amount < 0 ? 'used' : 'bought' };
  } else if (kind === 2) {
    body = { type: 'stock.set', itemId: item.id, qty: Math.abs(amount) };
  } else if (kind === 3) {
    const field: ItemField = pick % 2 === 0 ? 'name' : 'min';
    const value = field === 'name' ? `Renamed ${amount}` : Math.abs(amount);
    body = { type: 'item.update', itemId: item.id, field, value, base: item.fieldHlc[field] ?? null };
  } else if (kind === 4) {
    body = { type: 'item.archive', itemId: item.id };
  } else if (kind === 5) {
    body = { type: 'item.restore', itemId: item.id };
  } else {
    const all = client.store.all();
    const target = all[pick % all.length]!;
    body = { type: 'op.undo', targetOpId: target.id };
  }
  client.commit(actor, body);
}

function run(actions: Action[], skews: number[], onlyStock = false) {
  const world = buildWorld(skews);
  for (const a of actions) {
    switch (a.k) {
      case 'op':
        localEdit(world.clients[a.client]!, a.choice, a.pick, a.amount, onlyStock);
        break;
      case 'open':
        open(world.links[a.link % world.links.length]!);
        break;
      case 'close':
        close(world.links[a.link % world.links.length]!);
        break;
      case 'deliver':
        deliver(world.links[a.link % world.links.length]!, a.forward, a.n);
        break;
      case 'tick':
        world.time.now += a.ms;
        break;
    }
  }

  // Heal the network: hub↔cloud, and every phone to one of the servers.
  for (const l of world.links) close(l);
  open(world.links[0]!);
  world.links.slice(1).forEach((l, i) => i % 2 === 0 && open(l));
  let guard = 0;
  while (pending(world.links) > 0) {
    if (++guard > 100_000) throw new Error('sync did not settle');
    for (const l of world.links) {
      deliver(l, true, 1);
      deliver(l, false, 1);
    }
  }
  return world;
}

const actionArb: fc.Arbitrary<Action> = fc.oneof(
  { weight: 5, arbitrary: fc.record({ k: fc.constant('op' as const), client: fc.nat(CLIENTS - 1), choice: fc.nat(), pick: fc.nat(), amount: fc.integer({ min: -3, max: 6 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('open' as const), link: fc.nat(6) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('close' as const), link: fc.nat(6) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant('deliver' as const), link: fc.nat(6), forward: fc.boolean(), n: fc.integer({ min: 1, max: 4 }) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('tick' as const), ms: fc.integer({ min: 0, max: 2000 }) }) },
);
const skewsArb = fc.array(fc.integer({ min: -60_000, max: 60_000 }), { minLength: CLIENTS, maxLength: CLIENTS });

const fingerprint = (node: SyncNode) => {
  const s = reduce(node.store.all());
  return JSON.stringify({ items: s.items, conflicts: s.conflicts, undone: [...s.undone].sort() });
};

describe('sync convergence', () => {
  it('every device and server ends with identical ops and state', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 120 }), skewsArb, (actions, skews) => {
        const world = run(actions, skews);
        const expectedVector = world.cloud.store.vector();
        const expectedState = fingerprint(world.cloud);
        for (const node of world.nodes) {
          expect(node.store.vector()).toEqual(expectedVector);
          expect(fingerprint(node)).toBe(expectedState);
        }
        const madeLocally = world.clients.reduce((n, c) => n + c.writer.lastSeq, 0);
        expect(world.cloud.store.all()).toHaveLength(madeLocally);
      }),
      { numRuns: 300 },
    );
  });

  it('computes the same state whatever order ops are applied in', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 80 }), skewsArb, fc.integer(), (actions, skews, seed) => {
        const world = run(actions, skews);
        const ops = world.cloud.store.all();
        const shuffled = [...ops];
        let s = seed;
        for (let i = shuffled.length - 1; i > 0; i--) {
          s = (s * 1103515245 + 12345) & 0x7fffffff;
          const j = s % (i + 1);
          [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
        }
        const a = reduce(ops);
        const b = reduce(shuffled);
        expect(JSON.stringify({ i: b.items, c: b.conflicts })).toBe(JSON.stringify({ i: a.items, c: a.conflicts }));
      }),
      { numRuns: 200 },
    );
  });

  it('never loses a stock adjustment', () => {
    fc.assert(
      fc.property(fc.array(actionArb, { maxLength: 120 }), skewsArb, (actions, skews) => {
        const world = run(actions, skews, true);
        const ops = world.hub.store.all();
        const expected: Record<string, number> = {};
        for (const op of ops) {
          if (op.type === 'item.create') expected[op.itemId] ??= 0;
          if (op.type === 'stock.adjust') expected[op.itemId] = (expected[op.itemId] ?? 0) + op.delta;
        }
        const state = reduce(ops);
        for (const [id, qty] of Object.entries(expected)) expect(state.items[id]!.qty).toBe(qty);
      }),
      { numRuns: 200 },
    );
  });

  it('resyncs after a gap instead of storing out-of-order ops', () => {
    const world = buildWorld([0, 0, 0]);
    const [p0] = world.clients;
    const link = world.links[1]!; // phone0 ↔ hub
    open(link);
    while (pending([link]) > 0) {
      deliver(link, true, 10);
      deliver(link, false, 10);
    }
    p0!.commit('m', { type: 'item.create', itemId: 'x', fields: { name: 'X', unit: '', min: 0, par: 1, locationId: null, categoryId: null } });
    p0!.commit('m', { type: 'stock.adjust', itemId: 'x', delta: 1, reason: 'bought' });
    // Lose the first op in transit, deliver the second.
    link.live!.ab.shift();
    deliver(link, true, 1);
    expect(world.hub.store.vector()).toEqual({});
    // Hub asked for a resync; phone answers; hub now has both, in order.
    deliver(link, false, 1);
    deliver(link, true, 5);
    expect(world.hub.store.vector()).toEqual({ phone0: 2 });
  });
});
