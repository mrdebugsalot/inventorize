import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { HlcClock, OpWriter, type Op } from '@inventorize/core';
import { MemoryOpStore, SqlOpStore, type OpStore, type SqlAdapter } from './index.ts';

function sqliteAdapter(db: DatabaseSync): SqlAdapter {
  return {
    run: (sql, ...params) => void db.prepare(sql).run(...params),
    all: (sql, ...params) => db.prepare(sql).all(...params) as Record<string, unknown>[],
  };
}

function ops(device: string, n: number, start = 1000): Op[] {
  let now = start;
  const w = new OpWriter('h', device, new HlcClock(device, () => now++));
  const out = [w.write('m', { type: 'item.create', itemId: `${device}-i`, fields: { name: 'A', unit: '', min: 0, par: 1, locationId: null, categoryId: null } })];
  for (let i = 1; i < n; i++) out.push(w.write('m', { type: 'stock.adjust', itemId: `${device}-i`, delta: 1, reason: 'bought' }));
  return out;
}

const stores: [string, () => OpStore][] = [
  ['memory', () => new MemoryOpStore()],
  ['sqlite', () => new SqlOpStore(sqliteAdapter(new DatabaseSync(':memory:')))],
];

describe.each(stores)('%s op store', (_name, make) => {
  it('keeps a gap-free prefix per device', () => {
    const store = make();
    const [a1, a2, a3] = ops('a', 3);
    expect(store.add(a1!)).toBe('added');
    expect(store.add(a3!)).toBe('gap');
    expect(store.add(a2!)).toBe('added');
    expect(store.add(a2!)).toBe('duplicate');
    expect(store.add(a3!)).toBe('added');
    expect(store.vector()).toEqual({ a: 3 });
  });

  it('returns what a peer is missing, in HLC order', () => {
    const store = make();
    const a = ops('a', 3, 1000);
    const b = ops('b', 2, 1001);
    [...a, ...b].forEach((op) => store.add(op));
    const missing = store.opsSince({ a: 1 });
    expect(missing.map((o) => o.id)).toEqual(['a:2', 'b:1', 'a:3', 'b:2']);
  });
});

describe('SqlOpStore', () => {
  it('reloads its vector from disk', () => {
    const db = new DatabaseSync(':memory:');
    const first = new SqlOpStore(sqliteAdapter(db));
    ops('a', 4).forEach((op) => first.add(op));
    const reopened = new SqlOpStore(sqliteAdapter(db));
    expect(reopened.vector()).toEqual({ a: 4 });
    expect(reopened.all()).toHaveLength(4);
  });
});
