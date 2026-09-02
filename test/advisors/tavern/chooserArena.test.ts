import { beforeAll, describe, expect, it } from 'vitest';

import {
  contrastAgainstPlayer,
  enumerateArenaDecisions,
  type ArenaDecision,
  type ArenaRow,
} from '../../../src/advisors/tavern/chooserArena.js';
import {
  createBattleSimulator,
  type BattleSimulator,
} from '../../../src/advisors/battle/simulator.js';
import { buyCostOf } from '../../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../../src/advisors/tavern/rules.js';
import { loadCardIndex, type CardIndex } from '../../../src/data/cards.js';
import { part19Game, part32Game } from '../../fixtures.js';

/**
 * Арена выбирающих: перечисление точек, где ход игрока восстановим.
 *
 * Симуляции здесь не гоняются намеренно — перечисление обязано быть верным
 * само по себе, и именно на нём стоит вся выборка замера. Числа прогона
 * печатает `npm run spike:arena`.
 */
const base = (id: string): string => (id.endsWith('_G') ? id.slice(0, -2) : id);

describe('перечисление точек арены', () => {
  let cards: CardIndex;
  let simulator: BattleSimulator;
  let part19: readonly ArenaDecision[] = [];
  let part32: readonly ArenaDecision[] = [];

  beforeAll(() => {
    cards = loadCardIndex();
    simulator = createBattleSimulator();
    part19 = enumerateArenaDecisions(part19Game(), { cards, simulator }).decisions;
    part32 = enumerateArenaDecisions(part32Game(), { cards, simulator }).decisions;
    // Снапшот карт плюс три прохода по двум логам на партию: десятки секунд.
  }, 180_000);

  it('находит точки в обеих партиях', () => {
    expect(part19.length).toBeGreaterThan(0);
    expect(part32.length).toBeGreaterThan(0);
  });

  it('покупка игрока всегда среди кандидатов', () => {
    // Ради этого замер и существует: если ход игрока не попал в сравнение,
    // сравнивать не с чем, а «не нашли» молча превратилось бы в «не выбрал».
    for (const d of [...part19, ...part32]) {
      expect(d.playerIndex).toBeGreaterThanOrEqual(0);
      expect(d.playerIndex).toBeLessThan(d.candidates.length);
    }
  });

  it('на каждой точке есть выбор — два и более РАЗНЫХ кандидата', () => {
    for (const d of [...part19, ...part32]) {
      expect(d.candidates.length).toBeGreaterThanOrEqual(2);
      const ids = d.candidates.map((c) => base(c.minion.cardId));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('все кандидаты по карману — иначе выбор был бы выдуман', () => {
    for (const d of [...part19, ...part32]) {
      for (const c of d.candidates) {
        expect(buyCostOf(c.minion, DEFAULT_TAVERN_RULES)).toBeLessThanOrEqual(d.state.gold);
      }
    }
  });

  it('жертва назначается только на полном борде, и борд не переполняется', () => {
    for (const d of [...part19, ...part32]) {
      const full = d.state.board.length >= DEFAULT_TAVERN_RULES.boardSize;
      expect(d.sacrifice === null).toBe(!full);
      for (const c of d.candidates) {
        expect(c.board.length).toBeLessThanOrEqual(DEFAULT_TAVERN_RULES.boardSize);
        // Кандидат обязан быть на борде: без него сравнивались бы не покупки.
        expect(c.board[c.board.length - 1]?.entityId).toBe(c.minion.entityId);
      }
    }
  });

  it('жертва — свой миньон, а не карта витрины', () => {
    for (const d of [...part19, ...part32]) {
      if (d.sacrifice === null) continue;
      expect(d.state.board.some((m) => m.entityId === d.sacrifice?.entityId)).toBe(true);
    }
  });

  it('отсев считается по причинам, и сумма сходится с числом точек решения', () => {
    const { decisions, skips } = enumerateArenaDecisions(part19Game(), { cards, simulator });
    const dropped =
      skips.notBuyFirst +
      skips.buyOffShop +
      skips.noSpending +
      skips.noBattle +
      skips.noChoice +
      skips.noSacrifice;
    // Точек решения у part19 четырнадцать (см. замер выборки в docs/ml.md).
    expect(decisions.length + dropped).toBe(14);
  });
});

describe('парный контраст против игрока', () => {
  const row = (player: number, advisor: number, oracle: number): ArenaRow => ({
    turn: 1,
    candidates: 2,
    outcomes: [player, advisor],
    scores: {
      player,
      advisor,
      oracle,
      random: (player + advisor) / 2,
      stats: player,
      live3: advisor,
      liveAll: oracle,
      liveBudget: advisor,
      liveRich: oracle,
    },
    picks: { player: 0, advisor: 1, oracle: 1, stats: 0, live3: 1, liveAll: 1, liveBudget: 1, liveRich: 1 },
    spread: Math.abs(advisor - player),
    boardFull: false,
    liveHadTarget: true,
    liveBoards: 1,
    liveAllMs: 0,
  });

  it('сам с собой даёт ноль', () => {
    const c = contrastAgainstPlayer([[row(50, 60, 70)], [row(20, 30, 40)]], 'player');
    expect(c.mean).toBe(0);
    expect(c.mde).toBe(0);
  });

  it('кластер — партия, а не точка: две точки одной партии усредняются', () => {
    // Партия с двумя точками весит столько же, сколько партия с одной.
    const c = contrastAgainstPlayer(
      [[row(0, 10, 10), row(0, 30, 30)], [row(0, 40, 40)]],
      'advisor',
    );
    expect(c.mean).toBeCloseTo(30, 5); // (20 + 40) / 2, а не (10 + 30 + 40) / 3
    expect(c.games).toBe(2);
  });

  it('пустые партии не считаются партиями', () => {
    const c = contrastAgainstPlayer([[], [row(0, 10, 10)]], 'advisor');
    expect(c.games).toBe(1);
  });

  it('МРЭ равна 1.645 · SE', () => {
    const c = contrastAgainstPlayer([[row(0, 10, 10)], [row(0, 20, 20)], [row(0, 30, 30)]], 'advisor');
    expect(c.mean).toBeCloseTo(20, 5);
    expect(c.mde).toBeCloseTo(1.645 * c.se, 10);
  });
});
