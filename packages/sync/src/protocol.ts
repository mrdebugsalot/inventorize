import { isTooFarInFuture, validateOp, type Op } from '@inventorize/core';
import type { OpStore, Vector } from './store.ts';

/**
 * Sync protocol (PLAN.md §6.1). The same messages are used phone↔hub, phone↔cloud and
 * hub↔cloud.
 *
 *  - `sync`: "here is what I have". The receiver answers with every op the sender is
 *    missing, and with its own `sync` if `reply` is set (only on the opening handshake).
 *  - `ops`: new operations. Ops already held are ignored. If one arrives out of order
 *    (a gap), the receiver asks for a resync instead of storing it.
 */
export type SyncMessage =
  | { t: 'sync'; household: string; vector: Vector; reply: boolean }
  | { t: 'ops'; ops: Op[] };

export const MAX_OPS_PER_MESSAGE = 500;

/**
 * Opening handshake. Both ends send one when a connection opens, so neither needs to ask
 * for a reply; `reply: true` is for a peer that only listens.
 */
export function helloMessage(store: OpStore, household: string): SyncMessage {
  return { t: 'sync', household, vector: store.vector(), reply: false };
}

export function parseMessage(raw: string): SyncMessage | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const m = data as Record<string, unknown>;
  if (m.t === 'sync' && typeof m.household === 'string' && isVector(m.vector) && typeof m.reply === 'boolean') {
    return m as SyncMessage;
  }
  if (m.t === 'ops' && Array.isArray(m.ops) && m.ops.length <= MAX_OPS_PER_MESSAGE) {
    return m as SyncMessage;
  }
  return null;
}

function isVector(v: unknown): v is Vector {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false;
  return Object.values(v).every((n) => Number.isInteger(n) && (n as number) >= 0);
}

export interface HandleOptions {
  household: string;
  now?: () => number;
  onRejected?: (op: unknown, reason: string) => void;
}

/**
 * Applies one incoming message to `store`, replying via `send`.
 * Returns the ops that were newly added, which the caller forwards to its other peers.
 */
export function handleMessage(
  store: OpStore,
  msg: SyncMessage,
  send: (m: SyncMessage) => void,
  opts: HandleOptions,
): Op[] {
  if (msg.t === 'sync') {
    if (msg.household !== opts.household) return [];
    const missing = store.opsSince(msg.vector);
    for (let i = 0; i < missing.length; i += MAX_OPS_PER_MESSAGE) {
      send({ t: 'ops', ops: missing.slice(i, i + MAX_OPS_PER_MESSAGE) });
    }
    if (msg.reply) send({ t: 'sync', household: opts.household, vector: store.vector(), reply: false });
    return [];
  }

  const now = (opts.now ?? Date.now)();
  const added: Op[] = [];
  let gap = false;
  let rejected = false;
  for (const op of msg.ops) {
    if (!validateOp(op) || op.household !== opts.household) {
      rejected = true;
      opts.onRejected?.(op, 'invalid');
      continue;
    }
    if (isTooFarInFuture(op.hlc, now)) {
      rejected = true;
      opts.onRejected?.(op, 'clock too far ahead');
      continue;
    }
    const result = store.add(op);
    if (result === 'added') added.push(op);
    else if (result === 'gap') gap = true;
  }
  // Ask the peer to fill the gap. Skipped when something was rejected, because the peer
  // would resend the same rejected op and the two sides would loop.
  if (gap && !rejected) send({ t: 'sync', household: opts.household, vector: store.vector(), reply: false });
  return added;
}
