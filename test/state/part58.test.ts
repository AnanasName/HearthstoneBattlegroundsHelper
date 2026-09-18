import { beforeAll, describe, expect, it } from 'vitest';

import {
  copiesForTriple,
  isTripledGolden,
  playRules,
  tripleMergeOf,
  tripleRewardGold,
} from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState, Minion } from '../../src/state/types.js';
import { spendPlanLine } from '../../src/ui/format.js';
import { createBreather } from '../breather.js';
import { part58Game } from '../fixtures.js';

/**
 * part58 — Mister Clocksworth (18.09.2026), 6-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадр один, в чат
 * (verifiedBy: скриншот из чата): 13:10, ход 1, куплен River Skipper,
 * в витрине два Southsea Busker, открыта подсказка силы «Ускоренный темп».
 *
 * Пункт игрока: «учитывал ли ты, что сила героя даёт уникальный пассивный
 * эффект». Половину — да: порог «две копии» читался с part7 (D049).
 * Вторую половину — нет: план не знал, что вторая копия СЛИВАЕТСЯ
 * в золотого, и не знал, что розыгрыш такого золотого приносит монетку
 * (D246). Разбор ходов, где игрок поступил иначе, — в журнале (j-0918-1).
 */
describe('part58: Mister Clocksworth, слияние двух копий и монетка вместо награды', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part58Game();
    lines = text.split(/\r?\n/);
    cards = loadCardIndex();
    turns = await readTavernTurnsAsync(text, createBreather());
    const reducer = createReducer(readPlayers(text));
    const breather = createBreather();
    for (const event of readPowerEvents(text)) {
      if (breather.due()) await breather.pause();
      reducer.step(event);
    }
    final = reducer.snapshot();
  }, 600_000);

  /** Состояние на момент времени — срезом лога, с долями секунды. */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d\.\d+)/.exec(line);
      if (m !== null && (m[1] ?? '') > until) break;
      taken.push(line);
    }
    return reduceLog(taken.join('\n'));
  };

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  const name = (m: { cardId: string }): string => cards.info(m.cardId)?.name ?? m.cardId;
  const label = (list: readonly Minion[]): string[] =>
    list.map((m) => `${name(m)} ${String(m.attack)}/${String(m.health)}`);

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(6);
    expect(turns).toHaveLength(10);
    expect(final.hero?.cardId).toBe('BG34_HERO_002');
  });

  /**
   * Кадр 13:10 (в чат): ход 1, золото 0/3, 30 здоровья и 18 брони,
   * на борде River Skipper 1/1, в витрине два Southsea Busker 3/1
   * и Fortify за 1. Сила «Ускоренный темп» пассивная: у её сущности нет
   * ни `COST`, ни `HAS_ACTIVATE_POWER`.
   */
  it('кадр 13:10 совпадает со срезом лога, сила пассивная', () => {
    const frame = at('13:10:10.0');
    expect(frame.turn).toBe(1);
    expect(frame.techLevel).toBe(1);
    expect([frame.gold, frame.goldTotal]).toEqual([0, 3]);
    expect(frame.hero?.health).toBe(30);
    expect(frame.hero?.armor).toBe(18);
    expect(label(frame.board)).toEqual(['River Skipper 1/1']);
    expect(label(frame.shop)).toEqual(['Southsea Busker 3/1', 'Southsea Busker 3/1']);
    expect(frame.shopSpells.map((s) => [cards.info(s.cardId)?.name, s.cost])).toEqual([['Fortify', 1]]);
    expect(frame.hero?.heroPowerCardId).toBe('BG34_HERO_002p');
    expect(frame.hero?.heroPowerCost).toBeNull();
    expect(frame.hero?.heroPowerHasActivate).toBe(false);
  });

  /**
   * Правила тройки этой партии читаются из текста силы: две копии,
   * и монетка вместо награды. Тот же текст слово в слово у аномалии
   * «False Idols» (part2), а у обычной силы — три копии и награда.
   */
  it('сила называет порог в две копии и монетку вместо награды', () => {
    const state = decisionPoint(1);
    expect(copiesForTriple(state, cards)).toBe(2);
    expect(tripleRewardGold(state, cards)).toBe(1);

    const plain = { ...state, hero: { ...state.hero!, heroPowerCardId: 'TB_BaconShop_HP_042' } };
    expect(copiesForTriple(plain, cards)).toBe(3);
    expect(tripleRewardGold(plain, cards)).toBe(0);

    const idols = { ...plain, anomalyCardId: 'BG27_Anomaly_301' };
    expect(copiesForTriple(idols, cards)).toBe(2);
    expect(tripleRewardGold(idols, cards)).toBe(1);
  });

  /**
   * Лог хода 15. Покупка второго Blade Collector (13:19:09.74):
   *
   *   TAG_CHANGE Entity=[… id=4750 zone=PLAY zonePos=1 cardId=BG26_817 player=2] tag=ZONE value=SETASIDE
   *   TAG_CHANGE Entity=[… id=5679 zone=PLAY zonePos=4 cardId=BG26_817 player=10] tag=ZONE value=SETASIDE
   *   FULL_ENTITY - Creating ID=5769 CardID=BG26_817_G   (ZONE=HAND, BACON_TRIPLED_BASE_MINION_ID=99035)
   *
   * Розыгрыш (13:19:12.27) — и энчант проверки троек кладёт в руку
   * Tavern Coin `BG28_810` с ценой 0.
   */
  it('ход 15: вторая копия сливается в золотого 12/10 в руке, розыгрыш даёт монетку', () => {
    const before = decisionPoint(15);
    const onBoard = before.board.find((m) => m.cardId === 'BG26_817');
    const inShop = before.shop.find((m) => m.cardId === 'BG26_817');
    expect(onBoard && `${String(onBoard.attack)}/${String(onBoard.health)}`).toBe('9/8');
    expect(inShop && `${String(inShop.attack)}/${String(inShop.health)}`).toBe('3/2');

    const merged = at('13:19:11.0');
    expect(merged.board.some((m) => m.cardId === 'BG26_817')).toBe(false);
    const golden = merged.hand.find((m) => m.cardId === 'BG26_817_G');
    expect(golden && `${String(golden.attack)}/${String(golden.health)}`).toBe('12/10');
    expect(isTripledGolden(golden!)).toBe(true);

    // Предсказание слияния совпадает с логом: золотая база 6/4 плюс
    // усиления копий (9/8 при базе 3/2 — это +6/+6).
    const merge = tripleMergeOf(inShop!, before, cards);
    expect(merge?.consumed).toEqual([onBoard!.entityId]);
    expect(merge && `${String(merge.golden.attack)}/${String(merge.golden.health)}`).toBe('12/10');
    expect(merge && isTripledGolden(merge.golden)).toBe(true);

    // Живой совет на золотом в руке несёт монетку.
    const play = playRules(merged, { cards }).find((r) => r.minion?.entityId === golden!.entityId);
    expect(play?.grantsGold).toBe(1);
    expect(play?.reason).toContain('монетку');

    const played = at('13:19:13.0');
    expect(played.handSpells.filter((s) => s.cardId === 'BG28_810').map((s) => s.cost)).toEqual([0]);
  });

  /**
   * План хода 15 до правки: «КУПИТЬ Blade Collector 3/2 → РАЗЫГРАТЬ Blade
   * Collector 3/2, продав Thorned Trailblazer 4/5». Продажа была лишней:
   * слияние забирает копию с борда и освобождает слот само. Игрок
   * Trailblazer не продал.
   */
  it('план хода 15 разыгрывает золотого без продажи и считает монетку', () => {
    const state = decisionPoint(15);
    const plan = spendPlan(state, { cards });
    const steps = plan.steps.map((s) => s.recommendation);
    const buy = steps.findIndex((r) => r.action === 'buy' && r.minion?.cardId === 'BG26_817');
    expect(buy).toBeGreaterThanOrEqual(0);
    expect(steps[buy]?.tripleMerge).toBeDefined();
    const play = steps[buy + 1];
    expect(play?.action).toBe('play');
    expect(play?.minion?.golden).toBe(true);
    expect(play && `${String(play.minion?.attack)}/${String(play.minion?.health)}`).toBe('12/10');
    expect(play?.sellFirst).toBeNull();
    expect(play?.grantsGold).toBe(1);
    expect(steps.some((r) => r.sellFirst?.cardId === 'BG31_327')).toBe(false);
    expect(spendPlanLine(plan, cards)).toContain('РАЗЫГРАТЬ Blade Collector 12/10 (зол)');
  });

  /**
   * Ход 5: игрок взял Roadboar и Prodigious Tusker, план — Aureate Laureate
   * и Roadboar. Против поля хода борд игрока брал 68.0 %, плана — 50.6 %.
   * Tusker («Whenever another friendly minion attacks, this plays a Blood
   * Gem on it») стоил только тиром и статами: триггер на атаку союзника
   * боевым эффектом не читался. Теперь читается (корпус: +8.90 ± 5.72 п.п.
   * на 13 точках 9 партий), и план берёт Tusker.
   */
  it('ход 5: триггер Tusker на атаку союзника — боевой эффект, план его покупает', () => {
    const state = decisionPoint(5);
    expect(state.gold).toBe(6);
    const plan = spendPlan(state, { cards });
    const bought = plan.steps
      .map((s) => s.recommendation)
      .filter((r) => r.action === 'buy' && r.minion !== null)
      .map((r) => name(r.minion!));
    expect(bought).toContain('Prodigious Tusker');
  });

  /**
   * План хода 9 до правки: «КУПИТЬ Eternal Knight → КУПИТЬ Eternal Knight →
   * Blood Gem; остаётся 1 — сгорит» — две отдельные копии 4/2 и золотой,
   * которого нет. После слияния золотой 8/4 разыгрывается, монетка даёт
   * золотой, и сгорать нечему.
   */
  it('план хода 9: пара Eternal Knight — золотой 8/4 и монетка, золото не сгорает', () => {
    const state = decisionPoint(9);
    expect([state.gold, state.techLevel]).toEqual([7, 3]);
    const plan = spendPlan(state, { cards });
    const steps = plan.steps.map((s) => s.recommendation);
    expect(steps.slice(0, 3).map((r) => [r.action, r.minion === null ? null : `${name(r.minion)} ${String(r.minion.attack)}/${String(r.minion.health)}`])).toEqual([
      ['buy', 'Eternal Knight 4/2'],
      ['buy', 'Eternal Knight 4/2'],
      ['play', 'Eternal Knight 8/4'],
    ]);
    expect(steps[2]?.grantsGold).toBe(1);
    const last = plan.steps.at(-1)?.stateAfter;
    expect(last?.board.filter((m) => m.cardId.startsWith('BG25_008')).map((m) => m.golden)).toEqual([true]);
    expect(plan.goldLeft).toBe(0);
  });
});
