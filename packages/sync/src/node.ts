import { ClockDriftError, HlcClock, OpWriter, type Op, type OpBody } from '@inventorize/core';
import { handleMessage, helloMessage, type SyncMessage } from './protocol.ts';
import type { OpStore } from './store.ts';

export interface Connection {
  /** Feed a message received from the peer. */
  receive(msg: SyncMessage): void;
  /** Stop forwarding to this peer (socket closed). */
  close(): void;
}

/**
 * A participant in sync: holds a store and any number of connections, and forwards new ops
 * from one connection to all the others. Phones, the hub and server-side code all use this,
 * so a phone connected to both hub and cloud also bridges between them.
 */
export class SyncNode {
  readonly household: string;
  readonly store: OpStore;
  private readonly conns = new Set<(m: SyncMessage) => void>();
  private readonly listeners = new Set<(ops: Op[], source: 'local' | 'remote') => void>();
  private readonly now: () => number;

  constructor(household: string, store: OpStore, now: () => number = Date.now) {
    this.household = household;
    this.store = store;
    this.now = now;
  }

  onOps(listener: (ops: Op[], source: 'local' | 'remote') => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Attach a peer. `send` delivers a message to it. Sends the opening handshake. */
  connect(send: (m: SyncMessage) => void): Connection {
    this.conns.add(send);
    send(helloMessage(this.store, this.household));
    return {
      receive: (msg) => {
        if (!this.conns.has(send)) return;
        const added = handleMessage(this.store, msg, send, { household: this.household, now: this.now });
        if (added.length > 0) {
          this.forward(added, send);
          this.emit(added, 'remote');
        }
      },
      close: () => {
        this.conns.delete(send);
      },
    };
  }

  /** Store ops created on this node and send them to every peer. */
  publish(ops: Op[]): void {
    const added = ops.filter((op) => this.store.add(op) === 'added');
    if (added.length === 0) return;
    this.forward(added, null);
    this.emit(added, 'local');
  }

  private forward(ops: Op[], except: ((m: SyncMessage) => void) | null): void {
    for (const send of this.conns) if (send !== except) send({ t: 'ops', ops });
  }

  private emit(ops: Op[], source: 'local' | 'remote'): void {
    for (const l of this.listeners) l(ops, source);
  }
}

/** A device that also creates ops: a phone, tablet or the wall display. */
export class Replica extends SyncNode {
  readonly writer: OpWriter;

  constructor(household: string, device: string, store: OpStore, now: () => number = Date.now) {
    super(household, store, now);
    const clock = new HlcClock(device, now);
    for (const op of store.all()) clock.receive(op.hlc);
    this.writer = new OpWriter(household, device, clock, store.vector()[device] ?? 0);
    this.onOps((ops, source) => {
      if (source !== 'remote') return;
      for (const op of ops) {
        try {
          clock.receive(op.hlc);
        } catch (e) {
          if (!(e instanceof ClockDriftError)) throw e;
        }
      }
    });
  }

  commit(actor: string, body: OpBody): Op {
    const op = this.writer.write(actor, body);
    this.publish([op]);
    return op;
  }
}
