import { describe, expect, it } from 'vitest';

import { mulberry32, withSeededRandom } from '../../../src/advisors/position/rng.js';

describe('детерминированная случайность', () => {
  it('одно зерно даёт одну и ту же последовательность', () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const first = Array.from({ length: 20 }, () => a());
    const second = Array.from({ length: 20 }, () => b());
    expect(first).toEqual(second);
  });

  it('разные зёрна дают разные последовательности', () => {
    const a = Array.from({ length: 20 }, mulberry32(1));
    const b = Array.from({ length: 20 }, mulberry32(2));
    expect(a).not.toEqual(b);
  });

  it('значения лежат в [0, 1) и не вырождаются', () => {
    const next = mulberry32(7);
    const values = Array.from({ length: 5000 }, next);
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // Половина бросков решает, кто бьёт первым, поэтому перекос у самой
    // середины отрезка испортил бы оценку сильнее любой другой неравномерности.
    const half = values.filter((v) => v < 0.5).length / values.length;
    expect(Math.abs(half - 0.5)).toBeLessThan(0.03);
    expect(new Set(values).size).toBeGreaterThan(4900);
  });

  it('подменяет Math.random внутри и возвращает исходный после', () => {
    const original = Math.random;

    const inside = withSeededRandom(123, () => [Math.random(), Math.random()]);
    expect(Math.random).toBe(original);
    expect(inside).not.toEqual([]);

    // Внутри работает ровно тот же поток, что даёт mulberry32 с этим зерном.
    const expected = mulberry32(123);
    expect(inside).toEqual([expected(), expected()]);
  });

  it('возвращает Math.random даже когда внутри бросили исключение', () => {
    const original = Math.random;
    expect(() =>
      withSeededRandom(1, () => {
        throw new Error('симулятор упал');
      }),
    ).toThrow('симулятор упал');
    expect(Math.random).toBe(original);
  });

  it('под одним зерном два одинаковых прогона совпадают до последнего броска', () => {
    const roll = (): number[] =>
      withSeededRandom(999, () => Array.from({ length: 50 }, () => Math.random()));
    expect(roll()).toEqual(roll());
  });
});
