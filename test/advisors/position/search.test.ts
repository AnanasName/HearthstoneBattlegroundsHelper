import { describe, expect, it } from 'vitest';

import { mulberry32 } from '../../../src/advisors/position/rng.js';
import type { Estimate } from '../../../src/advisors/position/score.js';
import { winRate } from '../../../src/advisors/position/score.js';
import { searchArrangement, type Evaluate } from '../../../src/advisors/position/search.js';
import type { Minion } from '../../../src/state/types.js';
import { board } from '../../minions.js';

/**
 * Поиск проверяется на подставном оценщике с заранее известным оптимумом.
 *
 * Через симулятор это было бы непроверяемо: правильный ответ там неизвестен,
 * и упавший тест не отличил бы ошибку в алгоритме от неточности маппинга.
 * Здесь ландшафт задан руками — лучшая расстановка известна до запуска.
 */



/**
 * Ландшафт: чем ближе порядок к возрастанию entityId, тем выше доля побед.
 *
 * Мера близости — число инверсий. Оптимум единственный (строгое возрастание),
 * а соседние по обмену расстановки отличаются понемногу, то есть ландшафт
 * такой же, как у настоящей задачи: без обрывов, но и без единственного
 * очевидного направления.
 */
function inversions(b: readonly Minion[]): number {
  let count = 0;
  for (let i = 0; i < b.length; i += 1) {
    for (let j = i + 1; j < b.length; j += 1) {
      if ((b[i]?.entityId ?? 0) > (b[j]?.entityId ?? 0)) count += 1;
    }
  }
  return count;
}

function trueWinRate(b: readonly Minion[]): number {
  const max = (b.length * (b.length - 1)) / 2;
  return max === 0 ? 0.5 : 0.95 - 0.9 * (inversions(b) / max);
}

/** Оценщик без шума: считает ровно то, что задумано ландшафтом. */
const exact: Evaluate = (b, sims) => {
  const won = Math.round(trueWinRate(b) * sims);
  return { sims, won, tied: 0, lost: sims - won, wonLethal: 0, lostLethal: 0, damageWon: won * 5, damageLost: (sims - won) * 5 };
};

/** Оценщик с настоящим биномиальным шумом — как у симулятора. */
const noisy: Evaluate = (b, sims, seed) => {
  const p = trueWinRate(b);
  const random = mulberry32(seed);
  let won = 0;
  for (let i = 0; i < sims; i += 1) if (random() < p) won += 1;
  return { sims, won, tied: 0, lost: sims - won, wonLethal: 0, lostLethal: 0, damageWon: won * 5, damageLost: (sims - won) * 5 };
};

/** Оценщик, для которого все расстановки одинаковы. */
const flat: Evaluate = (_board, sims, seed) => {
  const random = mulberry32(seed);
  let won = 0;
  for (let i = 0; i < sims; i += 1) if (random() < 0.5) won += 1;
  return { sims, won, tied: 0, lost: sims - won, wonLethal: 0, lostLethal: 0, damageWon: 0, damageLost: 0 };
};

function counting(inner: Evaluate): { evaluate: Evaluate; calls: number[]; sims: () => number } {
  const calls: number[] = [];
  const evaluate: Evaluate = (b, sims, seed) => {
    calls.push(sims);
    return inner(b, sims, seed);
  };
  return { evaluate, calls, sims: () => calls.reduce((a, c) => a + c, 0) };
}

const ids = (e: readonly Minion[]): number[] => e.map((m) => m.entityId);

describe('поиск расстановки', () => {
  it('маленький борд перебирается целиком и оптимум находится точно', () => {
    const start = board([4, 3, 2, 1]);
    const report = searchArrangement(start, exact);

    expect(report.exhaustive).toBe(true);
    expect(report.space.distinct).toBe(24);
    expect(report.evaluated).toBe(24);
    expect(ids(report.top[0]?.board ?? [])).toEqual([1, 2, 3, 4]);
  });

  it('большой борд перебирается не целиком, но оптимум всё равно находится', () => {
    const start = board([7, 6, 5, 4, 3, 2, 1]);
    const report = searchArrangement(start, exact);

    expect(report.exhaustive).toBe(false);
    expect(report.space.distinct).toBe(5040);
    expect(report.evaluated).toBeLessThanOrEqual(200);
    expect(ids(report.top[0]?.board ?? [])).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('под биномиальным шумом находится расстановка около оптимума', () => {
    const start = board([7, 6, 5, 4, 3, 2, 1]);
    const report = searchArrangement(start, noisy, { seed: 20260812 });

    const best = report.top[0]?.board ?? [];
    // Не требуем точного попадания: при 150 симуляциях отбора шум сравним
    // с шагом ландшафта. Требуем, чтобы результат был близок к оптимуму
    // и заведомо лучше исходных семи инверсий из двадцати одной.
    expect(inversions(best)).toBeLessThanOrEqual(3);
    expect(inversions(best)).toBeLessThan(inversions(report.current.board));
  });

  it('исходная расстановка всегда оценена и попадает в отчёт', () => {
    const start = board([3, 1, 2]);
    const report = searchArrangement(start, exact);

    expect(ids(report.current.board)).toEqual([3, 1, 2]);
    expect(report.current.estimate.sims).toBeGreaterThan(0);
    expect(report.top.map((c) => c.key)).toContain(report.current.key);
  });

  it('финалисты досчитаны точнее отсеянных, и счётчики накапливаются', () => {
    const start = board([7, 6, 5, 4, 3, 2, 1]);
    const { evaluate, calls } = counting(exact);
    const report = searchArrangement(start, evaluate, {
      screenSims: 100,
      finalRounds: [
        { keep: 4, sims: 400 },
        { keep: 2, sims: 1000 },
      ],
    });

    // Отбор идёт сотнями, финал — сотнями и тысячами.
    expect(calls.filter((n) => n === 100).length).toBe(report.evaluated);
    expect(calls).toContain(400);
    expect(calls).toContain(1000);

    // У победителя за спиной все раунды сразу: 100 + 400 + 1000.
    expect(report.top[0]?.estimate.sims).toBe(1500);
    // И оценка у него точнее, чем у любого просто отобранного.
    expect(report.top[0]?.estimate.sims).toBeGreaterThan(100);
  });

  it('текущая расстановка досчитывается до той же точности, даже будучи плохой', () => {
    // Худшая из возможных — в финал по очкам она не попала бы никогда.
    const start = board([7, 6, 5, 4, 3, 2, 1]);
    const report = searchArrangement(start, exact, {
      finalRounds: [{ keep: 1, sims: 900 }],
    });

    expect(report.current.key).not.toBe(report.top[0]?.key);
    expect(report.current.estimate.sims).toBe(150 + 900);
  });

  it('одинаковый вход даёт одинаковый совет', () => {
    const start = board([5, 2, 7, 1, 3]);
    const first = searchArrangement(start, noisy, { seed: 7 });
    const second = searchArrangement(start, noisy, { seed: 7 });

    expect(first.top.map((c) => c.key)).toEqual(second.top.map((c) => c.key));
    expect(first.simulations).toBe(second.simulations);
  });

  it('повторные оценки одного кандидата берут разные потоки случайности', () => {
    const seeds: number[] = [];
    const evaluate: Evaluate = (b, sims, seed) => {
      seeds.push(seed);
      return noisy(b, sims, seed);
    };
    searchArrangement(board([2, 1]), evaluate);
    // Иначе накопление симуляций не добавляло бы ни бита: тот же поток
    // случайности дал бы тот же результат.
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('на ровном ландшафте не выдумывает победителя', () => {
    const start = board([4, 3, 2, 1]);
    const report = searchArrangement(start, flat, { seed: 3 });

    const best = report.top[0];
    expect(best).toBeDefined();
    // Все расстановки равны, значит разброс долей побед должен остаться
    // в пределах шума — иначе поиск где-то теряет накопленные симуляции.
    for (const candidate of report.top) {
      expect(Math.abs(winRate(candidate.estimate) - 0.5)).toBeLessThan(0.1);
    }
  });

  it('борд из одного миньона не порождает работы', () => {
    const report = searchArrangement(board([1]), exact);
    expect(report.space.distinct).toBe(1);
    expect(report.evaluated).toBe(1);
    expect(report.exhaustive).toBe(true);
  });

  it('потолок кандидатов соблюдается', () => {
    const start = board([7, 6, 5, 4, 3, 2, 1]);
    const report = searchArrangement(start, exact, { maxCandidates: 40 });
    expect(report.evaluated).toBeLessThanOrEqual(40);
  });

  it('цель поиска меняет ответ', () => {
    // Ландшафт, где чаще выигрывает один порядок, а меньше урона получает другой.
    const wins = board([1, 2, 3, 4]);
    const evaluate: Evaluate = (b, sims): Estimate => {
      const ascending = ids(b).join(',') === ids(wins).join(',');
      const descending = ids(b).join(',') === [...ids(wins)].reverse().join(',');
      const won = ascending ? Math.round(sims * 0.6) : descending ? Math.round(sims * 0.4) : Math.round(sims * 0.3);
      const lost = sims - won;
      return {
        sims,
        won,
        tied: 0,
        lost,
        wonLethal: 0,
        lostLethal: 0,
        damageWon: won * 2,
        // Порядок по убыванию проигрывает реже, но каждый его проигрыш дороже.
        damageLost: lost * (ascending ? 30 : descending ? 1 : 20),
      };
    };

    const start = board([2, 1, 4, 3]);
    const byWins = searchArrangement(start, evaluate, { objective: 'winRate' });
    const byDamage = searchArrangement(start, evaluate, { objective: 'netDamage' });

    expect(ids(byWins.top[0]?.board ?? [])).toEqual([1, 2, 3, 4]);
    expect(ids(byDamage.top[0]?.board ?? [])).toEqual([4, 3, 2, 1]);
  });
});
