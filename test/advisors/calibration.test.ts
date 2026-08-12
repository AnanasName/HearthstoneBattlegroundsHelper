import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodes, type BattleEpisode } from '../../src/advisors/battle/episodes.js';
import { toBattleInfo } from '../../src/advisors/battle/mapper.js';
import { createBattleSimulator } from '../../src/advisors/battle/simulator.js';
import { part4Game } from '../fixtures.js';

/**
 * Регрессия на качество предсказаний.
 *
 * Пороги намеренно мягче фактических значений — тест ловит поломку маппинга,
 * а не сторожит конкретные цифры. Актуальные числа печатает `npm run calibrate`.
 *
 * Симуляций здесь меньше, чем в боевом режиме: 500 хватает, чтобы поймать
 * систематическую ошибку, и не превращает прогон тестов в минутный.
 *
 * ## Почему только партия текущего патча
 *
 * Раньше здесь были обе полные фикстуры, и это стало неверным 13.08, когда
 * обновились карты и симулятор: на партиях билда 246003 расхождение выросло
 * с 3.9 до 9.0 п.п., хотя ни парсер, ни маппер не менялись. Игра поменялась,
 * а записанный исход относится к тому билду, при котором партия сыграна.
 * Старые фикстуры остаются годными для проверки РАЗБОРА лога — и там они
 * и работают, — но калибровать по ним предсказания больше нельзя.
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
    for (const text of [part4Game()]) {
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

  it('из фикстуры извлекается достаточно боёв с известным исходом', () => {
    // Партия оборвалась на восьмом бою — игрок выбыл. Это не мало
    // для проверки на грубую ошибку, но мало для точных чисел, и порог
    // тут именно про «бои вообще извлекаются».
    expect(rows.length).toBeGreaterThanOrEqual(8);
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
    // Фактически 0.2 п.п. на партии своего патча; порог с большим запасом.
    expect(Math.abs(mean - actual)).toBeLessThan(0.15);
  });

  it('Brier score заметно лучше, чем у предсказателя «всегда 50%»', () => {
    const brier =
      rows.reduce((s, r) => {
        const actual = r.episode.outcome === 'won' ? 1 : 0;
        return s + (r.wonPercent - actual) ** 2;
      }, 0) / rows.length;
    // Фактически около 0.001, «всегда 50%» дало бы 0.25.
    expect(brier).toBeLessThan(0.15);
  });

  it('фактический исход почти никогда не оказывается выбросом', () => {
    // Это и есть DoD фазы 2 из ТЗ, переведённый в измеримую форму.
    const outliers = rows.filter((r) => r.actualProbability < 0.05);
    expect(outliers.length).toBeLessThanOrEqual(3);
  });
});
