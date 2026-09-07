import { beforeAll, describe, expect, it } from 'vitest';

import { spellBuyDiscount } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { readTavernTurns } from '../../src/advisors/tavern/turns.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { createBattleSimulator } from '../../src/advisors/battle/simulator.js';
import type { GameState } from '../../src/state/types.js';
import { part49Game } from '../fixtures.js';

/**
 * part49 — Диджей Манашторм (07.09.2026). Пункт игрока первый: «на 1
 * скриншоте ты не учёл, что нага удешевит карту и я смогу сыграть 3 карты
 * за ход без сгорания».
 *
 * Тест держит три разные вещи, и делить их важно: ФАКТУРУ лога (что игра
 * пишет и что сделал игрок), ЧТЕНИЕ (текст перестал быть немым) и ПЛАН
 * (ради чего всё затевалось). Контраст с правилами БЕЗ шаблона стоит
 * тут же: без него видно только «план такой», а не «план стал таким».
 */
describe('part49: клич, дешевящий заклинание витрины', () => {
  let text: string;
  let cards: CardIndex;
  let turns: ReturnType<typeof readTavernTurns>;

  beforeAll(() => {
    text = part49Game();
    cards = loadCardIndex();
    turns = readTavernTurns(text);
  }, 240_000);

  const decisionPoint = (turn: number): GameState => {
    const found = turns.find((t) => t.turn === turn);
    expect(found, `точка решения хода ${String(turn)}`).toBeDefined();
    return found!.state;
  };

  it('партия целая: один матч Battlegrounds, доигранный до конца', () => {
    expect(text.match(/GameType=GT_BATTLEGROUNDS/g)).toHaveLength(1);
    expect(text.includes('GameType=GT_RANKED')).toBe(false);
    expect(text.includes('FINAL_GAMEOVER')).toBe(true);
  });

  /**
   * Фактура — из лога, а не из текста карты: скидку игра проставляет
   * тегом `COST` СРАЗУ, в тот же миг, что срабатывает клич, и ставит его
   * в двух местах — на самом заклинании и на его кнопке покупки. Значит
   * список советов цену видит верно всегда, а слеп был только план,
   * который эту покупку ещё только СОБИРАЕТСЯ сделать.
   */
  it('клич роняет цену заклинания витрины, и это видно тегом', () => {
    const spell = text.includes(
      'Entity=[entityName=Зачарованное лассо id=397 zone=PLAY zonePos=3 cardId=BG28_512 player=10] tag=COST value=1',
    );
    const button = text.includes(
      'cardId=TB_BaconShop_DragBuy_Spell player=2] tag=COST value=1',
    );
    expect(spell, 'COST=1 на самом заклинании').toBe(true);
    expect(button, 'COST=1 на кнопке покупки заклинания').toBe(true);
  });

  /**
   * Ход игрока по журналу: покупка наги, розыгрыш, покупка заклинания —
   * и всё это в первый ход, где золота ровно три. Именно он и есть
   * «три карты за ход без сгорания»: третьей стал миньон, которого лассо
   * украло из витрины.
   */
  it('на первом ходу игрок купил нагу, разыграл её и купил заклинание', () => {
    const last = turns[turns.length - 1]?.state;
    expect(last).toBeDefined();
    const firstTurn = (last?.actions ?? []).filter((a) => a.turn === 1);
    const kinds = firstTurn.map((a) => `${a.type}:${a.cardId ?? ''}`);
    expect(kinds.slice(0, 4)).toEqual([
      'buy:BG31_330',
      'play:BG31_330',
      'buy:BG28_512',
      'play:BG28_512',
    ]);
  });

  it('текст читается: у наги скидка 1, у золотой копии 2, у соседей ничего', () => {
    expect(spellBuyDiscount('BG31_330', cards)).toBe(1);
    expect(spellBuyDiscount('BG31_330_G', cards)).toBe(2);
    // Соседи по той же витрине — контроль на то, что шаблон не ловит всё
    // подряд: у обоих в тексте нет ни слова про заклинания таверны.
    expect(spellBuyDiscount('BG36_345', cards)).toBeNull();
    expect(spellBuyDiscount('BGS_004', cards)).toBeNull();
  });

  it('класс узкий: в пуле миньонов такая карта одна', () => {
    let inPool = 0;
    for (let tier = 1; tier <= 6; tier += 1) {
      for (const card of cards.poolOfTier(tier)) {
        if (spellBuyDiscount(card.id, cards) !== null) inPool += 1;
      }
    }
    expect(inPool).toBe(1);
  });

  /**
   * Само собой то, ради чего правка: план хода 1 стал ходом игрока.
   *
   * Контраст с правилами БЕЗ шаблона держит утверждение «стало», а не
   * «так и было»: тот же советник на том же состоянии покупал тело за 2
   * и морозил заклинание, оставляя монету сгорать.
   */
  it('план хода 1 повторяет ход игрока и не жжёт золота', () => {
    const state = decisionPoint(1);
    expect(state.gold).toBe(3);
    const deps = { cards, simulator: createBattleSimulator() };

    const plan = spendPlan(state, deps, DEFAULT_TAVERN_RULES);
    expect(plan.steps.map((s) => s.recommendation.action)).toEqual(['buy', 'buy']);
    expect(plan.steps[0]?.recommendation.minion?.cardId).toBe('BG31_330');
    expect(plan.steps[0]?.recommendation.spellDiscountAfter).toBe(1);
    expect(plan.steps[1]?.recommendation.spellCardId).toBe('BG28_512');
    // Заклинание стоит на золотой дешевле — ровно то, что игра написала
    // тегом через полторы секунды после покупки наги.
    expect(plan.steps[1]?.recommendation.cost).toBe(1);
    expect(plan.goldLeft).toBe(0);

    const blind = spendPlan(state, deps, {
      ...DEFAULT_TAVERN_RULES,
      spellBuyDiscountWords: [],
    });
    expect(blind.steps[0]?.recommendation.minion?.cardId).toBe('BG36_345');
    expect(blind.goldLeft).toBe(1);
  });

  /**
   * Границы. Скидка — не свойство кандидата вообще, а обещание СЛЕДУЮЩЕЙ
   * покупке заклинания: без заклинаний в витрине обещать нечего, и приписка
   * в строке действия была бы советом ни о чём.
   */
  it('без заклинаний в витрине правило молчит', () => {
    const state = decisionPoint(1);
    const deps = { cards, simulator: createBattleSimulator() };
    const dry: GameState = { ...state, shopSpells: [] };
    const plan = spendPlan(dry, deps, DEFAULT_TAVERN_RULES);
    for (const step of plan.steps) {
      expect(step.recommendation.spellDiscountAfter).toBeUndefined();
    }
  });
});
