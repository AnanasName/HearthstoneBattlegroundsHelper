import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodes, type BattleEpisode } from '../../src/advisors/battle/episodes.js';
import { toBattleInfo } from '../../src/advisors/battle/mapper.js';
import { createBattleSimulator } from '../../src/advisors/battle/simulator.js';
import { part2Game, part3Game } from '../fixtures.js';

/**
 * Регрессия на качество предсказаний.
 *
 * Пороги намеренно мягче фактических значений — тест ловит поломку маппинга,
 * а не сторожит конкретные цифры. Актуальные числа печатает `npm run calibrate`.
 *
 * Симуляций здесь меньше, чем в боевом режиме: 500 хватает, чтобы поймать
 * систематическую ошибку, и не превращает прогон тестов в минутный.
 */
const SIMULATIONS = 500;

interface Row {
  episode: BattleEpisode;
  wonPercent: number;
  actualProbability: number;
}

describe('калибровка симулятора на боях с известным исходом', () => {
  let rows: Row[] = [];

  beforeAll(() => {
    const simulator = createBattleSimulator();

    rows = [];
    for (const text of [part2Game(), part3Game()]) {
      for (const episode of readBattleEpisodes(text)) {
        const r = simulator.run(toBattleInfo(episode, SIMULATIONS));

        const actualProbability =
          episode.outcome === 'won'
            ? r.wonPercent / 100
            : episode.outcome === 'lost'
              ? r.lostPercent / 100
              : r.tiedPercent / 100;

        rows.push({ episode, wonPercent: r.wonPercent / 100, actualProbability });
      }
    }
  }, 120_000);

  it('из фикстур извлекается достаточно боёв с известным исходом', () => {
    expect(rows.length).toBeGreaterThanOrEqual(15);
  });

  it('у каждого боя есть оба борда', () => {
    for (const r of rows) {
      expect(r.episode.playerBoard.length).toBeGreaterThan(0);
      expect(r.episode.opponentBoard.length).toBeGreaterThan(0);
    }
  });

  it('предсказания калиброваны: средняя вероятность победы близка к фактической доле', () => {
    const actual = rows.filter((r) => r.episode.outcome === 'won').length / rows.length;
    const mean = rows.reduce((s, r) => s + r.wonPercent, 0) / rows.length;
    // Фактически около 4 п.п.; порог с большим запасом.
    expect(Math.abs(mean - actual)).toBeLessThan(0.15);
  });

  it('Brier score заметно лучше, чем у предсказателя «всегда 50%»', () => {
    const brier =
      rows.reduce((s, r) => {
        const actual = r.episode.outcome === 'won' ? 1 : 0;
        return s + (r.wonPercent - actual) ** 2;
      }, 0) / rows.length;
    // Фактически около 0.02, «всегда 50%» дало бы 0.25.
    expect(brier).toBeLessThan(0.15);
  });

  it('фактический исход почти никогда не оказывается выбросом', () => {
    // Это и есть DoD фазы 2 из ТЗ, переведённый в измеримую форму.
    const outliers = rows.filter((r) => r.actualProbability < 0.05);
    expect(outliers.length).toBeLessThanOrEqual(3);
  });
});
