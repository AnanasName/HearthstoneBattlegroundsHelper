import { beforeAll, describe, expect, it } from 'vitest';

import { readBattleEpisodes, type BattleEpisode } from '../../../src/advisors/battle/episodes.js';
import { toBattleInfo, withPlayerBoard } from '../../../src/advisors/battle/mapper.js';
import { createBattleSimulator, type BattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { advisePosition } from '../../../src/advisors/position/advisor.js';
import { withSeededRandom } from '../../../src/advisors/position/rng.js';
import type { Minion } from '../../../src/state/types.js';
import { part3Game } from '../../fixtures.js';

/**
 * DoD фазы 3 в измеримой форме.
 *
 * ТЗ: «на fixture-состоянии с заведомо важной позицией советник находит
 * расстановку не хуже той, что была сыграна фактически».
 *
 * Взят бой part3 на ходу 8. Позиция там важна не по мнению, а по замеру:
 * доля побед по всем 720 расстановкам идёт от 19% до 69%, то есть перестановка
 * решает исход боя целиком (`npm run spike:position`).
 *
 * Сравнение идёт не по оценке самого поиска — она была бы и судьёй, и
 * подсудимым, — а по отдельному прогону увеличенным числом симуляций.
 */

/** Проверочный прогон: втрое больше симуляций, чем тратит финал поиска. */
const VERIFY_SIMS = 4000;
/** Зерно проверки фиксировано, иначе тест мигал бы на границе. */
const VERIFY_SEED = 20260812;

describe('советник расстановки на фикстурах', () => {
  let simulator: BattleSimulator;
  let episodes: BattleEpisode[];

  beforeAll(() => {
    simulator = createBattleSimulator();
    episodes = readBattleEpisodes(part3Game());
  }, 120_000);

  const episodeOn = (turn: number): BattleEpisode => {
    const found = episodes.find((e) => e.turn === turn);
    if (found === undefined) throw new Error(`в part3 нет боя на ходу ${String(turn)}`);
    return found;
  };

  const trueWinPercent = (episode: BattleEpisode, board: readonly Minion[]): number =>
    withSeededRandom(
      VERIFY_SEED,
      () => simulator.run(withPlayerBoard(toBattleInfo(episode, 1), board), VERIFY_SIMS).wonPercent,
    );

  it(
    'на бою с решающей позицией совет не хуже сыгранного',
    () => {
      const episode = episodeOn(8);
      const advice = advisePosition(episode, { simulator });
      const recommended = advice.top[0];
      expect(recommended).toBeDefined();

      const asPlayed = trueWinPercent(episode, episode.playerBoard);
      const asAdvised = trueWinPercent(episode, recommended?.board ?? episode.playerBoard);

      expect(asAdvised).toBeGreaterThanOrEqual(asPlayed);
      // Фактически выигрыш около 17 п.п.; порог с запасом, чтобы тест ловил
      // поломку поиска, а не дрожание метода Монте-Карло.
      expect(asAdvised - asPlayed).toBeGreaterThan(5);
      expect(advice.improves).toBe(true);
    },
    180_000,
  );

  it(
    'совет по борду из семи миньонов укладывается в бюджет ТЗ',
    () => {
      const episode = episodeOn(12);
      expect(episode.playerBoard).toHaveLength(7);

      const advice = advisePosition(episode, { simulator });

      // 5040 расстановок целиком не перебираются — это заявлено, а не скрыто.
      expect(advice.report.space.distinct).toBe(5040);
      expect(advice.report.exhaustive).toBe(false);
      expect(advice.elapsedMs).toBeLessThan(10_000);
    },
    180_000,
  );

  it(
    'маленький борд перебирается целиком',
    () => {
      const episode = episodeOn(6);
      const advice = advisePosition(episode, { simulator });

      expect(advice.report.space.distinct).toBeLessThanOrEqual(24);
      expect(advice.report.exhaustive).toBe(true);
      expect(advice.report.evaluated).toBe(advice.report.space.distinct);
    },
    120_000,
  );

  it(
    'финалисты и текущая расстановка досчитаны до полной точности',
    () => {
      const episode = episodeOn(8);
      const advice = advisePosition(episode, { simulator });

      // Точное число зависит от того, насколько финал пришлось сжать под
      // бюджет, но победитель обязан быть измерен на порядок точнее отбора.
      const screened = advice.report.simulations / advice.report.evaluated;
      expect(advice.top[0]?.estimate.sims ?? 0).toBeGreaterThan(1000);
      expect(advice.top[0]?.estimate.sims ?? 0).toBeGreaterThan(4 * screened);
      expect(advice.current.estimate.sims).toBeGreaterThan(1000);
    },
    180_000,
  );

  it(
    'без ограничения по времени один и тот же вход даёт один и тот же совет',
    () => {
      // Воспроизводимость ограничена ровно одним: пока поиск режется бюджетом
      // в миллисекундах, число просмотренных кандидатов зависит от загрузки
      // машины, и совет может отличаться. Со снятым ограничением по времени
      // — а его ограничивает потолок кандидатов — вход определяет ответ
      // полностью. Это и есть то свойство, которым пользуется разбор жалоб.
      const episode = episodeOn(8);
      const fixed = { seed: 5, maxCandidates: 60, screenBudgetMs: Infinity, budgetMs: Infinity };
      const first = advisePosition(episode, { simulator }, fixed);
      const second = advisePosition(episode, { simulator }, fixed);

      expect(first.report.evaluated).toBe(60);
      expect(first.top[0]?.key).toBe(second.top[0]?.key);
      expect(first.report.simulations).toBe(second.report.simulations);
    },
    240_000,
  );
});
