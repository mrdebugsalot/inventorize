/**
 * Hybrid logical clock (HLC).
 *
 * Every operation is stamped with an HLC string. The encoding has fixed width, so plain
 * string comparison gives the same order on every device: wall-clock time, then a counter
 * for events in the same millisecond, then the node id as a deterministic tie-break.
 *
 * Format: <wall ms, base36, 11 chars>:<counter, base36, 4 chars>:<node id>
 */

export type Hlc = string;

const WALL_LEN = 11;
const COUNTER_LEN = 4;
const MAX_COUNTER = 36 ** COUNTER_LEN - 1;

/** Operations stamped further than this into the future are rejected (§6.2 of PLAN.md). */
export const MAX_FUTURE_DRIFT_MS = 24 * 60 * 60 * 1000;

export interface HlcParts {
  wall: number;
  counter: number;
  node: string;
}

export function encodeHlc({ wall, counter, node }: HlcParts): Hlc {
  return `${wall.toString(36).padStart(WALL_LEN, '0')}:${counter
    .toString(36)
    .padStart(COUNTER_LEN, '0')}:${node}`;
}

export function decodeHlc(hlc: Hlc): HlcParts {
  const first = hlc.indexOf(':');
  const second = hlc.indexOf(':', first + 1);
  if (first !== WALL_LEN || second !== WALL_LEN + 1 + COUNTER_LEN) {
    throw new Error(`Malformed HLC: ${hlc}`);
  }
  const wall = parseInt(hlc.slice(0, first), 36);
  const counter = parseInt(hlc.slice(first + 1, second), 36);
  const node = hlc.slice(second + 1);
  if (!Number.isFinite(wall) || !Number.isFinite(counter) || node.length === 0) {
    throw new Error(`Malformed HLC: ${hlc}`);
  }
  return { wall, counter, node };
}

export function isValidHlc(hlc: unknown): hlc is Hlc {
  if (typeof hlc !== 'string') return false;
  try {
    decodeHlc(hlc);
    return true;
  } catch {
    return false;
  }
}

export function compareHlc(a: Hlc, b: Hlc): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isTooFarInFuture(hlc: Hlc, now: number = Date.now()): boolean {
  return decodeHlc(hlc).wall > now + MAX_FUTURE_DRIFT_MS;
}

export class ClockDriftError extends Error {}

export class HlcClock {
  readonly node: string;
  private readonly now: () => number;
  private wall = 0;
  private counter = 0;

  constructor(node: string, now: () => number = Date.now) {
    if (node.length === 0) throw new Error('HLC node id must not be empty');
    this.node = node;
    this.now = now;
  }

  /** Timestamp for a new local event. */
  tick(): Hlc {
    const t = this.now();
    if (t > this.wall) {
      this.wall = t;
      this.counter = 0;
    } else {
      this.bumpCounter(this.counter + 1);
    }
    return this.current();
  }

  /** Merge a timestamp seen on a remote event, so later local events sort after it. */
  receive(remote: Hlc): void {
    const r = decodeHlc(remote);
    const t = this.now();
    if (r.wall > t + MAX_FUTURE_DRIFT_MS) {
      throw new ClockDriftError(`Remote clock too far ahead: ${remote}`);
    }
    const wall = Math.max(t, this.wall, r.wall);
    if (wall === this.wall && wall === r.wall) {
      this.bumpCounter(Math.max(this.counter, r.counter) + 1);
    } else if (wall === this.wall) {
      this.bumpCounter(this.counter + 1);
    } else if (wall === r.wall) {
      this.bumpCounter(r.counter + 1);
    } else {
      this.counter = 0;
    }
    this.wall = wall;
  }

  current(): Hlc {
    return encodeHlc({ wall: this.wall, counter: this.counter, node: this.node });
  }

  private bumpCounter(next: number): void {
    if (next > MAX_COUNTER) throw new ClockDriftError('HLC counter overflow');
    this.counter = next;
  }
}
