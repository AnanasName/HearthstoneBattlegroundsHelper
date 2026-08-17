import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern } from '../../src/advisors/tavern/advisor.js';
import { tavernTurnOf } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part20Game } from '../fixtures.js';

/**
 * part20 — двенадцатая партия с оверлеем (17.08.2026, 14:34–15:02, пираты,
 * 1-е место при 3 hp). Пункт обратной связи один и он про ЧАСТОТУ: «очень
 * часто советует улучшить таверну», со скриншотом хода 15, где игрок стоял
 * седьмым при 22 hp и десяти золотых, а подъём стоил ровно все десять.
 *
 * Причина оказалась не в пороге и не в месте, а в шкале ходов: таблица кривой
 * написана в ходах ТАВЕРНЫ («тир 6 к одиннадцатому»), а сравнивалась с сырым
 * `GameState.turn`, который растёт и на бое. Ход 15 — это восьмой ход таверны,
 * а советник читал его как одиннадцатый и объявлял отставание в два тира там,
 * где игрок шёл на тир ВПЕРЕДИ графика.
 *
 * Контрольные значения — `part20.expected.json`.
 */
describe('part20: кривая подъёма считает ходы таверны', () => {
  let cards: CardIndex;
  let turns: { readonly turn: number; readonly state: GameState }[];
  let finalState: GameState;

  beforeAll(() => {
    const text = part20Game();
    cards = loadCardIndex();
    turns = [...readTavernTurns(text)];

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) reducer.step(event);
    finalState = reducer.snapshot();
  }, 240_000);

  it('партия дочитывается до конца: 1-е место, билд из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(1);
    expect(finalState.hero?.cardId).toBe('BG26_HERO_101');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('ход 15 — восьмой ход таверны, и это видно по золоту', () => {
    // Золота на ходу таверны N ровно min(2 + N, 10) — на этом и держится
    // перевод шкалы: десять золотых бывают не раньше восьмого хода таверны.
    const state = turns.find((t) => t.turn === 15)?.state;
    expect(state).toBeDefined();
    if (state === undefined) return;

    expect(tavernTurnOf(state.turn)).toBe(8);
    expect(state.gold).toBe(10);
    expect(state.techLevel).toBe(5);
    expect(state.tavernUpgradeCost).toBe(10);
  });

  it('ход 15: подъём больше не верхний совет — игрок ВПЕРЕДИ графика (пункт 1)', () => {
    const state = turns.find((t) => t.turn === 15)?.state;
    expect(state).toBeDefined();
    if (state === undefined) return;

    // Фактура жалобы: седьмое место при 22 hp, и подъём просит все десять
    // золотых, то есть ход без покупки вовсе.
    expect(state.finalPlace).toBe(7);
    const hero = state.hero;
    expect(hero).not.toBeNull();
    if (hero === null) return;
    expect((hero.health ?? 0) - hero.damage + hero.armor).toBe(22);

    const advice = adviseTavern(state, { cards });
    expect(advice).not.toBeNull();
    if (advice === null) return;

    // Восьмому ходу таверны полагается тир 4 — при тире 5 отставания нет.
    expect(advice.targetTier).toBe(4);

    const top = advice.recommendations[0];
    expect(top?.action).toBe('buy');
    expect(top?.minion?.cardId).toBe('BG21_004');

    // Подъём остаётся в списке, но без очков срочности: он теперь «на
    // опережение», а не «догнать график».
    const levelUp = advice.recommendations.find((r) => r.action === 'levelUp');
    expect(levelUp?.score ?? 0).toBe(0);

    // План хода тоже начинается с покупки, а не с подъёма: он занимает
    // первую строку оверлея.
    const plan = spendPlan(state, { cards });
    expect(plan.steps[0]?.recommendation.action).toBe('buy');
    expect(plan.steps.some((s) => s.recommendation.action === 'levelUp')).toBe(false);
  });

  it('за партию подъём выходит верхним советом только в ранней игре', () => {
    // Прямая мера жалобы «очень часто советует улучшить таверну»: до правки
    // шкалы подъём был верхним советом на шести ходах из четырнадцати
    // (3, 7, 9, 13, 15, 17), причём на ходах 13–17 игрок шёл по графику
    // или впереди него.
    const levelFirst = turns
      .filter((t) => adviseTavern(t.state, { cards })?.recommendations[0]?.action === 'levelUp')
      .map((t) => t.turn);

    expect(levelFirst).toEqual([3, 7]);
    // Оба — второй и четвёртый ходы таверны, где подъём и есть стандартная
    // кривая: тир 2 на 4 золота, тир 3 на 6.
    expect(levelFirst.map(tavernTurnOf)).toEqual([2, 4]);
  });
});
