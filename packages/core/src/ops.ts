import { HlcClock, isValidHlc, type Hlc } from './hlc.ts';

/**
 * Operations are the source of truth (PLAN.md §5). They are immutable and identified by
 * (device, seq): every device numbers its own operations 1, 2, 3, ... with no gaps.
 */

export type StockReason = 'used' | 'bought' | 'wasted' | 'correction';

export interface ItemFields {
  name: string;
  unit: string;
  /** Reorder point: at or below this the item is "low". */
  min: number;
  /** Full level that "restock" fills up to. */
  par: number;
  locationId: string | null;
  categoryId: string | null;
}

export type ItemField = keyof ItemFields;
export const ITEM_FIELDS: readonly ItemField[] = ['name', 'unit', 'min', 'par', 'locationId', 'categoryId'];

export type OpBody =
  | { type: 'item.create'; itemId: string; fields: ItemFields }
  | {
      type: 'item.update';
      itemId: string;
      field: ItemField;
      value: ItemFields[ItemField];
      /** HLC of the field value the editor was looking at; used to detect concurrent edits. */
      base: Hlc | null;
    }
  | { type: 'item.archive'; itemId: string }
  | { type: 'item.restore'; itemId: string }
  | { type: 'stock.adjust'; itemId: string; delta: number; reason: StockReason }
  | { type: 'stock.set'; itemId: string; qty: number }
  | { type: 'op.undo'; targetOpId: string };

export type OpType = OpBody['type'];

export interface OpMeta {
  /** `${device}:${seq}`, unique across the household. */
  id: string;
  household: string;
  device: string;
  seq: number;
  hlc: Hlc;
  /** The member who did it (picked on the shared display). */
  actor: string;
}

export type Op = OpMeta & OpBody;

export const opId = (device: string, seq: number): string => `${device}:${seq}`;

/** Creates this device's operations: stamps HLC, sequence number and id. */
export class OpWriter {
  readonly household: string;
  readonly device: string;
  readonly clock: HlcClock;
  private seq: number;

  constructor(household: string, device: string, clock: HlcClock, lastSeq = 0) {
    if (clock.node !== device) throw new Error('Clock node must equal device id');
    this.household = household;
    this.device = device;
    this.clock = clock;
    this.seq = lastSeq;
  }

  get lastSeq(): number {
    return this.seq;
  }

  write(actor: string, body: OpBody): Op {
    this.seq += 1;
    return {
      ...body,
      id: opId(this.device, this.seq),
      household: this.household,
      device: this.device,
      seq: this.seq,
      hlc: this.clock.tick(),
      actor,
    };
  }
}

// ---------------------------------------------------------------------------
// Validation: servers and clients never trust operations from the network.
// ---------------------------------------------------------------------------

const MAX_ID_LEN = 128;
const MAX_TEXT_LEN = 500;
const REASONS: readonly StockReason[] = ['used', 'bought', 'wasted', 'correction'];

const isId = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_LEN;
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isText = (v: unknown): v is string => typeof v === 'string' && v.length <= MAX_TEXT_LEN;
const isNullableId = (v: unknown): v is string | null => v === null || isId(v);

function isFieldValue(field: ItemField, v: unknown): boolean {
  switch (field) {
    case 'name':
      return isText(v) && v.trim().length > 0;
    case 'unit':
      return isText(v);
    case 'min':
    case 'par':
      return isFiniteNum(v) && v >= 0;
    case 'locationId':
    case 'categoryId':
      return isNullableId(v);
  }
}

function isItemFields(v: unknown): v is ItemFields {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return ITEM_FIELDS.every((f) => isFieldValue(f, o[f]));
}

export function validateOp(v: unknown): v is Op {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!isId(o.household) || !isId(o.device) || !isId(o.actor)) return false;
  if (typeof o.device === 'string' && o.device.includes(':')) return false;
  if (!Number.isInteger(o.seq) || (o.seq as number) < 1) return false;
  if (o.id !== opId(o.device as string, o.seq as number)) return false;
  if (!isValidHlc(o.hlc) || !(o.hlc as string).endsWith(`:${o.device as string}`)) return false;

  switch (o.type) {
    case 'item.create':
      return isId(o.itemId) && isItemFields(o.fields);
    case 'item.update':
      return (
        isId(o.itemId) &&
        typeof o.field === 'string' &&
        (ITEM_FIELDS as readonly string[]).includes(o.field) &&
        isFieldValue(o.field as ItemField, o.value) &&
        (o.base === null || isValidHlc(o.base))
      );
    case 'item.archive':
    case 'item.restore':
      return isId(o.itemId);
    case 'stock.adjust':
      return (
        isId(o.itemId) &&
        isFiniteNum(o.delta) &&
        o.delta !== 0 &&
        REASONS.includes(o.reason as StockReason)
      );
    case 'stock.set':
      return isId(o.itemId) && isFiniteNum(o.qty) && o.qty >= 0;
    case 'op.undo':
      return isId(o.targetOpId);
    default:
      return false;
  }
}
