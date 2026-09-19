import { beforeAll, describe, expect, it } from 'vitest';

import { choiceAdvice, spellRules } from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurnsAsync, type TavernTurn } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer, reduceLog } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { createBreather } from '../breather.js';
import { part61Game } from '../fixtures.js';

/**
 * part61 — Tickatus (18.09.2026), 6-е место.
 *
 * Фактура партии — в `test/fixtures.ts`. Кадров нет. Пункты игрока: знал ли
 * советник силу героя и учитывал ли её (знал по статистике выбора героя,
 * силу — нет: D261, D262), и где игрок поступил иначе и был прав (перепродажа
 * Blue Shell — D263; разбор ходов — в журнале, j-0919-1).
 *
 * Партия переходит через полночь (23:44 → 00:01); все срезы теста — до неё,
 * поэтому сравнение времён строкой здесь честное.
 */
describe('part61: Tickatus — призы Prize Wall, перепродажа Blue Shell', () => {
  let text: string;
  let lines: string[];
  let cards: CardIndex;
  let turns: TavernTurn[];
  let final: GameState;

  beforeAll(async () => {
    text = part61Game();
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

  /** Состояние на момент времени — срезом лога (только до полуночи). */
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

  const name = (id: string): string => cards.info(id)?.name ?? id;

  it('партия целая: один матч Battlegrounds, доигранный до конца, 6-е место, Tickatus', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.match(/GameState\.DebugPrintPower\(\) - CREATE_GAME/g)).toHaveLength(1);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
    expect(final.buildNumber).toBe(251952);
    expect(final.finalPlace).toBe(6);
    expect(final.hero?.cardId).toBe('TB_BaconShop_HERO_94');
    expect(final.hero?.heroPowerCardId).toBe('TB_BaconShop_HP_106');
  });

  // Строки 21474–21478 фикстуры: `DebugPrintEntityChoices` id=2,
  // `Source=[… id=136 … cardId=TB_BaconShop_HP_106]`, варианты 1788–1790.
  it('ход 7: выбор приза судится правилами руки — The Good Stuff как витринный бафф на партию (D261)', () => {
    const s = at('23:47:50');
    expect(s.openChoice?.sourceCardId).toBe('TB_BaconShop_HP_106');
    expect(s.openChoice?.options.map((o) => o.cardId)).toEqual([
      'BGS_Treasures_110',
      'BGS_Treasures_013',
      'BGS_Treasures_033',
    ]);
    const advice = choiceAdvice(s, { cards });
    expect(advice[0]?.name).toBe('The Good Stuff');
    expect(advice[0]?.reason).toContain('до конца партии');
    // Прежде оба читались «+N статов → на Aureate Laureate»: заклинание
    // Laureate не трогает, а цены у прибавки к будущим картам нет.
    for (const id of ['BGS_Treasures_110', 'BGS_Treasures_033']) {
      const a = advice.find((x) => x.option.cardId === id);
      expect(a?.score, name(id)).toBeNull();
      expect(a?.reason, name(id)).not.toContain('Aureate Laureate');
    }
  });

  // Приз Evolving Tavern взят в 23:55:01 (строка 102573) и до конца партии
  // не разыгран: в руке на ходах 17 и 19.
  it('ход 19: Evolving Tavern из руки — в плане, витрина тиров 2–6 при 14 золота (D262)', () => {
    const s = decisionPoint(19);
    expect(s.handSpells.map((h) => h.cardId)).toContain('BGS_Treasures_006');
    const rec = spellRules(s, { cards }).find((r) => r.spellCardId === 'BGS_Treasures_006');
    expect(rec?.refreshesShop).toBe(true);
    expect(rec?.reason).toContain('тиры 2–6');
    const plan = spendPlan(s, { cards });
    expect(plan.steps.some((st) => st.recommendation.spellCardId === 'BGS_Treasures_006')).toBe(true);
  });

  // `DAMAGE_DEALT_TO_HERO_LAST_TURN` своего игрока: 3 в 23:46:44 (строка
  // 11588, бой 4), 0 в 23:47:42 (начало боя 8), 5 в 23:52:28 (бой 12).
  it('урон прошлого боя: проигрыш — его урон, выигрыш — ноль', () => {
    expect(decisionPoint(5).lastCombatDamage).toBe(3);
    expect(decisionPoint(9).lastCombatDamage).toBe(0);
    expect(decisionPoint(13).lastCombatDamage).toBe(5);
  });

  // Строки 75934–76489: покупка Blue Shell 4529 в 23:53:27, `BACON_SELL_VALUE`
  // 5 в руке, продажа в 23:53:29 — `RESOURCES_USED` 9 → 4.
  it('ход 13: план начинается перепродажей Tortollan Blue Shell за 5 (D263)', () => {
    const s = at('23:53:26');
    expect(s.lastCombatDamage).toBe(5);
    const plan = spendPlan(s, { cards });
    const first = plan.steps[0]?.recommendation;
    expect(first?.action).toBe('spin');
    expect(first?.minion?.cardId).toBe('BG24_018');
    expect(first?.grantsGold).toBe(5);
    expect(plan.steps[0]?.stateAfter.gold).toBe(s.gold + 2);
  });
});
