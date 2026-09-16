import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part55Game } from '../fixtures.js';

/**
 * part55 — Капитан Юдора (16.09.2026), 3-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадров игрок прислал два, оба
 * в чат (verifiedBy: скриншот из чата): 17:01 — ход 3, где оверлей не звал
 * нажать силу героя, и 17:19 — ход 23 с советом купить En-Djinn Blazer.
 */
describe('part55: Юдора, раскопки золотых и пираты', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  // Лог 69 МБ: без пауз разбор держит поток воркера дольше тайм-аута RPC.
  beforeAll(async () => {
    text = part55Game();
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
  }, 900_000);

  /** Состояние на момент времени — срезом лога (метод part40, part43–part54). */
  const at = (until: string): GameState => {
    const taken: string[] = [];
    for (const line of lines) {
      const m = /^D (\d\d:\d\d:\d\d)/.exec(line);
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

  const label = (list: readonly { cardId: string; attack: number | null; health: number | null }[]): string[] =>
    list.map((m) => `${cards.info(m.cardId)?.name ?? m.cardId} ${String(m.attack)}/${String(m.health)}`);

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(3);
    expect(turns).toHaveLength(15);
    expect(final.hero?.cardId).toBe('TB_BaconShop_HERO_64');
    expect(final.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_074');
  });

  /**
   * Кадр 17:01 (скриншот из чата): ход 3, тир 1, золото 4/4, 30 здоровья
   * и 14 брони, на борде золотая Aureate Laureate, в витрине 3/3, 3/3, 2/1
   * и Enchanted Lasso за 2. Первая трата хода — сила в 17:01:24, так что
   * кадр совпадает с точкой решения.
   */
  it('кадр хода 3 совпадает со скриншотом', () => {
    const frame = at('17:01:10');
    expect(frame.turn).toBe(3);
    expect(frame.techLevel).toBe(1);
    expect(frame.gold).toBe(4);
    expect(frame.tavernUpgradeCost).toBe(4);
    expect(frame.hero?.health).toBe(30);
    expect(frame.hero?.armor).toBe(14);
    expect(label(frame.board)).toEqual(['Aureate Laureate 2/2']);
    expect(frame.board[0]?.golden).toBe(true);
    expect(label(frame.shop)).toEqual(['Molten Rock 3/3', 'Flighty Scout 3/3', 'Ominous Seer 2/1']);
    expect(frame.shopSpells.map((s) => [cards.info(s.cardId)?.name, s.cost])).toEqual([
      ['Enchanted Lasso', 2],
    ]);
    expect(frame.hero?.heroPowerCost).toBe(1);
    expect(frame.hero?.heroPowerScriptData[0]).toBe(4);
  });

  /**
   * Счётчик раскопок — `TAG_SCRIPT_DATA_NUM_1` на силе (id 198):
   *
   *   D 17:00:20.52… FULL_ENTITY - Creating ID=198 CardID=TB_BaconShop_HP_074
   *   D 17:00:20.52…     tag=TAG_SCRIPT_DATA_NUM_1 value=4
   *   D 17:01:24.75… … id=198 … tag=TAG_SCRIPT_DATA_NUM_1 value=3
   *   D 17:04:31.91… … id=198 … tag=TAG_SCRIPT_DATA_NUM_1 value=0
   *   D 17:04:31.91… FULL_ENTITY - Creating ID=2524 CardID=BG23_002_G (ZONE=HAND, CREATOR=198)
   *   D 17:04:31.91… … id=198 … tag=TAG_SCRIPT_DATA_NUM_1 value=4
   *
   * Игрок нажимал силу каждый ход таверны со второго; на точках решения
   * счётчик идёт по кругу 4 → 1, и награды приходят на ходах 9, 17 и 25.
   */
  it('счётчик раскопок на точках решения и три золотые награды', () => {
    expect(turns.map((t) => t.state.hero?.heroPowerScriptData[0])).toEqual([
      4, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3, 2, 1, 4, 3,
    ]);

    // Золотой миньон в руке, созданный силой: тир случайный, не выше своего.
    const rewards: string[] = [];
    let pending: { cardId: string; hand: boolean; bySelf: boolean } | null = null;
    const flush = (): void => {
      if (pending?.hand === true && pending.bySelf) rewards.push(pending.cardId);
      pending = null;
    };
    for (const line of lines) {
      if (!line.includes('GameState.DebugPrintPower()')) continue;
      const created = /FULL_ENTITY - Creating ID=\d+ CardID=(\S*)/.exec(line);
      if (created !== null) {
        flush();
        pending = { cardId: created[1] ?? '', hand: false, bySelf: false };
        continue;
      }
      if (pending === null) continue;
      if (/ tag=ZONE value=HAND\s*$/.test(line)) pending.hand = true;
      else if (/ tag=CREATOR value=198\s*$/.test(line)) pending.bySelf = true;
      else if (!/^\S+ \S+ \S+ -\s+tag=/.test(line)) flush();
    }
    flush();
    expect(rewards).toEqual(['BG23_002_G', 'BG32_820_G', 'BG33_822_G']);
  });

  /**
   * Жалоба игрока №1: «на 1 скриншоте мне не предложило нажать силу героя,
   * которую желательно нажимать на этом герое почаще». До правки советник
   * молчал о силе на всех 15 точках решения.
   *
   * На ходу 3 сила теперь в списке, но план по-прежнему поднимает таверну:
   * подъём за 4 тратит всё золото, и развилка (D044) не открывается.
   */
  it('раскопка советуется: доля по остатку, последняя — целая награда', () => {
    const dig = (turn: number) =>
      adviseTavern(decisionPoint(turn), { cards })?.recommendations.find((r) => r.action === 'heroPower');

    const turn3 = dig(3);
    expect(turn3?.reason).toContain('раскопка 1 из 4');
    expect(turn3?.score).toBeGreaterThan(0);
    // Последняя раскопка — верхний совет хода 9.
    const top9 = adviseTavern(decisionPoint(9), { cards })?.recommendations[0];
    expect(top9?.action).toBe('heroPower');
    expect(top9?.reason).toContain('приходит этим нажатием');
    // Первый круг: доля растёт к последней раскопке.
    const round = [3, 5, 7, 9].map((t) => dig(t)?.score ?? NaN);
    expect(round).toEqual([...round].sort((a, b) => a - b));

    // Ходы таверны 14 и 15: до награды партия не доживёт — сила молчит.
    expect(dig(27)).toBeUndefined();
    expect(dig(29)).toBeUndefined();
  });

  it('план берёт силу, когда золото иначе остаётся: ходы 5 и 9', () => {
    for (const turn of [5, 9]) {
      const plan = spendPlan(decisionPoint(turn), { cards });
      expect(plan.steps.map((s) => s.recommendation.action), `ход ${String(turn)}`).toContain('heroPower');
      expect(plan.goldLeft, `ход ${String(turn)}`).toBe(0);
    }
  });
});
