import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, freezeRule, spinRule, buyRules } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES, tavernTurnOf } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part25Game } from '../fixtures.js';

/**
 * part25 — семнадцатая партия с оверлеем (17.08.2026, Murozond, Unbounded,
 * 3-е место). Два пункта обратной связи, и оба про ОДНУ механику: карту,
 * чьё обещание отдаёт ПРОДАЖА.
 *
 * Контрольные значения — `part25.expected.json`.
 */
describe('part25: карта, которая платит продажей', () => {
  let cards: CardIndex;

  let turn3BeforeFreeze: GameState | null = null;
  let turn5: GameState | null = null;
  let turn7: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part25Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;

      // Ход 3, момент скриншота: подъём сделан, золота нет, витрина ещё
      // старая и ЕЩЁ НЕ заморожена — заморозил её игрок сам через полминуты.
      if (s.turn === 3 && s.techLevel === 2 && s.gold === 0 && s.shop.every((m) => !m.frozen)) {
        turn3BeforeFreeze = s;
      }

      // Ход 5, точка решения: пять золота и та самая замороженная витрина.
      if (s.turn === 5 && s.gold === 5 && s.board.length === 1) turn5 = s;

      // Ход 7, точка решения: шесть золота, подъём стоит 5.
      if (s.turn === 7 && s.gold === 6 && s.board.length === 3) turn7 = s;
    }
    finalState = reducer.snapshot();
  }, 600_000);

  it('партия дочитывается до конца: 3-е место, герой из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(3);
    expect(finalState.hero?.cardId).toBe('BG34_HERO_000');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('все состояния разбора воспроизводятся из лога', () => {
    expect(turn3BeforeFreeze).not.toBeNull();
    expect(turn5).not.toBeNull();
    expect(turn7).not.toBeNull();
  });

  /**
   * Пункт 1 (скриншот хода 3): «не предлагает заморозить экономическую
   * карту, хотя она может помочь на следующем ходу получить две
   * гарантированные карты вместо негарантированного получения (будет только
   * 5 золото)».
   *
   * River Skipper («When you sell this, get a random Tier 1 minion») — это
   * покупка ДЕШЕВЛЕ трёх: купить за 3, разыграть, продать за 1 — тело
   * за чистых два, и на остаток покупается ещё одно. Ровно тем же числом
   * меряется заклинание витрины, дающее миньона (part17), и планка
   * у заморозки поэтому та же самая.
   */
  it('пункт 1: витрина держится ради карты, которая платит продажей', () => {
    expect(turn3BeforeFreeze).not.toBeNull();
    if (turn3BeforeFreeze === null) return;

    const s = turn3BeforeFreeze;
    expect(s.gold).toBe(0);
    expect(s.techLevel).toBe(2);
    expect(s.board.map((m) => m.cardId)).toEqual(['BGS_127']);
    expect(s.shop.map((m) => m.cardId)).toEqual(['BG33_140', 'BG32_330', 'BG33_886']);
    expect(cards.info('BG33_140')?.text).toContain('When you sell this');

    const keep = freezeRule(s, { cards });
    expect(keep?.minion?.cardId).toBe('BG33_140');
    expect(keep?.reason).toContain('купить-разыграть-продать');
    expect(keep?.reason).toContain('чистых 2');

    // Прежде на этом состоянии советник говорил «НИЧЕГО»: тратить нечего,
    // а ветки для такой карты у заморозки не было. Теперь план ею кончается.
    const plan = spendPlan(s, { cards });
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]?.recommendation.action).toBe('freeze');
    expect(plan.steps[0]?.recommendation.minion?.cardId).toBe('BG33_140');
  });

  /**
   * Та же витрина ходом позже — там, где ставка игрока и окупилась. Пять
   * золотых он разменял на ДВА тела: купил скипера за 3, продал за 1
   * (пришёл Tusked Camper) и купил ещё одного за 3.
   */
  it('пункт 1: на следующем ходу цепочка становится верхним советом', () => {
    expect(turn5).not.toBeNull();
    if (turn5 === null) return;

    const s = turn5;
    expect(s.gold).toBe(5);
    // Витрина хода 3, пережившая бой: три замороженных плюс одна новая.
    expect(s.shop.map((m) => m.cardId)).toEqual(['BG33_140', 'BG32_330', 'BG33_886', 'BG20_100']);

    const spin = spinRule(s, { cards }, DEFAULT_TAVERN_RULES, buyRules(s, { cards }));
    expect(spin?.minion?.cardId).toBe('BG33_140');
    expect(spin?.cost).toBe(2);
    expect(spin?.reason).toContain('продажа даст миньона тира 1');

    const advice = adviseTavern(s, { cards });
    expect(advice?.recommendations[0]?.action).toBe('spin');
    // Цепочка тратит золото до нуля — ровно то, что сыграл игрок.
    const plan = spendPlan(s, { cards });
    expect(plan.steps[0]?.recommendation.action).toBe('spin');
    expect(plan.goldLeft).toBe(0);
  });

  /**
   * Пункт 2 (ход 4 ТАВЕРНЫ, наш ход 7): «предложил слабый ход; по логам
   * видно, насколько сильный я смог сделать благодаря продажам карт».
   *
   * Игрок за шесть золота вырастил борд с трёх миньонов до шести: Patient
   * Scout за 3 и продажа за 1 («Discover a Tier 1 minion» дал второго Molten
   * Rock, а тот поднял здоровье первому), Ominous Seer за 3 («Battlecry:
   * The next Tavern spell you buy costs (1) less») и Enchanted Lasso
   * за подешевевшее 1, укравшее из витрины Decoy Conjurer 3/4.
   *
   * ЗАКРЫТО ДВУМЯ ПРАВКАМИ. Первая — цепочка через продажный генератор
   * теперь видна и стоит выше всех покупок. Вторая — по решению игрока
   * (третья подряд жалоба на один и тот же ход: part23 ход 5, part24 ход 7,
   * part25 ход 7) развилка плана судит и цепочку с подъёмом: в сумму он
   * идёт своей срочностью, а не очками списка, где внутри лежит лучшая
   * покупка. Список остался прежним — подъём в нём верхний.
   */
  it('пункт 2: прокрутка через продажу видна и стоит выше покупок', () => {
    expect(turn7).not.toBeNull();
    if (turn7 === null) return;

    const s = turn7;
    expect(tavernTurnOf(s.turn)).toBe(4);
    expect(s.gold).toBe(6);
    expect(s.shop.map((m) => m.cardId)).toEqual(['BG36_354', 'BG31_330', 'BG24_715', 'BGS_004']);
    expect(cards.info('BG24_715')?.text).toContain('When you sell this');

    const buys = buyRules(s, { cards });
    const spin = spinRule(s, { cards }, DEFAULT_TAVERN_RULES, buys);
    expect(spin?.minion?.cardId).toBe('BG24_715');
    expect(spin?.cost).toBe(2);
    // Выше всех покупок, включая заклинание витрины за 2.
    expect(spin?.score).toBeGreaterThan(Math.max(...buys.map((b) => b.score)));
  });

  it('пункт 2: план тратит все шесть золотых, а подъём остаётся в списке', () => {
    expect(turn7).not.toBeNull();
    if (turn7 === null) return;

    expect(turn7.tavernUpgradeCost).toBe(5);
    const advice = adviseTavern(turn7, { cards });
    // Список: подъём верхний, вторая строка — цепочка, которую игрок сыграл.
    expect(advice?.recommendations[0]?.action).toBe('levelUp');
    expect(advice?.recommendations[0]?.reason).toContain('сгорит');
    expect(advice?.recommendations[1]?.action).toBe('spin');

    // План: подъёма нет, золото уходит целиком — это и была жалоба.
    const plan = spendPlan(turn7, { cards });
    expect(plan.steps.some((s) => s.recommendation.action === 'levelUp')).toBe(false);
    expect(plan.goldLeft).toBe(0);
  });
});
