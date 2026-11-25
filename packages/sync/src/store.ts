import { compareOps, type Op } from '@inventorize/core';

/** device id → highest sequence number held. Stores always hold a gap-free prefix per device. */
export type Vector = Record<string, number>;

export type AddResult = 'added' | 'duplicate' | 'gap';

export interface OpStore {
  vector(): Vector;
  /** Adds the op only if it is the next one from its device. */
  add(op: Op): AddResult;
  /** Ops the holder of `vector` is missing, in HLC order (which preserves per-device order). */
  opsSince(vector: Vector): Op[];
  all(): Op[];
}

export class MemoryOpStore implements OpStore {
  private readonly byDevice = new Map<string, Op[]>();

  constructor(ops: Iterable<Op> = []) {
    for (const op of [...ops].sort((a, b) => a.seq - b.seq)) this.add(op);
  }

  vector(): Vector {
    const v: Vector = {};
    for (const [device, ops] of this.byDevice) v[device] = ops.length;
    return v;
  }

  add(op: Op): AddResult {
    const list = this.byDevice.get(op.device) ?? [];
    if (op.seq <= list.length) return 'duplicate';
    if (op.seq !== list.length + 1) return 'gap';
    list.push(op);
    this.byDevice.set(op.device, list);
    return 'added';
  }

  opsSince(vector: Vector): Op[] {
    const out: Op[] = [];
    for (const [device, ops] of this.byDevice) out.push(...ops.slice(vector[device] ?? 0));
    return out.sort(compareOps);
  }

  all(): Op[] {
    return this.opsSince({});
  }
}

/**
 * Minimal SQL surface shared by node:sqlite (hub) and Durable Object storage (cloud),
 * so both servers use the same table layout and logic.
 */
export interface SqlAdapter {
  run(sql: string, ...params: (string | number)[]): void;
  all(sql: string, ...params: (string | number)[]): Record<string, unknown>[];
}

export class SqlOpStore implements OpStore {
  private readonly db: SqlAdapter;
  private readonly cachedVector: Vector = {};

  constructor(db: SqlAdapter) {
    this.db = db;
    db.run(
      `CREATE TABLE IF NOT EXISTS ops (
        device TEXT NOT NULL,
        seq INTEGER NOT NULL,
        hlc TEXT NOT NULL,
        body TEXT NOT NULL,
        PRIMARY KEY (device, seq)
      )`,
    );
    for (const row of db.all('SELECT device, MAX(seq) AS seq FROM ops GROUP BY device')) {
      this.cachedVector[String(row.device)] = Number(row.seq);
    }
  }

  vector(): Vector {
    return { ...this.cachedVector };
  }

  add(op: Op): AddResult {
    const have = this.cachedVector[op.device] ?? 0;
    if (op.seq <= have) return 'duplicate';
    if (op.seq !== have + 1) return 'gap';
    this.db.run('INSERT INTO ops (device, seq, hlc, body) VALUES (?, ?, ?, ?)', op.device, op.seq, op.hlc, JSON.stringify(op));
    this.cachedVector[op.device] = op.seq;
    return 'added';
  }

  opsSince(vector: Vector): Op[] {
    const out: Op[] = [];
    for (const device of Object.keys(this.cachedVector)) {
      const rows = this.db.all('SELECT body FROM ops WHERE device = ? AND seq > ?', device, vector[device] ?? 0);
      for (const row of rows) out.push(JSON.parse(String(row.body)) as Op);
    }
    return out.sort(compareOps);
  }

  all(): Op[] {
    return this.opsSince({});
  }
}
