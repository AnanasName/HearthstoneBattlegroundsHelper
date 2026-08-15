import { describe, expect, it } from 'vitest';

import {
  centerWithinDecision,
  createRng,
  groupByDecision,
  mean,
  pairedDeltas,
  permuteWithinTier,
  rankWith,
  residualAfter,
  spearman,
  type DumpRow,
} from '../../../src/advisors/tavern/statAnalysis.js';

/**
 * Проверка САМОГО ИЗМЕРИТЕЛЯ на синтетике.
 *
 * Замер, который нечем проверить, — не замер: если конвейер находит сигнал
 * в чистом шуме или теряет подсаженный, любые его выводы бессмысленны.
 * Поэтому здесь два обязательных свойства (подсаженный сигнал находится,
 * шум — нет) и одно точное (парная разность на неизменившихся выборах
 * равна строго нулю, а не «нулю в пределах шума» — ради этого вся схема
 * с ранжированием и построена).
 */

function row(patch: Partial<DumpRow> & { fixture: string; turn: number; candIndex: number }): DumpRow {
  return {
    cardId: `CARD_${String(patch.candIndex)}`,
    name: 'карта',
    techLevel: 3,
    golden: false,
    isHeuristicPick: patch.candIndex === 0,
    score: 0,
    v: { total: 0 },
    outcome: 0,
    sims: 4000,
    stat: null,
    statGain: 0,
    ...patch,
  };
}

/** Синтетика: N ходов по 3 кандидата, исход зависит от statGain и шума. */
function synthetic(options: {
  readonly turns: number;
  readonly signal: number;
  readonly seed: number;
}): DumpRow[] {
  const rng = createRng(options.seed);
  const rows: DumpRow[] = [];
  for (let t = 0; t < options.turns; t += 1) {
    // Уровень хода: намеренно большой — центрирование внутри хода обязано
    // его снять, иначе связь утонет в разнице между ходами.
    const turnLevel = rng() * 80;
    for (let c = 0; c < 3; c += 1) {
      const total = 5 + rng() * 10;
      const statGain = rng() * 1.4 - 0.7;
      const noise = rng() * 10 - 5;
      rows.push(
        row({
          fixture: `part${String((t % 4) + 4)}`,
          turn: t * 2 + 1,
          candIndex: c,
          cardId: `CARD_${String(t)}_${String(c)}`,
          v: { total, techLevel: 6, stats: total - 6 },
          statGain,
          stat: { placement: 4, other: 4, impact: 0, residual: -statGain, totalPlayed: 10_000 },
          outcome: Math.max(0, Math.min(100, turnLevel + total + options.signal * statGain + noise)),
        }),
      );
    }
  }
  return rows;
}

describe('измеритель пользы статистики: проверка на синтетике', () => {
  it('подсаженный сигнал находится', () => {
    const rows = synthetic({ turns: 120, signal: 12, seed: 1 });
    const groups = groupByDecision(rows);

    const y = centerWithinDecision(groups, (r) => r.outcome);
    const g = centerWithinDecision(groups, (r) => r.statGain);
    const total = centerWithinDecision(groups, (r) => r.v['total'] ?? 0);
    const v1 = spearman(residualAfter(y, [total]), g);

    expect(v1).toBeGreaterThan(0.3);
  });

  it('в чистом шуме сигнала нет', () => {
    const rows = synthetic({ turns: 120, signal: 0, seed: 2 });
    const groups = groupByDecision(rows);

    const y = centerWithinDecision(groups, (r) => r.outcome);
    const g = centerWithinDecision(groups, (r) => r.statGain);
    const total = centerWithinDecision(groups, (r) => r.v['total'] ?? 0);
    const v1 = spearman(residualAfter(y, [total]), g);

    expect(Math.abs(v1)).toBeLessThan(0.15);
  });

  it('на неизменившихся выборах парная разность равна СТРОГО нулю', () => {
    // Ради этого свойства слагаемое и входит только в ранжирование:
    // борды кандидатов от веса не зависят, исходы взяты из одного дампа.
    const rows = synthetic({ turns: 60, signal: 5, seed: 3 });
    const groups = groupByDecision(rows);

    const base = rankWith(groups, 0);
    // Мизерный вес не может сменить ни одного выбора при разбросе total ~10.
    const tiny = rankWith(groups, 1e-9);
    expect(pairedDeltas(base, tiny).every((d) => d === 0)).toBe(true);

    // А заметный — меняет, и разность уже не тождественный ноль.
    const strong = rankWith(groups, 50);
    expect(pairedDeltas(base, strong).some((d) => d !== 0)).toBe(true);
  });

  it('λ=0 воспроизводит выбор эвристики точь-в-точь', () => {
    const rows = synthetic({ turns: 40, signal: 8, seed: 4 });
    const groups = groupByDecision(rows);
    const base = rankWith(groups, 0);

    // Эвристика берёт кандидата с максимальным total — это и есть её выбор.
    groups.forEach((group, i) => {
      const best = [...group.rows].sort((a, b) => (b.v['total'] ?? 0) - (a.v['total'] ?? 0))[0];
      expect(base.pickedCardId[i]).toBe(best?.cardId);
    });
  });

  it('перестановка внутри тира сохраняет тир и ломает карто-специфическое', () => {
    const rows: DumpRow[] = [
      row({ fixture: 'part4', turn: 1, candIndex: 0, cardId: 'A', techLevel: 2, statGain: 0.5 }),
      row({ fixture: 'part4', turn: 1, candIndex: 1, cardId: 'B', techLevel: 2, statGain: -0.5 }),
      row({ fixture: 'part4', turn: 3, candIndex: 0, cardId: 'C', techLevel: 5, statGain: 0.2 }),
      row({ fixture: 'part4', turn: 3, candIndex: 1, cardId: 'D', techLevel: 5, statGain: -0.2 }),
    ];
    const permuted = permuteWithinTier(rows, createRng(9));

    // Значения остались в своём тире: множества совпадают потирно.
    const tier2 = rows.filter((r) => r.techLevel === 2).map(permuted).sort((a, b) => a - b);
    const tier5 = rows.filter((r) => r.techLevel === 5).map(permuted).sort((a, b) => a - b);
    expect(tier2).toEqual([-0.5, 0.5]);
    expect(tier5).toEqual([-0.2, 0.2]);
  });

  it('одна карта получает одно значение во всех ходах, где встречается', () => {
    // Перестановка на уровне КАРТ, а не строк: иначе нуль занижен.
    const rows: DumpRow[] = [
      row({ fixture: 'part4', turn: 1, candIndex: 0, cardId: 'A', techLevel: 3, statGain: 0.4 }),
      row({ fixture: 'part4', turn: 3, candIndex: 0, cardId: 'A', techLevel: 3, statGain: 0.4 }),
      row({ fixture: 'part4', turn: 5, candIndex: 0, cardId: 'B', techLevel: 3, statGain: -0.4 }),
    ];
    const permuted = permuteWithinTier(rows, createRng(11));
    expect(permuted(rows[0] as DumpRow)).toBe(permuted(rows[1] as DumpRow));
  });

  it('среднее парных разностей — это и есть сдвиг средней цены', () => {
    const rows = synthetic({ turns: 50, signal: 6, seed: 5 });
    const groups = groupByDecision(rows);
    const base = rankWith(groups, 0);
    const other = rankWith(groups, 30);

    // cost(0) − cost(λ) обязано совпасть со средней парной разностью:
    // лучший исход хода один и тот же, он сокращается.
    const direct = base.averageCost - other.averageCost;
    expect(mean(pairedDeltas(base, other))).toBeCloseTo(direct, 10);
  });
});
