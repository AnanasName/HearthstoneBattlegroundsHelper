import { beforeAll, describe, expect, it } from 'vitest';

import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import {
  burnedGold,
  cutByTimer,
  idlePowers,
  idleSlots,
  lateLastAction,
  missedTriples,
} from '../../src/report/facts.js';
import {
  idleBeforeEnd,
  readTimeline,
  readTimelineAsync,
  turnSeconds,
  type GameTimeline,
  type ReportTurn,
} from '../../src/report/timeline.js';
import { createBreather } from '../breather.js';
import { part48Game, part49Game, part67Game, part68Game, part72Game, part73Game } from '../fixtures.js';

/**
 * Отчёт после партии: лента ходов и пункты, видные из лога без симулятора.
 *
 * Эталоны — разведка 25.09.2026 по 30 партиям part44–part73 и критик
 * спецификации; каждый сверен кадром (`npm run fixture:at`):
 *
 *  - part73, ход таверны 13 (turn 25): два Goldrinn на столе, третий
 *    в витрине с 20:17:13.68 за 3 при 8 золота (game.log:324351, цена
 *    :324445, игра сама метит его `BACON_TRIPLE_CANDIDATE=1` — :324900);
 *    в 20:17:16.03 игрок взял его (:326197 `SendOption() - selectedOption=12`)
 *    и отпустил пустым `MOVE_MINION` (:326223), в 20:17:21.43 обновил
 *    витрину (:326401); золотой собран лишь на turn 29;
 *  - part49, ход таверны 3 (Millhouse): третья Ominous Seer в витрине,
 *    а игрок поднял таверну и заморозил — размен на темп, не факт;
 *  - part68, ход таверны 10 (turn 19): 5 из 10 золота к концу хода,
 *    последнее нажатие :207039 (21:34:20.7828165), конец хода :209580
 *    (21:34:22.5174527); turn 27 — последнее нажатие :459256 (21:44:00.28)
 *    не исполнилось: до `MAIN_END` (:459259) только служебная `META_DATA`;
 *  - part67, ходы 21 и 23 — Spirit Swap Вол'джина не нажат;
 *  - отрицательные: part72 (у хода 19 одна монета — только на обновление,
 *    D279), part48 (Рено: сила «Once per game» — сбережение, D191).
 */
describe('отчёт после партии: лента и факты', () => {
  let cards: CardIndex;
  const games = new Map<number, GameTimeline>();

  beforeAll(async () => {
    cards = loadCardIndex();
    const sources: [number, () => string][] = [
      [48, part48Game],
      [49, part49Game],
      [67, part67Game],
      [68, part68Game],
      [72, part72Game],
      [73, part73Game],
    ];
    for (const [part, read] of sources) games.set(part, await readTimelineAsync(read(), createBreather()));
  }, 600_000);

  const game = (part: number): GameTimeline => {
    const found = games.get(part);
    if (found === undefined) throw new Error(`part${String(part)} не прочитан`);
    return found;
  };
  const turnOf = (part: number, turn: number): ReportTurn => {
    const found = game(part).turns.find((t) => t.turn === turn);
    if (found === undefined) throw new Error(`part${String(part)}: нет хода ${String(turn)}`);
    return found;
  };
  const ctx = (part: number) => ({ cards, actions: game(part).final.actions });

  describe('лента', () => {
    it('конец хода есть у каждого хода таверны, ходы нечётные и идут подряд', () => {
      expect(game(72).turns.map((t) => t.turn)).toEqual([1, 3, 5, 7, 9, 11, 13, 15, 17, 19, 21]);
      expect(game(73).turns).toHaveLength(17);
    });

    it('пауза до конца хода — от последнего нажатия до MAIN_END (part68, ход 19)', () => {
      const t = turnOf(68, 19);
      expect(t.end.gold).toBe(5);
      expect(t.end.goldTotal).toBe(10);
      expect(t.clock.clicks).toBe(63);
      // 21:34:22.5174527 − 21:34:20.7828165 (game.log:209580 и 207039).
      expect(idleBeforeEnd(t.clock)).toBeCloseTo(1.7346362, 5);
      expect(lateLastAction(t)).toBe(true);
      // Нажатие исполнено — ход кончился вовремя, а не оборван.
      expect(cutByTimer(t)).toBe(false);
    });

    it('неисполненное последнее нажатие — ход оборвал таймер (part68, ход 27)', () => {
      expect(cutByTimer(turnOf(68, 27))).toBe(true);
    });

    it('время хода — без показа прошлого боя (part73, ход 25)', () => {
      const t = turnOf(73, 25);
      // TURN=25 в 20:15:45.50, показ боя до 20:16:29.67, MAIN_END 20:18:18.57.
      expect(t.clock.replayEndAt).not.toBeNull();
      expect(turnSeconds(t.clock)).toBeCloseTo(108.9, 0);
    });

    it('перетаскивание карты витрины без покупки видно (part73: Goldrinn id=18299)', () => {
      expect(turnOf(73, 25).drags.map((d) => [d.entityId, d.time.slice(0, 8)])).toContainEqual([18299, '20:17:16']);
    });

    it('борд перед боем — после триггеров конца хода: дракончик Ониксии занимает слот (part73, ход 17)', () => {
      const t = turnOf(73, 17);
      expect(t.end.board).toHaveLength(6);
      expect(t.beforeCombat?.board).toHaveLength(7);
    });

    it('синхронный и асинхронный проход дают одну ленту', () => {
      const sync = readTimeline(part72Game());
      const key = (g: GameTimeline): string =>
        g.turns
          .map((t) => `${String(t.turn)}:${String(t.end.gold)}:${String(t.clock.clicks)}:${String(t.moments.length)}:${String(t.drags.length)}`)
          .join(',');
      expect(key(sync)).toBe(key(game(72)));
    });
  });

  describe('третья копия в витрине', () => {
    it('part73: Goldrinn на ходу таверны 13 — факт, и в нём сказано, что карту брали и отпустили', () => {
      const found = missedTriples(game(73).turns, ctx(73));
      expect(found.map((f) => [f.kind, f.turn, f.tavernTurn])).toEqual([['fact', 25, 13]]);
      expect(found[0]?.title).toContain('Goldrinn, the Great Wolf');
      expect(found[0]?.details).toContain('в 20:17:16 вы взяли эту карту и отпустили обратно в витрину');
    });

    it('part49: третья Ominous Seer при подъёме таверны — предположение с причиной, не факт', () => {
      const found = missedTriples(game(49).turns, ctx(49));
      const seer = found.find((f) => f.title.includes('Ominous Seer'));
      expect(seer?.kind).toBe('assumption');
      expect(seer?.caveats.join(' ')).toMatch(/подняли таверну/);
    });

    it('part72 и part68: тройки, которые были по карману, собраны', () => {
      expect(missedTriples(game(72).turns, ctx(72))).toEqual([]);
      expect(missedTriples(game(68).turns, ctx(68))).toEqual([]);
    });
  });

  describe('сгоревшее золото', () => {
    it('part68: ходы 19 и 27 — золото при миньонах витрины по 3', () => {
      const found = burnedGold(game(68).turns, ctx(68), true);
      expect(found.map((f) => f.turn)).toEqual([19, 27]);
      expect(found[1]?.details.some((d) => d.startsWith('последнее нажатие не успело исполниться'))).toBe(true);
    });

    it('part72: монета, которой хватает только на обновление, фактом не бывает (D279)', () => {
      expect(turnOf(72, 19).end.gold).toBe(1);
      expect(burnedGold(game(72).turns, ctx(72), true)).toEqual([]);
    });
  });

  describe('бесплатная сила', () => {
    it('part67: Spirit Swap не нажат на ходах 21 и 23', () => {
      expect(idlePowers(game(67).turns, ctx(67)).map((f) => f.turn)).toEqual([21, 23]);
    });

    it('part48: сила Рено «Once per game» — не из белого списка, её сбережение — стратегия (D191)', () => {
      expect(idlePowers(game(48).turns, ctx(48))).toEqual([]);
    });
  });

  describe('миньон в руке при свободном месте', () => {
    it('Ониксия: сила призывает в свободное место — слоты не судятся вовсе', () => {
      expect(idleSlots(game(73).turns, ctx(73))).toEqual([]);
    });

    it('фактом — только когда ход оборвал таймер, иначе предположение', () => {
      const found = idleSlots(game(68).turns, ctx(68));
      for (const f of found) expect(f.kind).toBe(cutByTimer(turnOf(68, f.turn)) ? 'fact' : 'assumption');
      expect(found.find((f) => f.turn === 27)?.kind).toBe('fact');
    });
  });
});
