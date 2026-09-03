import { beforeAll, describe, expect, it } from 'vitest';

import {
  adviseTavern,
  buffTarget,
  buyRules,
  sellRule,
  trinketAdvice,
} from '../../src/advisors/tavern/advisor.js';
import { spendPlan } from '../../src/advisors/tavern/spend.js';
import { spendPlanLine } from '../../src/ui/format.js';
import { loadCardIndex, type CardIndex } from '../../src/data/cards.js';
import { readPowerEvents } from '../../src/parser/blocks.js';
import { readPlayers } from '../../src/state/players.js';
import { createReducer } from '../../src/state/reducer.js';
import type { GameState } from '../../src/state/types.js';
import { part36Game } from '../fixtures.js';
import { changesAdvisorState } from '../snapshots.js';

/**
 * part36 — двадцать восьмая партия с оверлеем (03.09.2026, 00:25–00:53,
 * Заплатка `TB_BaconShop_HERO_34`, квилбоары, 5-е место), десятая на билде
 * 250339. Три пункта игрока, у каждого свой скриншот и свой ход.
 *
 * Общее у всех трёх — не «совет слабоват», а СЛЕПОТА: в каждом случае
 * советник не видел факта, который в логе есть.
 *
 *  1. **Ход 7.** «Предлагает навесить заклинание на существо, которое будет
 *     продано с большой долей вероятности». План: «ПОДНЯТЬ ТАВЕРНУ за 5 →
 *     КУПИТЬ Alliance Flag → Allied Buckler +1/+3 за 1 → на Sellemental
 *     3/3». Sellemental — «When you sell this, get a 3/3 Elemental», карта,
 *     чья ценность РЕАЛИЗУЕТСЯ ПРОДАЖЕЙ: её же продажу советник предлагает
 *     сам правилом `sellForGoldRule`, и на ходах 9 и 11 его собственный план
 *     говорит «ПРОДАТЬ Sellemental». Игрок повесил щит на Tusked Camper
 *     (00:29:13, `Target=Клыкастый походник`, `SubOption=1`), а Sellemental
 *     продал на ходу 11.
 *
 *  2. **Ход 13, посреди хода.** «Вместо продажи слабого существа и покупки
 *     более сильного советует обновить таверну». После подъёма на тир 5
 *     за 9 (00:33:56) осталось 2 золота при полном борде, и оверлей показал
 *     «ОБНОВИТЬ за 1» и «НИЧЕГО». Но покупка на полном борде идёт ВМЕСТЕ
 *     с продажей, а продажа приносит золотой: и `buyRules`, и `sellRule`
 *     сравнивали цену витрины с золотом ДО продажи, которую сами же
 *     и предлагают. Игрок сделал ровно это: 00:34:15 продал Water Droplet,
 *     00:34:16 купил Fearless Foodie за 3.
 *
 *  3. **Ход 17, предложение тринкетов.** «Программа решила, что она
 *     не подходит под мой стол с свинообразами». Тег племени игра пишет
 *     `BACON_SUBSET_QUILLBOAR` (два «l»), а снапшот называет то же племя
 *     `QUILBOAR` — сравнение молча не совпадало никогда. Так же расходится
 *     `BACON_SUBSET_ELEMENTALS` против `ELEMENTAL`; остальные восемь имён
 *     совпадают, и потому расхождение прожило от part9 до сегодня.
 */
describe('part36: продажа оплачивает покупку, усиление не на продаваемого, племя тринкета из тега', () => {
  const SELLEMENTAL = 'BGS_115';
  const TUSKED_CAMPER = 'BG33_886';
  const WATER_DROPLET = 'BGS_115t';
  const FEARLESS_FOODIE = 'BG30_123';
  const BLADE = 'BG36_MagicItem_214';

  let cards: CardIndex;
  let text: string;
  /** Ход 7, точка решения: тир 2, золото 6/6, борд из трёх. */
  let decision7: GameState | null = null;
  /** Скриншот хода 13: после подъёма на тир 5 — золото 2/11, борд полон. */
  let shot13: GameState | null = null;
  /** Ход 17: открыто предложение тринкетов, среди них «Insurrectionist's Blade». */
  let offer17: GameState | null = null;
  let end: GameState;

  beforeAll(() => {
    cards = loadCardIndex();
    text = part36Game();
    const reducer = createReducer(readPlayers(text));
    for (const event of readPowerEvents(text)) {
      reducer.step(event);
      if (!changesAdvisorState(event.line.content)) continue;
      const s = reducer.snapshot();
      if (s.phase !== 'tavern') continue;
      if (s.turn === 7 && s.goldSpent === 0 && s.gold === 6 && s.shop.length >= 4) decision7 = s;
      if (s.turn === 13 && s.techLevel === 5 && s.gold === 2 && s.board.length === 7 && s.shop.length >= 5) {
        shot13 = s;
      }
      if (
        offer17 === null &&
        s.turn === 17 &&
        s.trinketOffer.length >= 3 &&
        s.trinketOffer.some((o) => o.cardId === BLADE)
      ) {
        offer17 = s;
      }
    }
    end = reducer.snapshot();
  }, 900_000);

  const must = (s: GameState | null, what: string): GameState => {
    if (s === null) throw new Error(`не найдено состояние: ${what}`);
    return s;
  };
  const deps = (): { cards: CardIndex } => ({ cards });
  const nameOf = (cardId: string): string => cards.info(cardId)?.name ?? cardId;

  it('партия читается целиком: Заплатка, билд 250339, 5-е место', () => {
    expect(end.phase).toBe('gameOver');
    expect(end.turn).toBe(28);
    expect(end.hero?.cardId).toBe('TB_BaconShop_HERO_34');
    expect(end.buildNumber).toBe(250339);
    expect(end.playerBattleTag).toBe('AngryMem#2886');
    expect(end.finalPlace).toBe(5);
  });

  /**
   * Пункт 1. Правило «усиление не вешается на кандидата в продажу» (part17)
   * знало ровно одного кандидата — слабейшего своего, которого назовёт
   * покупка на полный борд. Но у нас есть ВТОРОЙ, и названный текстом карты:
   * «When you sell this, …». Держать такую карту телом — не получить
   * обещанного никогда, это записано у `sellForGoldRule` с part18.
   */
  it('ход 7: усиление идёт не на Sellemental, а на Tusked Camper — как и сыграл игрок', () => {
    const s = must(decision7, 'точка решения хода 7');
    expect(s.board.map((m) => m.cardId)).toEqual([TUSKED_CAMPER, SELLEMENTAL, 'BG25_001']);
    // Sellemental крупнейший по статам (3/3 против 2/3 и 2/1) — прежняя цель.
    const sellemental = s.board.find((m) => m.cardId === SELLEMENTAL);
    expect((sellemental?.attack ?? 0) + (sellemental?.health ?? 0)).toBe(6);
    expect(cards.info(SELLEMENTAL)?.text).toMatch(/when you sell this/i);

    const target = buffTarget(s, deps());
    expect(target?.cardId).not.toBe(SELLEMENTAL);
    expect(target?.cardId).toBe(TUSKED_CAMPER);
  });

  it('ход 7: план называет целью Tusked Camper, а не карту, которую сам же потом продаёт', () => {
    const s = must(decision7, 'точка решения хода 7');
    const line = spendPlanLine(spendPlan(s, deps()), cards);
    expect(line).toContain('+1/+3');
    expect(line).toContain(nameOf(TUSKED_CAMPER));
    expect(line).not.toContain(nameOf(SELLEMENTAL));

    // Строка лога 00:29:13: щит ушёл на Клыкастого походника второй ветвью.
    const played = text
      .split(/\r?\n/)
      .find((l) => l.includes('BlockType=PLAY') && l.includes('cardId=BG31_880 player=4'));
    expect(played).toContain('cardId=BG33_886 player=4');
    expect(played).toContain('SubOption=1');
    // А сам Sellemental продан — как игрок и сказал про «будет продано».
    expect(end.actions.some((a) => a.type === 'sell' && a.cardId === SELLEMENTAL)).toBe(true);
  });

  /**
   * Пункт 2. Золото 2, борд полон, вся витрина по три — и обе стороны
   * размена молчали по одной и той же причине: цена сравнивалась
   * с остатком ДО продажи.
   */
  it('ход 13: при двух золотых и полном борде покупка за 3 открыта продажей слабейшего', () => {
    const s = must(shot13, 'скриншот хода 13');
    expect(s.gold).toBe(2);
    expect(s.board.length).toBe(7);
    expect(s.shop.every((m) => (m.buyCost ?? 3) === 3)).toBe(true);
    expect(s.shop.map((m) => m.cardId)).toContain(FEARLESS_FOODIE);

    const buys = buyRules(s, deps());
    const foodie = buys.find((r) => r.minion?.cardId === FEARLESS_FOODIE);
    expect(foodie).toBeDefined();
    expect(foodie?.cost).toBe(3);
    expect(foodie?.sellFirst?.cardId).toBe(WATER_DROPLET);

    // Та же фактура с другой стороны: продажа сама оплачивает покупку.
    expect(sellRule(s, deps())?.minion?.cardId).toBe(WATER_DROPLET);
  });

  it('ход 13: верхний совет и план — продать Water Droplet и купить Fearless Foodie, а не обновить витрину', () => {
    const s = must(shot13, 'скриншот хода 13');
    const advice = adviseTavern(s, deps());
    const top = advice?.recommendations[0];
    expect(top?.action).toBe('buy');
    expect(top?.minion?.cardId).toBe(FEARLESS_FOODIE);

    const plan = spendPlan(s, deps());
    expect(plan.steps[0]?.recommendation.action).toBe('buy');
    expect(plan.steps[0]?.recommendation.minion?.cardId).toBe(FEARLESS_FOODIE);
    expect(plan.steps[0]?.recommendation.sellFirst?.cardId).toBe(WATER_DROPLET);

    // Ровно так игрок и сыграл: 00:34:15 продажа, 00:34:16 покупка.
    const turn13 = end.actions.filter((a) => a.turn === 13);
    expect(turn13.map((a) => `${a.type}:${a.cardId ?? '—'}`)).toEqual([
      'levelUp:—',
      `sell:${WATER_DROPLET}`,
      `buy:${FEARLESS_FOODIE}`,
      `play:${FEARLESS_FOODIE}`,
    ]);
  });

  /**
   * Пункт 3. Имена тегов игры против имён племён снапшота. Проверяется
   * не «мы починили этот тринкет», а сам словарь: каждый тег партии обязан
   * называть племя, которое снапшот знает.
   */
  it('имена тегов BACON_SUBSET_* приводятся к племенам снапшота', () => {
    const tags = new Set(text.match(/BACON_SUBSET_[A-Z]+/g) ?? []);
    expect(tags.has('BACON_SUBSET_QUILLBOAR')).toBe(true);
    expect(tags.has('BACON_SUBSET_ELEMENTALS')).toBe(true);

    const known = new Set<string>();
    for (const info of [1, 2, 3, 4, 5, 6, 7].flatMap((t) => cards.poolOfTier(t))) {
      for (const race of info.races) known.add(race);
    }
    const s = must(offer17, 'предложение тринкетов хода 17');
    // Хотя бы одно предложение партии несёт тег — иначе тест ничего не значит.
    const seen = [...new Set(s.trinketOffer.flatMap((o) => o.subsetRaces))];
    expect(seen.length).toBeGreaterThan(0);
    for (const race of seen) expect(known).toContain(race);
  });

  it('ход 17: племенные тринкеты видят пятерых своих квилбоаров и обходят бесплемённые', () => {
    const s = must(offer17, 'предложение тринкетов хода 17');
    const blade = s.trinketOffer.find((o) => o.cardId === BLADE);
    expect(blade?.subsetRaces).toEqual(['DRAGON', 'QUILBOAR']);

    const quilboars = s.board.filter((m) => (cards.info(m.cardId)?.races ?? []).includes('QUILBOAR'));
    expect(quilboars.length).toBe(5);

    const ranked = trinketAdvice(s, deps());
    const bladeAdvice = ranked.find((t) => t.offer.cardId === BLADE);
    expect(bladeAdvice?.tribeMinions).toBe(5);
    expect(bladeAdvice?.reason).toContain('упоминает DRAGON/QUILBOAR — своих 5');
    expect(bladeAdvice?.reason).not.toContain('своих таких нет');
    expect(bladeAdvice?.reason).not.toContain('QUILLBOAR');

    // Оба квилбоарных тринкета встают выше бесплемённых: 3.90 и 3.97
    // минус 0.3 за каждого своего против 3.89 у «Transcribing Typewriter».
    // Кто из этих двух первый — решает статистика, и порядок между ними
    // тест не закрепляет: своя шкала у нас одна на обоих.
    expect(ranked.slice(0, 2).map((t) => t.offer.cardId).sort()).toEqual(
      ['BG32_MagicItem_808t', BLADE].sort(),
    );
  });
});
