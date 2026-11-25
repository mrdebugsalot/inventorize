/**
 * Quick-log parser (PLAN.md §3.1): turns phrases like "2 milk", "used eggs" or
 * "out of rice" into an inventory action. Anything unrecognised means "+1 of this".
 */

export type QuickLog =
  | { kind: 'adjust'; name: string; delta: number }
  | { kind: 'set'; name: string; qty: number };

const NUM = '(\\d+(?:\\.\\d+)?)';
const USED = '(?:used|use|finished|ate|drank|took)';

export function parseQuickLog(input: string): QuickLog | null {
  const s = input.trim().replace(/\s+/g, ' ');
  if (!s) return null;
  let m: RegExpMatchArray | null;

  if ((m = s.match(/^(?:out of|no more|no) (.+)$/i))) return { kind: 'set', name: m[1]!, qty: 0 };
  if ((m = s.match(/^(.+?) (?:is |are )?(?:out|gone|finished)$/i))) return { kind: 'set', name: m[1]!, qty: 0 };
  if ((m = s.match(new RegExp(`^(?:set )?(.+?) ?= ?${NUM}$`, 'i')))) return { kind: 'set', name: m[1]!, qty: Number(m[2]) };
  if ((m = s.match(new RegExp(`^${USED} (?:${NUM} )?(.+)$`, 'i')))) {
    return { kind: 'adjust', name: m[2]!, delta: -(m[1] ? Number(m[1]) : 1) };
  }
  if ((m = s.match(new RegExp(`^([+-])? ?${NUM}(?: ?x)? (.+)$`, 'i')))) {
    const n = Number(m[2]);
    return { kind: 'adjust', name: m[3]!, delta: m[1] === '-' ? -n : n };
  }
  if ((m = s.match(new RegExp(`^(.+?) ?([+-]) ?${NUM}$`, 'i')))) {
    const n = Number(m[3]);
    return { kind: 'adjust', name: m[1]!, delta: m[2] === '-' ? -n : n };
  }
  return { kind: 'adjust', name: s, delta: 1 };
}

/** Case- and plural-insensitive key, so "Eggs" matches "egg". */
export function nameKey(name: string): string {
  const n = name.trim().toLowerCase();
  if (n.endsWith('ies') && n.length > 4) return `${n.slice(0, -3)}y`;
  if (n.endsWith('oes') && n.length > 4) return n.slice(0, -2);
  if (n.endsWith('s') && !n.endsWith('ss') && n.length > 3) return n.slice(0, -1);
  return n;
}

export function findByName<T extends { name: string }>(items: readonly T[], name: string): T | undefined {
  const key = nameKey(name);
  return items.find((i) => nameKey(i.name) === key);
}

export const displayName = (name: string): string => {
  const t = name.trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
};
