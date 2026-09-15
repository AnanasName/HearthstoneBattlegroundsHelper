import { describe, expect, it } from 'vitest';

import { DEFAULT_SEED, partsArg, positionalArgs, seedArg } from '../../src/measure/args.js';

describe('аргументы замеров', () => {
  const all = [4, 5, 6, 7, 30, 31, 32, 44];

  it('без флагов — зерно по умолчанию и весь список', () => {
    expect(seedArg([])).toBe(DEFAULT_SEED);
    expect(partsArg([], all)).toBe(all);
  });

  it('номера и диапазоны, в порядке общего списка', () => {
    expect(partsArg(['--parts=31,4-6'], all)).toEqual([4, 5, 6, 31]);
  });

  it('номер вне списка не добавляется', () => {
    expect(partsArg(['--parts=4,99'], all)).toEqual([4]);
  });

  it('мусор в аргументах — ошибка, а не молчаливый весь список', () => {
    expect(() => partsArg(['--parts=четыре'], all)).toThrow();
    expect(() => seedArg(['--seed=1.5'])).toThrow();
  });

  it('позиционные аргументы отделяются от флагов', () => {
    expect(positionalArgs(['data/a.log', '--seed=3', 'data/b.log'])).toEqual(['data/a.log', 'data/b.log']);
  });
});
