import { beforeAll, describe, expect, it } from 'vitest';

import { adviseTavern, darkGiftRule, freezeRule, shopSpellRules } from '../../src/advisors/tavern/advisor.js';
import { DEFAULT_TAVERN_RULES } from '../../src/advisors/tavern/rules.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part23Game } from '../fixtures.js';

/**
 * part23 — пятнадцатая партия с оверлеем (17.08.2026, Nightmare Lord Xavius,
 * мехи с пиратами, 7-е место). Три пункта обратной связи, и все три об одном:
 * ЦЕНА ДЕЙСТВИЯ В ЗОЛОТЕ.
 *
 * Контрольные значения — `part23.expected.json`.
 */
describe('part23: запертый остаток, названный тир и наценка заклинания', () => {
  let cards: CardIndex;

  let turn5: GameState | null = null;
  let turn11: GameState | null = null;
  let turn11End: GameState | null = null;
  let turn15End: GameState | null = null;
  let finalState: GameState;

  beforeAll(() => {
    const text = part23Game();
    cards = loadCardIndex();

    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;

      // Точка решения хода 5: пять золота, один свой, витрина из четырёх.
      if (s.turn === 5 && s.gold === 5 && s.board.length === 1 && s.shop.length === 4) turn5 = s;

      // Точка решения хода 11 (шестой ход таверны): восемь золота.
      if (s.turn === 11 && s.gold === 8 && s.board.length === 6) turn11 = s;

      // Конец хода 11: золото потрачено, таверна поднята до 4 — момент,
      // в который заклинание переставало быть покупкой и становилось
      // кандидатом на заморозку. Ровно про него жалоба игрока.
      if (s.turn === 11 && s.gold === 0 && s.techLevel === 4) turn11End = s;

      // Момент скриншота хода 15: золото потрачено, рука пуста, борд из шести.
      // Позже в том же ходу в руку приходит Satellite — это уже другой экран.
      if (s.turn === 15 && s.gold === 0 && s.hand.length === 0 && s.board.length === 6) {
        turn15End = s;
      }
    }
    finalState = reducer.snapshot();
  }, 600_000);

  it('партия дочитывается до конца: 7-е место, герой и его сила из лога', () => {
    expect(finalState.phase).toBe('gameOver');
    expect(finalState.finalPlace).toBe(7);
    expect(finalState.hero?.cardId).toBe('BG36_HERO_105');
    expect(finalState.hero?.heroPowerCardId).toBe('BG36_HERO_105p');
    expect(finalState.buildNumber).toBe(248348);
  });

  it('все состояния скриншотов воспроизводятся из лога', () => {
    expect(turn5).not.toBeNull();
    expect(turn11).not.toBeNull();
    expect(turn11End).not.toBeNull();
    expect(turn15End).not.toBeNull();
    if (turn5 === null || turn11 === null || turn15End === null) return;

    expect(turn5.techLevel).toBe(2);
    expect(turn5.shop.map((m) => m.cardId)).toEqual([
      'BG28_300',
      'BG25_008',
      'BG36_345',
      'BG27_002',
    ]);
    expect(turn5.shopSpells.map((s) => s.cardId)).toEqual(['BG28_827']);

    expect(turn11.techLevel).toBe(3);
    expect(turn11.shopSpells.map((s) => s.cardId)).toEqual(['BG28_504']);

    expect(turn15End.techLevel).toBe(5);
    expect(turn15End.board.map((m) => m.cardId)).toEqual([
      'BG32_236',
      'BG_TTN_401',
      'BG36_523_G',
      'BG36_344',
      'BG31_177',
      'BG26_810',
    ]);
    expect(turn15End.shopSpells.map((s) => s.cardId)).toEqual(['BG28_521']);
  });

  /**
   * Пункт 1 (скриншот хода 5): «мне вверх подсвечивает ход, где я должен
   * потерять золото».
   *
   * Пять золота. Жадная цепочка брала тёмный дар за 3 (8.0 очков), после
   * которого оставалось два — и ни одно действие за них не купить. Прокрутка
   * Oozeling Gladiator стоила чистых 2 (7.5 очков) и оставляла ровно три
   * на покупку за 3. Разрыв в очках у первого шага — полбалла, а цена
   * запертого остатка — два золота, то есть шесть очков по курсу.
   */
  it('пункт 1: план не запирает остаток — цепочка тратит все пять золота', () => {
    expect(turn5).not.toBeNull();
    if (turn5 === null) return;

    const plan = spendPlan(turn5, { cards });
    expect(plan.goldLeft).toBe(0);
    expect(plan.steps[0]?.recommendation.action).toBe('spin');
    expect(plan.steps[0]?.recommendation.minion?.cardId).toBe('BG27_002');
  });

  it('пункт 1: сам ПОРЯДОК советов правкой не тронут — прокрутка верхняя, дар молчит с part31', () => {
    expect(turn5).not.toBeNull();
    if (turn5 === null) return;

    // Развилка живёт только в плане: список советов — это ранжирование
    // отдельных действий, и запертый остаток к нему отношения не имеет.
    // До part31 дар стоял здесь верхней строкой (8.0 против 7.5): третий
    // ход таверны, тело тира 2. С part31 у заряда есть цена — три заряда
    // на 9.3 хода впереди, и нажатый сейчас вытесняет тело тира 5–6
    // десятого хода, — и на этом ходу дар молчит вовсе; верхней строкой
    // стоит та самая прокрутка, которую игрок и сыграл.
    const advice = adviseTavern(turn5, { cards });
    expect(advice?.recommendations[0]?.action).toBe('spin');
    expect(advice?.recommendations.some((r) => r.action === 'darkGift')).toBe(false);
    expect(turn5.darkGiftCost).toBe(3);
    expect(darkGiftRule(turn5, { cards })).toBeNull();
  });

  /**
   * Пункт 2 (ход 11, шестой ход таверны): «получать за 2 золота существо
   * из 1 таверны не настолько хорошая идея».
   *
   * Recruit a Trainee — «Get a random Tier 1 minion». Тир написан в тексте,
   * а ожидание бралось средним ПО ВИТРИНЕ третьего тира: 11.5 вместо
   * ценности тела первого тира.
   */
  it('пункт 2: заклинание с названным тиром оценивается пулом того тира', () => {
    expect(turn11).not.toBeNull();
    if (turn11 === null) return;

    const trainee = shopSpellRules(turn11, { cards }).find((r) => r.spellCardId === 'BG28_504');
    expect(trainee).toBeDefined();
    if (trainee === undefined) return;

    expect(trainee.reason).toContain('как средний миньон тира 1');
    // Прежде было 14.5 — как средняя карта витрины плюс скидка в золото.
    expect(trainee.score).toBeLessThan(11);

    // И в списке советов заклинание уходит ниже покупок третьего тира
    // (Annoy-o-Module 17.5, Cadaver Caretaker 13.0) — прежде оно стояло
    // с ними вровень. (Прежний порог «ниже третьей строки» держался ещё
    // и на тёмном даре в списке — с part31 у дара на шестом ходу таверны
    // есть цена придержанного заряда, 13.0 → 7.4, и он ушёл под
    // заклинание без единого сдвига в оценке самого заклинания.)
    const recs = adviseTavern(turn11, { cards })?.recommendations ?? [];
    const rank = recs.findIndex((r) => r.spellCardId === 'BG28_504');
    expect(rank).toBeGreaterThan(1);
    expect(recs[0]?.action).toBe('buy');
    expect(recs[1]?.action).toBe('buy');
    expect(recs.slice(0, rank).every((r) => r.score > trainee.score)).toBe(true);
  });

  /**
   * Та же жалоба, вторая её половина: игрок сказал «порекомендовало
   * ЗАМОРОЗИТЬ». В точке решения золота на заклинание хватает, и оно просто
   * покупка; заморозкой оно становится в конце хода, когда золото ушло.
   *
   * Одной переоценки тира для этого мало: планка заморозки была маржинальной
   * и на собранном борде падала почти в ноль. Обе стороны разности теперь
   * считаются одной функцией — пул своего тира против доживающей витрины, —
   * и планка растёт с тиром.
   */
  it('пункт 2: витрина четвёртого тира не морозится ради тела первого', () => {
    expect(turn11End).not.toBeNull();
    if (turn11End === null) return;

    expect(turn11End.techLevel).toBe(4);
    expect(turn11End.shopSpells.map((s) => s.cardId)).toEqual(['BG28_504']);
    // Цена (2) ниже цены миньона, то есть гейт по цене эту карту пропускает,
    // — молчит именно планка.
    expect(turn11End.shopSpells[0]?.cost).toBeLessThan(DEFAULT_TAVERN_RULES.minionCost);
    expect(freezeRule(turn11End, { cards })?.spellCardId).toBeUndefined();
  });

  it('пункт 2: тир читается и числом, и словами «своего тира»', () => {
    // Числом — Recruit a Trainee и Hallowed Ritual («Discover a Tier 7 minion»).
    const numbered = new RegExp(DEFAULT_TAVERN_RULES.namedTierWords.numbered, 'i');
    expect(numbered.exec(cards.info('BG28_504')?.text ?? '')?.[1]).toBe('1');

    expect(numbered.exec(cards.info('BG31_896')?.text ?? '')?.[1]).toBe('7');

    // Словами — Search Through Time («Discover a minion of your Tier»).
    const own = (text: string): boolean =>
      DEFAULT_TAVERN_RULES.namedTierWords.ownTier.some((w) => new RegExp(w, 'i').test(text));
    expect(own(cards.info('BG34_330')?.text ?? '')).toBe(true);

    // А «of your most common type» тира не называет: там витрина и есть мерка.
    expect(own(cards.info('BG28_521')?.text ?? '')).toBe(false);
    expect(numbered.test(cards.info('BG28_521')?.text ?? '')).toBe(false);
  });

  /**
   * Пункт 3 (скриншот хода 15): «рекомендует заморозить заклинание и таверну,
   * которые довольно слабые, учитывая, что у меня не будет обновления».
   *
   * Planar Telescope стоит 4 при цене миньона 3. Витрину держат ради
   * заклинания только тогда, когда оно ДЕШЕВЛЕ покупки (part17, ход 1):
   * тело за два золота там, где покупка стоит три. Заклинание дороже покупки
   * такой ставкой не является — то же тело в тот же ход просто покупается.
   *
   * Здесь молчат оба условия сразу: и гейт по цене, и планка (пятый тир).
   * Проверяется гейт — он единственный, кто ловит именно НАЦЕНКУ; планка
   * проверена на ходу 11, где цена заклинания вопросов не вызывает.
   */
  it('пункт 3: витрина не морозится ради заклинания дороже покупки', () => {
    expect(turn15End).not.toBeNull();
    if (turn15End === null) return;

    // Цена заклинания витрины — живой тег COST, и она выше цены миньона.
    expect(turn15End.shopSpells[0]?.cost).toBe(4);
    expect(DEFAULT_TAVERN_RULES.minionCost).toBe(3);

    expect(freezeRule(turn15End, { cards })).toBeNull();

    // И на экране остаётся честное «ничего»: делать в этом ходу нечего.
    const advice = adviseTavern(turn15End, { cards });
    expect(advice?.recommendations[0]?.action).toBe('pass');
    expect(spendPlan(turn15End, { cards }).steps).toEqual([]);
  });

  it('пункт 3: наценка считается тем же курсом, что скидка', () => {
    expect(turn15End).not.toBeNull();
    if (turn15End === null) return;

    // При деньгах телескоп покупается — но лишнее золото ему теперь в минус,
    // и в причине это сказано словами.
    const rich: GameState = { ...turn15End, gold: 10 };
    const telescope = shopSpellRules(rich, { cards }).find((r) => r.spellCardId === 'BG28_521');
    expect(telescope).toBeDefined();
    expect(telescope?.reason).toContain('ДОРОЖЕ покупки');

    // Ровно одно золото сверх цены миньона — по курсу это три очка.
    const atMinionCost: GameState = {
      ...rich,
      shopSpells: rich.shopSpells.map((s) => ({ ...s, cost: DEFAULT_TAVERN_RULES.minionCost })),
    };
    const noSurcharge = shopSpellRules(atMinionCost, { cards }).find(
      (r) => r.spellCardId === 'BG28_521',
    );
    expect((noSurcharge?.score ?? 0) - (telescope?.score ?? 0)).toBeCloseTo(
      DEFAULT_TAVERN_RULES.goldPointValue,
      5,
    );
  });

  /**
   * Тот же ход 5, вторая половина пункта 1: «мог купить существо за 3,
   * сделать активацию за 1 и докупить заклинание, которое даёт бесплатные
   * обновления».
   *
   * Leaf Through the Pages за 1 даёт два обновления по живой цене кнопки.
   * Прежде разбор возвращал `null` — ни статов, ни золота, ни миньона
   * в тексте, — и заклинание было советнику невидимо целиком.
   */
  it('пункт 1: заклинание бесплатных обновлений видно и считается золотом', () => {
    expect(turn5).not.toBeNull();
    if (turn5 === null) return;

    expect(cards.info('BG28_827')?.text).toContain('Gain 2 free');
    expect(turn5.rerollCost).toBe(1);

    const leaf = shopSpellRules(turn5, { cards }).find((r) => r.spellCardId === 'BG28_827');
    expect(leaf).toBeDefined();
    // Два обновления по 1 минус цена 1 — одно золото чистыми, три очка.
    expect(leaf?.score).toBeCloseTo(DEFAULT_TAVERN_RULES.goldPointValue, 5);

    // А при бесплатных обновлениях дарить нечего, и совет молчит.
    const freeAlready: GameState = { ...turn5, rerollCost: 0 };
    expect(shopSpellRules(freeAlready, { cards }).some((r) => r.spellCardId === 'BG28_827')).toBe(
      false,
    );
  });
});
