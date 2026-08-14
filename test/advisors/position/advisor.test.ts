import { beforeAll, describe, expect, it } from 'vitest';

import type { BgsBattleInfo } from '@firestone-hs/simulate-bgs-battle/dist/bgs-battle-info.js';
import type { SimulationResult } from '@firestone-hs/simulate-bgs-battle/dist/simulation-result.js';

import { readBattleEpisodes, type BattleEpisode } from '../../../src/advisors/battle/episodes.js';
import { toBattleInfo, withPlayerBoard, type BattleSetup } from '../../../src/advisors/battle/mapper.js';
import { createBattleSimulator, type BattleSimulator } from '../../../src/advisors/battle/simulator.js';
import { advisePosition, positionQuestion } from '../../../src/advisors/position/advisor.js';
import { withSeededRandom } from '../../../src/advisors/position/rng.js';
import { winRate } from '../../../src/advisors/position/score.js';
import {
  EMPTY_GLOBAL_INFO,
  EMPTY_STATE,
  type GameState,
  type Minion,
} from '../../../src/state/types.js';
import { board } from '../../minions.js';
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
    'поле из двух бордов: тот же вход — тот же совет',
    () => {
      // Зёрна поля выводятся иначе, чем у одиночной цели (у каждого борда
      // своё), поэтому воспроизводимость проверяется отдельно.
      const e6 = episodeOn(6);
      const e8 = episodeOn(8);
      const setups = [e6, { ...e6, opponentBoard: e8.opponentBoard }];
      const fixed = { seed: 5, maxCandidates: 30, screenBudgetMs: Infinity, budgetMs: Infinity };

      const first = advisePosition(setups, { simulator }, fixed);
      const second = advisePosition(setups, { simulator }, fixed);

      expect(first.top[0]?.key).toBe(second.top[0]?.key);
      expect(first.report.simulations).toBe(second.report.simulations);
    },
    240_000,
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

/**
 * Механика счёта против поля — на подставном симуляторе.
 *
 * Настоящий симулятор здесь мешал бы: проверяется не качество боя, а арифметика
 * поля — что оценка стала средним по бордам, что симуляции разделены поровну
 * и что лучшим признаётся лучший В СРЕДНЕМ, а не против одного из бордов.
 */
describe('счёт против поля из нескольких бордов', () => {
  interface FakeCall {
    readonly opponent: number;
    readonly sims: number;
  }

  /** Симулятор с заданной долей побед по (первый свой миньон, борд противника). */
  const fakeSimulator = (
    winOf: (playerFirst: number, opponentFirst: number) => number,
    calls: FakeCall[] = [],
  ): BattleSimulator =>
    ({
      run: (input: BgsBattleInfo, sims = 0): SimulationResult => {
        const playerFirst = input.playerBoard.board[0]?.entityId ?? 0;
        const opponentFirst = input.opponentBoard.board[0]?.entityId ?? 0;
        calls.push({ opponent: opponentFirst, sims });
        const won = Math.round(winOf(playerFirst, opponentFirst) * sims);
        return {
          won,
          tied: 0,
          lost: sims - won,
          wonLethal: 0,
          lostLethal: 0,
          damageWon: 0,
          damageLost: 0,
        } as SimulationResult;
      },
    }) as BattleSimulator;

  const HERO: NonNullable<GameState['hero']> = {
    entityId: 64,
    cardId: 'BG20_HERO_282',
    health: 30,
    damage: 0,
    armor: 0,
    heroPowerCardId: null,
    heroPowerEntityId: null,
    heroPowerCost: null,
    heroPowerUsedThisTurn: false,
    heroPowerUnplayable: false,
  heroPowerHasActivate: false,
  };

  const setupAgainst = (mine: readonly Minion[], opponent: readonly Minion[]): BattleSetup => ({
    turn: 9,
    playerBoard: mine,
    opponentBoard: opponent,
    playerHero: HERO,
    techLevel: 3,
    anomalyCardId: null,
    globalInfo: EMPTY_GLOBAL_INFO,
  });

  // Первый борд бьётся только порядком «1 впереди» (наверняка), второй —
  // только порядком «2 впереди» (и то в 40% случаев). В среднем по полю
  // «1 впереди» даёт 50%, «2 впереди» — 20%.
  const winOf = (playerFirst: number, opponentFirst: number): number => {
    if (opponentFirst === 11) return playerFirst === 1 ? 1 : 0;
    return playerFirst === 2 ? 0.4 : 0;
  };

  const exact = { screenBudgetMs: Infinity, budgetMs: Infinity };

  it('лучшим признаётся лучший в среднем, а не против одного борда', () => {
    const mine = board([2, 1]);
    const advice = advisePosition(
      [setupAgainst(mine, board([11])), setupAgainst(mine, board([12]))],
      { simulator: fakeSimulator(winOf) },
      exact,
    );

    const best = advice.top[0];
    expect(best).toBeDefined();
    if (best === undefined) return;
    expect(best.board[0]?.entityId).toBe(1);
    expect(advice.improves).toBe(true);
    // Оценка лучшего — среднее по полю: у первого борда выигрывает всегда,
    // у второго никогда.
    expect(winRate(best.estimate)).toBeCloseTo(0.5, 5);
    expect(advice.gain).toBeCloseTo(30, 3);

    // Против одного лишь второго борда совет противоположный — значит поле
    // действительно меняет ответ, а не пересказывает одиночный.
    const single = advisePosition(
      setupAgainst(mine, board([12])),
      { simulator: fakeSimulator(winOf) },
      exact,
    );
    expect(single.top[0]?.board[0]?.entityId).toBe(2);
  });

  it('симуляции делятся между бордами поровну и складываются в отчёт', () => {
    const mine = board([2, 1]);
    const calls: FakeCall[] = [];
    const advice = advisePosition(
      [setupAgainst(mine, board([11])), setupAgainst(mine, board([12]))],
      { simulator: fakeSimulator(winOf, calls) },
      exact,
    );

    const of = (opponent: number): number[] =>
      calls.filter((c) => c.opponent === opponent).map((c) => c.sims);
    // Каждая оценка делит свои симуляции поровну — списки вызовов совпадают.
    expect(of(11)).toEqual(of(12));
    // И ни одна не потеряна: отчёт считает всё, что было брошено на оба борда.
    const total = calls.reduce((sum, c) => sum + c.sims, 0);
    expect(advice.report.simulations).toBe(total);
  });

  it('сетапы с разными своими бордами — ошибка, а не тихая каша', () => {
    expect(() =>
      advisePosition(
        [setupAgainst(board([1, 2]), board([11])), setupAgainst(board([1, 2]), board([12]))],
        { simulator: fakeSimulator(winOf) },
        exact,
      ),
    ).toThrow(/один и тот же свой борд/);
  });
});

describe('вопрос советнику из состояния партии', () => {
  const HERO = {
    entityId: 64,
    cardId: 'BG20_HERO_282',
    health: 30,
    damage: 0,
    armor: 0,
    heroPowerCardId: null,
    heroPowerEntityId: null,
    heroPowerCost: null,
    heroPowerUsedThisTurn: false,
    heroPowerUnplayable: false,
  heroPowerHasActivate: false,
  };

  const stateFor = (patch: Partial<GameState>): GameState => ({
    ...EMPTY_STATE,
    phase: 'tavern',
    turn: 9,
    hero: HERO,
    board: board([1, 2]),
    playerId: 4,
    ...patch,
  });

  it('поле собирает по сетапу на борд, каждому — тринкеты его хозяина', () => {
    const question = positionQuestion(
      stateFor({
        nextOpponentPlayerId: 7,
        lastSeenBoards: { 3: board([31]), 5: board([51]) },
        lastSeenBoardTurns: { 3: 5, 5: 7 },
        trinketsByPlayer: { 3: [111], 5: [222], 4: [999] },
      }),
    );

    expect(question?.target.kind).toBe('field');
    expect(question?.setups).toHaveLength(2);
    expect(question?.setups[0]?.opponentBoard[0]?.entityId).toBe(31);
    expect(question?.setups[1]?.opponentBoard[0]?.entityId).toBe(51);
    // Тринкеты противника — его собственные, не соседа по полю: они меняют
    // исход боя и подмена делала бы кандидатов несравнимыми.
    expect(question?.setups[0]?.opponentTrinketDbfIds).toEqual([111]);
    expect(question?.setups[1]?.opponentTrinketDbfIds).toEqual([222]);
    expect(question?.setups.every((s) => s.playerTrinketDbfIds?.[0] === 999)).toBe(true);
    // Свой борд у сетапов один и тот же — буквально: этого требует советник.
    expect(question?.setups[0]?.playerBoard).toBe(question?.setups[1]?.playerBoard);
  });

  it('известный и виденный противник даёт один сетап, как раньше', () => {
    const question = positionQuestion(
      stateFor({
        nextOpponentPlayerId: 7,
        lastSeenBoards: { 7: board([71]), 3: board([31]) },
        lastSeenBoardTurns: { 7: 8, 3: 5 },
      }),
    );

    expect(question?.target.kind).toBe('single');
    expect(question?.setups).toHaveLength(1);
    expect(question?.setups[0]?.opponentBoard[0]?.entityId).toBe(71);
  });

  it('без единого виденного борда вопроса нет', () => {
    expect(positionQuestion(stateFor({ nextOpponentPlayerId: 7 }))).toBeNull();
  });
});
