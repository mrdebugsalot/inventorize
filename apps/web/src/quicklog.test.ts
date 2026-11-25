import { describe, expect, it } from 'vitest';
import { findByName, parseQuickLog } from './quicklog.ts';

describe('parseQuickLog', () => {
  it.each([
    ['2 milk', { kind: 'adjust', name: 'milk', delta: 2 }],
    ['+6 eggs', { kind: 'adjust', name: 'eggs', delta: 6 }],
    ['-1 bread', { kind: 'adjust', name: 'bread', delta: -1 }],
    ['3x paper towels', { kind: 'adjust', name: 'paper towels', delta: 3 }],
    ['milk +2', { kind: 'adjust', name: 'milk', delta: 2 }],
    ['olive oil -0.5', { kind: 'adjust', name: 'olive oil', delta: -0.5 }],
    ['used dish soap', { kind: 'adjust', name: 'dish soap', delta: -1 }],
    ['Used 2 eggs', { kind: 'adjust', name: 'eggs', delta: -2 }],
    ['out of rice', { kind: 'set', name: 'rice', qty: 0 }],
    ['coffee is out', { kind: 'set', name: 'coffee', qty: 0 }],
    ['milk = 4', { kind: 'set', name: 'milk', qty: 4 }],
    ['set flour=2', { kind: 'set', name: 'flour', qty: 2 }],
    ['batteries', { kind: 'adjust', name: 'batteries', delta: 1 }],
    ['  7up  ', { kind: 'adjust', name: '7up', delta: 1 }],
  ])('%s', (input, expected) => {
    expect(parseQuickLog(input)).toEqual(expected);
  });

  it('ignores empty input', () => {
    expect(parseQuickLog('   ')).toBeNull();
  });
});

describe('findByName', () => {
  const items = [{ name: 'Egg' }, { name: 'Paper towels' }, { name: 'Berries' }, { name: 'Glass' }];
  it('matches ignoring case and simple plurals', () => {
    expect(findByName(items, 'eggs')?.name).toBe('Egg');
    expect(findByName(items, 'paper towel')?.name).toBe('Paper towels');
    expect(findByName(items, 'berry')?.name).toBe('Berries');
    expect(findByName(items, 'glass')?.name).toBe('Glass');
    expect(findByName(items, 'milk')).toBeUndefined();
  });
});
