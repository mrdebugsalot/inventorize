import { describe, expect, it } from 'vitest';
import {
  HlcClock,
  OpWriter,
  ClockDriftError,
  decodeHlc,
  encodeHlc,
  reduce,
  stockStatus,
  validateOp,
  visibleItems,
  type ItemFields,
  type Op,
} from './index.ts';

const fields = (over: Partial<ItemFields> = {}): ItemFields => ({
  name: 'Milk',
  unit: 'L',
  min: 1,
  par: 4,
  locationId: null,
  categoryId: null,
  ...over,
});

/** A device whose clock reads from a shared, manually advanced time. */
function device(id: string, time: { now: number }, household = 'h1') {
  return new OpWriter(household, id, new HlcClock(id, () => time.now));
}

describe('HLC', () => {
  it('round-trips and sorts as strings', () => {
    const a = encodeHlc({ wall: 1000, counter: 0, node: 'b' });
    const b = encodeHlc({ wall: 1000, counter: 1, node: 'a' });
    const c = encodeHlc({ wall: 1001, counter: 0, node: 'a' });
    expect(decodeHlc(a)).toEqual({ wall: 1000, counter: 0, node: 'b' });
    expect([c, b, a].sort()).toEqual([a, b, c]);
  });

  it('is strictly increasing even when the wall clock stalls or goes back', () => {
    let now = 5000;
    const clock = new HlcClock('n', () => now);
    const seen = [clock.tick(), clock.tick()];
    now = 4000;
    seen.push(clock.tick());
    expect([...seen].sort()).toEqual(seen);
    expect(new Set(seen).size).toBe(3);
  });

  it('orders local events after anything received', () => {
    const slow = new HlcClock('slow', () => 1000);
    const fast = new HlcClock('fast', () => 9000);
    const remote = fast.tick();
    slow.receive(remote);
    expect(slow.tick() > remote).toBe(true);
  });

  it('rejects remote clocks more than a day ahead', () => {
    const clock = new HlcClock('n', () => 0);
    const future = encodeHlc({ wall: 2 * 24 * 3600 * 1000, counter: 0, node: 'x' });
    expect(() => clock.receive(future)).toThrow(ClockDriftError);
  });
});

describe('validateOp', () => {
  const t = { now: 1000 };
  it('accepts well-formed ops and rejects tampered ones', () => {
    const f = fields();
    const op = device('d1', t).write('alice', { type: 'item.create', itemId: 'i1', fields: f });
    expect(validateOp(op)).toBe(true);
    expect(validateOp({ ...op, id: 'd1:99' })).toBe(false);
    expect(validateOp({ ...op, hlc: op.hlc.replace(':d1', ':d2') })).toBe(false);
    expect(validateOp({ ...op, fields: { ...f, name: '  ' } })).toBe(false);
    expect(validateOp({ ...op, type: 'nope' })).toBe(false);
    expect(validateOp(null)).toBe(false);
  });
});

describe('reduce: stock', () => {
  it('counts concurrent "used 1" from two people (nothing lost)', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const b = device('b', t);
    const create = a.write('alice', { type: 'item.create', itemId: 'milk', fields: fields() });
    const set = a.write('alice', { type: 'stock.set', itemId: 'milk', qty: 5 });
    t.now = 2000;
    const useA = a.write('alice', { type: 'stock.adjust', itemId: 'milk', delta: -1, reason: 'used' });
    const useB = b.write('bob', { type: 'stock.adjust', itemId: 'milk', delta: -1, reason: 'used' });
    const state = reduce([useB, create, useA, set]);
    expect(state.items.milk!.qty).toBe(3);
  });

  it('counts from the latest stocktake and keeps adjustments made after it', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const b = device('b', t);
    const ops: Op[] = [a.write('alice', { type: 'item.create', itemId: 'egg', fields: fields() })];
    t.now = 1100;
    ops.push(b.write('bob', { type: 'stock.adjust', itemId: 'egg', delta: 6, reason: 'bought' })); // before count: absorbed
    t.now = 1200;
    ops.push(a.write('alice', { type: 'stock.set', itemId: 'egg', qty: 4 }));
    t.now = 1300;
    ops.push(b.write('bob', { type: 'stock.adjust', itemId: 'egg', delta: 1, reason: 'bought' })); // after count: adds
    expect(reduce(ops.reverse()).items.egg!.qty).toBe(5);
  });

  it('avoids floating point noise', () => {
    const t = { now: 1 };
    const a = device('a', t);
    const ops = [
      a.write('x', { type: 'item.create', itemId: 'oil', fields: fields() }),
      a.write('x', { type: 'stock.adjust', itemId: 'oil', delta: 0.1, reason: 'bought' }),
      a.write('x', { type: 'stock.adjust', itemId: 'oil', delta: 0.2, reason: 'bought' }),
    ];
    expect(reduce(ops).items.oil!.qty).toBe(0.3);
  });

  it('reports status', () => {
    expect(stockStatus({ qty: 0, min: 1 })).toBe('out');
    expect(stockStatus({ qty: 1, min: 1 })).toBe('low');
    expect(stockStatus({ qty: 2, min: 1 })).toBe('ok');
  });
});

describe('reduce: field edits and conflicts', () => {
  it('keeps the later of two concurrent edits and records the other', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const b = device('b', t);
    const create = a.write('alice', { type: 'item.create', itemId: 'soap', fields: fields({ min: 1 }) });
    const base = reduce([create]).items.soap!.fieldHlc.min!;
    t.now = 2000;
    const editA = a.write('alice', { type: 'item.update', itemId: 'soap', field: 'min', value: 4, base });
    t.now = 2001;
    const editB = b.write('bob', { type: 'item.update', itemId: 'soap', field: 'min', value: 6, base });
    const state = reduce([editB, editA, create]);
    expect(state.items.soap!.min).toBe(6);
    expect(state.conflicts).toEqual([
      expect.objectContaining({ field: 'min', kept: 6, keptBy: 'bob', overwritten: 4, overwrittenBy: 'alice' }),
    ]);
  });

  it('does not flag sequential edits as conflicts', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const create = a.write('alice', { type: 'item.create', itemId: 'soap', fields: fields() });
    const s1 = reduce([create]);
    const e1 = a.write('alice', {
      type: 'item.update', itemId: 'soap', field: 'name', value: 'Hand soap', base: s1.items.soap!.fieldHlc.name!,
    });
    const s2 = reduce([create, e1]);
    const e2 = a.write('bob', {
      type: 'item.update', itemId: 'soap', field: 'name', value: 'Liquid soap', base: s2.items.soap!.fieldHlc.name!,
    });
    const state = reduce([create, e1, e2]);
    expect(state.items.soap!.name).toBe('Liquid soap');
    expect(state.conflicts).toHaveLength(0);
  });

  it('archive wins over concurrent edits, and restore brings the edits back', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const b = device('b', t);
    const create = a.write('alice', { type: 'item.create', itemId: 'rice', fields: fields({ name: 'Rice' }) });
    t.now = 2000;
    const archive = a.write('alice', { type: 'item.archive', itemId: 'rice' });
    t.now = 2001;
    const rename = b.write('bob', { type: 'item.update', itemId: 'rice', field: 'name', value: 'Basmati', base: create.hlc });
    let state = reduce([create, archive, rename]);
    expect(state.items.rice!.archived).toBe(true);
    expect(visibleItems(state)).toHaveLength(0);
    t.now = 3000;
    const restore = a.write('alice', { type: 'item.restore', itemId: 'rice' });
    state = reduce([create, archive, rename, restore]);
    expect(visibleItems(state).map((i) => i.name)).toEqual(['Basmati']);
  });
});

describe('reduce: undo', () => {
  it('undoes an op, and undoing the undo brings it back', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const create = a.write('x', { type: 'item.create', itemId: 'tp', fields: fields() });
    const add = a.write('x', { type: 'stock.adjust', itemId: 'tp', delta: 12, reason: 'bought' });
    const undo = a.write('x', { type: 'op.undo', targetOpId: add.id });
    expect(reduce([create, add, undo]).items.tp!.qty).toBe(0);
    const redo = a.write('x', { type: 'op.undo', targetOpId: undo.id });
    expect(reduce([create, add, undo, redo]).items.tp!.qty).toBe(12);
  });

  it('ignores an undo that is older than its target', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const b = device('b', t);
    const create = a.write('x', { type: 'item.create', itemId: 'tp', fields: fields() });
    const bogus = b.write('y', { type: 'op.undo', targetOpId: 'a:3' });
    t.now = 2000;
    const add = a.write('x', { type: 'stock.adjust', itemId: 'tp', delta: 2, reason: 'bought' });
    expect(add.id).toBe('a:2');
    const later = a.write('x', { type: 'stock.adjust', itemId: 'tp', delta: 3, reason: 'bought' });
    expect(later.id).toBe('a:3');
    expect(reduce([create, bogus, add, later]).items.tp!.qty).toBe(5);
  });

  it('undoing a create hides the item', () => {
    const t = { now: 1000 };
    const a = device('a', t);
    const create = a.write('x', { type: 'item.create', itemId: 'tp', fields: fields() });
    const undo = a.write('x', { type: 'op.undo', targetOpId: create.id });
    expect(visibleItems(reduce([create, undo]))).toHaveLength(0);
  });
});
