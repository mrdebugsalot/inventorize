import type { Hlc } from './hlc.ts';
import type { ItemField, ItemFields, Op } from './ops.ts';

/**
 * Current state is a pure function of the set of operations (PLAN.md §5–6).
 * Every replica that holds the same operations computes exactly the same state,
 * whatever order the operations arrived in.
 */

export interface ItemState extends ItemFields {
  id: string;
  /** False until the item's create op is known (or if the create was undone). */
  exists: boolean;
  archived: boolean;
  qty: number;
  createdBy: string | null;
  /** HLC of the op that last wrote each field: editors send this back as `base`. */
  fieldHlc: Partial<Record<ItemField, Hlc>>;
  fieldActor: Partial<Record<ItemField, string>>;
  /** HLC of the stocktake ("set to X") that quantity is currently counted from. */
  lastStockSet: Hlc | null;
  updatedHlc: Hlc;
}

/** A concurrent edit that lost under last-writer-wins. Shown in the activity feed. */
export interface Conflict {
  itemId: string;
  field: ItemField;
  kept: unknown;
  keptBy: string;
  keptOpId: string;
  overwritten: unknown;
  overwrittenBy: string | null;
  hlc: Hlc;
}

export interface HouseholdState {
  items: Record<string, ItemState>;
  conflicts: Conflict[];
  /** Ids of operations cancelled by an effective undo. */
  undone: Set<string>;
}

export function compareOps(a: Op, b: Op): number {
  if (a.hlc !== b.hlc) return a.hlc < b.hlc ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Undo is itself an op, and an undo can be undone. Walking newest-to-oldest, an op is
 * cancelled when a later, still-effective undo targets it. An undo only affects ops older
 * than itself.
 */
export function findUndone(sorted: readonly Op[]): Set<string> {
  const cancelled = new Set<string>();
  const newer = new Set<string>();
  for (let i = sorted.length - 1; i >= 0; i--) {
    const op = sorted[i]!;
    newer.add(op.id);
    if (cancelled.has(op.id)) continue;
    if (op.type === 'op.undo' && !newer.has(op.targetOpId)) cancelled.add(op.targetOpId);
  }
  return cancelled;
}

/** Avoids floating-point noise like 0.1 + 0.2 in quantities. */
const roundQty = (n: number): number => Math.round(n * 1000) / 1000;

const valuesEqual = (a: unknown, b: unknown): boolean => a === b;

function blankItem(id: string, hlc: Hlc): ItemState {
  return {
    id,
    name: '',
    unit: '',
    min: 0,
    par: 0,
    locationId: null,
    categoryId: null,
    exists: false,
    archived: false,
    qty: 0,
    createdBy: null,
    fieldHlc: {},
    fieldActor: {},
    lastStockSet: null,
    updatedHlc: hlc,
  };
}

function writeField<F extends ItemField>(item: ItemState, field: F, value: ItemFields[F], op: Op): void {
  item[field] = value as ItemState[F];
  item.fieldHlc[field] = op.hlc;
  item.fieldActor[field] = op.actor;
}

export function reduce(ops: Iterable<Op>): HouseholdState {
  const sorted = [...ops].sort(compareOps);
  const undone = findUndone(sorted);
  const items: Record<string, ItemState> = {};
  const conflicts: Conflict[] = [];

  const itemFor = (id: string, hlc: Hlc): ItemState => (items[id] ??= blankItem(id, hlc));

  for (const op of sorted) {
    if (undone.has(op.id) || op.type === 'op.undo') continue;
    const item = itemFor(op.itemId, op.hlc);
    item.updatedHlc = op.hlc;

    switch (op.type) {
      case 'item.create': {
        if (!item.exists) {
          item.exists = true;
          item.createdBy ??= op.actor;
        }
        for (const field of Object.keys(op.fields) as ItemField[]) {
          writeField(item, field, op.fields[field], op);
        }
        break;
      }
      case 'item.update': {
        // Ops are applied oldest-first, so applying in order IS last-writer-wins.
        // If someone else wrote this field after the value the editor saw, the two edits
        // were concurrent: record the value being overwritten so it isn't lost silently.
        const current = item.fieldHlc[op.field] ?? null;
        const editorSawOlder = current !== null && (op.base === null || op.base < current);
        if (editorSawOlder && !valuesEqual(item[op.field], op.value)) {
          conflicts.push({
            itemId: op.itemId,
            field: op.field,
            kept: op.value,
            keptBy: op.actor,
            keptOpId: op.id,
            overwritten: item[op.field],
            overwrittenBy: item.fieldActor[op.field] ?? null,
            hlc: op.hlc,
          });
        }
        writeField(item, op.field, op.value, op);
        break;
      }
      case 'item.archive':
        item.archived = true;
        break;
      case 'item.restore':
        item.archived = false;
        break;
      case 'stock.adjust':
        // Additive: concurrent "used 1" taps from two people both count.
        item.qty = roundQty(item.qty + op.delta);
        break;
      case 'stock.set':
        // A stocktake replaces everything before it; adjustments after it still add on.
        item.qty = roundQty(op.qty);
        item.lastStockSet = op.hlc;
        break;
    }
  }

  return { items, conflicts, undone };
}

/** Items a person should see: created and not archived, sorted by name. */
export function visibleItems(state: HouseholdState): ItemState[] {
  return Object.values(state.items)
    .filter((i) => i.exists && !i.archived)
    .sort((a, b) => a.name.localeCompare(b.name) || (a.id < b.id ? -1 : 1));
}

export type StockStatus = 'out' | 'low' | 'ok';

export function stockStatus(item: Pick<ItemState, 'qty' | 'min'>): StockStatus {
  if (item.qty <= 0) return 'out';
  if (item.qty <= item.min) return 'low';
  return 'ok';
}
