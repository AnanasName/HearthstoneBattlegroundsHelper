import { beforeAll, describe, expect, it } from 'vitest';

import { createBattleSimulator } from '../../src/advisors/battle/simulator.js';
import { advisePositionForState } from '../../src/advisors/position/advisor.js';
import { winRate } from '../../src/advisors/position/score.js';
import { adviseTavern, freezeRule, spellRules } from '../../src/advisors/tavern/advisor.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part17Game } from '../fixtures.js';

/**
 * part17 — девятая партия с оверлеем (15.08.2026, элементали, 1-е место),
 * четыре пункта обратной связи. Контрольные значения —
 * `part17.expected.json`; пять скриншотов из чата.
 *
 * Два пункта из четырёх — ВОПРОСЫ игрока, а не жалобы: «верна ли логика
 * заморозки ради заклинания» (верна, и советник её не видел) и «почему
 * расстановка советуется в начале хода и молчит в конце» (борд за ход
 * дорос до 100% побед — это ответ, а не дефект).
 *
 * Моменты лежат посреди ходов, между точками решения, и собираются одним
 * потоковым проходом по предикатам — как в part16.
 */
describe('part17: лассо в заморозку, цель провокации, потолок расстановки, полный борд', () => {
  let cards: CardIndex;

  let lassoTurn1: GameState | null = null;
  let fortifyTurn11: GameState | null = null;
  let turn13Start: GameState | null = null;
  let turn13End: GameState | null = null;
  let cycloneTurn25: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part17Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const { content } = event.line;
      if (!content.includes('ZONE') && !content.includes('RESOURCES') && !content.includes('COST')) {
        continue;
      }
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;

      // Ход 1 после покупки Циклона и ДО того, как игрок заморозил витрину
      // сам: замороженную витрину морозить уже незачем.
      if (s.turn === 1 && s.gold === 0 && s.board.length === 1 && !s.shop.some((m) => m.frozen)) {
        lassoTurn1 = s;
      }
      // Последнее состояние с заклинанием в руке: при первом появлении
      // плейсхолдеры (TAG_SCRIPT_DATA_NUM) ещё не заполнены.
      if (s.turn === 11 && s.techLevel === 4 && s.gold === 0 && s.handSpells.length > 0) {
        fortifyTurn11 = s;
      }
      if (s.turn === 13 && s.techLevel === 4 && s.gold === 9 && turn13Start === null) {
        turn13Start = s;
      }
      if (s.turn === 13 && s.techLevel === 5 && s.gold === 0) turn13End = s;
      if (s.turn === 25 && s.gold === 0 && s.board.length === 7 && s.shop.some((m) => m.cardId === 'BGS_119')) {
        cycloneTurn25 = s;
      }
    }
    finalState = reducer.snapshot();
  }, 240_000);

  it('партия дочитывается до конца: 1-е место, билд из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(1);
    expect(finalState.hero?.cardId).toBe('BG36_HERO_105');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('ход 1: витрина морозится ради Enchanted Lasso (вопрос 1)', () => {
    // «Steal a random minion from the Tavern» за 2 золота: следующий ход
    // с пятью золотыми даёт покупку И кражу — два тела там, где две
    // покупки стоят шесть. Игрок сыграл это сам, совет молчал: ни статов,
    // ни золота в тексте не было, и разбор заклинания возвращал null.
    expect(lassoTurn1).not.toBeNull();
    if (lassoTurn1 === null) return;

    const lasso = lassoTurn1.shopSpells.find((h) => h.cardId === 'BG28_512');
    expect(lasso?.cost).toBe(2);
    expect(lassoTurn1.gold).toBe(0);

    const freeze = freezeRule(lassoTurn1, { cards });
    expect(freeze?.spellCardId).toBe('BG28_512');
    expect(freeze?.minion).toBeNull();

    const top = adviseTavern(lassoTurn1, { cards })?.recommendations[0];
    expect(top?.action).toBe('freeze');
  });

  it('ход 11: провокация Fortify идёт на тело, а не на кандидата в продажу (жалоба 2)', () => {
    // Совет вёл на Water Droplet 3/3 — токен, который игрок собирался
    // продать: оба Wildfire Elemental попадали в «движки» словом «After»
    // из собственного триггера («After this attacks…»).
    expect(fortifyTurn11).not.toBeNull();
    if (fortifyTurn11 === null) return;

    const rec = spellRules(fortifyTurn11, { cards }).find((r) => r.spellCardId === 'BG28_503');
    expect(rec).toBeDefined();
    expect(rec?.targetMinion?.cardId).toBe('BGS_126');
    // Токенов на борде два, и ни один не годится в цель.
    expect(rec?.targetMinion?.cardId).not.toBe('BGS_115t');

    // Числа усиления — только своей версии карты: в тексте снапшота
    // к обычной приклеена золотая («+{1} Health and Taunt.3[x]…»),
    // и прежний разбор складывал обе, обещая «+6 статов» вместо +3.
    expect(rec?.reason).toContain('+3 статов');
  });

  it('ход 13: борд за ход дорастает до потолка, и расстановке некуда (вопрос 3)', () => {
    // Начало хода и конец хода — РАЗНЫЕ борды: подъём на тир 5, тройка
    // в золотую Каплю воды 6/6, купленный Moat Custodian 4/10. Против
    // того же поля из виденных бордов конечный борд выигрывает всегда,
    // и «менять нечего» — это потолок, а не молчание советника.
    expect(turn13Start).not.toBeNull();
    expect(turn13End).not.toBeNull();
    if (turn13Start === null || turn13End === null) return;

    expect(turn13Start.techLevel).toBe(4);
    expect(turn13End.techLevel).toBe(5);
    expect(turn13End.board.map((m) => m.cardId)).toEqual(
      expect.arrayContaining(['BG36_351', 'BGS_115t_G']),
    );

    const advice = advisePositionForState(turn13End, { simulator: createBattleSimulator() });
    expect(advice).not.toBeNull();
    if (advice === null) return;

    expect(advice.target.kind).toBe('field');
    expect(winRate(advice.current.estimate)).toBeGreaterThanOrEqual(0.99);
    expect(advice.improves).toBe(false);
  }, 120_000);

  it('ход 25: на полном борде заморозка проходит планку покупки (жалоба 4)', () => {
    // Борд из семи миньонов по 130–780 статов; в витрине Crackling Cyclone
    // 38/43 — шесть своих элементалей и 56 очков против порога 14 тира 5,
    // то есть прежнее правило морозило витрину ради карты, которую сам же
    // советник купить бы не предложил.
    expect(cycloneTurn25).not.toBeNull();
    if (cycloneTurn25 === null) return;

    expect(cycloneTurn25.board).toHaveLength(7);
    expect(cycloneTurn25.shop.some((m) => m.cardId === 'BGS_119')).toBe(true);

    expect(freezeRule(cycloneTurn25, { cards })).toBeNull();
    const top = adviseTavern(cycloneTurn25, { cards })?.recommendations[0];
    expect(top?.action).not.toBe('freeze');
  });
});
